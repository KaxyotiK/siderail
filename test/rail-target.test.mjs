import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { cleanupTabPaneState, cleanupWorkspacePaneState } from "../src/herdr-pane-state.mjs";
import {
  applyRailTarget,
  clearRailTarget,
  describeCheckout,
  listSiblingWorktrees,
  railTargetPath,
  readRailTarget,
  resolveWorktree,
  sameCheckout,
  watchRailTarget,
  writeRailTarget,
} from "../src/rail-target.mjs";
import { ProcessError } from "../src/process.mjs";
import { hermeticEnvironment } from "./helpers/environment.mjs";

function worktreeSnapshot(root) {
  const checkout = (name) => {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  };
  return {
    workspaces: [
      { workspace_id: "w9", label: "relay-late", number: 9, worktree: { repo_key: "/repo/.git", checkout_path: checkout("relay-late"), is_linked_worktree: true } },
      { workspace_id: "w1", label: "repo", number: 1, worktree: { repo_key: "/repo/.git", checkout_path: checkout("main"), is_linked_worktree: false } },
      { workspace_id: "w4", label: "tier-relay", number: 4, worktree: { repo_key: "/repo/.git", checkout_path: checkout("tier-relay"), is_linked_worktree: true } },
      { workspace_id: "w2", label: "other", number: 2, worktree: { repo_key: "/other/.git", checkout_path: checkout("other"), is_linked_worktree: false } },
      { workspace_id: "w3", label: "plain", number: 3 },
    ],
  };
}

test("sibling worktrees share the workspace's repository, main checkout first", (t) => {
  const { root } = hermeticEnvironment(t);
  const snapshot = worktreeSnapshot(root);
  assert.deepEqual(listSiblingWorktrees(snapshot, "w4").map((worktree) => worktree.label), ["repo", "tier-relay", "relay-late"]);
  assert.deepEqual(listSiblingWorktrees(snapshot, "w2").map((worktree) => worktree.label), ["other"]);
  assert.deepEqual(listSiblingWorktrees(snapshot, "w3"), []);
  assert.deepEqual(listSiblingWorktrees(snapshot, "missing"), []);
});

test("a worktree resolves by label, workspace id, or checkout path", (t) => {
  const { root } = hermeticEnvironment(t);
  const worktrees = listSiblingWorktrees(worktreeSnapshot(root), "w1");
  assert.equal(resolveWorktree(worktrees, "tier-relay").workspaceId, "w4");
  assert.equal(resolveWorktree(worktrees, "TIER-RELAY").workspaceId, "w4");
  assert.equal(resolveWorktree(worktrees, "w9").label, "relay-late");
  assert.equal(resolveWorktree(worktrees, path.join(root, "tier-relay")).workspaceId, "w4");
  assert.equal(resolveWorktree(worktrees, "other"), null);
  assert.equal(resolveWorktree(worktrees, ""), null);
});

test("a pinned target replaces the followed cwd until its checkout disappears", () => {
  const context = { cwd: "/repo/main", tabId: "w1:t1", workspaceId: "w1", hasContent: false, visible: true };
  const target = { label: "tier-relay", checkoutPath: "/repo/tier-relay" };
  assert.deepEqual(applyRailTarget(context, target, { isDirectory: () => true }), {
    context: { ...context, cwd: "/repo/tier-relay", hasContent: true },
    stale: false,
  });
  assert.deepEqual(applyRailTarget(context, target, { isDirectory: () => false }), { context, stale: true });
  assert.deepEqual(applyRailTarget(context, null), { context, stale: false });
});

test("target files round-trip per tab and are removed with their tab or workspace", async (t) => {
  const { environment } = hermeticEnvironment(t);
  const first = railTargetPath({ workspaceId: "w1", tabId: "w1:t1", environment });
  const second = railTargetPath({ workspaceId: "w1", tabId: "w1:t2", environment });
  const neighbor = railTargetPath({ workspaceId: "w1G", tabId: "w1G:t1", environment });
  assert.equal(readRailTarget(first), null);
  for (const file of [first, second, neighbor]) writeRailTarget(file, { workspaceId: "w4", label: "tier-relay", checkoutPath: "/repo/tier-relay" });
  assert.deepEqual(readRailTarget(first), { workspaceId: "w4", label: "tier-relay", checkoutPath: "/repo/tier-relay" });

  fs.writeFileSync(second, "not json");
  assert.equal(readRailTarget(second), null);

  await cleanupTabPaneState({ workspaceId: "w1", tabId: "w1:t1", environment });
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), true);
  await cleanupWorkspacePaneState({ workspaceId: "w1", environment });
  assert.equal(fs.existsSync(second), false);
  assert.equal(fs.existsSync(neighbor), true);
  clearRailTarget(neighbor);
  assert.equal(readRailTarget(neighbor), null);
});

test("a rail sees its target file written and removed", async (t) => {
  const { environment } = hermeticEnvironment(t);
  const file = railTargetPath({ workspaceId: "w1", tabId: "w1:t1", environment });
  const seen = [];
  let notify;
  const watcher = watchRailTarget(file, () => { seen.push(readRailTarget(file)?.label ?? null); notify?.(); }, { pollMs: 50 });
  t.after(() => watcher.close());
  const next = () => new Promise((resolve) => { notify = resolve; });

  let change = next();
  writeRailTarget(file, { workspaceId: "w4", label: "tier-relay", checkoutPath: "/repo/tier-relay" });
  await change;
  change = next();
  clearRailTarget(file);
  await change;
  assert.deepEqual(seen, ["tier-relay", null]);
});

test("a pane's checkout is its root and branch, or says why it is unknown", async (t) => {
  const { root } = hermeticEnvironment(t);
  const answer = (stdout) => async () => ({ stdout });
  const failure = (kind) => async () => { throw new ProcessError("git failed", { kind }); };
  assert.deepEqual(await describeCheckout(root, { run: answer(`${root}\nfeature/relay\n`) }), {
    root: fs.realpathSync.native(root),
    branch: "feature/relay",
  });
  assert.equal((await describeCheckout(root, { run: answer(`${root}\nHEAD\n`) })).branch, "detached HEAD");
  assert.equal(await describeCheckout(root, { run: failure("exit") }), null);
  assert.equal(await describeCheckout(root, { run: failure("timeout") }), undefined);
});

test("checkouts compare by real path, not spelling", (t) => {
  const { root } = hermeticEnvironment(t);
  assert.equal(sameCheckout(root, `${root}/.`), true);
  assert.equal(sameCheckout(fs.realpathSync.native(root), root), true);
  assert.equal(sameCheckout(root, path.join(root, "..")), false);
  assert.equal(sameCheckout(root, ""), false);
});
