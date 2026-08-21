import assert from "node:assert/strict";
import test from "node:test";
import { resolveHerdrTabCwd, selectTabContentPane } from "../src/herdr-context.mjs";

test("content selection follows each tab's focused pane and ignores GitRail panes", () => {
  const panes = [
    { pane_id: "w1:p1", tab_id: "w1:t1", foreground_cwd: "/repo/one" },
    { pane_id: "w1:p2", tab_id: "w1:t1", foreground_cwd: "/repo/two" },
    { pane_id: "w1:p3", tab_id: "w1:t1", label: "HERDER GITRAIL" },
  ];
  assert.equal(selectTabContentPane(panes, { focused_pane_id: "w1:p2" }, {
    railPaneId: "w1:p3",
    sourcePaneId: "w1:p1",
  }).pane_id, "w1:p2");
  assert.equal(selectTabContentPane(panes, { focused_pane_id: "w1:p3" }, {
    railPaneId: "w1:p3",
    sourcePaneId: "w1:p1",
  }).pane_id, "w1:p1");
});

test("live cwd resolution is scoped to the rail's own tab", async () => {
  const run = async (_command, args) => {
    if (args[0] === "pane" && args[1] === "get") {
      return { stdout: JSON.stringify({ result: { pane: {
        pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t2",
      } } }) };
    }
    if (args[0] === "pane" && args[1] === "list") {
      return { stdout: JSON.stringify({ result: { panes: [
        { pane_id: "w1:p1", tab_id: "w1:t1", foreground_cwd: "/other-tab" },
        { pane_id: "w1:p2", tab_id: "w1:t2", foreground_cwd: "/repo/current" },
        { pane_id: "w1:p3", tab_id: "w1:t2", label: "HERDER GITRAIL" },
      ] } }) };
    }
    return { stdout: JSON.stringify({ result: { layout: { focused_pane_id: "w1:p2" } } }) };
  };
  assert.deepEqual(await resolveHerdrTabCwd({
    run,
    herdr: "herdr-test",
    workspaceId: "w1",
    railPaneId: "w1:p3",
    fallbackCwd: "/fallback",
  }), {
    cwd: "/repo/current",
    sourcePaneId: "w1:p2",
    tabId: "w1:t2",
    workspaceId: "w1",
  });
});

test("a focused GitRail Demo never becomes the main rail's content source", () => {
  const panes = [
    { pane_id: "w1:p1", foreground_cwd: "/repo/customer" },
    { pane_id: "w1:p2", foreground_cwd: "/plugin", label: "GitRail Demo" },
    { pane_id: "w1:p3", label: "HERDER GITRAIL" },
  ];
  assert.equal(selectTabContentPane(panes, { focused_pane_id: "w1:p2" }, {
    railPaneId: "w1:p3",
    sourcePaneId: "w1:p1",
  }).pane_id, "w1:p1");
});

test("a stored GitRail Demo source is discarded in favor of real tab content", async () => {
  const run = async (_command, args) => {
    if (args[0] === "pane" && args[1] === "get") {
      return { stdout: JSON.stringify({ result: { pane: {
        pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t1",
      } } }) };
    }
    if (args[0] === "pane" && args[1] === "list") {
      return { stdout: JSON.stringify({ result: { panes: [
        { pane_id: "w1:p1", tab_id: "w1:t1", foreground_cwd: "/repo/customer" },
        { pane_id: "w1:p2", tab_id: "w1:t1", foreground_cwd: "/plugin", label: "GitRail Demo" },
        { pane_id: "w1:p3", tab_id: "w1:t1", label: "HERDER GITRAIL" },
      ] } }) };
    }
    return { stdout: JSON.stringify({ result: { layout: { focused_pane_id: "w1:p3" } } }) };
  };
  assert.deepEqual(await resolveHerdrTabCwd({
    run,
    workspaceId: "w1",
    railPaneId: "w1:p3",
    sourcePaneId: "w1:p2",
  }), {
    cwd: "/repo/customer",
    sourcePaneId: "w1:p1",
    tabId: "w1:t1",
    workspaceId: "w1",
  });
});

test("a moved rail resolves cwd from its current workspace instead of its launch workspace", async () => {
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    if (args[0] === "pane" && args[1] === "get") {
      return { stdout: JSON.stringify({ result: { pane: {
        pane_id: "w2:p3", workspace_id: "w2", tab_id: "w2:t4",
      } } }) };
    }
    if (args[0] === "pane" && args[1] === "list") {
      return { stdout: JSON.stringify({ result: { panes: [
        { pane_id: "w2:p1", tab_id: "w2:t4", foreground_cwd: "/new/repo" },
        { pane_id: "w2:p3", tab_id: "w2:t4", label: "HERDER GITRAIL" },
      ] } }) };
    }
    return { stdout: JSON.stringify({ result: { layout: { focused_pane_id: "w2:p1" } } }) };
  };
  assert.deepEqual(await resolveHerdrTabCwd({
    run,
    workspaceId: "w1",
    railPaneId: "w1:p3",
    fallbackCwd: "/old/repo",
  }), {
    cwd: "/new/repo",
    sourcePaneId: "w2:p1",
    tabId: "w2:t4",
    workspaceId: "w2",
  });
  assert.ok(calls.some((args) => args.join(" ") === "pane list --workspace w2"));
  assert.equal(calls.some((args) => args.join(" ") === "pane list --workspace w1"), false);
});
