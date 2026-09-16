import assert from "node:assert/strict";
import test from "node:test";
import { createRailStateClient } from "../src/rail-state-client.mjs";
import { commitAge } from "../src/tui-format.mjs";

function setup() {
  const subscriptions = []; const renders = []; const snapshots = []; const statuses = [];
  const timers = new Map(); let serial = 0; let clientClosed = 0;
  const client = {
    subscribe(context, listener) {
      let resolve; let reject;
      const subscription = {
        context, listener, closed: 0, refreshes: [],
        ready: new Promise((yes, no) => { resolve = yes; reject = no; }),
        resolve: (snapshot, generation = 1) => resolve({ snapshot, stateGeneration: generation, status: "healthy" }),
        reject: (error) => reject(error),
        close() { this.closed += 1; },
        refresh(reason) { this.refreshes.push(reason); return Promise.resolve({ reason }); },
      };
      subscriptions.push(subscription); return subscription;
    },
    close() { clientClosed += 1; },
  };
  const view = createRailStateClient({ client,
    onSnapshot: (snapshot) => snapshots.push(snapshot), onStatus: (status) => statuses.push(status),
    onRender: () => renders.push(snapshots.at(-1)),
    setTimer(fn) { const id = ++serial; timers.set(id, fn); return id; }, clearTimer(id) { timers.delete(id); },
  });
  return { view, subscriptions, renders, snapshots, statuses, timers, clientClosed: () => clientClosed };
}

test("hidden rails retain new snapshots without redraw; showing uses cached state without Git", async () => {
  const f = setup(); const pending = f.view.updateContext({ cwd: "/a", visible: false });
  f.subscriptions[0].resolve({ branch: "main" }); await pending;
  f.subscriptions[0].listener({ stateGeneration: 2, snapshot: { branch: "feature" }, status: "healthy" });
  assert.equal(f.snapshots.at(-1).branch, "feature"); assert.equal(f.renders.length, 0); assert.equal(f.timers.size, 0);
  await f.view.updateContext({ cwd: "/a", visible: true });
  assert.equal(f.subscriptions.length, 1); assert.equal(f.subscriptions[0].refreshes.length, 0);
  assert.equal(f.renders.at(-1).branch, "feature"); assert.equal(f.timers.size, 1);
  const previous = f.renders.length;
  f.subscriptions[0].listener({ stateGeneration: 2, snapshot: { branch: "feature" }, status: "healthy", reconciliationDueAt: 123 });
  assert.equal(f.renders.length, previous);
  await f.view.close(); assert.equal(f.timers.size, 0); assert.equal(f.clientClosed(), 1);
});

test("context switches drop late results and no-content state releases the subscription", async () => {
  const f = setup(); const old = f.view.updateContext({ cwd: "/a" });
  const current = f.view.updateContext({ cwd: "/b" });
  assert.equal(f.subscriptions[0].closed, 1);
  f.subscriptions[1].resolve({ branch: "b" }); await current;
  f.subscriptions[0].resolve({ branch: "a" }); await old;
  f.subscriptions[0].listener({ stateGeneration: 99, snapshot: { branch: "a" }, status: "healthy" });
  assert.equal(f.view.latest().snapshot.branch, "b");
  assert.deepEqual(f.snapshots, [{ branch: "b" }]);
  await f.view.updateContext({ cwd: "/b", hasContent: false });
  assert.equal(f.subscriptions[1].closed, 1); assert.equal(f.statuses.at(-1).status, "suspended");
  assert.equal(await f.view.refresh(), null); assert.equal(f.timers.size, 0);
  const resumed = f.view.updateContext({ cwd: "/b", hasContent: true });
  f.subscriptions[2].resolve({ branch: "resumed" }); await resumed;
  assert.equal(f.view.latest().snapshot.branch, "resumed"); await f.view.close();
});

test("visible age timer is local only and hidden/closed rails cancel it", async () => {
  const f = setup(); const ready = f.view.updateContext({ cwd: "/a" });
  f.subscriptions[0].resolve({ commits: [{ authoredAtMs: 0 }] }); await ready;
  const before = f.renders.length;
  const [id, tick] = [...f.timers][0]; f.timers.delete(id); tick();
  assert.equal(f.renders.length, before + 1); assert.equal(f.subscriptions[0].refreshes.length, 0);
  assert.equal(f.subscriptions.length, 1);
  await f.view.refresh("manual"); assert.deepEqual(f.subscriptions[0].refreshes, ["manual"]);
  await f.view.updateContext({ cwd: "/a", visible: false }); assert.equal(f.timers.size, 0);
  await f.view.close(); await f.view.close(); assert.equal(f.clientClosed(), 1);
  assert.equal(await f.view.updateContext({ cwd: "/later" }), null);
});

test("startup failure is visible and closing a pending subscription discards completion", async () => {
  const f = setup(); const ready = f.view.updateContext({ cwd: "/broken" });
  f.subscriptions[0].reject(new Error("no Git")); assert.equal(await ready, null);
  assert.equal(f.statuses.at(-1).error.message, "no Git");
  const next = f.view.updateContext({ cwd: "/later" }); await f.view.close();
  f.subscriptions[1].resolve({ branch: "late" }); assert.equal(await next, null); assert.equal(f.snapshots.length, 0);
});

test("commit ages advance from absolute author times without another provider read", () => {
  assert.equal(commitAge({ age: "2 hours ago" }), "2h");
  assert.equal(commitAge({ authoredAtMs: 120_000 }, 0), "now");
  assert.equal(commitAge({ authoredAtMs: 0 }, 59_999), "now");
  for (const [milliseconds, label] of [[60_000, "1m"], [3_600_000, "1h"], [86_400_000, "1d"], [604_800_000, "1w"], [2_592_000_000, "1mo"], [31_536_000_000, "1y"]]) {
    assert.equal(commitAge({ authoredAtMs: 0 }, milliseconds), label);
  }
});

test("optional UI hooks can be omitted without breaking the subscription lifecycle", async () => {
  let listener;
  let closed = false;
  const first = { snapshot: { cwd: "/fixture" }, stateGeneration: 1, status: "healthy" };
  const controller = createRailStateClient({ client: {
    subscribe(_context, receive) {
      listener = receive;
      return { ready: Promise.resolve(first), refresh: async () => first, close() { closed = true; } };
    },
    close() {},
  } });
  await controller.updateContext({ cwd: "/fixture" });
  listener({ ...first, stateGeneration: 2 });
  assert.equal(controller.latest().stateGeneration, 2);
  await controller.refresh();
  await controller.updateContext({ cwd: "/fixture", hasContent: false });
  assert.equal(closed, true);
  await controller.close();
});
