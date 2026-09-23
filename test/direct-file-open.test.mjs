import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openExternalFile } from "../src/direct-file-open.mjs";
import { runGit } from "../src/process.mjs";

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-direct-open-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("clean Markdown opens its worktree path directly with the system application", async (t) => {
  const root = await temporaryRoot(t);
  const source = path.join(root, "README.md");
  await fs.writeFile(source, "# Current\n");
  const resolvedSource = await fs.realpath(source);
  let invocation;
  const result = await openExternalFile({
    viewer: { client: "system", args: [], mode: "external" },
    repoRoot: root,
    filePath: "README.md",
    descriptor: { kind: "filesystem" },
    metadata: { status: "clean" },
    maxFileBytes: 1024,
    platform: "darwin",
    run: async (command, args, options) => { invocation = { command, args, options }; },
    retain: () => assert.fail("a worktree file must not be retained as a temporary copy"),
  });
  assert.equal(result.sourcePath, resolvedSource);
  assert.equal(result.retentionWarning, "");
  assert.equal(invocation.command, "open");
  assert.deepEqual(invocation.args, [resolvedSource]);
  assert.equal(invocation.options.cwd, root);
});

test("historical Markdown opens an exact read-only copy and schedules its cleanup", async (t) => {
  const root = await temporaryRoot(t);
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "README.md"), "# Committed\n");
  await runGit(root, ["add", "README.md"]);
  await runGit(root, ["commit", "-m", "base"], { env: identity });
  const commitHash = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
  await fs.writeFile(path.join(root, "README.md"), "# Worktree\n");
  let openedPath;
  let retainedDirectory;
  const result = await openExternalFile({
    viewer: { client: "system", args: ["--background"], mode: "external" },
    repoRoot: root,
    filePath: "README.md",
    descriptor: { kind: "commit", commitHash },
    metadata: { status: "modified" },
    maxFileBytes: 1024,
    platform: "linux",
    run: async (command, args) => {
      assert.equal(command, "xdg-open");
      assert.equal(args[0], "--background");
      openedPath = args[1];
      assert.equal(await fs.readFile(openedPath, "utf8"), "# Committed\n");
      assert.equal((await fs.stat(openedPath)).mode & 0o777, 0o400);
    },
    retain: (directory) => { retainedDirectory = directory; },
  });
  t.after(() => fs.rm(retainedDirectory, { recursive: true, force: true }));
  assert.equal(result.sourcePath, openedPath);
  assert.equal(retainedDirectory, path.dirname(openedPath));
  assert.match(path.basename(retainedDirectory), /^siderail-preview-/);
  assert.doesNotMatch(await fs.readFile(openedPath, "utf8"), /Worktree/);
});

test("a failed system open removes its temporary copy", async (t) => {
  const root = await temporaryRoot(t);
  await fs.writeFile(path.join(root, "README.md"), "# Demo\n");
  let attemptedPath;
  await assert.rejects(openExternalFile({
    viewer: { client: "system", args: [], mode: "external" },
    repoRoot: root,
    filePath: "README.md",
    descriptor: { kind: "filesystem" },
    metadata: { status: "clean" },
    maxFileBytes: 1024,
    temporarySource: true,
    run: async (_command, args) => { attemptedPath = args[0]; throw new Error("system open failed"); },
  }), /system open failed/);
  await assert.rejects(fs.access(path.dirname(attemptedPath)), { code: "ENOENT" });
});
