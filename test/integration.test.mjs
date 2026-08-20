import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFixtureRepository, removeFixtureRepository } from "../src/fixture.mjs";
import { getCommitFiles, getRepositoryState } from "../src/git-provider.mjs";
import { loadDiff, loadRaw, safeWorktreePath } from "../src/preview-provider.mjs";
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

test("staged, unstaged, against, commit, untracked, and clean descriptors are independent", async (t) => {
  const root = await createFixtureRepository();
  t.after(() => removeFixtureRepository(root));
  const state = await getRepositoryState(root);
  const options = { repoRoot: root, maxOutputBytes: 1024 * 1024 };
  const staged = await loadDiff({ ...options, filePath: "src/status.mjs", descriptor: { kind: "staged" } });
  const unstaged = await loadDiff({ ...options, filePath: "src/status.mjs", descriptor: { kind: "unstaged" } });
  assert.match(staged.text, /staged/);
  assert.doesNotMatch(staged.text, /partially-staged/);
  assert.match(unstaged.text, /partially-staged/);
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
});
