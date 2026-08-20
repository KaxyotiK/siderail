import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { autoOpenEnabled, collectTabTargets, tabTargetFromContext } from "../scripts/auto-open-herdr-tabs.mjs";

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
    { workspace_id: "w2", tab_id: "w2:t1" },
  ] } };
  const panes = { result: { panes: [
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p2", cwd: "/repos/one-a" },
    { workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p1", cwd: "/repos/one", focused: true },
    { workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p3", label: "HERDER GITRAIL" },
    { workspace_id: "w1", tab_id: "w1:t3", pane_id: "w1:p4", cwd: "/repos/preview", label: "GitRail Preview" },
    { workspace_id: "w2", tab_id: "w2:t1", pane_id: "w2:p1", cwd: "/wrong" },
  ] } };
  assert.deepEqual(collectTabTargets(workspaces, tabs, panes), [
    { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p2", cwd: "/repos/one-a" },
    { workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p1", cwd: "/worktrees/two" },
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
    { workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", cwd: "/two" },
  ]);
});

test("repository configuration can disable automatic Herdr opening", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-auto-open-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, ".git-rail.json"), JSON.stringify({
    version: 1,
    herdr: { autoOpen: true },
  }));
  assert.equal(autoOpenEnabled(root, {}), true);
  await fs.writeFile(path.join(root, ".git-rail.json"), JSON.stringify({
    version: 1,
    herdr: { autoOpen: false },
  }));
  assert.equal(autoOpenEnabled(root, {}), false);
});

test("Herdr launch keeps plugin code rooted while passing the selected repository explicitly", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-auto-open-launch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mock = path.join(root, "herdr-mock");
  const argsFile = path.join(root, "args");
  await fs.writeFile(mock, `#!/bin/sh
if [ "$1" = "pane" ] && [ "$2" = "get" ]; then exit 1; fi
if [ "$1" = "pane" ] && [ "$2" = "layout" ]; then
  printf '%s\\n' '{"result":{"layout":{"panes":[{"pane_id":"w1:p2","rect":{"x":34,"y":0,"width":34,"height":20}}],"splits":[{"direction":"right","rect":{"x":0,"y":0,"width":68,"height":20}}]}}}'
  exit 0
fi
printf '%s\\n' "$@" > "$MOCK_ARGS_FILE"
printf '%s\\n' '{"result":{"plugin_pane":{"pane":{"pane_id":"w1:p2"}}}}'
`);
  await fs.chmod(mock, 0o700);
  const selectedRepo = path.join(root, "repo with spaces");
  await execFileAsync("bash", ["scripts/open-herdr-panel.sh", "git-tui", "ensure"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      HERDR_BIN_PATH: mock,
      HERDR_PLUGIN_ID: "local.git-rail",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_PLUGIN_CONTEXT_JSON: "",
      GIT_RAIL_WORKSPACE_CWD: selectedRepo,
      XDG_CACHE_HOME: path.join(root, "cache"),
      MOCK_ARGS_FILE: argsFile,
    },
  });
  const args = (await fs.readFile(argsFile, "utf8")).trim().split("\n");
  assert.equal(args.includes("--cwd"), false);
  assert.deepEqual(args.slice(args.indexOf("--env"), args.indexOf("--env") + 2), [
    "--env", `GIT_RAIL_REPO_ROOT=${selectedRepo}`,
  ]);
  const stateFiles = await fs.readdir(path.join(root, "cache", "herdr-gitrail", "panes"));
  assert.ok(stateFiles.some((name) => name.includes("w1_t1")));
});
