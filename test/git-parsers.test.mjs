import assert from "node:assert/strict";
import test from "node:test";
import { parseNameStatusZ, parseNumstatZ, parsePorcelainV2Z } from "../src/git-parsers.mjs";

test("porcelain v2 parser preserves spaces, tabs, unicode, renames, and conflicts", () => {
  const output = [
    "1 M. N... 100644 100644 100644 aaa bbb path with space.txt",
    "2 R. N... 100644 100644 100644 aaa bbb R100 renamed → file.txt",
    "old\tname.txt",
    "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt",
    "? leading - and ünicode.txt",
    "",
  ].join("\0");
  const entries = parsePorcelainV2Z(output);
  assert.equal(entries[0].path, "path with space.txt");
  assert.equal(entries[1].path, "renamed → file.txt");
  assert.equal(entries[1].oldPath, "old\tname.txt");
  assert.equal(entries[2].conflict, "UU");
  assert.equal(entries[3].path, "leading - and ünicode.txt");
});

test("name-status and numstat parse rename pairs without human-format reconstruction", () => {
  const names = parseNameStatusZ("R093\0old name.txt\0new\tname.txt\0C100\0copy from\0copy to\0M\0普通.md\0");
  assert.deepEqual(names, [
    { path: "new\tname.txt", oldPath: "old name.txt", status: "renamed", score: "093" },
    { path: "copy to", oldPath: "copy from", status: "copied", score: "100" },
    { path: "普通.md", status: "modified" },
  ]);
  const stats = parseNumstatZ("2\t1\t\0old name.txt\0new\tname.txt\0-\t-\tbinary.dat\0");
  assert.deepEqual(stats.get("new\tname.txt"), { additions: 2, deletions: 1, binary: false, oldPath: "old name.txt" });
  assert.deepEqual(stats.get("binary.dat"), { additions: 0, deletions: 0, binary: true });
});
