import assert from "node:assert/strict";
import test from "node:test";
import { buildPathIndex, filesAgainstBase } from "../src/model.mjs";

test("Files view combines base-branch diffs with grey unchanged files", () => {
  const files = buildPathIndex({
    tracked: ["clean.txt", "committed.txt", "working.txt"],
    againstBase: [{ path: "committed.txt", status: "modified", additions: 8, deletions: 2, descriptor: { kind: "against", baseRef: "main" } }],
    unstaged: [
      { path: "working.txt", status: "modified", additions: 1, deletions: 1, descriptor: { kind: "unstaged" } },
      { path: "new.txt", status: "untracked", additions: 3, deletions: 0, descriptor: { kind: "untracked" } },
    ],
  });
  const descriptor = { kind: "workspace", baseRef: "main", mergeBase: "abc123" };
  const entries = filesAgainstBase(files, [
    { path: "committed.txt", status: "modified", additions: 8, deletions: 2, descriptor },
    { path: "working.txt", status: "modified", additions: 2, deletions: 1, descriptor },
  ], descriptor);
  const byPath = new Map(entries.map((file) => [file.path, file]));

  assert.deepEqual(byPath.get("working.txt").descriptor, descriptor);
  assert.equal(byPath.get("working.txt").additions, 2);
  assert.deepEqual(byPath.get("committed.txt").descriptor, descriptor);
  assert.equal(byPath.get("committed.txt").status, "modified");
  assert.equal(byPath.get("clean.txt").status, "clean");
  assert.deepEqual(byPath.get("clean.txt").descriptor, descriptor);
  assert.deepEqual(byPath.get("new.txt").descriptor, { kind: "untracked" });
});
