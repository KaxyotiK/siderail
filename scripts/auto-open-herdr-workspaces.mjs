#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { runCommand } from "../src/process.mjs";

const RAIL_LABEL = "HERDER GITRAIL";
const LEGACY_RAIL_LABEL = "Grove Git Rail";

function responseItems(payload, key) {
  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  const items = parsed?.result?.[key];
  return Array.isArray(items) ? items : [];
}

export function workspaceTargetFromContext(context, environment = process.env) {
  const workspaceId = environment.HERDR_WORKSPACE_ID || context?.workspace_id;
  const paneId = environment.HERDR_PANE_ID || context?.focused_pane_id;
  const cwd = context?.worktree?.checkout_path || context?.focused_pane_cwd || context?.workspace_cwd;
  if (!workspaceId || !cwd) return null;
  return { workspaceId, paneId: paneId || "", cwd };
}

export function collectWorkspaceTargets(workspacePayload, panePayload) {
  const workspaces = responseItems(workspacePayload, "workspaces");
  const panes = responseItems(panePayload, "panes");
  return workspaces.flatMap((workspace) => {
    const workspacePanes = panes.filter((pane) => pane.workspace_id === workspace.workspace_id);
    if (workspacePanes.some((pane) => pane.label === RAIL_LABEL || pane.label === LEGACY_RAIL_LABEL)) return [];
    const candidates = workspacePanes.filter((pane) => (
      pane.workspace_id === workspace.workspace_id
      && pane.label !== RAIL_LABEL
      && (!workspace.active_tab_id || pane.tab_id === workspace.active_tab_id)
    ));
    const targetPane = candidates.find((pane) => pane.focused) || candidates[0];
    const cwd = workspace.worktree?.checkout_path || targetPane?.cwd;
    if (!cwd) return [];
    return [{ workspaceId: workspace.workspace_id, paneId: targetPane?.pane_id || "", cwd }];
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
  if (!repoRoot || !autoOpenEnabled(repoRoot, environment)) return false;
  await runCommand("bash", [path.join(pluginRoot, "scripts/open-herdr-panel.sh"), "git-tui", "ensure"], {
    cwd: pluginRoot,
    env: {
      HERDR_BIN_PATH: herdr,
      HERDR_WORKSPACE_ID: target.workspaceId,
      HERDR_PANE_ID: target.paneId,
      HERDR_TARGET_PANE_ID: "",
      HERDR_PLUGIN_CONTEXT_JSON: "",
      GIT_RAIL_WORKSPACE_CWD: target.cwd,
    },
    timeoutMs: 15_000,
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

export async function autoOpenHerdrWorkspaces(environment = process.env) {
  const herdr = environment.HERDR_BIN_PATH || "herdr";
  const pluginRoot = environment.HERDR_PLUGIN_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  let targets;
  if (environment.HERDR_PLUGIN_EVENT === "workspace.created") {
    const target = workspaceTargetFromContext(pluginContext(environment), environment);
    targets = target ? [target] : [];
  } else {
    const [workspaceResult, paneResult] = await Promise.all([
      runCommand(herdr, ["workspace", "list"], { timeoutMs: 8_000, maxOutputBytes: 4 * 1_024 * 1_024 }),
      runCommand(herdr, ["pane", "list"], { timeoutMs: 8_000, maxOutputBytes: 16 * 1_024 * 1_024 }),
    ]);
    targets = collectWorkspaceTargets(workspaceResult.stdout, paneResult.stdout);
  }

  const failures = [];
  for (const target of targets) {
    try {
      await openTarget(target, { herdr, pluginRoot, environment });
    } catch (error) {
      failures.push(`${target.workspaceId}: ${error.message}`);
    }
  }
  if (failures.length > 0) throw new Error(`GitRail auto-open failed for ${failures.join("; ")}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  autoOpenHerdrWorkspaces().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
