import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCommitLogZ,
  parseCommitPathsRawLogZ,
  parsePorcelainV2Z,
  parseRawNumstatZ,
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

test("combined raw and numstat output preserves metadata, stats, and unusual paths", () => {
  const output = [
    ":100644 100644 aaaaaaa bbbbbbb R093", "old name.txt", "new\tname.txt",
    ":100644 100755 ccccccc ddddddd M", "2\tpath\twith tabs.txt",
    "2\t1\t", "old name.txt", "new\tname.txt",
    "4\t3\t2\tpath\twith tabs.txt",
    "",
  ].join("\0");
  assert.deepEqual(parseRawNumstatZ(output), [
    {
      path: "new\tname.txt",
      oldPath: "old name.txt",
      status: "renamed",
      score: "093",
      mode: "100644",
      oldMode: "100644",
      newMode: "100644",
      oldObjectId: "aaaaaaa",
      newObjectId: "bbbbbbb",
      executableChange: false,
      executable: false,
      oldSymlink: false,
      symlink: false,
      oldSubmodule: false,
      submodule: false,
      additions: 2,
      deletions: 1,
      binary: false,
    },
    {
      path: "2\tpath\twith tabs.txt",
      status: "modified",
      mode: "100755",
      oldMode: "100644",
      newMode: "100755",
      oldObjectId: "ccccccc",
      newObjectId: "ddddddd",
      executableChange: true,
      executable: true,
      oldSymlink: false,
      symlink: false,
      oldSubmodule: false,
      submodule: false,
      additions: 4,
      deletions: 3,
      binary: false,
    },
  ]);
});
