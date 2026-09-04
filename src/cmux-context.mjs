import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./process.mjs";

function parseObject(stdout) {
  const value = JSON.parse(stdout || "{}");
  if (Array.isArray(value)) return value[0] || {};
  return value && typeof value === "object" ? value : {};
}

function parseValue(stdout) {
  const value = JSON.parse(stdout || "{}");
  return value && typeof value === "object" ? value : {};
}

function surfaceRows(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.surfaces || payload?.result?.surfaces || [];
}

function windowRows(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.windows || payload?.result?.windows || [];
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

function cmuxCall(run, cmux, args, environment, maxOutputBytes = 512 * 1_024) {
  return run(cmux, ["--json", "--id-format", "both", ...args], {
    env: environment,
    timeoutMs: 3_000,
    maxOutputBytes,
  });
}

function windowOwnsSurface(payload, surfaceId) {
  return surfaceRows(payload).some((surface) => normalized(surface.id || surface.surface_id) === surfaceId);
}

/**
 * Resolve the cmux window that owns this GitRail surface.
 *
 * cmux reports `caller: null` for Dock surfaces, so the owning window cannot be
 * read back from `identify`. The surface's own id is the only durable anchor, so
 * the owner is the window whose panel list contains it. `GIT_RAIL_WINDOW_ID` and
 * the global-Dock `CMUX_WORKSPACE_ID` convention are checked only afterwards,
 * because both are lost across Dock restore and relaunch.
 */
export async function resolveCmuxOwnerWindowId({
  run = runCommand,
  cmux = cmuxExecutable(),
  environment = process.env,
} = {}) {
  const ownSurfaceId = normalized(environment.CMUX_SURFACE_ID);
  if (!ownSurfaceId) return "";
  const listed = await cmuxCall(run, cmux, ["list-windows"], environment);
  const windowIds = windowRows(parseValue(listed.stdout))
    .map((row) => normalized(row.id || row.window_id))
    .filter(Boolean);
  for (const windowId of windowIds) {
    const panels = await cmuxCall(run, cmux, ["list-panels", "--window", windowId], environment, 2 * 1_024 * 1_024);
    if (windowOwnsSurface(parseValue(panels.stdout), ownSurfaceId)) return windowId;
  }
  const hinted = normalized(environment.GIT_RAIL_WINDOW_ID);
  if (hinted && windowIds.includes(hinted)) return hinted;
  const dockOwner = normalized(environment.CMUX_WORKSPACE_ID);
  return dockOwner && windowIds.includes(dockOwner) ? dockOwner : "";
}

export function selectedMainWorkspace(identifyPayload, workspacePayload, environment = process.env, ownerWindowId = "") {
  const focused = identifyPayload?.focused || identifyPayload?.active || {};
  const caller = identifyPayload?.caller || {};
  const workspace = workspacePayload?.workspace || workspacePayload || {};
  const dockSurfaceId = normalized(environment.CMUX_SURFACE_ID);
  const workspaceId = normalized(workspace.id || workspace.workspace_id || focused.workspace_id);
  const windowId = normalized(
    ownerWindowId
    || workspace.window_id
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

function selectedMainSurface(surfacePayload, mainSurfaceId, dockSurfaceId) {
  const rows = surfaceRows(surfacePayload).filter((surface) => (
    !normalized(surface.dock_scope)
    && normalized(surface.id || surface.surface_id) !== normalized(dockSurfaceId)
  ));
  return rows.find((surface) => normalized(surface.id || surface.surface_id) === normalized(mainSurfaceId))
    || rows.find((surface) => surface.focused === true)
    || rows.find((surface) => surface.selected_in_pane === true)
    || null;
}

function selectedDirectoryCandidates(main, surface) {
  return [
    surface?.resume_binding?.launch_command?.working_directory,
    surface?.requested_working_directory,
    surface?.current_directory,
    surface?.resume_binding?.cwd,
    main.cwd,
  ].map(normalized).filter(Boolean);
}

async function directoryExists(candidate) {
  try { return (await fs.stat(candidate)).isDirectory(); } catch { return false; }
}

/**
 * A linked worktree carries a `.git` file rather than a directory, so presence
 * of the entry — not its type — is what marks a candidate as checked out.
 */
async function withinRepository(candidate) {
  let directory = path.resolve(candidate);
  for (;;) {
    try {
      await fs.stat(path.join(directory, ".git"));
      return true;
    } catch { /* keep walking towards the filesystem root */ }
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

/**
 * cmux happily reports a directory that is not checked out — a global Dock
 * control's `cwd: "."` resolves to the home directory. Prefer the first
 * candidate that is actually inside a repository so the Dock does not settle on
 * a valid-but-unversioned folder and report Changes as unavailable.
 */
async function selectedProjectDirectory(main, surface, projectFallback, isDirectory, isRepository) {
  const candidates = [...new Set(selectedDirectoryCandidates(main, surface).map((candidate) => path.resolve(candidate)))];
  const existing = [];
  for (const candidate of candidates) if (await isDirectory(candidate)) existing.push(candidate);
  for (const candidate of existing) if (await isRepository(candidate)) return candidate;
  return existing[0] || candidates[0] || path.resolve(projectFallback);
}

async function currentWorkspace({ run, cmux, identifyPayload, environment, ownerWindowId }) {
  const focused = identifyPayload?.focused || identifyPayload?.active || {};
  const caller = identifyPayload?.caller || {};
  const windowId = normalized(
    ownerWindowId || environment.GIT_RAIL_WINDOW_ID || caller.window_id || focused.window_id,
  );
  const args = ["--json", "--id-format", "both", "current-workspace"];
  if (windowId) args.push("--window", windowId);
  const result = await run(cmux, args, {
    env: environment,
    timeoutMs: 3_000,
    maxOutputBytes: 512 * 1_024,
  });
  return parseObject(result.stdout);
}

async function ownerWindow({ run, cmux, environment, ownerWindowId }) {
  const provided = normalized(ownerWindowId);
  if (provided) return provided;
  try {
    const discovered = await resolveCmuxOwnerWindowId({ run, cmux, environment });
    if (discovered) return discovered;
  } catch { /* discovery is best effort; the environment hint still applies */ }
  return normalized(environment.GIT_RAIL_WINDOW_ID);
}

export async function resolveCmuxProjectContext({
  run = runCommand,
  cmux = cmuxExecutable(),
  environment = process.env,
  fallbackCwd = process.cwd(),
  isDirectory = directoryExists,
  isRepository = withinRepository,
  ownerWindowId = "",
} = {}) {
  const projectFallback = normalized(environment.GIT_RAIL_PROJECT_CWD) || fallbackCwd;
  let identifyPayload = {};
  let workspacePayload = {};
  let surfacePayload = {};
  let ownerWindowIdentity = "";
  let warning = "";
  try {
    ownerWindowIdentity = await ownerWindow({ run, cmux, environment, ownerWindowId });
    const identifyArgs = ["--json", "--id-format", "both", "identify"];
    if (ownerWindowIdentity) identifyArgs.push("--window", ownerWindowIdentity);
    const identified = await run(cmux, identifyArgs, {
      env: environment,
      timeoutMs: 3_000,
      maxOutputBytes: 512 * 1_024,
    });
    identifyPayload = parseObject(identified.stdout);
    workspacePayload = await currentWorkspace({
      run, cmux, identifyPayload, environment, ownerWindowId: ownerWindowIdentity,
    });
    const main = selectedMainWorkspace(identifyPayload, workspacePayload, environment, ownerWindowIdentity);
    if (main.workspaceId) {
      const listed = await run(cmux, [
        "--json", "--id-format", "both", "list-panels", "--workspace", main.workspaceId,
      ], {
        env: environment,
        timeoutMs: 3_000,
        maxOutputBytes: 512 * 1_024,
      });
      surfacePayload = parseObject(listed.stdout);
    }
  } catch (error) {
    warning = `cmux context unavailable: ${error.message}`;
  }

  const main = selectedMainWorkspace(identifyPayload, workspacePayload, environment, ownerWindowIdentity);
  const mainSurface = selectedMainSurface(
    surfacePayload,
    main.mainSurfaceId,
    normalized(environment.CMUX_SURFACE_ID),
  );
  return {
    cwd: await selectedProjectDirectory(main, mainSurface, projectFallback, isDirectory, isRepository),
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
