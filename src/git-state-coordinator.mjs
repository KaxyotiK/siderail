import fs from "node:fs/promises";
import fsSync from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";
import {
  MAX_BLOCKED_WRITE_MS,
  MAX_CONTROL_FRAME_BYTES,
  MAX_QUEUED_CONTROL_BYTES,
  MAX_QUEUED_CONTROL_MESSAGES,
  MAX_SNAPSHOT_FRAME_BYTES,
  PROTOCOL_VERSION,
  createFrameDecoder,
  encodeFrame,
  encodeSnapshot,
  validateClientMessage,
  validateServerMessage,
} from "./git-state-protocol.mjs";
import { resolveRepositoryIdentity } from "./git-state-identity.mjs";
import { createRepositoryEngine } from "./repository-engine.mjs";
import { createRepositoryWatcher } from "./git-invalidation.mjs";

function safeError(error, fallbackCode = "COORDINATOR_ERROR") {
  return {
    code: String(error?.code || fallbackCode).slice(0, 64),
    message: String(error?.message || error || "Coordinator request failed").slice(0, 1_024),
  };
}

function deliveryForWire(delivery) {
  return {
    ...delivery,
    ...(delivery?.snapshot ? { snapshot: encodeSnapshot(delivery.snapshot) } : {}),
  };
}

function performanceComponent(environment, entry) {
  const target = environment.GIT_RAIL_PERFORMANCE_LOG;
  if (!target) return;
  try {
    fsSync.appendFileSync(target, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "component",
      role: "coordinator",
      pid: process.pid,
      ...entry,
    })}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {}
}

function createSocketWriter(socket, {
  blockedWriteMs = MAX_BLOCKED_WRITE_MS,
  maxControlMessages = MAX_QUEUED_CONTROL_MESSAGES,
  maxControlBytes = MAX_QUEUED_CONTROL_BYTES,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const controls = [];
  const latestDeliveries = new Map();
  let controlBytes = 0;
  let blocked = false;
  let closed = false;
  let blockedTimer;

  const stopBlockedTimer = () => {
    clearTimer(blockedTimer);
    blockedTimer = undefined;
  };
  const failBlocked = () => socket.destroy(Object.assign(new Error("Git state client stopped reading"), {
    code: "GIT_STATE_BACKPRESSURE_TIMEOUT",
  }));
  const writeFrame = (frame) => {
    if (closed) return false;
    blocked = !socket.write(frame);
    if (blocked && !blockedTimer) {
      blockedTimer = setTimer(failBlocked, blockedWriteMs);
      blockedTimer.unref?.();
    }
    return !blocked;
  };
  const flush = () => {
    if (closed || blocked) return;
    stopBlockedTimer();
    while (!blocked && controls.length) {
      const frame = controls.shift();
      controlBytes -= frame.length;
      writeFrame(frame);
    }
    if (blocked) return;
    for (const [subscriptionId, frame] of latestDeliveries) {
      latestDeliveries.delete(subscriptionId);
      if (!writeFrame(frame)) break;
    }
  };
  const send = (message, { delivery = false } = {}) => {
    validateServerMessage(message);
    const frame = encodeFrame(message, {
      maxBytes: delivery ? MAX_SNAPSHOT_FRAME_BYTES : MAX_CONTROL_FRAME_BYTES,
    });
    if (!blocked && controls.length === 0 && latestDeliveries.size === 0) {
      writeFrame(frame);
      return;
    }
    if (delivery) {
      latestDeliveries.set(message.subscriptionId, frame);
      return;
    }
    if (controls.length >= maxControlMessages || controlBytes + frame.length > maxControlBytes) {
      socket.destroy(Object.assign(new Error("Git state control queue exceeded its bound"), {
        code: "GIT_STATE_BACKPRESSURE_LIMIT",
      }));
      return;
    }
    controls.push(frame);
    controlBytes += frame.length;
  };

  socket.on("drain", () => {
    blocked = false;
    flush();
  });
  socket.on("close", () => {
    closed = true;
    stopBlockedTimer();
    controls.length = 0;
    latestDeliveries.clear();
  });
  return { send, flush };
}

export function createGitStateCoordinator({
  namespaceId,
  coordinatorId = randomUUID(),
  environment = process.env,
  providerConfig = {},
  schedulerConfig = {},
  engineFactory = ({ context }) => createRepositoryEngine({
    context,
    watchFactory: createRepositoryWatcher,
  }),
  resolveIdentity = ({ cwd }) => resolveRepositoryIdentity({
    cwd,
    environment,
    providerConfig,
    schedulerConfig,
    codeVersion: namespaceId,
  }),
  hostSourceFactory,
  idleGraceMs = 0,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onIdle = () => {},
  createServer = (listener) => net.createServer(listener),
} = {}) {
  if (typeof namespaceId !== "string" || !namespaceId) throw new TypeError("coordinator requires namespaceId");
  if (!Number.isInteger(idleGraceMs) || idleGraceMs < 0 || idleGraceMs > 30_000) {
    throw new TypeError("idleGraceMs must be an integer from 0 to 30000");
  }
  const engines = new Map();
  const unshareable = new Map();
  const sessions = new Set();
  let hostSource;
  let hostSubscribers = 0;
  let server;
  let closed = false;
  performanceComponent(environment, { phase: "started", owner: namespaceId });

  const maybeIdle = () => {
    if (!closed && engines.size === 0 && sessions.size === 0 && hostSubscribers === 0) onIdle();
  };
  const releaseEngineLater = (entry) => {
    if (entry.subscribers.size || entry.closeTimer || closed) return;
    entry.closeTimer = setTimer(async () => {
      entry.closeTimer = undefined;
      if (entry.subscribers.size || engines.get(entry.key) !== entry) return;
      engines.delete(entry.key);
      try { await entry.engine.close(); } catch {}
      maybeIdle();
    }, idleGraceMs);
    entry.closeTimer.unref?.();
  };
  const acquireEngine = async (cwd) => {
    const identity = await resolveIdentity({ cwd, environment });
    const key = `${namespaceId}:${identity.identityId}`;
    if (unshareable.has(key)) throw unshareable.get(key);
    let entry = engines.get(key);
    if (!entry) {
      const scope = identity.worktreeRoot || identity.canonicalCwd;
      entry = [...engines.values()].find((candidate) => (
        (candidate.identity.worktreeRoot || candidate.identity.canonicalCwd) === scope
        // Only repository creation/removal migrates an existing scope. A new
        // Git directory or index identity must get its own immutable context.
        && candidate.identity.kind !== identity.kind
      ));
      if (entry) {
        engines.delete(entry.key);
        entry.key = key;
        entry.identity = identity;
        engines.set(key, entry);
      }
    }
    if (!entry) {
      const context = Object.freeze({
        cwd: identity.worktreeRoot || identity.canonicalCwd,
        engineKey: key,
        environment: Object.freeze({ ...environment }),
        schedulerConfig: Object.freeze({ ...schedulerConfig }),
        providerConfig: Object.freeze({ ...providerConfig }),
        repositoryIdentity: identity,
      });
      const engine = engineFactory({ context, identity });
      entry = { key, identity, engine, subscribers: new Set(), closeTimer: undefined };
      engines.set(key, entry);
    }
    if (entry.closeTimer) {
      clearTimer(entry.closeTimer);
      entry.closeTimer = undefined;
    }
    return entry;
  };

  const accept = (socket) => {
    if (closed) return socket.destroy();
    socket.setNoDelay?.(true);
    const writer = createSocketWriter(socket, { setTimer, clearTimer });
    const repositorySubscriptions = new Map();
    const hostSubscriptions = new Map();
    let handshaken = false;
    let sessionClosed = false;

    const sendResponse = (requestId, value) => writer.send({
      type: "response", requestId, ok: true, ...(value === undefined ? {} : { value }),
    });
    const sendFailure = (requestId, error) => writer.send({
      type: "response", requestId, ok: false, error: safeError(error),
    });
    const sendRepository = (subscriptionId, delivery) => {
      try {
        writer.send({
          type: "repository_delivery",
          subscriptionId,
          delivery: deliveryForWire(delivery),
        }, { delivery: true });
      } catch (cause) {
        const subscription = repositorySubscriptions.get(subscriptionId);
        const code = cause?.code === "FRAME_TOO_LARGE"
          ? "GIT_STATE_SNAPSHOT_TOO_LARGE"
          : "GIT_STATE_SNAPSHOT_UNSHAREABLE";
        const error = Object.assign(new Error(
          code === "GIT_STATE_SNAPSHOT_TOO_LARGE"
            ? "Repository snapshot exceeds the shared-state transport limit"
            : "Repository snapshot cannot be encoded for shared state",
        ), { code, cause });
        if (subscription) unshareable.set(subscription.entry.key, error);
        writer.send({ type: "error", code, message: error.message, subscriptionId });
        removeRepository(subscriptionId);
      }
    };
    const sendHost = (subscriptionId, context) => writer.send({
      type: "host_delivery", subscriptionId, context,
    }, { delivery: true });

    const removeRepository = (subscriptionId) => {
      const subscription = repositorySubscriptions.get(subscriptionId);
      if (!subscription) return;
      repositorySubscriptions.delete(subscriptionId);
      subscription.unsubscribe();
      subscription.entry.subscribers.delete(subscription);
      releaseEngineLater(subscription.entry);
    };
    const removeHost = (subscriptionId) => {
      const subscription = hostSubscriptions.get(subscriptionId);
      if (!subscription) return;
      hostSubscriptions.delete(subscriptionId);
      subscription.unsubscribe();
      hostSubscribers -= 1;
      if (hostSubscribers === 0 && hostSource) {
        hostSource.close();
        hostSource = undefined;
      }
      maybeIdle();
    };

    const handleRepositorySubscribe = async (message) => {
      if (repositorySubscriptions.size && !repositorySubscriptions.has(message.subscriptionId)) {
        throw Object.assign(new Error("One repository subscription is allowed per connection"), {
          code: "GIT_STATE_SUBSCRIPTION_LIMIT",
        });
      }
      removeRepository(message.subscriptionId);
      const entry = await acquireEngine(message.cwd);
      const subscription = { entry, unsubscribe: () => {} };
      entry.subscribers.add(subscription);
      repositorySubscriptions.set(message.subscriptionId, subscription);
      try { await entry.engine.ready; }
      catch (error) {
        removeRepository(message.subscriptionId);
        throw error;
      }
      if (sessionClosed || repositorySubscriptions.get(message.subscriptionId) !== subscription) return;
      subscription.unsubscribe = entry.engine.subscribe((delivery) => {
        if (!sessionClosed && repositorySubscriptions.get(message.subscriptionId) === subscription) {
          sendRepository(message.subscriptionId, delivery);
        }
      });
      sendResponse(message.requestId, { identityId: entry.identity.identityId });
    };
    const handleRepositoryRefresh = async (message) => {
      const subscription = repositorySubscriptions.get(message.subscriptionId);
      if (!subscription) throw Object.assign(new Error("Unknown repository subscription"), {
        code: "GIT_STATE_UNKNOWN_SUBSCRIPTION",
      });
      const delivery = await subscription.entry.engine.refresh(message.reason || "remote-manual");
      sendResponse(message.requestId, {
        stateGeneration: delivery.stateGeneration,
        inputGeneration: delivery.inputGeneration,
      });
    };
    const handleHostSubscribe = async (message) => {
      if (!hostSourceFactory) throw Object.assign(new Error("Host context source is unavailable"), {
        code: "GIT_STATE_HOST_UNAVAILABLE",
      });
      if (hostSubscriptions.size && !hostSubscriptions.has(message.subscriptionId)) {
        throw Object.assign(new Error("One host subscription is allowed per connection"), {
          code: "GIT_STATE_SUBSCRIPTION_LIMIT",
        });
      }
      removeHost(message.subscriptionId);
      hostSource ||= hostSourceFactory({ environment });
      hostSubscribers += 1;
      const subscription = { handle: undefined, latestContext: null, unsubscribe: () => {} };
      const handle = hostSource.subscribe(message.selector, (context) => {
        if (!sessionClosed && hostSubscriptions.get(message.subscriptionId) === subscription) {
          subscription.latestContext = context;
          sendHost(message.subscriptionId, context);
        }
      });
      subscription.handle = handle;
      subscription.unsubscribe = () => handle.unsubscribe();
      hostSubscriptions.set(message.subscriptionId, subscription);
      const context = await handle.ready;
      subscription.latestContext = context;
      if (sessionClosed || hostSubscriptions.get(message.subscriptionId) !== subscription) return;
      sendResponse(message.requestId);
      if (context) sendHost(message.subscriptionId, context);
    };
    const handleMessage = async (input) => {
      const message = validateClientMessage(input);
      if (!handshaken) {
        if (message.type !== "hello") throw Object.assign(new Error("Git state handshake required"), {
          code: "GIT_STATE_HANDSHAKE_REQUIRED",
        });
        if (message.protocolVersion !== PROTOCOL_VERSION || message.namespaceId !== namespaceId) {
          throw Object.assign(new Error("Git state namespace or protocol mismatch"), {
            code: "GIT_STATE_INCOMPATIBLE",
          });
        }
        handshaken = true;
        writer.send({ type: "hello_ack", protocolVersion: PROTOCOL_VERSION, namespaceId, coordinatorId });
        return;
      }
      if (message.type === "ping") return writer.send({ type: "pong", nonce: message.nonce });
      try {
        if (message.type === "repository_subscribe") await handleRepositorySubscribe(message);
        else if (message.type === "repository_refresh") await handleRepositoryRefresh(message);
        else if (message.type === "repository_unsubscribe") {
          removeRepository(message.subscriptionId);
          sendResponse(message.requestId);
        } else if (message.type === "host_subscribe") await handleHostSubscribe(message);
        else if (message.type === "host_refresh") {
          if (!hostSubscriptions.has(message.subscriptionId)) throw Object.assign(new Error("Unknown host subscription"), { code: "GIT_STATE_UNKNOWN_SUBSCRIPTION" });
          const subscription = hostSubscriptions.get(message.subscriptionId);
          const result = await hostSource.requestRefresh(message.reason || "remote-manual");
          const context = subscription.handle.context || subscription.latestContext;
          sendResponse(message.requestId, { ok: Boolean(result?.ok), ...(context ? { context } : {}) });
        } else if (message.type === "host_unsubscribe") {
          removeHost(message.subscriptionId);
          sendResponse(message.requestId);
        } else throw Object.assign(new Error(`Unsupported client message: ${message.type}`), {
          code: "GIT_STATE_UNSUPPORTED_MESSAGE",
        });
      } catch (error) {
        if (message.requestId) sendFailure(message.requestId, error);
        else throw error;
      }
    };
    const decoder = createFrameDecoder({
      maxBytes: MAX_CONTROL_FRAME_BYTES,
      onMessage: (message) => Promise.resolve(handleMessage(message)).catch((error) => {
        const safe = safeError(error, "GIT_STATE_PROTOCOL_ERROR");
        try { writer.send({ type: "error", code: safe.code, message: safe.message }); } catch {}
        socket.destroy(error);
      }),
      onError: (error) => socket.destroy(error),
    });
    socket.on("data", (chunk) => decoder.push(chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      if (sessionClosed) return;
      sessionClosed = true;
      decoder.end?.();
      for (const id of [...repositorySubscriptions.keys()]) removeRepository(id);
      for (const id of [...hostSubscriptions.keys()]) removeHost(id);
      sessions.delete(session);
      maybeIdle();
    });
    const session = { socket, repositorySubscriptions, hostSubscriptions };
    sessions.add(session);
  };

  async function listen(socketPath) {
    if (closed) throw new Error("Git state coordinator is closed");
    if (server) throw new Error("Git state coordinator is already listening");
    server = createServer(accept);
    await new Promise((resolve, reject) => {
      const failed = (error) => { server.removeListener("listening", ready); reject(error); };
      const ready = () => { server.removeListener("error", failed); resolve(); };
      server.once("error", failed);
      server.once("listening", ready);
      server.listen(socketPath);
    });
    await fs.chmod(socketPath, 0o600);
    performanceComponent(environment, { phase: "ready", owner: namespaceId });
    return socketPath;
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const session of sessions) session.socket.destroy();
    sessions.clear();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    server = undefined;
    for (const entry of engines.values()) {
      clearTimer(entry.closeTimer);
      try { await entry.engine.close(); } catch {}
    }
    engines.clear();
    hostSource?.close();
    hostSource = undefined;
    hostSubscribers = 0;
    performanceComponent(environment, { phase: "stopped", owner: namespaceId });
  }

  return {
    listen,
    close,
    get status() {
      return {
        closed,
        listening: Boolean(server?.listening),
        sessions: sessions.size,
        engines: engines.size,
        repositorySubscriptions: [...engines.values()].reduce((total, entry) => total + entry.subscribers.size, 0),
        hostSubscribers,
      };
    },
  };
}
