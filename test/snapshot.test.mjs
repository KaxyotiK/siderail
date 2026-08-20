import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { runGit } from "../src/process.mjs";

const exec = promisify(execFile);

for (const width of [25, 36, 52, 100]) {
  test(`demo snapshot is coherent at ${width} columns`, async () => {
    const { stdout } = await exec(process.execPath, ["scripts/git-rail.mjs", "--demo", "--snapshot", "--width", String(width), "--height", "32"], { maxBuffer: 2 * 1024 * 1024 });
    const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
    assert.doesNotMatch(plain, /HERDR GITRAIL/);
    assert.match(plain, /feature\/sidebar/);
    assert.match(plain, /CHANGES\s+FILES/);
    assert.doesNotMatch(plain, /CHANGES \d/);
    assert.match(plain, /Staged/);
    assert.match(plain, /Unstaged/);
    if (width === 25) {
      assert.match(plain, /status\.mjs/);
      assert.doesNotMatch(plain, /Untracked/);
    }
    assert.doesNotMatch(plain, /Read-only demo preview|const panel = "files"/);
    assert.ok(plain.split("\n").every((line) => [...line].length <= width));
  });
}

for (const width of [25, 100]) {
  test(`Files view puts repository-root files after folders at ${width} columns`, async () => {
    const { stdout } = await exec(process.execPath, ["scripts/git-rail.mjs", "--demo", "--snapshot", "--files", "--width", String(width), "--height", "40"], { maxBuffer: 2 * 1024 * 1024 });
    const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
    assert.ok(plain.indexOf("docs") < plain.indexOf("README.md"));
    assert.ok(plain.indexOf("src") < plain.indexOf("README.md"));
  });
}

test("Changes search includes commit history summaries", async () => {
  const { stdout } = await exec(process.execPath, ["scripts/git-rail.mjs", "--demo", "--snapshot", "--search", "descriptor-aware", "--width", "52", "--height", "32"], { maxBuffer: 2 * 1024 * 1024 });
  const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(plain, /1 result/);
  assert.match(plain, /Commits  1/);
  assert.match(plain, /add descriptor-aware rail/);
  assert.doesNotMatch(plain, /No changes or commits match/);
});

test("large repositories expose an explicit reachable continuation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-large-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "--initial-branch=main"]);
  await Promise.all(Array.from({ length: 250 }, (_, index) => fs.writeFile(path.join(root, `file-${String(index).padStart(3, "0")}.txt`), `${index}\n`)));
  const script = path.resolve("scripts/git-rail.mjs");
  const { stdout } = await exec(process.execPath, [script, "--snapshot", "--width", "52", "--height", "120"], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(plain, /Unstaged  250/);
  assert.match(plain, /Show 100 more\s+\(150 remaining\)/);
});
