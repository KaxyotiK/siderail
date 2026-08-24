#!/usr/bin/env node
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquirePaneStateLock,
  ensurePaneStateDirectory,
  legacyPaneStatePath,
  paneStatePath,
  readPaneState,
  removeLegacyPaneState,
  writePaneState,
} from "../src/herdr-pane-state.mjs";
import { runCommand } from "../src/process.mjs";
import { sanitizeTerminalText } from "../src/terminal-ui.mjs";
import { assertSupportedNode } from "../src/node-version.mjs";
import { resizeConfiguredSidebar } from "./resize-herdr-sidebar.mjs";

const RAIL_LABEL = "HERDER GITRAIL";
assertSupportedNode();
const LEGACY_RAIL_LABEL = "Grove Git Rail";
const DEMO_LABEL = "GitRail Demo";
const PREVIEW_LABEL = "GitRail Preview";
const STAGING_LABEL = "GitRail Layout Staging";
const MAX_SOCKET_BYTES = 1024 * 1024;
const MAX_LAYOUT_DEPTH = 16;
const MAX_LAYOUT_PANES = 24;
const LAYOUT_JOURNAL_VERSION = 2;
const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let activeLayoutRecovery = null;
let activeLayoutAbort = null;
let activeLayoutSettled = null;
let layoutTerminationRequested = false;

function createRecoveryBudget(durationMs, now = () => performance.now()) {
  const deadline = now() + durationMs;
  return {
    remaining(maximumMs = 1_000) {
      const remaining = Math.floor(deadline - now());
      if (remaining <= 0) throw new Error("layout recovery budget exhausted");
      return Math.max(1, Math.min(maximumMs, remaining));
    },
  };
}

function recoveryCommandOptions(budget, maxOutputBytes) {
  return {
    timeoutMs: budget.remaining(1_000),
    maxOutputBytes,
    killGraceMs: 0,
    waitForTermination: true,
  };
}

function mergeCommandOptions(defaults, overrides) {
  return overrides ? { ...defaults, ...overrides } : defaults;
}

function safeToken(value) {
  return String(value || "").replace(/[^A-Za-z0-9._-]+/g, "_");
}

function layoutTransactionDirectory(environment = process.env) {
  const cacheRoot = environment.XDG_CACHE_HOME || path.join(environment.HOME || os.homedir(), ".cache");
  return path.join(cacheRoot, "herdr-gitrail", "layout-transactions");
}

function layoutJournalPath(environment, workspaceId, tabId) {
  return path.join(layoutTransactionDirectory(environment), `${safeToken(workspaceId)}-${safeToken(tabId)}.json`);
}

async function durableJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  const handle = await fs.open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, filePath);
}

async function persistLayoutTransaction(transaction) {
  transaction.updatedAt = Date.now();
  await durableJson(transaction.journalPath, transaction);
}

async function journaledMove(transaction, run, herdr, args, destination) {
  if (layoutTerminationRequested) throw new Error("layout transaction interrupted before mutation");
  transaction.pendingOperation = { kind: "move", args, destination };
  await persistLayoutTransaction(transaction);
  if (layoutTerminationRequested) throw new Error("layout transaction interrupted before mutation");
  const result = await movePane(run, herdr, args, destination, transaction.commandOptions || null);
  transaction.completedOperations = (transaction.completedOperations || 0) + 1;
  transaction.pendingOperation = null;
  await persistLayoutTransaction(transaction);
  return result;
}

const ENTRYPOINT_IDENTITIES = Object.freeze({
  "git-tui": { current: [RAIL_LABEL], legacy: [LEGACY_RAIL_LABEL] },
  "git-mockup": { current: [DEMO_LABEL], legacy: [] },
});

function parseJson(value) {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

function responseItems(payload, key) {
  const parsed = typeof payload === "string" ? parseJson(payload) : payload;
  const items = parsed?.result?.[key];
  return Array.isArray(items) ? items : [];
}

function resultPaneId(payload) {
  const result = parseJson(payload)?.result || {};
  return result.plugin_pane?.pane?.pane_id || result.pane?.pane_id || result.pane_id || "";
}

function focusedWorkspace(payload) {
  return responseItems(payload, "workspaces").find((workspace) => workspace.focused);
}

function paneFromPayload(payload) {
  return parseJson(payload)?.result?.pane || null;
}

function entrypointIdentity(entrypoint) {
  return ENTRYPOINT_IDENTITIES[entrypoint] || { current: [], legacy: [] };
}

function hasLabel(pane, labels) {
  return labels.includes(pane?.label);
}

function sourcePane(tabPanes, requestedPaneId, layout, ownedPaneIds = new Set(), entrypoint = "git-tui") {
  const otherEntrypointLabels = entrypoint === "git-mockup"
    ? new Set([RAIL_LABEL, LEGACY_RAIL_LABEL])
    : new Set([DEMO_LABEL]);
  const usable = tabPanes.filter((pane) => (
    pane.label !== PREVIEW_LABEL
    && !otherEntrypointLabels.has(pane.label)
    && !ownedPaneIds.has(pane.pane_id)
  ));
  return usable.find((pane) => pane.pane_id === requestedPaneId)
    || usable.find((pane) => pane.pane_id === layout?.focused_pane_id)
    || usable[0]
    || null;
}

function moveResult(payload) {
  return parseJson(payload)?.result?.move_result || null;
}

function assertMoved(payload, destination) {
  const moved = moveResult(payload);
  if (!moved?.changed) {
    const reason = moved?.reason ? ` (${sanitizeTerminalText(moved.reason)})` : "";
    throw new Error(`Herdr could not move the GitRail pane to ${destination}${reason}`);
  }
  return moved;
}

function sameRect(left, right) {
  return left && right && ["x", "y", "width", "height"].every((key) => left[key] === right[key]);
}

function boundsOf(items) {
  const x = Math.min(...items.map((item) => item.rect.x));
  const y = Math.min(...items.map((item) => item.rect.y));
  const right = Math.max(...items.map((item) => item.rect.x + item.rect.width));
  const bottom = Math.max(...items.map((item) => item.rect.y + item.rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

function snapshotTree(layout, paneIds = null) {
  const allowed = paneIds ? new Set(paneIds) : null;
  const items = (layout?.panes || [])
    .filter((pane) => pane.rect && (!allowed || allowed.has(pane.pane_id)))
    .map((pane) => ({ paneId: pane.pane_id, rect: pane.rect }));
  const build = (members) => {
    if (members.length === 1) return { type: "pane", paneId: members[0].paneId };
    const bounds = boundsOf(members);
    const declared = (layout?.splits || []).find((split) => sameRect(split.rect, bounds));
    const candidates = declared ? [declared] : [
      ...new Set(members.flatMap((item) => [item.rect.x, item.rect.x + item.rect.width]))
    ].filter((boundary) => boundary > bounds.x && boundary < bounds.x + bounds.width)
      .map((boundary) => ({ direction: "right", boundary }));
    if (!declared) {
      candidates.push(...[...new Set(members.flatMap((item) => [item.rect.y, item.rect.y + item.rect.height]))]
        .filter((boundary) => boundary > bounds.y && boundary < bounds.y + bounds.height)
        .map((boundary) => ({ direction: "down", boundary })));
    }
    for (const candidate of candidates) {
      const direction = candidate.direction;
      const boundary = candidate.boundary ?? (direction === "right"
        ? bounds.x + bounds.width * candidate.ratio
        : bounds.y + bounds.height * candidate.ratio);
      const first = members.filter((item) => (
        direction === "right"
          ? item.rect.x + item.rect.width <= boundary + 1
          : item.rect.y + item.rect.height <= boundary + 1
      ));
      const second = members.filter((item) => (
        direction === "right" ? item.rect.x >= boundary - 1 : item.rect.y >= boundary - 1
      ));
      if (first.length === 0 || second.length === 0 || first.length + second.length !== members.length) continue;
      return {
        type: "split",
        direction,
        ratio: candidate.ratio ?? (direction === "right"
          ? (boundary - bounds.x) / bounds.width
          : (boundary - bounds.y) / bounds.height),
        first: build(first),
        second: build(second),
      };
    }
    throw new Error("unable to reconstruct the current Herdr pane layout");
  };
  return items.length > 0 ? build(items) : null;
}

function normalizeExportedTree(node, depth = 0, state = { leaves: 0 }) {
  if (!node || depth > MAX_LAYOUT_DEPTH) return null;
  if (node.type === "pane") {
    if (typeof node.pane_id !== "string" || !node.pane_id || ++state.leaves > MAX_LAYOUT_PANES) return null;
    return { type: "pane", paneId: node.pane_id };
  }
  if (node.type !== "split" || !["right", "down"].includes(node.direction)
    || !Number.isFinite(node.ratio) || node.ratio < 0.1 || node.ratio > 0.9) return null;
  const first = normalizeExportedTree(node.first, depth + 1, state);
  const second = normalizeExportedTree(node.second, depth + 1, state);
  if (!first || !second) return null;
  return {
    type: "split",
    direction: node.direction,
    ratio: node.ratio,
    first,
    second,
  };
}

function validatedTree(node, expectedPaneIds) {
  if (!node) return null;
  const actual = treeLeaves(node).sort();
  const expected = [...expectedPaneIds].sort();
  return actual.length === expected.length && actual.every((paneId, index) => paneId === expected[index])
    ? node
    : null;
}

function pruneTree(node, excluded) {
  if (!node) return null;
  if (node.type === "pane") return excluded.has(node.paneId) ? null : node;
  const first = pruneTree(node.first, excluded);
  const second = pruneTree(node.second, excluded);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function firstLeaf(node) {
  return node.type === "pane" ? node.paneId : firstLeaf(node.first);
}

function treeLeaves(node) {
  return node.type === "pane" ? [node.paneId] : [...treeLeaves(node.first), ...treeLeaves(node.second)];
}

function treeInsertions(node, output = []) {
  if (node.type === "pane") return output;
  output.push({
    paneId: firstLeaf(node.second),
    targetPaneId: firstLeaf(node.first),
    direction: node.direction,
    ratio: node.ratio,
  });
  treeInsertions(node.first, output);
  treeInsertions(node.second, output);
  return output;
}

async function exportLayoutFromSocket(environment, tabId) {
  const socketPath = environment.HERDR_SOCKET_PATH;
  if (!socketPath) return null;
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  const id = `git-rail-layout-${process.pid}-${Date.now()}`;
  return new Promise((resolve) => {
    const client = net.createConnection(endpoint);
    let buffer = "";
    const finish = (value) => {
      client.destroy();
      resolve(value);
    };
    client.setTimeout(2_000, () => finish(null));
    client.on("connect", () => client.write(`${JSON.stringify({
      id,
      method: "layout.export",
      params: { tab_id: tabId },
    })}\n`));
    client.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > MAX_SOCKET_BYTES) return finish(null);
      const line = buffer.split("\n")[0];
      if (!line) return;
      const response = parseJson(line);
      if (response.id === id) finish(normalizeExportedTree(response?.result?.layout?.root));
    });
    client.on("error", () => finish(null));
    client.on("end", () => finish(null));
  });
}

export function rightmostPaneId(layout, panes) {
  const allowed = new Set(panes.map((pane) => pane.pane_id));
  return (layout?.panes || [])
    .filter((pane) => allowed.has(pane.pane_id) && pane.rect)
    .sort((left, right) => (
      (right.rect.x + right.rect.width) - (left.rect.x + left.rect.width)
      || right.rect.x - left.rect.x
      || right.rect.y - left.rect.y
    ))[0]?.pane_id || panes[0]?.pane_id || "";
}

async function commandJson(run, command, args, options = {}) {
  const result = await run(command, args, options);
  return { result, payload: parseJson(result.stdout) };
}

async function globalFocusLocation(run, herdr) {
  const { payload } = await commandJson(run, herdr, ["workspace", "list"], {
    timeoutMs: 5_000,
    maxOutputBytes: 2 * 1_024 * 1_024,
  });
  const workspace = focusedWorkspace(payload);
  return workspace?.workspace_id && workspace?.active_tab_id
    ? { workspaceId: workspace.workspace_id, tabId: workspace.active_tab_id }
    : null;
}

async function restoreGlobalFocus(run, herdr, location) {
  if (!location) return;
  await run(herdr, ["workspace", "focus", location.workspaceId], {
    timeoutMs: 5_000,
    maxOutputBytes: 256 * 1_024,
  });
  await run(herdr, ["tab", "focus", location.tabId], {
    timeoutMs: 5_000,
    maxOutputBytes: 256 * 1_024,
  });
}

async function resolveInvocation(environment, herdr, run) {
  const context = parseJson(environment.HERDR_PLUGIN_CONTEXT_JSON);
  let workspaceId = environment.HERDR_WORKSPACE_ID || context.workspace_id || "";
  let tabId = environment.HERDR_TAB_ID || context.tab_id || "";
  let requestedPaneId = environment.HERDR_PANE_ID || environment.HERDR_TARGET_PANE_ID || context.focused_pane_id || "";
  let workspaceCwd = environment.GIT_RAIL_WORKSPACE_CWD
    || context.worktree?.checkout_path
    || context.focused_pane_cwd
    || context.workspace_cwd
    || "";

  if (!workspaceId) {
    const { payload } = await commandJson(run, herdr, ["workspace", "list"]);
    const workspace = focusedWorkspace(payload);
    workspaceId = workspace?.workspace_id || "";
    tabId ||= workspace?.active_tab_id || "";
  }
  if (requestedPaneId && (!tabId || !workspaceId || !workspaceCwd)) {
    try {
      const { payload } = await commandJson(run, herdr, ["pane", "get", requestedPaneId]);
      const pane = paneFromPayload(payload);
      workspaceId ||= pane?.workspace_id || "";
      tabId ||= pane?.tab_id || "";
      workspaceCwd ||= pane?.foreground_cwd || pane?.cwd || "";
    } catch {}
  }
  if (!workspaceId) throw new Error("unable to resolve Herdr workspace");
  return { context, workspaceId, tabId, requestedPaneId, workspaceCwd };
}

async function closeOwnedPane(run, herdr, paneId, { quiet = false, commandOptions = null } = {}) {
  try {
    await run(herdr, ["plugin", "pane", "close", paneId], commandOptions || {
      timeoutMs: 5_000,
      maxOutputBytes: 256 * 1_024,
    });
    return true;
  } catch (error) {
    if (quiet) return false;
    throw error;
  }
}

async function verifiedOwnedRail(run, herdr, pane, state, entrypoint) {
  if (state?.paneId === pane.pane_id && state.terminalId
    && state.terminalId !== pane.terminal_id) return false;
  try {
    const { payload } = await commandJson(run, herdr, ["pane", "process-info", "--pane", pane.pane_id], {
      timeoutMs: 3_000,
      maxOutputBytes: 256 * 1_024,
    });
    const processes = payload?.result?.process_info?.foreground_processes || [];
    return processes.some((processInfo) => {
      const argv = Array.isArray(processInfo.argv) ? processInfo.argv.map(String) : [];
      const cwd = processInfo.cwd ? path.resolve(String(processInfo.cwd)) : "";
      const scriptArgument = argv.find((argument) => argument === "scripts/git-rail.mjs"
        || argument.endsWith("/scripts/git-rail.mjs"));
      if (!scriptArgument || !cwd) return false;
      const scriptPath = path.isAbsolute(scriptArgument)
        ? path.resolve(scriptArgument)
        : path.resolve(cwd, scriptArgument);
      const isGitRail = scriptPath === path.join(PLUGIN_ROOT, "scripts/git-rail.mjs");
      const isDemo = argv.includes("--demo");
      return isGitRail && (entrypoint === "git-mockup" ? isDemo : !isDemo);
    });
  } catch (error) {
    throw new Error(
      `unable to verify ownership of existing GitRail pane ${sanitizeTerminalText(pane.pane_id)}: ${sanitizeTerminalText(error.message)}`,
    );
  }
}

async function cleanupInterruptedRailOpen({ run, herdr, transaction, budget }) {
  if (transaction.pendingOperation?.kind !== "open-rail" || transaction.railPaneId) return;
  if (!Array.isArray(transaction.priorPaneIds)) {
    throw new Error("layout recovery has no pre-open pane inventory");
  }
  const { payload } = await commandJson(
    run,
    herdr,
    ["pane", "list", "--workspace", transaction.workspaceId],
    recoveryCommandOptions(budget, 8 * 1_024 * 1_024),
  );
  const prior = new Set(transaction.priorPaneIds);
  const labels = entrypointIdentity(transaction.entrypoint).current;
  const candidates = responseItems(payload, "panes").filter((pane) => (
    pane.workspace_id === transaction.workspaceId
    && !prior.has(pane.pane_id)
    && hasLabel(pane, labels)
  ));
  for (const pane of candidates) {
    if (!pane.terminal_id || !await verifiedOwnedRail(run, herdr, pane, null, transaction.entrypoint)) {
      throw new Error(`layout recovery cannot prove interrupted pane ${sanitizeTerminalText(pane.pane_id)} is owned`);
    }
    await closeOwnedPane(run, herdr, pane.pane_id, {
      commandOptions: recoveryCommandOptions(budget, 256 * 1_024),
    });
  }
}

async function movePane(run, herdr, args, destination, commandOptions = null) {
  const moved = await run(herdr, ["pane", "move", ...args], commandOptions || {
    timeoutMs: 8_000,
    maxOutputBytes: 2 * 1_024 * 1_024,
  });
  return assertMoved(moved.stdout, destination);
}

async function validateOpenedRail({
  run,
  herdr,
  paneId,
  workspaceId,
  tabId = "",
  entrypoint,
  priorPaneIds,
  commandOptions = null,
}) {
  if (priorPaneIds.has(paneId)) throw new Error("Herdr returned an existing pane instead of the opened GitRail pane");
  const { payload } = await commandJson(run, herdr, ["pane", "get", paneId], mergeCommandOptions({
    timeoutMs: 3_000,
    maxOutputBytes: 256 * 1_024,
  }, commandOptions));
  const pane = payload?.result?.pane;
  const labels = entrypointIdentity(entrypoint).current;
  if (!pane || pane.pane_id !== paneId || pane.workspace_id !== workspaceId
    || (tabId && pane.tab_id !== tabId) || !hasLabel(pane, labels)) {
    throw new Error("Herdr returned an invalid GitRail pane after opening the plugin");
  }
  return pane;
}

async function workspacePaneIds(run, herdr, workspaceId, commandOptions = null) {
  const { payload } = await commandJson(run, herdr, ["pane", "list", "--workspace", workspaceId], mergeCommandOptions({
    timeoutMs: 5_000,
    maxOutputBytes: 8 * 1_024 * 1_024,
  }, commandOptions));
  return new Set(responseItems(payload, "panes").map((pane) => pane.pane_id));
}

async function workspaceTabIds(run, herdr, workspaceId, commandOptions = null) {
  const { payload } = await commandJson(run, herdr, ["tab", "list"], mergeCommandOptions({
    timeoutMs: 5_000,
    maxOutputBytes: 8 * 1_024 * 1_024,
  }, commandOptions));
  return new Set(responseItems(payload, "tabs")
    .filter((tab) => tab.workspace_id === workspaceId)
    .map((tab) => tab.tab_id));
}

async function openRailInTab({
  run,
  herdr,
  pluginId,
  entrypoint,
  workspaceId,
  sourceTabId,
  workspaceCwd,
  sourcePaneId,
  commandOptions = null,
}) {
  const args = [
    "plugin", "pane", "open",
    "--plugin", pluginId,
    "--entrypoint", entrypoint,
    "--placement", "tab",
    "--workspace", workspaceId,
    "--no-focus",
  ];
  if (workspaceCwd) args.push("--env", `GIT_RAIL_REPO_ROOT=${workspaceCwd}`);
  if (sourcePaneId) args.push("--env", `GIT_RAIL_SOURCE_PANE_ID=${sourcePaneId}`);
  if (sourceTabId) args.push("--env", `GIT_RAIL_SOURCE_TAB_ID=${sourceTabId}`);
  const [priorPaneIds, priorTabIds] = await Promise.all([
    workspacePaneIds(run, herdr, workspaceId, commandOptions),
    workspaceTabIds(run, herdr, workspaceId, commandOptions),
  ]);
  const opened = await run(herdr, args, mergeCommandOptions({
    timeoutMs: 8_000,
    maxOutputBytes: 2 * 1_024 * 1_024,
  }, commandOptions));
  const paneId = resultPaneId(opened.stdout);
  if (!paneId) throw new Error("Herdr did not return the opened GitRail pane id");
  const currentTabIds = await workspaceTabIds(run, herdr, workspaceId, commandOptions);
  const createdTabIds = [...currentTabIds].filter((tabId) => !priorTabIds.has(tabId));
  if (createdTabIds.length !== 1) throw new Error("Herdr did not create one identifiable GitRail tab");
  await validateOpenedRail({
    run,
    herdr,
    paneId,
    workspaceId,
    tabId: createdTabIds[0],
    entrypoint,
    priorPaneIds,
    commandOptions,
  });
  return { paneId, stdout: opened.stdout };
}

function paneAtOuterRight(layout, paneId) {
  const pane = (layout?.panes || []).find((item) => item.pane_id === paneId);
  const area = layout?.area;
  return Boolean(pane?.rect && area
    && pane.rect.height === area.height
    && pane.rect.y === area.y
    && pane.rect.x + pane.rect.width === area.x + area.width);
}

async function stageContentPanes({ run, herdr, workspaceId, tabId, paneIds, transaction = null }) {
  if (paneIds.length === 0) return "";
  const move = transaction ? (args, destination) => journaledMove(transaction, run, herdr, args, destination) : (args, destination) => movePane(run, herdr, args, destination);
  await move([
    paneIds[0], "--new-tab", "--workspace", workspaceId,
    "--label", STAGING_LABEL, "--no-focus",
  ], "a temporary GitRail layout tab");
  const stagingTabId = await paneTabId(run, herdr, paneIds[0]);
  if (!stagingTabId || stagingTabId === tabId) {
    throw new Error("Herdr did not move content into a temporary layout tab");
  }
  for (const paneId of paneIds.slice(1)) {
    await move([
      paneId, "--tab", stagingTabId, "--split", "right",
      "--target-pane", paneIds[0], "--no-focus",
    ], "the temporary GitRail layout tab");
  }
  return stagingTabId;
}

async function paneTabId(run, herdr, paneId, commandOptions = null) {
  try {
    const { payload } = await commandJson(run, herdr, ["pane", "get", paneId], commandOptions || {
      timeoutMs: 3_000,
      maxOutputBytes: 256 * 1_024,
    });
    return payload?.result?.pane?.tab_id || "";
  } catch {
    return "";
  }
}

async function stageTreeForRecovery({
  run,
  herdr,
  workspaceId,
  tabId,
  tree,
  budget = createRecoveryBudget(15_000),
}) {
  const paneIds = treeLeaves(tree).slice(1);
  if (paneIds.length === 0) return "";
  const locations = new Map();
  for (const paneId of paneIds) {
    locations.set(paneId, await paneTabId(
      run,
      herdr,
      paneId,
      recoveryCommandOptions(budget, 256 * 1_024),
    ));
  }
  let stagingAnchor = paneIds.find((paneId) => locations.get(paneId) && locations.get(paneId) !== tabId);
  let stagingTabId = stagingAnchor ? locations.get(stagingAnchor) : "";
  if (!stagingAnchor) {
    stagingAnchor = paneIds[0];
    await movePane(run, herdr, [
      stagingAnchor, "--new-tab", "--workspace", workspaceId,
      "--label", STAGING_LABEL, "--no-focus",
    ], "a recovery layout tab", recoveryCommandOptions(budget, 2 * 1_024 * 1_024));
    stagingTabId = await paneTabId(
      run,
      herdr,
      stagingAnchor,
      recoveryCommandOptions(budget, 256 * 1_024),
    );
    if (!stagingTabId || stagingTabId === tabId) throw new Error("Herdr did not create the recovery layout tab");
  }
  for (const paneId of paneIds) {
    if (paneId === stagingAnchor || locations.get(paneId) === stagingTabId) continue;
    await movePane(run, herdr, [
      paneId, "--tab", stagingTabId, "--split", "right",
      "--target-pane", stagingAnchor, "--no-focus",
    ], "the recovery layout tab", recoveryCommandOptions(budget, 2 * 1_024 * 1_024));
  }
  return stagingTabId;
}

async function restoreContentTree({
  run,
  herdr,
  tabId,
  contentTree,
  restoreFocusPaneId,
  continueOnError = false,
  transaction = null,
  budget = null,
}) {
  let firstError = null;
  const move = transaction
    ? (args, destination) => journaledMove(transaction, run, herdr, args, destination)
    : (args, destination) => movePane(
      run,
      herdr,
      args,
      destination,
      budget ? recoveryCommandOptions(budget, 2 * 1_024 * 1_024) : null,
    );
  for (const insertion of treeInsertions(contentTree)) {
    const focusArg = insertion.paneId === restoreFocusPaneId ? "--focus" : "--no-focus";
    try {
      await move([
        insertion.paneId,
        "--tab", tabId,
        "--split", insertion.direction,
        "--target-pane", insertion.targetPaneId,
        "--ratio", String(insertion.ratio),
        focusArg,
      ], "the recovered content layout");
    } catch (error) {
      if (!continueOnError) throw error;
      firstError ||= error;
    }
  }
  if (firstError) throw firstError;
}

async function verifyRecoveryOwnership({ run, herdr, transaction, budget }) {
  const { payload: tabsPayload } = await commandJson(
    run,
    herdr,
    ["tab", "list"],
    recoveryCommandOptions(budget, 4 * 1_024 * 1_024),
  );
  const tabs = new Map(responseItems(tabsPayload, "tabs").map((tab) => [tab.tab_id, tab]));
  for (const paneId of treeLeaves(transaction.recoveryTree)) {
    const expectedTerminalId = transaction.paneTerminalIds?.[paneId];
    if (!expectedTerminalId) {
      throw new Error(`layout recovery has no instance identity for pane ${sanitizeTerminalText(paneId)}`);
    }
    const { payload } = await commandJson(
      run,
      herdr,
      ["pane", "get", paneId],
      recoveryCommandOptions(budget, 256 * 1_024),
    );
    const pane = payload?.result?.pane;
    if (!pane || pane.pane_id !== paneId || pane.terminal_id !== expectedTerminalId
      || pane.workspace_id !== transaction.workspaceId) {
      throw new Error(`layout recovery cannot verify pane ${sanitizeTerminalText(paneId)}`);
    }
    if (pane.tab_id !== transaction.tabId && tabs.get(pane.tab_id)?.label !== STAGING_LABEL) {
      throw new Error(`layout recovery found pane ${sanitizeTerminalText(paneId)} in an unowned tab`);
    }
  }
}

async function recoverLayoutTransaction({ run, herdr, transaction, budget = createRecoveryBudget(15_000) }) {
  if (transaction.version !== LAYOUT_JOURNAL_VERSION || !transaction.workspaceId || !transaction.tabId || !transaction.recoveryTree) {
    throw new Error("invalid GitRail layout transaction journal");
  }
  await verifyRecoveryOwnership({ run, herdr, transaction, budget });
  await cleanupInterruptedRailOpen({ run, herdr, transaction, budget });
  if (transaction.createdRail && transaction.railPaneId) {
    try {
      const { payload } = await commandJson(
        run,
        herdr,
        ["pane", "get", transaction.railPaneId],
        recoveryCommandOptions(budget, 256 * 1_024),
      );
      const pane = payload?.result?.pane;
      if (pane && await verifiedOwnedRail(run, herdr, pane, null, transaction.entrypoint)) {
        await closeOwnedPane(run, herdr, transaction.railPaneId, {
          quiet: true,
          commandOptions: recoveryCommandOptions(budget, 256 * 1_024),
        });
      }
    } catch {}
  }
  await stageTreeForRecovery({
    run,
    herdr,
    workspaceId: transaction.workspaceId,
    tabId: transaction.tabId,
    tree: transaction.recoveryTree,
    budget,
  });
  await restoreContentTree({
    run,
    herdr,
    tabId: transaction.tabId,
    contentTree: transaction.recoveryTree,
    restoreFocusPaneId: transaction.restoreFocusPaneId || "",
    continueOnError: true,
    budget,
  });
  budget.remaining();
  await fs.rm(transaction.journalPath, { force: true });
}

export async function recoverLayoutTransactions({
  environment = process.env,
  run = runCommand,
  herdr = environment.HERDR_BIN_PATH || "herdr",
  workspaceId = "",
  now = () => performance.now(),
} = {}) {
  const directory = layoutTransactionDirectory(environment);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let release;
  try {
    release = await acquirePaneStateLock(path.join(directory, "recovery"), {
      timeoutMs: 1_000,
      staleMs: 20_000,
      ownerGraceMs: 500,
    });
  } catch (error) {
    console.error(`GitRail layout recovery deferred: ${sanitizeTerminalText(error.message)}`);
    return { recovered: [], deferredWorkspaces: workspaceId ? [workspaceId] : [] };
  }
  const budget = createRecoveryBudget(15_000, now);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    await release();
    if (error.code === "ENOENT") return { recovered: [], deferredWorkspaces: [] };
    throw error;
  }
  const recovered = [];
  const deferredWorkspaces = new Set();
  const journaledStagingTabs = new Set();
  try {
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const journalPath = path.join(directory, entry.name);
      let transaction;
      try {
        transaction = JSON.parse(await fs.readFile(journalPath, "utf8"));
        transaction.journalPath = journalPath;
        if (transaction.stagingTabId) journaledStagingTabs.add(transaction.stagingTabId);
        if (workspaceId && transaction.workspaceId !== workspaceId) continue;
        budget.remaining();
        await recoverLayoutTransaction({ run, herdr, transaction, budget });
        recovered.push(journalPath);
      } catch (error) {
        if (transaction?.workspaceId) deferredWorkspaces.add(transaction.workspaceId);
        console.error(`GitRail layout recovery deferred for ${sanitizeTerminalText(entry.name)}: ${sanitizeTerminalText(error.message)}`);
      }
    }
    try {
      const { payload } = await commandJson(
        run,
        herdr,
        ["tab", "list"],
        recoveryCommandOptions(budget, 4 * 1_024 * 1_024),
      );
      for (const tab of responseItems(payload, "tabs")) {
        if (tab.label !== STAGING_LABEL || journaledStagingTabs.has(tab.tab_id)) continue;
        if (workspaceId && tab.workspace_id !== workspaceId) continue;
        console.error(`GitRail found unjournaled layout staging tab ${sanitizeTerminalText(tab.tab_id)} in workspace ${sanitizeTerminalText(tab.workspace_id)}; it was left untouched`);
      }
    } catch (error) {
      console.error(`GitRail could not inspect layout staging tabs: ${sanitizeTerminalText(error.message)}`);
    }
  } finally {
    await release();
  }
  return { recovered, deferredWorkspaces: [...deferredWorkspaces] };
}

async function rebuildWithOuterRail({
  run,
  herdr,
  pluginId,
  entrypoint,
  workspaceId,
  tabId,
  workspaceCwd,
  layout,
  exportedTree,
  contentPanes,
  existingRail,
  restoreFocusPaneId = "",
  sourcePaneId = "",
  environment = process.env,
}) {
  const contentPaneIds = contentPanes.map((pane) => pane.pane_id);
  const excluded = new Set((layout?.panes || [])
    .map((pane) => pane.pane_id)
    .filter((paneId) => !contentPaneIds.includes(paneId)));
  const layoutPaneIds = (layout?.panes || []).map((pane) => pane.pane_id);
  const fullTree = validatedTree(exportedTree, layoutPaneIds) || snapshotTree(layout, layoutPaneIds);
  const contentTree = validatedTree(pruneTree(fullTree, excluded), contentPaneIds);
  if (!contentTree) throw new Error("unable to preserve the current Herdr content layout");
  const anchorPaneId = firstLeaf(contentTree);
  const stagedPaneIds = treeLeaves(contentTree).filter((paneId) => paneId !== anchorPaneId);
  let railPaneId = existingRail?.pane_id || "";
  let openedStdout = "";
  const journalPath = layoutJournalPath(environment, workspaceId, tabId);
  const transaction = {
    version: LAYOUT_JOURNAL_VERSION,
    journalPath,
    workspaceId,
    tabId,
    entrypoint,
    recoveryTree: existingRail ? fullTree : contentTree,
    paneTerminalIds: Object.fromEntries(
      [...contentPanes, ...(existingRail ? [existingRail] : [])]
        .filter((pane) => pane?.pane_id && pane?.terminal_id)
        .map((pane) => [pane.pane_id, pane.terminal_id]),
    ),
    restoreFocusPaneId,
    createdRail: !existingRail,
    railPaneId,
    pendingOperation: null,
    completedOperations: 0,
    phase: "prepared",
  };
  const missingIdentity = treeLeaves(transaction.recoveryTree)
    .find((paneId) => !transaction.paneTerminalIds[paneId]);
  if (missingIdentity) {
    throw new Error(`unable to capture the pane instance identity required to recover ${sanitizeTerminalText(missingIdentity)}`);
  }
  const abortController = new globalThis.AbortController();
  Object.defineProperty(transaction, "commandOptions", {
    configurable: true,
    enumerable: false,
    value: {
      signal: abortController.signal,
      waitForTermination: true,
      killGraceMs: 250,
    },
  });
  let settleLayout;
  const layoutSettled = new Promise((resolve) => { settleLayout = resolve; });
  activeLayoutAbort = abortController;
  activeLayoutSettled = layoutSettled;
  await persistLayoutTransaction(transaction);
  activeLayoutRecovery = (budget = createRecoveryBudget(15_000)) => recoverLayoutTransaction({
    run,
    herdr,
    transaction,
    budget,
  });
  try {
    transaction.stagingTabId = await stageContentPanes({ run, herdr, workspaceId, tabId, paneIds: stagedPaneIds, transaction });
    await persistLayoutTransaction(transaction);
    if (railPaneId) {
      await journaledMove(transaction, run, herdr, [
        railPaneId, "--new-tab", "--workspace", workspaceId,
        "--label", STAGING_LABEL, "--no-focus",
      ], "a temporary GitRail pane tab");
    } else {
      transaction.priorPaneIds = [...await workspacePaneIds(
        run,
        herdr,
        workspaceId,
        transaction.commandOptions,
      )];
      transaction.pendingOperation = { kind: "open-rail" };
      await persistLayoutTransaction(transaction);
      const opened = await openRailInTab({
        run,
        herdr,
        pluginId,
        entrypoint,
        workspaceId,
        sourceTabId: tabId,
        workspaceCwd,
        sourcePaneId,
        commandOptions: transaction.commandOptions,
      });
      railPaneId = opened.paneId;
      openedStdout = opened.stdout;
      transaction.railPaneId = railPaneId;
      transaction.pendingOperation = null;
      transaction.completedOperations += 1;
      await persistLayoutTransaction(transaction);
    }

    await journaledMove(transaction, run, herdr, [
      railPaneId, "--tab", tabId, "--split", "right",
      "--target-pane", anchorPaneId, "--ratio", "0.8", "--no-focus",
    ], "the outer-right side of the target tab");

    await restoreContentTree({ run, herdr, tabId, contentTree, restoreFocusPaneId, transaction });
    transaction.phase = "committed";
    await persistLayoutTransaction(transaction);
    await fs.rm(journalPath, { force: true });
    activeLayoutRecovery = null;
  } catch (error) {
    if (layoutTerminationRequested) throw error;
    let recoveryError = null;
    try {
      const recoveryBudget = createRecoveryBudget(15_000);
      if (railPaneId && !existingRail) {
        const closed = await closeOwnedPane(run, herdr, railPaneId, {
          quiet: true,
          commandOptions: recoveryCommandOptions(recoveryBudget, 256 * 1_024),
        });
        if (!closed && await paneTabId(
          run,
          herdr,
          railPaneId,
          recoveryCommandOptions(recoveryBudget, 256 * 1_024),
        ) === tabId) {
          await movePane(run, herdr, [
            railPaneId, "--new-tab", "--workspace", workspaceId,
            "--label", STAGING_LABEL, "--no-focus",
          ], "a temporary GitRail recovery tab", recoveryCommandOptions(recoveryBudget, 2 * 1_024 * 1_024));
        }
      }
      const recoveryTree = existingRail ? fullTree : contentTree;
      await stageTreeForRecovery({
        run,
        herdr,
        workspaceId,
        tabId,
        tree: recoveryTree,
        budget: recoveryBudget,
      });
      await restoreContentTree({
        run,
        herdr,
        tabId,
        contentTree: recoveryTree,
        restoreFocusPaneId,
        continueOnError: true,
        budget: recoveryBudget,
      });
      await fs.rm(journalPath, { force: true });
      activeLayoutRecovery = null;
    } catch (caught) {
      recoveryError = caught;
    }
    if (recoveryError) {
      throw new Error(
        `${sanitizeTerminalText(error.message)}; Herdr layout recovery also failed: ${sanitizeTerminalText(recoveryError.message)}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    settleLayout();
    if (activeLayoutAbort === abortController) activeLayoutAbort = null;
    if (activeLayoutSettled === layoutSettled) activeLayoutSettled = null;
  }
  return { paneId: railPaneId, stdout: openedStdout };
}

async function paneLayout(run, herdr, paneId) {
  const { payload } = await commandJson(
    run,
    herdr,
    ["pane", "layout", "--pane", paneId],
    { timeoutMs: 5_000, maxOutputBytes: 2 * 1_024 * 1_024 },
  );
  const layout = payload?.result?.layout;
  if (!layout) throw new Error("Herdr did not return the target tab layout");
  return layout;
}

async function placeExistingRail({
  run,
  herdr,
  pluginId,
  entrypoint,
  workspaceId,
  tabId,
  workspaceCwd,
  rail,
  contentPanes,
  layout,
  exportedTree,
  environment,
  allowRebuild = true,
}) {
  if (paneAtOuterRight(layout, rail.pane_id)) return { paneId: rail.pane_id, placementChanged: false };
  if (!allowRebuild) return { paneId: rail.pane_id, placementChanged: false, skipped: true };
  const rightmostId = rightmostPaneId(layout, contentPanes);
  const rightmost = (layout.panes || []).find((pane) => pane.pane_id === rightmostId);
  const railLayout = (layout.panes || []).find((pane) => pane.pane_id === rail.pane_id);
  const area = layout.area;
  const bothFullHeight = area && rightmost?.rect && railLayout?.rect
    && rightmost.rect.y === area.y && rightmost.rect.height === area.height
    && railLayout.rect.y === area.y && railLayout.rect.height === area.height;
  if (bothFullHeight) {
    await run(herdr, [
      "pane", "swap", "--source-pane", rail.pane_id, "--target-pane", rightmostId,
    ], { timeoutMs: 5_000, maxOutputBytes: 512 * 1_024 });
    return { paneId: rail.pane_id, placementChanged: true };
  }
  const rebuilt = await rebuildWithOuterRail({
    run,
    herdr,
    pluginId,
    entrypoint,
    workspaceId,
    tabId,
    workspaceCwd,
    layout,
    exportedTree,
    contentPanes,
    existingRail: rail,
    restoreFocusPaneId: contentPanes.find((pane) => pane.focused)?.pane_id || "",
    sourcePaneId: contentPanes.find((pane) => pane.pane_id === layout?.focused_pane_id)?.pane_id
      || contentPanes[0]?.pane_id
      || "",
    environment,
  });
  return { paneId: rebuilt.paneId, placementChanged: true };
}

export async function openHerdrPanel({
  entrypoint,
  openMode = "replace",
  environment = process.env,
  run = runCommand,
  resize = resizeConfiguredSidebar,
  exportLayout = exportLayoutFromSocket,
  writeOutput = (value) => process.stdout.write(value),
} = {}) {
  if (!entrypoint) throw new Error("missing entrypoint");
  const herdr = environment.HERDR_BIN_PATH || "herdr";
  const pluginId = environment.HERDR_PLUGIN_ID || "local.git-rail";
  const invocation = await resolveInvocation(environment, herdr, run);
  const { workspaceId } = invocation;
  const recovery = await recoverLayoutTransactions({ environment, run, herdr, workspaceId });
  if (recovery.deferredWorkspaces.includes(workspaceId)) {
    return { paneId: "", openMode, skipped: true, recoveryDeferred: true };
  }
  await ensurePaneStateDirectory(environment);
  const statePath = paneStatePath({ workspaceId, tabId: invocation.tabId, entrypoint, environment });
  const release = await acquirePaneStateLock(statePath);
  let restoreZoomPaneId = "";
  let restoreFocusLocation = null;
  try {
    const { payload: panePayload } = await commandJson(
      run,
      herdr,
      ["pane", "list", "--workspace", workspaceId],
      { timeoutMs: 5_000, maxOutputBytes: 8 * 1_024 * 1_024 },
    );
    const workspacePanes = responseItems(panePayload, "panes");
    if (!invocation.tabId && invocation.requestedPaneId) {
      invocation.tabId = workspacePanes.find((pane) => pane.pane_id === invocation.requestedPaneId)?.tab_id || "";
    }
    if (!invocation.tabId) {
      const { payload } = await commandJson(run, herdr, ["workspace", "list"]);
      invocation.tabId = responseItems(payload, "workspaces")
        .find((workspace) => workspace.workspace_id === workspaceId)?.active_tab_id || "";
    }
    if (!invocation.tabId) throw new Error("unable to resolve Herdr tab");
    const actualStatePath = paneStatePath({ workspaceId, tabId: invocation.tabId, entrypoint, environment });
    if (actualStatePath !== statePath) throw new Error("Herdr tab changed while acquiring its pane lock");

    const identity = entrypointIdentity(entrypoint);
    let tabPanes = workspacePanes.filter((pane) => pane.tab_id === invocation.tabId);
    const state = await readPaneState(statePath) || await readPaneState(legacyPaneStatePath({
      workspaceId,
      entrypoint,
      environment,
    }));
    const currentRails = [];
    const legacyRails = [];
    for (const pane of tabPanes.filter((candidate) => hasLabel(candidate, identity.current))) {
      if (await verifiedOwnedRail(run, herdr, pane, state, entrypoint)) currentRails.push(pane);
    }
    for (const pane of tabPanes.filter((candidate) => hasLabel(candidate, identity.legacy))) {
      if (await verifiedOwnedRail(run, herdr, pane, state, entrypoint)) legacyRails.push(pane);
    }
    if (openMode === "toggle" && currentRails.length + legacyRails.length > 0) {
      for (const pane of [...currentRails, ...legacyRails]) await closeOwnedPane(run, herdr, pane.pane_id);
      await fs.rm(statePath, { force: true });
      await removeLegacyPaneState({ workspaceId, entrypoint, environment });
      return { paneId: "", closed: true };
    }
    const ownedPaneIds = new Set([...currentRails, ...legacyRails].map((pane) => pane.pane_id));
    let keptRail = currentRails.find((pane) => pane.pane_id === state?.paneId) || currentRails[0] || null;
    const invokedFromRail = Boolean(keptRail && invocation.requestedPaneId === keptRail.pane_id);
    const replaceExisting = Boolean(keptRail && openMode !== "ensure" && !invokedFromRail);
    if (replaceExisting) {
      const zoomProbe = sourcePane(tabPanes, invocation.requestedPaneId, null, ownedPaneIds, entrypoint) || keptRail;
      const beforeReplace = await paneLayout(run, herdr, zoomProbe.pane_id);
      if (beforeReplace.zoomed) {
        restoreFocusLocation = await globalFocusLocation(run, herdr);
        await run(herdr, ["pane", "zoom", "--pane", zoomProbe.pane_id, "--off"], {
          timeoutMs: 5_000,
          maxOutputBytes: 256 * 1_024,
        });
        restoreZoomPaneId = zoomProbe.pane_id;
      }
      for (const pane of [...currentRails, ...legacyRails]) await closeOwnedPane(run, herdr, pane.pane_id);
      tabPanes = tabPanes.filter((pane) => !currentRails.includes(pane) && !legacyRails.includes(pane));
      ownedPaneIds.clear();
      keptRail = null;
    }

    if (keptRail) {
      for (const pane of [...currentRails, ...legacyRails]) {
        if (pane.pane_id !== keptRail.pane_id) await closeOwnedPane(run, herdr, pane.pane_id);
      }
      const contentPane = sourcePane(tabPanes, invocation.requestedPaneId, null, ownedPaneIds, entrypoint);
      const adoptedCwd = invocation.workspaceCwd
        || contentPane?.foreground_cwd
        || contentPane?.cwd
        || state?.cwd
        || keptRail.cwd
        || "";
      const contentPanes = tabPanes.filter((pane) => pane.label !== PREVIEW_LABEL && !ownedPaneIds.has(pane.pane_id));
      try {
        let placementChanged = false;
        if (contentPanes.length > 0) {
          const layout = await paneLayout(run, herdr, keptRail.pane_id);
          if (!layout.zoomed) {
            const exportedTree = await exportLayout(environment, invocation.tabId);
            const placement = await placeExistingRail({
              run,
              herdr,
              pluginId,
              entrypoint,
              workspaceId,
              tabId: invocation.tabId,
              workspaceCwd: adoptedCwd,
              rail: keptRail,
              contentPanes,
              layout,
              exportedTree,
              environment,
              allowRebuild: openMode !== "ensure",
            });
            placementChanged = placement.placementChanged;
          }
        }
        if (placementChanged) {
          await resize({ paneId: keptRail.pane_id, workspaceCwd: adoptedCwd, environment });
        }
      } catch (error) {
        console.error(`GitRail was adopted, but its sidebar placement could not be repaired: ${sanitizeTerminalText(error.message)}`);
      }
      await writePaneState(statePath, keptRail.pane_id, adoptedCwd, keptRail.terminal_id || "");
      await removeLegacyPaneState({ workspaceId, entrypoint, environment });
      try {
        const { result } = await commandJson(run, herdr, ["pane", "get", keptRail.pane_id]);
        writeOutput(result.stdout);
      } catch {
        writeOutput(`${keptRail.pane_id}\n`);
      }
      return { paneId: keptRail.pane_id, adopted: true };
    }

    const layoutProbe = sourcePane(tabPanes, invocation.requestedPaneId, null, ownedPaneIds, entrypoint);
    if (!layoutProbe && legacyRails.length > 0 && entrypoint === "git-tui") {
      const legacy = legacyRails[0];
      await run(herdr, ["pane", "rename", legacy.pane_id, RAIL_LABEL], { timeoutMs: 5_000, maxOutputBytes: 256 * 1_024 });
      await writePaneState(
        statePath,
        legacy.pane_id,
        invocation.workspaceCwd || legacy.cwd || "",
        legacy.terminal_id || "",
      );
      await removeLegacyPaneState({ workspaceId, entrypoint, environment });
      return { paneId: legacy.pane_id, adopted: true };
    }
    if (!layoutProbe) throw new Error("unable to resolve a non-GitRail pane in the target tab");
    for (const pane of legacyRails) await closeOwnedPane(run, herdr, pane.pane_id);

    let layout = await paneLayout(run, herdr, layoutProbe.pane_id);
    if (layout.zoomed) {
      restoreFocusLocation = await globalFocusLocation(run, herdr);
      await run(herdr, ["pane", "zoom", "--pane", layoutProbe.pane_id, "--off"], {
        timeoutMs: 5_000,
        maxOutputBytes: 256 * 1_024,
      });
      restoreZoomPaneId = layoutProbe.pane_id;
      layout = await paneLayout(run, herdr, layoutProbe.pane_id);
    }
    const source = sourcePane(tabPanes, invocation.requestedPaneId, layout, ownedPaneIds, entrypoint) || layoutProbe;
    const contentPanes = tabPanes.filter((pane) => pane.label !== PREVIEW_LABEL && !ownedPaneIds.has(pane.pane_id));
    const placementPaneId = rightmostPaneId(layout, contentPanes) || source.pane_id;
    const placementLayout = (layout.panes || []).find((pane) => pane.pane_id === placementPaneId);
    const canSplitAtOuterRight = layout.area && placementLayout?.rect
      && placementLayout.rect.y === layout.area.y
      && placementLayout.rect.height === layout.area.height;
    invocation.workspaceCwd ||= source.foreground_cwd || source.cwd || "";

    let paneId;
    let openedStdout;
    if (canSplitAtOuterRight) {
      const openArgs = [
        "plugin", "pane", "open",
        "--plugin", pluginId,
        "--entrypoint", entrypoint,
        "--no-focus",
      ];
      if (invocation.workspaceCwd) openArgs.push("--env", `GIT_RAIL_REPO_ROOT=${invocation.workspaceCwd}`);
      if (source.pane_id) openArgs.push("--env", `GIT_RAIL_SOURCE_PANE_ID=${source.pane_id}`);
      if (invocation.tabId) openArgs.push("--env", `GIT_RAIL_SOURCE_TAB_ID=${invocation.tabId}`);
      openArgs.push("--target-pane", placementPaneId, "--placement", "split", "--direction", "right");
      const priorPaneIds = await workspacePaneIds(run, herdr, workspaceId);
      const opened = await run(herdr, openArgs, { timeoutMs: 8_000, maxOutputBytes: 2 * 1_024 * 1_024 });
      paneId = resultPaneId(opened.stdout);
      openedStdout = opened.stdout;
      if (!paneId) throw new Error("Herdr did not return the opened GitRail pane id");
      await validateOpenedRail({
        run,
        herdr,
        paneId,
        workspaceId,
        tabId: invocation.tabId,
        entrypoint,
        priorPaneIds,
      });
    } else {
      if (openMode === "ensure") {
        console.error(`GitRail auto-open skipped tab ${sanitizeTerminalText(invocation.tabId)} because an outer-right split is not safe`);
        return { paneId: "", adopted: false, openMode, skipped: true };
      }
      const rebuilt = await rebuildWithOuterRail({
        run,
        herdr,
        pluginId,
        entrypoint,
        workspaceId,
        tabId: invocation.tabId,
        workspaceCwd: invocation.workspaceCwd,
        layout,
        exportedTree: await exportLayout(environment, invocation.tabId),
        contentPanes,
        existingRail: null,
        restoreFocusPaneId: contentPanes.find((pane) => pane.focused)?.pane_id || "",
        sourcePaneId: source.pane_id,
        environment,
      });
      paneId = rebuilt.paneId;
      openedStdout = rebuilt.stdout;
    }
    writeOutput(openedStdout);
    let terminalId = "";
    try {
      const { payload: openedPanePayload } = await commandJson(run, herdr, ["pane", "get", paneId], {
        timeoutMs: 3_000,
        maxOutputBytes: 256 * 1_024,
      });
      const openedPane = openedPanePayload?.result?.pane;
      if (openedPane?.pane_id === paneId && openedPane.workspace_id === workspaceId) {
        terminalId = openedPane.terminal_id || "";
      }
    } catch (error) {
      console.error(`GitRail opened, but its pane instance identity could not be recorded: ${sanitizeTerminalText(error.message)}`);
    }
    await writePaneState(statePath, paneId, invocation.workspaceCwd, terminalId);
    await removeLegacyPaneState({ workspaceId, entrypoint, environment });
    try {
      await resize({ paneId, workspaceCwd: invocation.workspaceCwd, environment });
    } catch (error) {
      console.error(`GitRail opened, but its configured sidebar width could not be applied: ${sanitizeTerminalText(error.message)}`);
    }
    return { paneId, adopted: false, openMode };
  } finally {
    if (restoreZoomPaneId) {
      try {
        await run(herdr, ["pane", "zoom", "--pane", restoreZoomPaneId, "--on"], {
          timeoutMs: 5_000,
          maxOutputBytes: 256 * 1_024,
        });
      } catch {}
    }
    if (restoreFocusLocation) {
      try {
        await restoreGlobalFocus(run, herdr, restoreFocusLocation);
      } catch {}
    }
    await release();
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  let terminating = false;
  const recoverAndExit = async () => {
    if (terminating) return;
    terminating = true;
    layoutTerminationRequested = true;
    const budget = createRecoveryBudget(4_000);
    activeLayoutAbort?.abort();
    let transactionSettled = true;
    if (activeLayoutSettled) {
      let timer;
      transactionSettled = await Promise.race([
        activeLayoutSettled.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), budget.remaining(4_000));
        }),
      ]);
      clearTimeout(timer);
    }
    if (activeLayoutRecovery && transactionSettled) {
      try {
        await activeLayoutRecovery(budget);
      } catch (error) {
        console.error(`GitRail layout recovery remains journaled: ${sanitizeTerminalText(error.message)}`);
      }
    } else if (!transactionSettled) {
      console.error("GitRail layout recovery remains journaled: active mutation did not stop within the four-second recovery budget");
    }
    process.exit(1);
  };
  process.once("SIGTERM", recoverAndExit);
  process.once("SIGINT", recoverAndExit);
  try {
    await openHerdrPanel({ entrypoint: process.argv[2], openMode: process.argv[3] });
  } catch (error) {
    console.error(sanitizeTerminalText(error.message));
    process.exitCode = 1;
  }
}
