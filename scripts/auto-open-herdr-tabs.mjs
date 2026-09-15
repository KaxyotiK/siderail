#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import {
  cleanupTabPaneState,
  cleanupWorkspacePaneState,
  pruneMissingPaneState,
} from "../src/herdr-pane-state.mjs";
import { runCommand } from "../src/process.mjs";
import { sanitizeTerminalText } from "../src/terminal-ui.mjs";
import { assertSupportedNode } from "../src/node-version.mjs";

const RAIL_LABELS = new Set(["HERDR GITRAIL", "HERDER GITRAIL"]);
assertSupportedNode();
const LEGACY_RAIL_LABEL = "Grove Git Rail";
const DEMO_LABEL = "GitRail Demo";
const PREVIEW_LABEL = "GitRail Preview";
const LEGACY_STAGING_LABEL = "GitRail Layout Staging";

function responseItems(payload, key) {
  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  const items = parsed?.result?.[key];
  return Array.isArray(items) ? items : [];
}

export function tabTargetFromContext(context, environment = process.env) {
  const workspaceId = environment.HERDR_WORKSPACE_ID || context?.workspace_id;
  const tabId = environment.HERDR_TAB_ID || context?.tab_id;
  const paneId = environment.HERDR_PANE_ID || context?.focused_pane_id;
  const cwd = context?.worktree?.checkout_path || context?.focused_pane_cwd || context?.workspace_cwd;
  if (!workspaceId || !tabId) return null;
  return { workspaceId, tabId, paneId: paneId || "", cwd: cwd || "" };
}

export function collectTabTargets(workspacePayload, tabPayload, panePayload, only = {}) {
  const workspaces = responseItems(workspacePayload, "workspaces");
  const tabs = responseItems(tabPayload, "tabs");
  const panes = responseItems(panePayload, "panes");
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.workspace_id, workspace]));
  return tabs.flatMap((tab) => {
    if (tab.label === LEGACY_STAGING_LABEL) return [];
    if (only.workspaceId && tab.workspace_id !== only.workspaceId) return [];
    if (only.tabId && tab.tab_id !== only.tabId) return [];
    const tabPanes = panes.filter((pane) => pane.tab_id === tab.tab_id);
    // File previews are deliberately full tabs; adding a rail beside them would
    // turn one GitRail-owned pane into another auto-open cycle.
    if (tabPanes.some((pane) => pane.label === PREVIEW_LABEL || pane.label === DEMO_LABEL)) return [];
    const usablePanes = tabPanes.filter((pane) => (
      !RAIL_LABELS.has(pane.label) && pane.label !== LEGACY_RAIL_LABEL && pane.label !== DEMO_LABEL
    ));
    const targetPane = usablePanes.find((pane) => pane.pane_id === only.paneId)
      || usablePanes.find((pane) => pane.focused)
      || usablePanes[0]
      || tabPanes[0];
    const workspace = workspaceById.get(tab.workspace_id);
    const cwd = targetPane?.cwd || workspace?.worktree?.checkout_path;
    if (!workspace || !targetPane || !cwd) return [];
    return [{
      workspaceId: tab.workspace_id,
      tabId: tab.tab_id,
      paneId: targetPane.pane_id,
      cwd,
      currentRailPaneIds: tabPanes.filter((pane) => RAIL_LABELS.has(pane.label)).map((pane) => pane.pane_id),
      legacyRailPaneIds: tabPanes.filter((pane) => pane.label === LEGACY_RAIL_LABEL).map((pane) => pane.pane_id),
    }];
  });
}

async function gitWorkspaceRoot(cwd, run = runCommand, timeoutMs = 2_000) {
  try {
    const result = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      timeoutMs: Math.max(1, Math.min(2_000, timeoutMs)),
      maxOutputBytes: 64 * 1_024,
    });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

export function autoOpenEnabled(environment = process.env) {
  return loadConfig(environment).config.herdr.autoOpen;
}

export async function openAutoOpenTarget(target, {
  herdr,
  pluginRoot,
  environment,
  run = runCommand,
  timeoutMs = 35_000,
  now = () => performance.now(),
}) {
  const startedAt = now();
  const repoRoot = await gitWorkspaceRoot(target.cwd, run, timeoutMs);
  const enabled = repoRoot ? autoOpenEnabled(environment) : false;
  if (!enabled) return false;
  const remainingMs = Math.floor(timeoutMs - (now() - startedAt));
  if (remainingMs <= 0) {
    const error = new Error("GitRail auto-open deadline expired while detecting the repository");
    error.kind = "timeout";
    throw error;
  }
  await run("/bin/bash", [path.join(pluginRoot, "scripts/open-herdr-panel.sh"), "git-tui", "ensure"], {
    cwd: pluginRoot,
    env: {
      HERDR_BIN_PATH: herdr,
      HERDR_WORKSPACE_ID: target.workspaceId,
      HERDR_TAB_ID: target.tabId,
      HERDR_PANE_ID: target.paneId,
      HERDR_TARGET_PANE_ID: "",
      HERDR_PLUGIN_CONTEXT_JSON: "",
      GIT_RAIL_WORKSPACE_CWD: target.cwd,
      GIT_RAIL_NODE_PATH: process.execPath,
    },
    timeoutMs: remainingMs,
    killGraceMs: 5_000,
    waitForTermination: true,
    maxOutputBytes: 256 * 1_024,
  });
  return true;
}

export async function runBoundedSweep(targets, job, {
  concurrency = 4,
  deadlineMs = 35_000,
  now = () => performance.now(),
  deadlineAt = null,
} = {}) {
  const deadline = deadlineAt ?? now() + deadlineMs;
  const summary = { opened: [], skipped: [], failed: [], deadlineCancelled: [] };
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      if (now() >= deadline) {
        summary.deadlineCancelled.push(...targets.slice(cursor).map((target) => target.tabId));
        cursor = targets.length;
        return;
      }
      const target = targets[cursor++];
      try {
        const opened = await job(target, Math.max(1, deadline - now()));
        (opened ? summary.opened : summary.skipped).push(target.tabId);
      } catch (error) {
        if (error?.kind === "timeout" || now() >= deadline) summary.deadlineCancelled.push(target.tabId);
        else summary.failed.push({ tabId: target.tabId, message: sanitizeTerminalText(error.message) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return summary;
}

function pluginContext(environment) {
  try {
    return JSON.parse(environment.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    return {};
  }
}

export async function autoOpenHerdrTabs(environment = process.env, dependencies = {}) {
  const run = dependencies.run || runCommand;
  const now = dependencies.now || (() => performance.now());
  const deadlineAt = now() + 35_000;
  const herdr = environment.HERDR_BIN_PATH || "herdr";
  const pluginRoot = environment.HERDR_PLUGIN_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  if (environment.HERDR_PLUGIN_EVENT === "tab.closed") {
    const context = pluginContext(environment);
    const workspaceId = environment.HERDR_WORKSPACE_ID || context.workspace_id;
    const tabId = environment.HERDR_TAB_ID || context.tab_id;
    if (workspaceId && tabId) await cleanupTabPaneState({ workspaceId, tabId, environment });
    return;
  }
  if (environment.HERDR_PLUGIN_EVENT === "workspace.closed") {
    const context = pluginContext(environment);
    const workspaceId = environment.HERDR_WORKSPACE_ID || context.workspace_id;
    if (workspaceId) await cleanupWorkspacePaneState({ workspaceId, environment });
    return;
  }
  const lifecycleEvent = ["workspace.created", "tab.created"].includes(environment.HERDR_PLUGIN_EVENT);
  const eventTarget = lifecycleEvent
    ? tabTargetFromContext(pluginContext(environment), environment)
    : null;
  const [workspaceResult, tabResult, paneResult] = await Promise.all([
    run(herdr, ["workspace", "list"], { timeoutMs: Math.max(1, Math.min(8_000, deadlineAt - now())), maxOutputBytes: 4 * 1_024 * 1_024 }),
    run(herdr, ["tab", "list"], { timeoutMs: Math.max(1, Math.min(8_000, deadlineAt - now())), maxOutputBytes: 8 * 1_024 * 1_024 }),
    run(herdr, ["pane", "list"], { timeoutMs: Math.max(1, Math.min(8_000, deadlineAt - now())), maxOutputBytes: 16 * 1_024 * 1_024 }),
  ]);
  const targets = lifecycleEvent && !eventTarget
    ? []
    : collectTabTargets(
      workspaceResult.stdout,
      tabResult.stdout,
      paneResult.stdout,
      eventTarget ? {
        workspaceId: eventTarget.workspaceId,
        tabId: eventTarget.tabId,
        paneId: eventTarget.paneId,
      } : {},
    );

  if (!lifecycleEvent) {
    const livePaneIds = new Set(responseItems(paneResult.stdout, "panes").map((pane) => pane.pane_id));
    await pruneMissingPaneState(livePaneIds, environment);
  }

  const summary = await runBoundedSweep(
    targets,
    dependencies.openTarget || ((target, timeoutMs) => openAutoOpenTarget(target, {
      herdr,
      pluginRoot,
      environment,
      run,
      timeoutMs,
      now,
    })),
    { now, deadlineAt },
  );
  if (summary.failed.length || summary.deadlineCancelled.length) {
    const failed = summary.failed.map((item) => `${item.tabId}: ${item.message}`).join("; ");
    const cancelled = summary.deadlineCancelled.join(", ");
    console.error(`GitRail auto-open partial result (opened ${summary.opened.length}, skipped ${summary.skipped.length})${failed ? `; failed ${failed}` : ""}${cancelled ? `; deadline-cancelled ${cancelled}` : ""}`);
  }
  return summary;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  autoOpenHerdrTabs().then((summary) => {
    if (summary?.failed?.length || summary?.deadlineCancelled?.length) process.exitCode = 1;
  }).catch((error) => {
    console.error(sanitizeTerminalText(error.message));
    process.exitCode = 1;
  });
}
