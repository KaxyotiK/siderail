import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cmuxDockControlRegistrationIsActive,
  cmuxDockControlStatePath,
  cmuxDockControlSurfaceStatePath,
  cmuxProcessStartMarker,
  cmuxExecutable,
  readCmuxDockControlRegistration,
  registerCmuxDockControl,
  resolveCmuxOwnerWindowId,
  resolveCmuxProjectContext,
  selectedMainWorkspace,
} from "../src/cmux-context.mjs";

test("cmux executable selection prefers an explicit override and then the bundled CLI", () => {
  assert.equal(cmuxExecutable({ SIDERAIL_CMUX_BIN: "/test/cmux", CMUX_BUNDLED_CLI_PATH: "/bundle/cmux" }), "/test/cmux");
  assert.equal(cmuxExecutable({ CMUX_BUNDLED_CLI_PATH: "/bundle/cmux" }), "/bundle/cmux");
  assert.equal(cmuxExecutable({}), "cmux");
});

test("cmux Dock control ownership is keyed by its own surface, not the workspace it follows", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-cmux-control-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = { XDG_CACHE_HOME: root };
  const register = (workspaceId, updatedAt) => registerCmuxDockControl({
    workspaceId,
    surfaceId: "configured-dock",
    controlId: "siderail",
    instanceId: "instance-1",
    processId: 4242,
    environment,
    now: () => updatedAt,
    readStartMarker: async () => "Thu Sep  4 08:00:00 2026",
  });
  assert.equal(await register("workspace-a", 1234), true);
  assert.deepEqual(await readCmuxDockControlRegistration({
    workspaceId: "workspace-a",
    controlId: "siderail",
    surfaceIds: ["configured-dock"],
    environment,
  }), {
    version: 3,
    surfaceId: "configured-dock",
    controlId: "siderail",
    instanceId: "instance-1",
    processId: 4242,
    processStartedAt: "Thu Sep  4 08:00:00 2026",
    workspaceId: "workspace-a",
    updatedAt: 1234,
  });

  const statePath = cmuxDockControlSurfaceStatePath({ surfaceId: "configured-dock", environment });
  assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);

  // Following three more workspaces must not leave three more records behind.
  for (const [workspaceId, updatedAt] of [["workspace-b", 2], ["workspace-c", 3], ["workspace-d", 4]]) {
    await register(workspaceId, updatedAt);
  }
  assert.deepEqual(await fs.readdir(path.dirname(statePath)), ["configured-dock-siderail.json"]);
});

test("cmux Dock control registration rejects incomplete, missing, malformed, and mismatched ownership", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-cmux-control-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = { XDG_CACHE_HOME: root };
  const marker = { readStartMarker: async () => "start-marker" };
  assert.equal(await registerCmuxDockControl({ workspaceId: "workspace", surfaceId: "", environment, ...marker }), false);
  assert.equal(await registerCmuxDockControl({ workspaceId: "workspace", surfaceId: "surface", controlId: "", environment, ...marker }), false);
  assert.equal(await registerCmuxDockControl({ workspaceId: "workspace", surfaceId: "surface", instanceId: "", environment, ...marker }), false);
  assert.equal(await registerCmuxDockControl({ workspaceId: "workspace", surfaceId: "surface", processId: 0, environment, ...marker }), false);
  // A missing workspace is no longer disqualifying: ownership is the surface.
  assert.equal(await registerCmuxDockControl({ workspaceId: "", surfaceId: "surface", environment, ...marker }), true);
  assert.equal(await readCmuxDockControlRegistration({ workspaceId: "workspace", environment }), null);

  const surfacePath = cmuxDockControlSurfaceStatePath({ surfaceId: "surface", environment });
  await fs.writeFile(surfacePath, "not json");
  assert.equal(await readCmuxDockControlRegistration({
    workspaceId: "workspace", surfaceIds: ["surface"], environment,
  }), null);
  for (const invalid of [
    { version: 3, controlId: "siderail", instanceId: "i", processId: 1 },
    { version: 3, surfaceId: "surface", controlId: "other", instanceId: "i", processId: 1 },
    { version: 3, surfaceId: "surface", controlId: "siderail", instanceId: "", processId: 1 },
    { version: 3, surfaceId: "surface", controlId: "siderail", instanceId: "i", processId: 0 },
    { version: 4, surfaceId: "surface", controlId: "siderail", instanceId: "i", processId: 1 },
  ]) {
    await fs.writeFile(surfacePath, JSON.stringify(invalid));
    assert.equal(await readCmuxDockControlRegistration({
      workspaceId: "workspace", surfaceIds: ["surface"], environment,
    }), null);
  }

  const legacyPath = cmuxDockControlStatePath({ workspaceId: "workspace", environment });
  await fs.rm(surfacePath, { force: true });
  await fs.writeFile(legacyPath, "not json");
  assert.equal(await readCmuxDockControlRegistration({ workspaceId: "workspace", environment }), null);
  for (const invalid of [
    { version: 2, workspaceId: "workspace", controlId: "siderail", surfaceId: "surface" },
    { version: 1, workspaceId: "other", controlId: "siderail", surfaceId: "surface" },
    { version: 1, workspaceId: "workspace", controlId: "other", surfaceId: "surface" },
    { version: 1, workspaceId: "workspace", controlId: "siderail", surfaceId: "" },
  ]) {
    await fs.writeFile(legacyPath, JSON.stringify(invalid));
    assert.equal(await readCmuxDockControlRegistration({ workspaceId: "workspace", environment }), null);
  }
});

test("cmux Dock control registration follows a live surface across workspace changes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-cmux-control-workspace-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = { XDG_CACHE_HOME: root };
  await registerCmuxDockControl({
    workspaceId: "workspace-a",
    surfaceId: "configured-dock",
    controlId: "siderail",
    instanceId: "instance-a",
    processId: 4242,
    environment,
    now: () => 1234,
    readStartMarker: async () => "start-a",
  });
  assert.deepEqual(await readCmuxDockControlRegistration({
    workspaceId: "workspace-b",
    controlId: "siderail",
    surfaceIds: ["configured-dock", "unrelated-dock"],
    environment,
  }), {
    version: 3,
    surfaceId: "configured-dock",
    controlId: "siderail",
    instanceId: "instance-a",
    processId: 4242,
    processStartedAt: "start-a",
    workspaceId: "workspace-a",
    updatedAt: 1234,
  });
});

test("cmux Dock registration liveness requires the recorded process", async () => {
  const registration = {
    version: 2,
    workspaceId: "workspace",
    surfaceId: "surface",
    controlId: "siderail",
    instanceId: "instance",
    processId: 4242,
    updatedAt: 1234,
  };
  assert.equal(await cmuxDockControlRegistrationIsActive(registration, (processId) => processId === 4242), true);
  assert.equal(await cmuxDockControlRegistrationIsActive(registration, () => false), false);
  assert.equal(await cmuxDockControlRegistrationIsActive({ ...registration, processId: 0 }, () => true), false);
});

test("a reused process id cannot revive a version 3 registration", async () => {
  const registration = {
    version: 3,
    surfaceId: "surface",
    controlId: "siderail",
    instanceId: "instance",
    processId: 4242,
    processStartedAt: "Thu Sep  4 08:00:00 2026",
    workspaceId: "workspace",
    updatedAt: 1234,
  };
  const alive = () => true;
  assert.equal(await cmuxDockControlRegistrationIsActive(
    registration, alive, async () => "Thu Sep  4 08:00:00 2026",
  ), true);
  // Same id, different process: the launcher must still relaunch this Dock.
  assert.equal(await cmuxDockControlRegistrationIsActive(
    registration, alive, async () => "Thu Sep  4 09:31:12 2026",
  ), false);
  // An unreadable marker is not proof of life either.
  assert.equal(await cmuxDockControlRegistrationIsActive(registration, alive, async () => ""), false);
  assert.equal(await cmuxDockControlRegistrationIsActive(registration, () => false, async () => "Thu Sep  4 08:00:00 2026"), false);
});

test("a markerless version 3 record is invalid rather than silently process-id only", async (t) => {
  const registration = {
    version: 3,
    surfaceId: "surface",
    controlId: "siderail",
    instanceId: "instance",
    processStartedAt: "",
    processId: 4242,
    workspaceId: "workspace",
    updatedAt: 1234,
  };
  assert.equal(await cmuxDockControlRegistrationIsActive(registration, () => true, async () => "marker"), false);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-cmux-markerless-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = { XDG_CACHE_HOME: root };
  const statePath = cmuxDockControlSurfaceStatePath({ surfaceId: "surface", environment });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(registration));
  assert.equal(await readCmuxDockControlRegistration({
    workspaceId: "workspace", surfaceIds: ["surface"], environment, readStartMarker: async () => "",
  }), null);
});

test("registration fails rather than writing a version 3 record without a start marker", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-cmux-no-marker-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = { XDG_CACHE_HOME: root };
  assert.equal(await registerCmuxDockControl({
    workspaceId: "ws-a",
    surfaceId: "dock-surface",
    instanceId: "instance",
    processId: 4242,
    environment,
    readStartMarker: async () => "   ",
  }), false);
  await assert.rejects(
    () => fs.access(cmuxDockControlSurfaceStatePath({ surfaceId: "dock-surface", environment })),
    (error) => error.code === "ENOENT",
  );
});

test("the process start marker is read in a fixed locale and zone", async () => {
  let options;
  await cmuxProcessStartMarker(4242, {
    run: async (_command, _args, given) => { options = given; return { stdout: "4242 Thu Sep  4 08:00:00 2026" }; },
    environment: { LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8", TZ: "America/New_York", PATH: "/bin" },
  });
  assert.equal(options.env.LC_ALL, "C");
  assert.equal(options.env.LANG, "C");
  assert.equal(options.env.TZ, "UTC");
  assert.equal(options.env.PATH, "/bin");
});

test("the process start marker rejects a row that belongs to another process", async () => {
  const calls = [];
  const marker = (stdout) => cmuxProcessStartMarker(4242, {
    run: async (command, args) => { calls.push([command, args]); return { stdout }; },
    environment: {},
  });
  assert.equal(await marker(" 4242 Thu Sep  4 08:00:00 2026\n"), "Thu Sep  4 08:00:00 2026");
  assert.deepEqual(calls[0], ["/bin/ps", ["-p", "4242", "-o", "pid=,lstart="]]);
  assert.equal(await marker(" 9999 Thu Sep  4 08:00:00 2026\n"), "");
  assert.equal(await marker(""), "");
  assert.equal(await marker("garbage"), "");
  assert.equal(await cmuxProcessStartMarker(0, { run: async () => { throw new Error("unused"); } }), "");
  assert.equal(await cmuxProcessStartMarker(4242, { run: async () => { throw new Error("ps missing"); } }), "");
});

test("main workspace selection never treats the SideRail Dock surface as its source surface", () => {
  assert.deepEqual(selectedMainWorkspace({
    focused: { workspace_id: "main-workspace", window_id: "window-1", surface_id: "dock-surface" },
  }, {
    id: "main-workspace", current_directory: "/repo/live",
  }, { CMUX_SURFACE_ID: "dock-surface" }), {
    cwd: "/repo/live",
    workspaceId: "main-workspace",
    windowId: "window-1",
    mainSurfaceId: "",
  });
});

test("cmux context resolves live main-area cwd while preserving every Dock identity", async () => {
  const calls = [];
  const environment = {
    CMUX_WORKSPACE_ID: "dock-owner-window",
    CMUX_SURFACE_ID: "dock-surface",
    CMUX_DOCK_CONTROL_ID: "siderail",
    CMUX_DOCK_CONTROL_TITLE: "SideRail",
    SIDERAIL_PROJECT_CWD: "/repo/configured",
  };
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes("identify")) return { stdout: JSON.stringify({ focused: {
      window_id: "window-1", workspace_id: "main-workspace", surface_id: "main-surface",
    } }) };
    return { stdout: JSON.stringify({ id: "main-workspace", window_id: "window-1", current_directory: "/repo/live" }) };
  };
  const result = await resolveCmuxProjectContext({ run, cmux: "/bundle/cmux", environment, fallbackCwd: "/fallback" });
  assert.deepEqual(result, {
    cwd: "/repo/live",
    workspaceId: "main-workspace",
    windowId: "window-1",
    mainSurfaceId: "main-surface",
    dockSurfaceId: "dock-surface",
    dockWorkspaceId: "dock-owner-window",
    dockControlId: "siderail",
    dockControlTitle: "SideRail",
    warning: "",
  });
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ["/bundle/cmux", ["--json", "--id-format", "both", "list-windows"]],
    ["/bundle/cmux", ["--json", "--id-format", "both", "identify"]],
    ["/bundle/cmux", ["--json", "--id-format", "both", "current-workspace", "--window", "window-1"]],
    ["/bundle/cmux", ["--json", "--id-format", "both", "list-panels", "--workspace", "main-workspace"]],
  ]);
  assert.ok(calls.every((call) => call.options.env === environment));
});

test("cmux context falls back to the configured project cwd when discovery fails", async () => {
  const environment = { SIDERAIL_PROJECT_CWD: "relative/project", CMUX_SURFACE_ID: "dock" };
  const result = await resolveCmuxProjectContext({
    run: async () => { throw new Error("socket offline"); },
    cmux: "cmux-test",
    environment,
    fallbackCwd: "/fallback",
  });
  assert.equal(result.cwd.endsWith("/relative/project"), true);
  assert.equal(result.workspaceId, "");
  assert.equal(result.dockSurfaceId, "dock");
  assert.match(result.warning, /socket offline/);
});

test("cmux context can resolve an older caller-scoped workspace without a window id", async () => {
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    if (args.includes("identify")) return { stdout: JSON.stringify({ focused: { workspace_id: "workspace-old" } }) };
    return { stdout: JSON.stringify({ workspace_id: "workspace-old", cwd: "/repo/old" }) };
  };
  const result = await resolveCmuxProjectContext({ run, environment: {}, fallbackCwd: "/fallback" });
  assert.equal(result.cwd, "/repo/old");
  assert.deepEqual(calls[0], ["--json", "--id-format", "both", "identify"]);
  assert.deepEqual(calls[1], ["--json", "--id-format", "both", "current-workspace"]);
});

test("cmux context remains anchored to its owner window when global focus moves", async () => {
  const calls = [];
  const environment = {
    SIDERAIL_WINDOW_ID: "window-owner",
    CMUX_SURFACE_ID: "dock-surface",
  };
  const run = async (_command, args) => {
    calls.push(args);
    if (args.includes("identify")) return { stdout: JSON.stringify({
      caller: { window_id: "window-owner" },
      focused: { window_id: "window-other", workspace_id: "other-workspace", surface_id: "other-surface" },
    }) };
    return { stdout: JSON.stringify({
      workspace: {
        id: "owner-workspace",
        window_id: "window-owner",
        current_directory: "/repo/owner",
      },
    }) };
  };
  const result = await resolveCmuxProjectContext({ run, cmux: "cmux-test", environment });
  assert.equal(result.workspaceId, "owner-workspace");
  assert.equal(result.windowId, "window-owner");
  assert.equal(result.cwd, "/repo/owner");
  assert.deepEqual(calls[0], ["--json", "--id-format", "both", "list-windows"]);
  assert.deepEqual(calls[1], ["--json", "--id-format", "both", "identify", "--window", "window-owner"]);
  assert.deepEqual(calls[2], ["--json", "--id-format", "both", "current-workspace", "--window", "window-owner"]);
});

test("cmux context recovers the selected project from the focused surface when workspace cwd is stale", async () => {
  const environment = {
    CMUX_SURFACE_ID: "dock-surface",
    SIDERAIL_PROJECT_CWD: "/integration/checkout",
  };
  const run = async (_command, args) => {
    if (args.includes("identify")) return { stdout: JSON.stringify({ focused: {
      window_id: "window-1", workspace_id: "workspace-1", surface_id: "main-surface",
    } }) };
    if (args.includes("current-workspace")) return { stdout: JSON.stringify({
      id: "workspace-1", window_id: "window-1", current_directory: "/stale/selected/project",
    }) };
    return { stdout: JSON.stringify({ surfaces: [{
      id: "main-surface",
      focused: true,
      requested_working_directory: "/also/stale/project",
      resume_binding: {
        cwd: "/selected/project",
        launch_command: { working_directory: "/selected/project" },
      },
    }, {
      id: "dock-surface",
      dock_scope: "global",
      focused: true,
      requested_working_directory: "/integration/checkout",
    }] }) };
  };
  const result = await resolveCmuxProjectContext({
    run,
    environment,
    fallbackCwd: "/fallback",
    isDirectory: async (candidate) => candidate === "/selected/project",
  });
  assert.equal(result.cwd, "/selected/project");
  assert.equal(result.mainSurfaceId, "main-surface");
});

test("cmux context pins a valid main-surface launch folder when Dock activity contaminates workspace cwd", async () => {
  const run = async (_command, args) => {
    if (args.includes("identify")) return { stdout: JSON.stringify({ focused: {
      window_id: "window-1", workspace_id: "workspace-1", surface_id: "main-surface",
    } }) };
    if (args.includes("current-workspace")) return { stdout: JSON.stringify({
      id: "workspace-1", window_id: "window-1", current_directory: "/repo/other",
    }) };
    return { stdout: JSON.stringify({ surfaces: [{
      id: "main-surface",
      focused: true,
      requested_working_directory: "/repo/selected",
    }, {
      id: "dock-surface",
      dock_scope: "global",
      focused: true,
      requested_working_directory: "/repo/other",
    }] }) };
  };
  const result = await resolveCmuxProjectContext({
    run,
    environment: { CMUX_SURFACE_ID: "dock-surface" },
    isDirectory: async (candidate) => candidate === "/repo/selected" || candidate === "/repo/other",
  });
  assert.equal(result.cwd, "/repo/selected");
  assert.equal(result.mainSurfaceId, "main-surface");
});

test("cmux context never substitutes the SideRail Dock cwd for a missing selected project", async () => {
  const run = async (_command, args) => {
    if (args.includes("identify")) return { stdout: JSON.stringify({ focused: {
      workspace_id: "workspace-1", surface_id: "dock-surface",
    } }) };
    if (args.includes("current-workspace")) return { stdout: JSON.stringify({
      id: "workspace-1", current_directory: "/missing/selected/project",
    }) };
    return { stdout: JSON.stringify({ surfaces: [{
      id: "dock-surface", dock_scope: "global", requested_working_directory: "/integration/checkout",
    }] }) };
  };
  const result = await resolveCmuxProjectContext({
    run,
    environment: { CMUX_SURFACE_ID: "dock-surface", SIDERAIL_PROJECT_CWD: "/integration/checkout" },
    isDirectory: async (candidate) => candidate === "/integration/checkout",
  });
  assert.equal(result.cwd, "/missing/selected/project");
  assert.notEqual(result.cwd, "/integration/checkout");
});

test("Dock owner window is discovered from the Dock's own surface when cmux reports no caller", async () => {
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    if (args.includes("list-windows")) {
      return { stdout: JSON.stringify([{ id: "window-other" }, { id: "window-owner" }]) };
    }
    if (args.includes("--window") && args.includes("window-other")) {
      return { stdout: JSON.stringify({ surfaces: [{ id: "other-main" }, { id: "other-dock", dock_scope: "global" }] }) };
    }
    return { stdout: JSON.stringify({ surfaces: [{ id: "owner-main" }, { id: "dock-surface", dock_scope: "global" }] }) };
  };
  assert.equal(await resolveCmuxOwnerWindowId({
    run,
    cmux: "cmux-test",
    environment: { CMUX_SURFACE_ID: "dock-surface" },
  }), "window-owner");
  assert.deepEqual(calls, [
    ["--json", "--id-format", "both", "list-windows"],
    ["--json", "--id-format", "both", "list-panels", "--window", "window-other"],
    ["--json", "--id-format", "both", "list-panels", "--window", "window-owner"],
  ]);
});

test("Dock owner window discovery is skipped without a surface of its own", async () => {
  let calls = 0;
  assert.equal(await resolveCmuxOwnerWindowId({
    run: async () => { calls += 1; return { stdout: "{}" }; },
    environment: { SIDERAIL_WINDOW_ID: "window-hint" },
  }), "");
  assert.equal(calls, 0);
});

test("Dock owner window falls back to a live window hint before the global-Dock workspace convention", async () => {
  const listWindows = async (_command, args) => (args.includes("list-windows")
    ? { stdout: JSON.stringify([{ window_id: "window-a" }, { window_id: "window-b" }]) }
    : { stdout: JSON.stringify({ surfaces: [{ id: "unrelated" }] }) });
  assert.equal(await resolveCmuxOwnerWindowId({
    run: listWindows,
    environment: { CMUX_SURFACE_ID: "missing-dock", SIDERAIL_WINDOW_ID: "window-b", CMUX_WORKSPACE_ID: "window-a" },
  }), "window-b");
  assert.equal(await resolveCmuxOwnerWindowId({
    run: listWindows,
    environment: { CMUX_SURFACE_ID: "missing-dock", SIDERAIL_WINDOW_ID: "closed-window", CMUX_WORKSPACE_ID: "window-a" },
  }), "window-a");
  assert.equal(await resolveCmuxOwnerWindowId({
    run: listWindows,
    environment: { CMUX_SURFACE_ID: "missing-dock", SIDERAIL_WINDOW_ID: "closed-window", CMUX_WORKSPACE_ID: "closed-workspace" },
  }), "");
});

test("cmux context resolves the Dock-owning window when identify has no caller and focus is elsewhere", async () => {
  const calls = [];
  const environment = {
    CMUX_SURFACE_ID: "dock-surface",
    CMUX_WORKSPACE_ID: "window-owner",
    CMUX_DOCK_CONTROL_ID: "siderail",
  };
  const run = async (_command, args) => {
    calls.push(args);
    if (args.includes("list-windows")) {
      return { stdout: JSON.stringify([{ id: "window-focused" }, { id: "window-owner" }]) };
    }
    if (args.includes("--window") && args.includes("window-focused")) {
      return { stdout: JSON.stringify({ surfaces: [{ id: "focused-main" }] }) };
    }
    if (args.includes("list-panels") && args.includes("window-owner")) {
      return { stdout: JSON.stringify({ surfaces: [{ id: "owner-main" }, { id: "dock-surface", dock_scope: "global" }] }) };
    }
    if (args.includes("identify")) {
      return { stdout: JSON.stringify({
        caller: null,
        focused: args.includes("window-owner")
          ? { window_id: "window-owner", workspace_id: "owner-workspace", surface_id: "owner-main" }
          : { window_id: "window-focused", workspace_id: "focused-workspace", surface_id: "focused-main" },
      }) };
    }
    if (args.includes("current-workspace")) {
      return { stdout: JSON.stringify({ workspace: {
        id: "owner-workspace",
        window_id: "window-owner",
        current_directory: "/worktrees/branding-options",
      } }) };
    }
    return { stdout: JSON.stringify({ surfaces: [{
      id: "owner-main", focused: true, requested_working_directory: "/worktrees/branding-options",
    }] }) };
  };
  const result = await resolveCmuxProjectContext({
    run,
    cmux: "cmux-test",
    environment,
    fallbackCwd: "/Users/operator",
    isDirectory: async (candidate) => candidate === "/worktrees/branding-options",
  });
  assert.equal(result.windowId, "window-owner");
  assert.equal(result.workspaceId, "owner-workspace");
  assert.equal(result.cwd, "/worktrees/branding-options");
  assert.equal(result.mainSurfaceId, "owner-main");
  assert.ok(calls.some((args) => args.includes("identify") && args.includes("--window") && args.includes("window-owner")));
  assert.ok(calls.some((args) => args.includes("current-workspace") && args.includes("window-owner")));
});

test("cmux context never resolves the focused window's project for a Dock owned by another window", async () => {
  const run = async (_command, args) => {
    if (args.includes("list-windows")) {
      return { stdout: JSON.stringify([{ id: "window-focused" }, { id: "window-owner" }]) };
    }
    if (args.includes("list-panels") && args.includes("window-focused")) {
      return { stdout: JSON.stringify({ surfaces: [{ id: "focused-main" }] }) };
    }
    if (args.includes("list-panels") && args.includes("window-owner")) {
      return { stdout: JSON.stringify({ surfaces: [{ id: "dock-surface", dock_scope: "global" }] }) };
    }
    if (args.includes("identify")) {
      return { stdout: JSON.stringify({ caller: null, focused: { window_id: "window-focused", workspace_id: "focused-workspace" } }) };
    }
    if (args.includes("current-workspace")) {
      const owner = args.includes("window-owner");
      return { stdout: JSON.stringify({ workspace: {
        id: owner ? "owner-workspace" : "focused-workspace",
        current_directory: owner ? "/worktrees/branding-options" : "/other/window/project",
      } }) };
    }
    return { stdout: "{}" };
  };
  const result = await resolveCmuxProjectContext({
    run,
    environment: { CMUX_SURFACE_ID: "dock-surface" },
    fallbackCwd: "/Users/operator",
    isDirectory: async () => true,
  });
  assert.equal(result.cwd, "/worktrees/branding-options");
  assert.equal(result.workspaceId, "owner-workspace");
  assert.notEqual(result.cwd, "/other/window/project");
});

test("cmux context reuses a cached owner window without repeating Dock discovery", async () => {
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    if (args.includes("identify")) return { stdout: JSON.stringify({ caller: null, focused: { window_id: "window-owner" } }) };
    if (args.includes("current-workspace")) {
      return { stdout: JSON.stringify({ workspace: { id: "owner-workspace", current_directory: "/repo/owner" } }) };
    }
    return { stdout: JSON.stringify({ surfaces: [] }) };
  };
  const result = await resolveCmuxProjectContext({
    run,
    environment: { CMUX_SURFACE_ID: "dock-surface" },
    ownerWindowId: "window-owner",
    isDirectory: async () => true,
  });
  assert.equal(result.windowId, "window-owner");
  assert.equal(calls.some((args) => args.includes("list-windows")), false);
  assert.deepEqual(calls[0], ["--json", "--id-format", "both", "identify", "--window", "window-owner"]);
});

test("cmux context still resolves a project when Dock owner discovery fails outright", async () => {
  const run = async (_command, args) => {
    if (args.includes("list-windows")) throw new Error("list-windows unsupported");
    if (args.includes("identify")) return { stdout: JSON.stringify({ caller: null, focused: { window_id: "window-hint" } }) };
    if (args.includes("current-workspace")) {
      return { stdout: JSON.stringify({ workspace: { id: "hinted-workspace", current_directory: "/repo/hinted" } }) };
    }
    return { stdout: JSON.stringify({ surfaces: [] }) };
  };
  const result = await resolveCmuxProjectContext({
    run,
    environment: { CMUX_SURFACE_ID: "dock-surface", SIDERAIL_WINDOW_ID: "window-hint" },
    isDirectory: async () => true,
  });
  assert.equal(result.warning, "");
  assert.equal(result.windowId, "window-hint");
  assert.equal(result.cwd, "/repo/hinted");
});

test("a checked-out candidate outranks an existing but unversioned directory", async () => {
  const run = async (_command, args) => {
    if (args.includes("identify")) return { stdout: JSON.stringify({ focused: {
      window_id: "window-1", workspace_id: "workspace-1", surface_id: "main-surface",
    } }) };
    if (args.includes("current-workspace")) return { stdout: JSON.stringify({
      id: "workspace-1", current_directory: "/Users/operator",
    }) };
    return { stdout: JSON.stringify({ surfaces: [{
      id: "main-surface", focused: true, requested_working_directory: "/worktrees/branding-options",
    }] }) };
  };
  const result = await resolveCmuxProjectContext({
    run,
    environment: { CMUX_SURFACE_ID: "dock-surface", SIDERAIL_PROJECT_CWD: "/Users/operator" },
    ownerWindowId: "window-1",
    isDirectory: async () => true,
    isRepository: async (candidate) => candidate === "/worktrees/branding-options",
  });
  assert.equal(result.cwd, "/worktrees/branding-options");
});

test("no checked-out candidate keeps the first existing directory rather than an unusable path", async () => {
  const run = async (_command, args) => {
    if (args.includes("identify")) return { stdout: JSON.stringify({ focused: { workspace_id: "workspace-1" } }) };
    if (args.includes("current-workspace")) return { stdout: JSON.stringify({ id: "workspace-1", current_directory: "/repo/live" }) };
    return { stdout: JSON.stringify({ surfaces: [{
      id: "main-surface", focused: true, requested_working_directory: "/repo/requested",
    }] }) };
  };
  const result = await resolveCmuxProjectContext({
    run,
    environment: {},
    isDirectory: async (candidate) => candidate === "/repo/live",
    isRepository: async () => false,
  });
  assert.equal(result.cwd, "/repo/live");
});

test("repository detection accepts a linked worktree whose .git is a file", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-worktree-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worktree = path.join(root, "worktree");
  const nested = path.join(worktree, "src", "deep");
  const bare = path.join(root, "plain");
  await fs.mkdir(nested, { recursive: true });
  await fs.mkdir(bare, { recursive: true });
  await fs.writeFile(path.join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/worktree\n");

  const resolveFor = async (cwd) => (await resolveCmuxProjectContext({
    run: async (_command, args) => (args.includes("identify")
      ? { stdout: JSON.stringify({ focused: { workspace_id: "workspace-1" } }) }
      : args.includes("current-workspace")
        ? { stdout: JSON.stringify({ id: "workspace-1", current_directory: bare }) }
        : { stdout: JSON.stringify({ surfaces: [{ id: "main", focused: true, requested_working_directory: cwd }] }) }),
    environment: {},
  })).cwd;
  assert.equal(await resolveFor(nested), nested);
  assert.equal(await resolveFor(path.join(root, "missing")), bare);
});

test("cmux Dock control state paths cannot escape the SideRail cache directory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-control-token-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = { XDG_CACHE_HOME: root };
  const directory = path.join(root, "siderail", "cmux-controls");
  for (const hostile of ["../../escape", "a/b", "..", "with spaces"]) {
    const statePath = cmuxDockControlStatePath({ workspaceId: hostile, environment });
    assert.equal(path.dirname(statePath), directory);
    assert.doesNotMatch(path.basename(statePath), /[/\\]/);
  }
  assert.equal(await registerCmuxDockControl({
    workspaceId: "../../escape",
    surfaceId: "dock-surface",
    instanceId: "instance",
    processId: 4242,
    environment,
    readStartMarker: async () => "start-marker",
  }), true);
  assert.deepEqual((await fs.readdir(root)), ["siderail"]);
});

test("cmux Dock control lookup ignores another control's record for the same surface", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-control-foreign-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = { XDG_CACHE_HOME: root };
  await registerCmuxDockControl({
    workspaceId: "workspace-a",
    surfaceId: "shared-surface",
    controlId: "tests",
    instanceId: "instance-tests",
    processId: 4242,
    environment,
    readStartMarker: async () => "start-marker",
  });
  assert.equal(await readCmuxDockControlRegistration({
    workspaceId: "workspace-a",
    controlId: "siderail",
    surfaceIds: ["shared-surface"],
    environment,
  }), null);
  await registerCmuxDockControl({
    workspaceId: "workspace-a",
    surfaceId: "shared-surface",
    controlId: "siderail",
    instanceId: "instance-rail",
    processId: 4242,
    environment,
    readStartMarker: async () => "start-marker",
  });
  assert.equal((await readCmuxDockControlRegistration({
    workspaceId: "workspace-a",
    controlId: "siderail",
    surfaceIds: ["shared-surface"],
    environment,
  })).instanceId, "instance-rail");
});

test("cmux Dock control lookup prefers the current workspace and then the newest record", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-control-order-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = { XDG_CACHE_HOME: root };
  await registerCmuxDockControl({
    workspaceId: "workspace-old", surfaceId: "dock-old", instanceId: "old", processId: 4242, environment, now: () => 10,
    readStartMarker: async () => "start-marker",
  });
  await registerCmuxDockControl({
    workspaceId: "workspace-new", surfaceId: "dock-new", instanceId: "new", processId: 4242, environment, now: () => 20,
    readStartMarker: async () => "start-marker",
  });
  assert.equal((await readCmuxDockControlRegistration({
    workspaceId: "workspace-old", surfaceIds: ["dock-old", "dock-new"], environment,
  })).instanceId, "old");
  assert.equal((await readCmuxDockControlRegistration({
    workspaceId: "workspace-absent", surfaceIds: ["dock-old", "dock-new"], environment,
  })).instanceId, "new");
  assert.equal(await readCmuxDockControlRegistration({
    workspaceId: "workspace-old", surfaceIds: ["dock-closed"], environment,
  }), null);
});

test("a main surface launched from home does not outrank the workspace's checked-out project", async () => {
  // The live failure shape: the main-area terminal reports a requested working
  // directory of the home folder, which exists but is not checked out, while the
  // owner window's selected workspace points at the worktree the Dock must show.
  const run = async (_command, args) => {
    if (args.includes("list-windows")) return { stdout: JSON.stringify([{ id: "window-owner" }]) };
    if (args.includes("list-panels") && args.includes("--window")) {
      return { stdout: JSON.stringify({ surfaces: [{ id: "dock-surface", dock_scope: "global" }] }) };
    }
    if (args.includes("identify")) return { stdout: JSON.stringify({ caller: null, focused: {
      window_id: "window-owner", workspace_id: "owner-workspace", surface_id: "main-surface",
    } }) };
    if (args.includes("current-workspace")) return { stdout: JSON.stringify({ workspace: {
      id: "owner-workspace", current_directory: "/worktrees/branding-options",
    } }) };
    return { stdout: JSON.stringify({ surfaces: [
      { id: "main-surface", focused: true, requested_working_directory: "/Users/operator" },
      { id: "dock-surface", dock_scope: "global", requested_working_directory: "/Users/operator/." },
    ] }) };
  };
  const result = await resolveCmuxProjectContext({
    run,
    environment: { CMUX_SURFACE_ID: "dock-surface", CMUX_DOCK_CONTROL_ID: "siderail" },
    fallbackCwd: "/Users/operator",
    isDirectory: async () => true,
    isRepository: async (candidate) => candidate === "/worktrees/branding-options",
  });
  assert.equal(result.cwd, "/worktrees/branding-options");
  assert.equal(result.windowId, "window-owner");
  assert.equal(result.mainSurfaceId, "main-surface");
});

async function writeLegacyRecord(environment, { workspaceId, surfaceId, instanceId, processId = 4242, updatedAt = 1 }) {
  const statePath = cmuxDockControlStatePath({ workspaceId, controlId: "siderail", environment });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify({
    version: 2, workspaceId, surfaceId, controlId: "siderail", instanceId, processId, updatedAt,
  }));
  return statePath;
}

test("a legacy record is migrated forward and its duplicates for the same surface are removed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-cmux-migrate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = { XDG_CACHE_HOME: root };
  const paths = [];
  for (const [workspaceId, updatedAt] of [["ws-a", 10], ["ws-b", 20], ["ws-c", 30]]) {
    paths.push(await writeLegacyRecord(environment, {
      workspaceId, surfaceId: "dock-surface", instanceId: "instance-1", updatedAt,
    }));
  }
  const other = await writeLegacyRecord(environment, {
    workspaceId: "ws-d", surfaceId: "other-dock", instanceId: "instance-2", updatedAt: 40,
  });

  const lookup = (readStartMarker) => readCmuxDockControlRegistration({
    workspaceId: "ws-c", controlId: "siderail", surfaceIds: ["dock-surface"], environment, readStartMarker,
  });

  // Without a marker for the recorded process, promotion is refused and the
  // control stays explicitly version 2 with every legacy record intact.
  const unpromoted = await lookup(async () => "");
  assert.equal(unpromoted.version, 2);
  for (const statePath of paths) await fs.access(statePath);

  // The migrating call already returns the canonical record it published.
  const first = await lookup(async () => "start-marker");
  assert.equal(first.version, 3);
  assert.equal(first.instanceId, "instance-1");

  for (const statePath of paths) {
    await assert.rejects(() => fs.access(statePath), (error) => error.code === "ENOENT");
  }
  // A record for a surface this caller cannot see is never touched.
  await fs.access(other);

  const migrated = await lookup(async () => "start-marker");
  assert.deepEqual(migrated, {
    version: 3,
    surfaceId: "dock-surface",
    controlId: "siderail",
    instanceId: "instance-1",
    processId: 4242,
    processStartedAt: "start-marker",
    workspaceId: "ws-c",
    updatedAt: 30,
  });
});

test("a version 3 record is preferred without ever scanning legacy records", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-cmux-prefer-v3-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = { XDG_CACHE_HOME: root };
  const legacy = await writeLegacyRecord(environment, {
    workspaceId: "ws-a", surfaceId: "dock-surface", instanceId: "stale-instance", updatedAt: 99,
  });
  await registerCmuxDockControl({
    workspaceId: "ws-b",
    surfaceId: "dock-surface",
    instanceId: "live-instance",
    processId: 4242,
    environment,
    now: () => 1,
    readStartMarker: async () => "start",
  });
  const found = await readCmuxDockControlRegistration({
    workspaceId: "ws-b", controlId: "siderail", surfaceIds: ["dock-surface"], environment,
  });
  assert.equal(found.instanceId, "live-instance");
  // The legacy record is left alone because no scan was needed to find the control.
  await fs.access(legacy);
});

test("a failed migration still returns the legacy record rather than losing the control", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-cmux-migrate-fail-"));
  t.after(async () => {
    await fs.chmod(path.join(root, "siderail", "cmux-controls"), 0o700).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const environment = { XDG_CACHE_HOME: root };
  const legacy = await writeLegacyRecord(environment, {
    workspaceId: "ws-a", surfaceId: "dock-surface", instanceId: "instance-1", updatedAt: 10,
  });
  // A read-only parent makes the version 3 write fail after the legacy record is chosen.
  await fs.chmod(path.dirname(legacy), 0o500);

  const found = await readCmuxDockControlRegistration({
    workspaceId: "ws-a", controlId: "siderail", surfaceIds: ["dock-surface"], environment,
    readStartMarker: async () => "start-marker",
  });
  assert.equal(found.version, 2);
  assert.equal(found.instanceId, "instance-1");

  await fs.chmod(path.dirname(legacy), 0o700);
  // Nothing was deleted, so the next launch can migrate it.
  await fs.access(legacy);
});

test("legacy selection prefers the current workspace and then the newest record", async (t) => {
  // Each lookup migrates what it selects, so every case needs its own store.
  const select = async (workspaceId) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-cmux-legacy-order-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const environment = { XDG_CACHE_HOME: root };
    await writeLegacyRecord(environment, {
      workspaceId: "ws-old", surfaceId: "dock-a", instanceId: "old", updatedAt: 10,
    });
    await writeLegacyRecord(environment, {
      workspaceId: "ws-new", surfaceId: "dock-b", instanceId: "new", updatedAt: 20,
    });
    return (await readCmuxDockControlRegistration({
      workspaceId, controlId: "siderail", surfaceIds: ["dock-a", "dock-b"], environment,
    })).instanceId;
  };
  assert.equal(await select("ws-old"), "old");
  assert.equal(await select("ws-absent"), "new");
});

test("a dead process never causes a record to be pruned, so relaunch can still find its Dock", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-cmux-dead-pid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = { XDG_CACHE_HOME: root };
  await registerCmuxDockControl({
    workspaceId: "ws-a",
    surfaceId: "dock-surface",
    instanceId: "exited-instance",
    processId: 4242,
    environment,
    now: () => 1,
    readStartMarker: async () => "start",
  });
  const found = await readCmuxDockControlRegistration({
    workspaceId: "ws-a", controlId: "siderail", surfaceIds: ["dock-surface"], environment,
  });
  assert.equal(found.instanceId, "exited-instance");
  assert.equal(await cmuxDockControlRegistrationIsActive(found, () => false), false);
  await fs.access(cmuxDockControlSurfaceStatePath({ surfaceId: "dock-surface", environment }));
});

test("a registration landing mid-migration is never clobbered by the legacy record", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-cmux-race-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = { XDG_CACHE_HOME: root };
  const legacy = await writeLegacyRecord(environment, {
    workspaceId: "ws-a", surfaceId: "dock-surface", instanceId: "exited-instance", processId: 4242, updatedAt: 10,
  });

  // The marker read sits between the version 3 miss and the legacy publish, so
  // registering here reproduces a SideRail starting inside that exact window.
  const found = await readCmuxDockControlRegistration({
    workspaceId: "ws-a",
    controlId: "siderail",
    surfaceIds: ["dock-surface"],
    environment,
    readStartMarker: async () => {
      await registerCmuxDockControl({
        workspaceId: "ws-a",
        surfaceId: "dock-surface",
        instanceId: "fresh-instance",
        processId: 9999,
        environment,
        now: () => 500,
        readStartMarker: async () => "fresh-marker",
      });
      return "stale-marker";
    },
  });

  // The freshly registered control wins, and its record is what the caller acts on.
  assert.deepEqual(found, {
    version: 3,
    surfaceId: "dock-surface",
    controlId: "siderail",
    instanceId: "fresh-instance",
    processId: 9999,
    processStartedAt: "fresh-marker",
    workspaceId: "ws-a",
    updatedAt: 500,
  });
  // The migration lost, so it removed nothing.
  await fs.access(legacy);
  // No staged temporary file is left behind.
  const staged = (await fs.readdir(path.dirname(cmuxDockControlSurfaceStatePath({ surfaceId: "dock-surface", environment }))))
    .filter((entry) => entry.endsWith(".tmp"));
  assert.deepEqual(staged, []);
});

test("concurrent migrations of one legacy record agree on a single canonical winner", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-cmux-race-many-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = { XDG_CACHE_HOME: root };
  for (const workspaceId of ["ws-a", "ws-b", "ws-c", "ws-d"]) {
    await writeLegacyRecord(environment, {
      workspaceId, surfaceId: "dock-surface", instanceId: "instance-1", processId: 4242, updatedAt: 10,
    });
  }
  const lookup = () => readCmuxDockControlRegistration({
    workspaceId: "ws-a",
    controlId: "siderail",
    surfaceIds: ["dock-surface"],
    environment,
    readStartMarker: async () => "start-marker",
  });
  const results = await Promise.all(Array.from({ length: 8 }, lookup));
  assert.equal(results.every((result) => result?.surfaceId === "dock-surface"), true);
  assert.equal(new Set(results.map((result) => JSON.stringify(result))).size, 1);
  assert.deepEqual(await fs.readdir(path.join(root, "siderail", "cmux-controls")), ["surfaces"]);
});
