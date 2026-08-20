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
