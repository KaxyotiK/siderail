import assert from "node:assert/strict";
import test from "node:test";
import {
  closeWatcherOnError,
  resolveGitWatchRoots,
  shouldInstallRecoveryPoll,
  shouldInstallWatchers,
} from "../src/git-watch.mjs";

test("an asynchronous watcher error closes only that watcher and reaches recovery", () => {
  let listener;
  let closed = false;
  let recovered;
  const watcher = {
    on(event, callback) { assert.equal(event, "error"); listener = callback; },
    close() { closed = true; },
  };
  assert.equal(closeWatcherOnError(watcher, (error) => { recovered = error; }), watcher);
  const failure = new Error("watch failed asynchronously");
  listener(failure);
  assert.equal(closed, true);
  assert.equal(recovered, failure);
});

test("the release witness can isolate the recovery poll from filesystem watchers", () => {
  assert.equal(shouldInstallWatchers({}), true);
  assert.equal(shouldInstallWatchers({ SIDERAIL_WATCH_MODE: "ordinary" }), true);
  assert.equal(shouldInstallWatchers({ SIDERAIL_WATCH_MODE: "poll-only" }), false);
  assert.equal(shouldInstallRecoveryPoll({}), true);
  assert.equal(shouldInstallRecoveryPoll({ SIDERAIL_WATCH_MODE: "poll-only" }), true);
  assert.equal(shouldInstallRecoveryPoll({ SIDERAIL_WATCH_MODE: "watch-only" }), false);
  assert.equal(shouldInstallRecoveryPoll({ SIDERAIL_WATCH_MODE: "watch-only" }, { watchFailed: true }), true);
});

test("git watcher resolves and deduplicates per-worktree and common git directories", async () => {
  const calls = [];
  const roots = await resolveGitWatchRoots("/repo/worktree", { run: async (_cwd, args) => {
    calls.push(args);
    return { stdout: args.includes("--absolute-git-dir") ? "/repo/.git/worktrees/one\n" : "/repo/.git\n" };
  } });
  assert.deepEqual(roots, ["/repo/.git/worktrees/one", "/repo/.git"]);
  assert.equal(calls.length, 2);
});

test("git watcher never runs Git for an empty repository root", async () => {
  assert.deepEqual(await resolveGitWatchRoots("", { run: async () => { throw new Error("must not run"); } }), []);
});
