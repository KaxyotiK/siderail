#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSupportedNode } from "../src/node-version.mjs";
import { runCommand } from "../src/process.mjs";
import { sanitizeTerminalText } from "../src/terminal-ui.mjs";
import {
  PLUGIN_ID,
  assertHerdrLinkedHere,
  dockControl,
  dockControlRoot,
  findDockControl,
  findHerdrPlugin,
  readPackageInfo,
  setupCmux,
  setupHerdr,
  uninstallCmux,
} from "../src/host-setup.mjs";
import { readHerdrSessionSnapshot } from "../src/herdr-context-watch.mjs";
import {
  clearRailTarget,
  listSiblingWorktrees,
  railTargetPath,
  readRailTarget,
  resolveWorktree,
  withWorktreeBranches,
  writeRailTarget,
} from "../src/rail-target.mjs";
import { uninstallSideRail } from "./uninstall-herdr-plugin.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOSTS = ["herdr", "cmux"];

const USAGE = `Usage: siderail <command> [host...]

Commands:
  setup [herdr] [cmux]      Register this install with Herdr and/or the cmux Dock
  uninstall [herdr] [cmux]  Remove this install's Herdr plugin and/or cmux Dock control
  status                    Show the installed version and each host's registration
  version                   Print the installed version
  target <worktree>         Show a Herdr worktree of this repository in this tab's rail
  target --follow           Return this tab's rail to following the focused pane
  target --list [--json]    List the worktrees this tab's rail can show

With no host, setup registers every host found on this machine and uninstall
removes every registration that points at this install.

target acts on the rail in the caller's Herdr tab; pass --tab <tab_id> for
another tab. A worktree is named by its Herdr workspace label, branch,
workspace id, or checkout path, and must be open in Herdr for the same
repository.
`;

function parseTargetArgs(values) {
  const options = { follow: false, list: false, json: false, tab: "", worktree: "" };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--follow") options.follow = true;
    else if (value === "--list") options.list = true;
    else if (value === "--json") options.json = true;
    else if (value === "--tab") {
      options.tab = values[index + 1] || "";
      index += 1;
      if (!options.tab) throw new Error("--tab requires a tab id");
    } else if (value.startsWith("--")) throw new Error(`unknown target option "${value}"`);
    else if (!options.worktree) options.worktree = value;
    else throw new Error(`unexpected argument "${value}"`);
  }
  const modes = [options.follow, options.list, Boolean(options.worktree)].filter(Boolean).length;
  if (modes !== 1) throw new Error("target needs exactly one of <worktree>, --follow, or --list");
  if (options.json && !options.list) throw new Error("--json applies only to --list");
  return options;
}

function resolveTargetTab(snapshot, tabId, environment) {
  if (tabId) {
    const tab = (snapshot.tabs || []).find((candidate) => candidate.tab_id === tabId);
    if (!tab) throw new Error(`no Herdr tab "${tabId}"`);
    return { tabId: tab.tab_id, workspaceId: tab.workspace_id };
  }
  const paneId = environment.HERDR_PANE_ID || "";
  const pane = paneId && (snapshot.panes || []).find((candidate) => candidate.pane_id === paneId);
  if (!pane) throw new Error("cannot tell which Herdr tab to use; run inside Herdr or pass --tab <tab_id>");
  return { tabId: pane.tab_id, workspaceId: pane.workspace_id };
}

async function commandTarget(values, { environment, write, readSnapshot, run }) {
  const options = parseTargetArgs(values);
  const snapshot = await readSnapshot({ socketPath: environment.HERDR_SOCKET_PATH || "" });
  const { tabId, workspaceId } = resolveTargetTab(snapshot, options.tab, environment);
  const worktrees = await withWorktreeBranches(listSiblingWorktrees(snapshot, workspaceId), {
    run: (cwd, args, options) => run("git", ["-C", cwd, ...args], options),
  });
  const targetPath = railTargetPath({ workspaceId, tabId, environment });
  const current = readRailTarget(targetPath);
  if (options.list) {
    if (options.json) {
      write(`${JSON.stringify({ tabId, workspaceId, target: current, worktrees }, null, 2)}\n`);
      return;
    }
    if (!worktrees.length) { write("No Herdr worktrees are open for this workspace's repository.\n"); return; }
    for (const worktree of worktrees) {
      const mark = current?.checkoutPath === worktree.checkoutPath ? "*" : " ";
      write(`${mark} ${sanitizeTerminalText(worktree.label)}\t${sanitizeTerminalText(worktree.branch || "?")}\t${worktree.workspaceId}\t${sanitizeTerminalText(worktree.checkoutPath)}\n`);
    }
    if (!current) write("(rail follows the focused pane)\n");
    return;
  }
  if (options.follow) {
    clearRailTarget(targetPath);
    write(`SideRail in ${tabId} now follows the focused pane.\n`);
    return;
  }
  const worktree = resolveWorktree(worktrees, options.worktree);
  if (!worktree) {
    const choices = worktrees.map((candidate) => candidate.label).join(", ") || "none open";
    throw new Error(`no open worktree "${options.worktree}" for this repository (choices: ${choices})`);
  }
  writeRailTarget(targetPath, worktree);
  write(`SideRail in ${tabId} now shows ${sanitizeTerminalText(worktree.label)} (${sanitizeTerminalText(worktree.checkoutPath)}).\n`);
}

function herdrMissing(error) {
  return error?.kind === "missing-executable";
}

function cmuxPresent(environment, exists) {
  const directories = String(environment.PATH || "").split(path.delimiter).filter(Boolean);
  return directories.some((directory) => exists(path.join(directory, "cmux")))
    || exists("/Applications/cmux.app")
    || (environment.HOME ? exists(path.join(environment.HOME, ".config", "cmux")) : false);
}

async function herdrState(context) {
  try {
    return { available: true, plugin: await findHerdrPlugin(context) };
  } catch (error) {
    if (herdrMissing(error)) return { available: false, plugin: null };
    throw error;
  }
}

function describeRoot(root, installRoot) {
  if (!root) return "unknown path";
  return path.resolve(root) === path.resolve(installRoot) ? "this install" : root;
}

async function commandSetup(hosts, context) {
  const { root, write, environment, exists } = context;
  const explicit = hosts.length > 0;
  const selected = explicit ? hosts : HOSTS;
  let configured = 0;
  for (const host of selected) {
    if (host === "herdr") {
      const state = await herdrState(context);
      if (!state.available) {
        if (explicit) throw new Error("herdr is not installed or not on PATH");
        write("Herdr: not found, skipped\n");
        continue;
      }
      const result = await setupHerdr(context);
      configured += 1;
      if (result.action === "unchanged") write(`Herdr: plugin ${PLUGIN_ID} already linked to this install\n`);
      else if (result.action === "moved") write(`Herdr: plugin ${PLUGIN_ID} moved from ${result.previousRoot} to ${root}\n`);
      else write(`Herdr: linked plugin ${PLUGIN_ID}\n`);
      if (result.action !== "unchanged") {
        write(`  Open it with: herdr plugin action invoke ${PLUGIN_ID}.open-siderail\n`);
        write(`  Bind a toggle key with command "${PLUGIN_ID}.toggle-siderail" (see the README)\n`);
      }
    } else {
      if (!explicit && !cmuxPresent(environment, exists)) {
        write("cmux: not found, skipped\n");
        continue;
      }
      const result = setupCmux(context);
      configured += 1;
      if (result.action === "unchanged") write(`cmux: Dock control already points at this install (${result.configPath})\n`);
      else write(`cmux: ${result.action} the SideRail Dock control in ${result.configPath}\n`);
      if (result.action !== "unchanged") {
        write("  New Docks pick it up automatically; use cmux's Dock config reload for an open Dock.\n");
        write("  A project's own .cmux/dock.json takes precedence over this global control.\n");
      }
    }
  }
  if (!configured) throw new Error("found neither Herdr nor cmux; run \"siderail setup herdr\" or \"siderail setup cmux\" explicitly");
}

async function commandUninstall(hosts, context) {
  const { root, write } = context;
  const explicit = hosts.length > 0;
  const selected = explicit ? hosts : HOSTS;
  for (const host of selected) {
    if (host === "herdr") {
      const state = await herdrState(context);
      if (!state.available) {
        if (explicit) throw new Error("herdr is not installed or not on PATH");
        continue;
      }
      if (!state.plugin) {
        write(`Herdr: plugin ${PLUGIN_ID} is not installed\n`);
        continue;
      }
      if (!explicit && (state.plugin.source !== "local" || path.resolve(state.plugin.root || "") !== path.resolve(root))) {
        write(`Herdr: plugin ${PLUGIN_ID} belongs to ${describeRoot(state.plugin.root, root)}, left in place\n`);
        continue;
      }
      await assertHerdrLinkedHere(context);
      const result = await context.uninstallHerdr({
        environment: context.environment,
        run: context.run,
        pluginRoot: root,
        pluginId: PLUGIN_ID,
      });
      write(`Herdr: unlinked ${result.pluginId}; closed ${result.closedPaneIds.length} verified SideRail pane(s)\n`);
    } else {
      const { control } = findDockControl(context);
      if (!explicit && control && control.command !== dockControl(root).command) {
        write(`cmux: Dock control belongs to ${dockControlRoot(control) || "another command"}, left in place\n`);
        continue;
      }
      const result = uninstallCmux(context);
      write(result.action === "removed"
        ? `cmux: removed the SideRail Dock control from ${result.configPath}\n`
        : "cmux: no SideRail Dock control is configured\n");
    }
  }
}

async function commandStatus(context) {
  const { root, write } = context;
  const info = readPackageInfo(root);
  write(`SideRail ${info.version}\n  install: ${root}\n`);
  const herdr = await herdrState(context);
  if (!herdr.available) write("  herdr:   not found\n");
  else if (!herdr.plugin) write("  herdr:   not set up (run: siderail setup herdr)\n");
  else {
    const where = describeRoot(herdr.plugin.root, root);
    const stale = where !== "this install" ? " — stale; run: siderail setup herdr" : "";
    write(`  herdr:   ${herdr.plugin.source} plugin ${PLUGIN_ID}${herdr.plugin.version ? ` ${herdr.plugin.version}` : ""} at ${where}${herdr.plugin.enabled ? "" : " (disabled)"}${stale}\n`);
  }
  const { configPath, control } = findDockControl(context);
  if (!control) write(`  cmux:    not set up (run: siderail setup cmux)\n`);
  else if (control.command === dockControl(root).command) write(`  cmux:    Dock control at this install (${configPath})\n`);
  else write(`  cmux:    Dock control points at ${dockControlRoot(control) || "another command"} — stale; run: siderail setup cmux\n`);
}

function parseHosts(values) {
  const hosts = [];
  for (const value of values) {
    if (!HOSTS.includes(value)) throw new Error(`unknown host "${value}"; expected herdr or cmux`);
    if (!hosts.includes(value)) hosts.push(value);
  }
  return hosts;
}

export async function main(argv = process.argv.slice(2), {
  root = PACKAGE_ROOT,
  environment = process.env,
  run = runCommand,
  write = (text) => process.stdout.write(text),
  exists = fs.existsSync,
  uninstallHerdr = uninstallSideRail,
  readSnapshot = readHerdrSessionSnapshot,
} = {}) {
  assertSupportedNode();
  const [command, ...rest] = argv;
  const context = { root, environment, run, write, exists, uninstallHerdr, readSnapshot };
  switch (command) {
    case "setup":
      await commandSetup(parseHosts(rest), context);
      return 0;
    case "uninstall":
      await commandUninstall(parseHosts(rest), context);
      return 0;
    case "status":
      await commandStatus(context);
      return 0;
    case "target":
      await commandTarget(rest, context);
      return 0;
    case "version":
    case "--version":
    case "-v":
      write(`${readPackageInfo(root).version}\n`);
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      write(USAGE);
      return 0;
    default:
      write(USAGE);
      throw new Error(`unknown command "${command}"`);
  }
}

const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  // A reader such as `head` or `grep -q` may close the pipe early.
  process.stdout.on("error", (error) => {
    if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw error;
  });
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`siderail: ${sanitizeTerminalText(error.message)}`);
    process.exitCode = 1;
  });
}
