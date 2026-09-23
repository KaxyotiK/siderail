import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGitStateClient, createGitStateCoordinatorLauncher } from "../src/git-state-client.mjs";
import { createGitStateCoordinator } from "../src/git-state-coordinator.mjs";
import { createFrameDecoder, encodeFrame, PROTOCOL_VERSION } from "../src/git-state-protocol.mjs";
import { readProcessStartIdentity, resolveGitStateRuntime } from "../src/git-state-runtime.mjs";
import { createRepositoryEngine } from "../src/repository-engine.mjs";
import { getRepositoryState } from "../src/git-provider.mjs";
import { runGit } from "../src/process.mjs";

const identity = Object.freeze({
  kind: "git",
  canonicalCwd: "/fixture/subdirectory",
  worktreeRoot: "/fixture",
  gitDir: "/fixture/.git",
  commonGitDir: "/fixture/.git",
  indexPath: "/fixture/.git/index",
  identityId: "shared-fixture",
});

function snapshot(value) {
  return {
    cwd: "/fixture",
    repoRoot: "/fixture",
    value,
    commitPathIndex: new Map([[`commit-${value}`, [`file-${value}.txt`]]]),
  };
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition did not become true");
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-coordinator-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, socketPath: path.join(root, "coordinator.sock") };
}

class CoordinatorFixtureSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.allowWrites = false;
    this.messages = [];
    this.decoder = createFrameDecoder({ onMessage: (message) => this.messages.push(message) });
  }
  setNoDelay() {}
  write(frame) {
    this.decoder.push(frame);
    return this.allowWrites;
  }
  feed(message) { this.emit("data", encodeFrame(message)); }
  destroy(error) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroyError = error;
    if (error) this.emit("error", error);
    this.emit("close");
  }
}

async function fakeCoordinatorServer(t, options = {}) {
  const { socketPath } = await fixture(t);
  await fs.writeFile(socketPath, "");
  let accept;
  const server = new EventEmitter();
  server.listening = false;
  server.listen = () => {
    server.listening = true;
    queueMicrotask(() => server.emit("listening"));
  };
  server.close = (callback) => {
    server.listening = false;
    callback();
  };
  const coordinator = createGitStateCoordinator({
    namespaceId: "transport-namespace",
    createServer(listener) { accept = listener; return server; },
    ...options,
  });
  t.after(() => coordinator.close());
  await coordinator.listen(socketPath);
  return { coordinator, accept };
}

test("coordinator transport drains controls in order and enforces blocked-write bounds", async (t) => {
  const timers = [];
  const { accept } = await fakeCoordinatorServer(t, {
    setTimer(callback) {
      const timer = { callback, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { if (timer) timer.cleared = true; },
  });
  const socket = new CoordinatorFixtureSocket();
  accept(socket);
  socket.feed({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    namespaceId: "transport-namespace",
    clientId: "fixture-client",
  });
  socket.feed({ type: "ping", nonce: "first" });
  socket.feed({ type: "ping", nonce: "second" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.messages.map(({ type }) => type), ["hello_ack"]);
  socket.allowWrites = true;
  socket.emit("drain");
  assert.deepEqual(socket.messages.map(({ type }) => type), ["hello_ack", "pong", "pong"]);
  assert.deepEqual(socket.messages.slice(1).map(({ nonce }) => nonce), ["first", "second"]);

  socket.allowWrites = false;
  socket.feed({ type: "ping", nonce: "blocked" });
  await new Promise((resolve) => setImmediate(resolve));
  const blockedTimer = timers.findLast((timer) => !timer.cleared);
  blockedTimer.callback();
  assert.equal(socket.destroyError?.code, "GIT_STATE_BACKPRESSURE_TIMEOUT");

  const limited = new CoordinatorFixtureSocket();
  accept(limited);
  limited.feed({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    namespaceId: "transport-namespace",
    clientId: "bounded-client",
  });
  for (let index = 0; index < 129; index += 1) {
    limited.feed({ type: "ping", nonce: String(index) });
  }
  await waitFor(() => limited.destroyed);
  assert.equal(limited.destroyError?.code, "GIT_STATE_BACKPRESSURE_LIMIT");
});

test("eight socket clients share one engine build and one edit build", async (t) => {
  const { socketPath } = await fixture(t);
  let engineFactories = 0;
  let builds = 0;
  const coordinator = createGitStateCoordinator({
    namespaceId: "fixture-namespace",
    resolveIdentity: async () => identity,
    engineFactory: ({ context }) => {
      engineFactories += 1;
      return createRepositoryEngine({
        context,
        readState: async () => snapshot(++builds),
      });
    },
  });
  t.after(() => coordinator.close());
  await coordinator.listen(socketPath);

  const clients = Array.from({ length: 8 }, () => createGitStateClient({
    namespaceId: "fixture-namespace",
    socketPath,
  }));
  t.after(() => Promise.allSettled(clients.map((client) => client.close())));
  const received = clients.map(() => []);
  const handles = clients.map((client, index) => client.openRepositorySubscription({
    context: { cwd: `/fixture/subdirectory-${index}`, environment: { PRIVATE: `client-${index}` } },
    onDelivery: (delivery) => received[index].push(delivery),
  }));
  const initial = await Promise.all(handles.map((handle) => handle.ready));
  assert.deepEqual(initial.map(({ snapshot: state }) => state.value), Array(8).fill(1));
  assert.ok(initial.every(({ snapshot: state }) => state.commitPathIndex instanceof Map));
  assert.equal(engineFactories, 1);
  assert.equal(builds, 1);
  assert.equal(coordinator.status.repositorySubscriptions, 8);

  const updated = await handles[0].refresh("tracked-edit");
  assert.equal(updated.snapshot.value, 2);
  await waitFor(() => handles.every((handle) => handle.latest()?.snapshot.value === 2));
  assert.equal(builds, 2);
  assert.deepEqual(handles.map((handle) => handle.latest().stateGeneration), Array(8).fill(2));

  await Promise.all(clients.map((client) => client.close()));
  await waitFor(() => coordinator.status.sessions === 0 && coordinator.status.engines === 0);
});

test("a disconnected client resubscribes and maps a restarted engine to a fresh local generation", async (t) => {
  const { socketPath } = await fixture(t);
  let incarnation = 1;
  const coordinator = () => createGitStateCoordinator({
    namespaceId: "reconnect-namespace",
    resolveIdentity: async () => identity,
    engineFactory: ({ context }) => createRepositoryEngine({
      context,
      readState: async () => snapshot(incarnation),
    }),
  });
  let active = coordinator();
  await active.listen(socketPath);
  t.after(async () => { await active.close(); });
  const client = createGitStateClient({ namespaceId: "reconnect-namespace", socketPath });
  t.after(() => client.close());
  const deliveries = [];
  const handle = client.openRepositorySubscription({
    context: { cwd: "/fixture" },
    onDelivery: (delivery) => deliveries.push(delivery),
  });
  assert.equal((await handle.ready).snapshot.value, 1);

  await active.close();
  await fs.unlink(socketPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  incarnation = 2;
  active = coordinator();
  await active.listen(socketPath);
  const restored = await waitFor(() => deliveries.find(({ snapshot: state }) => state.value === 2));
  assert.equal(restored.stateGeneration, 2);
  assert.equal(handle.latest().snapshot.value, 2);
});

test("host refresh suppresses unchanged context and reconnect follows a moved rail terminal", async (t) => {
  const { socketPath } = await fixture(t);
  let sourceFactories = 0;
  let refreshes = 0;
  let context = {
    cwd: "/fixture",
    sourcePaneId: "source",
    tabId: "tab",
    workspaceId: "workspace",
    railPaneId: "rail-before-move",
    railTerminalId: "terminal",
    hasContent: true,
    visible: true,
  };
  let listener;
  const selectors = [];
  const coordinator = () => createGitStateCoordinator({
    namespaceId: "host-namespace",
    resolveIdentity: async () => identity,
    hostSourceFactory: () => {
      sourceFactories += 1;
      return {
        subscribe(selector, next) {
          selectors.push(selector);
          listener = next;
          return { ready: Promise.resolve(context), context, unsubscribe() {} };
        },
        async requestRefresh() { refreshes += 1; return { ok: true }; },
        close() {},
      };
    },
  });
  let active = coordinator();
  t.after(() => active.close());
  await active.listen(socketPath);
  const client = createGitStateClient({ namespaceId: "host-namespace", socketPath });
  t.after(() => client.close());
  const delivered = [];
  const handle = client.subscribeHost({ railPaneId: "rail-before-move" }, (value) => delivered.push(value));
  assert.deepEqual(await handle.ready, context);
  assert.equal(sourceFactories, 1);
  await handle.refresh("manual-context");
  assert.equal(refreshes, 1);
  assert.equal(delivered.length, 1);

  context = { ...context, railPaneId: "rail-after-move" };
  listener(context);
  await waitFor(() => handle.latest()?.railPaneId === "rail-after-move");
  assert.equal(delivered.length, 2);

  await active.close();
  await fs.unlink(socketPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  active = coordinator();
  await active.listen(socketPath);
  await waitFor(() => selectors.length === 2);
  assert.deepEqual(selectors[1], {
    railPaneId: "rail-after-move",
    railTerminalId: "terminal",
  });
  assert.equal(sourceFactories, 2);
});

test("a non-repository engine migrates to the Git identity when a late client joins", async (t) => {
  const { root, socketPath } = await fixture(t);
  const repository = path.join(root, "new-repository");
  await fs.mkdir(repository);
  const environment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
  };
  let factories = 0;
  let builds = 0;
  const coordinator = createGitStateCoordinator({
    namespaceId: "identity-migration",
    environment,
    engineFactory: ({ context }) => {
      factories += 1;
      return createRepositoryEngine({
        context,
        readState: async () => {
          builds += 1;
          return getRepositoryState(context.cwd, { env: environment });
        },
      });
    },
  });
  t.after(() => coordinator.close());
  await coordinator.listen(socketPath);
  const firstClient = createGitStateClient({ namespaceId: "identity-migration", socketPath });
  const first = firstClient.openRepositorySubscription({ context: { cwd: repository }, onDelivery() {} });
  assert.equal((await first.ready).snapshot.repoRoot, "");
  await runGit(repository, ["init", "--initial-branch=main"]);
  assert.equal((await first.refresh("repository-created")).snapshot.repoRoot, await fs.realpath(repository));

  const secondClient = createGitStateClient({ namespaceId: "identity-migration", socketPath });
  const second = secondClient.openRepositorySubscription({ context: { cwd: repository }, onDelivery() {} });
  assert.equal((await second.ready).snapshot.repoRoot, await fs.realpath(repository));
  assert.equal(factories, 1);
  assert.equal(builds, 2);
  await Promise.all([firstClient.close(), secondClient.close()]);
});

test("relocated Git metadata gets a distinct engine instead of relabeling an active context", async (t) => {
  const { root, socketPath } = await fixture(t);
  const repository = path.join(root, "repository");
  await fs.mkdir(repository);
  const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };
  await runGit(repository, ["init", "--initial-branch=main"], { baseEnv: environment });
  const contexts = [];
  const coordinator = createGitStateCoordinator({
    namespaceId: "git-directory-relocation",
    environment,
    engineFactory: ({ context }) => {
      contexts.push(context);
      return createRepositoryEngine({ context });
    },
  });
  t.after(() => coordinator.close());
  await coordinator.listen(socketPath);
  const clients = Array.from({ length: 3 }, () => createGitStateClient({ namespaceId: "git-directory-relocation", socketPath }));
  t.after(() => Promise.all(clients.map((client) => client.close())));
  const open = (client) => client.openRepositorySubscription({ context: { cwd: repository }, onDelivery() {} });
  const first = open(clients[0]);
  const initial = await first.ready;
  const relocated = path.join(root, "metadata");
  await runGit(repository, ["init", "--separate-git-dir", relocated], { baseEnv: environment });
  const second = open(clients[1]);
  const next = await second.ready;
  assert.equal(contexts.length, 2);
  assert.notEqual(next.engineKey, initial.engineKey);
  assert.equal(contexts[0].repositoryIdentity.gitDir, path.join(await fs.realpath(repository), ".git"));
  assert.equal(contexts[1].repositoryIdentity.gitDir, await fs.realpath(relocated));
  assert.equal((await first.refresh()).engineKey, initial.engineKey);
  const third = open(clients[2]);
  assert.equal((await third.ready).engineKey, next.engineKey);
  assert.equal(contexts.length, 2, "later clients share the new identity's engine");
});

test("an unencodable snapshot is typed and remains non-shareable for that engine key", async (t) => {
  const { socketPath } = await fixture(t);
  let factories = 0;
  const coordinator = createGitStateCoordinator({
    namespaceId: "oversize-namespace",
    resolveIdentity: async () => identity,
    engineFactory: ({ context }) => {
      factories += 1;
      return createRepositoryEngine({
        context,
        readState: async () => ({
          ...snapshot(1),
          unsupported: new Map([["not", "commitPathIndex"]]),
        }),
      });
    },
  });
  t.after(() => coordinator.close());
  await coordinator.listen(socketPath);
  const client = createGitStateClient({ namespaceId: "oversize-namespace", socketPath });
  t.after(() => client.close());
  const first = client.openRepositorySubscription({ context: { cwd: "/fixture" }, onDelivery() {} });
  await assert.rejects(first.ready, { code: "GIT_STATE_SNAPSHOT_UNSHAREABLE" });
  const second = client.openRepositorySubscription({ context: { cwd: "/fixture" }, onDelivery() {} });
  await assert.rejects(second.ready, { code: "GIT_STATE_SNAPSHOT_UNSHAREABLE" });
  assert.equal(factories, 1);
});

test("atomic launch claims allow one child and reclaim a dead owner", async (t) => {
  const { root, socketPath } = await fixture(t);
  const leasePath = path.join(root, "owner.json");
  let spawns = 0;
  const spawnProcess = () => {
    spawns += 1;
    const child = new EventEmitter();
    child.pid = 40_000 + spawns;
    child.exitCode = null;
    child.killed = false;
    child.unref = () => {};
    return child;
  };
  const launcher = () => createGitStateCoordinatorLauncher({
    namespaceId: "launch-namespace",
    socketPath,
    leasePath,
    launcherPath: "/fixture/launcher.mjs",
    spawnProcess,
  });
  const results = await Promise.all(Array.from({ length: 8 }, () => launcher().launch()));
  assert.equal(results.filter(({ owner }) => owner).length, 1);
  assert.equal(spawns, 1);

  await fs.writeFile(leasePath, JSON.stringify({ nonce: "dead", pid: 999_999_999 }), { mode: 0o600 });
  const reclaimed = await Promise.all(Array.from({ length: 8 }, () => createGitStateCoordinatorLauncher({
    namespaceId: "launch-namespace",
    socketPath,
    leasePath,
    launcherPath: "/fixture/launcher.mjs",
    spawnProcess,
    staleClaimMs: 0,
  }).launch()));
  assert.equal(reclaimed.filter(({ owner }) => owner).length, 1);
  assert.equal(spawns, 2);

  const liveLease = path.join(root, "live-owner.json");
  await fs.writeFile(liveLease, JSON.stringify({
    nonce: "live-claim",
    claimantPid: process.pid,
    claimantStartIdentity: await readProcessStartIdentity(process.pid),
    namespaceId: "launch-namespace",
    createdAt: 0,
  }), { mode: 0o600 });
  await fs.utimes(liveLease, new Date(0), new Date(0));
  const live = createGitStateCoordinatorLauncher({
    namespaceId: "launch-namespace",
    socketPath: path.join(root, "live.sock"),
    leasePath: liveLease,
    launcherPath: "/fixture/launcher.mjs",
    spawnProcess,
    staleClaimMs: 0,
  });
  assert.deepEqual(await live.launch(), { owner: false });
  assert.equal(spawns, 2);

  const crashedElectionLease = path.join(root, "crashed-election-owner.json");
  const crashedElection = `${crashedElectionLease}.election`;
  await fs.mkdir(crashedElection);
  await fs.writeFile(path.join(crashedElection, "owner.json"), JSON.stringify({
    nonce: "abandoned-election",
    pid: 999_999_999,
    processStartIdentity: "dead",
    createdAt: 0,
  }), { mode: 0o600 });
  await fs.utimes(crashedElection, new Date(0), new Date(0));
  const afterCrash = createGitStateCoordinatorLauncher({
    namespaceId: "launch-namespace",
    socketPath: path.join(root, "crashed-election.sock"),
    leasePath: crashedElectionLease,
    launcherPath: "/fixture/launcher.mjs",
    spawnProcess,
    staleClaimMs: 0,
  });
  assert.deepEqual(await afterCrash.launch(), { owner: true, pid: 40_003 });
  assert.equal(spawns, 3);
  await assert.rejects(fs.access(crashedElection), { code: "ENOENT" });
});

test("the thin launcher starts one real daemon and records its complete lifecycle", async (t) => {
  const { root } = await fixture(t);
  const repository = path.join(root, "repo");
  const performanceLog = path.join(root, "performance.ndjson");
  const hostSocketPath = path.join(root, "herdr.sock");
  await fs.mkdir(repository);
  await fs.writeFile(hostSocketPath, "fixture");
  await runGit(repository, ["init", "--initial-branch=main"]);
  const environment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    SIDERAIL_PERFORMANCE_LOG: performanceLog,
    HERDR_SOCKET_PATH: hostSocketPath,
    XDG_RUNTIME_DIR: root,
  };
  const resolved = await resolveGitStateRuntime({ environment });
  const { namespaceId } = resolved.identity;
  const { socketPath, leasePath } = resolved.paths;
  const launcher = createGitStateCoordinatorLauncher({
    namespaceId,
    socketPath,
    leasePath,
    environment,
  });
  const client = createGitStateClient({
    namespaceId,
    socketPath,
    launchCoordinator: launcher.launch,
    connectTimeoutMs: 5_000,
  });
  t.after(() => client.close());
  const ownedPids = new Map();
  t.after(async () => {
    for (const [pid, startIdentity] of ownedPids) {
      const current = await readProcessStartIdentity(pid).catch(() => null);
      if (current === startIdentity) {
        try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
  });
  const readActiveOwner = async () => {
    const lease = JSON.parse(await fs.readFile(leasePath, "utf8"));
    return JSON.parse(await fs.readFile(`${leasePath}.${lease.nonce}.owner.json`, "utf8"));
  };
  const deliveries = [];
  const handle = client.openRepositorySubscription({
    context: { cwd: repository },
    onDelivery(delivery) { deliveries.push(delivery); },
  });
  const initial = await handle.ready;
  assert.equal(initial.snapshot.repoRoot, await fs.realpath(repository));
  assert.ok(initial.snapshot.commitPathIndex instanceof Map);
  const firstOwner = await waitFor(async () => {
    try { return await readActiveOwner(); } catch { return null; }
  });
  ownedPids.set(firstOwner.pid, firstOwner.processStartIdentity);
  assert.equal(firstOwner.namespaceId, namespaceId);
  assert.equal(firstOwner.processStartIdentity, await readProcessStartIdentity(firstOwner.pid));

  process.kill(firstOwner.pid, "SIGKILL");
  await waitFor(() => deliveries.at(-1)?.status === "stale");
  await fs.writeFile(path.join(repository, "after-crash.txt"), "visible after restart\n");
  const secondOwner = await waitFor(async () => {
    try {
      const owner = await readActiveOwner();
      return owner.pid !== firstOwner.pid ? owner : null;
    } catch { return null; }
  }, 5_000);
  ownedPids.set(secondOwner.pid, secondOwner.processStartIdentity);
  assert.equal(secondOwner.namespaceId, namespaceId);
  assert.equal(secondOwner.processStartIdentity, await readProcessStartIdentity(secondOwner.pid));
  await waitFor(() => handle.latest()?.snapshot.untracked.some(({ path: file }) => file === "after-crash.txt"), 5_000);
  assert.ok(handle.latest().stateGeneration > initial.stateGeneration);

  await client.close();
  await waitFor(async () => {
    try { await fs.access(leasePath); return false; }
    catch { return true; }
  }, 4_000);
  const records = (await fs.readFile(performanceLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.filter(({ event }) => event === "component").map(({ phase }) => phase), [
    "started", "ready", "started", "ready", "stopped",
  ]);
  assert.ok(records.every(({ owner }) => owner === namespaceId));
});

test("a client that disconnects while its repository identity resolves leaves the coordinator idle", async (t) => {
  let resolveLookup;
  let engineClosed = false;
  let idle = 0;
  const { coordinator, accept } = await fakeCoordinatorServer(t, {
    resolveIdentity: () => new Promise((resolve) => { resolveLookup = resolve; }),
    engineFactory: () => ({
      ready: Promise.resolve(),
      subscribe: () => () => {},
      close: async () => { engineClosed = true; },
    }),
    onIdle: () => { idle += 1; },
  });
  const socket = new CoordinatorFixtureSocket();
  socket.allowWrites = true;
  accept(socket);
  socket.feed({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    namespaceId: "transport-namespace",
    clientId: "short-lived-rail",
  });
  socket.feed({
    type: "repository_subscribe",
    requestId: "subscribe-1",
    subscriptionId: "repository-1",
    cwd: "/fixture",
    namespaceId: "transport-namespace",
  });
  await waitFor(() => resolveLookup);
  socket.destroy();
  resolveLookup(identity);
  await waitFor(() => engineClosed && coordinator.status.engines === 0);
  assert.deepEqual(
    { sessions: coordinator.status.sessions, subscriptions: coordinator.status.repositorySubscriptions },
    { sessions: 0, subscriptions: 0 },
  );
  assert.ok(idle > 0);
  assert.equal(socket.messages.some((message) => message.type === "response"), false);
});
