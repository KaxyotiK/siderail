import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./process.mjs";

function parseObject(stdout) {
  const value = JSON.parse(stdout || "{}");
  if (Array.isArray(value)) return value[0] || {};
  return value && typeof value === "object" ? value : {};
}

function normalized(value) {
  const text = String(value || "").trim();
  return text || "";
}

function safeToken(value) {
  return normalized(value).replace(/[^A-Za-z0-9._-]+/g, "_") || "unknown";
}

function controlStateDirectory(environment) {
  const root = environment.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(root, "herdr-gitrail", "cmux-controls");
}

export function cmuxDockControlStatePath({ workspaceId, controlId = "git-rail", environment = process.env }) {
  return path.join(controlStateDirectory(environment), `${safeToken(workspaceId)}-${safeToken(controlId)}.json`);
}

function validatedControlState(state, { workspaceId = "", controlId = "git-rail" } = {}) {
  if (state?.version !== 2
    || !normalized(state.controlId)
    || normalized(state.controlId) !== normalized(controlId)
    || !normalized(state.workspaceId)
    || !normalized(state.surfaceId)
    || !normalized(state.instanceId)
    || !Number.isInteger(state.processId)
    || state.processId <= 0) return null;
  if (workspaceId && normalized(state.workspaceId) !== normalized(workspaceId)) return null;
  return state;
}

async function readControlState(statePath, criteria) {
  try {
    return validatedControlState(JSON.parse(await fs.readFile(statePath, "utf8")), criteria);
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function cmuxDockControlRegistrationIsActive(state, isProcessAlive = (processId) => {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}) {
  return Boolean(validatedControlState(state, { controlId: state?.controlId }) && isProcessAlive(state.processId));
}

export async function registerCmuxDockControl({
  workspaceId,
  surfaceId,
  controlId = "git-rail",
  instanceId = `pid-${process.pid}`,
  processId = process.pid,
  environment = process.env,
  now = Date.now,
}) {
  workspaceId = normalized(workspaceId);
  surfaceId = normalized(surfaceId);
  controlId = normalized(controlId);
  instanceId = normalized(instanceId);
  if (!workspaceId || !surfaceId || !controlId || !instanceId || !Number.isInteger(processId) || processId <= 0) return false;
  const directory = controlStateDirectory(environment);
  const statePath = cmuxDockControlStatePath({ workspaceId, controlId, environment });
  const temporary = `${statePath}.${process.pid}.tmp`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  await fs.writeFile(temporary, `${JSON.stringify({
    version: 2,
    workspaceId,
    surfaceId,
    controlId,
    instanceId,
    processId,
    updatedAt: now(),
  })}\n`, { mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, statePath);
  return true;
}

export async function readCmuxDockControlRegistration({
  workspaceId,
  controlId = "git-rail",
  surfaceIds = [],
  environment = process.env,
}) {
  const visibleSurfaceIds = new Set(surfaceIds.map(normalized).filter(Boolean));
  if (!visibleSurfaceIds.size) {
    return readControlState(cmuxDockControlStatePath({ workspaceId, controlId, environment }), { workspaceId, controlId });
  }

  const directory = controlStateDirectory(environment);
  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.endsWith(`-${safeToken(controlId)}.json`)) continue;
    const state = await readControlState(path.join(directory, entry), { controlId });
    if (state && visibleSurfaceIds.has(normalized(state.surfaceId))) candidates.push(state);
  }
  candidates.sort((left, right) => {
    const leftCurrent = normalized(left.workspaceId) === normalized(workspaceId) ? 1 : 0;
    const rightCurrent = normalized(right.workspaceId) === normalized(workspaceId) ? 1 : 0;
    return rightCurrent - leftCurrent || Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
  });
  return candidates[0] || null;
}

export function cmuxExecutable(environment = process.env) {
  return normalized(environment.GIT_RAIL_CMUX_BIN)
    || normalized(environment.CMUX_BUNDLED_CLI_PATH)
    || "cmux";
}

export function selectedMainWorkspace(identifyPayload, workspacePayload, environment = process.env) {
  const focused = identifyPayload?.focused || identifyPayload?.active || {};
  const caller = identifyPayload?.caller || {};
  const workspace = workspacePayload?.workspace || workspacePayload || {};
  const dockSurfaceId = normalized(environment.CMUX_SURFACE_ID);
  const workspaceId = normalized(workspace.id || workspace.workspace_id || focused.workspace_id);
  const windowId = normalized(
    workspace.window_id
    || environment.GIT_RAIL_WINDOW_ID
    || caller.window_id
    || focused.window_id,
  );
  const cwd = normalized(workspace.current_directory || workspace.cwd);
  return {
    cwd,
    workspaceId,
    windowId,
    mainSurfaceId: normalized(focused.surface_id) === dockSurfaceId ? "" : normalized(focused.surface_id),
  };
}

async function currentWorkspace({ run, cmux, identifyPayload, environment }) {
  const focused = identifyPayload?.focused || identifyPayload?.active || {};
  const caller = identifyPayload?.caller || {};
  const windowId = normalized(environment.GIT_RAIL_WINDOW_ID || caller.window_id || focused.window_id);
  const args = ["--json", "--id-format", "both", "current-workspace"];
  if (windowId) args.push("--window", windowId);
  const result = await run(cmux, args, {
    env: environment,
    timeoutMs: 3_000,
    maxOutputBytes: 512 * 1_024,
  });
  return parseObject(result.stdout);
}

export async function resolveCmuxProjectContext({
  run = runCommand,
  cmux = cmuxExecutable(),
  environment = process.env,
  fallbackCwd = process.cwd(),
} = {}) {
  const projectFallback = normalized(environment.GIT_RAIL_PROJECT_CWD) || fallbackCwd;
  let identifyPayload = {};
  let workspacePayload = {};
  let warning = "";
  try {
    const identifyArgs = ["--json", "--id-format", "both", "identify"];
    const ownerWindowId = normalized(environment.GIT_RAIL_WINDOW_ID);
    if (ownerWindowId) identifyArgs.push("--window", ownerWindowId);
    const identified = await run(cmux, identifyArgs, {
      env: environment,
      timeoutMs: 3_000,
      maxOutputBytes: 512 * 1_024,
    });
    identifyPayload = parseObject(identified.stdout);
    workspacePayload = await currentWorkspace({ run, cmux, identifyPayload, environment });
  } catch (error) {
    warning = `cmux context unavailable: ${error.message}`;
  }

  const main = selectedMainWorkspace(identifyPayload, workspacePayload, environment);
  return {
    cwd: path.resolve(main.cwd || projectFallback),
    workspaceId: main.workspaceId,
    windowId: main.windowId,
    mainSurfaceId: main.mainSurfaceId,
    dockSurfaceId: normalized(environment.CMUX_SURFACE_ID),
    dockWorkspaceId: normalized(environment.CMUX_WORKSPACE_ID),
    dockControlId: normalized(environment.CMUX_DOCK_CONTROL_ID),
    dockControlTitle: normalized(environment.CMUX_DOCK_CONTROL_TITLE),
    warning,
  };
}
