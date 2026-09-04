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
  resolveCmuxOwnerWindowId,
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
    ["/bundle/cmux", ["--json", "--id-format", "both", "list-windows"]],
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
  assert.deepEqual(calls[0], ["--json", "--id-format", "both", "identify"]);
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
  assert.deepEqual(calls[0], ["--json", "--id-format", "both", "list-windows"]);
  assert.deepEqual(calls[1], ["--json", "--id-format", "both", "identify", "--window", "window-owner"]);
  assert.deepEqual(calls[2], ["--json", "--id-format", "both", "current-workspace", "--window", "window-owner"]);
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
    environment: { GIT_RAIL_WINDOW_ID: "window-hint" },
  }), "");
  assert.equal(calls, 0);
});

test("Dock owner window falls back to a live window hint before the global-Dock workspace convention", async () => {
  const listWindows = async (_command, args) => (args.includes("list-windows")
    ? { stdout: JSON.stringify([{ window_id: "window-a" }, { window_id: "window-b" }]) }
    : { stdout: JSON.stringify({ surfaces: [{ id: "unrelated" }] }) });
  assert.equal(await resolveCmuxOwnerWindowId({
    run: listWindows,
    environment: { CMUX_SURFACE_ID: "missing-dock", GIT_RAIL_WINDOW_ID: "window-b", CMUX_WORKSPACE_ID: "window-a" },
  }), "window-b");
  assert.equal(await resolveCmuxOwnerWindowId({
    run: listWindows,
    environment: { CMUX_SURFACE_ID: "missing-dock", GIT_RAIL_WINDOW_ID: "closed-window", CMUX_WORKSPACE_ID: "window-a" },
  }), "window-a");
  assert.equal(await resolveCmuxOwnerWindowId({
    run: listWindows,
    environment: { CMUX_SURFACE_ID: "missing-dock", GIT_RAIL_WINDOW_ID: "closed-window", CMUX_WORKSPACE_ID: "closed-workspace" },
  }), "");
});

test("cmux context resolves the Dock-owning window when identify has no caller and focus is elsewhere", async () => {
  const calls = [];
  const environment = {
    CMUX_SURFACE_ID: "dock-surface",
    CMUX_WORKSPACE_ID: "window-owner",
    CMUX_DOCK_CONTROL_ID: "git-rail",
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
    environment: { CMUX_SURFACE_ID: "dock-surface", GIT_RAIL_WINDOW_ID: "window-hint" },
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
    environment: { CMUX_SURFACE_ID: "dock-surface", GIT_RAIL_PROJECT_CWD: "/Users/operator" },
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-worktree-"));
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

test("cmux Dock control state paths cannot escape the GitRail cache directory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-control-token-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = { XDG_CACHE_HOME: root };
  const directory = path.join(root, "herdr-gitrail", "cmux-controls");
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
  }), true);
  assert.deepEqual((await fs.readdir(root)), ["herdr-gitrail"]);
});

test("cmux Dock control lookup ignores another control's record for the same surface", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-control-foreign-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = { XDG_CACHE_HOME: root };
  await registerCmuxDockControl({
    workspaceId: "workspace-a",
    surfaceId: "shared-surface",
    controlId: "tests",
    instanceId: "instance-tests",
    processId: 4242,
    environment,
  });
  assert.equal(await readCmuxDockControlRegistration({
    workspaceId: "workspace-a",
    controlId: "git-rail",
    surfaceIds: ["shared-surface"],
    environment,
  }), null);
  await registerCmuxDockControl({
    workspaceId: "workspace-a",
    surfaceId: "shared-surface",
    controlId: "git-rail",
    instanceId: "instance-rail",
    processId: 4242,
    environment,
  });
  assert.equal((await readCmuxDockControlRegistration({
    workspaceId: "workspace-a",
    controlId: "git-rail",
    surfaceIds: ["shared-surface"],
    environment,
  })).instanceId, "instance-rail");
});

test("cmux Dock control lookup prefers the current workspace and then the newest record", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-control-order-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = { XDG_CACHE_HOME: root };
  await registerCmuxDockControl({
    workspaceId: "workspace-old", surfaceId: "dock-old", instanceId: "old", processId: 4242, environment, now: () => 10,
  });
  await registerCmuxDockControl({
    workspaceId: "workspace-new", surfaceId: "dock-new", instanceId: "new", processId: 4242, environment, now: () => 20,
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
    environment: { CMUX_SURFACE_ID: "dock-surface", CMUX_DOCK_CONTROL_ID: "git-rail" },
    fallbackCwd: "/Users/operator",
    isDirectory: async () => true,
    isRepository: async (candidate) => candidate === "/worktrees/branding-options",
  });
  assert.equal(result.cwd, "/worktrees/branding-options");
  assert.equal(result.windowId, "window-owner");
  assert.equal(result.mainSurfaceId, "main-surface");
});
