#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  cmuxDockControlRegistrationIsActive,
  cmuxExecutable,
  readCmuxDockControlRegistration,
  resolveCmuxProjectContext,
} from "../src/cmux-context.mjs";
import { assertSupportedNode } from "../src/node-version.mjs";
import { runCommand } from "../src/process.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const NODE_LAUNCHER = path.join(SCRIPT_DIRECTORY, "cmux-node-launcher.sh");
const CMUX_ENTRYPOINT = path.join(SCRIPT_DIRECTORY, "cmux-git-rail.mjs");

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function parse(stdout) {
  return JSON.parse(stdout || "{}");
}

function surfaces(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.surfaces || payload?.result?.surfaces || [];
}

function surfaceControlId(surface) {
  return String(surface.dock_control_id || surface.control_id || "");
}

function surfaceId(surface) {
  return String(surface?.id || surface?.surface_id || "");
}

function isConfiguredDockWrapper(surface) {
  return /(?:^|\/)cmux-dock-control-[^/]+\.sh(?:\s|$)/.test(String(surface.initial_command || ""));
}

function dockStartupEnvironment(context) {
  return {
    GIT_RAIL_HOST: "cmux",
    GIT_RAIL_NODE_PATH: process.execPath,
    GIT_RAIL_PROJECT_CWD: context.cwd,
    GIT_RAIL_STAY_OPEN: "1",
    ...(context.windowId ? { GIT_RAIL_WINDOW_ID: context.windowId } : {}),
    CMUX_DOCK_CONTROL_ID: "git-rail",
    CMUX_DOCK_CONTROL_TITLE: "GitRail",
  };
}

/**
 * `send` types into a shell that no longer carries the Dock's startup
 * environment, so a relaunch has to restate it. Without this the restarted
 * control loses GIT_RAIL_WINDOW_ID and GIT_RAIL_PROJECT_CWD and resolves the
 * globally focused window instead of the Dock-owning one.
 */
export function cmuxDockRelaunchCommand(command, variables) {
  const assignments = Object.entries(variables)
    .filter(([, value]) => String(value ?? "").trim())
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  return assignments.length ? `env ${assignments.join(" ")} ${command}` : command;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function launchCmuxDock({
  run = runCommand,
  readRegistration = readCmuxDockControlRegistration,
  isRegistrationActive = cmuxDockControlRegistrationIsActive,
  wait = delay,
  registrationAttempts = 8,
  registrationDelayMs = 250,
  environment = process.env,
  fallbackCwd = process.cwd(),
} = {}) {
  const cmux = cmuxExecutable(environment);
  const context = await resolveCmuxProjectContext({ run, cmux, environment, fallbackCwd });
  if (!context.workspaceId) throw new Error("No selected cmux main workspace is available");
  const list = await run(cmux, ["--json", "--id-format", "both", "list-panels", "--workspace", context.workspaceId], {
    env: environment,
    timeoutMs: 3_000,
    maxOutputBytes: 2 * 1_024 * 1_024,
  });
  const callerOwnedSurfaceId = environment.CMUX_DOCK_CONTROL_ID === "git-rail"
    ? String(environment.CMUX_SURFACE_ID || "")
    : "";
  const dockSurfaces = surfaces(parse(list.stdout)).filter((surface) => surface.dock_scope);
  const visibleSurfaceIds = dockSurfaces.map(surfaceId).filter(Boolean);
  const readVisibleRegistration = () => readRegistration({
    workspaceId: context.workspaceId,
    controlId: "git-rail",
    surfaceIds: visibleSurfaceIds,
    environment,
  });
  let registration = await readVisibleRegistration();
  if (!registration && dockSurfaces.some(isConfiguredDockWrapper)) {
    for (let attempt = 1; attempt < Math.max(1, registrationAttempts) && !registration; attempt += 1) {
      await wait(registrationDelayMs);
      registration = await readVisibleRegistration();
    }
  }
  const registeredSurface = registration
    ? dockSurfaces.find((surface) => surfaceId(surface) === String(registration.surfaceId || ""))
    : null;
  let dockSurface = registeredSurface || dockSurfaces.find((surface) => (
    surfaceId(surface) === callerOwnedSurfaceId
    || surfaceControlId(surface) === "git-rail"
    || String(surface.initial_command || "").includes(CMUX_ENTRYPOINT)
  ));
  let created = false;
  let relaunched = false;
  const command = `/bin/bash ${shellQuote(NODE_LAUNCHER)} ${shellQuote(CMUX_ENTRYPOINT)}`;
  if (registeredSurface && !isRegistrationActive(registration)) {
    const target = ["--workspace", context.workspaceId, "--surface", surfaceId(registeredSurface)];
    await run(cmux, ["send-key", ...target, "ctrl+c"], {
      env: environment,
      timeoutMs: 3_000,
      maxOutputBytes: 256 * 1_024,
    });
    await run(cmux, ["send", ...target, "--", cmuxDockRelaunchCommand(command, dockStartupEnvironment(context))], {
      env: environment,
      timeoutMs: 3_000,
      maxOutputBytes: 256 * 1_024,
    });
    await run(cmux, ["send-key", ...target, "enter"], {
      env: environment,
      timeoutMs: 3_000,
      maxOutputBytes: 256 * 1_024,
    });
    relaunched = true;
  } else if (!dockSurface) {
    const params = {
      workspace_id: context.workspaceId,
      placement: "dock",
      type: "terminal",
      working_directory: context.cwd,
      initial_command: command,
      startup_environment: dockStartupEnvironment(context),
      focus: false,
    };
    const result = await run(cmux, ["rpc", "surface.create", JSON.stringify(params)], {
      cwd: context.cwd,
      env: environment,
      timeoutMs: 5_000,
      maxOutputBytes: 512 * 1_024,
    });
    const payload = parse(result.stdout);
    const surfaceId = String(payload.dock_surface_id || "");
    if (!surfaceId || payload.surface_id) throw new Error("cmux did not return a Dock surface id");
    dockSurface = { id: surfaceId };
    created = true;
    const renameArgs = ["rename-tab", "--surface", surfaceId, "--title", "GitRail"];
    if (context.windowId) renameArgs.push("--window", context.windowId);
    try { await run(cmux, renameArgs, { env: environment, timeoutMs: 3_000, maxOutputBytes: 256 * 1_024 }); } catch {}
  }
  await run(cmux, ["right-sidebar", "set", "dock", "--workspace", context.workspaceId, "--no-focus"], {
    env: environment,
    timeoutMs: 3_000,
    maxOutputBytes: 256 * 1_024,
  });
  return { created, relaunched, surfaceId: surfaceId(dockSurface), context };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assertSupportedNode();
  launchCmuxDock().then(({ created, relaunched }) => {
    process.stdout.write(created || relaunched ? "GitRail opened in the cmux Dock.\n" : "GitRail is already open in the cmux Dock.\n");
  }).catch((error) => {
    process.stderr.write(`Could not open GitRail in cmux: ${error.message}\n`);
    process.exitCode = 1;
  });
}
