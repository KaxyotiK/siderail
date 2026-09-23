import assert from "node:assert/strict";
import test from "node:test";
import { cmuxDockRestartCommand, ensureCmuxDockResume } from "../src/cmux-resume.mjs";

test("cmux Dock restart command preserves absolute paths with shell metacharacters", () => {
  assert.equal(
    cmuxDockRestartCommand("/checkout with ' quote/scripts"),
    "/bin/bash '/checkout with '\\'' quote/scripts/cmux-node-launcher.sh' '/checkout with '\\'' quote/scripts/cmux-siderail.mjs'",
  );
});

test("cmux Dock restart command restates the host environment a resume binding cannot store", () => {
  assert.equal(
    cmuxDockRestartCommand("/checkout/scripts", {
      SIDERAIL_HOST: "cmux",
      SIDERAIL_NODE_PATH: "",
      SIDERAIL_STAY_OPEN: "1",
    }),
    "env SIDERAIL_HOST='cmux' SIDERAIL_STAY_OPEN='1'"
    + " /bin/bash '/checkout/scripts/cmux-node-launcher.sh' '/checkout/scripts/cmux-siderail.mjs'",
  );
});

test("cmux Dock resume registration is scoped to its window and surface", async () => {
  const calls = [];
  const environment = {
    CMUX_BUNDLED_CLI_PATH: "/bundle/cmux",
    SIDERAIL_WINDOW_ID: "window-owner",
    SIDERAIL_NODE_PATH: "/opt/node",
    CMUX_WORKSPACE_ID: "dock-owner-workspace",
    CMUX_SURFACE_ID: "dock-surface",
    CMUX_DOCK_CONTROL_ID: "siderail",
    CMUX_DOCK_CONTROL_TITLE: "SideRail",
  };
  const result = await ensureCmuxDockResume({
    environment,
    scriptDirectory: "/checkout/scripts",
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: JSON.stringify({ resume_binding: { auto_resume: true } }) };
    },
  });
  const expectedCommand = "env SIDERAIL_HOST='cmux' SIDERAIL_NODE_PATH='/opt/node' SIDERAIL_STAY_OPEN='1'"
    + " CMUX_DOCK_CONTROL_ID='siderail' CMUX_DOCK_CONTROL_TITLE='SideRail'"
    + " /bin/bash '/checkout/scripts/cmux-node-launcher.sh' '/checkout/scripts/cmux-siderail.mjs'";
  assert.deepEqual(result, {
    configured: true,
    autoResume: true,
    command: expectedCommand,
    projectRoot: "/checkout",
  });
  assert.deepEqual(calls[0].args, [
    "--json",
    "surface", "resume", "set",
    "--window", "window-owner",
    "--surface", "dock-surface",
    "--name", "SideRail",
    "--kind", "siderail",
    "--source", "siderail",
    "--cwd", "/checkout",
    "--shell", expectedCommand,
  ]);
  assert.equal(calls[0].command, "/bundle/cmux");
  assert.equal(calls[0].options.cwd, "/checkout");
  assert.equal(calls[0].options.env, environment);
});

test("cmux Dock resume registration ignores foreign and incomplete controls", async () => {
  let calls = 0;
  const run = async () => { calls += 1; };
  assert.deepEqual(await ensureCmuxDockResume({
    run,
    scriptDirectory: "/checkout/scripts",
    environment: { CMUX_WORKSPACE_ID: "window", CMUX_SURFACE_ID: "surface", CMUX_DOCK_CONTROL_ID: "other" },
  }), { configured: false, autoResume: false });
  assert.deepEqual(await ensureCmuxDockResume({
    run,
    scriptDirectory: "/checkout/scripts",
    environment: { CMUX_WORKSPACE_ID: "window", CMUX_DOCK_CONTROL_ID: "siderail" },
  }), { configured: false, autoResume: false });
  assert.equal(calls, 0);
});

test("cmux Dock resume registration survives a restore that dropped the owner window id", async () => {
  const calls = [];
  const result = await ensureCmuxDockResume({
    scriptDirectory: "/checkout/scripts",
    environment: { CMUX_SURFACE_ID: "dock-surface", CMUX_DOCK_CONTROL_ID: "siderail" },
    run: async (_command, args) => {
      calls.push(args);
      return { stdout: JSON.stringify({ resume_binding: { auto_resume: true } }) };
    },
  });
  assert.equal(result.configured, true);
  assert.equal(calls[0].includes("--window"), false);
  assert.deepEqual(calls[0].slice(0, 6), ["--json", "surface", "resume", "set", "--surface", "dock-surface"]);
  assert.doesNotMatch(result.command, /SIDERAIL_WINDOW_ID/);
});

test("cmux Dock resume registration reports a retained manual approval", async () => {
  const result = await ensureCmuxDockResume({
    scriptDirectory: "/checkout/scripts",
    environment: {
      CMUX_WORKSPACE_ID: "window",
      CMUX_SURFACE_ID: "surface",
      CMUX_DOCK_CONTROL_ID: "siderail",
    },
    run: async () => ({ stdout: JSON.stringify({ resume_binding: { auto_resume: false } }) }),
  });
  assert.equal(result.configured, true);
  assert.equal(result.autoResume, false);
});
