import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectEffectiveRuntimeSemantics,
  GitStateIdentityError,
  collectEffectiveGitEnvironment,
  computeCodeFingerprint,
  createCoordinatorIdentity,
  digestEffectiveGitEnvironment,
  digestEffectiveRuntimeSemantics,
  preparePrivateRuntimePaths,
  resolveGitExecutableIdentity,
  resolveRepositoryIdentity,
  validateOwnedRuntimeDirectory,
} from "../src/git-state-identity.mjs";
import { ProcessError, runCommand, runGit } from "../src/process.mjs";

const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.devNull,
};

test("effective Git environment is deterministic, conservative, and excludes resolved SideRail inputs", () => {
  const first = {
    PATH: "/one:/two",
    HOME: "/home/example",
    LANG: "en_US.UTF-8",
    LC_TIME: "C",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "siderail.marker",
    GIT_CONFIG_VALUE_0: "alpha",
    GIT_INDEX_FILE: "/repo/index-a",
    GIT_OPTIONAL_LOCKS: "1",
    SIDERAIL_CLIENT: "code",
    SIDERAIL_REPO_ROOT: "/selected",
  };
  const reordered = Object.fromEntries(Object.entries(first).reverse());
  assert.equal(digestEffectiveGitEnvironment(first, { platform: "darwin", uid: 501 }), digestEffectiveGitEnvironment(reordered, { platform: "darwin", uid: 501 }));

  const collected = collectEffectiveGitEnvironment(first, { platform: "darwin", uid: 501 });
  const variables = new Map(collected.variables);
  assert.equal(variables.get("GIT_OPTIONAL_LOCKS"), "0");
  assert.equal(variables.get("GIT_CONFIG_KEY_0"), "siderail.marker");
  assert.equal(variables.get("LC_TIME"), "C");
  assert.equal(variables.has("SIDERAIL_CLIENT"), false);
  assert.equal(variables.has("SIDERAIL_REPO_ROOT"), false);
  assert.equal(variables.get("XDG_CONFIG_HOME"), null);

  assert.notEqual(
    digestEffectiveGitEnvironment(first, { platform: "darwin", uid: 501 }),
    digestEffectiveGitEnvironment({ ...first, GIT_CONFIG_VALUE_0: "beta" }, { platform: "darwin", uid: 501 }),
  );
  assert.equal(
    digestEffectiveGitEnvironment(first, { platform: "darwin", uid: 501 }),
    digestEffectiveGitEnvironment({ ...first, SIDERAIL_CLIENT: "vim" }, { platform: "darwin", uid: 501 }),
  );
  assert.notEqual(
    digestEffectiveGitEnvironment(first, { platform: "darwin", uid: 501 }),
    digestEffectiveGitEnvironment({ ...first, SIDERAIL_UNKNOWN_PROVIDER_INPUT: "future" }, { platform: "darwin", uid: 501 }),
  );
});

test("Git executable identity resolves PATH to canonical file identity", async (t) => {
  const root = await fs.mkdtemp("/tmp/gri-exec-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "git");
  await fs.copyFile(process.execPath, executable);
  await fs.chmod(executable, 0o700);
  const identity = await resolveGitExecutableIdentity({
    environment: { PATH: root },
    executable: "git",
    cwd: root,
  });
  assert.equal(identity.realpath, await fs.realpath(executable));
  assert.match(identity.dev, /^\d+$/);
  assert.match(identity.ino, /^\d+$/);
  assert.match(identity.size, /^\d+$/);
  assert.match(identity.mtimeNs, /^\d+$/);
  await fs.mkdir(path.join(root, "relative-bin"));
  await fs.copyFile(process.execPath, path.join(root, "relative-bin", "git"));
  await fs.chmod(path.join(root, "relative-bin", "git"), 0o700);
  const relative = await resolveGitExecutableIdentity({
    environment: { PATH: "relative-bin" },
    executable: "git",
    cwd: root,
  });
  assert.equal(relative.realpath, await fs.realpath(path.join(root, "relative-bin", "git")));
});

test("code fingerprint covers canonical checkout path, runtime paths, and bytes", async (t) => {
  const parent = await fs.mkdtemp("/tmp/gri-code-");
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const one = path.join(parent, "one");
  const two = path.join(parent, "two");
  await fs.mkdir(one);
  await fs.mkdir(two);
  await fs.writeFile(path.join(one, "launcher.mjs"), "launch('one')\n");
  await fs.writeFile(path.join(one, "runtime.mjs"), "export const value = 1\n");
  await fs.writeFile(path.join(two, "launcher.mjs"), "launch('one')\n");
  await fs.writeFile(path.join(two, "runtime.mjs"), "export const value = 1\n");

  const first = await computeCodeFingerprint(["runtime.mjs", "launcher.mjs"], { checkoutPath: one });
  assert.equal(first, await computeCodeFingerprint(["launcher.mjs", "runtime.mjs"], { checkoutPath: one }));
  assert.notEqual(first, await computeCodeFingerprint(["launcher.mjs", "runtime.mjs"], { checkoutPath: two }));
  await fs.writeFile(path.join(one, "runtime.mjs"), "export const value = 2\n");
  assert.notEqual(first, await computeCodeFingerprint(["launcher.mjs", "runtime.mjs"], { checkoutPath: one }));
  await assert.rejects(
    computeCodeFingerprint([path.join(two, "runtime.mjs")], { checkoutPath: one }),
    (error) => error instanceof GitStateIdentityError && error.code === "RUNTIME_FILE_OUTSIDE_CHECKOUT",
  );
});

test("coordinator namespace separates user, host session, code, and Git-impact environment", async (t) => {
  const root = await fs.mkdtemp("/tmp/gri-host-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const socket = path.join(root, "herdr.sock");
  const alias = path.join(root, "alias.sock");
  await fs.writeFile(socket, "fixture");
  await fs.symlink(socket, alias);
  const codeFingerprint = "a".repeat(64);
  const providerEnvironmentId = "b".repeat(64);
  const effectiveConfigId = "e".repeat(64);
  const gitExecutableIdentity = { realpath: "/usr/bin/git", dev: "1", ino: "2", size: "3", mtimeNs: "4" };
  const base = await createCoordinatorIdentity({ hostSocketPath: socket, codeFingerprint, providerEnvironmentId, effectiveConfigId, gitExecutableIdentity, uid: 501 });
  const throughAlias = await createCoordinatorIdentity({ hostSocketPath: alias, codeFingerprint, providerEnvironmentId, effectiveConfigId, gitExecutableIdentity, uid: 501 });
  assert.equal(base.namespaceId, throughAlias.namespaceId);
  assert.notEqual(base.namespaceId, (await createCoordinatorIdentity({ hostSocketPath: socket, codeFingerprint: "c".repeat(64), providerEnvironmentId, effectiveConfigId, gitExecutableIdentity, uid: 501 })).namespaceId);
  assert.notEqual(base.namespaceId, (await createCoordinatorIdentity({ hostSocketPath: socket, codeFingerprint, providerEnvironmentId: "d".repeat(64), effectiveConfigId, gitExecutableIdentity, uid: 501 })).namespaceId);
  assert.notEqual(base.namespaceId, (await createCoordinatorIdentity({ hostSocketPath: socket, codeFingerprint, providerEnvironmentId, effectiveConfigId: "f".repeat(64), gitExecutableIdentity, uid: 501 })).namespaceId);
  assert.notEqual(base.namespaceId, (await createCoordinatorIdentity({ hostSocketPath: socket, codeFingerprint, providerEnvironmentId, effectiveConfigId, gitExecutableIdentity, uid: 502 })).namespaceId);
  assert.notEqual(base.namespaceId, (await createCoordinatorIdentity({
    hostSocketPath: socket,
    codeFingerprint,
    providerEnvironmentId,
    effectiveConfigId,
    gitExecutableIdentity: { ...gitExecutableIdentity, ino: "99" },
    uid: 501,
  })).namespaceId);
});

test("effective runtime semantics include immutable environment overrides only", () => {
  const base = collectEffectiveRuntimeSemantics({ CONFIG_FILE_CONTENT: "one" });
  const first = digestEffectiveRuntimeSemantics(base);
  assert.equal(first, digestEffectiveRuntimeSemantics(collectEffectiveRuntimeSemantics({ CONFIG_FILE_CONTENT: "two" })));
  assert.notEqual(first, digestEffectiveRuntimeSemantics(collectEffectiveRuntimeSemantics({ SIDERAIL_BASE: "release" })));
  assert.notEqual(first, digestEffectiveRuntimeSemantics(collectEffectiveRuntimeSemantics({ SIDERAIL_WATCH_MODE: "poll-only" })));
  assert.notEqual(first, digestEffectiveRuntimeSemantics(collectEffectiveRuntimeSemantics({ SIDERAIL_BASE: undefined })));
});

test("private runtime paths are mode 0700, short, stable, and do not claim the lease", async (t) => {
  const root = await fs.mkdtemp("/tmp/gri-runtime-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.chmod(root, 0o700);
  const namespaceId = "a".repeat(64);
  const options = {
    environment: { XDG_RUNTIME_DIR: root },
    namespaceId,
    uid: process.getuid(),
    shortTmpRoot: root,
  };
  const first = await preparePrivateRuntimePaths(options);
  const second = await preparePrivateRuntimePaths(options);
  assert.deepEqual(second, first);
  assert.ok(Buffer.byteLength(first.socketPath) <= 103);
  assert.equal((await fs.stat(first.runtimeDirectory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.dirname(first.runtimeDirectory))).mode & 0o777, 0o700);
  await assert.rejects(fs.stat(first.leasePath), { code: "ENOENT" });
  assert.equal(await validateOwnedRuntimeDirectory(first.runtimeDirectory), first.runtimeDirectory);
});

test("unsafe configured runtime directories and symlinks are never used", async (t) => {
  const root = await fs.mkdtemp("/tmp/gri-unsafe-");
  const fallback = await fs.mkdtemp("/tmp/gf-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(fallback, { recursive: true, force: true }));
  const unsafe = path.join(root, "unsafe");
  const link = path.join(root, "runtime-link");
  await fs.mkdir(unsafe, { mode: 0o777 });
  await fs.chmod(unsafe, 0o777);
  await fs.symlink(unsafe, link);
  const paths = await preparePrivateRuntimePaths({
    environment: { XDG_RUNTIME_DIR: link },
    namespaceId: "b".repeat(64),
    uid: process.getuid(),
    shortTmpRoot: fallback,
  });
  assert.ok(paths.runtimeDirectory.startsWith(fallback));
  await assert.rejects(
    validateOwnedRuntimeDirectory(unsafe),
    (error) => error instanceof GitStateIdentityError && error.code === "UNSAFE_RUNTIME_DIRECTORY",
  );
});

test("repository identity shares subdirectories and resolves a relative alternate index from worktree root", async (t) => {
  const root = await fs.mkdtemp("/tmp/gri-repo-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "--initial-branch=main"], { baseEnv: gitEnvironment });
  const subdirectory = path.join(root, "src", "nested");
  await fs.mkdir(subdirectory, { recursive: true });
  const executableIdentity = await resolveGitExecutableIdentity({ environment: gitEnvironment });
  const calls = [];
  const tracedRunGit = async ({ cwd, args, gitExecutable, environment }) => {
    calls.push({ cwd, args });
    return runCommand(gitExecutable, args, {
      cwd,
      baseEnv: environment,
      env: { GIT_OPTIONAL_LOCKS: "0" },
      stdoutEncoding: "utf8-strict",
    });
  };
  const fromRoot = await resolveRepositoryIdentity({
    cwd: root,
    environment: gitEnvironment,
    executableIdentity,
    runGit: tracedRunGit,
  });
  const fromNested = await resolveRepositoryIdentity({
    cwd: subdirectory,
    environment: gitEnvironment,
    executableIdentity,
    runGit: tracedRunGit,
  });
  assert.equal(fromRoot.kind, "git");
  assert.equal(fromRoot.worktreeRoot, await fs.realpath(root));
  assert.equal(fromNested.canonicalCwd, await fs.realpath(subdirectory));
  assert.equal(fromNested.identityId, fromRoot.identityId);
  assert.equal(calls.length, 8);
  assert.ok(calls.every(({ args }) => args[0] === "rev-parse"));

  const alternate = await resolveRepositoryIdentity({
    cwd: subdirectory,
    environment: { ...gitEnvironment, GIT_INDEX_FILE: "alternate-index" },
    executableIdentity,
    runGit: tracedRunGit,
  });
  assert.equal(alternate.indexPath, path.join(await fs.realpath(root), "alternate-index"));
  assert.notEqual(alternate.identityId, fromNested.identityId);

  await fs.rename(path.join(root, ".git"), path.join(root, ".git-old"));
  await fs.cp(path.join(root, ".git-old"), path.join(root, ".git"), { recursive: true });
  const replacedMetadata = await resolveRepositoryIdentity({
    cwd: root,
    environment: gitEnvironment,
    executableIdentity,
    runGit: tracedRunGit,
  });
  assert.equal(replacedMetadata.identityId, fromRoot.identityId);
  await fs.rm(path.join(root, ".git-old"), { recursive: true, force: true });
});

test("linked worktrees have distinct per-worktree Git dirs and one common Git dir", async (t) => {
  const container = await fs.mkdtemp("/tmp/gri-linked-");
  t.after(() => fs.rm(container, { recursive: true, force: true }));
  const primary = path.join(container, "primary");
  const linked = path.join(container, "linked");
  await fs.mkdir(primary);
  await runGit(primary, ["init", "--initial-branch=main"], { baseEnv: gitEnvironment });
  await fs.writeFile(path.join(primary, "README.md"), "fixture\n");
  await runGit(primary, ["add", "README.md"], { baseEnv: gitEnvironment });
  await runGit(primary, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"], { baseEnv: gitEnvironment });
  await runGit(primary, ["worktree", "add", "-b", "linked", linked], { baseEnv: gitEnvironment });
  const [one, two] = await Promise.all([
    resolveRepositoryIdentity({ cwd: primary, environment: gitEnvironment }),
    resolveRepositoryIdentity({ cwd: linked, environment: gitEnvironment }),
  ]);
  assert.notEqual(one.gitDir, two.gitDir);
  assert.equal(one.commonGitDir, two.commonGitDir);
  assert.notEqual(one.indexPath, two.indexPath);
  assert.notEqual(one.identityId, two.identityId);
});

test("ordinary non-repositories use canonical filesystem identity", async (t) => {
  const root = await fs.mkdtemp("/tmp/gri-files-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = await resolveRepositoryIdentity({ cwd: root, environment: gitEnvironment });
  assert.deepEqual(
    {
      kind: identity.kind,
      canonicalCwd: identity.canonicalCwd,
      worktreeRoot: identity.worktreeRoot,
      gitDir: identity.gitDir,
      commonGitDir: identity.commonGitDir,
      indexPath: identity.indexPath,
    },
    {
      kind: "filesystem",
      canonicalCwd: await fs.realpath(root),
      worktreeRoot: "",
      gitDir: "",
      commonGitDir: "",
      indexPath: "",
    },
  );
  assert.match(identity.identityId, /^[a-f0-9]{64}$/);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root);
  const replacement = await resolveRepositoryIdentity({ cwd: root, environment: gitEnvironment });
  assert.equal(replacement.identityId, identity.identityId);
});

test("missing executables and ambiguous environment values fail explicitly", async () => {
  await assert.rejects(
    resolveGitExecutableIdentity({ environment: { PATH: "/definitely/missing" } }),
    (error) => error instanceof GitStateIdentityError && error.code === "GIT_EXECUTABLE_UNAVAILABLE",
  );
  assert.throws(
    () => digestEffectiveGitEnvironment({ PATH: "/bin", GIT_INDEX_FILE: "bad\0path" }),
    (error) => error instanceof GitStateIdentityError && error.code === "UNSUPPORTED_ENVIRONMENT",
  );
});

test("malformed namespace inputs cannot collapse incompatible coordinators", async () => {
  const executable = { realpath: "/usr/bin/git", dev: "1", ino: "2", size: "3", mtimeNs: "4" };
  const base = { hostSocketPath: "/fixture/socket", codeFingerprint: "a".repeat(64), providerEnvironmentId: "b".repeat(64),
    effectiveConfigId: "c".repeat(64), gitExecutableIdentity: executable, realpath: async (value) => value };
  for (const patch of [{ hostSocketPath: "" }, { codeFingerprint: "bad" }, { providerEnvironmentId: "bad" },
    { effectiveConfigId: "bad" }, { gitExecutableIdentity: null }, { protocolVersion: 0 },
    { gitExecutableIdentity: { ...executable, extra: true } }, { gitExecutableIdentity: { ...executable, ino: "" } },
    { gitExecutableIdentity: { ...executable, dev: "not-numeric" } }, { gitExecutableIdentity: { ...executable, realpath: "bad\0path" } }]) {
    await assert.rejects(createCoordinatorIdentity({ ...base, ...patch }), TypeError);
  }
  assert.notEqual((await createCoordinatorIdentity({ ...base, uid: null })).namespaceId,
    (await createCoordinatorIdentity({ ...base, uid: 1 })).namespaceId);
  for (const invalid of [null, []]) {
    assert.throws(() => collectEffectiveGitEnvironment(invalid), TypeError);
    assert.throws(() => collectEffectiveRuntimeSemantics(invalid), TypeError);
  }
  assert.throws(() => digestEffectiveRuntimeSemantics(), TypeError);
});

test("runtime paths reject wrong ownership, inaccessible filesystems, and excessive socket lengths", async () => {
  const uid = process.getuid();
  const metadata = { uid, mode: 0o700, isDirectory: () => true, isSymbolicLink: () => false };
  await assert.rejects(validateOwnedRuntimeDirectory("/fixture", { uid, lstat: async () => ({ ...metadata, uid: uid + 1 }) }), { code: "UNSAFE_RUNTIME_DIRECTORY" });
  await assert.rejects(validateOwnedRuntimeDirectory("/fixture", { lstat: async () => { throw new Error("inaccessible"); } }), { code: "RUNTIME_DIRECTORY_UNAVAILABLE" });
  await assert.rejects(preparePrivateRuntimePaths({ namespaceId: "bad" }), TypeError);
  await assert.rejects(preparePrivateRuntimePaths({ namespaceId: "a".repeat(64), uid: null }), { code: "UNSUPPORTED_USER_IDENTITY" });
  await assert.rejects(preparePrivateRuntimePaths({ namespaceId: "a".repeat(64), environment: {}, shortTmpRoot: `/${"x".repeat(110)}` }), { code: "RUNTIME_PATH_TOO_LONG" });
  await assert.rejects(preparePrivateRuntimePaths({ namespaceId: "a".repeat(64), environment: {},
    mkdir: async () => { throw Object.assign(new Error("read-only"), { code: "EROFS" }); } }), { code: "RUNTIME_DIRECTORY_UNAVAILABLE" });
});

test("executable and code identity failures are typed instead of borrowing another context", async () => {
  await assert.rejects(resolveGitExecutableIdentity({ executable: "" }), { code: "UNSUPPORTED_EXECUTABLE" });
  await assert.rejects(resolveGitExecutableIdentity({ executable: "/fixture/git", access: async () => { throw new Error("denied"); } }), { code: "GIT_EXECUTABLE_UNAVAILABLE" });
  await assert.rejects(resolveGitExecutableIdentity({ executable: "/fixture/git", access: async () => {},
    realpath: async () => { throw new Error("gone"); } }), { code: "PATH_UNAVAILABLE" });
  await assert.rejects(resolveGitExecutableIdentity({ executable: "/fixture/git", access: async () => {}, realpath: async (value) => value,
    stat: async () => { throw new Error("gone"); } }), { code: "GIT_EXECUTABLE_UNAVAILABLE" });
  await assert.rejects(resolveGitExecutableIdentity({ executable: "/fixture/git", access: async () => {}, realpath: async (value) => value,
    stat: async () => ({ isFile: () => false }) }), { code: "UNSUPPORTED_EXECUTABLE" });
  await assert.rejects(computeCodeFingerprint([]), TypeError);
  await assert.rejects(computeCodeFingerprint([""], { checkoutPath: "/fixture", realpath: async (value) => value }), TypeError);
  await assert.rejects(computeCodeFingerprint(["same", "same"], { checkoutPath: "/fixture", realpath: async (value) => value }), { code: "DUPLICATE_RUNTIME_FILE" });
});

test("ambiguous repository responses fail before a potentially incorrect shared snapshot", async () => {
  const executableIdentity = { realpath: "/usr/bin/git", dev: "1", ino: "2", size: "3", mtimeNs: "4" };
  const base = { cwd: "/fixture", environment: {}, executableIdentity, realpath: async (value) => value };
  for (const stdout of ["", "bad\0path"]) {
    await assert.rejects(resolveRepositoryIdentity({ ...base, runGit: async () => ({ stdout }) }), { code: "AMBIGUOUS_REPOSITORY" });
  }
  await assert.rejects(resolveRepositoryIdentity({ ...base, runGit: async ({ args }) => {
    if (args.includes("--show-toplevel")) return { stdout: "/fixture\n" };
    throw new Error("metadata unavailable");
  } }), { code: "AMBIGUOUS_REPOSITORY" });
  await assert.rejects(resolveRepositoryIdentity({ cwd: "" }), TypeError);
});

test("only Git's own exit marks a directory as outside Git", async (t) => {
  const root = await fs.mkdtemp("/tmp/gri-busy-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executableIdentity = await resolveGitExecutableIdentity({ environment: gitEnvironment });
  const resolveWith = (error) => resolveRepositoryIdentity({
    cwd: root,
    environment: gitEnvironment,
    executableIdentity,
    runGit: async () => { throw error; },
  });
  // A slow machine must not turn a repository into plain files.
  for (const kind of ["timeout", "aborted", "spawn"]) {
    await assert.rejects(resolveWith(new ProcessError(`git ${kind}`, { kind })), { kind });
  }
  assert.equal((await resolveWith(new ProcessError("not a git repository", { kind: "exit", exitCode: 128 }))).kind, "filesystem");
});
