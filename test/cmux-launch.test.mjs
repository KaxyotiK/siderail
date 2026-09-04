import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cmuxDockRelaunchCommand, launchCmuxDock } from "../scripts/open-cmux-dock.mjs";

const CMUX_ENTRYPOINT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "scripts", "cmux-git-rail.mjs");
const noRegistration = async () => null;
const launchTest = (options) => launchCmuxDock({ wait: async () => {}, ...options });

function runner({ existing = false } = {}) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes("identify")) return { stdout: JSON.stringify({ focused: {
      window_id: "window-1", workspace_id: "main-workspace", surface_id: "main-surface",
    } }) };
    if (args.includes("current-workspace")) return { stdout: JSON.stringify({ id: "main-workspace", current_directory: "/repo" }) };
    if (args.includes("list-panels")) return { stdout: JSON.stringify({ surfaces: existing ? [{
      id: "existing-dock", dock_scope: "global", initial_command: `/bin/bash launcher ${CMUX_ENTRYPOINT}`,
    }] : [] }) };
    if (args[0] === "rpc") return { stdout: JSON.stringify({ dock_surface_id: "new-dock", dock_pane_id: "dock-pane" }) };
    return { stdout: "{}" };
  };
  return { calls, run };
}

test("manual launch creates one unfocused Dock terminal and reveals Dock without stealing focus", async () => {
  const mocked = runner();
  const environment = { GIT_RAIL_CMUX_BIN: "cmux-test" };
  const result = await launchTest({ run: mocked.run, readRegistration: noRegistration, environment, fallbackCwd: "/repo" });
  assert.equal(result.created, true);
  assert.equal(result.surfaceId, "new-dock");
  const create = mocked.calls.find((call) => call.args[0] === "rpc");
  const params = JSON.parse(create.args[2]);
  assert.equal(params.workspace_id, "main-workspace");
  assert.equal(params.placement, "dock");
  assert.equal(params.type, "terminal");
  assert.equal(params.focus, false);
  assert.equal(params.working_directory, "/repo");
  assert.equal(params.startup_environment.CMUX_DOCK_CONTROL_ID, "git-rail");
  assert.equal(params.startup_environment.CMUX_DOCK_CONTROL_TITLE, "GitRail");
  assert.equal(params.startup_environment.GIT_RAIL_NODE_PATH, process.execPath);
  assert.equal(params.startup_environment.GIT_RAIL_STAY_OPEN, "1");
  assert.equal(params.startup_environment.GIT_RAIL_WINDOW_ID, "window-1");
  assert.match(params.initial_command, /cmux-git-rail\.mjs/);
  assert.match(params.initial_command, /cmux-node-launcher\.sh/);
  assert.ok(mocked.calls.some((call) => call.args.join(" ") === "right-sidebar set dock --workspace main-workspace --no-focus"));
  assert.ok(mocked.calls.some((call) => call.args.includes("rename-tab") && call.args.includes("new-dock")));
});

test("manual launch adopts an existing GitRail Dock surface instead of duplicating it", async () => {
  const mocked = runner({ existing: true });
  const result = await launchTest({ run: mocked.run, readRegistration: noRegistration, environment: {}, fallbackCwd: "/repo" });
  assert.deepEqual({ created: result.created, surfaceId: result.surfaceId }, { created: false, surfaceId: "existing-dock" });
  assert.equal(mocked.calls.some((call) => call.args[0] === "rpc"), false);
  assert.equal(mocked.calls.some((call) => call.args[0] === "rename-tab"), false);
});

test("manual launch recognizes its configured Dock caller identity even with cmux's startup wrapper", async () => {
  const calls = [];
  const environment = {
    CMUX_DOCK_CONTROL_ID: "git-rail",
    CMUX_SURFACE_ID: "configured-dock",
  };
  const run = async (_command, args) => {
    calls.push(args);
    if (args.includes("identify")) return { stdout: JSON.stringify({ focused: { window_id: "window-1", workspace_id: "main-workspace" } }) };
    if (args.includes("current-workspace")) return { stdout: JSON.stringify({ id: "main-workspace", current_directory: "/repo" }) };
    if (args.includes("list-panels")) return { stdout: JSON.stringify({ surfaces: [{
      id: "configured-dock", dock_scope: "global", initial_command: "/tmp/cmux-dock-control-wrapper.sh",
    }] }) };
    return { stdout: "{}" };
  };
  const result = await launchTest({ run, readRegistration: noRegistration, environment });
  assert.deepEqual({ created: result.created, surfaceId: result.surfaceId }, { created: false, surfaceId: "configured-dock" });
  assert.equal(calls.some((args) => args[0] === "rpc"), false);
});

test("manual launch can coexist with an unrelated configured Dock control", async () => {
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    if (args.includes("identify")) return { stdout: JSON.stringify({ focused: {
      window_id: "window-1", workspace_id: "main-workspace", surface_id: "main-surface",
    } }) };
    if (args.includes("current-workspace")) return { stdout: JSON.stringify({ id: "main-workspace", current_directory: "/repo" }) };
    if (args.includes("list-panels")) return { stdout: JSON.stringify({ surfaces: [{
      id: "tests-dock", title: "Tests", dock_scope: "global", initial_command: "/tmp/cmux-dock-control-31d9.sh",
    }] }) };
    if (args[0] === "rpc") return { stdout: JSON.stringify({ dock_surface_id: "new-dock" }) };
    return { stdout: "{}" };
  };
  const result = await launchTest({ run, readRegistration: noRegistration, environment: {}, fallbackCwd: "/repo" });
  assert.deepEqual({ created: result.created, surfaceId: result.surfaceId }, { created: true, surfaceId: "new-dock" });
  assert.equal(calls.filter((args) => args[0] === "rpc").length, 1);
});

test("manual launch adopts a registered configured GitRail control", async () => {
  const mocked = runner();
  const baseRun = mocked.run;
  mocked.run = async (command, args, options) => {
    if (args.includes("list-panels")) return { stdout: JSON.stringify({ surfaces: [{
      id: "configured-dock", title: "Terminal", dock_scope: "global",
      initial_command: "/tmp/cmux-dock-control-31d9.sh",
    }] }) };
    return baseRun(command, args, options);
  };
  const result = await launchTest({
    run: mocked.run,
    readRegistration: async () => ({
      version: 2,
      workspaceId: "main-workspace",
      surfaceId: "configured-dock",
      controlId: "git-rail",
      instanceId: "active-instance",
      processId: process.pid,
      updatedAt: Date.now(),
    }),
    environment: {},
    fallbackCwd: "/repo",
  });
  assert.deepEqual({ created: result.created, surfaceId: result.surfaceId }, { created: false, surfaceId: "configured-dock" });
  assert.equal(mocked.calls.some((call) => call.args[0] === "rpc"), false);
});

test("manual launch finds an active configured control after the main workspace changes", async () => {
  const mocked = runner();
  const baseRun = mocked.run;
  mocked.run = async (command, args, options) => {
    if (args.includes("list-panels")) return { stdout: JSON.stringify({ surfaces: [{
      id: "configured-dock", dock_scope: "global", initial_command: "/tmp/cmux-dock-control-31d9.sh",
    }] }) };
    return baseRun(command, args, options);
  };
  let requested;
  const result = await launchTest({
    run: mocked.run,
    readRegistration: async (options) => {
      requested = options;
      return {
        version: 2,
        workspaceId: "workspace-a",
        surfaceId: "configured-dock",
        controlId: "git-rail",
        instanceId: "active-instance",
        processId: process.pid,
        updatedAt: Date.now(),
      };
    },
    environment: {},
    fallbackCwd: "/repo",
  });
  assert.deepEqual({ created: result.created, relaunched: result.relaunched, surfaceId: result.surfaceId }, {
    created: false, relaunched: false, surfaceId: "configured-dock",
  });
  assert.equal(requested.workspaceId, "main-workspace");
  assert.deepEqual(requested.surfaceIds, ["configured-dock"]);
  assert.equal(mocked.calls.some((call) => call.args[0] === "rpc"), false);
});

test("manual launch reuses a registered post-q login shell", async () => {
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    if (args.includes("identify")) return { stdout: JSON.stringify({ focused: {
      window_id: "window-1", workspace_id: "main-workspace", surface_id: "main-surface",
    } }) };
    if (args.includes("current-workspace")) return { stdout: JSON.stringify({ id: "main-workspace", current_directory: "/repo" }) };
    if (args.includes("list-panels")) return { stdout: JSON.stringify({ surfaces: [{
      id: "post-q-shell", dock_scope: "global", initial_command: "/tmp/cmux-dock-control-31d9.sh",
    }] }) };
    return { stdout: "{}" };
  };
  const result = await launchTest({
    run,
    readRegistration: async () => ({
      version: 2,
      workspaceId: "main-workspace",
      surfaceId: "post-q-shell",
      controlId: "git-rail",
      instanceId: "exited-instance",
      processId: 4242,
      updatedAt: 1234,
    }),
    isRegistrationActive: () => false,
    environment: {},
    fallbackCwd: "/repo",
  });
  assert.deepEqual({ created: result.created, relaunched: result.relaunched, surfaceId: result.surfaceId }, {
    created: false, relaunched: true, surfaceId: "post-q-shell",
  });
  assert.deepEqual(calls.filter((args) => args[0] === "send-key" || args[0] === "send").map((args) => args[0]), [
    "send-key", "send", "send-key",
  ]);
  assert.ok(calls.some((args) => args[0] === "send" && args.includes("post-q-shell") && args.at(-1).includes("cmux-git-rail.mjs")));
  assert.equal(calls.some((args) => args[0] === "rpc"), false);
});

test("manual launch waits for a starting configured control to register", async () => {
  const calls = [];
  let reads = 0;
  let waits = 0;
  const run = async (_command, args) => {
    calls.push(args);
    if (args.includes("identify")) return { stdout: JSON.stringify({ focused: {
      window_id: "window-1", workspace_id: "main-workspace", surface_id: "main-surface",
    } }) };
    if (args.includes("current-workspace")) return { stdout: JSON.stringify({ id: "main-workspace", current_directory: "/repo" }) };
    if (args.includes("list-panels")) return { stdout: JSON.stringify({ surfaces: [{
      id: "starting-control", dock_scope: "global", initial_command: "/tmp/cmux-dock-control-31d9.sh",
    }] }) };
    return { stdout: "{}" };
  };
  const result = await launchCmuxDock({
    run,
    readRegistration: async () => (++reads < 3 ? null : {
      version: 2,
      workspaceId: "main-workspace",
      surfaceId: "starting-control",
      controlId: "git-rail",
      instanceId: "starting-instance",
      processId: process.pid,
      updatedAt: Date.now(),
    }),
    wait: async () => { waits += 1; },
    registrationAttempts: 4,
    environment: {},
    fallbackCwd: "/repo",
  });
  assert.deepEqual({ created: result.created, relaunched: result.relaunched, surfaceId: result.surfaceId }, {
    created: false, relaunched: false, surfaceId: "starting-control",
  });
  assert.equal(waits, 2);
  assert.equal(calls.some((args) => args[0] === "rpc"), false);
});

test("manual launch adopts a Dock surface with an exposed GitRail control id", async () => {
  const mocked = runner();
  const baseRun = mocked.run;
  mocked.run = async (command, args, options) => {
    if (args.includes("list-panels")) return { stdout: JSON.stringify({ surfaces: [{
      id: "configured-dock", dock_scope: "global", initial_command: "/tmp/cmux-dock-control-31d9.sh",
      dock_control_id: "git-rail",
    }] }) };
    return baseRun(command, args, options);
  };
  const result = await launchTest({ run: mocked.run, readRegistration: noRegistration, environment: {}, fallbackCwd: "/repo" });
  assert.deepEqual({ created: result.created, surfaceId: result.surfaceId }, { created: false, surfaceId: "configured-dock" });
  assert.equal(mocked.calls.some((call) => call.args[0] === "rpc"), false);
});

test("manual launch fails closed without a selected main workspace or Dock response", async () => {
  await assert.rejects(launchTest({
    run: async (_command, args) => args.includes("identify") ? { stdout: "{}" } : args.includes("current-workspace") ? { stdout: "{}" } : { stdout: "{}" },
    readRegistration: noRegistration,
    environment: {},
  }), /No selected cmux main workspace/);

  const base = runner();
  const wrongAreaRun = async (command, args, options) => {
    const result = await base.run(command, args, options);
    return args[0] === "rpc" ? { stdout: JSON.stringify({ surface_id: "wrong-area" }) } : result;
  };
  await assert.rejects(launchTest({ run: wrongAreaRun, readRegistration: noRegistration, environment: {}, fallbackCwd: "/repo" }), /Dock surface id/);
});

test("Dock relaunch command restates variables and quotes shell metacharacters", () => {
  assert.equal(
    cmuxDockRelaunchCommand("/bin/bash launcher", {
      GIT_RAIL_PROJECT_CWD: "/repo with ' quote",
      GIT_RAIL_WINDOW_ID: "window-1",
      GIT_RAIL_NODE_PATH: "",
      CMUX_DOCK_CONTROL_TITLE: "   ",
    }),
    "env GIT_RAIL_PROJECT_CWD='/repo with '\\'' quote' GIT_RAIL_WINDOW_ID='window-1' /bin/bash launcher",
  );
  assert.equal(cmuxDockRelaunchCommand("/bin/bash launcher", {}), "/bin/bash launcher");
  assert.equal(cmuxDockRelaunchCommand("/bin/bash launcher", { A: undefined, B: null }), "/bin/bash launcher");
});

test("relaunching an existing Dock surface restores the owner window and project directory", async () => {
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    if (args.includes("identify")) return { stdout: JSON.stringify({ focused: {
      window_id: "window-owner", workspace_id: "main-workspace", surface_id: "main-surface",
    } }) };
    if (args.includes("current-workspace")) return { stdout: JSON.stringify({
      id: "main-workspace", window_id: "window-owner", current_directory: "/worktrees/branding-options",
    }) };
    if (args.includes("list-panels")) return { stdout: JSON.stringify({ surfaces: [{
      id: "stale-dock", dock_scope: "global", initial_command: "/tmp/cmux-dock-control-31d9.sh",
    }] }) };
    return { stdout: "{}" };
  };
  const result = await launchTest({
    run,
    readRegistration: async () => ({
      version: 2,
      workspaceId: "main-workspace",
      surfaceId: "stale-dock",
      controlId: "git-rail",
      instanceId: "exited-instance",
      processId: 4242,
      updatedAt: 1234,
    }),
    isRegistrationActive: () => false,
    environment: {},
    fallbackCwd: "/repo",
  });
  assert.equal(result.relaunched, true);
  const sent = calls.find((args) => args[0] === "send").at(-1);
  assert.match(sent, /^env /);
  assert.match(sent, /GIT_RAIL_WINDOW_ID='window-owner'/);
  assert.match(sent, /GIT_RAIL_PROJECT_CWD='\/worktrees\/branding-options'/);
  assert.match(sent, /GIT_RAIL_HOST='cmux'/);
  assert.match(sent, /GIT_RAIL_STAY_OPEN='1'/);
  assert.match(sent, /CMUX_DOCK_CONTROL_ID='git-rail'/);
  assert.match(sent, /cmux-git-rail\.mjs'$/);
});

test("a relaunched Dock surface receives exactly the environment a created one does", async () => {
  const environments = [];
  const collect = async (existingSurface, registrationActive) => {
    const run = async (_command, args) => {
      if (args.includes("identify")) return { stdout: JSON.stringify({ focused: {
        window_id: "window-owner", workspace_id: "main-workspace", surface_id: "main-surface",
      } }) };
      if (args.includes("current-workspace")) return { stdout: JSON.stringify({
        id: "main-workspace", window_id: "window-owner", current_directory: "/repo",
      }) };
      if (args.includes("list-panels")) return { stdout: JSON.stringify({ surfaces: existingSurface }) };
      if (args[0] === "rpc") {
        environments.push(JSON.parse(args[2]).startup_environment);
        return { stdout: JSON.stringify({ dock_surface_id: "new-dock" }) };
      }
      if (args[0] === "send") environments.push(args.at(-1));
      return { stdout: "{}" };
    };
    await launchTest({
      run,
      readRegistration: async () => (existingSurface.length ? {
        version: 2,
        workspaceId: "main-workspace",
        surfaceId: "stale-dock",
        controlId: "git-rail",
        instanceId: "instance",
        processId: 4242,
        updatedAt: 1234,
      } : null),
      isRegistrationActive: () => registrationActive,
      environment: {},
      fallbackCwd: "/repo",
    });
  };
  await collect([], true);
  await collect([{ id: "stale-dock", dock_scope: "global", initial_command: "/tmp/cmux-dock-control-31d9.sh" }], false);
  const [created, relaunched] = environments;
  for (const [key, value] of Object.entries(created)) {
    assert.match(relaunched, new RegExp(`${key}='${value.replaceAll("/", "\\/")}'`), `${key} is missing from the relaunch`);
  }
});

test("a Dock launch without a resolvable owner window omits the window variable rather than guessing", async () => {
  const run = async (_command, args) => {
    if (args.includes("identify")) return { stdout: JSON.stringify({ focused: { workspace_id: "main-workspace" } }) };
    if (args.includes("current-workspace")) return { stdout: JSON.stringify({ id: "main-workspace", current_directory: "/repo" }) };
    if (args.includes("list-panels")) return { stdout: JSON.stringify({ surfaces: [] }) };
    if (args[0] === "rpc") return { stdout: JSON.stringify({ dock_surface_id: "new-dock" }) };
    return { stdout: "{}" };
  };
  const calls = [];
  const result = await launchTest({
    run: async (command, args, options) => { calls.push(args); return run(command, args, options); },
    readRegistration: noRegistration,
    environment: {},
    fallbackCwd: "/repo",
  });
  assert.equal(result.created, true);
  const params = JSON.parse(calls.find((args) => args[0] === "rpc")[2]);
  assert.equal(Object.hasOwn(params.startup_environment, "GIT_RAIL_WINDOW_ID"), false);
  assert.equal(calls.find((args) => args[0] === "rename-tab").includes("--window"), false);
});

test("a relaunch decision awaits an asynchronous liveness verdict", async () => {
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    if (args.includes("identify")) return { stdout: JSON.stringify({ focused: {
      window_id: "window-1", workspace_id: "main-workspace", surface_id: "main-surface",
    } }) };
    if (args.includes("current-workspace")) return { stdout: JSON.stringify({ id: "main-workspace", current_directory: "/repo" }) };
    if (args.includes("list-panels")) return { stdout: JSON.stringify({ surfaces: [{
      id: "reused-pid-dock", dock_scope: "global", initial_command: "/tmp/cmux-dock-control-31d9.sh",
    }] }) };
    return { stdout: "{}" };
  };
  const registration = {
    version: 3,
    surfaceId: "reused-pid-dock",
    controlId: "git-rail",
    instanceId: "exited-instance",
    processId: 4242,
    processStartedAt: "Thu Sep  4 08:00:00 2026",
    workspaceId: "main-workspace",
    updatedAt: 1234,
  };
  const result = await launchTest({
    run,
    readRegistration: async () => registration,
    // A reused process id looks alive, so only the start marker prevents the
    // launcher from declining to relaunch a Dock that needs it.
    isRegistrationActive: async () => false,
    environment: {},
    fallbackCwd: "/repo",
  });
  assert.equal(result.relaunched, true);
  assert.ok(calls.some((args) => args[0] === "send" && args.at(-1).includes("GIT_RAIL_PROJECT_CWD")));
});

test("an active registration is still adopted rather than relaunched", async () => {
  const mocked = runner({ existing: true });
  const result = await launchTest({
    run: mocked.run,
    readRegistration: async () => ({
      version: 3,
      surfaceId: "existing-dock",
      controlId: "git-rail",
      instanceId: "live-instance",
      processId: process.pid,
      processStartedAt: "marker",
      workspaceId: "main-workspace",
      updatedAt: Date.now(),
    }),
    isRegistrationActive: async () => true,
    environment: {},
    fallbackCwd: "/repo",
  });
  assert.deepEqual({ created: result.created, relaunched: result.relaunched }, { created: false, relaunched: false });
  assert.equal(mocked.calls.some((call) => call.args[0] === "send"), false);
});
