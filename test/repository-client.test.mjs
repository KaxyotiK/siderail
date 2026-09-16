import assert from "node:assert/strict";
import test from "node:test";
import { createRepositoryClient, openEngineSubscription } from "../src/repository-client.mjs";
import { createRepositoryEngine } from "../src/repository-engine.mjs";

async function flush() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

test("repository client stamps immutable tokens and drops closed-context deliveries", async () => {
  const connections = [];
  let token = 0;
  const client = createRepositoryClient({
    createToken: () => `token-${++token}`,
    openSubscription({ context, onDelivery }) {
      let latest = null;
      const connection = {
        context,
        onDelivery(value) {
          latest = value;
          onDelivery(value);
        },
        ready: Promise.resolve({ stateGeneration: 1, snapshot: { cwd: context.cwd } }),
        latest: () => latest,
        refresh: async () => ({ stateGeneration: 2, snapshot: { cwd: context.cwd } }),
        close: async () => {},
      };
      connections.push(connection);
      return connection;
    },
  });
  const received = [];
  const firstContext = { engineKey: "one", cwd: "/one" };
  const first = client.subscribe(firstContext, (delivery) => received.push(delivery));
  firstContext.cwd = "/mutated";
  assert.equal(first.context.cwd, "/one");
  assert.equal((await first.ready).contextToken, "token-1");
  assert.equal((await first.refresh()).contextToken, "token-1");
  connections[0].onDelivery({ stateGeneration: 3, snapshot: { cwd: "/one" } });
  await flush();
  assert.equal(received.at(-1).contextToken, "token-1");
  await first.close();
  connections[0].onDelivery({ stateGeneration: 4, snapshot: { cwd: "/stale" } });
  await flush();
  assert.equal(received.some(({ stateGeneration }) => stateGeneration === 4), false);

  const second = client.subscribe({ engineKey: "two", cwd: "/two" }, (delivery) => received.push(delivery));
  assert.equal((await second.ready).contextToken, "token-2");
  connections[1].onDelivery({ stateGeneration: 1, snapshot: { cwd: "/two" } });
  await flush();
  assert.equal(received.at(-1).contextToken, "token-2");
  assert.equal(received.at(-1).snapshot.cwd, "/two");
  await client.close();
  assert.throws(() => client.subscribe({ cwd: "/three" }, () => {}), /closed/);
});

test("in-process subscription preserves one engine owner and closes it only when requested", async () => {
  let reads = 0;
  const engine = createRepositoryEngine({
    context: { engineKey: "in-process", cwd: "/fixture" },
    readState: async () => ({ value: ++reads }),
  });
  const client = createRepositoryClient({
    createToken: () => "in-process-token",
    openSubscription: ({ onDelivery }) => openEngineSubscription({
      engine,
      onDelivery,
      closeEngine: true,
    }),
  });
  const deliveries = [];
  const handle = client.subscribe(engine.context, (delivery) => deliveries.push(delivery));
  assert.equal((await handle.ready).snapshot.value, 1);
  assert.equal((await handle.refresh("toolbar")).snapshot.value, 2);
  await flush();
  assert.ok(deliveries.every(({ contextToken }) => contextToken === "in-process-token"));
  await handle.close();
  assert.equal(engine.latest().status, "closed");
  await client.close();
});

test("client close invalidates a subscription whose ready result arrives later", async () => {
  let resolveReady;
  const delayed = new Promise((resolve) => { resolveReady = resolve; });
  const client = createRepositoryClient({
    openSubscription: () => ({
      ready: delayed,
      latest: () => null,
      refresh: async () => null,
      close: async () => {},
    }),
  });
  const received = [];
  const handle = client.subscribe({ cwd: "/late" }, (value) => received.push(value));
  await handle.close();
  resolveReady({ stateGeneration: 1, snapshot: {} });
  await assert.rejects(handle.ready, /closed before ready/);
  assert.deepEqual(received, []);
  await client.close();
});
