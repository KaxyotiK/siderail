#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTerminalAnsi } from "../src/terminal-ui.mjs";
import { assertSupportedNode } from "../src/node-version.mjs";

assertSupportedNode();

const pluginId = "local.git-rail";
const railLabel = "HERDER GITRAIL";
const previewLabel = "GitRail Preview";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gitrail-live-herdr-"));
const nonGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gitrail-live-nongit-"));
const commandEnvironment = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

for (const key of [
  "HERDR_SOCKET_PATH",
  "HERDR_WORKSPACE_ID",
  "HERDR_TAB_ID",
  "HERDR_PANE_ID",
  "HERDR_PLUGIN_CONTEXT_JSON",
  "HERDR_PLUGIN_EVENT",
]) delete commandEnvironment[key];

if (!commandEnvironment.HERDR_SESSION) {
  throw new Error("HERDR_SESSION must select a disposable named Herdr server");
}

function run(command, args, { cwd = repositoryRoot, allowFailure = false, timeout = 15_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: commandEnvironment,
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
}

function herdr(args, options) {
  return run(commandEnvironment.HERDR_BIN_PATH || "herdr", args, options);
}

function json(command, args, options) {
  const result = run(command, args, options);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`${command} ${args.join(" ")} returned non-JSON output: ${result.stdout}`); }
}

function herdrJson(args, options) {
  return json(commandEnvironment.HERDR_BIN_PATH || "herdr", args, options);
}

function resultItems(payload, key) {
  const items = payload?.result?.[key];
  return Array.isArray(items) ? items : [];
}

function panes() {
  return resultItems(herdrJson(["pane", "list"]), "panes");
}

function tabs() {
  return resultItems(herdrJson(["tab", "list"]), "tabs");
}

function tabPanes(tabId) {
  return panes().filter((pane) => pane.tab_id === tabId);
}

function paneText(paneId, source = "visible") {
  const result = herdr(["pane", "read", paneId, "--source", source, "--format", "text", "--raw"]);
  return stripTerminalAnsi(result.stdout).replaceAll("\r", "");
}

function git(args, options) {
  return run("git", args, { cwd: fixtureRoot, ...options });
}

function write(relativePath, contents) {
  const filePath = path.join(fixtureRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function append(relativePath, contents) {
  fs.appendFileSync(path.join(fixtureRoot, relativePath), contents);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function repositoryInvariant() {
  const indexPathValue = git(["rev-parse", "--git-path", "index"]).stdout.trim();
  const indexPath = path.isAbsolute(indexPathValue) ? indexPathValue : path.join(fixtureRoot, indexPathValue);
  const indexStat = fs.statSync(indexPath, { bigint: true });
  const listed = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).stdout
    .split("\0").filter(Boolean).sort();
  const worktree = listed.map((relativePath) => {
    const absolutePath = path.join(fixtureRoot, relativePath);
    let stat;
    try { stat = fs.lstatSync(absolutePath, { bigint: true }); }
    catch (error) {
      if (error.code === "ENOENT") return { path: relativePath, missing: true };
      throw error;
    }
    const bytes = stat.isSymbolicLink()
      ? Buffer.from(fs.readlinkSync(absolutePath))
      : stat.isFile() ? fs.readFileSync(absolutePath) : Buffer.alloc(0);
    return { path: relativePath, mode: Number(stat.mode), sha256: sha256(bytes) };
  });
  return {
    head: git(["rev-parse", "HEAD"]).stdout,
    refs: git(["for-each-ref", "--format=%(refname)%00%(objectname)%00"]).stdout,
    status: git(["status", "--porcelain=v2", "-z", "--untracked-files=all"]).stdout,
    index: {
      size: indexStat.size.toString(),
      mtimeNs: indexStat.mtimeNs.toString(),
      sha256: sha256(fs.readFileSync(indexPath)),
    },
    worktree,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function eventually(label, operation, { timeout = 12_000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(interval);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

function createWorkspace(cwd, label) {
  const payload = herdrJson(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]);
  return {
    workspaceId: payload.result.workspace.workspace_id,
    tabId: payload.result.tab.tab_id,
    paneId: payload.result.root_pane.pane_id,
  };
}

function createTab(workspaceId, cwd, label) {
  const payload = herdrJson(["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label, "--no-focus"]);
  return {
    tabId: payload.result.tab.tab_id,
    paneId: payload.result.root_pane.pane_id,
  };
}

function focusTab(tabId) {
  herdr(["tab", "focus", tabId]);
}

async function railFor(tabId) {
  return eventually(`GitRail pane in ${tabId}`, () => tabPanes(tabId).find((pane) => pane.label === railLabel));
}

async function openFileFromRail(railPaneId, fileName) {
  const existingPreviews = new Set(panes().filter((pane) => pane.label === previewLabel).map((pane) => pane.pane_id));
  herdr(["pane", "send-text", railPaneId, "/"]);
  await eventually("GitRail search mode", () => paneText(railPaneId).includes("▏"));
  herdr(["pane", "send-keys", railPaneId, "ctrl+u"]);
  await eventually("cleared GitRail search", () => paneText(railPaneId).includes("⌕ ▏"));
  herdr(["pane", "send-text", railPaneId, fileName]);
  await eventually(`${fileName} active search`, () => paneText(railPaneId).includes(`⌕ ${fileName}▏`));
  herdr(["pane", "send-keys", railPaneId, "enter"]);
  await eventually(`${fileName} search result`, () => {
    const text = paneText(railPaneId);
    return text.includes(fileName) && !text.includes(`⌕ ${fileName}▏`);
  });
  herdr(["pane", "send-keys", railPaneId, "j"]);
  await delay(250);
  herdr(["pane", "send-keys", railPaneId, "enter"]);
  return eventually(`${fileName} preview`, () => {
    const pane = panes().find((candidate) => candidate.label === previewLabel && !existingPreviews.has(candidate.pane_id));
    if (!pane) return null;
    return tabs().find((tab) => tab.tab_id === pane.tab_id)?.label === fileName ? pane : null;
  }, { timeout: 30_000 });
}

function assertPaneExists(paneId, expected = true) {
  assert.equal(panes().some((pane) => pane.pane_id === paneId), expected, `${paneId} existence mismatch`);
}

async function waitForPluginEvents(previousCount, increment = 2) {
  await eventually(`${increment} plugin lifecycle events`, () => {
    const logs = resultItems(herdrJson(["plugin", "log", "list", "--plugin", pluginId, "--limit", "100"]), "logs");
    const added = logs.slice(previousCount);
    return added.length >= increment && added.slice(0, increment).every((log) => log.status === "succeeded");
  });
}

function pluginLogCount() {
  return resultItems(herdrJson(["plugin", "log", "list", "--plugin", pluginId, "--limit", "100"]), "logs").length;
}

async function invokeAction(actionId) {
  const payload = herdrJson(["plugin", "action", "invoke", `${pluginId}.${actionId}`]);
  const logId = payload?.result?.log?.log_id;
  assert.ok(logId, `Herdr did not return a command log for ${actionId}`);
  return eventually(`${actionId} completion`, () => {
    const logs = resultItems(herdrJson(["plugin", "log", "list", "--plugin", pluginId, "--limit", "100"]), "logs");
    const log = logs.find((candidate) => candidate.log_id === logId);
    if (!log || log.status === "running") return null;
    assert.equal(log.status, "succeeded", log.stderr || `${actionId} failed`);
    return log;
  }, { timeout: 45_000 });
}

function initializeFixture() {
  git(["init", "--initial-branch=main"]);
  git(["config", "user.name", "GitRail Smoke"]);
  git(["config", "user.email", "gitrail-smoke@example.invalid"]);
  write("clean.md", "# Clean baseline\n\nGlow baseline marker.\n");
  write("modified.md", "tracked baseline\n");
  git(["add", "."]);
  git(["commit", "-m", "baseline"]);
  append("modified.md", "unstaged marker\n");
  write("staged.md", "# Staged Markdown\n\nGlow staged marker.\n");
  git(["add", "staged.md"]);
  write("untracked.md", "# Untracked Markdown\n\nGlow rendered marker.\n");
}

async function main() {
  initializeFixture();
  const beforeInspection = repositoryInvariant();
  const observations = [];
  const watchMode = process.env.GIT_RAIL_WATCH_MODE || "watch-and-poll";
  assert.ok(["watch-only", "poll-only", "watch-and-poll"].includes(watchMode), `unsupported live witness watch mode: ${watchMode}`);

  const beforeGitEvents = pluginLogCount();
  const sourceA = createWorkspace(fixtureRoot, "GitRail live Git");
  await waitForPluginEvents(beforeGitEvents);
  // Herdr can deliver workspace.created before the root pane is queryable. The
  // startup/event supervisor is intentionally idempotent, so reconcile once
  // after both lifecycle commands have completed before inspecting the result.
  run(process.execPath, ["scripts/auto-open-herdr-tabs.mjs"], { timeout: 45_000 });
  const railA = await railFor(sourceA.tabId);
  const initialPanes = tabPanes(sourceA.tabId);
  assert.equal(initialPanes.filter((pane) => pane.label === railLabel).length, 1);
  assert.equal(railA.focused, false);

  const railState = await eventually("initial GitRail render", () => {
    const text = paneText(railA.pane_id);
    return text.includes("Staged") && text.includes("Untracked") ? text : "";
  });
  for (const expected of ["Staged", "Unstaged", "Untracked", "staged.md", "modified.md", "untracked.md", "?"]) {
    assert.match(railState, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  observations.push("auto-open and Staged/Unstaged/Untracked separation");

  const beforeNonGitEvents = pluginLogCount();
  const nonGit = createWorkspace(nonGitRoot, "GitRail live non-Git");
  await waitForPluginEvents(beforeNonGitEvents);
  assert.deepEqual(tabPanes(nonGit.tabId).map((pane) => pane.pane_id), [nonGit.paneId]);
  observations.push("non-Git auto-open exclusion");

  const split = herdrJson(["pane", "split", sourceA.paneId, "--direction", "down", "--ratio", "0.30", "--cwd", fixtureRoot, "--focus"]);
  const unrelatedPaneId = split.result.pane.pane_id;
  focusTab(sourceA.tabId);
  await invokeAction("toggle-git-rail");
  await eventually("manual Toggle close", () => !tabPanes(sourceA.tabId).some((pane) => pane.label === railLabel));
  assertPaneExists(sourceA.paneId);
  assertPaneExists(unrelatedPaneId);

  run(process.execPath, ["scripts/auto-open-herdr-tabs.mjs"], {
    timeout: 45_000,
  });
  assert.equal(tabPanes(sourceA.tabId).some((pane) => pane.label === railLabel), false, "automatic ensure changed an unsafe layout");
  assertPaneExists(sourceA.paneId);
  assertPaneExists(unrelatedPaneId);

  focusTab(sourceA.tabId);
  await invokeAction("open-git-rail");
  assert.equal(tabPanes(sourceA.tabId).some((pane) => pane.label === railLabel), false, "manual open changed an unsafe layout");
  assertPaneExists(sourceA.paneId);
  assertPaneExists(unrelatedPaneId);
  herdr(["pane", "close", unrelatedPaneId]);
  assertPaneExists(unrelatedPaneId, false);
  focusTab(sourceA.tabId);
  await invokeAction("open-git-rail");
  const rebuiltRailA = await railFor(sourceA.tabId);
  assertPaneExists(sourceA.paneId);
  observations.push("manual Toggle and automatic/manual unsafe-layout skips without pane reconstruction");

  focusTab(sourceA.tabId);
  const previewA1 = await openFileFromRail(rebuiltRailA.pane_id, "untracked.md");
  const previewTabsBefore = tabs();
  await eventually("preview tab auto-open exclusion", () => tabPanes(previewA1.tab_id).length === 1);
  assert.equal(tabPanes(previewA1.tab_id)[0].label, previewLabel);
  assert.ok(previewTabsBefore.some((tab) => tab.tab_id === previewA1.tab_id));

  await eventually("automatic Glow TUI", () => {
    const text = paneText(previewA1.pane_id);
    return text.includes("Glow rendered marker") && !text.includes("HERDR GITRAIL PREVIEW");
  }, { timeout: 20_000 });
  herdr(["pane", "send-text", previewA1.pane_id, "q"]);
  await eventually("preview controls after Glow", () => /1 Diff\s+2 Raw\s+3 Rendered/.test(paneText(previewA1.pane_id)));
  herdr(["pane", "send-text", previewA1.pane_id, "1"]);
  await eventually("Diff action", () => paneText(previewA1.pane_id).includes("Untracked · index → worktree") || paneText(previewA1.pane_id).includes("Untracked · new file"));
  herdr(["pane", "send-text", previewA1.pane_id, "2"]);
  await eventually("Raw action", () => paneText(previewA1.pane_id).includes("Glow rendered marker"));
  herdr(["pane", "send-text", previewA1.pane_id, "3"]);
  await eventually("Glow TUI action", () => {
    const text = paneText(previewA1.pane_id);
    return text.includes("Glow rendered marker") && !text.includes("HERDR GITRAIL PREVIEW");
  }, { timeout: 20_000 });
  herdr(["pane", "send-text", previewA1.pane_id, "q"]);
  await eventually("return from Glow TUI", () => paneText(previewA1.pane_id).includes("Returned from glow"));
  observations.push("Diff/Raw/action-3 Glow TUI and preview-tab exclusion");

  const beforeSourceBEvents = pluginLogCount();
  const sourceB = createTab(sourceA.workspaceId, fixtureRoot, "source-b");
  await waitForPluginEvents(beforeSourceBEvents, 1);
  run(process.execPath, ["scripts/auto-open-herdr-tabs.mjs"], { timeout: 45_000 });
  const railB = await railFor(sourceB.tabId);
  focusTab(sourceB.tabId);
  const previewB1 = await openFileFromRail(railB.pane_id, "staged.md");
  assertPaneExists(previewA1.pane_id);

  focusTab(sourceA.tabId);
  const previewA2 = await openFileFromRail(rebuiltRailA.pane_id, "modified.md");
  await eventually("source-A preview replacement", () => !panes().some((pane) => pane.pane_id === previewA1.pane_id), { timeout: 30_000 });
  assertPaneExists(previewA2.pane_id);
  assertPaneExists(previewB1.pane_id);
  observations.push("per-source-tab preview replacement");

  assert.deepEqual(repositoryInvariant(), beforeInspection);
  observations.push("inspection preserved HEAD, refs, status, index bytes/mtime, and worktree bytes");

  focusTab(sourceA.tabId);
  append("modified.md", "manual refresh marker\n");
  herdr(["pane", "send-text", rebuiltRailA.pane_id, "r"]);
  await eventually("manual refresh confirmation", () => paneText(rebuiltRailA.pane_id).includes("Git state refreshed"));

  git(["switch", "-c", "live-refresh"]);
  await eventually("watcher or recovery-poll branch convergence", () => paneText(rebuiltRailA.pane_id).includes("live-refresh"), { timeout: 20_000 });

  const gitShim = process.env.GIT_RAIL_LIVE_GIT_SHIM;
  assert.ok(gitShim && fs.existsSync(gitShim), "GIT_RAIL_LIVE_GIT_SHIM must name the live server's isolated git executable");
  const disabledGitShim = `${gitShim}.disabled`;
  fs.renameSync(gitShim, disabledGitShim);
  try {
    herdr(["pane", "send-text", rebuiltRailA.pane_id, "r"]);
    await eventually("failed refresh status", () => paneText(rebuiltRailA.pane_id).includes("Refresh failed"));
    assert.match(paneText(rebuiltRailA.pane_id), /live-refresh/);
  } finally {
    fs.renameSync(disabledGitShim, gitShim);
  }
  herdr(["pane", "send-text", rebuiltRailA.pane_id, "r"]);
  await eventually("refresh recovery", () => {
    const text = paneText(rebuiltRailA.pane_id);
    return text.includes("live-refresh") && !text.includes("Refresh failed");
  });
  observations.push(`manual refresh, ${watchMode} convergence, and failure-state preservation`);

  focusTab(sourceA.tabId);
  await invokeAction("open-git-rail-mockup");
  const demoPane = await eventually("live demo pane", () => panes().find((pane) => pane.label === "GitRail Demo"));
  const demoText = await eventually("live demo content", () => {
    const text = paneText(demoPane.pane_id);
    return text.includes("Staged") && text.includes("Untracked") ? text : "";
  });
  assert.match(demoText, /Staged/);
  for (const width of [36, 52, 100]) {
    assert.ok(fs.statSync(path.join(repositoryRoot, "docs", "screenshots", `gitrail-${width}.png`)).size > 10_000);
  }
  observations.push("real demo pane and checked-in 36/52/100 capture artifacts");

  process.stdout.write(`${JSON.stringify({
    type: "live_herdr_smoke",
    platform: process.platform,
    node: process.version,
    herdr: herdr(["--version"]).stdout.trim(),
    watchMode,
    observations,
  }, null, 2)}\n`);
}

try {
  await main();
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.rmSync(nonGitRoot, { recursive: true, force: true });
}
