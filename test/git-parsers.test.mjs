import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCommitLogZ,
  parseCommitPathsRawLogZ,
  parseNameStatusZ,
  parseNumstatZ,
  parsePorcelainV2Z,
  parseRawDiffZ,
} from "../src/git-parsers.mjs";

test("commit machine formats preserve control characters and unambiguous paths", () => {
  const hash = "a".repeat(40);
  const nextHash = "b".repeat(40);
  const commits = parseCommitLogZ([
    hash, "aaaaaaa", "subject\x1fwith\x1erecord controls\nand a newline", "Author\x1fName", "now", "",
  ].join("\0"));
  assert.deepEqual(commits, [{
    hash,
    shortHash: "aaaaaaa",
    message: "subject\x1fwith\x1erecord controls\nand a newline",
    author: "Author\x1fName",
    age: "now",
  }]);

  const hashShapedPath = "c".repeat(40);
  const raw = [
    hash,
    "\n:100644 100644 1111111 2222222 M",
    hashShapedPath,
    ":100644 100644 1111111 2222222 M",
    "line\nbreak\tü.txt",
    nextHash,
    "\n:000000 100644 0000000 3333333 A",
    "new.txt",
    "",
  ].join("\0");
  assert.deepEqual(parseCommitPathsRawLogZ(raw), new Map([
    [hash, [hashShapedPath, "line\nbreak\tü.txt"]],
    [nextHash, ["new.txt"]],
  ]));
});

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
  assert.equal(entries[1].headMode, "100644");
  assert.equal(entries[1].indexMode, "100644");
  assert.equal(entries[1].worktreeMode, "100644");
  assert.equal(entries[2].conflict, "UU");
  assert.equal(entries[3].path, "leading - and ünicode.txt");
});

test("raw mode metadata describes the new side while retaining the old type", () => {
  const metadata = parseRawDiffZ(":120000 100644 aaaaaaa bbbbbbb T\0link-to-file\0").get("link-to-file");
  assert.equal(metadata.oldSymlink, true);
  assert.equal(metadata.symlink, false);
  assert.equal(metadata.oldSubmodule, false);
  assert.equal(metadata.submodule, false);
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
