import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveGitWatchRoots,
  shouldInstallRecoveryPoll,
  shouldInstallWatchers,
} from "../src/git-watch.mjs";

test("the release witness can isolate the recovery poll from filesystem watchers", () => {
  assert.equal(shouldInstallWatchers({}), true);
  assert.equal(shouldInstallWatchers({ GIT_RAIL_WATCH_MODE: "ordinary" }), true);
  assert.equal(shouldInstallWatchers({ GIT_RAIL_WATCH_MODE: "poll-only" }), false);
  assert.equal(shouldInstallRecoveryPoll({}), true);
  assert.equal(shouldInstallRecoveryPoll({ GIT_RAIL_WATCH_MODE: "poll-only" }), true);
  assert.equal(shouldInstallRecoveryPoll({ GIT_RAIL_WATCH_MODE: "watch-only" }), false);
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
