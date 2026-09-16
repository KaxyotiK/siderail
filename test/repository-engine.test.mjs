import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRepositoryEngine } from "../src/repository-engine.mjs";
import { runGit } from "../src/process.mjs";

async function flush() {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test("repository engine owns startup, subscriptions, manual refresh, and watcher snapshots", async () => {
  const snapshots = [{ value: 1 }, { value: 2 }];
  const updates = [];
  const deliveries = [];
  let reads = 0;
  let closed = 0;
  const engine = createRepositoryEngine({
    context: { engineKey: "repo:test", cwd: "/fixture" },
    readState: async () => snapshots[reads++],
    watchFactory: async ({ snapshot, onHealth }) => {
      assert.equal(snapshot, snapshots[0]);
      onHealth({ healthy: true });
      return {
        updateSnapshot(next) { updates.push(next); },
        close() { closed += 1; },
      };
    },
    schedulerOptions: { random: () => 0.5 },
  });
  const unsubscribe = engine.subscribe((delivery) => deliveries.push(delivery));
  const initial = await engine.ready;
  assert.equal(initial.snapshot, snapshots[0]);
  assert.equal(initial.stateGeneration, 1);
  assert.equal(initial.status, "healthy");

  const refreshed = await engine.refresh("toolbar");
  assert.equal(refreshed.snapshot, snapshots[1]);
  assert.equal(refreshed.stateGeneration, 2);
  assert.deepEqual(updates, [snapshots[1]]);
  assert.equal(engine.latest().snapshot, snapshots[1]);
  await flush();
  assert.ok(deliveries.some(({ stateGeneration }) => stateGeneration === 2));

  unsubscribe();
  await engine.close();
  assert.equal(closed, 1);
  await engine.close();
});

test("watcher-reported degraded health is preserved and reconciliation checks roots first", async () => {
  let currentTime = 0;
  let timerId = 0;
  const timers = new Map();
  const events = [];
  let reads = 0;
  const setTimer = (callback, delay) => {
    const handle = { id: ++timerId, at: currentTime + delay, callback, unref() {} };
    timers.set(handle.id, handle);
    return handle;
  };
  const clearTimer = (handle) => { if (handle) timers.delete(handle.id); };
  const tick = async (duration) => {
    const target = currentTime + duration;
    while (true) {
      const due = [...timers.values()].filter(({ at }) => at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      timers.delete(due.id);
      currentTime = due.at;
      due.callback();
      await flush();
    }
    currentTime = target;
    await flush();
  };
  const engine = createRepositoryEngine({
    context: { engineKey: "repo:degraded", cwd: "/fixture" },
    now: () => currentTime,
    readState: async () => ({ reads: ++reads }),
    watchFactory: async ({ onHealth, onInvalidation }) => {
      onHealth({ healthy: false, error: new Error("partial watcher") });
      return {
        reconcile() { events.push("reconcile"); onInvalidation({ reason: "root-identity" }); },
        updateSnapshot() { events.push("update"); },
        close() {},
      };
    },
    schedulerOptions: {
      now: () => currentTime,
      setTimer,
      clearTimer,
      random: () => 0.5,
      fallbackIntervalMs: 10_000,
    },
  });
  const initial = await engine.ready;
  assert.equal(initial.status, "degraded");
  await tick(9_999);
  assert.equal(reads, 1);
  await tick(1);
  assert.equal(reads, 2);
  assert.deepEqual(events.slice(0, 2), ["reconcile", "update"]);
  await tick(2_000);
  assert.equal(reads, 2, "reconciliation invalidation is covered by its following read");
  await engine.close();
});

test("refresh failure retains the last snapshot and later success clears the error", async () => {
  let attempt = 0;
  const engine = createRepositoryEngine({
    context: { engineKey: "repo:failure", cwd: "/fixture" },
    readState: async () => {
      attempt += 1;
      if (attempt === 2) throw new Error("provider offline");
      return { attempt };
    },
    watchFactory: async ({ onHealth }) => {
      onHealth({ healthy: true });
      return { close() {} };
    },
  });
  await engine.ready;
  await assert.rejects(engine.refresh("failure"), /provider offline/);
  assert.deepEqual(engine.latest().snapshot, { attempt: 1 });
  assert.equal(engine.latest().status, "error");
  const recovered = await engine.refresh("retry");
  assert.deepEqual(recovered.snapshot, { attempt: 3 });
  await flush();
  assert.equal(engine.latest().status, "healthy");
  await engine.close();
});

test("provider config changes update the engine reconciliation interval", async () => {
  let reads = 0;
  const engine = createRepositoryEngine({
    context: {
      engineKey: "repo:config",
      cwd: "/fixture",
      schedulerConfig: { pollIntervalMs: 10_000, reconcileIntervalMs: 300_000 },
    },
    now: () => 0,
    readState: async () => ({
      value: ++reads,
      config: { refresh: { pollIntervalMs: 10_000, reconcileIntervalMs: reads === 1 ? 60_000 : 120_000 } },
    }),
    watchFactory: async ({ onHealth }) => {
      onHealth({ healthy: true });
      return { close() {} };
    },
    schedulerOptions: { random: () => 0.5 },
  });
  await engine.ready;
  await flush();
  assert.equal(engine.latest().reconciliationDueAt, 60_000);
  await engine.refresh("config-changed");
  await flush();
  assert.equal(engine.latest().reconciliationDueAt, 120_000);
  await engine.close();
});

test("watch invalidation refreshes once and a watcher update failure degrades the delivery", async () => {
  let invalidate;
  let reads = 0;
  const engine = createRepositoryEngine({
    context: { engineKey: "repo:watch-update", cwd: "/fixture" },
    readState: async () => ({ value: ++reads }),
    watchFactory: async ({ onInvalidation, onHealth }) => {
      invalidate = onInvalidation;
      onHealth({ healthy: true });
      return {
        updateSnapshot() { throw new Error("watch root disappeared"); },
        close() {},
      };
    },
    schedulerOptions: { burstDelayMs: 0, minimumIntervalMs: 0 },
  });
  await engine.ready;
  const changed = new Promise((resolve) => {
    const unsubscribe = engine.subscribe((delivery) => {
      if (delivery.stateGeneration === 2) {
        unsubscribe();
        resolve(delivery);
      }
    });
  });
  invalidate({ reason: "tracked-file" });
  const delivery = await changed;
  assert.equal(reads, 2);
  assert.equal(delivery.status, "degraded");
  await engine.close();
});

test("watch factory failure degrades state and an initial provider failure rejects ready", async () => {
  const degraded = createRepositoryEngine({
    context: { engineKey: "repo:watch-start-failure", cwd: "/fixture" },
    readState: async () => ({ value: 1 }),
    watchFactory: async () => { throw new Error("watch unavailable"); },
  });
  assert.equal((await degraded.ready).status, "degraded");
  await degraded.close();

  const failed = createRepositoryEngine({
    context: { engineKey: "repo:startup-failure", cwd: "/fixture" },
    readState: async () => { throw new Error("initial provider failure"); },
    schedulerOptions: { fallbackIntervalMs: 60_000 },
  });
  await assert.rejects(failed.ready, /initial provider failure/);
  assert.equal(failed.latest().status, "error");
  assert.match(failed.latest().error.message, /initial provider failure/);
  await failed.close();
});

test("late subscribers replay current state and close disposes a watcher still starting", async () => {
  const watcherGate = deferred();
  const watcherStarted = deferred();
  let watcherClosed = 0;
  const engine = createRepositoryEngine({
    context: { engineKey: "repo:closing-startup", cwd: "/fixture" },
    readState: async () => ({ value: 1 }),
    watchFactory: async () => {
      watcherStarted.resolve();
      return watcherGate.promise;
    },
  });
  await watcherStarted.promise;
  const closing = engine.close();
  watcherGate.resolve({ close() { watcherClosed += 1; } });
  await closing;
  await assert.rejects(engine.ready, /closed|cancelled/i);
  assert.equal(watcherClosed, 1);

  const current = createRepositoryEngine({
    context: { engineKey: "repo:late-subscribe", cwd: "/fixture" },
    readState: async () => ({ value: 2 }),
    schedulerOptions: { burstDelayMs: 0, minimumIntervalMs: 0 },
  });
  await current.ready;
  const replayed = new Promise((resolve) => current.subscribe(resolve));
  assert.equal((await replayed).snapshot.value, 2);
  const ignored = current.subscribe(() => { throw new Error("listener failure is isolated"); });
  await current.invalidate("direct-dirty");
  ignored();
  await current.close();
});

test("opt-in engine evidence counts provider builds without logging context paths", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-engine-log-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const log = path.join(root, "debug.ndjson");
  const previous = process.env.GIT_RAIL_DEBUG_LOG;
  process.env.GIT_RAIL_DEBUG_LOG = log;
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_RAIL_DEBUG_LOG;
    else process.env.GIT_RAIL_DEBUG_LOG = previous;
  });
  const engine = createRepositoryEngine({
    context: { engineKey: "private/path/repository", cwd: "/fixture" },
    readState: async () => ({ value: 1 }),
    watchFactory: async ({ onHealth }) => {
      onHealth({ healthy: true });
      return {
        metrics: { installed: 2 },
        classifierMetrics: { classifierLaunches: 1 },
        close() {},
      };
    },
  });
  await engine.ready;
  await engine.close();
  const contents = await fs.readFile(log, "utf8");
  const entries = contents.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.filter(({ operation, phase }) => operation === "repository-provider" && phase === "start").length, 1);
  assert.equal(entries.filter(({ operation, phase }) => operation === "repository-provider" && phase === "finish").length, 1);
  assert.deepEqual(entries.find(({ operation }) => operation === "repository-watcher").metrics, { installed: 2 });
  assert.doesNotMatch(contents, /private\/path|\/fixture/);
});

test("real provider engines keep simultaneous alternate-index environments isolated", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-engine-index-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = {
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "alpha.txt"), "base\n");
  await fs.writeFile(path.join(root, "beta.txt"), "base\n");
  await runGit(root, ["add", "--all"]);
  await runGit(root, ["commit", "-m", "base"], { env: identity });
  const originalIndex = await fs.readFile(path.join(root, ".git", "index"));
  const indexA = path.join(root, ".git", "index-a");
  const indexB = path.join(root, ".git", "index-b");
  await fs.writeFile(indexA, originalIndex);
  await fs.writeFile(indexB, originalIndex);
  await fs.writeFile(path.join(root, "alpha.txt"), "alpha\n");
  await fs.writeFile(path.join(root, "beta.txt"), "beta\n");
  const baseEnvironment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
  };
  await Promise.all([
    runGit(root, ["add", "alpha.txt"], { baseEnv: { ...baseEnvironment, GIT_INDEX_FILE: indexA } }),
    runGit(root, ["add", "beta.txt"], { baseEnv: { ...baseEnvironment, GIT_INDEX_FILE: indexB } }),
  ]);
  const engine = (name, indexPath) => createRepositoryEngine({
    context: {
      engineKey: `repo:${name}`,
      cwd: root,
      environment: { ...baseEnvironment, GIT_INDEX_FILE: indexPath },
    },
  });
  const alpha = engine("alpha", indexA);
  const beta = engine("beta", indexB);
  const [alphaState, betaState] = (await Promise.all([alpha.ready, beta.ready])).map(({ snapshot }) => snapshot);
  assert.deepEqual(alphaState.staged.map(({ path: filePath }) => filePath), ["alpha.txt"]);
  assert.deepEqual(betaState.staged.map(({ path: filePath }) => filePath), ["beta.txt"]);
  await Promise.all([alpha.close(), beta.close()]);
});
