import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cmuxDockControlRegistrationIsActive,
  cmuxDockControlStatePath,
  cmuxExecutable,
  readCmuxDockControlRegistration,
  registerCmuxDockControl,
  resolveCmuxProjectContext,
  selectedMainWorkspace,
} from "../src/cmux-context.mjs";

test("cmux executable selection prefers an explicit override and then the bundled CLI", () => {
  assert.equal(cmuxExecutable({ GIT_RAIL_CMUX_BIN: "/test/cmux", CMUX_BUNDLED_CLI_PATH: "/bundle/cmux" }), "/test/cmux");
  assert.equal(cmuxExecutable({ CMUX_BUNDLED_CLI_PATH: "/bundle/cmux" }), "/bundle/cmux");
  assert.equal(cmuxExecutable({}), "cmux");
});

test("cmux Dock control registration preserves stable control ownership", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-cmux-control-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = { XDG_CACHE_HOME: root };
  assert.equal(await registerCmuxDockControl({
    workspaceId: "main-workspace",
    surfaceId: "configured-dock",
    controlId: "git-rail",
    instanceId: "instance-1",
    processId: 4242,
    environment,
    now: () => 1234,
  }), true);
  assert.deepEqual(await readCmuxDockControlRegistration({
    workspaceId: "main-workspace",
    controlId: "git-rail",
    environment,
  }), {
    version: 2,
    workspaceId: "main-workspace",
    surfaceId: "configured-dock",
    controlId: "git-rail",
    instanceId: "instance-1",
    processId: 4242,
    updatedAt: 1234,
  });
  assert.equal((await fs.stat(cmuxDockControlStatePath({
    workspaceId: "main-workspace", controlId: "git-rail", environment,
  }))).mode & 0o777, 0o600);
});

test("cmux Dock control registration rejects incomplete, missing, malformed, and mismatched ownership", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-cmux-control-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = { XDG_CACHE_HOME: root };
  assert.equal(await registerCmuxDockControl({ workspaceId: "", surfaceId: "surface", environment }), false);
  assert.equal(await registerCmuxDockControl({ workspaceId: "workspace", surfaceId: "", environment }), false);
  assert.equal(await registerCmuxDockControl({ workspaceId: "workspace", surfaceId: "surface", controlId: "", environment }), false);
  assert.equal(await registerCmuxDockControl({ workspaceId: "workspace", surfaceId: "surface", instanceId: "", environment }), false);
  assert.equal(await registerCmuxDockControl({ workspaceId: "workspace", surfaceId: "surface", processId: 0, environment }), false);
  assert.equal(await readCmuxDockControlRegistration({ workspaceId: "workspace", environment }), null);

  const statePath = cmuxDockControlStatePath({ workspaceId: "workspace", environment });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, "not json");
  assert.equal(await readCmuxDockControlRegistration({ workspaceId: "workspace", environment }), null);
  for (const invalid of [
    { version: 2, workspaceId: "workspace", controlId: "git-rail", surfaceId: "surface" },
    { version: 1, workspaceId: "other", controlId: "git-rail", surfaceId: "surface" },
    { version: 1, workspaceId: "workspace", controlId: "other", surfaceId: "surface" },
    { version: 1, workspaceId: "workspace", controlId: "git-rail", surfaceId: "" },
  ]) {
    await fs.writeFile(statePath, JSON.stringify(invalid));
    assert.equal(await readCmuxDockControlRegistration({ workspaceId: "workspace", environment }), null);
  }
});

test("cmux Dock control registration follows a live surface across workspace changes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-cmux-control-workspace-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = { XDG_CACHE_HOME: root };
  await registerCmuxDockControl({
    workspaceId: "workspace-a",
    surfaceId: "configured-dock",
    controlId: "git-rail",
    instanceId: "instance-a",
    processId: 4242,
    environment,
    now: () => 1234,
  });
  assert.deepEqual(await readCmuxDockControlRegistration({
    workspaceId: "workspace-b",
    controlId: "git-rail",
    surfaceIds: ["configured-dock", "unrelated-dock"],
    environment,
  }), {
    version: 2,
    workspaceId: "workspace-a",
    surfaceId: "configured-dock",
    controlId: "git-rail",
    instanceId: "instance-a",
    processId: 4242,
    updatedAt: 1234,
  });
});

test("cmux Dock registration liveness requires the recorded process", () => {
  const registration = {
    version: 2,
    workspaceId: "workspace",
    surfaceId: "surface",
    controlId: "git-rail",
    instanceId: "instance",
    processId: 4242,
    updatedAt: 1234,
  };
  assert.equal(cmuxDockControlRegistrationIsActive(registration, (processId) => processId === 4242), true);
  assert.equal(cmuxDockControlRegistrationIsActive(registration, () => false), false);
  assert.equal(cmuxDockControlRegistrationIsActive({ ...registration, processId: 0 }, () => true), false);
});

test("main workspace selection never treats the GitRail Dock surface as its source surface", () => {
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
    CMUX_DOCK_CONTROL_ID: "git-rail",
    CMUX_DOCK_CONTROL_TITLE: "GitRail",
    GIT_RAIL_PROJECT_CWD: "/repo/configured",
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
    dockControlId: "git-rail",
    dockControlTitle: "GitRail",
    warning: "",
  });
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ["/bundle/cmux", ["--json", "--id-format", "both", "identify"]],
    ["/bundle/cmux", ["--json", "--id-format", "both", "current-workspace", "--window", "window-1"]],
    ["/bundle/cmux", ["--json", "--id-format", "both", "list-panels", "--workspace", "main-workspace"]],
  ]);
  assert.ok(calls.every((call) => call.options.env === environment));
});

test("cmux context falls back to the configured project cwd when discovery fails", async () => {
  const environment = { GIT_RAIL_PROJECT_CWD: "relative/project", CMUX_SURFACE_ID: "dock" };
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
  assert.deepEqual(calls[1], ["--json", "--id-format", "both", "current-workspace"]);
});

test("cmux context remains anchored to its owner window when global focus moves", async () => {
  const calls = [];
  const environment = {
    GIT_RAIL_WINDOW_ID: "window-owner",
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
  assert.deepEqual(calls[0], ["--json", "--id-format", "both", "identify", "--window", "window-owner"]);
  assert.deepEqual(calls[1], ["--json", "--id-format", "both", "current-workspace", "--window", "window-owner"]);
});

test("cmux context recovers the selected project from the focused surface when workspace cwd is stale", async () => {
  const environment = {
    CMUX_SURFACE_ID: "dock-surface",
    GIT_RAIL_PROJECT_CWD: "/integration/checkout",
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

test("cmux context never substitutes the GitRail Dock cwd for a missing selected project", async () => {
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
    environment: { CMUX_SURFACE_ID: "dock-surface", GIT_RAIL_PROJECT_CWD: "/integration/checkout" },
    isDirectory: async (candidate) => candidate === "/integration/checkout",
  });
  assert.equal(result.cwd, "/missing/selected/project");
  assert.notEqual(result.cwd, "/integration/checkout");
});
