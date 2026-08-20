import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFixtureRepository, removeFixtureRepository } from "../src/fixture.mjs";
import { getCommitFiles, getRepositoryState } from "../src/git-provider.mjs";
import { diffArguments, loadDiff, loadRaw, safeWorktreePath } from "../src/preview-provider.mjs";
import { runGit } from "../src/process.mjs";

test("fixture state is derived by the production provider", async (t) => {
  const root = await createFixtureRepository();
  t.after(() => removeFixtureRepository(root));
  const state = await getRepositoryState(root);
  assert.equal(state.branch, "feature/sidebar");
  assert.equal(state.baseRef, "main");
  assert.equal(state.againstBase.length, 2);
  assert.equal(state.staged.length, 1);
  assert.equal(state.unstaged.length, 3);
  assert.equal(state.files.find((file) => file.path === "src/status.mjs").states.length, 2);
  assert.equal(state.files.find((file) => file.path === "assets/binary.dat").binary, true);
  assert.ok(state.commits[0].hash.length === 40);
  const files = await getCommitFiles(root, state.commits[0].hash);
  assert.ok(files.every((file) => file.descriptor.commitHash === state.commits[0].hash));
});

test("read-only refresh does not rewrite the Git index", async (t) => {
  const root = await createFixtureRepository();
  t.after(() => removeFixtureRepository(root));
  const indexPath = path.join(root, ".git", "index");
  const before = await fs.stat(indexPath, { bigint: true });
  await getRepositoryState(root);
  const after = await fs.stat(indexPath, { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs);
});

test("staged, unstaged, against, commit, untracked, and clean descriptors are independent", async (t) => {
  const root = await createFixtureRepository();
  t.after(() => removeFixtureRepository(root));
  const state = await getRepositoryState(root);
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
});

test("provider handles unborn and detached repositories plus unusual renamed paths", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-matrix-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "--initial-branch=trunk"]);
  const unborn = await getRepositoryState(root);
  assert.equal(unborn.branch, "trunk");
  assert.equal(unborn.baseRef, "");
  const oldPath = " leading - tab\tand ünicode.txt";
  const newPath = "renamed → path.txt";
  await fs.writeFile(path.join(root, oldPath), "one\ntwo\n");
  await runGit(root, ["add", "--", oldPath]);
  await runGit(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "seed"]);
  await runGit(root, ["mv", "--", oldPath, newPath]);
  const renamed = await getRepositoryState(root);
  assert.equal(renamed.staged[0].status, "renamed");
  assert.equal(renamed.staged[0].oldPath, oldPath);
  await runGit(root, ["commit", "-m", "rename"], { env: { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
  await runGit(root, ["switch", "--detach"]);
  const detached = await getRepositoryState(root);
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

  const state = await getRepositoryState(root);
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

  const state = await getRepositoryState(root);
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
  const state = await getRepositoryState(root);
  const counts = new Map(state.unstaged.map((file) => [file.path, file.additions]));
  assert.equal(counts.get("empty.txt"), 0);
  assert.equal(counts.get("terminated.txt"), 1);
  assert.equal(counts.get("unterminated.txt"), 1);
  assert.equal(counts.get("mixed.txt"), 2);
  assert.equal(counts.get("link.txt"), 1);
  const link = state.unstaged.find((file) => file.path === "link.txt");
  assert.equal(link.symlink, true);
  const raw = await loadRaw({ repoRoot: root, filePath: link.path, descriptor: link.descriptor, metadata: link, maxFileBytes: 1024 });
  assert.equal(raw.text, "../outside-target");
  assert.equal(raw.revision, "worktree");
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
  const state = await getRepositoryState(root);
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
  const state = await getRepositoryState(root);
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
  await runGit(root, ["switch", "-c", "feature/submodule"]);
  await runGit(path.join(root, "deps/sample"), ["checkout", second]);
  await runGit(root, ["add", "deps/sample"]);
  await runGit(root, ["commit", "-m", "advance submodule"], { env: identity });
  const state = await getRepositoryState(root);
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
