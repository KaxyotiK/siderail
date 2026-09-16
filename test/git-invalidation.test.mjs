import assert from "node:assert/strict";
import test from "node:test";
import { createGitInvalidationClassifier, gitMetadataRelevant, watchedRootIdentity } from "../src/git-invalidation.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture(options = {}) {
  const timers = new Map(); let sequence = 0;
  const events = []; const calls = [];
  const classifier = createGitInvalidationClassifier({
    repoRoot: "/fixture", gitDir: "/fixture/.git", commonGitDir: "/fixture/.git",
    snapshot: { tracked: ["tracked", "directory/child", "submodule"], error: "" },
    run: async (_cwd, args, input) => {
      calls.push({ args, input });
      return { stdout: input.stdinInput.split("\0").filter((entry) => entry.startsWith("ignored/")).join("\0") + "\0" };
    },
    onInvalidation: (event) => events.push(event),
    setTimer(fn) { const id = ++sequence; timers.set(id, fn); return id; },
    clearTimer(id) { timers.delete(id); },
    ...options,
  });
  return { classifier, events, calls, async flush() {
    for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
    await settle();
  } };
}

test("metadata filtering is dependency-specific and conservative when unhealthy", () => {
  for (const filename of ["objects/ab/cdef", "objects", "objects/pack/new.pack"]) {
    assert.equal(gitMetadataRelevant(filename), false);
    assert.equal(gitMetadataRelevant(filename, { healthy: false }), true);
  }
  for (const filename of ["", "objects/info/alternates", "objects/info/http-alternates", "refs/heads/main", "packed-refs", "HEAD", "index", "index.lock", "config.lock", "unknown.lock", "rebase-merge/head-name"]) {
    assert.equal(gitMetadataRelevant(filename), true, filename);
  }
  for (const filename of ["index", "index.lock", "HEAD", "HEAD.lock", "logs/HEAD", "sharedindex.abc", "MERGE_HEAD", "rebase-merge/head-name"]) {
    assert.equal(gitMetadataRelevant(`worktrees/sibling/${filename}`, { own: false }), false, filename);
  }
  assert.equal(gitMetadataRelevant("worktrees/sibling/new-dependency", { own: false }), true);
  assert.equal(gitMetadataRelevant("worktrees/sibling/commondir", { own: false }), true);
});

test("ignored noise uses one NUL-safe batch and caches exact paths", async () => {
  const f = fixture();
  for (const name of ["ignored/cache", "ignored/line\nbreak", "ignored/tab\tname", "ignored/cache"]) f.classifier.event("/fixture", name);
  await f.flush();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args, ["check-ignore", "--stdin", "-z"]);
  assert.equal(f.calls[0].input.stdinInput, "ignored/cache\0ignored/line\nbreak\0ignored/tab\tname\0");
  assert.equal(f.events.length, 0);
  for (let i = 0; i < 20; i += 1) f.classifier.event("/fixture", "ignored/cache");
  await f.flush();
  assert.equal(f.calls.length, 1); assert.equal(f.events.length, 0);
  f.classifier.event("/fixture", "new-file"); await f.flush();
  assert.equal(f.events.length, 1);
  f.classifier.event("/fixture", "new-file");
  assert.equal(f.calls.length, 2); assert.equal(f.events.length, 2);
  f.classifier.close();
});

test("tracked paths, tracked directory renames, and submodule children bypass ignores", async () => {
  const f = fixture();
  for (const name of ["tracked", "directory", "directory/child", "submodule/file", "submodule/.git/HEAD"]) f.classifier.event("/fixture", name);
  await f.flush();
  assert.equal(f.events.length, 5); assert.equal(f.calls.length, 0);
  f.classifier.close();
});

test("own and sibling indexes are distinct for primary and linked worktrees", () => {
  const primary = fixture();
  primary.classifier.event("/fixture", ".git/worktrees/sibling/index");
  primary.classifier.event("/fixture", ".git/objects/ab/new");
  assert.equal(primary.events.length, 0);
  primary.classifier.event("/fixture", ".git/index"); assert.equal(primary.events.length, 1);
  const linked = fixture({ repoRoot: "/linked", gitDir: "/fixture/.git/worktrees/current" });
  linked.classifier.event("/fixture/.git", "worktrees/current/index");
  linked.classifier.event("/fixture/.git", "worktrees/sibling/index");
  linked.classifier.event("/fixture/.git", "refs/heads/main");
  assert.equal(linked.events.length, 2);
  primary.classifier.close(); linked.classifier.close();
});

test("ignore/index/config changes invalidate classification without discarding tracked ignores", async () => {
  let configs = 0;
  const f = fixture({ onConfigChange() { configs += 1; } });
  f.classifier.event("/fixture", "ignored/cache"); await f.flush();
  for (const dependency of [".gitignore", "nested/.gitignore", ".gitattributes", ".gitmodules", ".git/config", ".git/HEAD", ".git/index"]) {
    f.classifier.event("/fixture", dependency);
    f.classifier.event("/fixture", "ignored/cache"); await f.flush();
  }
  assert.equal(f.calls.length, 8); assert.equal(f.events.length, 7); assert.equal(configs, 6);
  f.classifier.updateSnapshot({ tracked: ["ignored/cache"] });
  f.classifier.event("/fixture", "ignored/cache");
  assert.equal(f.calls.length, 8); assert.equal(f.events.length, 8);
  f.classifier.close();
});

test("unknown names, external paths, directory mode, and provider errors recover conservatively", async () => {
  const f = fixture();
  for (const name of [null, undefined, "", "\ufffd", ".", "../external"]) f.classifier.event("/fixture", name);
  assert.equal(f.events.length, 6);
  f.classifier.setHealthy(false); f.classifier.event("/fixture", "new");
  f.classifier.event("/fixture", ".git/objects/ab/missing");
  assert.equal(f.events.length, 8); assert.equal(f.calls.length, 0);
  const directory = fixture({ gitDir: "", commonGitDir: "" });
  directory.classifier.event("/fixture", "new"); await directory.flush();
  assert.equal(directory.events.length, 1); assert.equal(directory.calls.length, 0);
  f.classifier.setRoots({ repoRoot: "/other", gitDir: "/other/.git", commonGitDir: "/other/.git" });
  f.classifier.updateSnapshot({ tracked: [{ path: "clean" }], error: "" });
  f.classifier.event("/other", "clean"); assert.equal(f.events.length, 9);
  directory.classifier.close(); f.classifier.close();
});

test("classification failure and a generation change during classification never drop work", async () => {
  const broken = fixture({ run: async () => { throw new Error("Git unavailable"); } });
  broken.classifier.event("/fixture", "new"); await broken.flush();
  assert.equal(broken.events[0].reason, "classification-failed"); broken.classifier.close();
  let resolve;
  const pending = fixture({ run: () => new Promise((done) => { resolve = done; }) });
  pending.classifier.event("/fixture", "ignored/cache"); await pending.flush();
  pending.classifier.clearIgnore(); resolve({ stdout: "ignored/cache\0" }); await settle();
  assert.equal(pending.events[0].reason, "classification-generation-changed"); pending.classifier.close();
});

test("close cancels pending work and drops in-flight classifier completions", async () => {
  const f = fixture(); f.classifier.event("/fixture", "pending"); f.classifier.close(); await f.flush();
  f.classifier.event("/fixture", "tracked"); assert.equal(f.calls.length, 0); assert.equal(f.events.length, 0);
  let resolve;
  const pending = fixture({ run: () => new Promise((done) => { resolve = done; }) });
  pending.classifier.event("/fixture", "pending"); await pending.flush();
  pending.classifier.close(); resolve({ stdout: "" }); await settle(); assert.equal(pending.events.length, 0);
  assert.equal(await watchedRootIdentity("/this-path-cannot-exist-git-refresh-fixture"), null);
});
