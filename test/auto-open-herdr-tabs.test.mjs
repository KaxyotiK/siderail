import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { autoOpenEnabled, autoOpenHerdrTabs, collectTabTargets, openAutoOpenTarget, runBoundedSweep, tabTargetFromContext } from "../scripts/auto-open-herdr-tabs.mjs";
import { hermeticEnvironment } from "./helpers/environment.mjs";

const execFileAsync = promisify(execFile);

test("tab creation uses the event tab instead of the globally focused tab", () => {
  const target = tabTargetFromContext({
    workspace_id: "w2",
    tab_id: "w2:t3",
    workspace_cwd: "/repos/two",
    focused_pane_id: "w2:p1",
    focused_pane_cwd: "/repos/two/subdir",
    worktree: { checkout_path: "/worktrees/two" },
  }, {});
  assert.deepEqual(target, { workspaceId: "w2", tabId: "w2:t3", paneId: "w2:p1", cwd: "/worktrees/two" });
});

test("startup reconciliation chooses one non-GitRail pane per tab", () => {
  const workspaces = { result: { workspaces: [
    { workspace_id: "w1" },
    { workspace_id: "w2", worktree: { checkout_path: "/worktrees/two" } },
  ] } };
  const tabs = { result: { tabs: [
    { workspace_id: "w1", tab_id: "w1:t1" },
    { workspace_id: "w1", tab_id: "w1:t2" },
    { workspace_id: "w1", tab_id: "w1:t3" },
    { workspace_id: "w1", tab_id: "w1:t4" },
    { workspace_id: "w2", tab_id: "w2:t1" },
  ] } };
  const panes = { result: { panes: [
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p2", cwd: "/repos/one-a" },
    { workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p6", cwd: "/rail-checkout", focused: true, label: "HERDR GITRAIL" },
    { workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p1", cwd: "/repos/one", focused: true },
    { workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p3", label: "HERDER GITRAIL" },
    { workspace_id: "w1", tab_id: "w1:t3", pane_id: "w1:p4", cwd: "/repos/preview", label: "GitRail Preview" },
    { workspace_id: "w1", tab_id: "w1:t4", pane_id: "w1:p5", cwd: "/repos/demo", label: "GitRail Demo" },
    { workspace_id: "w2", tab_id: "w2:t1", pane_id: "w2:p1", cwd: "/wrong" },
  ] } };
  assert.deepEqual(collectTabTargets(workspaces, tabs, panes), [
    { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p2", cwd: "/repos/one-a", currentRailPaneIds: [], legacyRailPaneIds: [] },
    { workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p1", cwd: "/repos/one", currentRailPaneIds: ["w1:p6", "w1:p3"], legacyRailPaneIds: [] },
    { workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p1", cwd: "/wrong", currentRailPaneIds: [], legacyRailPaneIds: [] },
  ]);
});

test("event reconciliation filters to the created tab", () => {
  const workspaces = { result: { workspaces: [{ workspace_id: "w1" }] } };
  const tabs = { result: { tabs: [
    { workspace_id: "w1", tab_id: "w1:t1" },
    { workspace_id: "w1", tab_id: "w1:t2" },
  ] } };
  const panes = { result: { panes: [
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/one" },
    { workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p2", cwd: "/two" },
  ] } };
  assert.deepEqual(collectTabTargets(workspaces, tabs, panes, { workspaceId: "w1", tabId: "w1:t2" }), [
    { workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", cwd: "/two", currentRailPaneIds: [], legacyRailPaneIds: [] },
  ]);
});

test("legacy layout-staging tabs never trigger auto-open", () => {
  const workspaces = { result: { workspaces: [{ workspace_id: "w1" }] } };
  const tabs = { result: { tabs: [{
    workspace_id: "w1",
    tab_id: "w1:t9",
    label: "GitRail Layout Staging",
  }] } };
  const panes = { result: { panes: [{
    workspace_id: "w1",
    tab_id: "w1:t9",
    pane_id: "w1:p2",
    cwd: "/repo",
  }] } };
  assert.deepEqual(collectTabTargets(workspaces, tabs, panes), []);
});

test("bounded sweep caps workers and preserves mixed partial results", async () => {
  const targets = Array.from({ length: 12 }, (_value, index) => ({ tabId: `t${index}` }));
  let active = 0;
  let maximum = 0;
  const summary = await runBoundedSweep(targets, async (target) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await Promise.resolve();
    active -= 1;
    if (target.tabId === "t3") throw new Error("broken");
    return target.tabId !== "t4";
  });
  assert.equal(maximum, 4);
  assert.equal(summary.opened.length, 10);
  assert.deepEqual(summary.skipped, ["t4"]);
  assert.deepEqual(summary.failed, [{ tabId: "t3", message: "broken" }]);
});

test("bounded sweep does not dequeue work after its global deadline", async () => {
  const targets = Array.from({ length: 8 }, (_value, index) => ({ tabId: `t${index}` }));
  let clock = 0;
  const summary = await runBoundedSweep(targets, async () => {
    clock = 40_000;
    return true;
  }, { deadlineMs: 35_000, now: () => clock });
  assert.equal(summary.opened.length, 1);
  assert.equal(summary.deadlineCancelled.length, 7);
});

test("bounded sweep cancels every target when the deadline has already expired", async () => {
  const targets = Array.from({ length: 5 }, (_value, index) => ({ tabId: `t${index}` }));
  let calls = 0;
  const summary = await runBoundedSweep(targets, async () => { calls += 1; }, {
    deadlineAt: 35_000,
    now: () => 35_000,
  });
  assert.equal(calls, 0);
  assert.deepEqual(summary.deadlineCancelled, targets.map((target) => target.tabId));
});

test("bounded sweep reports both active and queued jobs as deadline-cancelled", async () => {
  const targets = Array.from({ length: 8 }, (_value, index) => ({ tabId: `t${index}` }));
  let clock = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = [];
  const sweep = runBoundedSweep(targets, async (target) => {
    started.push(target.tabId);
    await gate;
    const error = new Error("hung child reached the global deadline");
    error.kind = "timeout";
    throw error;
  }, { deadlineAt: 35_000, now: () => clock });
  while (started.length < 4) await new Promise((resolve) => setImmediate(resolve));
  clock = 35_000;
  release();
  const summary = await sweep;
  assert.deepEqual(started, ["t0", "t1", "t2", "t3"]);
  assert.deepEqual([...summary.deadlineCancelled].sort(), targets.map((target) => target.tabId).sort());
  assert.deepEqual(summary.opened, []);
});

test("auto-open target gives its process group the remaining deadline and recovery grace", async (t) => {
  const { environment } = hermeticEnvironment(t);
  let clock = 10_000;
  let shellOptions;
  const opened = await openAutoOpenTarget({ cwd: "/repo", workspaceId: "w1", tabId: "t1", paneId: "p1" }, {
    herdr: "herdr-test",
    pluginRoot: "/plugin",
    environment,
    timeoutMs: 25_000,
    now: () => clock,
    run: async (command, _args, options) => {
      if (command === "git") {
        clock = 15_000;
        return { stdout: "/repo\n" };
      }
      shellOptions = options;
      return { stdout: "" };
    },
  });
  assert.equal(opened, true);
  assert.equal(shellOptions.timeoutMs, 20_000);
  assert.equal(shellOptions.killGraceMs, 5_000);
  assert.equal(shellOptions.waitForTermination, true);
});

test("the global auto-open deadline starts before Herdr discovery", async (t) => {
  const { environment } = hermeticEnvironment(t, {
    HERDR_PLUGIN_EVENT: "startup",
    HERDR_BIN_PATH: "herdr-test",
  });
  let clock = 0;
  let receivedTimeout = 0;
  const run = async (_command, args) => {
    clock = 8_000;
    if (args[0] === "workspace") {
      return { stdout: JSON.stringify({ result: { workspaces: [{ workspace_id: "w1" }] } }) };
    }
    if (args[0] === "tab") {
      return { stdout: JSON.stringify({ result: { tabs: [{ workspace_id: "w1", tab_id: "w1:t1" }] } }) };
    }
    return { stdout: JSON.stringify({ result: { panes: [{ workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo" }] } }) };
  };
  const result = await autoOpenHerdrTabs(environment, {
    run,
    now: () => clock,
    openTarget: async (_target, timeoutMs) => {
      receivedTimeout = timeoutMs;
      return false;
    },
  });
  assert.equal(receivedTimeout, 27_000);
  assert.deepEqual(result.skipped, ["w1:t1"]);
});

test("only user configuration can disable automatic Herdr opening", async (t) => {
  const { environment } = hermeticEnvironment(t);
  const directory = path.join(environment.XDG_CONFIG_HOME, "git-rail");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({
    version: 1,
    herdr: { autoOpen: false },
  }));
  assert.equal(autoOpenEnabled(environment), false);
});

test("non-Git legacy labels never authorize closing a user pane", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-auto-open-spoof-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mock = path.join(root, "herdr-mock");
  const argsFile = path.join(root, "args");
  await fs.writeFile(mock, `#!/bin/sh
printf '%s\\n' "$*" >> "$MOCK_ARGS_FILE"
if [ "$1 $2" = "workspace list" ]; then
  printf '%s\\n' '{"result":{"workspaces":[{"workspace_id":"w1"}]}}'
elif [ "$1 $2" = "tab list" ]; then
  printf '%s\\n' '{"result":{"tabs":[{"workspace_id":"w1","tab_id":"w1:t1"}]}}'
else
  printf '%s\\n' '{"result":{"panes":[{"workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p1","cwd":"/tmp","label":"Grove Git Rail"}]}}'
fi
`);
  await fs.chmod(mock, 0o700);
  await autoOpenHerdrTabs({
    HERDR_BIN_PATH: mock,
    HERDR_PLUGIN_ROOT: path.resolve("."),
    HERDR_PLUGIN_EVENT: "startup",
    XDG_CACHE_HOME: path.join(root, "cache"),
    MOCK_ARGS_FILE: argsFile,
  });
  const calls = await fs.readFile(argsFile, "utf8").catch(() => "");
  assert.doesNotMatch(calls, /pane close/);
  assert.doesNotMatch(calls, /plugin pane close/);
});

test("Herdr launch keeps plugin code rooted while passing the selected repository explicitly", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-auto-open-launch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mock = path.join(root, "herdr-mock");
  const argsFile = path.join(root, "args");
  await fs.writeFile(mock, `#!/bin/sh
printf 'CALL' >> "$MOCK_ARGS_FILE"
for arg in "$@"; do printf ' <%s>' "$arg" >> "$MOCK_ARGS_FILE"; done
printf '\\n' >> "$MOCK_ARGS_FILE"
if [ "$1" = "pane" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '{"result":{"panes":[{"workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p1","terminal_id":"term-p1","cwd":"/repo"}]}}'
elif [ "$1" = "pane" ] && [ "$2" = "layout" ]; then
  printf '%s\\n' '{"result":{"layout":{"area":{"x":0,"y":0,"width":68,"height":20},"focused_pane_id":"w1:p1","panes":[{"pane_id":"w1:p1","rect":{"x":0,"y":0,"width":68,"height":20}}],"splits":[]}}}'
elif [ "$1" = "plugin" ] && [ "$2" = "pane" ] && [ "$3" = "open" ]; then
  printf '%s\\n' '{"result":{"plugin_pane":{"pane":{"workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p2","terminal_id":"term-p2","label":"HERDER GITRAIL"}}}}'
elif [ "$1" = "pane" ] && [ "$2" = "get" ] && [ "$3" = "w1:p2" ]; then
  printf '%s\\n' '{"result":{"pane":{"workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p2","terminal_id":"term-p2","label":"HERDER GITRAIL"}}}'
else
  printf '%s\\n' '{"result":{"type":"ok"}}'
fi
`);
  await fs.chmod(mock, 0o700);
  const selectedRepo = path.join(root, "repo with spaces");
  await execFileAsync("bash", ["scripts/open-herdr-panel.sh", "git-tui", "ensure"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      HERDR_BIN_PATH: mock,
      HERDR_ENV: "",
      HERDR_PLUGIN_ID: "local.git-rail",
      HERDR_PLUGIN_ROOT: path.resolve("."),
      HERDR_SOCKET_PATH: "",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_PLUGIN_CONTEXT_JSON: "",
      GIT_RAIL_WORKSPACE_CWD: selectedRepo,
      GIT_RAIL_NODE_PATH: process.execPath,
      XDG_CACHE_HOME: path.join(root, "cache"),
      MOCK_ARGS_FILE: argsFile,
    },
  });
  const calls = await fs.readFile(argsFile, "utf8");
  assert.equal(calls.includes("--cwd"), false);
  assert.match(calls, new RegExp(`<--env> <GIT_RAIL_REPO_ROOT=${selectedRepo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>`));
  assert.match(calls, /<--target-pane> <w1:p1>/);
  const stateFiles = await fs.readdir(path.join(root, "cache", "herdr-gitrail", "panes"));
  assert.ok(stateFiles.some((name) => name.includes("w1_t1")));
});
