import assert from "node:assert/strict";
import test from "node:test";
import { createRefreshScheduler, RefreshSchedulerClosedError } from "../src/refresh-scheduler.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function fakeClock() {
  let current = 0;
  let nextId = 0;
  const timers = new Map();
  const flush = async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };
  return {
    now: () => current,
    setTimer(callback, delay) {
      const handle = { id: ++nextId, at: current + Math.max(0, delay), callback, unref() {} };
      timers.set(handle.id, handle);
      return handle;
    },
    clearTimer(handle) { if (handle) timers.delete(handle.id); },
    async tick(duration) {
      const target = current + duration;
      while (true) {
        const due = [...timers.values()]
          .filter(({ at }) => at <= target)
          .sort((left, right) => left.at - right.at || left.id - right.id)[0];
        if (!due) break;
        timers.delete(due.id);
        current = due.at;
        due.callback();
        await flush();
      }
      current = target;
      await flush();
    },
    flush,
  };
}

function schedulerWithClock(clock, run, options = {}) {
  return createRefreshScheduler({
    run,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
    ...options,
  });
}

test("dirty bursts coalesce and retain the two-second start cadence", async () => {
  const clock = fakeClock();
  const starts = [];
  const scheduler = schedulerWithClock(clock, async (request) => {
    starts.push({ at: clock.now(), ...request });
    return starts.length;
  });
  const first = scheduler.request({ kind: "dirty", reason: "one" });
  const coalesced = scheduler.request({ kind: "dirty", reason: "two" });
  await clock.tick(124);
  assert.equal(starts.length, 0);
  await clock.tick(1);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].inputGeneration, 2);
  assert.deepEqual(await Promise.all([first, coalesced]), [1, 1]);

  const second = scheduler.request({ kind: "dirty", reason: "later" });
  await clock.tick(1_999);
  assert.equal(starts.length, 1);
  await clock.tick(1);
  assert.equal(starts.length, 2);
  assert.equal(await second, 2);
  await scheduler.close();
});

test("a dirty event during a read queues exactly one throttled follow-up", async () => {
  const clock = fakeClock();
  const reads = [];
  const scheduler = schedulerWithClock(clock, (request) => {
    const gate = deferred();
    reads.push({ request, gate, at: clock.now() });
    return gate.promise;
  });
  const startup = scheduler.request({ kind: "manual", reason: "startup" });
  await clock.flush();
  assert.equal(reads.length, 1);
  const dirtyOne = scheduler.request({ kind: "dirty", reason: "edit-1" });
  const dirtyTwo = scheduler.request({ kind: "dirty", reason: "edit-2" });
  reads[0].gate.resolve("initial");
  await clock.flush();
  assert.equal(await startup, "initial");
  await clock.tick(1_999);
  assert.equal(reads.length, 1);
  await clock.tick(1);
  assert.equal(reads.length, 2);
  assert.equal(reads[1].request.inputGeneration, 2);
  reads[1].gate.resolve("updated");
  await clock.flush();
  assert.deepEqual(await Promise.all([dirtyOne, dirtyTwo]), ["updated", "updated"]);
  assert.equal(reads.length, 2);
  await scheduler.close();
});

test("a manual request during a read receives one immediate follow-up", async () => {
  const clock = fakeClock();
  const reads = [];
  const scheduler = schedulerWithClock(clock, () => {
    const gate = deferred();
    reads.push(gate);
    return gate.promise;
  });
  const first = scheduler.request({ kind: "manual", reason: "startup" });
  await clock.flush();
  const manual = scheduler.request({ kind: "manual", reason: "toolbar" });
  reads[0].resolve("first");
  await clock.flush();
  assert.equal(await first, "first");
  assert.equal(reads.length, 2);
  reads[1].resolve("second");
  await clock.flush();
  assert.equal(await manual, "second");
  await scheduler.close();
});

test("a due reconciliation covers an already pending dirty event without another read", async () => {
  const clock = fakeClock();
  const starts = [];
  const scheduler = schedulerWithClock(clock, async (request) => {
    starts.push({ at: clock.now(), ...request });
    return starts.length;
  });
  assert.equal(await scheduler.request({ kind: "manual", reason: "startup" }), 1);
  await clock.tick(299_999);
  const dirty = scheduler.request({ kind: "dirty", reason: "boundary-edit" });
  await clock.tick(1);
  assert.equal(starts.length, 2);
  assert.deepEqual(new Set(starts[1].kinds), new Set(["dirty", "reconcile"]));
  assert.equal(await dirty, 2);
  await clock.tick(125);
  assert.equal(starts.length, 2);
  await scheduler.close();
});

test("healthy reconciliation and degraded fallback honor maximum jitter bounds", async () => {
  const healthyClock = fakeClock();
  let healthyReads = 0;
  const healthy = schedulerWithClock(healthyClock, async () => ++healthyReads, { random: () => 1 });
  await healthy.request({ kind: "manual", reason: "startup" });
  await healthyClock.tick(329_999);
  assert.equal(healthyReads, 1);
  await healthyClock.tick(1);
  assert.equal(healthyReads, 2);
  await healthy.close();

  const degradedClock = fakeClock();
  let degradedReads = 0;
  const degraded = schedulerWithClock(degradedClock, async () => ++degradedReads, {
    watchHealthy: false,
    random: () => 1,
  });
  await degraded.request({ kind: "manual", reason: "startup" });
  await degradedClock.tick(10_999);
  assert.equal(degradedReads, 1);
  await degradedClock.tick(1);
  assert.equal(degradedReads, 2);
  await degraded.close();
});

test("runtime interval updates reschedule only when a value changes", async () => {
  const clock = fakeClock();
  let reads = 0;
  const scheduler = schedulerWithClock(clock, async () => ++reads);
  await scheduler.request({ kind: "manual", reason: "startup" });
  const originalDue = scheduler.status.reconciliationDueAt;
  scheduler.updateConfig({ reconcileIntervalMs: 300_000, fallbackIntervalMs: 10_000 });
  assert.equal(scheduler.status.reconciliationDueAt, originalDue);
  scheduler.updateConfig({ reconcileIntervalMs: 60_000 });
  assert.equal(scheduler.status.reconciliationDueAt, 60_000);
  await clock.tick(59_999);
  assert.equal(reads, 1);
  await clock.tick(1);
  assert.equal(reads, 2);
  await scheduler.close();
});

test("provider failure retains bounded retry and close aborts owned work", async () => {
  const retryClock = fakeClock();
  let attempts = 0;
  const retry = schedulerWithClock(retryClock, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("offline");
    return "current";
  });
  await assert.rejects(retry.request({ kind: "manual", reason: "startup" }), /offline/);
  assert.equal(retry.status.providerFailed, true);
  await retryClock.tick(9_999);
  assert.equal(attempts, 1);
  await retryClock.tick(1);
  assert.equal(attempts, 2);
  assert.equal(retry.status.providerFailed, false);
  await retry.close();

  const closeClock = fakeClock();
  let aborted = false;
  const closing = schedulerWithClock(closeClock, ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      aborted = true;
      reject(signal.reason);
    }, { once: true });
  }));
  const active = closing.request({ kind: "manual", reason: "startup" });
  await closeClock.flush();
  await closing.close();
  assert.equal(aborted, true);
  await assert.rejects(active, RefreshSchedulerClosedError);
  await assert.rejects(closing.request({ kind: "manual" }), RefreshSchedulerClosedError);
});
