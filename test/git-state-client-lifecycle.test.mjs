import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { URL } from "node:url";
import { promisify } from "node:util";
import { createGitStateClient } from "../src/git-state-client.mjs";
import { createGitStateCoordinator } from "../src/git-state-coordinator.mjs";
import { createRepositoryEngine } from "../src/repository-engine.mjs";
import { createFrameDecoder, encodeFrame, encodeSnapshot, PROTOCOL_VERSION } from "../src/git-state-protocol.mjs";

const namespaceId = "client-lifecycle-fixture";
const execFileAsync = promisify(execFile);

function bounded(promise, milliseconds = 1_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("client operation exceeded test deadline")), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

async function until(predicate) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("client condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FixtureSocket extends EventEmitter {
  constructor({ handshake = true, value = "first" } = {}) {
    super();
    this.destroyed = false;
    this.writes = [];
    this.blockWrites = false;
    this.handshake = handshake;
    this.responses = true;
    this.value = value;
    this.decoder = createFrameDecoder({ onMessage: (message) => this.receive(message) });
  }
  write(frame) {
    this.decoder.push(frame);
    return !this.blockWrites;
  }
  send(message) {
    queueMicrotask(() => { if (!this.destroyed) this.emit("data", encodeFrame(message)); });
  }
  receive(message) {
    this.writes.push(message);
    if (message.type === "hello") {
      if (this.handshake) this.send({ type: "hello_ack", protocolVersion: PROTOCOL_VERSION, namespaceId, coordinatorId: this.value });
      return;
    }
    if (message.type === "repository_subscribe") {
      this.send({ type: "repository_delivery", subscriptionId: message.subscriptionId, delivery: {
        engineKey: "fixture", stateGeneration: 1, inputGeneration: 1, status: "healthy",
        refreshedAt: 0, reconciliationDueAt: null,
        snapshot: encodeSnapshot({ cwd: "/fixture", repoRoot: "/fixture", value: this.value, commitPathIndex: new Map() }),
      } });
    }
    if (this.responses) this.send({ type: "response", requestId: message.requestId, ok: true,
      value: { stateGeneration: 1, inputGeneration: 1 } });
  }
  destroy(error) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroyError = error;
    if (error) this.emit("error", error);
    this.emit("close");
  }
  drain() { this.blockWrites = false; this.emit("drain"); }
}

function clientFor(connect, options = {}) {
  return createGitStateClient({ namespaceId, socketPath: "/unused-fixture.sock", connect,
    connectTimeoutMs: 40, handshakeTimeoutMs: 10, requestTimeoutMs: 100,
    retryDelayMs: 5, maxRetryDelayMs: 10, ...options });
}

function subscribe(client, onDelivery = () => {}) {
  return client.openRepositorySubscription({ context: { cwd: "/fixture" }, onDelivery });
}

test("a silent handshake expires and close settles without an abandoned connection", async (t) => {
  const sockets = [];
  const client = clientFor(async () => {
    const socket = new FixtureSocket({ handshake: false }); sockets.push(socket); return socket;
  });
  t.after(() => bounded(client.close()));
  const handle = subscribe(client);
  await assert.rejects(bounded(handle.ready), (error) => error.code === "GIT_STATE_UNAVAILABLE"
    && error.cause?.code === "GIT_STATE_HANDSHAKE_TIMEOUT");
  await bounded(client.close());
  assert.ok(sockets.length >= 1);
  assert.ok(sockets.every((socket) => socket.destroyed));
  assert.equal(client.status.pendingRequests, 0);
});

test("initial connection sends exactly one repository subscription", async (t) => {
  const socket = new FixtureSocket();
  const client = clientFor(async () => socket);
  t.after(() => bounded(client.close()));
  const handle = subscribe(client);
  assert.equal((await bounded(handle.ready)).snapshot.value, "first");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.writes.filter(({ type }) => type === "repository_subscribe").length, 1);
  assert.equal(socket.writes.filter(({ type }) => type === "hello").length, 1);
});

test("blocked client controls wait for drain and then flush in order", async (t) => {
  const socket = new FixtureSocket();
  const client = clientFor(async () => socket);
  t.after(() => bounded(client.close()));
  const handle = subscribe(client); await bounded(handle.ready);
  await new Promise((resolve) => setImmediate(resolve));
  socket.blockWrites = true;
  const first = handle.refresh("first");
  await until(() => socket.writes.some(({ reason }) => reason === "first"));
  const queued = [handle.refresh("second"), handle.refresh("third")];
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.writes.filter(({ type }) => type === "repository_refresh").map(({ reason }) => reason), ["first"]);
  assert.equal(client.status.blocked, true);
  socket.drain();
  await bounded(Promise.all([first, ...queued]));
  assert.deepEqual(socket.writes.filter(({ type }) => type === "repository_refresh").map(({ reason }) => reason), ["first", "second", "third"]);
  assert.equal(client.status.blocked, false);
});

for (const limit of ["count", "bytes"]) {
  test(`blocked client controls enforce the ${limit} bound and release pending requests`, async (t) => {
    const socket = new FixtureSocket();
    const client = clientFor(async () => {
      if (socket.destroyed) throw new Error("fixture coordinator is down");
      return socket;
    });
    t.after(() => bounded(client.close()));
    const handle = subscribe(client); await bounded(handle.ready);
    await new Promise((resolve) => setImmediate(resolve));
    socket.blockWrites = true;
    const blocked = handle.refresh("block");
    await until(() => client.status.blocked);
    const reason = limit === "bytes" ? "x".repeat(600_000) : "queued";
    const count = limit === "bytes" ? 2 : 129;
    const results = await bounded(Promise.allSettled([
      blocked, ...Array.from({ length: count }, () => handle.refresh(reason)),
    ]));
    assert.equal(socket.destroyError?.code, "GIT_STATE_BACKPRESSURE_LIMIT");
    assert.ok(results.some((result) => result.status === "rejected" && result.reason.code === "GIT_STATE_BACKPRESSURE_LIMIT"));
    assert.equal(socket.writes.filter(({ type }) => type === "repository_refresh").length, 1);
    await bounded(client.close());
    assert.equal(client.status.pendingRequests, 0);
  });
}

test("disconnect retains stale state and retries beyond a failed connection window", async (t) => {
  const first = new FixtureSocket();
  const second = new FixtureSocket({ value: "restarted" });
  let availableAt = Infinity;
  let attempts = 0;
  const client = clientFor(async () => {
    attempts += 1;
    if (!first.destroyed) return first;
    if (Date.now() < availableAt) throw new Error("fixture coordinator is down");
    return second;
  }, { connectTimeoutMs: 20 });
  t.after(() => bounded(client.close()));
  const deliveries = [];
  const handle = subscribe(client, (delivery) => deliveries.push(delivery));
  await bounded(handle.ready);
  await new Promise((resolve) => setImmediate(resolve));
  availableAt = Date.now() + 100;
  first.destroy();
  assert.equal(deliveries.at(-1).status, "stale");
  assert.equal(deliveries.at(-1).snapshot.value, "first");
  await until(() => client.status.lastConnectionError?.code === "GIT_STATE_UNAVAILABLE");
  await until(() => handle.latest()?.snapshot.value === "restarted");
  assert.equal(handle.latest().stateGeneration, 2);
  assert.equal(handle.latest().status, "healthy");
  assert.ok(attempts > 3);
  assert.equal(second.writes.filter(({ type }) => type === "repository_subscribe").length, 1);
});

test("a coordinator that never drains is disconnected at the blocked-write deadline", async (t) => {
  const socket = new FixtureSocket();
  const client = clientFor(async () => {
    if (socket.destroyed) throw new Error("fixture coordinator is down");
    return socket;
  }, { blockedWriteMs: 15 });
  t.after(() => bounded(client.close()));
  const handle = subscribe(client); await bounded(handle.ready);
  await new Promise((resolve) => setImmediate(resolve));
  socket.blockWrites = true;
  await bounded(handle.refresh("block-without-drain"));
  await until(() => socket.destroyed);
  assert.equal(socket.destroyError.code, "GIT_STATE_BACKPRESSURE_TIMEOUT");
  assert.equal(handle.latest().status, "stale");
});

test("unanswered requests time out and do not make unsubscribe or client close hang", async (t) => {
  const socket = new FixtureSocket();
  const client = clientFor(async () => socket, { requestTimeoutMs: 20 });
  t.after(() => bounded(client.close()));
  const handle = subscribe(client); await bounded(handle.ready);
  await new Promise((resolve) => setImmediate(resolve));
  socket.responses = false;
  await assert.rejects(bounded(handle.refresh("unanswered")), { code: "GIT_STATE_REQUEST_TIMEOUT" });
  assert.equal(client.status.pendingRequests, 0);
  await bounded(client.close());
  assert.equal(socket.destroyed, true);
  assert.equal(client.status.subscriptions, 0);
  await assert.rejects(handle.refresh(), /closed/);
});

test("closing before connect finishes destroys the arriving socket and suppresses state", async () => {
  let finishConnect;
  const socket = new FixtureSocket();
  const deliveries = [];
  const client = clientFor(() => new Promise((resolve) => { finishConnect = resolve; }));
  const handle = subscribe(client, (delivery) => deliveries.push(delivery));
  const closing = client.close();
  await new Promise((resolve) => setImmediate(resolve));
  finishConnect(socket);
  await bounded(closing);
  await assert.rejects(handle.ready, /closed/);
  assert.equal(socket.destroyed, true);
  assert.deepEqual(deliveries, []);
  assert.equal(await client.close(), undefined);
});

test("an initial retry keeps a standalone process alive until ready settles", async () => {
  const clientModule = new URL("../src/git-state-client.mjs", import.meta.url).href;
  const source = `
    import { createGitStateClient } from ${JSON.stringify(clientModule)};
    const client = createGitStateClient({
      namespaceId: "standalone-fixture",
      socketPath: "/definitely/missing/git-state.sock",
      connectTimeoutMs: 40,
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
    });
    const handle = client.openRepositorySubscription({ context: { cwd: "/fixture" }, onDelivery() {} });
    await handle.ready.then(
      () => { throw new Error("unexpected delivery"); },
      (error) => process.stdout.write(error.code),
    );
    await client.close();
  `;
  const result = await execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
    timeout: 2_000,
  });
  assert.equal(result.stdout, "GIT_STATE_UNAVAILABLE");
});

test("an independent Node client connects successfully after its initial refusal", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gr-start-"));
  const socketPath = path.join(root, "s");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const coordinator = createGitStateCoordinator({ namespaceId,
    resolveIdentity: async () => ({ canonicalCwd: "/fixture", identityId: "fixture" }),
    engineFactory: ({ context }) => createRepositoryEngine({ context,
      readState: async () => ({ cwd: "/fixture", repoRoot: "/fixture", commitPathIndex: new Map() }),
    }),
  });
  await coordinator.listen(socketPath);
  t.after(() => coordinator.close());
  const source = `
    import net from 'node:net';
    import {createGitStateClient} from ${JSON.stringify(new URL("../src/git-state-client.mjs", import.meta.url).href)};
    let attempts = 0;
    const client = createGitStateClient({namespaceId:${JSON.stringify(namespaceId)}, socketPath:${JSON.stringify(socketPath)},
      retryDelayMs:20, connect:async () => {
        if (++attempts === 1) throw new Error('simulated first connection refusal');
        return new Promise((resolve,reject) => {
          const socket = net.createConnection({path:${JSON.stringify(socketPath)}});
          socket.once('connect',() => resolve(socket)); socket.once('error',reject);
        });
      }});
    const handle = client.openRepositorySubscription({context:{cwd:'/fixture'},onDelivery(){}});
    const state = await handle.ready;
    process.stdout.write(JSON.stringify({attempts,root:state.snapshot.repoRoot}));
    await client.close();
  `;
  const result = await execFileAsync(process.execPath, ["--input-type=module", "--eval", source], { timeout: 3_000 });
  assert.deepEqual(JSON.parse(result.stdout), { attempts: 2, root: "/fixture" });
});
