import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  normalizeHerdrEventName,
  requestHerdr,
  subscribeHerdr,
} from "./helpers/herdr-socket-client.mjs";

async function fixture(handler) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "siderail-herdr-socket-"));
  const socketPath = path.join(root, "api.sock");
  const server = net.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("requestHerdr sends NDJSON and returns the matching result", async () => {
  const seen = [];
  const server = await fixture((socket) => {
    socket.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString("utf8"));
      seen.push(request);
      socket.end(`${JSON.stringify({ id: request.id, result: { type: "pong", protocol: 20 } })}\n`);
    });
  });
  try {
    assert.deepEqual(await requestHerdr(server.socketPath, "ping", {}, { id: "ping-1" }), {
      type: "pong", protocol: 20,
    });
    assert.deepEqual(seen, [{ id: "ping-1", method: "ping", params: {} }]);
  } finally {
    await server.close();
  }
});

test("subscribeHerdr preserves pushed event order after its acknowledgement", async () => {
  const server = await fixture((socket) => {
    socket.once("data", (chunk) => {
      const request = JSON.parse(chunk.toString("utf8"));
      socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
      socket.write(`${JSON.stringify({ event: "pane_focused", data: { type: "pane_focused", pane_id: "w1:p1", workspace_id: "w1" } })}\n`);
      socket.write(`${JSON.stringify({ event: "layout_updated", data: { type: "layout_updated", layout: { tab_id: "w1:t1" } } })}\n`);
    });
  });
  const subscription = await subscribeHerdr(server.socketPath, [{ type: "pane.focused" }], { id: "sub-1" });
  try {
    assert.equal((await subscription.next()).event, "pane_focused");
    assert.equal((await subscription.next()).event, "layout_updated");
  } finally {
    subscription.close();
    await server.close();
  }
});

test("event names normalize from emitted snake_case to subscription dot notation", () => {
  assert.equal(normalizeHerdrEventName("pane_focused"), "pane.focused");
  assert.equal(normalizeHerdrEventName("workspace_metadata_updated"), "workspace.metadata_updated");
});

test("requestHerdr surfaces structured server errors", async () => {
  const server = await fixture((socket) => {
    socket.once("data", (chunk) => {
      const request = JSON.parse(chunk.toString("utf8"));
      socket.end(`${JSON.stringify({ id: request.id, error: { code: "not_found", message: "gone" } })}\n`);
    });
  });
  try {
    await assert.rejects(requestHerdr(server.socketPath, "pane.get", {}, { id: "bad" }), {
      code: "not_found",
      message: "gone",
    });
  } finally {
    await server.close();
  }
});

test("a timed-out event wait does not consume the next event", async () => {
  let peer;
  const server = await fixture((socket) => {
    peer = socket;
    socket.once("data", (chunk) => {
      const request = JSON.parse(chunk.toString("utf8"));
      socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
    });
  });
  const subscription = await subscribeHerdr(server.socketPath, [{ type: "pane.focused" }]);
  try {
    await assert.rejects(subscription.next({ timeoutMs: 10 }), { code: "HERDR_TIMEOUT" });
    peer.write(`${JSON.stringify({ event: "pane_focused", data: { pane_id: "w1:p1" } })}\n`);
    assert.equal((await subscription.next({ timeoutMs: 100 })).event, "pane_focused");
  } finally {
    subscription.close();
    await server.close();
  }
});

test("invalid and oversized response lines reject without crashing the process", async (context) => {
  await context.test("invalid JSON", async () => {
    const server = await fixture((socket) => socket.once("data", () => socket.end("{broken}\n")));
    try {
      await assert.rejects(requestHerdr(server.socketPath, "ping"), { code: "HERDR_PROTOCOL_ERROR" });
    } finally {
      await server.close();
    }
  });
  await context.test("oversized complete line", async () => {
    const server = await fixture((socket) => socket.once("data", () => socket.end(`${"x".repeat(80)}\n`)));
    try {
      await assert.rejects(requestHerdr(server.socketPath, "ping", {}, { maxLineBytes: 32 }), {
        code: "HERDR_PROTOCOL_ERROR",
      });
    } finally {
      await server.close();
    }
  });
});
