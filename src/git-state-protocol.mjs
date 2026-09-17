export const PROTOCOL_VERSION = 1;
export const MAX_CONTROL_FRAME_BYTES = 1024 * 1024;
export const MAX_SNAPSHOT_FRAME_BYTES = 64 * 1024 * 1024;
export const MAX_QUEUED_CONTROL_MESSAGES = 128;
export const MAX_QUEUED_CONTROL_BYTES = 1024 * 1024;
export const MAX_BLOCKED_WRITE_MS = 5_000;

const SNAPSHOT_SCHEMA = "git-railgun.repository-snapshot.v1";
const MAX_ID_LENGTH = 128;
const MAX_PATH_LENGTH = 32 * 1024;
const MAX_MESSAGE_LENGTH = 4 * 1024;
const MAX_REASON_LENGTH = 128;

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProtocolError(code, message);
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_MESSAGE", `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("INVALID_MESSAGE", `${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, label, required, optional = []) {
  plainObject(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("UNKNOWN_FIELD", `${label} contains unknown field ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("MISSING_FIELD", `${label} requires ${key}`);
  }
}

function boundedString(value, label, maximum, { empty = false } = {}) {
  if (typeof value !== "string" || (!empty && value.length === 0) || value.length > maximum) {
    fail("INVALID_FIELD", `${label} must be ${empty ? "a" : "a non-empty"} string of at most ${maximum} characters`);
  }
  if (value.includes("\0")) fail("INVALID_FIELD", `${label} must not contain NUL`);
  return value;
}

function finiteNumber(value, label, { nullable = false, integer = false, minimum = 0 } = {}) {
  if (nullable && value === null) return value;
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < minimum) {
    fail("INVALID_FIELD", `${label} must be ${nullable ? "null or " : ""}a ${integer ? "non-negative integer" : "non-negative finite number"}`);
  }
  return value;
}

function validateId(value, label) {
  return boundedString(value, label, MAX_ID_LENGTH);
}

function validateNamespace(value, label = "namespaceId") {
  boundedString(value, label, MAX_ID_LENGTH);
  if (!/^[A-Za-z0-9._-]+$/.test(value)) fail("INVALID_FIELD", `${label} contains unsupported characters`);
  return value;
}

function validateSafeError(value, label) {
  exactKeys(value, label, ["message"], ["name", "code"]);
  boundedString(value.message, `${label}.message`, MAX_MESSAGE_LENGTH);
  if (value.name !== undefined) boundedString(value.name, `${label}.name`, MAX_ID_LENGTH);
  if (value.code !== undefined) boundedString(value.code, `${label}.code`, MAX_ID_LENGTH);
  return value;
}

function validateSelector(value, label = "selector") {
  exactKeys(value, label, ["railPaneId"], ["railTerminalId", "sourcePaneId", "fallbackCwd"]);
  validateId(value.railPaneId, `${label}.railPaneId`);
  for (const key of ["railTerminalId", "sourcePaneId"]) {
    if (value[key] !== undefined) boundedString(value[key], `${label}.${key}`, MAX_ID_LENGTH, { empty: true });
  }
  if (value.fallbackCwd !== undefined) boundedString(value.fallbackCwd, `${label}.fallbackCwd`, MAX_PATH_LENGTH, { empty: true });
  return value;
}

function validateHostContext(value, label = "context") {
  exactKeys(value, label, [
    "cwd", "sourcePaneId", "tabId", "workspaceId", "railPaneId", "railTerminalId", "hasContent", "visible",
  ]);
  boundedString(value.cwd, `${label}.cwd`, MAX_PATH_LENGTH, { empty: true });
  for (const key of ["sourcePaneId", "tabId", "workspaceId", "railPaneId", "railTerminalId"]) {
    boundedString(value[key], `${label}.${key}`, MAX_ID_LENGTH, { empty: true });
  }
  if (typeof value.hasContent !== "boolean" || typeof value.visible !== "boolean") {
    fail("INVALID_FIELD", `${label}.hasContent and ${label}.visible must be boolean`);
  }
  return value;
}

function validateJsonValue(value, label, depth = 0) {
  if (depth > 128) fail("INVALID_FIELD", `${label} exceeds maximum nesting depth`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) fail("INVALID_FIELD", `${label} must not contain sparse arrays`);
      validateJsonValue(value[index], `${label}[${index}]`, depth + 1);
    }
    return value;
  }
  plainObject(value, label);
  for (const [key, nested] of Object.entries(value)) validateJsonValue(nested, `${label}.${key}`, depth + 1);
  return value;
}

function cloneForSnapshot(value, path, undefinedPaths, seen) {
  if (value === undefined) {
    undefinedPaths.push(path);
    return null;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_SNAPSHOT", `snapshot value at ${path.join(".") || "<root>"} must be finite`);
    return value;
  }
  if (typeof value !== "object") fail("INVALID_SNAPSHOT", `unsupported snapshot value at ${path.join(".") || "<root>"}`);
  if (seen.has(value)) fail("INVALID_SNAPSHOT", "snapshot must not contain cycles or repeated object references");
  if (value instanceof Map) fail("INVALID_SNAPSHOT", "only snapshot.commitPathIndex may be a Map");
  seen.add(value);
  let copy;
  if (Array.isArray(value)) {
    copy = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) fail("INVALID_SNAPSHOT", "snapshot must not contain sparse arrays");
      copy.push(cloneForSnapshot(value[index], [...path, index], undefinedPaths, seen));
    }
  } else {
    plainObject(value, `snapshot.${path.join(".")}`);
    copy = Object.create(null);
    for (const key of Object.keys(value)) {
      Object.defineProperty(copy, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: cloneForSnapshot(value[key], [...path, key], undefinedPaths, seen),
      });
    }
  }
  seen.delete(value);
  return copy;
}

function validateCommitPathEntries(entries) {
  if (!Array.isArray(entries)) fail("INVALID_SNAPSHOT", "commitPathIndex must encode as an array");
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    if (!Array.isArray(entry) || entry.length !== 2) fail("INVALID_SNAPSHOT", `commitPathIndex[${index}] must be a pair`);
    const [commit, paths] = entry;
    boundedString(commit, `commitPathIndex[${index}][0]`, MAX_ID_LENGTH);
    if (seen.has(commit)) fail("INVALID_SNAPSHOT", `commitPathIndex contains duplicate key ${commit}`);
    seen.add(commit);
    if (!Array.isArray(paths)) fail("INVALID_SNAPSHOT", `commitPathIndex[${index}][1] must be an array`);
    for (const [pathIndex, filePath] of paths.entries()) {
      boundedString(filePath, `commitPathIndex[${index}][1][${pathIndex}]`, MAX_PATH_LENGTH, { empty: true });
    }
  }
  return entries;
}

function validateUndefinedPaths(paths) {
  if (!Array.isArray(paths)) fail("INVALID_SNAPSHOT", "undefinedOwnPaths must be an array");
  for (const [index, propertyPath] of paths.entries()) {
    if (!Array.isArray(propertyPath) || propertyPath.length === 0 || propertyPath.length > 128) {
      fail("INVALID_SNAPSHOT", `undefinedOwnPaths[${index}] must be a non-empty property path`);
    }
    for (const token of propertyPath) {
      if (typeof token === "string") boundedString(token, `undefinedOwnPaths[${index}] token`, MAX_PATH_LENGTH, { empty: true });
      else if (!Number.isInteger(token) || token < 0) fail("INVALID_SNAPSHOT", `undefinedOwnPaths[${index}] contains an invalid token`);
    }
  }
  return paths;
}

function validateDescriptor(value, label, undefinedPaths, path) {
  plainObject(value, label);
  const kind = value.kind;
  const fieldsByKind = {
    clean: [],
    filesystem: [],
    staged: [],
    unstaged: [],
    untracked: [],
    workspace: ["baseRef", "mergeBase"],
    against: ["baseRef", "mergeBase"],
    commit: ["commitHash", "parentHash", "comparison"],
  };
  if (!Object.hasOwn(fieldsByKind, kind)) fail("INVALID_SNAPSHOT", `${label}.kind is unsupported`);
  exactKeys(value, label, ["kind"], fieldsByKind[kind]);
  for (const key of fieldsByKind[kind]) {
    if (!Object.hasOwn(value, key)) continue;
    if (value[key] === undefined) continue;
    const fieldPath = JSON.stringify([...path, key]);
    if (value[key] === null && undefinedPaths.has(fieldPath)) continue;
    boundedString(value[key], `${label}.${key}`, key === "comparison" ? MAX_ID_LENGTH : MAX_PATH_LENGTH, { empty: key === "parentHash" });
  }
}

function validateDescriptorTree(value, undefinedPaths, path = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, nested] of value.entries()) validateDescriptorTree(nested, undefinedPaths, [...path, index], seen);
  } else {
    for (const [key, nested] of Object.entries(value)) {
      const nestedPath = [...path, key];
      if (key === "descriptor" && nested !== null) {
        validateDescriptor(nested, `snapshot.${nestedPath.join(".")}`, undefinedPaths, nestedPath);
      } else if (key === "workspaceDescriptor" && nested !== null) {
        validateDescriptor(nested, `snapshot.${nestedPath.join(".")}`, undefinedPaths, nestedPath);
      }
      validateDescriptorTree(nested, undefinedPaths, nestedPath, seen);
    }
  }
  seen.delete(value);
}

function validateEncodedSnapshot(value) {
  exactKeys(value, "encoded snapshot", ["schema", "snapshot", "commitPathIndex", "undefinedOwnPaths"]);
  if (value.schema !== SNAPSHOT_SCHEMA) fail("INVALID_SNAPSHOT", `unsupported snapshot schema ${String(value.schema)}`);
  plainObject(value.snapshot, "encoded snapshot.snapshot");
  if (Object.hasOwn(value.snapshot, "commitPathIndex")) {
    fail("INVALID_SNAPSHOT", "encoded snapshot data must not contain commitPathIndex");
  }
  validateJsonValue(value.snapshot, "encoded snapshot.snapshot");
  validateCommitPathEntries(value.commitPathIndex);
  validateUndefinedPaths(value.undefinedOwnPaths);
  validateDescriptorTree(value.snapshot, new Set(value.undefinedOwnPaths.map((propertyPath) => JSON.stringify(propertyPath))));
  return value;
}

export function encodeSnapshot(snapshot) {
  plainObject(snapshot, "snapshot");
  if (!(snapshot.commitPathIndex instanceof Map)) {
    fail("INVALID_SNAPSHOT", "snapshot.commitPathIndex must be a Map");
  }
  validateDescriptorTree(snapshot, new Set());
  const data = Object.create(null);
  const undefinedOwnPaths = [];
  const seen = new Set([snapshot]);
  for (const key of Object.keys(snapshot)) {
    if (key === "commitPathIndex") continue;
    Object.defineProperty(data, key, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: cloneForSnapshot(snapshot[key], [key], undefinedOwnPaths, seen),
    });
  }
  const commitPathIndex = [...snapshot.commitPathIndex.entries()].map(([commit, paths]) => [commit, [...paths]]);
  validateCommitPathEntries(commitPathIndex);
  return {
    schema: SNAPSHOT_SCHEMA,
    snapshot: data,
    commitPathIndex,
    undefinedOwnPaths,
  };
}

export function decodeSnapshot(encoded) {
  validateEncodedSnapshot(encoded);
  const snapshot = JSON.parse(JSON.stringify(encoded.snapshot));
  for (const propertyPath of encoded.undefinedOwnPaths) {
    let target = snapshot;
    for (let index = 0; index < propertyPath.length - 1; index += 1) {
      const token = propertyPath[index];
      if (!target || typeof target !== "object" || !Object.hasOwn(target, token)) {
        fail("INVALID_SNAPSHOT", "undefinedOwnPaths points outside snapshot data");
      }
      target = target[token];
    }
    const key = propertyPath.at(-1);
    if (!target || typeof target !== "object" || !Object.hasOwn(target, key)) {
      fail("INVALID_SNAPSHOT", "undefinedOwnPaths points outside snapshot data");
    }
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: undefined,
    });
  }
  Object.defineProperty(snapshot, "commitPathIndex", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: new Map(encoded.commitPathIndex.map(([commit, paths]) => [commit, [...paths]])),
  });
  return snapshot;
}

export function encodeFrame(message, { maxBytes = MAX_CONTROL_FRAME_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_SNAPSHOT_FRAME_BYTES) {
    throw new TypeError("maxBytes must be a positive integer no greater than MAX_SNAPSHOT_FRAME_BYTES");
  }
  let payload;
  try { payload = Buffer.from(JSON.stringify(message), "utf8"); }
  catch (error) { throw new ProtocolError("INVALID_JSON", `message is not JSON serializable: ${error.message}`); }
  if (payload.length === 0) fail("INVALID_JSON", "message must not encode to an empty payload");
  if (payload.length > maxBytes) fail("FRAME_TOO_LARGE", `message exceeds ${maxBytes} bytes`);
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export function createFrameDecoder({
  maxBytes = MAX_CONTROL_FRAME_BYTES,
  onMessage,
  onError,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_SNAPSHOT_FRAME_BYTES) {
    throw new TypeError("maxBytes must be a positive integer no greater than MAX_SNAPSHOT_FRAME_BYTES");
  }
  if (typeof onMessage !== "function") throw new TypeError("frame decoder requires onMessage");
  if (onError !== undefined && typeof onError !== "function") throw new TypeError("onError must be a function");
  let header = Buffer.alloc(4);
  let headerOffset = 0;
  let payload = null;
  let payloadOffset = 0;
  let failed = false;

  const resetFrame = () => {
    header = Buffer.alloc(4);
    headerOffset = 0;
    payload = null;
    payloadOffset = 0;
  };
  const report = (error) => {
    failed = true;
    resetFrame();
    if (onError) onError(error);
    else throw error;
  };
  const finishPayload = () => {
    let message;
    try { message = JSON.parse(payload.toString("utf8")); }
    catch (error) {
      report(new ProtocolError("INVALID_JSON", `frame contains invalid JSON: ${error.message}`));
      return;
    }
    resetFrame();
    onMessage(message);
  };

  return {
    push(chunk) {
      if (failed) return;
      if (!(chunk instanceof Uint8Array)) return report(new ProtocolError("INVALID_CHUNK", "frame chunk must be bytes"));
      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      let offset = 0;
      while (!failed && offset < bytes.length) {
        if (!payload) {
          const copied = bytes.copy(header, headerOffset, offset, offset + Math.min(4 - headerOffset, bytes.length - offset));
          headerOffset += copied;
          offset += copied;
          if (headerOffset < 4) continue;
          const length = header.readUInt32BE(0);
          if (length === 0) return report(new ProtocolError("INVALID_FRAME", "frame payload must not be empty"));
          if (length > maxBytes) return report(new ProtocolError("FRAME_TOO_LARGE", `frame exceeds ${maxBytes} bytes`));
          payload = Buffer.allocUnsafe(length);
        }
        const copied = bytes.copy(payload, payloadOffset, offset, offset + Math.min(payload.length - payloadOffset, bytes.length - offset));
        payloadOffset += copied;
        offset += copied;
        if (payloadOffset === payload.length) finishPayload();
      }
    },
    end() {
      if (failed) return;
      if (headerOffset || payload) report(new ProtocolError("TRUNCATED_FRAME", "stream ended with a partial frame"));
    },
    reset() {
      failed = false;
      resetFrame();
    },
  };
}

function validateRepositoryDelivery(value) {
  exactKeys(value, "delivery", [
    "engineKey", "stateGeneration", "inputGeneration", "status", "refreshedAt", "reconciliationDueAt",
  ], ["snapshot", "error"]);
  boundedString(value.engineKey, "delivery.engineKey", MAX_PATH_LENGTH);
  finiteNumber(value.stateGeneration, "delivery.stateGeneration", { integer: true });
  finiteNumber(value.inputGeneration, "delivery.inputGeneration", { integer: true });
  if (!["starting", "healthy", "degraded", "stale", "error", "closed"].includes(value.status)) {
    fail("INVALID_FIELD", "delivery.status is unsupported");
  }
  finiteNumber(value.refreshedAt, "delivery.refreshedAt", { nullable: true });
  finiteNumber(value.reconciliationDueAt, "delivery.reconciliationDueAt", { nullable: true });
  if (value.snapshot !== undefined) validateEncodedSnapshot(value.snapshot);
  if (value.error !== undefined) validateSafeError(value.error, "delivery.error");
  return value;
}

export function validateClientMessage(message) {
  plainObject(message, "message");
  boundedString(message.type, "message.type", MAX_ID_LENGTH);
  switch (message.type) {
    case "hello":
      exactKeys(message, "hello", ["type", "protocolVersion", "namespaceId", "clientId"]);
      finiteNumber(message.protocolVersion, "hello.protocolVersion", { integer: true });
      validateNamespace(message.namespaceId);
      validateId(message.clientId, "hello.clientId");
      break;
    case "repository_subscribe":
      exactKeys(message, "repository_subscribe", ["type", "requestId", "subscriptionId", "cwd", "namespaceId"]);
      validateId(message.requestId, "repository_subscribe.requestId");
      validateId(message.subscriptionId, "repository_subscribe.subscriptionId");
      boundedString(message.cwd, "repository_subscribe.cwd", MAX_PATH_LENGTH);
      validateNamespace(message.namespaceId);
      break;
    case "repository_refresh":
    case "host_refresh":
      exactKeys(message, message.type, ["type", "requestId", "subscriptionId", "reason"]);
      validateId(message.requestId, `${message.type}.requestId`);
      validateId(message.subscriptionId, `${message.type}.subscriptionId`);
      boundedString(message.reason, `${message.type}.reason`, MAX_REASON_LENGTH);
      break;
    case "repository_unsubscribe":
    case "host_unsubscribe":
      exactKeys(message, message.type, ["type", "requestId", "subscriptionId"]);
      validateId(message.requestId, `${message.type}.requestId`);
      validateId(message.subscriptionId, `${message.type}.subscriptionId`);
      break;
    case "host_subscribe":
      exactKeys(message, "host_subscribe", ["type", "requestId", "subscriptionId", "selector"]);
      validateId(message.requestId, "host_subscribe.requestId");
      validateId(message.subscriptionId, "host_subscribe.subscriptionId");
      validateSelector(message.selector);
      break;
    case "ping":
      exactKeys(message, "ping", ["type"], ["nonce"]);
      if (message.nonce !== undefined) validateId(message.nonce, "ping.nonce");
      break;
    default:
      fail("UNKNOWN_MESSAGE", `unsupported client message type ${message.type}`);
  }
  return message;
}

export function validateServerMessage(message) {
  plainObject(message, "message");
  boundedString(message.type, "message.type", MAX_ID_LENGTH);
  switch (message.type) {
    case "hello_ack":
      exactKeys(message, "hello_ack", ["type", "protocolVersion", "namespaceId", "coordinatorId"]);
      finiteNumber(message.protocolVersion, "hello_ack.protocolVersion", { integer: true });
      validateNamespace(message.namespaceId);
      validateId(message.coordinatorId, "hello_ack.coordinatorId");
      break;
    case "response":
      exactKeys(message, "response", ["type", "requestId", "ok"], ["value", "error"]);
      validateId(message.requestId, "response.requestId");
      if (typeof message.ok !== "boolean") fail("INVALID_FIELD", "response.ok must be boolean");
      if (message.ok) {
        if (Object.hasOwn(message, "error")) fail("INVALID_FIELD", "successful response must not contain error");
        if (Object.hasOwn(message, "value")) validateJsonValue(message.value, "response.value");
      } else {
        if (!Object.hasOwn(message, "error") || Object.hasOwn(message, "value")) {
          fail("INVALID_FIELD", "failed response requires error and must not contain value");
        }
        validateSafeError(message.error, "response.error");
      }
      break;
    case "repository_delivery":
      exactKeys(message, "repository_delivery", ["type", "subscriptionId", "delivery"]);
      validateId(message.subscriptionId, "repository_delivery.subscriptionId");
      validateRepositoryDelivery(message.delivery);
      break;
    case "host_delivery":
      exactKeys(message, "host_delivery", ["type", "subscriptionId", "context"]);
      validateId(message.subscriptionId, "host_delivery.subscriptionId");
      validateHostContext(message.context);
      break;
    case "status":
      exactKeys(message, "status", ["type", "status"], ["scope", "subscriptionId", "message"]);
      boundedString(message.status, "status.status", MAX_ID_LENGTH);
      if (message.scope !== undefined) boundedString(message.scope, "status.scope", MAX_ID_LENGTH);
      if (message.subscriptionId !== undefined) validateId(message.subscriptionId, "status.subscriptionId");
      if (message.message !== undefined) boundedString(message.message, "status.message", MAX_MESSAGE_LENGTH, { empty: true });
      break;
    case "error":
      exactKeys(message, "error", ["type", "code", "message"], ["requestId", "subscriptionId"]);
      boundedString(message.code, "error.code", MAX_ID_LENGTH);
      boundedString(message.message, "error.message", MAX_MESSAGE_LENGTH);
      if (message.requestId !== undefined) validateId(message.requestId, "error.requestId");
      if (message.subscriptionId !== undefined) validateId(message.subscriptionId, "error.subscriptionId");
      break;
    case "pong":
      exactKeys(message, "pong", ["type"], ["nonce"]);
      if (message.nonce !== undefined) validateId(message.nonce, "pong.nonce");
      break;
    default:
      fail("UNKNOWN_MESSAGE", `unsupported server message type ${message.type}`);
  }
  return message;
}
