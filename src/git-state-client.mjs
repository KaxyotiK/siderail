import net from "node:net";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import {
  MAX_BLOCKED_WRITE_MS,
  MAX_CONTROL_FRAME_BYTES,
  MAX_QUEUED_CONTROL_BYTES,
  MAX_QUEUED_CONTROL_MESSAGES,
  MAX_SNAPSHOT_FRAME_BYTES,
  PROTOCOL_VERSION,
  createFrameDecoder,
  decodeSnapshot,
  encodeFrame,
  validateServerMessage,
} from "./git-state-protocol.mjs";
import { readProcessStartIdentity } from "./git-state-runtime.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function remoteError(error = {}) {
  return Object.assign(new Error(error.message || "Git state coordinator request failed"), {
    code: error.code || "GIT_STATE_REMOTE_ERROR",
  });
}

function deliveryFromWire(delivery) {
  return {
    ...delivery,
    ...(delivery?.snapshot ? { snapshot: decodeSnapshot(delivery.snapshot) } : {}),
  };
}

const HOST_CONTEXT_KEYS = Object.freeze([
  "cwd", "sourcePaneId", "tabId", "workspaceId", "railPaneId", "railTerminalId", "hasContent", "visible",
]);

function sameHostContext(left, right) {
  return Boolean(left && right && HOST_CONTEXT_KEYS.every((key) => left[key] === right[key]));
}

function openSocket(path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error("Git state coordinator connection timed out"), {
        code: "GIT_STATE_CONNECT_TIMEOUT",
      }));
    }, timeoutMs);
    timer.unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

async function readLeaseOwner(leasePath) {
  try { return JSON.parse(await fs.readFile(leasePath, "utf8")); }
  catch { return null; }
}

export function createGitStateCoordinatorLauncher({
  namespaceId,
  socketPath,
  leasePath,
  environment = process.env,
  launcherPath = fileURLToPath(new URL("../scripts/git-state-coordinator.mjs", import.meta.url)),
  spawnProcess = spawn,
  staleClaimMs = 5_000,
  now = Date.now,
} = {}) {
  if (![namespaceId, socketPath, leasePath, launcherPath].every((value) => typeof value === "string" && value)) {
    throw new TypeError("coordinator launcher requires namespaceId, socketPath, leasePath, and launcherPath");
  }
  let child;

  const liveIdentity = async (record, pidKey = "pid", identityKey = "processStartIdentity") => {
    const pid = record?.[pidKey];
    if (!processAlive(pid)) return false;
    if (!record?.[identityKey]) return true;
    try {
      return record[identityKey] === await readProcessStartIdentity(pid);
    } catch {
      return true;
    }
  };

  async function reclaimStaleLease() {
    const claim = await readLeaseOwner(leasePath);
    const ownerPath = claim?.nonce ? `${leasePath}.${claim.nonce}.owner.json` : "";
    const owner = ownerPath ? await readLeaseOwner(ownerPath) : null;
    let age;
    try { age = Math.max(0, now() - (await fs.stat(leasePath)).mtimeMs); } catch { return true; }
    if (owner ? await liveIdentity(owner) : await liveIdentity(claim, "claimantPid", "claimantStartIdentity")) {
      return false;
    }
    if (!owner?.pid && age < staleClaimMs) return false;
    const tombstone = `${leasePath}.stale-${randomUUID()}`;
    try { await fs.rename(leasePath, tombstone); }
    catch (error) { return error.code === "ENOENT"; }
    try { await fs.unlink(socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (ownerPath) await fs.rm(ownerPath, { force: true });
    await fs.rm(tombstone, { force: true });
    return true;
  }

  async function launch() {
    if (child && child.exitCode === null
      && (child.signalCode === null || child.signalCode === undefined) && !child.killed) {
      return { owner: true, pid: child.pid };
    }
    await fs.mkdir(path.dirname(leasePath), { recursive: true, mode: 0o700 });
    const electionPath = `${leasePath}.election`;
    const electionOwnerPath = path.join(electionPath, "owner.json");
    const electionNonce = randomUUID();
    const electionOwner = {
      nonce: electionNonce,
      pid: process.pid,
      processStartIdentity: await readProcessStartIdentity(process.pid),
      createdAt: now(),
    };
    let electionStat;

    const ownsElection = async () => {
      const current = await readLeaseOwner(electionOwnerPath);
      return current?.nonce === electionNonce
        && current.pid === electionOwner.pid
        && current.processStartIdentity === electionOwner.processStartIdentity;
    };
    const restoreDisplacedElection = async (tombstone) => {
      try { await fs.rename(tombstone, electionPath); }
      catch (error) {
        if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
      }
    };
    const reclaimStaleElection = async () => {
      let observedStat;
      try { observedStat = await fs.stat(electionPath); }
      catch (error) { return error.code === "ENOENT"; }
      const observedOwner = await readLeaseOwner(electionOwnerPath);
      if (await liveIdentity(observedOwner)) return false;
      const age = Math.max(0, now() - observedStat.mtimeMs);
      // mkdir and owner-file creation are separate syscalls. Never classify that
      // small construction window as abandoned, even in zero-delay tests.
      if (!observedOwner?.pid && age < Math.max(staleClaimMs, 1_000)) return false;

      const tombstone = `${electionPath}.stale-${randomUUID()}`;
      try { await fs.rename(electionPath, tombstone); }
      catch (error) { return error.code === "ENOENT"; }
      const [movedStat, movedOwner] = await Promise.all([
        fs.stat(tombstone),
        readLeaseOwner(path.join(tombstone, "owner.json")),
      ]);
      const sameDirectory = movedStat.dev === observedStat.dev && movedStat.ino === observedStat.ino;
      const sameOwner = observedOwner
        ? movedOwner?.nonce === observedOwner.nonce
          && movedOwner.pid === observedOwner.pid
          && movedOwner.processStartIdentity === observedOwner.processStartIdentity
        : !movedOwner;
      if (!sameDirectory || !sameOwner) {
        await restoreDisplacedElection(tombstone);
        return false;
      }
      await fs.rm(tombstone, { recursive: true, force: true });
      return true;
    };
    let elected = false;
    for (let attempt = 0; attempt < 3 && !elected; attempt += 1) {
      try {
        await fs.mkdir(electionPath, { mode: 0o700 });
        electionStat = await fs.stat(electionPath);
        await fs.writeFile(electionOwnerPath, JSON.stringify(electionOwner), { mode: 0o600, flag: "wx" });
        elected = true;
      } catch (error) {
        if (error.code === "ENOENT") continue;
        if (error.code !== "EEXIST") throw error;
        if (!await reclaimStaleElection()) return { owner: false };
      }
    }
    if (!elected) return { owner: false };
    const nonce = randomUUID();
    let claimed = false;
    try {
      const claim = JSON.stringify({
        nonce,
        claimantPid: process.pid,
        claimantStartIdentity: await readProcessStartIdentity(process.pid),
        namespaceId,
        createdAt: now(),
      });
      for (let attempt = 0; attempt < 2 && !claimed; attempt += 1) {
        if (!await ownsElection()) return { owner: false };
        try {
          await fs.writeFile(leasePath, claim, { mode: 0o600, flag: "wx" });
          claimed = true;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          if (!await reclaimStaleLease()) return { owner: false };
        }
      }
    } finally {
      if (await ownsElection()) {
        const currentStat = await fs.stat(electionPath).catch(() => null);
        if (currentStat?.dev === electionStat.dev && currentStat.ino === electionStat.ino) {
          await fs.rm(electionPath, { recursive: true, force: true });
        }
      }
    }
    if (!claimed) return { owner: false };
    try {
      child = spawnProcess(process.execPath, [
        launcherPath,
        "--namespace", namespaceId,
        "--socket", socketPath,
        "--lease", leasePath,
        "--nonce", nonce,
      ], {
        detached: true,
        stdio: "ignore",
        env: { ...environment },
      });
      child.once("error", async () => {
        const current = await readLeaseOwner(leasePath);
        if (current?.nonce === nonce) {
          await fs.rm(leasePath, { force: true });
          await fs.rm(`${leasePath}.${nonce}.owner.json`, { force: true });
        }
      });
      child.once("exit", async () => {
        const current = await readLeaseOwner(leasePath);
        const owner = await readLeaseOwner(`${leasePath}.${nonce}.owner.json`);
        if (current?.nonce === nonce && (!owner?.pid || !processAlive(owner.pid))) {
          await fs.rm(leasePath, { force: true });
          await fs.rm(`${leasePath}.${nonce}.owner.json`, { force: true });
        }
      });
      child.unref();
      return { owner: true, pid: child.pid };
    } catch (error) {
      const current = await readLeaseOwner(leasePath);
      if (current?.nonce === nonce) {
        await fs.rm(leasePath, { force: true });
        await fs.rm(`${leasePath}.${nonce}.owner.json`, { force: true });
      }
      throw error;
    }
  }

  return { launch };
}

export function createGitStateClient({
  namespaceId,
  socketPath,
  launchCoordinator = async () => {},
  connect = () => openSocket(socketPath, 2_000),
  clientId = randomUUID(),
  createId = randomUUID,
  connectTimeoutMs = 5_000,
  retryDelayMs = 25,
  maxRetryDelayMs = 500,
  blockedWriteMs = MAX_BLOCKED_WRITE_MS,
  handshakeTimeoutMs = 2_000,
  requestTimeoutMs = 5_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof namespaceId !== "string" || !namespaceId) throw new TypeError("Git state client requires namespaceId");
  if (typeof socketPath !== "string" || !socketPath) throw new TypeError("Git state client requires socketPath");
  const subscriptions = new Map();
  const pendingRequests = new Map();
  let socket;
  let connecting;
  let connectionEpoch = 0;
  let requestSequence = 0;
  let closed = false;
  let blocked = false;
  let blockedTimer;
  let reconnectTimer;
  let lastConnectionError;
  const outboundQueue = [];
  let outboundBytes = 0;
  const hasPendingInitialSubscription = () => [...subscriptions.values()].some((record) => (
    !record.closed && !record.initialSettled
  ));

  const nextId = (prefix) => `${prefix}-${clientId}-${++requestSequence}-${createId()}`;
  const clearBlockedTimer = () => {
    clearTimer(blockedTimer);
    blockedTimer = undefined;
  };
  const failPending = (error) => {
    for (const pending of pendingRequests.values()) {
      clearTimer(pending.timer);
      pending.reject(error);
    }
    pendingRequests.clear();
  };
  const writeFrame = (frame) => {
    blocked = !socket.write(frame);
    if (blocked && !blockedTimer) {
      blockedTimer = setTimer(() => socket?.destroy(Object.assign(new Error("Git state coordinator stopped reading"), {
        code: "GIT_STATE_BACKPRESSURE_TIMEOUT",
      })), blockedWriteMs);
      blockedTimer.unref?.();
    }
  };
  const flushOutbound = () => {
    if (blocked || !socket || socket.destroyed) return;
    clearBlockedTimer();
    while (!blocked && outboundQueue.length) {
      const frame = outboundQueue.shift();
      outboundBytes -= frame.length;
      writeFrame(frame);
    }
  };
  const send = (message) => {
    if (!socket || socket.destroyed) throw Object.assign(new Error("Git state coordinator is disconnected"), {
      code: "GIT_STATE_DISCONNECTED",
    });
    const frame = encodeFrame(message, { maxBytes: MAX_CONTROL_FRAME_BYTES });
    if (!blocked && outboundQueue.length === 0) {
      writeFrame(frame);
      return;
    }
    if (outboundQueue.length >= MAX_QUEUED_CONTROL_MESSAGES || outboundBytes + frame.length > MAX_QUEUED_CONTROL_BYTES) {
      const error = Object.assign(new Error("Git state client control queue exceeded its bound"), {
        code: "GIT_STATE_BACKPRESSURE_LIMIT",
      });
      socket.destroy(error);
      throw error;
    }
    outboundQueue.push(frame);
    outboundBytes += frame.length;
  };
  const request = async (message) => {
    await ensureConnection();
    const requestId = nextId("request");
    const pending = deferred();
    pending.timer = setTimer(() => {
      if (!pendingRequests.delete(requestId)) return;
      pending.reject(Object.assign(new Error("Git state coordinator request timed out"), {
        code: "GIT_STATE_REQUEST_TIMEOUT",
      }));
    }, requestTimeoutMs);
    pending.timer.unref?.();
    pendingRequests.set(requestId, pending);
    try { send({ ...message, requestId }); }
    catch (error) {
      pendingRequests.delete(requestId);
      clearTimer(pending.timer);
      throw error;
    }
    return pending.promise;
  };

  const resolveInitial = (record, value) => {
    if (!record.initialSettled) {
      record.initialSettled = true;
      record.initial.resolve(value);
    }
  };
  const rejectInitial = (record, error) => {
    if (!record.initialSettled) {
      record.initialSettled = true;
      record.initial.reject(error);
    }
  };
  const publishRepository = (record, encoded) => {
    const decoded = deliveryFromWire(encoded);
    const serverGeneration = decoded.stateGeneration;
    if (record.serverEpoch !== connectionEpoch || record.serverGeneration !== serverGeneration) {
      record.localGeneration += 1;
      record.serverEpoch = connectionEpoch;
      record.serverGeneration = serverGeneration;
    }
    const delivery = Object.freeze({ ...decoded, stateGeneration: record.localGeneration });
    record.latest = delivery;
    resolveInitial(record, delivery);
    try { record.listener(delivery); } catch {}
    for (const waiter of [...record.refreshWaiters]) {
      if (waiter.epoch < connectionEpoch || serverGeneration >= waiter.generation) {
        record.refreshWaiters.delete(waiter);
        waiter.resolve(delivery);
      }
    }
  };
  const publishHost = (record, context) => {
    record.selector = Object.freeze({
      ...record.selector,
      ...(context.railPaneId ? { railPaneId: context.railPaneId } : {}),
      ...(context.railTerminalId ? { railTerminalId: context.railTerminalId } : {}),
    });
    if (sameHostContext(record.latest, context)) return record.latest;
    record.latest = Object.freeze({ ...context });
    resolveInitial(record, record.latest);
    try { record.listener(record.latest); } catch {}
    return record.latest;
  };

  const handleMessage = (input, handshake) => {
    const message = validateServerMessage(input);
    if (!handshake.settled) {
      if (message.type !== "hello_ack" || message.protocolVersion !== PROTOCOL_VERSION || message.namespaceId !== namespaceId) {
        throw Object.assign(new Error("Git state coordinator handshake mismatch"), {
          code: "GIT_STATE_INCOMPATIBLE",
        });
      }
      handshake.settled = true;
      clearTimer(handshake.timer);
      handshake.resolve();
      return;
    }
    if (message.type === "response") {
      const pending = pendingRequests.get(message.requestId);
      if (!pending) return;
      pendingRequests.delete(message.requestId);
      clearTimer(pending.timer);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(remoteError(message.error));
      return;
    }
    if (message.type === "repository_delivery") {
      const record = subscriptions.get(message.subscriptionId);
      if (record?.kind === "repository" && !record.closed) publishRepository(record, message.delivery);
      return;
    }
    if (message.type === "host_delivery") {
      const record = subscriptions.get(message.subscriptionId);
      if (record?.kind === "host" && !record.closed) publishHost(record, message.context);
      return;
    }
    if (message.type === "error" && message.subscriptionId) {
      const record = subscriptions.get(message.subscriptionId);
      if (!record) return;
      const error = remoteError({ code: message.code, message: message.message });
      rejectInitial(record, error);
      try { record.onError?.(error); } catch {}
      for (const waiter of record.refreshWaiters) waiter.reject(error);
      record.refreshWaiters.clear();
      record.closed = true;
      subscriptions.delete(record.id);
      return;
    }
    if (message.type === "error") throw remoteError({ code: message.code, message: message.message });
  };

  const subscribeRecord = async (record) => {
    await ensureConnection();
    if (record.closed || record.subscribedEpoch === connectionEpoch) return;
    const epoch = connectionEpoch;
    // Recorded before the request so a close while it is pending still
    // unsubscribes; the coordinator would otherwise keep the subscription.
    record.requestedEpoch = epoch;
    if (record.kind === "repository") {
      await request({
        type: "repository_subscribe",
        subscriptionId: record.id,
        cwd: record.context.cwd,
        namespaceId,
      });
    } else {
      await request({ type: "host_subscribe", subscriptionId: record.id, selector: record.selector });
    }
    if (!record.closed && connectionEpoch === epoch) record.subscribedEpoch = epoch;
  };

  const resubscribe = async () => {
    await Promise.allSettled([...subscriptions.values()].filter((record) => !record.closed).map(async (record) => {
      try { await subscribeRecord(record); }
      catch (error) { if (connectionEpoch && !record.initialSettled) rejectInitial(record, error); }
    }));
  };

  async function establishConnection() {
    const startedAt = Date.now();
    let nextLaunchAt = 0;
    let delay = retryDelayMs;
    while (!closed) {
      try {
        const candidate = await connect();
        if (closed) { candidate.destroy(); throw new Error("Git state client is closed"); }
        const handshake = deferred();
        handshake.settled = false;
        handshake.timer = setTimer(() => {
          if (handshake.settled) return;
          handshake.settled = true;
          const error = Object.assign(new Error("Git state coordinator handshake timed out"), {
            code: "GIT_STATE_HANDSHAKE_TIMEOUT",
          });
          handshake.reject(error);
          candidate.destroy(error);
        }, handshakeTimeoutMs);
        handshake.timer.unref?.();
        const candidateDecoder = createFrameDecoder({
          maxBytes: MAX_SNAPSHOT_FRAME_BYTES,
          onMessage: (message) => {
            try { handleMessage(message, handshake); }
            catch (error) { candidate.destroy(error); }
          },
          onError: (error) => candidate.destroy(error),
        });
        candidate.on("data", (chunk) => candidateDecoder.push(chunk));
        candidate.on("drain", () => { blocked = false; flushOutbound(); });
        candidate.on("error", () => {});
        candidate.on("close", () => {
          if (!handshake.settled) {
            handshake.settled = true;
            clearTimer(handshake.timer);
            handshake.reject(Object.assign(new Error("Git state coordinator closed during handshake"), {
              code: "GIT_STATE_DISCONNECTED",
            }));
          }
          if (socket !== candidate) return;
          socket = undefined;
          blocked = false;
          clearBlockedTimer();
          outboundQueue.length = 0;
          outboundBytes = 0;
          const error = Object.assign(new Error("Git state coordinator disconnected"), {
            code: "GIT_STATE_DISCONNECTED",
          });
          failPending(error);
          for (const record of subscriptions.values()) {
            record.subscribedEpoch = 0;
            if (record.kind === "repository" && record.latest) {
              record.latest = Object.freeze({
                ...record.latest,
                status: "stale",
                error: { code: error.code, message: error.message },
              });
              try { record.listener(record.latest); } catch {}
            }
          }
          if (!closed && subscriptions.size) ensureConnection().catch(() => {});
        });
        socket = candidate;
        send({ type: "hello", protocolVersion: PROTOCOL_VERSION, namespaceId, clientId });
        await handshake.promise;
        connectionEpoch += 1;
        lastConnectionError = undefined;
        clearTimer(reconnectTimer);
        reconnectTimer = undefined;
        await resubscribe();
        return candidate;
      } catch (error) {
        if (closed) throw error;
        // A socket can close just before its child exit event is delivered.
        // Retry the idempotent election while disconnected instead of caching
        // that first, still-alive owner for an entire connection window.
        if (Date.now() >= nextLaunchAt) {
          nextLaunchAt = Date.now() + maxRetryDelayMs;
          try { await launchCoordinator(); } catch {}
        }
        if (Date.now() - startedAt >= connectTimeoutMs) {
          throw Object.assign(new Error(`Git state coordinator unavailable: ${error.message}`), {
            code: "GIT_STATE_UNAVAILABLE",
            cause: error,
          });
        }
        await new Promise((resolve) => {
          const timer = setTimer(resolve, delay);
          if (!hasPendingInitialSubscription()) timer.unref?.();
        });
        delay = Math.min(maxRetryDelayMs, delay * 2);
      }
    }
    throw new Error("Git state client is closed");
  }

  function scheduleReconnect(error) {
    lastConnectionError = error;
    if (closed || !subscriptions.size || reconnectTimer) return;
    reconnectTimer = setTimer(() => {
      reconnectTimer = undefined;
      ensureConnection().catch((nextError) => scheduleReconnect(nextError));
    }, maxRetryDelayMs);
    reconnectTimer.unref?.();
  }

  function ensureConnection() {
    if (closed) return Promise.reject(new Error("Git state client is closed"));
    if (socket && !socket.destroyed && connectionEpoch) return Promise.resolve(socket);
    if (!connecting) connecting = establishConnection()
      .catch((error) => {
        scheduleReconnect(error);
        throw error;
      })
      .finally(() => { connecting = undefined; });
    return connecting;
  }

  function createRecord(kind, value, listener, onError) {
    if (closed) throw new Error("Git state client is closed");
    if (typeof listener !== "function") throw new TypeError(`${kind} subscription requires a listener`);
    if ([...subscriptions.values()].some((record) => record.kind === kind && !record.closed)) {
      throw Object.assign(new Error(`Only one ${kind} subscription is allowed per coordinator connection`), {
        code: "GIT_STATE_SUBSCRIPTION_LIMIT",
      });
    }
    const id = nextId(kind);
    const initial = deferred();
    const record = {
      id,
      kind,
      listener,
      onError,
      initial,
      initialSettled: false,
      latest: null,
      closed: false,
      subscribedEpoch: 0,
      requestedEpoch: 0,
      refreshWaiters: new Set(),
      localGeneration: 0,
      serverEpoch: 0,
      serverGeneration: 0,
      ...(kind === "repository" ? { context: Object.freeze({ ...value }) } : { selector: Object.freeze({ ...value }) }),
    };
    subscriptions.set(id, record);
    subscribeRecord(record).catch((error) => rejectInitial(record, error));
    return record;
  }

  function subscriptionHandle(record) {
    return {
      ready: record.initial.promise,
      latest: () => record.latest,
      async refresh(reason = "manual") {
        if (record.closed) throw new Error("Git state subscription is closed");
        const value = await request({
          type: record.kind === "repository" ? "repository_refresh" : "host_refresh",
          subscriptionId: record.id,
          reason,
        });
        if (record.kind === "host") {
          if (value?.context) publishHost(record, value.context);
          return record.latest;
        }
        if (record.latest && record.serverEpoch === connectionEpoch && record.serverGeneration >= value.stateGeneration) {
          return record.latest;
        }
        const waiter = deferred();
        const item = { epoch: connectionEpoch, generation: value.stateGeneration, ...waiter };
        record.refreshWaiters.add(item);
        return item.promise;
      },
      async close() {
        if (record.closed) return;
        record.closed = true;
        subscriptions.delete(record.id);
        const error = new Error("Git state subscription is closed");
        rejectInitial(record, error);
        for (const waiter of record.refreshWaiters) waiter.reject(error);
        record.refreshWaiters.clear();
        if (socket && !socket.destroyed && (record.subscribedEpoch === connectionEpoch || record.requestedEpoch === connectionEpoch)) {
          try {
            await request({
              type: record.kind === "repository" ? "repository_unsubscribe" : "host_unsubscribe",
              subscriptionId: record.id,
            });
          } catch {}
        }
      },
    };
  }

  function openRepositorySubscription({ context, onDelivery, onError }) {
    if (!context || typeof context.cwd !== "string" || !context.cwd) {
      throw new TypeError("repository subscription requires context.cwd");
    }
    if (onError !== undefined && typeof onError !== "function") throw new TypeError("onError must be a function");
    const record = createRecord("repository", context, onDelivery, onError);
    return subscriptionHandle(record);
  }

  function subscribeHost(selector, listener) {
    if (!selector || typeof selector.railPaneId !== "string" || !selector.railPaneId) {
      throw new TypeError("host subscription requires railPaneId");
    }
    const record = createRecord("host", selector, listener);
    return subscriptionHandle(record);
  }

  async function close() {
    if (closed) return;
    await Promise.allSettled([...subscriptions.values()].map((record) => subscriptionHandle(record).close()));
    closed = true;
    subscriptions.clear();
    failPending(new Error("Git state client is closed"));
    clearBlockedTimer();
    clearTimer(reconnectTimer);
    reconnectTimer = undefined;
    outboundQueue.length = 0;
    outboundBytes = 0;
    socket?.destroy();
    socket = undefined;
    await connecting?.catch(() => {});
  }

  return {
    openRepositorySubscription,
    subscribeHost,
    close,
    get status() {
      return {
        closed,
        connected: Boolean(socket && !socket.destroyed && connectionEpoch),
        connectionEpoch,
        subscriptions: subscriptions.size,
        pendingRequests: pendingRequests.size,
        blocked,
        lastConnectionError: lastConnectionError ? remoteError(lastConnectionError) : null,
      };
    },
  };
}
