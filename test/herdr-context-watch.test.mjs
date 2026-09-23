import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHerdrContextSource, readHerdrSessionSnapshot } from "../src/herdr-context-watch.mjs";

function snapshot({ cwd = "/repo", content = true, visible = true } = {}) {
  const panes = content ? [
    { pane_id: "w1:p1", terminal_id: "content", workspace_id: "w1", tab_id: "w1:t1", foreground_cwd: cwd },
    { pane_id: "w1:p2", terminal_id: "rail", workspace_id: "w1", tab_id: "w1:t1", label: "SIDERAIL" },
  ] : [
    { pane_id: "w1:p2", terminal_id: "rail", workspace_id: "w1", tab_id: "w1:t1", label: "SIDERAIL" },
  ];
  return {
    focused_workspace_id: visible ? "w1" : "w9",
    focused_tab_id: visible ? "w1:t1" : "w9:t9",
    panes,
    layouts: [{ workspace_id: "w1", tab_id: "w1:t1", focused_pane_id: content ? "w1:p1" : "w1:p2", zoomed: false }],
  };
}

function fakeTimers() {
  const timers = [];
  return {
    timers,
    schedule(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel(timer) { timer.cancelled = true; },
    async runNext() {
      const timer = timers.find((candidate) => !candidate.cancelled && !candidate.ran);
      assert.ok(timer, "no scheduled timer");
      timer.ran = true;
      await timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
      return timer;
    },
  };
}

test("session snapshot uses one documented socket request", async () => {
  const calls = [];
  const value = snapshot();
  assert.equal(await readHerdrSessionSnapshot({
    socketPath: "/private/test.sock",
    request: async (...args) => {
      calls.push(args);
      return { type: "session_snapshot", snapshot: value };
    },
  }), value);
  assert.deepEqual(calls, [["/private/test.sock", "session.snapshot", {}, { timeoutMs: 5_000 }]]);
});

test("one source shares its initial snapshot and publishes semantic changes only", async () => {
  let current = snapshot();
  let requests = 0;
  const timers = fakeTimers();
  const source = createHerdrContextSource({
    fallbackIntervalMs: 10_000,
    readSnapshot: async () => { requests += 1; return current; },
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
  const first = [];
  const second = [];
  const subscriptionA = source.subscribe({ railPaneId: "w1:p2", fallbackCwd: "/fallback" }, (context) => first.push(context));
  const subscriptionB = source.subscribe({ railPaneId: "w1:p2", fallbackCwd: "/fallback" }, (context) => second.push(context));
  await Promise.all([subscriptionA.ready, subscriptionB.ready]);
  assert.equal(requests, 1);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0].cwd, "/repo");
  assert.equal(first[0].visible, true);

  await source.requestRefresh("unchanged");
  assert.equal(requests, 2);
  assert.equal(first.length, 1);
  assert.equal(source.metrics().semanticUnchanged, 2);

  current = snapshot({ cwd: "/other", visible: false });
  await source.requestRefresh("context-change");
  assert.equal(first.length, 2);
  assert.equal(first[1].cwd, "/other");
  assert.equal(first[1].visible, false);

  current = snapshot({ content: false });
  await source.requestRefresh("no-content");
  assert.equal(first.at(-1).hasContent, false);
  assert.equal(first.at(-1).sourcePaneId, "");
  subscriptionA.unsubscribe();
  subscriptionB.unsubscribe();
  assert.equal(source.metrics().subscribers, 0);
  assert.equal(timers.timers.at(-1).cancelled, true);
  source.close();
});

test("concurrent refresh requests queue one follow-up without overlapping snapshots", async () => {
  let resolveFirst;
  let requests = 0;
  let active = 0;
  let maxActive = 0;
  const source = createHerdrContextSource({
    readSnapshot: async () => {
      requests += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (requests === 1) await new Promise((resolve) => { resolveFirst = resolve; });
      active -= 1;
      return snapshot();
    },
  });
  const subscription = source.subscribe({ railPaneId: "w1:p2" }, () => {});
  const refreshA = source.requestRefresh("manual-a");
  const refreshB = source.requestRefresh("manual-b");
  let refreshSettled = false;
  refreshA.then(() => { refreshSettled = true; });
  resolveFirst();
  await subscription.ready;
  assert.equal(refreshSettled, false, "queued refresh resolved before its follow-up snapshot");
  await Promise.all([refreshA, refreshB]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 2);
  assert.equal(maxActive, 1);
  assert.equal(source.metrics().queued, false);
  source.close();
});

test("fallback cadence is one snapshot per completed interval and stops without subscribers", async () => {
  let requests = 0;
  const timers = fakeTimers();
  const source = createHerdrContextSource({
    fallbackIntervalMs: 10_000,
    readSnapshot: async () => { requests += 1; return snapshot(); },
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
  const subscription = source.subscribe({ railPaneId: "w1:p2" }, () => {});
  await subscription.ready;
  assert.equal(requests, 1);
  assert.equal(timers.timers.at(-1).delay, 10_000);
  await timers.runNext();
  assert.equal(requests, 2);
  assert.equal(timers.timers.at(-1).delay, 10_000);
  subscription.unsubscribe();
  assert.equal(timers.timers.at(-1).cancelled, true);
  source.close();
});

test("snapshot failure is explicit, retains no false context, and schedules retry", async () => {
  const statuses = [];
  const timers = fakeTimers();
  const source = createHerdrContextSource({
    fallbackIntervalMs: 10_000,
    readSnapshot: async () => { throw Object.assign(new Error("socket unavailable"), { code: "ENOENT" }); },
    schedule: timers.schedule,
    cancel: timers.cancel,
    onStatus: (status) => statuses.push(status),
  });
  let publishes = 0;
  const subscription = source.subscribe({ railPaneId: "w1:p2" }, () => { publishes += 1; });
  const context = await subscription.ready;
  assert.equal(context, null);
  assert.equal(statuses.at(-1).status, "degraded");
  assert.equal(source.metrics().failures, 1);
  assert.equal(publishes, 0);
  assert.equal(timers.timers.at(-1).delay, 10_000);
  source.close();
});

test("a listener failure is isolated from other subscribers and future polling", async () => {
  const statuses = [];
  const source = createHerdrContextSource({
    readSnapshot: async () => snapshot(),
    onStatus: (status) => statuses.push(status),
  });
  const broken = source.subscribe({ railPaneId: "w1:p2" }, () => { throw new Error("consumer failed"); });
  let healthyPublishes = 0;
  const healthy = source.subscribe({ railPaneId: "w1:p2" }, () => { healthyPublishes += 1; });
  await Promise.all([broken.ready, healthy.ready]);
  assert.equal(healthyPublishes, 1);
  assert.equal(source.metrics().listenerFailures, 1);
  assert.ok(statuses.some((status) => status.status === "listener-error"));
  source.close();
});

test("default host source uses the socket and its timer without launching a CLI", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gr-source-wire-"));
  const socketPath = path.join(root, "s");
  const value = snapshot(); let calls = 0;
  const server = net.createServer((socket) => {
    socket.once("data", (bytes) => {
      const request = JSON.parse(bytes.toString());
      assert.equal(request.method, "session.snapshot"); calls += 1;
      socket.end(`${JSON.stringify({ id: request.id, result: { type: "session_snapshot", snapshot: value } })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const source = createHerdrContextSource({ environment: { HERDR_SOCKET_PATH: socketPath }, fallbackIntervalMs: 15 });
  t.after(() => source.close());
  const first = source.subscribe({ railPaneId: "w1:p2" }, () => {});
  assert.equal((await first.ready).cwd, "/repo");
  const late = source.subscribe({ railPaneId: "w1:p2" }, () => {});
  await late.ready; assert.equal(calls, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(calls >= 2);
  assert.equal(source.snapshot, source.latestSnapshot);
  source.close(); source.close();
  assert.throws(() => source.subscribe({ railPaneId: "w1:p2" }, () => {}), /closed/);
});

test("host response validation fails explicitly and inactive queued refreshes settle", async () => {
  await assert.rejects(readHerdrSessionSnapshot({ socketPath: "" }), { code: "HERDR_SOCKET_UNAVAILABLE" });
  await assert.rejects(readHerdrSessionSnapshot({ socketPath: "/fixture", request: async () => ({ type: "wrong" }) }), { code: "HERDR_PROTOCOL_ERROR" });
  assert.throws(() => createHerdrContextSource({ fallbackIntervalMs: 0 }), /positive/);
  let finish;
  const source = createHerdrContextSource({ readSnapshot: () => new Promise((resolve) => { finish = resolve; }) });
  assert.throws(() => source.subscribe({}, () => {}), /railPaneId/);
  const handle = source.subscribe({ railPaneId: "w1:p2" }, () => {});
  const queued = source.requestRefresh();
  handle.unsubscribe(); finish(snapshot());
  await handle.ready;
  assert.equal((await queued).inactive, true);
  source.close();
  assert.equal((await source.requestRefresh()).closed, true);
});
