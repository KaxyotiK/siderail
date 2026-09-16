import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_BLOCKED_WRITE_MS,
  MAX_CONTROL_FRAME_BYTES,
  MAX_QUEUED_CONTROL_BYTES,
  MAX_QUEUED_CONTROL_MESSAGES,
  MAX_SNAPSHOT_FRAME_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  createFrameDecoder,
  decodeSnapshot,
  encodeFrame,
  encodeSnapshot,
  validateClientMessage,
  validateServerMessage,
} from "../src/git-state-protocol.mjs";

test("snapshot codec preserves only the schema-declared Map and own-property presence", () => {
  const withoutParent = { kind: "commit", commitHash: "a".repeat(40) };
  const withEmptyParent = { kind: "commit", commitHash: "b".repeat(40), parentHash: "" };
  const snapshot = {
    cwd: "/fixture",
    workspaceDescriptor: null,
    commitPathIndex: new Map([
      ["a".repeat(40), ["src/a.mjs", "README.md"]],
      ["b".repeat(40), []],
    ]),
    files: [
      { path: "src/a.mjs", descriptor: withoutParent, optional: undefined },
      { path: "README.md", descriptor: withEmptyParent },
    ],
  };

  const encoded = encodeSnapshot(snapshot);
  const decoded = decodeSnapshot(JSON.parse(JSON.stringify(encoded)));
  assert.deepEqual(decoded, snapshot);
  assert.ok(decoded.commitPathIndex instanceof Map);
  assert.equal(Object.hasOwn(decoded.files[0], "optional"), true);
  assert.equal(decoded.files[0].optional, undefined);
  assert.equal(Object.hasOwn(decoded.files[0].descriptor, "parentHash"), false);
  assert.equal(Object.hasOwn(decoded.files[1].descriptor, "parentHash"), true);
  assert.equal(decoded.files[1].descriptor.parentHash, "");
});

test("snapshot codec preserves an empty commit path Map", () => {
  const snapshot = { commitPathIndex: new Map(), files: [] };
  const decoded = decodeSnapshot(encodeSnapshot(snapshot));
  assert.deepEqual(decoded, snapshot);
  assert.ok(decoded.commitPathIndex instanceof Map);
  assert.equal(decoded.commitPathIndex.size, 0);
});

test("snapshot codec rejects arbitrary Maps, cycles, tags, and forged undefined paths", () => {
  assert.throws(
    () => encodeSnapshot({ commitPathIndex: new Map(), nested: new Map() }),
    (error) => error instanceof ProtocolError && error.code === "INVALID_SNAPSHOT",
  );
  const cyclic = { commitPathIndex: new Map() };
  cyclic.self = cyclic;
  assert.throws(() => encodeSnapshot(cyclic), ProtocolError);

  const encoded = encodeSnapshot({ commitPathIndex: new Map(), files: [] });
  assert.throws(
    () => decodeSnapshot({ ...encoded, $type: "Map" }),
    (error) => error instanceof ProtocolError && error.code === "UNKNOWN_FIELD",
  );
  assert.throws(
    () => decodeSnapshot({ ...encoded, undefinedOwnPaths: [["missing"]] }),
    (error) => error instanceof ProtocolError && error.code === "INVALID_SNAPSHOT",
  );
  assert.throws(
    () => encodeSnapshot({ commitPathIndex: new Map(), files: [{ descriptor: { kind: "command", argv: ["git"] } }] }),
    (error) => error instanceof ProtocolError && error.code === "INVALID_SNAPSHOT",
  );
});

test("four-byte framing handles split headers, split payloads, and multiple frames", () => {
  const messages = [];
  const errors = [];
  const decoder = createFrameDecoder({ onMessage: (message) => messages.push(message), onError: (error) => errors.push(error) });
  const first = encodeFrame({ type: "ping", nonce: "one" });
  const second = encodeFrame({ type: "ping", nonce: "two" });
  const combined = Buffer.concat([first, second]);
  decoder.push(combined.subarray(0, 2));
  decoder.push(combined.subarray(2, 7));
  decoder.push(combined.subarray(7));
  decoder.end();
  assert.deepEqual(messages, [{ type: "ping", nonce: "one" }, { type: "ping", nonce: "two" }]);
  assert.deepEqual(errors, []);
});

test("frame decoder rejects oversize, malformed, and truncated frames and can reset", () => {
  const messages = [];
  const errors = [];
  const decoder = createFrameDecoder({
    maxBytes: 32,
    onMessage: (message) => messages.push(message),
    onError: (error) => errors.push(error),
  });
  const oversizedHeader = Buffer.alloc(4);
  oversizedHeader.writeUInt32BE(33);
  decoder.push(oversizedHeader);
  decoder.push(encodeFrame({ ok: true }, { maxBytes: 32 }));
  assert.equal(errors[0].code, "FRAME_TOO_LARGE");
  assert.deepEqual(messages, []);

  decoder.reset();
  const malformed = Buffer.from("{");
  const malformedFrame = Buffer.alloc(5);
  malformedFrame.writeUInt32BE(1);
  malformed.copy(malformedFrame, 4);
  decoder.push(malformedFrame);
  assert.equal(errors[1].code, "INVALID_JSON");

  decoder.reset();
  decoder.push(encodeFrame({ ok: true }, { maxBytes: 32 }).subarray(0, 5));
  decoder.end();
  assert.equal(errors[2].code, "TRUNCATED_FRAME");
});

test("frame encoder enforces the caller-selected bound", () => {
  assert.throws(
    () => encodeFrame({ value: "x".repeat(64) }, { maxBytes: 16 }),
    (error) => error instanceof ProtocolError && error.code === "FRAME_TOO_LARGE",
  );
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(MAX_CONTROL_FRAME_BYTES, 1024 * 1024);
  assert.equal(MAX_SNAPSHOT_FRAME_BYTES, 64 * 1024 * 1024);
  assert.equal(MAX_QUEUED_CONTROL_MESSAGES, 128);
  assert.equal(MAX_QUEUED_CONTROL_BYTES, 1024 * 1024);
  assert.equal(MAX_BLOCKED_WRITE_MS, 5_000);
});

test("client validator accepts typed repository and host requests", () => {
  const messages = [
    { type: "hello", protocolVersion: 1, namespaceId: "a".repeat(64), clientId: "client-1" },
    { type: "repository_subscribe", requestId: "r1", subscriptionId: "s1", cwd: "/repo", namespaceId: "a".repeat(64) },
    { type: "repository_refresh", requestId: "r2", subscriptionId: "s1", reason: "manual" },
    { type: "repository_unsubscribe", requestId: "r3", subscriptionId: "s1" },
    {
      type: "host_subscribe",
      requestId: "r4",
      subscriptionId: "h1",
      selector: { railPaneId: "p1", railTerminalId: "t1", sourcePaneId: "p2", fallbackCwd: "/repo" },
    },
    { type: "host_refresh", requestId: "r5", subscriptionId: "h1", reason: "fallback" },
    { type: "host_unsubscribe", requestId: "r6", subscriptionId: "h1" },
    { type: "ping", nonce: "n1" },
  ];
  for (const message of messages) assert.equal(validateClientMessage(message), message);
});

test("validators reject unknown fields and command or environment injection", () => {
  for (const message of [
    { type: "repository_subscribe", requestId: "r", subscriptionId: "s", cwd: "/repo", namespaceId: "a".repeat(64), command: "rm" },
    { type: "repository_subscribe", requestId: "r", subscriptionId: "s", cwd: "/repo", namespaceId: "a".repeat(64), env: { HOME: "/tmp" } },
    { type: "host_subscribe", requestId: "r", subscriptionId: "s", selector: { railPaneId: "p", executable: "git" } },
  ]) {
    assert.throws(
      () => validateClientMessage(message),
      (error) => error instanceof ProtocolError && error.code === "UNKNOWN_FIELD",
    );
  }
  assert.throws(
    () => validateClientMessage({ type: "repository_refresh", requestId: "r", subscriptionId: "s", reason: "x".repeat(129) }),
    (error) => error instanceof ProtocolError && error.code === "INVALID_FIELD",
  );
});

test("server validator accepts encoded repository and exact host deliveries", () => {
  const encoded = encodeSnapshot({ commitPathIndex: new Map(), files: [] });
  const repository = {
    type: "repository_delivery",
    subscriptionId: "s1",
    delivery: {
      engineKey: "engine",
      stateGeneration: 1,
      inputGeneration: 2,
      status: "healthy",
      snapshot: encoded,
      refreshedAt: 10,
      reconciliationDueAt: 20,
    },
  };
  const host = {
    type: "host_delivery",
    subscriptionId: "h1",
    context: {
      cwd: "/repo",
      sourcePaneId: "p1",
      tabId: "tab1",
      workspaceId: "w1",
      railPaneId: "p2",
      railTerminalId: "term2",
      hasContent: true,
      visible: false,
    },
  };
  assert.equal(validateServerMessage(repository), repository);
  assert.equal(validateServerMessage(host), host);
  assert.equal(validateServerMessage({ type: "response", requestId: "r1", ok: true, value: { closed: true } }).type, "response");
  assert.equal(validateServerMessage({ type: "response", requestId: "r2", ok: false, error: { code: "NOPE", message: "failed" } }).type, "response");
});

test("typed wire messages reject malformed scalar fields and contradictory responses", () => {
  const hello = { type: "hello", protocolVersion: 1, namespaceId: "fixture", clientId: "client" };
  for (const message of [null, [], new Date(), {}, { ...hello, protocolVersion: -1 },
    { ...hello, protocolVersion: 0.5 }, { ...hello, namespaceId: "bad/path" },
    { ...hello, clientId: "bad\0id" }, { ...hello, clientId: 1 }, { ...hello, type: "execute" }]) {
    assert.throws(() => validateClientMessage(message), ProtocolError);
  }
  for (const message of [
    { type: "response", requestId: "r", ok: "yes" },
    { type: "response", requestId: "r", ok: true, error: { message: "wrong" } },
    { type: "response", requestId: "r", ok: false },
    { type: "response", requestId: "r", ok: false, error: { message: "bad" }, value: {} },
    { type: "response", requestId: "r", ok: true, value: Array(2) },
    { type: "response", requestId: "r", ok: true, value: NaN },
    { type: "execute", command: "git" },
    { type: "repository_delivery", subscriptionId: "s", delivery: {
      engineKey: "e", stateGeneration: 0, inputGeneration: 0, status: "made-up", refreshedAt: null, reconciliationDueAt: null,
    } },
    { type: "host_delivery", subscriptionId: "s", context: {
      cwd: "", sourcePaneId: "", tabId: "", workspaceId: "", railPaneId: "", railTerminalId: "", hasContent: 1, visible: true,
    } },
  ]) assert.throws(() => validateServerMessage(message), ProtocolError);
  for (const message of [
    { type: "status", status: "stale", scope: "repository", subscriptionId: "s", message: "" },
    { type: "status", status: "healthy" },
    { type: "pong" }, { type: "pong", nonce: "p" },
    { type: "error", code: "FAILED", message: "failed", requestId: "r", subscriptionId: "s" },
    { type: "response", requestId: "r", ok: false, error: { name: "Error", code: "FAILED", message: "failed" } },
    { type: "response", requestId: "r", ok: true, value: [true, 1, null, "value"] },
  ]) assert.equal(validateServerMessage(message), message);
  assert.equal(validateClientMessage({ type: "ping" }).type, "ping");
});

test("snapshot schema rejects forged Maps and restores nested undefined without prototype mutation", () => {
  const encoded = encodeSnapshot({ commitPathIndex: new Map(), files: [{ descriptor: { kind: "commit", commitHash: "a", parentHash: undefined } }] });
  assert.equal(Object.hasOwn(decodeSnapshot(encoded).files[0].descriptor, "parentHash"), true);
  const polluted = encodeSnapshot({ commitPathIndex: new Map(), nested: JSON.parse('{"__proto__":{"value":null}}') });
  polluted.undefinedOwnPaths = [["nested", "__proto__", "value"]];
  assert.equal(decodeSnapshot(polluted).nested.__proto__.value, undefined);
  assert.equal(Object.prototype.value, undefined);
  for (const value of [Infinity, () => {}, Symbol("x"), 1n, Array(2), new Date()]) {
    assert.throws(() => encodeSnapshot({ commitPathIndex: new Map(), value }));
  }
  assert.throws(() => encodeSnapshot({ files: [] }), ProtocolError);
  for (const patch of [
    { schema: "unknown" }, { snapshot: { commitPathIndex: [] } },
    { commitPathIndex: {} }, { commitPathIndex: [["a"]] },
    { commitPathIndex: [["a", []], ["a", []]] }, { commitPathIndex: [["a", {}]] },
    { undefinedOwnPaths: {} }, { undefinedOwnPaths: [[]] },
    { undefinedOwnPaths: [[-1]] }, { undefinedOwnPaths: [["missing", "nested"]] },
  ]) assert.throws(() => decodeSnapshot({ ...encoded, ...patch }), ProtocolError);
  let deep = null;
  for (let index = 0; index < 130; index += 1) deep = [deep];
  assert.throws(() => validateServerMessage({ type: "response", requestId: "r", ok: true, value: deep }), ProtocolError);
});

test("framing rejects invalid limits, unserializable messages, and zero-length frames", () => {
  for (const maxBytes of [0, -1, 0.5, MAX_SNAPSHOT_FRAME_BYTES + 1]) {
    assert.throws(() => encodeFrame({}, { maxBytes }), TypeError);
    assert.throws(() => createFrameDecoder({ maxBytes, onMessage() {} }), TypeError);
  }
  assert.throws(() => createFrameDecoder(), /onMessage/);
  assert.throws(() => createFrameDecoder({ onMessage() {}, onError: 1 }), /onError/);
  assert.throws(() => encodeFrame({ value: 1n }), { code: "INVALID_JSON" });
  const decoder = createFrameDecoder({ onMessage() { throw new Error("unexpected frame"); } });
  assert.throws(() => decoder.push(Buffer.alloc(4)), ProtocolError);
});
