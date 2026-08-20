import assert from "node:assert/strict";
import test from "node:test";
import { parseUnifiedDiff } from "../src/diff-view.mjs";

test("structured file diff removes Git plumbing and tracks both line numbers", () => {
  const rows = parseUnifiedDiff([
    "diff --git a/docs/README.md b/docs/README.md",
    "index 1111111..2222222 100644",
    "--- a/docs/README.md",
    "+++ b/docs/README.md",
    "@@ -10,3 +10,3 @@ heading",
    " same",
    "-before",
    "+after",
    " tail",
  ].join("\n"));

  assert.deepEqual(rows, [
    { kind: "hunk", text: "@@ -10,3 +10,3 @@ heading" },
    { kind: "context", oldLine: 10, newLine: 10, text: "same" },
    { kind: "deleted", oldLine: 11, newLine: null, text: "before" },
    { kind: "added", oldLine: null, newLine: 11, text: "after" },
    { kind: "context", oldLine: 12, newLine: 12, text: "tail" },
  ]);
});

test("structured file diff preserves meaningful file metadata", () => {
  assert.deepEqual(parseUnifiedDiff("old mode 100644\nnew mode 100755\n"), [
    { kind: "meta", text: "old mode 100644" },
    { kind: "meta", text: "new mode 100755" },
  ]);
});

test("structured file diff parses combined conflict hunks", () => {
  const rows = parseUnifiedDiff([
    "diff --cc conflict.txt",
    "index 1111111,2222222..3333333",
    "--- a/conflict.txt",
    "+++ b/conflict.txt",
    "@@@ -1,3 -1,3 +1,4 @@@",
    "  shared",
    "++<<<<<<< HEAD",
    "+ ours",
    " +theirs",
    "  tail",
  ].join("\n"));

  assert.equal(rows[0].kind, "hunk");
  assert.equal(rows[0].combined, true);
  assert.deepEqual(rows.slice(1).map(({ kind, text, oldLines, newLine }) => ({ kind, text, oldLines, newLine })), [
    { kind: "context", text: "shared", oldLines: [1, 1], newLine: 1 },
    { kind: "added", text: "<<<<<<< HEAD", oldLines: [null, null], newLine: 2 },
    { kind: "added", text: "ours", oldLines: [null, 2], newLine: 3 },
    { kind: "added", text: "theirs", oldLines: [2, null], newLine: 4 },
    { kind: "context", text: "tail", oldLines: [3, 3], newLine: 5 },
  ]);
});

test("diff rows neutralize repository-controlled terminal sequences", () => {
  const rows = parseUnifiedDiff("@@ -1 +1 @@\n-safe\n+before\u001b]52;c;c3RlYWw=\u0007after\n");
  assert.equal(rows.at(-1).text, "before�after");
  assert.doesNotMatch(JSON.stringify(rows), /(?:\u001b|]52;|c3RlYWw=)/);
});

test("structured diff parsing strips Git color without losing hunk semantics", () => {
  const color = (code, text) => `\u001b[${code}m${text}\u001b[m`;
  const rows = parseUnifiedDiff([
    color("1", "diff --git a/file.txt b/file.txt"),
    color("36", "@@ -1 +1 @@"),
    color("31", "-before"),
    color("32", "+after"),
  ].join("\n"));

  assert.deepEqual(rows, [
    { kind: "hunk", text: "@@ -1 +1 @@" },
    { kind: "deleted", oldLine: 1, newLine: null, text: "before" },
    { kind: "added", oldLine: null, newLine: 1, text: "after" },
  ]);
});
