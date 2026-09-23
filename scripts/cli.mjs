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
import { uninstallSideRail } from "./uninstall-herdr-plugin.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOSTS = ["herdr", "cmux"];

const USAGE = `Usage: siderail <command> [host...]

Commands:
  setup [herdr] [cmux]      Register this install with Herdr and/or the cmux Dock
  uninstall [herdr] [cmux]  Remove this install's Herdr plugin and/or cmux Dock control
  status                    Show the installed version and each host's registration
  version                   Print the installed version

With no host, setup registers every host found on this machine and uninstall
removes every registration that points at this install.
`;

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
      const result = await context.uninstallHerdr({ environment: context.environment, run: context.run, pluginRoot: root });
      write(`Herdr: unlinked ${result.pluginId}; closed ${result.closedPaneIds.length} verified SideRail pane(s)\n`);
    } else {
      const { control } = findDockControl(context);
      const controlRoot = dockControlRoot(control);
      if (!explicit && control && (!controlRoot || path.resolve(controlRoot) !== path.resolve(root))) {
        write(`cmux: Dock control belongs to ${describeRoot(controlRoot, root)}, left in place\n`);
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
} = {}) {
  assertSupportedNode();
  const [command, ...rest] = argv;
  const context = { root, environment, run, write, exists, uninstallHerdr };
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
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`siderail: ${sanitizeTerminalText(error.message)}`);
    process.exitCode = 1;
  });
}
