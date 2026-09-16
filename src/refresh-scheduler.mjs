const REQUEST_KINDS = new Set(["dirty", "manual", "reconcile", "fallback"]);

export class RefreshSchedulerClosedError extends Error {
  constructor(message = "Refresh scheduler is closed") {
    super(message);
    this.name = "RefreshSchedulerClosedError";
    this.code = "ERR_REFRESH_SCHEDULER_CLOSED";
  }
}

function finiteInteger(value, fallback, minimum = 0) {
  return Number.isInteger(value) && value >= minimum ? value : fallback;
}

function jitteredRefreshInterval(interval, random = Math.random) {
  const value = Number(random());
  const bounded = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  return Math.max(1, Math.round(interval * (0.9 + bounded * 0.2)));
}

export function createRefreshScheduler({
  run,
  onStatus = () => {},
  burstDelayMs = 125,
  minimumIntervalMs = 2_000,
  reconcileIntervalMs = 300_000,
  fallbackIntervalMs = 10_000,
  watchHealthy = true,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  random = Math.random,
} = {}) {
  if (typeof run !== "function") throw new TypeError("refresh scheduler requires a run function");
  burstDelayMs = finiteInteger(burstDelayMs, 125);
  minimumIntervalMs = finiteInteger(minimumIntervalMs, 2_000);
  reconcileIntervalMs = finiteInteger(reconcileIntervalMs, 300_000, 1);
  fallbackIntervalMs = finiteInteger(fallbackIntervalMs, 10_000, 1);

  let closed = false;
  let running = false;
  let providerFailed = false;
  let inputGeneration = 0;
  let requestSequence = 0;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let lastSucceededAt = null;
  let startTimer;
  let reconciliationTimer;
  let fallbackTimer;
  let reconciliationDueAt = null;
  let fallbackDueAt = null;
  let activeController;
  let activeRequests = [];
  let runningPromise;
  const pending = [];

  const timer = (callback, delay) => {
    const handle = setTimer(callback, Math.max(0, delay));
    handle?.unref?.();
    return handle;
  };
  const clear = (handle) => {
    if (handle !== undefined) clearTimer(handle);
  };
  const settle = (request, method, value) => {
    if (request.settled) return;
    request.settled = true;
    request[method](value);
  };
  const snapshotStatus = () => ({
    closed,
    running,
    watchHealthy,
    providerFailed,
    inputGeneration,
    lastStartedAt: Number.isFinite(lastStartedAt) ? lastStartedAt : null,
    lastSucceededAt,
    reconciliationDueAt,
    fallbackDueAt,
    pending: pending.length,
  });
  const emitStatus = () => {
    try { onStatus(snapshotStatus()); } catch {}
  };

  const clearReconciliation = () => {
    clear(reconciliationTimer);
    reconciliationTimer = undefined;
    reconciliationDueAt = null;
  };
  const clearFallback = () => {
    clear(fallbackTimer);
    fallbackTimer = undefined;
    fallbackDueAt = null;
  };

  let schedulePending;

  const scheduleReconciliation = () => {
    clearReconciliation();
    if (closed || !watchHealthy || providerFailed || lastSucceededAt === null) return;
    const delay = jitteredRefreshInterval(reconcileIntervalMs, random);
    reconciliationDueAt = lastSucceededAt + delay;
    reconciliationTimer = timer(() => {
      reconciliationTimer = undefined;
      reconciliationDueAt = null;
      request({ kind: "reconcile", reason: "healthy-reconciliation" }).catch(() => {});
    }, reconciliationDueAt - now());
  };

  const scheduleFallback = () => {
    clearFallback();
    if (closed || (watchHealthy && !providerFailed)) return;
    const delay = jitteredRefreshInterval(fallbackIntervalMs, random);
    fallbackDueAt = now() + delay;
    fallbackTimer = timer(() => {
      fallbackTimer = undefined;
      fallbackDueAt = null;
      request({ kind: "fallback", reason: providerFailed ? "provider-retry" : "watch-degraded" }).catch(() => {});
    }, delay);
  };

  const startRun = () => {
    if (closed || running || !pending.length) return;
    clear(startTimer);
    startTimer = undefined;
    const captured = pending.splice(0);
    const capturedInputGeneration = inputGeneration;
    const startedAt = now();
    const reasons = [...new Set(captured.map(({ kind, reason }) => reason || kind))];
    lastStartedAt = startedAt;
    running = true;
    activeRequests = captured;
    activeController = new globalThis.AbortController();
    emitStatus();

    runningPromise = Promise.resolve().then(() => run({
      inputGeneration: capturedInputGeneration,
      reasons,
      kinds: [...new Set(captured.map(({ kind }) => kind))],
      signal: activeController.signal,
      startedAt,
    })).then((result) => {
      if (closed) throw new RefreshSchedulerClosedError();
      providerFailed = false;
      lastSucceededAt = now();
      for (const item of captured) settle(item, "resolve", result);
      if (watchHealthy) {
        clearFallback();
        scheduleReconciliation();
      }
      else scheduleFallback();
      return result;
    }, (error) => {
      providerFailed = !closed;
      for (const item of captured) settle(item, "reject", error);
      clearReconciliation();
      if (!closed) scheduleFallback();
      throw error;
    }).catch(() => undefined).finally(() => {
      running = false;
      activeRequests = [];
      activeController = undefined;
      runningPromise = undefined;
      emitStatus();
      schedulePending();
    });
  };

  schedulePending = () => {
    clear(startTimer);
    startTimer = undefined;
    if (closed || running || !pending.length) return;
    const urgent = pending.some(({ kind }) => kind !== "dirty");
    const firstRequestedAt = Math.min(...pending.map(({ requestedAt }) => requestedAt));
    const deadline = urgent
      ? now()
      : Math.max(firstRequestedAt + burstDelayMs, lastStartedAt + minimumIntervalMs);
    if (deadline <= now()) startRun();
    else startTimer = timer(startRun, deadline - now());
    emitStatus();
  };

  function request({ kind = "dirty", reason = "", dirtyGeneration } = {}) {
    if (!REQUEST_KINDS.has(kind)) return Promise.reject(new TypeError(`unknown refresh request kind: ${kind}`));
    if (closed) return Promise.reject(new RefreshSchedulerClosedError());
    if (kind === "dirty") {
      if (dirtyGeneration !== undefined) {
        if (!Number.isInteger(dirtyGeneration) || dirtyGeneration < 1) {
          return Promise.reject(new TypeError("dirtyGeneration must be a positive integer"));
        }
        inputGeneration = Math.max(inputGeneration, dirtyGeneration);
      } else inputGeneration += 1;
    }
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    pending.push({
      sequence: ++requestSequence,
      kind,
      reason,
      requestedAt: now(),
      inputGeneration,
      resolve,
      reject,
      settled: false,
    });
    schedulePending();
    return promise;
  }

  function setWatchHealth({ healthy, error } = {}) {
    if (closed) return;
    const nextHealthy = Boolean(healthy);
    if (watchHealthy === nextHealthy && !error) return;
    watchHealthy = nextHealthy;
    if (watchHealthy && !providerFailed) {
      clearFallback();
      scheduleReconciliation();
    } else {
      clearReconciliation();
      scheduleFallback();
    }
    emitStatus();
  }

  function updateConfig({ reconcileIntervalMs: nextReconcile, fallbackIntervalMs: nextFallback } = {}) {
    if (closed) return;
    let changed = false;
    if (nextReconcile !== undefined) {
      const valid = finiteInteger(nextReconcile, -1, 1);
      if (valid < 1) throw new TypeError("reconcileIntervalMs must be a positive integer");
      if (valid !== reconcileIntervalMs) {
        reconcileIntervalMs = valid;
        changed = true;
      }
    }
    if (nextFallback !== undefined) {
      const valid = finiteInteger(nextFallback, -1, 1);
      if (valid < 1) throw new TypeError("fallbackIntervalMs must be a positive integer");
      if (valid !== fallbackIntervalMs) {
        fallbackIntervalMs = valid;
        changed = true;
      }
    }
    if (!changed) return;
    if (watchHealthy && !providerFailed) scheduleReconciliation();
    else scheduleFallback();
    emitStatus();
  }

  async function close() {
    if (closed) return;
    closed = true;
    clear(startTimer);
    clearReconciliation();
    clearFallback();
    startTimer = undefined;
    const error = new RefreshSchedulerClosedError();
    for (const item of pending.splice(0)) settle(item, "reject", error);
    for (const item of activeRequests) settle(item, "reject", error);
    activeController?.abort(error);
    const active = runningPromise;
    emitStatus();
    await active;
  }

  return {
    request,
    setWatchHealth,
    updateConfig,
    get status() { return snapshotStatus(); },
    close,
  };
}
