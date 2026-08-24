import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { paneStatePath, readPaneState, writePaneState } from "../src/herdr-pane-state.mjs";
import { openOwnedPreview, previewPaneStatePath } from "../src/preview-pane-lifecycle.mjs";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-preview-lifecycle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, environment: { XDG_CACHE_HOME: root } };
}

function mockRunner({ staleLabel = "GitRail Preview", staleWorkspace = "w1", argv = ["node", "scripts/file-preview.mjs"], failInspection = false, missingPane = false, failOpen = false, failRename = false, malformedOpen = false } = {}) {
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    if (args.join(" ") === "plugin pane open") {
      if (failOpen) throw new Error("open failed");
      return { stdout: malformedOpen ? "{}" : JSON.stringify({ result: { plugin_pane: { pane: { pane_id: "new-pane", tab_id: "preview-tab", terminal_id: "new-terminal" } } } }) };
    }
    if (args[0] === "pane" && args[1] === "get") {
      if (failInspection) throw new Error("inspection timed out");
      if (missingPane) return { stdout: "{}" };
      return { stdout: JSON.stringify({ result: { pane: { pane_id: args[2], terminal_id: "stale-terminal", workspace_id: staleWorkspace, label: staleLabel } } }) };
    }
    if (args[0] === "tab" && args[1] === "rename" && failRename) throw new Error("rename failed");
    if (args[0] === "pane" && args[1] === "process-info") {
      return { stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ argv, cwd: PROJECT_ROOT }] } } }) };
    }
    return { stdout: JSON.stringify({ result: { type: "ok" } }) };
  };
  return { calls, run };
}

test("preview state is scoped by workspace, source tab, and entrypoint", async (t) => {
  const { environment } = await fixture(t);
  const first = previewPaneStatePath({ workspaceId: "w1", sourceTabId: "w1:t1", environment });
  const second = previewPaneStatePath({ workspaceId: "w1", sourceTabId: "w1:t2", environment });
  const otherWorkspace = previewPaneStatePath({ workspaceId: "w2", sourceTabId: "w2:t1", environment });
  assert.notEqual(first, second);
  assert.notEqual(first, otherWorkspace);
  assert.equal(first, paneStatePath({ workspaceId: "w1", tabId: "w1:t1", entrypoint: "file-preview", environment }));
});

test("opening a preview records it, renames its tab, and closes only a verified stale preview", async (t) => {
  const { environment } = await fixture(t);
  const statePath = previewPaneStatePath({ workspaceId: "w1", sourceTabId: "w1:t1", environment });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await writePaneState(statePath, "stale-pane", "/repo", "stale-terminal");
  const mocked = mockRunner();
  const result = await openOwnedPreview({
    run: mocked.run,
    herdr: "herdr",
    openArgs: ["plugin", "pane", "open"],
    cwd: "/repo",
    workspaceId: "w1",
    sourceTabId: "w1:t1",
    environment,
    tabName: "README.md",
  });
  assert.deepEqual(result, { paneId: "new-pane", tabId: "preview-tab", cleanupWarning: "", renameWarning: "" });
  assert.deepEqual(await readPaneState(statePath), { paneId: "new-pane", cwd: "/repo", terminalId: "new-terminal" });
  assert.deepEqual(mocked.calls.filter((args) => args[0] === "plugin" && args[1] === "pane" && args[2] === "close"), [["plugin", "pane", "close", "stale-pane"]]);
  assert.ok(mocked.calls.some((args) => args.join(" ") === "tab rename preview-tab README.md"));
});

for (const [name, options] of [
  ["reused user pane id", { staleLabel: "shell" }],
  ["wrong workspace", { staleWorkspace: "w2" }],
  ["unrelated process", { argv: ["node", "server.mjs"] }],
  ["same-named script from another checkout", { argv: ["node", "/tmp/unrelated/scripts/file-preview.mjs"] }],
]) {
  test(`${name} is never closed from stale preview state`, async (t) => {
    const { environment } = await fixture(t);
    const statePath = previewPaneStatePath({ workspaceId: "w1", sourceTabId: "w1:t1", environment });
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await writePaneState(statePath, "stale-pane", "/repo", "stale-terminal");
    const mocked = mockRunner(options);
    await openOwnedPreview({ run: mocked.run, herdr: "herdr", openArgs: ["plugin", "pane", "open"], cwd: "/repo", workspaceId: "w1", sourceTabId: "w1:t1", environment });
    assert.equal(mocked.calls.some((args) => args[0] === "plugin" && args[2] === "close"), false);
  });
}

test("inspection failure leaves the old pane open without hiding the successful new preview", async (t) => {
  const { environment } = await fixture(t);
  const statePath = previewPaneStatePath({ workspaceId: "w1", sourceTabId: "w1:t1", environment });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await writePaneState(statePath, "stale-pane", "/repo", "stale-terminal");
  const mocked = mockRunner({ failInspection: true });
  const result = await openOwnedPreview({ run: mocked.run, herdr: "herdr", openArgs: ["plugin", "pane", "open"], cwd: "/repo", workspaceId: "w1", sourceTabId: "w1:t1", environment });
  assert.equal(result.paneId, "new-pane");
  assert.match(result.cleanupWarning, /inspection timed out/);
  assert.equal(mocked.calls.some((args) => args[0] === "plugin" && args[2] === "close"), false);
});

test("malformed open response does not overwrite existing preview ownership", async (t) => {
  const { environment } = await fixture(t);
  const statePath = previewPaneStatePath({ workspaceId: "w1", sourceTabId: "w1:t1", environment });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await writePaneState(statePath, "stale-pane", "/repo", "stale-terminal");
  const mocked = mockRunner({ malformedOpen: true });
  await assert.rejects(
    openOwnedPreview({ run: mocked.run, herdr: "herdr", openArgs: ["plugin", "pane", "open"], cwd: "/repo", workspaceId: "w1", sourceTabId: "w1:t1", environment }),
    /did not return a preview pane id/,
  );
  assert.deepEqual(await readPaneState(statePath), { paneId: "stale-pane", cwd: "/repo", terminalId: "stale-terminal" });
});

test("missing stale panes are discarded without a destructive close", async (t) => {
  const { environment } = await fixture(t);
  const statePath = previewPaneStatePath({ workspaceId: "w1", sourceTabId: "w1:t1", environment });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await writePaneState(statePath, "missing-pane", "/repo", "missing-terminal");
  const mocked = mockRunner({ missingPane: true });
  const result = await openOwnedPreview({ run: mocked.run, herdr: "herdr", openArgs: ["plugin", "pane", "open"], cwd: "/repo", workspaceId: "w1", sourceTabId: "w1:t1", environment });
  assert.equal(result.paneId, "new-pane");
  assert.equal(mocked.calls.some((args) => args[0] === "plugin" && args[2] === "close"), false);
});

test("open failure preserves stale ownership and rename failure is only a warning", async (t) => {
  const { environment } = await fixture(t);
  const statePath = previewPaneStatePath({ workspaceId: "w1", sourceTabId: "w1:t1", environment });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await writePaneState(statePath, "stale-pane", "/repo", "stale-terminal");
  const failed = mockRunner({ failOpen: true });
  await assert.rejects(openOwnedPreview({ run: failed.run, herdr: "herdr", openArgs: ["plugin", "pane", "open"], cwd: "/repo", workspaceId: "w1", sourceTabId: "w1:t1", environment }), /open failed/);
  assert.deepEqual(await readPaneState(statePath), { paneId: "stale-pane", cwd: "/repo", terminalId: "stale-terminal" });

  const renamed = mockRunner({ failRename: true });
  const result = await openOwnedPreview({ run: renamed.run, herdr: "herdr", openArgs: ["plugin", "pane", "open"], cwd: "/repo", workspaceId: "w1", sourceTabId: "w1:t1", environment, tabName: "README.md" });
  assert.equal(result.paneId, "new-pane");
  assert.match(result.renameWarning, /rename failed/);
});

test("an unwritable preview state root fails inside the guarded lifecycle before opening a pane", async (t) => {
  const { root } = await fixture(t);
  const cacheFile = path.join(root, "cache-is-a-file");
  await fs.writeFile(cacheFile, "not a directory");
  const mocked = mockRunner();
  await assert.rejects(
    openOwnedPreview({
      run: mocked.run,
      herdr: "herdr",
      openArgs: ["plugin", "pane", "open"],
      cwd: "/repo",
      workspaceId: "w1",
      sourceTabId: "w1:t1",
      environment: { XDG_CACHE_HOME: cacheFile },
    }),
    /ENOTDIR/,
  );
  assert.equal(mocked.calls.length, 0);
});
