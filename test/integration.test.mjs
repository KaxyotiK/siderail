import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFixtureRepository, removeFixtureRepository } from "../src/fixture.mjs";
import { getCommitFiles, getRepositoryState, scanDirectory } from "../src/git-provider.mjs";
import { diffArguments, loadDiff, loadRaw, loadRawBytes, safeWorktreePath } from "../src/preview-provider.mjs";
import { runCommand, runGit } from "../src/process.mjs";
import { hermeticEnvironment } from "./helpers/environment.mjs";

function repositoryState(t, root, options = {}) {
  const { environment } = hermeticEnvironment(t, options.env || {});
  return getRepositoryState(root, { ...options, env: environment });
}

async function traceGitCommands(t, run) {
  const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-command-trace-"));
  t.after(() => fs.rm(traceRoot, { recursive: true, force: true }));
  const tracePath = path.join(traceRoot, "trace.jsonl");
  await fs.writeFile(tracePath, "");
  const previous = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = tracePath;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previous;
  }
  return (await fs.readFile(tracePath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === "start" && Array.isArray(entry.argv))
    .map((entry) => entry.argv.slice(1));
}

test("fixture state is derived by the production provider", async (t) => {
  const root = await createFixtureRepository();
  t.after(() => removeFixtureRepository(root));
  const state = await repositoryState(t, root);
  assert.equal(state.branch, "feature/sidebar");
  assert.equal(state.baseRef, "main");
  assert.equal(state.againstBase.length, 2);
  assert.equal(state.staged.length, 1);
  assert.equal(state.unstaged.length, 1);
  assert.equal(state.untracked.length, 2);
  assert.equal(state.files.find((file) => file.path === "src/status.mjs").states.length, 2);
  assert.equal(state.files.find((file) => file.path === "assets/binary.dat").binary, true);
  assert.ok(state.commits[0].hash.length === 40);
  const files = await getCommitFiles(root, state.commits[0].hash);
  assert.ok(files.every((file) => file.descriptor.commitHash === state.commits[0].hash));
});

test("inspection leaves HEAD, refs, index, status, and worktree bytes unchanged", async (t) => {
  const root = await createFixtureRepository();
  t.after(() => removeFixtureRepository(root));
  const indexPath = path.join(root, ".git", "index");
  const capture = async () => ({
    head: (await runGit(root, ["rev-parse", "HEAD"])).stdout,
    refs: (await runGit(root, ["show-ref"])).stdout,
    status: (await runGit(root, ["status", "--porcelain=v2", "-z"])).stdout,
    index: await fs.readFile(indexPath),
    indexMtime: (await fs.stat(indexPath, { bigint: true })).mtimeNs,
    worktree: await Promise.all(["README.md", "src/rail.mjs", "src/status.mjs", "docs/usage.md", "docs/preview.md", "assets/binary.dat", "notes/production ready.md"]
      .map(async (file) => [file, await fs.readFile(path.join(root, file))])),
  });
  const before = await capture();
  const state = await repositoryState(t, root);
  await getCommitFiles(root, state.commits[0].hash);
  await loadRaw({ repoRoot: root, filePath: "src/status.mjs", descriptor: state.workspaceDescriptor, metadata: {}, maxFileBytes: 1024 * 1024 });
  await loadDiff({ repoRoot: root, filePath: "src/status.mjs", descriptor: state.workspaceDescriptor, maxOutputBytes: 1024 * 1024 });
  const after = await capture();
  assert.deepEqual(after, before);
});

test("refresh and commit details use one exact-copy diff scan per comparison", async (t) => {
  const root = await createFixtureRepository();
  t.after(() => removeFixtureRepository(root));
  let state;
  const refreshCommands = await traceGitCommands(t, async () => {
    state = await repositoryState(t, root);
  });
  const refreshDiffs = refreshCommands.filter(([command]) => command === "diff");
  // Base-ref discovery can take a different number of cheap rev-parse calls
  // depending on the user's configured limits; the expensive diff count is exact.
  assert.ok(refreshCommands.length <= 17);
  assert.equal(refreshDiffs.length, 4);
  for (const args of refreshDiffs) {
    assert.ok(args.includes("--raw"));
    assert.ok(args.includes("--numstat"));
    assert.ok(args.includes("--find-copies=100%"));
    assert.equal(args.filter((arg) => arg === "--find-copies-harder").length, 1);
    assert.equal(args.includes("--name-status"), false);
  }

  const commitCommands = await traceGitCommands(t, () => getCommitFiles(root, state.commits[0].hash));
  assert.equal(commitCommands.length, 2);
  const detail = commitCommands.find(([command]) => command === "diff" || command === "show");
  assert.ok(detail);
  assert.ok(detail.includes("--raw"));
  assert.ok(detail.includes("--numstat"));
  assert.ok(detail.includes("--find-copies=100%"));
  assert.equal(detail.filter((arg) => arg === "--find-copies-harder").length, 1);
  assert.equal(detail.includes("--name-status"), false);
});

test("non-repository directories provide a bounded filesystem Files state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-directory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "docs"));
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(path.join(root, "README.md"), "# Directory\n");
  await fs.writeFile(path.join(root, "docs", "guide.txt"), "guide\n");
  await fs.writeFile(path.join(root, ".git", "private"), "not a repository\n");
  await fs.symlink("README.md", path.join(root, "current"));

  const state = await repositoryState(t, root);
  assert.equal(state.repoRoot, "");
  assert.equal(state.branch, "—");
  assert.equal(state.workspaceDescriptor.kind, "filesystem");
  assert.deepEqual(state.files.map((file) => file.path), ["current", "docs/guide.txt", "README.md"]);
  assert.equal(state.files.find((file) => file.path === "current").symlink, true);
  assert.match(state.error, /No Git repository/);

  const raw = await loadRaw({
    repoRoot: root,
    filePath: "docs/guide.txt",
    descriptor: { kind: "filesystem" },
    metadata: { status: "clean" },
    maxFileBytes: 1024,
  });
  assert.equal(raw.text, "guide\n");
  assert.equal(raw.revision, "worktree");
  const diff = await loadDiff({
    repoRoot: root,
    filePath: "docs/guide.txt",
    descriptor: { kind: "filesystem" },
    maxOutputBytes: 1024,
  });
  assert.equal(diff.text, "No Git change exists for this file.");

  const limited = await scanDirectory(root, { fileLimit: 1, timeLimitMs: 10_000 });
  assert.equal(limited.entries.length, 1);
  assert.equal(limited.truncated, true);
});

test("configured bases must resolve to commits and never silently fall back", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-base-validation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "README.md"), "base\n");
  await runGit(root, ["add", "README.md"]);
  await runGit(root, ["commit", "-m", "base"], { env: identity });

  for (const requested of ["HEAD:README.md", "refs/heads/definitely-missing"]) {
    const state = await repositoryState(t, root, { env: { GIT_RAIL_BASE: requested } });
    assert.equal(state.baseRef, "");
    assert.equal(state.againstBase.length, 0);
    assert.match(state.configErrors.join("\n"), new RegExp(`does not resolve to a commit: ${requested.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
});

test("a configured base with unrelated history never masquerades as a merge base", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-unrelated-base-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "README.md"), "main\n");
  await runGit(root, ["add", "README.md"]);
  await runGit(root, ["commit", "-m", "main root"], { env: identity });
  const emptyTree = (await runGit(root, ["mktree"], { stdinInput: "" })).stdout.trim();
  const unrelatedCommit = (await runGit(root, ["commit-tree", emptyTree, "-m", "unrelated root"], { env: identity })).stdout.trim();
  await runGit(root, ["update-ref", "refs/heads/unrelated", unrelatedCommit]);

  const state = await repositoryState(t, root, { env: { GIT_RAIL_BASE: "unrelated" } });
  assert.equal(state.baseRef, "unrelated");
  assert.equal(state.workspaceDescriptor, null);
  assert.deepEqual(state.workspaceChanges, []);
  assert.deepEqual(state.againstBase, []);
  assert.match(state.error, /has no merge base with HEAD: unrelated/);
});

test("invalid UTF-8 in display-only commit metadata does not hide repository state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-commit-metadata-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "README.md"), "base\n");
  await runGit(root, ["add", "README.md"]);
  await runGit(root, ["commit", "-m", "base"], { env: identity });
  await runGit(root, ["switch", "-c", "feature"]);
  await fs.writeFile(path.join(root, "README.md"), "feature\n");
  await runGit(root, ["add", "README.md"]);
  const tree = (await runGit(root, ["write-tree"])).stdout.trim();
  const parent = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
  const commit = (await runGit(root, ["commit-tree", tree, "-p", parent], {
    env: identity,
    stdinInput: Buffer.from([0x80, 0x0a]),
  })).stdout.trim();
  await runGit(root, ["update-ref", "HEAD", commit]);

  const state = await repositoryState(t, root, { env: { GIT_RAIL_BASE: "main" } });
  assert.equal(state.commits.length, 1);
  assert.equal(state.commits[0].hash, commit);
  assert.notEqual(state.commits[0].message, "");
  assert.equal(state.workspaceChanges[0].path, "README.md");
});

test("non-UTF-8 Git paths fail visibly instead of collapsing identities", { skip: process.platform !== "linux" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-non-utf8-paths-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  const absolutePrefix = Buffer.from(`${root}${path.sep}`);
  await fs.writeFile(Buffer.concat([absolutePrefix, Buffer.from([0x80]), Buffer.from(".txt")]), "first\n");
  await fs.writeFile(Buffer.concat([absolutePrefix, Buffer.from([0x81]), Buffer.from(".txt")]), "second\n");
  await runGit(root, ["add", "-A"]);
  await runGit(root, ["commit", "-m", "non UTF-8 paths"], { env: identity });
  await assert.rejects(repositoryState(t, root), /git stdout was not valid UTF-8/);
});

test("Against Raw uses the same merge base as its diff after branches diverge", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-against-merge-base-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "gone.txt"), "merge-base v1\n");
  await runGit(root, ["add", "gone.txt"]);
  await runGit(root, ["commit", "-m", "base"], { env: identity });
  const mergeBase = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
  await runGit(root, ["switch", "-c", "feature/delete"]);
  await fs.rm(path.join(root, "gone.txt"));
  await runGit(root, ["commit", "-am", "delete on feature"], { env: identity });
  await runGit(root, ["switch", "main"]);
  await fs.writeFile(path.join(root, "gone.txt"), "main-tip v2 NEVER ON FEATURE\n");
  await runGit(root, ["commit", "-am", "advance main"], { env: identity });
  await runGit(root, ["switch", "feature/delete"]);

  const state = await repositoryState(t, root);
  const deleted = state.againstBase.find((file) => file.path === "gone.txt");
  assert.equal(deleted.descriptor.mergeBase, mergeBase);
  const diff = await loadDiff({ repoRoot: root, filePath: deleted.path, descriptor: deleted.descriptor, metadata: deleted, maxOutputBytes: 1024 * 1024 });
  assert.match(diff.text, /merge-base v1/);
  assert.doesNotMatch(diff.text, /NEVER ON FEATURE/);
  const raw = await loadRaw({ repoRoot: root, filePath: deleted.path, descriptor: deleted.descriptor, metadata: deleted, maxFileBytes: 1024 * 1024 });
  assert.equal(raw.text, "merge-base v1\n");
  assert.equal(raw.revision, `${mergeBase}:gone.txt`);
});

test("staged copy identity and colon-prefixed index paths remain exact", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-staged-identity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "source.txt"), "copy me\n");
  await fs.writeFile(path.join(root, "foo"), "WRONG ordinary foo\n");
  await runGit(root, ["add", "source.txt", "foo"]);
  await runGit(root, ["commit", "-m", "base"], { env: identity });
  await fs.copyFile(path.join(root, "source.txt"), path.join(root, "copy.txt"));
  await fs.writeFile(path.join(root, "0:foo"), "RIGHT colon file\n");
  await runGit(root, ["add", "copy.txt", "0:foo"]);

  const state = await repositoryState(t, root);
  const copy = state.staged.find((file) => file.path === "copy.txt");
  assert.equal(copy.status, "copied");
  assert.equal(copy.oldPath, "source.txt");
  assert.equal(copy.score, "100");
  const colon = state.staged.find((file) => file.path === "0:foo");
  const raw = await loadRaw({ repoRoot: root, filePath: colon.path, descriptor: colon.descriptor, metadata: colon, maxFileBytes: 1024 });
  assert.equal(raw.text, "RIGHT colon file\n");
});

test("exact-revision materialization preserves bounded binary bytes for viewers", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-binary-materialization-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "--initial-branch=main"]);
  const expected = Buffer.from([0, 1, 2, 3, 255]);
  await fs.writeFile(path.join(root, "image.bin"), expected);
  await runGit(root, ["add", "image.bin"]);
  const options = { repoRoot: root, filePath: "image.bin", descriptor: { kind: "staged" }, metadata: { status: "added", binary: true }, maxFileBytes: 1024 };
  await assert.rejects(() => loadRaw(options), /Binary file/);
  const materialized = await loadRawBytes(options);
  assert.deepEqual(materialized.bytes, expected);
  assert.equal(materialized.revision, "index:image.bin");
});

test("staged, unstaged, against, commit, untracked, and clean descriptors are independent", async (t) => {
  const root = await createFixtureRepository();
  t.after(() => removeFixtureRepository(root));
  const state = await repositoryState(t, root);
  const options = { repoRoot: root, maxOutputBytes: 1024 * 1024 };
  const staged = await loadDiff({ ...options, filePath: "src/status.mjs", descriptor: { kind: "staged" } });
  const unstaged = await loadDiff({ ...options, filePath: "src/status.mjs", descriptor: { kind: "unstaged" } });
  const workspace = await loadDiff({ ...options, filePath: "src/status.mjs", descriptor: state.workspaceDescriptor });
  assert.match(staged.text, /staged/);
  assert.doesNotMatch(staged.text, /partially-staged/);
  assert.match(unstaged.text, /partially-staged/);
  assert.match(workspace.text, /partially-staged/);
  assert.match(workspace.text, /nul-delimited/);
  assert.doesNotMatch(workspace.text, /status = 'staged'/);
  const against = await loadDiff({ ...options, filePath: "src/rail.mjs", descriptor: { kind: "against", baseRef: "main" } });
  assert.match(against.text, /staged.*unstaged/s);
  const commit = await loadDiff({ ...options, filePath: "src/rail.mjs", descriptor: { kind: "commit", commitHash: state.commits[0].hash } });
  assert.match(commit.text, /descriptor-aware rail|staged.*unstaged/s);
  const untracked = await loadDiff({ ...options, filePath: "notes/production ready.md", descriptor: { kind: "untracked" } });
  assert.match(untracked.text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ""), /\+This untracked file is rendered from disk/);
  const clean = await loadDiff({ ...options, filePath: "README.md", descriptor: { kind: "clean" } });
  assert.equal(clean.text, "No change exists for this file.");
});

test("raw preview identifies revisions and rejects escaping symlinks", async (t) => {
  const root = await createFixtureRepository();
  t.after(() => removeFixtureRepository(root));
  const raw = await loadRaw({ repoRoot: root, filePath: "README.md", descriptor: { kind: "clean" }, maxFileBytes: 1024 * 1024 });
  assert.equal(raw.revision, "worktree");
  assert.match(raw.text, /GitRail fixture/);
  const outside = path.join(path.dirname(root), "outside-secret.txt");
  await fs.writeFile(outside, "secret");
  t.after(() => fs.rm(outside, { force: true }));
  await fs.symlink(outside, path.join(root, "escape.txt"));
  await assert.rejects(() => safeWorktreePath(root, "escape.txt"), /symlink outside/);
  await fs.symlink(path.join(path.dirname(root), "missing-outside.txt"), path.join(root, "dangling.txt"));
  await assert.rejects(() => safeWorktreePath(root, "dangling.txt"), /dangling symlink/);
});

test("missing worktree content never falls back unless the selected state is deleted", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-missing-raw-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "file.txt"), "HEAD content\n");
  await runGit(root, ["add", "file.txt"]);
  await runGit(root, ["commit", "-m", "base"], { env: identity });
  await fs.rm(path.join(root, "file.txt"));

  for (const [descriptor, metadata] of [
    [{ kind: "clean" }, { status: "clean" }],
    [{ kind: "untracked" }, { status: "added" }],
    [{ kind: "unstaged" }, { status: "modified" }],
    [{ kind: "workspace", baseRef: "main", mergeBase: "main" }, { status: "modified" }],
  ]) {
    await assert.rejects(
      () => loadRaw({ repoRoot: root, filePath: "file.txt", descriptor, metadata, maxFileBytes: 1024 }),
      /ENOENT|no such file/i,
    );
  }

  const deleted = await loadRaw({
    repoRoot: root,
    filePath: "file.txt",
    descriptor: { kind: "workspace", baseRef: "main", mergeBase: "main" },
    metadata: { status: "deleted" },
    maxFileBytes: 1024,
  });
  assert.equal(deleted.text, "HEAD content\n");
  assert.equal(deleted.revision, "main:file.txt");
});

test("provider handles unborn and detached repositories plus unusual renamed paths", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-matrix-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "--initial-branch=trunk"]);
  const unborn = await repositoryState(t, root);
  assert.equal(unborn.branch, "trunk");
  assert.equal(unborn.baseRef, "");
  const oldPath = " leading - tab\tand ünicode.txt";
  const newPath = "renamed → path.txt";
  await fs.writeFile(path.join(root, oldPath), "one\ntwo\n");
  await runGit(root, ["add", "--", oldPath]);
  await runGit(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "seed"]);
  await runGit(root, ["mv", "--", oldPath, newPath]);
  const renamed = await repositoryState(t, root);
  assert.equal(renamed.staged[0].status, "renamed");
  assert.equal(renamed.staged[0].oldPath, oldPath);
  await runGit(root, ["commit", "-m", "rename"], { env: { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
  await runGit(root, ["switch", "--detach"]);
  const detached = await repositoryState(t, root);
  assert.match(detached.branch, /^detached [0-9a-f]+$/);
});

test("rename pathspecs preserve identity in every diff scope", () => {
  const metadata = { oldPath: "old name.txt", status: "renamed" };
  const paths = (args) => args.slice(args.indexOf("--") + 1);
  assert.deepEqual(paths(diffArguments({ kind: "against", baseRef: "main" }, "new name.txt", metadata)), ["old name.txt", "new name.txt"]);
  assert.deepEqual(paths(diffArguments({ kind: "workspace", baseRef: "main", mergeBase: "base" }, "new name.txt", metadata)), ["old name.txt", "new name.txt"]);
  assert.deepEqual(paths(diffArguments({ kind: "commit", commitHash: "commit", parentHash: "parent" }, "new name.txt", metadata)), ["old name.txt", "new name.txt"]);
  assert.deepEqual(paths(diffArguments({ kind: "staged" }, "new name.txt", metadata)), ["old name.txt", "new name.txt"]);
  assert.deepEqual(paths(diffArguments({ kind: "unstaged" }, "new name.txt", metadata)), ["old name.txt", "new name.txt"]);
});

test("rename and copy previews retain Git identity across against, workspace, commit, and staged views", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-preview-identity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "rename-old.txt"), "rename identity\n");
  await fs.writeFile(path.join(root, "copy-source.txt"), "copy identity\n");
  await fs.writeFile(path.join(root, "staged-old.txt"), "staged identity\n");
  await runGit(root, ["add", "--all"]);
  await runGit(root, ["commit", "-m", "base"], { env: identity });
  await runGit(root, ["switch", "-c", "feature/identity"]);
  await runGit(root, ["mv", "rename-old.txt", "rename-new.txt"]);
  await fs.copyFile(path.join(root, "copy-source.txt"), path.join(root, "copy-target.txt"));
  await runGit(root, ["add", "--all"]);
  await runGit(root, ["commit", "-m", "rename and copy"], { env: identity });
  await runGit(root, ["mv", "staged-old.txt", "staged-new.txt"]);

  const state = await repositoryState(t, root);
  const options = { repoRoot: root, maxOutputBytes: 1024 * 1024 };
  const againstRename = state.againstBase.find((file) => file.path === "rename-new.txt");
  const againstCopy = state.againstBase.find((file) => file.path === "copy-target.txt");
  assert.equal(againstRename.oldPath, "rename-old.txt");
  assert.equal(againstCopy.oldPath, "copy-source.txt");
  for (const file of [againstRename, againstCopy]) {
    const preview = await loadDiff({ ...options, filePath: file.path, descriptor: file.descriptor, metadata: file });
    assert.match(preview.text, file.status === "renamed" ? /rename from rename-old\.txt[\s\S]*rename to rename-new\.txt/ : /copy from copy-source\.txt[\s\S]*copy to copy-target\.txt/);
  }
  const workspaceRename = state.workspaceChanges.find((file) => file.path === "rename-new.txt");
  assert.match((await loadDiff({ ...options, filePath: workspaceRename.path, descriptor: workspaceRename.descriptor, metadata: workspaceRename })).text, /rename from rename-old\.txt/);
  const commitFiles = await getCommitFiles(root, state.commits[0].hash);
  const commitRename = commitFiles.find((file) => file.path === "rename-new.txt");
  assert.match((await loadDiff({ ...options, filePath: commitRename.path, descriptor: commitRename.descriptor, metadata: commitRename })).text, /rename from rename-old\.txt/);
  const stagedRename = state.staged.find((file) => file.path === "staged-new.txt");
  assert.match((await loadDiff({ ...options, filePath: stagedRename.path, descriptor: stagedRename.descriptor, metadata: stagedRename })).text, /rename from staged-old\.txt/);
});

test("commit history and file details use one explicit first-parent comparison", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-first-parent-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "base.txt"), "base\n");
  await runGit(root, ["add", "base.txt"]);
  await runGit(root, ["commit", "-m", "base"], { env: identity });
  await runGit(root, ["switch", "-c", "side"]);
  await fs.writeFile(path.join(root, "from-side.txt"), "side\n");
  await runGit(root, ["add", "from-side.txt"]);
  await runGit(root, ["commit", "-m", "side subject \x1f \x1e stays intact"], { env: identity });
  await runGit(root, ["switch", "main"]);
  await fs.writeFile(path.join(root, "from-main.txt"), "main\n");
  await runGit(root, ["add", "from-main.txt"]);
  await runGit(root, ["commit", "-m", "main advance"], { env: identity });
  const firstParent = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
  await runGit(root, ["switch", "-c", "review"]);
  await runGit(root, ["merge", "--no-ff", "side", "-m", "merge subject \x1f \x1e remains one record"], { env: identity });
  const mergeHash = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();

  const state = await repositoryState(t, root);
  assert.equal(state.totalCommits, 1);
  assert.equal(state.commits[0].hash, mergeHash);
  assert.equal(state.commits[0].message, "merge subject \x1f \x1e remains one record");
  assert.deepEqual(state.commitPathIndex.get(mergeHash), ["from-side.txt"]);
  const files = await getCommitFiles(root, mergeHash);
  assert.deepEqual(files.map((file) => file.path), ["from-side.txt"]);
  assert.equal(files[0].descriptor.parentHash, firstParent);
  assert.equal(files[0].descriptor.comparison, "first-parent");
  const preview = await loadDiff({ repoRoot: root, filePath: "from-side.txt", descriptor: files[0].descriptor, metadata: files[0], maxOutputBytes: 1024 * 1024 });
  assert.match(preview.text, /side/);
  assert.match(preview.revision, /first parent/);
});

test("untracked text line counts match Git numstat semantics", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-untracked-lines-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "tracked.txt"), "tracked\n");
  await runGit(root, ["add", "tracked.txt"]);
  await runGit(root, ["commit", "-m", "base"], { env: identity });
  await fs.writeFile(path.join(root, "empty.txt"), "");
  await fs.writeFile(path.join(root, "terminated.txt"), "one\n");
  await fs.writeFile(path.join(root, "unterminated.txt"), "one");
  await fs.writeFile(path.join(root, "mixed.txt"), "one\ntwo");
  await fs.symlink("../outside-target", path.join(root, "link.txt"));
  const state = await repositoryState(t, root);
  const counts = new Map(state.untracked.map((file) => [file.path, file.additions]));
  assert.equal(counts.get("empty.txt"), 0);
  assert.equal(counts.get("terminated.txt"), 1);
  assert.equal(counts.get("unterminated.txt"), 1);
  assert.equal(counts.get("mixed.txt"), 2);
  assert.equal(counts.get("link.txt"), 1);
  const link = state.untracked.find((file) => file.path === "link.txt");
  assert.equal(link.symlink, true);
  const raw = await loadRaw({ repoRoot: root, filePath: link.path, descriptor: link.descriptor, metadata: link, maxFileBytes: 1024 });
  assert.equal(raw.text, "../outside-target");
  assert.equal(raw.revision, "worktree");
  const diff = await loadDiff({ repoRoot: root, filePath: link.path, descriptor: link.descriptor, metadata: link, maxOutputBytes: 1024 });
  assert.match(diff.text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ""), /\+\.\.\/outside-target/);
});

test("untracked statistics stop at an aggregate inspection budget", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-untracked-budget-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "--initial-branch=main"]);
  await Promise.all(Array.from({ length: 260 }, (_, index) => fs.writeFile(path.join(root, `file-${String(index).padStart(3, "0")}.txt`), "")));
  const state = await repositoryState(t, root);
  assert.equal(state.untracked.length, 260);
  assert.equal(state.untrackedStatsLimited, true);
  assert.ok(state.untracked.filter((file) => file.statsUnavailable).length >= 4);
});

test("clean tracked files retain symlink and executable metadata", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-clean-modes-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "target.txt"), "target\n");
  await fs.writeFile(path.join(root, "tool.sh"), "#!/bin/sh\n", { mode: 0o755 });
  await fs.symlink("target.txt", path.join(root, "link"));
  await runGit(root, ["add", "--all"]);
  await runGit(root, ["commit", "-m", "modes"], { env: identity });
  const state = await repositoryState(t, root);
  const files = new Map(state.files.map((file) => [file.path, file]));
  assert.equal(files.get("link").clean, true);
  assert.equal(files.get("link").symlink, true);
  assert.equal(files.get("tool.sh").clean, true);
  assert.equal(files.get("tool.sh").executable, true);
  assert.equal((await loadRaw({ repoRoot: root, filePath: "link", descriptor: { kind: "clean" }, metadata: files.get("link"), maxFileBytes: 1024 })).text, "target.txt");
});

test("unstaged type changes use worktree mode rather than index mode", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-type-mode-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "target.txt"), "target\n");
  await fs.symlink("target.txt", path.join(root, "value"));
  await fs.writeFile(path.join(root, "other"), "regular in index\n");
  await runGit(root, ["add", "--all"]);
  await runGit(root, ["commit", "-m", "types"], { env: identity });
  await fs.unlink(path.join(root, "value"));
  await fs.writeFile(path.join(root, "value"), "regular in worktree\n");
  await fs.unlink(path.join(root, "other"));
  await fs.symlink("target.txt", path.join(root, "other"));
  const state = await repositoryState(t, root);
  const regular = state.unstaged.find((file) => file.path === "value");
  const symlink = state.unstaged.find((file) => file.path === "other");
  assert.equal(regular.status, "type-changed");
  assert.equal(regular.oldSymlink, true);
  assert.equal(regular.symlink, false);
  assert.equal(regular.mode, "100644");
  assert.equal((await loadRaw({ repoRoot: root, filePath: regular.path, descriptor: regular.descriptor, metadata: regular, maxFileBytes: 1024 })).text, "regular in worktree\n");
  assert.equal(symlink.oldSymlink, false);
  assert.equal(symlink.symlink, true);
  assert.equal(symlink.mode, "120000");
  assert.equal((await loadRaw({ repoRoot: root, filePath: symlink.path, descriptor: symlink.descriptor, metadata: symlink, maxFileBytes: 1024 })).text, "target.txt");
});

test("against-base model retains deletion, rename, copy, executable, and symlink metadata", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-statuses-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "delete.txt"), "delete me\n");
  await fs.writeFile(path.join(root, "rename-old.txt"), "rename me\n");
  await fs.writeFile(path.join(root, "copy-source.txt"), "copy me exactly\n");
  await fs.writeFile(path.join(root, "tool.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  await runGit(root, ["add", "--all"]);
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["commit", "-m", "base"], { env: identity });
  await runGit(root, ["switch", "-c", "feature/statuses"]);
  await fs.rm(path.join(root, "delete.txt"));
  await runGit(root, ["mv", "rename-old.txt", "rename-new.txt"]);
  await fs.copyFile(path.join(root, "copy-source.txt"), path.join(root, "copy-target.txt"));
  await fs.chmod(path.join(root, "tool.sh"), 0o755);
  await fs.symlink("copy-source.txt", path.join(root, "source-link"));
  await runGit(root, ["add", "--all"]);
  await runGit(root, ["commit", "-m", "exercise statuses"], { env: identity });
  const state = await repositoryState(t, root);
  const statuses = new Map(state.againstBase.map((file) => [file.path, file]));
  assert.equal(statuses.get("delete.txt").status, "deleted");
  assert.equal(statuses.get("rename-new.txt").status, "renamed");
  assert.equal(statuses.get("rename-new.txt").oldPath, "rename-old.txt");
  assert.equal(statuses.get("copy-target.txt").status, "copied");
  assert.equal(statuses.get("copy-target.txt").oldPath, "copy-source.txt");
  assert.equal(statuses.get("tool.sh").status, "modified");
  assert.equal(statuses.get("tool.sh").executableChange, true);
  assert.equal(statuses.get("source-link").status, "added");
  assert.equal(statuses.get("source-link").symlink, true);
  const symlinkRaw = await loadRaw({
    repoRoot: root,
    filePath: "source-link",
    descriptor: state.workspaceDescriptor,
    metadata: statuses.get("source-link"),
    maxFileBytes: 1024,
  });
  assert.equal(symlinkRaw.text, "copy-source.txt");
  assert.equal(symlinkRaw.revision, "worktree");
});

test("unmerged porcelain state remains an explicit conflict in both scopes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-conflict-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "conflict.txt"), "base\n");
  await runGit(root, ["add", "conflict.txt"]);
  await runGit(root, ["commit", "-m", "base"], { env: identity });
  await runGit(root, ["switch", "-c", "side"]);
  await fs.writeFile(path.join(root, "conflict.txt"), "side\n");
  await runGit(root, ["commit", "-am", "side"], { env: identity });
  await runGit(root, ["switch", "main"]);
  await fs.writeFile(path.join(root, "conflict.txt"), "main\n");
  await runGit(root, ["commit", "-am", "main"], { env: identity });
  await runGit(root, ["merge", "side"], { env: identity, allowExitCodes: [0, 1] });
  const state = await repositoryState(t, root);
  assert.equal(state.staged.find((file) => file.path === "conflict.txt").status, "conflicted");
  assert.equal(state.unstaged.find((file) => file.path === "conflict.txt").status, "conflicted");
  assert.equal(state.files.find((file) => file.path === "conflict.txt").conflict, true);
});

test("raw content limits fail safely before reading unbounded data", async (t) => {
  const root = await createFixtureRepository();
  t.after(() => removeFixtureRepository(root));
  await fs.writeFile(path.join(root, "large.txt"), "x".repeat(4096));
  await assert.rejects(
    () => loadRaw({ repoRoot: root, filePath: "large.txt", descriptor: { kind: "untracked" }, maxFileBytes: 1024 }),
    /preview limit/,
  );
  await fs.writeFile(path.join(root, "invalid-utf8.txt"), Buffer.from([0x66, 0x80, 0x6f]));
  await assert.rejects(
    () => loadRaw({ repoRoot: root, filePath: "invalid-utf8.txt", descriptor: { kind: "untracked" }, maxFileBytes: 1024 }),
    /not valid UTF-8/,
  );
});

test("historical and index blobs receive bounded binary and UTF-8 validation without fallback", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-blob-validation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  for (const name of ["binary.dat", "invalid.txt", "large.txt", "deleted.txt"]) await fs.writeFile(path.join(root, name), "base text\n");
  await runGit(root, ["add", "--all"]);
  await runGit(root, ["commit", "-m", "base"], { env: identity });
  await runGit(root, ["switch", "-c", "feature/blobs"]);
  await fs.writeFile(path.join(root, "binary.dat"), Buffer.from([0x61, 0x00, 0x62]));
  await fs.writeFile(path.join(root, "invalid.txt"), Buffer.from([0x66, 0x80, 0x6f]));
  await fs.writeFile(path.join(root, "large.txt"), "x".repeat(4096));
  await fs.rm(path.join(root, "deleted.txt"));
  await runGit(root, ["add", "--all"]);
  await runGit(root, ["commit", "-m", "hostile blobs"], { env: identity });
  const state = await repositoryState(t, root);
  const files = new Map(state.againstBase.map((file) => [file.path, file]));
  await assert.rejects(
    () => loadRaw({ repoRoot: root, filePath: "binary.dat", descriptor: files.get("binary.dat").descriptor, metadata: files.get("binary.dat"), maxFileBytes: 1024 }),
    /Binary file/,
  );
  await assert.rejects(
    () => loadRaw({ repoRoot: root, filePath: "invalid.txt", descriptor: files.get("invalid.txt").descriptor, metadata: files.get("invalid.txt"), maxFileBytes: 1024 }),
    /not valid UTF-8/,
  );
  await assert.rejects(
    () => loadRaw({ repoRoot: root, filePath: "large.txt", descriptor: files.get("large.txt").descriptor, metadata: files.get("large.txt"), maxFileBytes: 1024 }),
    /exceeded 1024 bytes/,
  );
  const deleted = await loadRaw({ repoRoot: root, filePath: "deleted.txt", descriptor: files.get("deleted.txt").descriptor, metadata: files.get("deleted.txt"), maxFileBytes: 1024 });
  assert.equal(deleted.text, "base text\n");
  assert.match(deleted.revision, /^[0-9a-f]{40}:deleted\.txt$/);

  await fs.writeFile(path.join(root, "invalid-index.txt"), "valid worktree\n");
  await runGit(root, ["add", "invalid-index.txt"]);
  await fs.writeFile(path.join(root, "invalid-index.txt"), Buffer.from([0x66, 0x80, 0x6f]));
  await runGit(root, ["add", "invalid-index.txt"]);
  await assert.rejects(
    () => loadRaw({ repoRoot: root, filePath: "invalid-index.txt", descriptor: { kind: "staged" }, metadata: { status: "added" }, maxFileBytes: 1024 }),
    /not valid UTF-8/,
  );
});

test("non-regular worktree entries are rejected without opening a blocking stream", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-fifo-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "--initial-branch=main"]);
  await runCommand("mkfifo", [path.join(root, "pipe")]);
  await assert.rejects(
    () => loadRaw({ repoRoot: root, filePath: "pipe", descriptor: { kind: "untracked" }, maxFileBytes: 1024 }),
    /Only regular files/,
  );
  await assert.rejects(
    () => loadDiff({ repoRoot: root, filePath: "pipe", descriptor: { kind: "untracked" }, maxOutputBytes: 1024 }),
    /Only regular files and symbolic links/,
  );
});

test("commit history is bounded while retaining an exact total", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-history-limit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await runGit(root, ["config", "gc.auto", "0"]);
  await fs.writeFile(path.join(root, "seed"), "seed\n");
  await runGit(root, ["add", "seed"]);
  await runGit(root, ["commit", "-m", "seed"], { env: identity });
  await runGit(root, ["switch", "-c", "feature/history"]);
  for (let index = 0; index < 205; index += 1) {
    await runGit(root, ["commit", "--allow-empty", "-m", `history ${index}`], { env: identity });
  }
  const state = await repositoryState(t, root);
  assert.equal(state.totalCommits, 205);
  assert.equal(state.commits.length, 200);
  assert.equal(state.historyLimit, 200);
  assert.equal(state.historyTruncated, true);
  assert.equal(state.historyPathsAvailable, true);
  assert.equal(state.commitPathIndex.size, 200);
});

test("submodule gitlinks remain first-class canonical metadata", async (t) => {
  const container = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-submodule-"));
  t.after(() => fs.rm(container, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const sub = path.join(container, "source");
  await fs.mkdir(sub);
  await runGit(sub, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(sub, "value.txt"), "one\n");
  await runGit(sub, ["add", "value.txt"]);
  await runGit(sub, ["commit", "-m", "one"], { env: identity });
  const first = (await runGit(sub, ["rev-parse", "HEAD"])).stdout.trim();
  await fs.writeFile(path.join(sub, "value.txt"), "two\n");
  await runGit(sub, ["commit", "-am", "two"], { env: identity });
  const second = (await runGit(sub, ["rev-parse", "HEAD"])).stdout.trim();

  const root = path.join(container, "parent");
  await fs.mkdir(root);
  await runGit(root, ["init", "--initial-branch=main"]);
  await runGit(root, ["-c", "protocol.file.allow=always", "submodule", "add", sub, "deps/sample"]);
  await runGit(path.join(root, "deps/sample"), ["checkout", first]);
  await runGit(root, ["add", "--all"]);
  await runGit(root, ["commit", "-m", "base submodule"], { env: identity });
  const cleanState = await repositoryState(t, root);
  const cleanSubmodule = cleanState.files.find((file) => file.path === "deps/sample");
  assert.equal(cleanSubmodule.clean, true);
  assert.equal(cleanSubmodule.submodule, true);
  await runGit(root, ["switch", "-c", "feature/submodule"]);
  await runGit(path.join(root, "deps/sample"), ["checkout", second]);
  await runGit(root, ["add", "deps/sample"]);
  await runGit(root, ["commit", "-m", "advance submodule"], { env: identity });
  const state = await repositoryState(t, root);
  const submodule = state.againstBase.find((file) => file.path === "deps/sample");
  assert.equal(submodule.submodule, true);
  assert.equal(state.files.find((file) => file.path === "deps/sample").submodule, true);
  const raw = await loadRaw({
    repoRoot: root,
    filePath: submodule.path,
    descriptor: submodule.descriptor,
    metadata: submodule,
    maxFileBytes: 1024 * 1024,
  });
  assert.equal(raw.text, `Submodule commit ${second}\n`);
  assert.equal(raw.revision, "HEAD:deps/sample");
  await runGit(root, ["submodule", "deinit", "-f", "deps/sample"]);
  const uninitializedRaw = await loadRaw({
    repoRoot: root,
    filePath: submodule.path,
    descriptor: state.workspaceDescriptor,
    metadata: submodule,
    maxFileBytes: 1024 * 1024,
  });
  assert.equal(uninitializedRaw.text, `Submodule commit ${second}\n`);
  assert.equal(uninitializedRaw.revision, "index:deps/sample");
});
