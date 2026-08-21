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

const RAIL_LABEL = "HERDER GITRAIL";
const LEGACY_RAIL_LABEL = "Grove Git Rail";
const DEMO_LABEL = "GitRail Demo";
const PREVIEW_LABEL = "GitRail Preview";
const STAGING_LABEL = "GitRail Layout Staging";

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
    if (tab.label === STAGING_LABEL) return [];
    if (only.workspaceId && tab.workspace_id !== only.workspaceId) return [];
    if (only.tabId && tab.tab_id !== only.tabId) return [];
    const tabPanes = panes.filter((pane) => pane.tab_id === tab.tab_id);
    // File previews are deliberately full tabs; adding a rail beside them would
    // turn one GitRail-owned pane into another auto-open cycle.
    if (tabPanes.some((pane) => pane.label === PREVIEW_LABEL || pane.label === DEMO_LABEL)) return [];
    const usablePanes = tabPanes.filter((pane) => (
      pane.label !== RAIL_LABEL && pane.label !== LEGACY_RAIL_LABEL && pane.label !== DEMO_LABEL
    ));
    const targetPane = usablePanes.find((pane) => pane.pane_id === only.paneId)
      || usablePanes.find((pane) => pane.focused)
      || usablePanes[0]
      || tabPanes[0];
    const workspace = workspaceById.get(tab.workspace_id);
    const cwd = workspace?.worktree?.checkout_path || targetPane?.cwd;
    if (!workspace || !targetPane || !cwd) return [];
    return [{
      workspaceId: tab.workspace_id,
      tabId: tab.tab_id,
      paneId: targetPane.pane_id,
      cwd,
      currentRailPaneIds: tabPanes.filter((pane) => pane.label === RAIL_LABEL).map((pane) => pane.pane_id),
      legacyRailPaneIds: tabPanes.filter((pane) => pane.label === LEGACY_RAIL_LABEL).map((pane) => pane.pane_id),
    }];
  });
}

async function gitWorkspaceRoot(cwd) {
  try {
    const result = await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      timeoutMs: 2_000,
      maxOutputBytes: 64 * 1_024,
    });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

export function autoOpenEnabled(repoRoot, environment = process.env) {
  return loadConfig(repoRoot, environment).config.herdr.autoOpen;
}

async function openTarget(target, { herdr, pluginRoot, environment }) {
  const repoRoot = await gitWorkspaceRoot(target.cwd);
  const enabled = repoRoot ? autoOpenEnabled(repoRoot, environment) : false;
  if (!enabled) return false;
  await runCommand("bash", [path.join(pluginRoot, "scripts/open-herdr-panel.sh"), "git-tui", "ensure"], {
    cwd: pluginRoot,
    env: {
      HERDR_BIN_PATH: herdr,
      HERDR_WORKSPACE_ID: target.workspaceId,
      HERDR_TAB_ID: target.tabId,
      HERDR_PANE_ID: target.paneId,
      HERDR_TARGET_PANE_ID: "",
      HERDR_PLUGIN_CONTEXT_JSON: "",
      GIT_RAIL_WORKSPACE_CWD: target.cwd,
    },
    timeoutMs: 35_000,
    maxOutputBytes: 256 * 1_024,
  });
  return true;
}

function pluginContext(environment) {
  try {
    return JSON.parse(environment.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    return {};
  }
}

export async function autoOpenHerdrTabs(environment = process.env) {
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
    runCommand(herdr, ["workspace", "list"], { timeoutMs: 8_000, maxOutputBytes: 4 * 1_024 * 1_024 }),
    runCommand(herdr, ["tab", "list"], { timeoutMs: 8_000, maxOutputBytes: 8 * 1_024 * 1_024 }),
    runCommand(herdr, ["pane", "list"], { timeoutMs: 8_000, maxOutputBytes: 16 * 1_024 * 1_024 }),
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

  const failures = [];
  for (const target of targets) {
    try {
      await openTarget(target, { herdr, pluginRoot, environment });
    } catch (error) {
      failures.push(`${sanitizeTerminalText(target.workspaceId)}: ${sanitizeTerminalText(error.message)}`);
    }
  }
  if (failures.length > 0) throw new Error(`GitRail auto-open failed for ${failures.join("; ")}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  autoOpenHerdrTabs().catch((error) => {
    console.error(sanitizeTerminalText(error.message));
    process.exitCode = 1;
  });
}
