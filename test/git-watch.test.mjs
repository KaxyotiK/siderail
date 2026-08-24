import assert from "node:assert/strict";
import test from "node:test";
import { resolveGitWatchRoots } from "../src/git-watch.mjs";

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
