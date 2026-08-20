import assert from "node:assert/strict";
import test from "node:test";
import { buildPathIndex, filesAgainstHead } from "../src/model.mjs";

test("Files view compares tracked worktree changes against HEAD", () => {
  const files = buildPathIndex({
    tracked: ["clean.txt", "committed.txt", "working.txt"],
    againstBase: [{ path: "committed.txt", status: "modified", additions: 8, deletions: 2, descriptor: { kind: "against", baseRef: "main" } }],
    unstaged: [
      { path: "working.txt", status: "modified", additions: 1, deletions: 1, descriptor: { kind: "unstaged" } },
      { path: "new.txt", status: "untracked", additions: 3, deletions: 0, descriptor: { kind: "untracked" } },
    ],
  });
  const entries = filesAgainstHead(files, [
    { path: "working.txt", status: "modified", additions: 2, deletions: 1, descriptor: { kind: "head" } },
  ]);
  const byPath = new Map(entries.map((file) => [file.path, file]));

  assert.deepEqual(byPath.get("working.txt").descriptor, { kind: "head" });
  assert.equal(byPath.get("working.txt").additions, 2);
  assert.deepEqual(byPath.get("committed.txt").descriptor, { kind: "head" });
  assert.equal(byPath.get("committed.txt").status, "clean");
  assert.deepEqual(byPath.get("new.txt").descriptor, { kind: "untracked" });
});
