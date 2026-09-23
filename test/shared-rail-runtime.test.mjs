import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifySharedRuntimeFallback,
  createSharedRailRuntime,
  localizeRepositoryDelivery,
  resolveRailStateMode,
  resolveSharedRuntimeSemantics,
} from "../src/shared-rail-runtime.mjs";
import { digestEffectiveGitEnvironment } from "../src/git-state-identity.mjs";

function configuration(environment) {
  return {
    config: {
      version: 1,
      baseRef: environment.CONFIG_BASE || "main",
      marker: environment.CONFIG_MARKER || "local",
      limits: { maxFileBytes: 4096, maxDiffBytes: 8192 },
      refresh: { pollIntervalMs: 10_000, reconcileIntervalMs: 300_000 },
    },
    errors: environment.CONFIG_ERROR ? [environment.CONFIG_ERROR] : [],
  };
}

function runtimeFor(environment) {
  const semantics = resolveSharedRuntimeSemantics(environment, { loadConfiguration: configuration });
  return {
    identity: {
      namespaceId: `namespace-${semantics.effectiveConfigId}`,
      effectiveConfigId: semantics.effectiveConfigId,
      providerEnvironmentId: digestEffectiveGitEnvironment(environment),
      codeFingerprint: "c".repeat(64),
    },
    paths: { socketPath: "/fixture/coordinator.sock", leasePath: "/fixture/owner.json" },
    gitExecutableIdentity: { realpath: "/usr/bin/git", dev: "1", ino: "2", size: "3", mtimeNs: "4" },
  };
}

function delivery(snapshot, generation = 1) {
  return {
    engineKey: "engine",
    stateGeneration: generation,
    inputGeneration: generation,
    status: "healthy",
    snapshot,
    refreshedAt: generation,
    reconciliationDueAt: 300_000,
  };
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition did not become true within ${timeoutMs}ms`);
}

function fakeFactories(environment, behavior = {}) {
  const records = [];
  let launches = 0;
  let hostRecord;
  const launcherFactory = () => ({ launch: async () => { launches += 1; } });
  const clientFactory = () => ({
    openRepositorySubscription(options) {
      const record = { ...options, closed: 0, refreshes: 0 };
      records.push(record);
      const initial = behavior.initial || delivery({
        cwd: "/canonical/repo",
        config: { marker: "coordinator" },
        configErrors: ["provider base failed"],
        error: "provider base failed",
        commitPathIndex: new Map(),
      });
      const ready = behavior.readyError
        ? Promise.reject(Object.assign(new Error(behavior.readyError), { code: behavior.readyError }))
        : behavior.pendingReady || Promise.resolve(initial);
      return {
        ready,
        latest: () => initial,
        async refresh() { record.refreshes += 1; return behavior.refreshError ? Promise.reject(behavior.refreshError) : initial; },
        async close() { record.closed += 1; return behavior.closePromise; },
      };
    },
    subscribeHost(selector, listener) {
      hostRecord = { selector, listener, closed: false, refreshes: 0 };
      return {
        ready: Promise.resolve({ cwd: "/host", railPaneId: selector.railPaneId }),
        latest: () => ({ cwd: "/host", railPaneId: selector.railPaneId }),
        async refresh() { hostRecord.refreshes += 1; return this.latest(); },
        async close() { hostRecord.closed = true; },
      };
    },
    async close() {},
    status: { connected: false },
  });
  return {
    records,
    launcherFactory,
    clientFactory,
    get launches() { return launches; },
    get hostRecord() { return hostRecord; },
    resolveRuntime: async () => runtimeFor(environment),
  };
}

test("state mode is explicit and rejects unknown rollback values", () => {
  assert.equal(resolveRailStateMode({}), "shared");
  assert.equal(resolveRailStateMode({ SIDERAIL_STATE_MODE: "shared" }), "shared");
  assert.equal(resolveRailStateMode({ SIDERAIL_STATE_MODE: "in-process" }), "in-process");
  assert.throws(
    () => resolveRailStateMode({ SIDERAIL_STATE_MODE: "sometimes" }),
    (error) => error.code === "GIT_STATE_MODE_UNSUPPORTED",
  );
});

test("only typed identity and snapshot-size failures select explicit fallback", () => {
  assert.equal(classifySharedRuntimeFallback({ code: "PATH_UNAVAILABLE" }), "identity-unsupported");
  assert.equal(classifySharedRuntimeFallback({ code: "GIT_STATE_SNAPSHOT_TOO_LARGE" }), "snapshot-oversize");
  assert.equal(classifySharedRuntimeFallback({ code: "GIT_STATE_UNAVAILABLE" }), "");
});

test("namespace semantics follow immutable environment overrides, not mutable config contents", () => {
  const environment = { PATH: "/bin", HOME: "/home/test", CONFIG_BASE: "main" };
  const first = resolveSharedRuntimeSemantics(environment, { loadConfiguration: configuration });
  const fileEdited = resolveSharedRuntimeSemantics({ ...environment, CONFIG_BASE: "release" }, { loadConfiguration: configuration });
  assert.equal(first.effectiveConfigId, fileEdited.effectiveConfigId);
  assert.notEqual(first.providerConfig.baseRef, fileEdited.providerConfig.baseRef);

  const baseOverride = resolveSharedRuntimeSemantics({ ...environment, SIDERAIL_BASE: "release" }, { loadConfiguration: configuration });
  const pollOverride = resolveSharedRuntimeSemantics({ ...environment, SIDERAIL_POLL_INTERVAL_MS: "20000" }, { loadConfiguration: configuration });
  const reconcileOverride = resolveSharedRuntimeSemantics({ ...environment, SIDERAIL_RECONCILE_INTERVAL_MS: "60000" }, { loadConfiguration: configuration });
  const watchOverride = resolveSharedRuntimeSemantics({ ...environment, SIDERAIL_WATCH_MODE: "poll-only" }, { loadConfiguration: configuration });
  for (const changed of [baseOverride, pollOverride, reconcileOverride, watchOverride]) {
    assert.notEqual(changed.effectiveConfigId, first.effectiveConfigId);
  }
});

test("delivery localization preserves provider errors and never mutates a shared snapshot", () => {
  const snapshot = {
    cwd: "/canonical/repo",
    config: { marker: "coordinator" },
    configErrors: ["invalid provider base"],
    error: "invalid provider base",
    commitPathIndex: new Map(),
  };
  const original = delivery(snapshot);
  const localized = localizeRepositoryDelivery(original, {
    cwd: "/selected/subdirectory",
    environment: { CONFIG_MARKER: "rail", CONFIG_ERROR: "local viewer error" },
    loadConfiguration: configuration,
  });
  assert.notEqual(localized, original);
  assert.notEqual(localized.snapshot, snapshot);
  assert.equal(localized.snapshot.cwd, "/selected/subdirectory");
  assert.equal(localized.snapshot.config.marker, "rail");
  assert.deepEqual(localized.snapshot.configErrors, ["invalid provider base", "local viewer error"]);
  assert.equal(localized.snapshot.error, "invalid provider base");
  assert.equal(snapshot.cwd, "/canonical/repo");
  assert.equal(snapshot.config.marker, "coordinator");
});

test("bootstrap stays dormant and exposes repository and host subscription seams", async (t) => {
  const environment = { PATH: "/bin", HOME: "/home/test" };
  const fake = fakeFactories(environment);
  const runtime = await createSharedRailRuntime({
    environment,
    resolveRuntime: fake.resolveRuntime,
    launcherFactory: fake.launcherFactory,
    clientFactory: fake.clientFactory,
    loadConfiguration: configuration,
  });
  t.after(() => runtime.close());
  assert.equal(runtime.mode, "shared");
  assert.equal(fake.launches, 0);
  const seen = [];
  const repository = runtime.openRepositorySubscription({
    context: { cwd: "/selected", environment },
    onDelivery: (value) => seen.push(value),
  });
  const initial = await repository.ready;
  assert.equal(initial.snapshot.cwd, "/selected");
  assert.equal(initial.snapshot.config.marker, "local");
  assert.ok(seen.length >= 1);
  const host = runtime.subscribeHost({ railPaneId: "rail" }, () => {});
  assert.equal((await host.ready).railPaneId, "rail");
  await host.refresh("manual");
  assert.equal(fake.hostRecord.refreshes, 1);
  await host.close();
  assert.equal(fake.hostRecord.closed, true);
});

test("local config is reloaded for every shared delivery", async (t) => {
  const environment = { PATH: "/bin", HOME: "/home/test", CONFIG_MARKER: "first" };
  const fake = fakeFactories(environment);
  const runtime = await createSharedRailRuntime({
    environment,
    resolveRuntime: fake.resolveRuntime,
    launcherFactory: fake.launcherFactory,
    clientFactory: fake.clientFactory,
    loadConfiguration: configuration,
  });
  t.after(() => runtime.close());
  const seen = [];
  const handle = runtime.openRepositorySubscription({ context: { cwd: "/selected", environment }, onDelivery: (value) => seen.push(value) });
  await handle.ready;
  environment.CONFIG_MARKER = "second";
  const sharedSnapshot = {
    cwd: "/canonical/repo",
    config: { marker: "coordinator" },
    configErrors: [],
    commitPathIndex: new Map(),
  };
  fake.records[0].onDelivery(delivery(sharedSnapshot, 2));
  assert.equal(seen.at(-1).snapshot.config.marker, "second");
  assert.equal(seen.at(-1).snapshot.cwd, "/selected");
  assert.equal(sharedSnapshot.config.marker, "coordinator");
});

test("different immutable semantics cannot borrow the first runtime", async (t) => {
  const environment = { PATH: "/bin", HOME: "/home/test" };
  const fake = fakeFactories(environment);
  const runtime = await createSharedRailRuntime({
    environment,
    resolveRuntime: fake.resolveRuntime,
    launcherFactory: fake.launcherFactory,
    clientFactory: fake.clientFactory,
    loadConfiguration: configuration,
  });
  t.after(() => runtime.close());
  assert.throws(
    () => runtime.openRepositorySubscription({
      context: { cwd: "/repo", environment: { ...environment, SIDERAIL_BASE: "release" } },
      onDelivery() {},
    }),
    (error) => error.code === "GIT_STATE_CONTEXT_INCOMPATIBLE",
  );
  assert.equal(fake.records.length, 0);
});

test("typed identity failure switches one subscription to explicit in-process fallback", async (t) => {
  const environment = { PATH: "/bin", HOME: "/home/test" };
  const fake = fakeFactories(environment, { readyError: "GIT_STATE_IDENTITY_UNSUPPORTED" });
  const statuses = [];
  let fallbackOpens = 0;
  const runtime = await createSharedRailRuntime({
    environment,
    resolveRuntime: fake.resolveRuntime,
    launcherFactory: fake.launcherFactory,
    clientFactory: fake.clientFactory,
    loadConfiguration: configuration,
    onStatus: (value) => statuses.push(value),
    openInProcessSubscription({ onDelivery }) {
      fallbackOpens += 1;
      const value = delivery({ cwd: "/fallback", configErrors: [], commitPathIndex: new Map() });
      queueMicrotask(() => onDelivery(value));
      return { ready: Promise.resolve(value), latest: () => value, refresh: async () => value, close: async () => {} };
    },
  });
  t.after(() => runtime.close());
  const handle = runtime.openRepositorySubscription({ context: { cwd: "/selected", environment }, onDelivery() {} });
  assert.equal((await handle.ready).snapshot.cwd, "/selected");
  assert.equal(handle.transport, "in-process");
  assert.equal(handle.fallbackReason, "identity-unsupported");
  assert.equal(fallbackOpens, 1);
  assert.equal(fake.records[0].closed, 1);
  assert.equal(statuses[0].reason, "identity-unsupported");
});

test("post-initial oversize signal switches automatically and ignores the old epoch", async (t) => {
  const environment = { PATH: "/bin", HOME: "/home/test" };
  const fake = fakeFactories(environment);
  const statuses = [];
  const fallbackValue = delivery({ cwd: "/fallback", configErrors: [], commitPathIndex: new Map() }, 1);
  const runtime = await createSharedRailRuntime({
    environment,
    resolveRuntime: fake.resolveRuntime,
    launcherFactory: fake.launcherFactory,
    clientFactory: fake.clientFactory,
    loadConfiguration: configuration,
    onStatus: (value) => statuses.push(value),
    openInProcessSubscription({ onDelivery }) {
      queueMicrotask(() => onDelivery(fallbackValue));
      return { ready: Promise.resolve(fallbackValue), latest: () => fallbackValue, refresh: async () => fallbackValue, close: async () => {} };
    },
  });
  t.after(() => runtime.close());
  const seen = [];
  const handle = runtime.openRepositorySubscription({ context: { cwd: "/selected", environment }, onDelivery: (value) => seen.push(value) });
  await handle.ready;
  fake.records[0].onError(Object.assign(new Error("too large"), { code: "GIT_STATE_SNAPSHOT_TOO_LARGE" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handle.transport, "in-process");
  assert.equal(statuses[0].reason, "snapshot-oversize");
  assert.equal(seen.at(-1).stateGeneration, 2);
  fake.records[0].onDelivery(delivery({ cwd: "/old", configErrors: [], commitPathIndex: new Map() }, 8));
  assert.equal(seen.at(-1).stateGeneration, 2);
});

test("normal shared connection errors remain visible and do not silently fall back", async (t) => {
  const environment = { PATH: "/bin", HOME: "/home/test" };
  const fake = fakeFactories(environment, { readyError: "GIT_STATE_UNAVAILABLE" });
  let fallbackOpens = 0;
  const runtime = await createSharedRailRuntime({
    environment,
    resolveRuntime: fake.resolveRuntime,
    launcherFactory: fake.launcherFactory,
    clientFactory: fake.clientFactory,
    loadConfiguration: configuration,
    openInProcessSubscription() { fallbackOpens += 1; throw new Error("unexpected fallback"); },
  });
  t.after(() => runtime.close());
  const handle = runtime.openRepositorySubscription({ context: { cwd: "/selected", environment }, onDelivery() {} });
  await assert.rejects(handle.ready, (error) => error.code === "GIT_STATE_UNAVAILABLE");
  assert.equal(fallbackOpens, 0);
});

test("close does not wait on a blocked ready or unbounded remote close", async () => {
  const environment = { PATH: "/bin", HOME: "/home/test" };
  const pendingReady = new Promise(() => {});
  const closePromise = new Promise(() => {});
  const fake = fakeFactories(environment, { pendingReady, closePromise });
  const runtime = await createSharedRailRuntime({
    environment,
    resolveRuntime: fake.resolveRuntime,
    launcherFactory: fake.launcherFactory,
    clientFactory: fake.clientFactory,
    loadConfiguration: configuration,
    subscriptionCloseTimeoutMs: 10,
  });
  const handle = runtime.openRepositorySubscription({ context: { cwd: "/selected", environment }, onDelivery() {} });
  const startedAt = Date.now();
  await handle.close();
  assert.ok(Date.now() - startedAt < 200);
  assert.equal(fake.records[0].closed, 1);
});

test("explicit in-process mode is selected before shared runtime construction", async () => {
  await assert.rejects(
    createSharedRailRuntime({ environment: { SIDERAIL_STATE_MODE: "in-process" } }),
    (error) => error.code === "GIT_STATE_IN_PROCESS_REQUESTED",
  );
});

test("real facade and daemon derive one namespace and deliver repository state", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-shared-facade-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hostSocketPath = path.join(root, "herdr.sock");
  await fs.writeFile(hostSocketPath, "isolated identity fixture");
  const environment = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_RUNTIME_DIR: root,
    HERDR_SOCKET_PATH: hostSocketPath,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    SIDERAIL_POLL_INTERVAL_MS: "60000",
    SIDERAIL_RECONCILE_INTERVAL_MS: "60000",
  };
  const runtime = await createSharedRailRuntime({ environment });
  const seen = [];
  const subscription = runtime.openRepositorySubscription({
    context: { cwd: process.cwd(), environment },
    onDelivery: (value) => seen.push(value),
  });
  const initial = await subscription.ready;
  assert.equal(initial.snapshot.cwd, process.cwd());
  assert.ok(initial.snapshot.branch);
  assert.ok(seen.length >= 1);
  await subscription.close();
  await runtime.close();
  await waitFor(async () => {
    try { await fs.access(runtime.paths.leasePath); return false; }
    catch { return true; }
  });
});

test("real in-process fallback remains refreshable and closes its engine", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gr-local-fallback-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const environment = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"),
    GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" };
  const fake = fakeFactories(environment, { readyError: "GIT_STATE_IDENTITY_UNSUPPORTED" });
  const runtime = await createSharedRailRuntime({ environment, ...fake, loadConfiguration: configuration });
  t.after(() => runtime.close());
  const handle = runtime.openRepositorySubscription({ context: { cwd: root }, onDelivery() {} });
  const first = await handle.ready;
  assert.equal(first.snapshot.repoRoot, "");
  assert.equal(handle.transport, "in-process");
  assert.equal(runtime.status.fallbackSubscriptions, 1);
  assert.equal(runtime.status.repositorySubscriptions, 1);
  await fs.writeFile(path.join(root, "new.txt"), "new file\n");
  const updated = await handle.refresh();
  assert.ok(updated.snapshot.files.some((file) => file.path === "new.txt"));
  assert.ok(updated.stateGeneration > first.stateGeneration);
  assert.equal(handle.latest(), updated);
  await runtime.close();
  assert.equal(runtime.status.closed, true);
  await assert.rejects(handle.refresh(), { code: "GIT_STATE_SUBSCRIPTION_CLOSED" });
  assert.throws(() => runtime.subscribeHost({ railPaneId: "rail" }, () => {}), { code: "GIT_STATE_RUNTIME_CLOSED" });
  assert.throws(() => runtime.openRepositorySubscription({ context: { cwd: root }, onDelivery() {} }), { code: "GIT_STATE_RUNTIME_CLOSED" });
});

test("manual refresh switches on a typed size failure but preserves ordinary errors", async (t) => {
  for (const code of ["GIT_STATE_SNAPSHOT_TOO_LARGE", "GIT_STATE_UNAVAILABLE"]) {
    const environment = { PATH: "/bin", HOME: "/fixture" };
    const fake = fakeFactories(environment, { refreshError: Object.assign(new Error(code), { code }) });
    let refreshes = 0;
    const runtime = await createSharedRailRuntime({ environment, ...fake, loadConfiguration: configuration,
      openInProcessSubscription() {
        const initial = delivery({ files: [], commitPathIndex: new Map() });
        return { ready: Promise.resolve(initial), latest: () => initial, close() {},
          async refresh() { refreshes += 1; return delivery({ files: ["fresh"], commitPathIndex: new Map() }, 2); } };
      },
    });
    t.after(() => runtime.close());
    const handle = runtime.openRepositorySubscription({ context: { cwd: "/fixture" }, onDelivery() {} });
    await handle.ready;
    if (code === "GIT_STATE_UNAVAILABLE") {
      await assert.rejects(handle.refresh(), { code }); assert.equal(refreshes, 0);
    } else {
      assert.deepEqual((await handle.refresh()).snapshot.files, ["fresh"]);
      assert.equal(refreshes, 1);
      assert.equal(handle.fallbackReason, "snapshot-oversize");
    }
  }
});

test("facade rejects malformed identities and invalid subscription contracts", async (t) => {
  const environment = { PATH: "/bin", HOME: "/fixture" };
  const fake = fakeFactories(environment);
  await assert.rejects(createSharedRailRuntime({ environment, ...fake, resolveRuntime: async () => ({}), loadConfiguration: configuration }), /incomplete/);
  await assert.rejects(createSharedRailRuntime({ environment, ...fake,
    resolveRuntime: async () => ({ ...runtimeFor(environment), identity: { ...runtimeFor(environment).identity, effectiveConfigId: "wrong" } }),
    loadConfiguration: configuration }), { code: "GIT_STATE_RUNTIME_SEMANTICS_MISMATCH" });
  assert.throws(() => resolveSharedRuntimeSemantics({ SIDERAIL_WATCH_MODE: "invalid" }, { loadConfiguration: configuration }), /WATCH_MODE/);
  const runtime = await createSharedRailRuntime({ environment, ...fake, loadConfiguration: configuration });
  t.after(() => runtime.close());
  assert.throws(() => runtime.openRepositorySubscription({ context: {}, onDelivery() {} }), /context.cwd/);
  assert.throws(() => runtime.openRepositorySubscription({ context: { cwd: "/fixture" } }), /onDelivery/);
  const status = { status: "error" };
  assert.equal(localizeRepositoryDelivery(status), status);
});
