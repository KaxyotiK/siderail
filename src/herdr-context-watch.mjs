import { selectHerdrSnapshotContext, sameHerdrSnapshotContext } from "./herdr-context.mjs";
import { requestHerdr } from "./herdr-socket.mjs";

export async function readHerdrSessionSnapshot({
  socketPath = process.env.HERDR_SOCKET_PATH || "",
  timeoutMs = 5_000,
  request = requestHerdr,
} = {}) {
  if (!socketPath) {
    const error = new Error("HERDR_SOCKET_PATH is unavailable");
    error.code = "HERDR_SOCKET_UNAVAILABLE";
    throw error;
  }
  const result = await request(socketPath, "session.snapshot", {}, { timeoutMs });
  if (result?.type !== "session_snapshot" || !result.snapshot) {
    const error = new Error(`unexpected session.snapshot response: ${result?.type || "missing"}`);
    error.code = "HERDR_PROTOCOL_ERROR";
    throw error;
  }
  return result.snapshot;
}

export function createHerdrContextSource({
  environment = process.env,
  socketPath = environment.HERDR_SOCKET_PATH || "",
  intervalMs = 10_000,
  fallbackIntervalMs = intervalMs,
  timeoutMs = 5_000,
  readSnapshot = () => readHerdrSessionSnapshot({ socketPath, timeoutMs }),
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = (timer) => clearTimeout(timer),
  now = () => Date.now(),
  onStatus = () => {},
} = {}) {
  if (!Number.isFinite(fallbackIntervalMs) || fallbackIntervalMs <= 0) {
    throw new TypeError("fallbackIntervalMs must be positive");
  }
  const subscribers = new Map();
  const counts = {
    snapshotRequests: 0,
    semanticChanges: 0,
    semanticUnchanged: 0,
    failures: 0,
    listenerFailures: 0,
  };
  let nextSubscriberId = 1;
  let latestSnapshot = null;
  let timer = null;
  let inFlight = null;
  let queuedReason = "";
  let queuedWaiters = [];
  let closed = false;
  let lastDurationMs = null;
  let lastSuccessAt = null;

  function clearTimer() {
    if (timer !== null) cancel(timer);
    timer = null;
  }

  function scheduleFallback() {
    clearTimer();
    if (closed || subscribers.size === 0) return;
    timer = schedule(() => {
      timer = null;
      reconcile("fallback");
    }, fallbackIntervalMs);
    timer?.unref?.();
  }

  function derive(subscriber, snapshot) {
    const context = selectHerdrSnapshotContext(snapshot, {
      railPaneId: subscriber.railPaneId,
      railTerminalId: subscriber.railTerminalId,
      sourcePaneId: subscriber.context?.sourcePaneId || subscriber.sourcePaneId,
      fallbackCwd: subscriber.context?.cwd || subscriber.fallbackCwd,
    });
    if (context.railTerminalId) subscriber.railTerminalId = context.railTerminalId;
    if (context.railPaneId) subscriber.railPaneId = context.railPaneId;
    return context;
  }

  function publish(subscriber, snapshot, reason) {
    const context = derive(subscriber, snapshot);
    if (sameHerdrSnapshotContext(subscriber.context, context)) {
      counts.semanticUnchanged += 1;
      return false;
    }
    subscriber.context = context;
    counts.semanticChanges += 1;
    try {
      subscriber.listener(context, { reason, snapshot });
    } catch (error) {
      counts.listenerFailures += 1;
      onStatus({ status: "listener-error", reason, error });
    }
    return true;
  }

  async function runReconcile(reason) {
    clearTimer();
    const startedAt = now();
    counts.snapshotRequests += 1;
    try {
      const snapshot = await readSnapshot();
      if (closed) return { ok: false, closed: true };
      latestSnapshot = snapshot;
      lastSuccessAt = now();
      lastDurationMs = Math.max(0, lastSuccessAt - startedAt);
      for (const subscriber of subscribers.values()) publish(subscriber, snapshot, reason);
      onStatus({ status: "healthy", reason, lastDurationMs });
      return { ok: true, snapshot };
    } catch (error) {
      lastDurationMs = Math.max(0, now() - startedAt);
      counts.failures += 1;
      onStatus({ status: "degraded", reason, error, lastDurationMs });
      return { ok: false, error };
    } finally {
      inFlight = null;
      if (!closed && subscribers.size > 0 && queuedReason) {
        const queued = queuedReason;
        const waiters = queuedWaiters;
        queuedReason = "";
        queuedWaiters = [];
        reconcile(queued).then((result) => {
          for (const resolve of waiters) resolve(result);
        });
      } else {
        if (queuedWaiters.length) {
          for (const resolve of queuedWaiters) resolve({
            ok: false,
            closed,
            inactive: subscribers.size === 0,
          });
          queuedWaiters = [];
        }
        queuedReason = "";
        scheduleFallback();
      }
    }
  }

  function reconcile(reason = "manual", { queueIfBusy = true } = {}) {
    if (closed) return Promise.resolve({ ok: false, closed: true });
    if (inFlight) {
      if (!queueIfBusy) return inFlight;
      queuedReason ||= reason;
      return new Promise((resolve) => queuedWaiters.push(resolve));
    }
    inFlight = runReconcile(reason);
    return inFlight;
  }

  function subscribe({
    railPaneId,
    railTerminalId = "",
    sourcePaneId = "",
    fallbackCwd = "",
  }, listener) {
    if (closed) throw new Error("Herdr context source is closed");
    if (!railPaneId || typeof listener !== "function") {
      throw new TypeError("subscribe requires railPaneId and listener");
    }
    const id = nextSubscriberId++;
    const subscriber = {
      railPaneId, railTerminalId, sourcePaneId, fallbackCwd, listener, context: null,
    };
    subscribers.set(id, subscriber);
    let ready;
    if (latestSnapshot) {
      publish(subscriber, latestSnapshot, "subscribe");
      ready = Promise.resolve({ ok: true, snapshot: latestSnapshot });
    } else {
      ready = reconcile("initial", { queueIfBusy: false });
    }
    ready = ready.then(() => subscriber.context);
    return {
      ready,
      get context() { return subscriber.context; },
      unsubscribe() {
        subscribers.delete(id);
        if (subscribers.size === 0) clearTimer();
      },
    };
  }

  return {
    subscribe,
    requestRefresh(reason = "manual") { return reconcile(reason); },
    get latestSnapshot() { return latestSnapshot; },
    get snapshot() { return latestSnapshot; },
    metrics() {
      return {
        mode: "phase-a-snapshot-fallback",
        fallbackIntervalMs,
        subscribers: subscribers.size,
        inFlight: Boolean(inFlight),
        queued: Boolean(queuedReason),
        lastDurationMs,
        lastSuccessAt,
        ...counts,
      };
    },
    close() {
      if (closed) return;
      closed = true;
      queuedReason = "";
      for (const resolve of queuedWaiters) resolve({ ok: false, closed: true });
      queuedWaiters = [];
      clearTimer();
      subscribers.clear();
    },
  };
}
