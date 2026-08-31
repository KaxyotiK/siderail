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

test("Files view omits deleted paths but keeps files recreated at the same path", () => {
  const descriptor = { kind: "workspace", baseRef: "main", mergeBase: "abc123" };
  const files = buildPathIndex({
    tracked: ["present.txt", "deleted.txt"],
    againstBase: [
      { path: "deleted.txt", status: "deleted", descriptor: { kind: "against", baseRef: "main" } },
      { path: "recreated.txt", status: "deleted", descriptor: { kind: "against", baseRef: "main" } },
    ],
    untracked: [
      { path: "recreated.txt", status: "added", descriptor: { kind: "untracked" } },
    ],
  });

  const entries = filesAgainstBase(files, [
    { path: "deleted.txt", status: "deleted", descriptor },
    { path: "recreated.txt", status: "modified", descriptor },
  ], descriptor);

  assert.deepEqual(entries.map((file) => file.path), ["present.txt", "recreated.txt"]);
  assert.deepEqual(entries.find((file) => file.path === "recreated.txt").descriptor, { kind: "untracked" });
});

test("Files view omits deleted paths when no base comparison is available", () => {
  const files = buildPathIndex({
    tracked: ["deleted.txt"],
    staged: [{ path: "deleted.txt", status: "modified", descriptor: { kind: "staged" } }],
    unstaged: [{ path: "deleted.txt", status: "deleted", descriptor: { kind: "unstaged" } }],
  });

  assert.deepEqual(filesAgainstBase(files, [], null), []);
});

test("canonical clean files preserve tracked mode metadata", () => {
  const files = buildPathIndex({
    tracked: [
      { path: "link", mode: "120000", symlink: true },
      { path: "module", mode: "160000", submodule: true },
      { path: "tool", mode: "100755", executable: true },
    ],
  });
  const byPath = new Map(files.map((file) => [file.path, file]));
  assert.equal(byPath.get("link").symlink, true);
  assert.equal(byPath.get("module").submodule, true);
  assert.equal(byPath.get("tool").executable, true);
  assert.ok(files.every((file) => file.clean));
});
