import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openHerdrPanel, rightmostPaneId } from "../scripts/open-herdr-panel.mjs";
import {
  acquirePaneStateLock,
  cleanupTabPaneState,
  ensurePaneStateDirectory,
  legacyPaneStatePath,
  paneStatePath,
  readPaneState,
  writePaneState,
} from "../src/herdr-pane-state.mjs";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function environment(root, overrides = {}) {
  return {
    XDG_CACHE_HOME: root,
    HERDR_BIN_PATH: "herdr-test",
    HERDR_PLUGIN_ID: "local.git-rail",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_TAB_ID: "w1:t1",
    HERDR_PANE_ID: "w1:p1",
    HERDR_PLUGIN_CONTEXT_JSON: "",
    ...overrides,
  };
}

function mockRun({ panes, layout, openedPaneId = "w1:p9", afterMutation = null }) {
  panes = panes.map((pane) => ({ terminal_id: `term-${pane.pane_id}`, ...pane }));
  const calls = [];
  const paneTabs = new Map(panes.map((pane) => [pane.pane_id, pane.tab_id]));
  let openedPane = null;
  const run = async (_command, args) => {
    calls.push(args);
    if (args[0] === "pane" && args[1] === "list") {
      return { stdout: JSON.stringify({ result: { panes: [...panes, ...(openedPane ? [openedPane] : [])] } }) };
    }
    if (args[0] === "tab" && args[1] === "list") {
      const tabs = [...new Set([...paneTabs.values(), openedPane?.tab_id].filter(Boolean))]
        .map((tabId) => ({ workspace_id: "w1", tab_id: tabId }));
      return { stdout: JSON.stringify({ result: { tabs } }) };
    }
    if (args[0] === "pane" && args[1] === "layout") {
      return { stdout: JSON.stringify({ result: { layout } }) };
    }
    if (args[0] === "pane" && args[1] === "get") {
      const existing = panes.find((item) => item.pane_id === args[2]);
      const pane = existing ? { ...existing, tab_id: paneTabs.get(existing.pane_id) } : openedPane;
      return { stdout: JSON.stringify({ result: { pane } }) };
    }
    if (args[0] === "pane" && args[1] === "process-info") {
      const pane = panes.find((item) => item.pane_id === args.at(-1));
      const argv = pane?.label === "GitRail Demo"
        ? ["node", "scripts/git-rail.mjs", "--demo"]
        : ["node", "scripts/git-rail.mjs"];
      return { stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ argv, cwd: PROJECT_ROOT }] } } }) };
    }
    if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") {
      const targetPaneId = args[args.indexOf("--target-pane") + 1];
      openedPane = {
        workspace_id: "w1",
        tab_id: args.includes("--target-pane") ? paneTabs.get(targetPaneId) : "w1:t8",
        pane_id: openedPaneId,
        terminal_id: `term-${openedPaneId}`,
        label: args.includes("git-mockup") ? "GitRail Demo" : "HERDER GITRAIL",
      };
      paneTabs.set(openedPaneId, openedPane.tab_id);
      await afterMutation?.(args);
      return { stdout: JSON.stringify({ result: { plugin_pane: { pane: openedPane } } }) };
    }
    if (args[0] === "pane" && args[1] === "move") {
      const paneId = args[2];
      paneTabs.set(paneId, args.includes("--new-tab") ? "w1:t9" : args[args.indexOf("--tab") + 1]);
      if (openedPane?.pane_id === paneId) openedPane.tab_id = paneTabs.get(paneId);
      await afterMutation?.(args);
      return { stdout: JSON.stringify({ result: { move_result: {
        changed: true,
        created_tab: args.includes("--new-tab") ? { tab_id: "w1:t9" } : undefined,
      } } }) };
    }
    if (args[0] === "plugin" && args[1] === "pane" && args[2] === "close") {
      if (openedPane?.pane_id === args[3]) {
        paneTabs.delete(openedPane.pane_id);
        openedPane = null;
      }
      return { stdout: JSON.stringify({ result: { type: "ok" } }) };
    }
    return { stdout: JSON.stringify({ result: { type: "ok" } }) };
  };
  return { calls, paneTabs, run, openedPane: () => openedPane };
}

async function temporaryRoot(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("orphaned pane locks are recovered instead of suppressing auto-open", async (t) => {
  const root = await temporaryRoot(t, "gitrail-lock-");
  const env = environment(root);
  await ensurePaneStateDirectory(env);
  const statePath = paneStatePath({ workspaceId: "w1", tabId: "w1:t1", entrypoint: "git-tui", environment: env });
  const lockPath = `${statePath}.lock`;
  await fs.mkdir(lockPath);
  await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: 2_147_483_647, createdAt: 1 }));
  const release = await acquirePaneStateLock(statePath, { timeoutMs: 100 });
  const owner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"));
  assert.equal(owner.pid, process.pid);
  await release();
  await assert.rejects(fs.stat(lockPath), { code: "ENOENT" });
});

test("a live lock cannot be age-evicted or released by an earlier owner", async (t) => {
  const root = await temporaryRoot(t, "gitrail-live-lock-");
  const env = environment(root);
  await ensurePaneStateDirectory(env);
  const statePath = paneStatePath({ workspaceId: "w1", tabId: "w1:t1", entrypoint: "git-tui", environment: env });
  const lockPath = `${statePath}.lock`;
  const release = await acquirePaneStateLock(statePath);
  await assert.rejects(
    acquirePaneStateLock(statePath, { timeoutMs: 60, staleMs: 0, ownerGraceMs: 0 }),
    /already in progress/,
  );
  const currentOwner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"));
  await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ ...currentOwner, nonce: "replacement" }));
  await release();
  assert.equal((await fs.stat(lockPath)).isDirectory(), true);
  await fs.rm(lockPath, { recursive: true, force: true });
});

test("an orphaned reclaimer cannot permanently wedge a pane lock", async (t) => {
  const root = await temporaryRoot(t, "gitrail-reclaim-lock-");
  const env = environment(root);
  await ensurePaneStateDirectory(env);
  const statePath = paneStatePath({ workspaceId: "w1", tabId: "w1:t1", entrypoint: "git-tui", environment: env });
  const lockPath = `${statePath}.lock`;
  await fs.mkdir(path.join(lockPath, ".reclaim"), { recursive: true });
  await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: 2_147_483_647, createdAt: 1, nonce: "dead" }));
  await fs.writeFile(path.join(lockPath, ".reclaim", "owner.json"), JSON.stringify({ pid: 2_147_483_647, createdAt: 1, nonce: "dead-reclaimer" }));
  const release = await acquirePaneStateLock(statePath, { timeoutMs: 250, staleMs: 0, ownerGraceMs: 0 });
  await release();
  await assert.rejects(fs.stat(lockPath), { code: "ENOENT" });
});

test("existing current rails are adopted, deduplicated, and never reopened from themselves", async (t) => {
  const root = await temporaryRoot(t, "gitrail-adopt-");
  const env = environment(root, { HERDR_PANE_ID: "w1:p3", GIT_RAIL_WORKSPACE_CWD: "/repo" });
  await ensurePaneStateDirectory(env);
  const legacyState = legacyPaneStatePath({ workspaceId: "w1", entrypoint: "git-tui", environment: env });
  await writePaneState(legacyState, "w1:p3", "/repo");
  const panes = [
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo" },
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p3", cwd: "/repo", label: "HERDER GITRAIL" },
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p4", cwd: "/repo", label: "HERDER GITRAIL" },
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p5", cwd: "/repo", label: "Grove Git Rail" },
  ];
  const mocked = mockRun({ panes, layout: {
    area: { x: 0, y: 0, width: 100, height: 20 },
    focused_pane_id: "w1:p1",
    panes: [
      { pane_id: "w1:p1", rect: { x: 0, y: 0, width: 70, height: 20 } },
      { pane_id: "w1:p3", rect: { x: 70, y: 0, width: 30, height: 20 } },
    ],
  } });
  const result = await openHerdrPanel({
    entrypoint: "git-tui",
    environment: env,
    run: mocked.run,
    resize: async () => {},
    writeOutput: () => {},
  });
  assert.deepEqual(result, { paneId: "w1:p3", adopted: true });
  assert.equal(mocked.calls.some((args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "open"), false);
  assert.deepEqual(mocked.calls.filter((args) => args.join(" ").startsWith("plugin pane close")).map((args) => args[3]), ["w1:p4", "w1:p5"]);
  const statePath = paneStatePath({ workspaceId: "w1", tabId: "w1:t1", entrypoint: "git-tui", environment: env });
  assert.deepEqual(await readPaneState(statePath), {
    paneId: "w1:p3",
    cwd: "/repo",
    terminalId: "term-w1:p3",
  });
  await assert.rejects(fs.stat(legacyState), { code: "ENOENT" });
});

test("toggle closes only the verified GitRail rail and clears its tab state", async (t) => {
  const root = await temporaryRoot(t, "gitrail-toggle-close-");
  const env = environment(root, { HERDR_PANE_ID: "w1:p1" });
  await ensurePaneStateDirectory(env);
  const statePath = paneStatePath({ workspaceId: "w1", tabId: "w1:t1", entrypoint: "git-tui", environment: env });
  await writePaneState(statePath, "w1:p3", "/repo");
  const panes = [
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo" },
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p3", cwd: "/repo", label: "HERDER GITRAIL" },
  ];
  const mocked = mockRun({ panes, layout: { area: { x: 0, y: 0, width: 100, height: 20 }, panes: [] } });
  const result = await openHerdrPanel({
    entrypoint: "git-tui",
    openMode: "toggle",
    environment: env,
    run: mocked.run,
    resize: async () => {},
    writeOutput: () => {},
  });
  assert.deepEqual(result, { paneId: "", closed: true });
  assert.deepEqual(mocked.calls.filter((args) => args.join(" ").startsWith("plugin pane close")), [["plugin", "pane", "close", "w1:p3"]]);
  assert.equal(mocked.calls.some((args) => args.join(" ").startsWith("plugin pane open")), false);
  await assert.rejects(fs.stat(statePath), { code: "ENOENT" });
});

test("toggle opens a rail when the current tab has none", async (t) => {
  const root = await temporaryRoot(t, "gitrail-toggle-open-");
  const env = environment(root, { HERDR_PANE_ID: "w1:p1", GIT_RAIL_WORKSPACE_CWD: "/repo" });
  const panes = [{ workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo" }];
  const mocked = mockRun({ panes, layout: {
    area: { x: 0, y: 0, width: 100, height: 20 },
    focused_pane_id: "w1:p1",
    panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 100, height: 20 } }],
  } });
  const result = await openHerdrPanel({
    entrypoint: "git-tui",
    openMode: "toggle",
    environment: env,
    run: mocked.run,
    resize: async () => {},
    writeOutput: () => {},
  });
  assert.equal(result.paneId, "w1:p9");
  assert.equal(result.openMode, "toggle");
  assert.equal(mocked.calls.some((args) => args.join(" ").startsWith("plugin pane open")), true);
});

test("automatic ensure uses a safe outer-right split without layout staging", async (t) => {
  const root = await temporaryRoot(t, "gitrail-safe-auto-split-");
  const env = environment(root, { HERDR_PANE_ID: "w1:p1", GIT_RAIL_WORKSPACE_CWD: "/repo" });
  const panes = [{ workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo" }];
  const mocked = mockRun({ panes, layout: {
    area: { x: 0, y: 0, width: 100, height: 20 },
    focused_pane_id: "w1:p1",
    panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 100, height: 20 } }],
  } });
  const result = await openHerdrPanel({
    entrypoint: "git-tui",
    openMode: "ensure",
    environment: env,
    run: mocked.run,
    resize: async () => {},
    writeOutput: () => {},
  });
  assert.equal(result.paneId, "w1:p9");
  const opened = mocked.calls.find((args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "open");
  assert.ok(opened.includes("--target-pane"));
  assert.equal(opened[opened.indexOf("--target-pane") + 1], "w1:p1");
  assert.equal(mocked.calls.some((args) => args[0] === "pane" && args[1] === "move"), false);
});

test("legacy rails are replaced at the right edge using the tab-focused source cwd", async (t) => {
  const root = await temporaryRoot(t, "gitrail-legacy-");
  const env = environment(root, { HERDR_PANE_ID: "" });
  const panes = [
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo/one" },
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p2", cwd: "/repo/two", foreground_cwd: "/repo/two/sub" },
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p3", cwd: "/old", label: "Grove Git Rail" },
  ];
  const layout = {
    area: { x: 0, y: 0, width: 150, height: 20 },
    focused_pane_id: "w1:p2",
    panes: [
      { pane_id: "w1:p1", rect: { x: 0, y: 0, width: 60, height: 20 } },
      { pane_id: "w1:p2", rect: { x: 60, y: 0, width: 60, height: 20 } },
      { pane_id: "w1:p3", rect: { x: 120, y: 0, width: 30, height: 20 } },
    ],
  };
  const mocked = mockRun({ panes, layout });
  await openHerdrPanel({
    entrypoint: "git-tui",
    environment: env,
    run: mocked.run,
    resize: async () => {},
    writeOutput: () => {},
  });
  assert.ok(mocked.calls.some((args) => args.join(" ") === "plugin pane close w1:p3"));
  const open = mocked.calls.find((args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "open");
  assert.equal(open[open.indexOf("--target-pane") + 1], "w1:p2");
  assert.ok(open.includes("GIT_RAIL_REPO_ROOT=/repo/two/sub"));
});

test("legacy migration open failure retains the verified legacy rail", async (t) => {
  const root = await temporaryRoot(t, "gitrail-legacy-open-failure-");
  const env = environment(root, { HERDR_PANE_ID: "w1:p1", GIT_RAIL_WORKSPACE_CWD: "/repo" });
  const panes = [
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo" },
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p3", cwd: "/repo", label: "Grove Git Rail" },
  ];
  const layout = {
    area: { x: 0, y: 0, width: 100, height: 20 }, focused_pane_id: "w1:p1", zoomed: false,
    panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 70, height: 20 } }],
  };
  const mocked = mockRun({ panes, layout, afterMutation: async (args) => {
    if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") throw new Error("injected legacy open failure");
  } });
  await assert.rejects(openHerdrPanel({
    entrypoint: "git-tui", environment: env, run: mocked.run, resize: async () => {}, writeOutput: () => {},
  }), /injected legacy open failure/);
  assert.equal(mocked.calls.some((args) => args.join(" ") === "plugin pane close w1:p3"), false);
});

test("automatic ensure adopts a middle rail without rearranging user panes", async (t) => {
  const root = await temporaryRoot(t, "gitrail-repair-");
  const env = environment(root, { GIT_RAIL_WORKSPACE_CWD: "/repo" });
  const panes = [
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo" },
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p2", cwd: "/repo", label: "HERDER GITRAIL" },
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p3", cwd: "/repo" },
  ];
  const layout = { area: { x: 0, y: 0, width: 130, height: 20 }, focused_pane_id: "w1:p1", panes: [
    { pane_id: "w1:p1", rect: { x: 0, y: 0, width: 50, height: 20 } },
    { pane_id: "w1:p2", rect: { x: 50, y: 0, width: 30, height: 20 } },
    { pane_id: "w1:p3", rect: { x: 80, y: 0, width: 50, height: 20 } },
  ] };
  const mocked = mockRun({ panes, layout, openedPaneId: "unused" });
  const resized = [];
  await openHerdrPanel({
    entrypoint: "git-tui",
    openMode: "ensure",
    environment: env,
    run: mocked.run,
    resize: async (options) => resized.push(options.paneId),
    writeOutput: () => {},
  });
  assert.equal(mocked.calls.some((args) => args[0] === "pane" && ["swap", "move"].includes(args[1])), false);
  assert.deepEqual(resized, []);
});

test("rightmost placement is independent of pane listing order", () => {
  const panes = [{ pane_id: "left" }, { pane_id: "right" }, { pane_id: "middle" }];
  const layout = { panes: [
    { pane_id: "middle", rect: { x: 40, y: 0, width: 40, height: 20 } },
    { pane_id: "left", rect: { x: 0, y: 0, width: 40, height: 20 } },
    { pane_id: "right", rect: { x: 80, y: 0, width: 40, height: 20 } },
  ] };
  assert.equal(rightmostPaneId(layout, panes), "right");
});

test("automatic ensure skips an unsafe vertical layout without staging or opening", async (t) => {
  const root = await temporaryRoot(t, "gitrail-vertical-ensure-");
  const env = environment(root, { GIT_RAIL_WORKSPACE_CWD: "/repo" });
  const panes = [
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo" },
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p2", cwd: "/repo" },
  ];
  const layout = {
    area: { x: 0, y: 0, width: 120, height: 40 },
    focused_pane_id: "w1:p1",
    panes: [
      { pane_id: "w1:p1", rect: { x: 0, y: 0, width: 120, height: 20 } },
      { pane_id: "w1:p2", rect: { x: 0, y: 20, width: 120, height: 20 } },
    ],
  };
  const mocked = mockRun({ panes, layout });
  const result = await openHerdrPanel({ entrypoint: "git-tui", openMode: "ensure", environment: env, run: mocked.run, resize: async () => {}, writeOutput: () => {} });
  assert.deepEqual(result, { paneId: "", adopted: false, openMode: "ensure", skipped: true });
  assert.equal(mocked.calls.some((args) => args[0] === "pane" && args[1] === "move"), false);
  assert.equal(mocked.calls.some((args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "open"), false);
});

test("manual open also skips an unsafe vertical layout without rearranging user panes", async (t) => {
  const root = await temporaryRoot(t, "gitrail-vertical-manual-");
  const env = environment(root, { GIT_RAIL_WORKSPACE_CWD: "/repo" });
  const panes = [
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo" },
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p2", cwd: "/repo" },
  ];
  const layout = {
    area: { x: 0, y: 0, width: 120, height: 40 },
    focused_pane_id: "w1:p1",
    panes: [
      { pane_id: "w1:p1", rect: { x: 0, y: 0, width: 120, height: 20 } },
      { pane_id: "w1:p2", rect: { x: 0, y: 20, width: 120, height: 20 } },
    ],
  };
  const mocked = mockRun({ panes, layout });
  const result = await openHerdrPanel({
    entrypoint: "git-tui",
    openMode: "replace",
    environment: env,
    run: mocked.run,
    resize: async () => {},
    writeOutput: () => {},
  });
  assert.deepEqual(result, { paneId: "", adopted: false, openMode: "replace", skipped: true });
  assert.equal(mocked.calls.some((args) => args[0] === "pane" && ["move", "swap"].includes(args[1])), false);
  assert.equal(mocked.calls.some((args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "open"), false);
});

test("manual open retains an existing verified rail when replacement is unsafe", async (t) => {
  const root = await temporaryRoot(t, "gitrail-existing-vertical-manual-");
  const env = environment(root, { HERDR_PANE_ID: "w1:p1", GIT_RAIL_WORKSPACE_CWD: "/repo" });
  const panes = [
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo" },
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p2", cwd: "/repo" },
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p3", cwd: "/repo", label: "HERDER GITRAIL" },
  ];
  const layout = {
    area: { x: 0, y: 0, width: 120, height: 40 },
    focused_pane_id: "w1:p1",
    panes: [
      { pane_id: "w1:p1", rect: { x: 0, y: 0, width: 80, height: 20 } },
      { pane_id: "w1:p2", rect: { x: 0, y: 20, width: 80, height: 20 } },
      { pane_id: "w1:p3", rect: { x: 80, y: 0, width: 40, height: 40 } },
    ],
  };
  const mocked = mockRun({ panes, layout });
  const result = await openHerdrPanel({
    entrypoint: "git-tui",
    openMode: "replace",
    environment: env,
    run: mocked.run,
    resize: async () => {},
    writeOutput: () => {},
  });
  assert.deepEqual(result, { paneId: "w1:p3", adopted: true, openMode: "replace", skipped: true });
  assert.equal(mocked.calls.some((args) => args.join(" ").startsWith("plugin pane close")), false);
  assert.equal(mocked.calls.some((args) => args.join(" ").startsWith("plugin pane open")), false);
});

test("manual replace retargets an existing rail while ensure adopts it", async (t) => {
  const root = await temporaryRoot(t, "gitrail-retarget-");
  const env = environment(root, { HERDR_PANE_ID: "w1:p1", GIT_RAIL_WORKSPACE_CWD: "/repo/two" });
  const panes = [
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo/two" },
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p3", cwd: "/repo/one", label: "HERDER GITRAIL" },
  ];
  const layout = {
    area: { x: 0, y: 0, width: 100, height: 20 },
    focused_pane_id: "w1:p1",
    panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 70, height: 20 } }],
  };
  const replaced = mockRun({ panes, layout, openedPaneId: "w1:p9" });
  const result = await openHerdrPanel({
    entrypoint: "git-tui",
    environment: env,
    run: replaced.run,
    resize: async () => {},
    writeOutput: () => {},
  });
  assert.deepEqual(result, { paneId: "w1:p9", adopted: false, openMode: "replace" });
  assert.ok(replaced.calls.some((args) => args.join(" ") === "plugin pane close w1:p3"));
  assert.ok(replaced.calls.some((args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "open"));
});

test("replacement open failure retains the existing verified rail", async (t) => {
  const root = await temporaryRoot(t, "gitrail-replacement-open-failure-");
  const env = environment(root, { HERDR_PANE_ID: "w1:p1", GIT_RAIL_WORKSPACE_CWD: "/repo/two" });
  const panes = [
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo/two" },
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p3", cwd: "/repo/one", label: "HERDER GITRAIL" },
  ];
  const layout = {
    area: { x: 0, y: 0, width: 100, height: 20 }, focused_pane_id: "w1:p1", zoomed: false,
    panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 70, height: 20 } }],
  };
  const mocked = mockRun({ panes, layout, afterMutation: async (args) => {
    if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") throw new Error("injected open failure");
  } });
  await assert.rejects(openHerdrPanel({
    entrypoint: "git-tui", environment: env, run: mocked.run, resize: async () => {}, writeOutput: () => {},
  }), /injected open failure/);
  assert.equal(mocked.calls.some((args) => args.join(" ") === "plugin pane close w1:p3"), false);
});

test("replace compensates the new pane when the owned rail cannot close", async (t) => {
  const root = await temporaryRoot(t, "gitrail-close-failure-");
  const env = environment(root, { HERDR_PANE_ID: "w1:p1", GIT_RAIL_WORKSPACE_CWD: "/repo/two" });
  const panes = [
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo/two" },
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p3", cwd: "/repo/one", label: "HERDER GITRAIL" },
  ];
  const layout = {
    area: { x: 0, y: 0, width: 100, height: 20 }, focused_pane_id: "w1:p1", zoomed: false,
    panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 70, height: 20 } }],
  };
  const mocked = mockRun({ panes, layout });
  const run = async (command, args, options) => {
    if (args.join(" ") === "plugin pane close w1:p3") throw new Error("injected close failure");
    return mocked.run(command, args, options);
  };
  await assert.rejects(openHerdrPanel({
    entrypoint: "git-tui", environment: env, run, resize: async () => {}, writeOutput: () => {},
  }), /injected close failure/);
  assert.equal(mocked.calls.some((args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "open"), true);
  assert.equal(mocked.calls.some((args) => args.join(" ") === "plugin pane close w1:p9"), true);
});

test("zoomed tabs are unzoomed for replacement and restored afterward", async (t) => {
  const root = await temporaryRoot(t, "gitrail-zoomed-");
  const env = environment(root, { HERDR_PANE_ID: "w1:p1", GIT_RAIL_WORKSPACE_CWD: "/repo" });
  const panes = [
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo" },
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p3", label: "HERDER GITRAIL" },
  ];
  const baseLayout = {
    area: { x: 0, y: 0, width: 100, height: 20 }, focused_pane_id: "w1:p1",
    panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 100, height: 20 } }],
  };
  const mocked = mockRun({ panes, layout: baseLayout, openedPaneId: "w1:p9" });
  let zoomed = true;
  const calls = [];
  const run = async (command, args, options) => {
    calls.push(args);
    if (args[0] === "workspace" && args[1] === "list") {
      return { stdout: JSON.stringify({ result: { workspaces: [{
        workspace_id: "w0", active_tab_id: "w0:t7", focused: true,
      }] } }) };
    }
    if (args[0] === "pane" && args[1] === "layout") {
      return { stdout: JSON.stringify({ result: { layout: { ...baseLayout, zoomed } } }) };
    }
    if (args[0] === "pane" && args[1] === "zoom") {
      zoomed = args.includes("--on");
      return { stdout: JSON.stringify({ result: { zoom: { changed: true } } }) };
    }
    return mocked.run(command, args, options);
  };
  await openHerdrPanel({ entrypoint: "git-tui", environment: env, run, resize: async () => {}, writeOutput: () => {} });
  const off = calls.findIndex((args) => args[0] === "pane" && args[1] === "zoom" && args.includes("--off"));
  const close = calls.findIndex((args) => args.join(" ") === "plugin pane close w1:p3");
  const on = calls.findIndex((args) => args[0] === "pane" && args[1] === "zoom" && args.includes("--on"));
  const restoreWorkspace = calls.findIndex((args) => args.join(" ") === "workspace focus w0");
  const restoreTab = calls.findIndex((args) => args.join(" ") === "tab focus w0:t7");
  assert.ok(off >= 0 && close > off && on > close);
  assert.ok(restoreWorkspace > on && restoreTab > restoreWorkspace);
  assert.equal(zoomed, true);
});

test("GitRail Demo panes use entrypoint-specific identity instead of accumulating", async (t) => {
  const root = await temporaryRoot(t, "gitrail-demo-");
  const env = environment(root, { HERDR_PANE_ID: "w1:p1", GIT_RAIL_WORKSPACE_CWD: "/repo" });
  const panes = [
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo" },
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p3", cwd: "/repo", label: "GitRail Demo" },
  ];
  const layout = {
    area: { x: 0, y: 0, width: 100, height: 20 },
    focused_pane_id: "w1:p1",
    panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 70, height: 20 } }],
  };
  const mocked = mockRun({ panes, layout, openedPaneId: "w1:p9" });
  await openHerdrPanel({
    entrypoint: "git-mockup",
    environment: env,
    run: mocked.run,
    resize: async () => {},
    writeOutput: () => {},
  });
  assert.ok(mocked.calls.some((args) => args.join(" ") === "plugin pane close w1:p3"));
  assert.equal(mocked.calls.filter((args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "open").length, 1);
});

test("a GitRail Demo pane cannot become the main rail's content source", async (t) => {
  const root = await temporaryRoot(t, "gitrail-demo-source-");
  const env = environment(root, { HERDR_PANE_ID: "w1:p3", GIT_RAIL_WORKSPACE_CWD: "/plugin" });
  const panes = [{
    workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p3", cwd: "/plugin", label: "GitRail Demo",
  }];
  const mocked = mockRun({ panes, layout: {
    area: { x: 0, y: 0, width: 100, height: 20 },
    focused_pane_id: "w1:p3",
    panes: [{ pane_id: "w1:p3", rect: { x: 0, y: 0, width: 100, height: 20 } }],
  } });
  await assert.rejects(openHerdrPanel({
    entrypoint: "git-tui", environment: env, run: mocked.run, resize: async () => {}, writeOutput: () => {},
  }), /unable to resolve a non-GitRail pane/);
  assert.equal(mocked.calls.some((args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "open"), false);
});

test("a user pane renamed like GitRail is never treated as plugin-owned", async (t) => {
  const root = await temporaryRoot(t, "gitrail-spoof-");
  const env = environment(root, { HERDR_PANE_ID: "w1:p1", GIT_RAIL_WORKSPACE_CWD: "/repo" });
  const panes = [{
    workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo", label: "HERDER GITRAIL",
  }];
  const layout = {
    area: { x: 0, y: 0, width: 100, height: 20 },
    focused_pane_id: "w1:p1",
    panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 100, height: 20 } }],
  };
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    if (args[0] === "pane" && args[1] === "list") return { stdout: JSON.stringify({ result: { panes } }) };
    if (args[0] === "pane" && args[1] === "layout") return { stdout: JSON.stringify({ result: { layout } }) };
    if (args[0] === "pane" && args[1] === "process-info") {
      return { stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ argv: ["zsh"] }] } } }) };
    }
    if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") {
      return { stdout: JSON.stringify({ result: { plugin_pane: { pane: { pane_id: "w1:p9" } } } }) };
    }
    if (args[0] === "pane" && args[1] === "get" && args[2] === "w1:p9") {
      return { stdout: JSON.stringify({ result: { pane: {
        workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p9", terminal_id: "term-p9", label: "HERDER GITRAIL",
      } } }) };
    }
    return { stdout: JSON.stringify({ result: { type: "ok" } }) };
  };
  await openHerdrPanel({ entrypoint: "git-tui", environment: env, run, resize: async () => {}, writeOutput: () => {} });
  assert.equal(calls.some((args) => args.join(" ") === "plugin pane close w1:p1"), false);
  assert.equal(calls.some((args) => args[0] === "pane" && args[1] === "move" && args.includes("w1:p1")), false);
});

test("ownership inspection failure aborts instead of opening a duplicate rail", async (t) => {
  const root = await temporaryRoot(t, "gitrail-ownership-timeout-");
  const env = environment(root, { GIT_RAIL_WORKSPACE_CWD: "/repo" });
  const panes = [
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo" },
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p3", label: "HERDER GITRAIL" },
  ];
  const layout = {
    area: { x: 0, y: 0, width: 100, height: 20 }, focused_pane_id: "w1:p1",
    panes: [{ pane_id: "w1:p1", rect: { x: 0, y: 0, width: 100, height: 20 } }],
  };
  const mocked = mockRun({ panes, layout });
  const run = async (command, args, options) => {
    if (args[0] === "pane" && args[1] === "process-info") throw new Error("inspection timed out");
    return mocked.run(command, args, options);
  };
  await assert.rejects(openHerdrPanel({
    entrypoint: "git-tui", environment: env, run, resize: async () => {}, writeOutput: () => {},
  }), /unable to verify ownership.*inspection timed out/);
  assert.equal(mocked.calls.some((args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "open"), false);
});

test("an invalid plugin-open pane id is never moved into the target tab", async (t) => {
  const root = await temporaryRoot(t, "gitrail-invalid-open-");
  const env = environment(root, { GIT_RAIL_WORKSPACE_CWD: "/repo" });
  const panes = [
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", cwd: "/repo" },
    { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p2", cwd: "/repo" },
  ];
  const layout = {
    area: { x: 0, y: 0, width: 120, height: 20 }, focused_pane_id: "w1:p1",
    panes: [
      { pane_id: "w1:p1", rect: { x: 0, y: 0, width: 60, height: 20 } },
      { pane_id: "w1:p2", rect: { x: 60, y: 0, width: 60, height: 20 } },
    ],
  };
  const mocked = mockRun({ panes, layout, openedPaneId: "FOREIGN:pane" });
  const run = async (command, args, options) => {
    if (args[0] === "pane" && args[1] === "get" && args[2] === "FOREIGN:pane") {
      return { stdout: JSON.stringify({ result: { pane: {
        pane_id: "FOREIGN:pane", workspace_id: "other", tab_id: "other:t1", label: "HERDER GITRAIL",
      } } }) };
    }
    return mocked.run(command, args, options);
  };
  await assert.rejects(openHerdrPanel({
    entrypoint: "git-tui", environment: env, run, resize: async () => {}, writeOutput: () => {},
  }), /invalid GitRail pane/);
  assert.equal(mocked.calls.some((args) => args[0] === "pane" && args[1] === "move" && args[2] === "FOREIGN:pane"), false);
});

test("closed-tab cleanup removes state and orphan locks only for that tab", async (t) => {
  const root = await temporaryRoot(t, "gitrail-cleanup-");
  const env = environment(root);
  await ensurePaneStateDirectory(env);
  const closed = paneStatePath({ workspaceId: "w1", tabId: "w1:t1", entrypoint: "git-tui", environment: env });
  const other = paneStatePath({ workspaceId: "w1", tabId: "w1:t2", entrypoint: "git-tui", environment: env });
  await writePaneState(closed, "w1:p1", "/repo");
  await fs.mkdir(`${closed}.lock`);
  await writePaneState(other, "w1:p2", "/repo");
  await cleanupTabPaneState({ workspaceId: "w1", tabId: "w1:t1", environment: env });
  await assert.rejects(fs.stat(closed), { code: "ENOENT" });
  await assert.rejects(fs.stat(`${closed}.lock`), { code: "ENOENT" });
  assert.deepEqual(await readPaneState(other), { paneId: "w1:p2", cwd: "/repo" });
});
