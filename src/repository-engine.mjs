import { createHash } from "node:crypto";
import { getRepositoryState } from "./git-provider.mjs";
import { createRefreshScheduler } from "./refresh-scheduler.mjs";
import { debugLog } from "./debug-log.mjs";

function safeError(error) {
  if (!error) return null;
  return {
    name: String(error.name || "Error"),
    message: String(error.message || error),
    ...(error.code ? { code: String(error.code) } : {}),
  };
}

function defaultReadState({ context, signal }) {
  return getRepositoryState(context.cwd, {
    env: context.environment || process.env,
    gitExecutable: context.gitExecutable,
    signal,
  });
}

function safeReason(value) {
  const text = String(value || "unspecified");
  return text.length <= 64 && !/[\\/\0]/.test(text) ? text : "event";
}

function numericMetrics(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, count]) => Number.isFinite(count)));
}

export function createRepositoryEngine({
  context,
  readState = defaultReadState,
  watchFactory,
  schedulerFactory = createRefreshScheduler,
  schedulerOptions = {},
  now = Date.now,
} = {}) {
  if (!context || typeof context !== "object") throw new TypeError("repository engine requires a context");
  if (typeof context.cwd !== "string" || !context.cwd) throw new TypeError("repository context requires cwd");
  if (typeof readState !== "function") throw new TypeError("repository engine requires a readState function");
  const immutableContext = Object.freeze({ ...context });
  const engineKey = String(context.engineKey || context.cwd);
  const engineId = createHash("sha256").update(engineKey).digest("hex").slice(0, 12);
  const listeners = new Set();
  let closed = false;
  let watcher;
  let watcherStarting;
  let snapshot;
  let latestDelivery;
  let stateGeneration = 0;
  let preReadCoverage = false;
  let observedDirtyPromise;
  let lastError = null;
  let readySettled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Consumers may choose latest()/subscribe() without awaiting ready.
  ready.catch(() => {});

  const notify = (delivery) => {
    latestDelivery = delivery;
    for (const listener of listeners) queueMicrotask(() => {
      if (!closed && listeners.has(listener)) {
        try { listener(delivery); } catch {}
      }
    });
  };

  let scheduler;
  const deliveryStatus = () => {
    if (closed) return "closed";
    if (scheduler?.status.providerFailed || lastError) return "error";
    if (!scheduler?.status.watchHealthy) return "degraded";
    return snapshot ? "healthy" : "starting";
  };
  const delivery = () => ({
    engineKey,
    stateGeneration,
    inputGeneration: scheduler?.status.inputGeneration || 0,
    status: deliveryStatus(),
    ...(snapshot ? { snapshot } : {}),
    ...(lastError ? { error: safeError(lastError) } : {}),
    refreshedAt: snapshot ? latestDelivery?.refreshedAt || now() : null,
    reconciliationDueAt: scheduler?.status.reconciliationDueAt ?? null,
  });
  const publishStatus = () => {
    if (!latestDelivery || closed) return;
    const next = delivery();
    if (
      next.status !== latestDelivery.status
      || next.reconciliationDueAt !== latestDelivery.reconciliationDueAt
      || next.inputGeneration !== latestDelivery.inputGeneration
      || next.error?.message !== latestDelivery.error?.message
    ) notify(next);
  };

  const setWatchHealth = (health) => scheduler?.setWatchHealth(health);
  const onInvalidation = (event = {}) => {
    const reason = safeReason(event.reason || event.path || "watch");
    debugLog("refresh-trigger", { source: "watch", engineId, reason, covered: preReadCoverage });
    // Reconciliation runs before the provider, so invalidations it discovers
    // are covered by the read that is about to start.
    if (closed || preReadCoverage) return;
    const promise = scheduler.request({ kind: "dirty", reason });
    // Coalesced requests share a promise. Attaching once per batch also bounds
    // pending rejection reactions during a large filesystem-event burst.
    if (promise !== observedDirtyPromise) {
      observedDirtyPromise = promise;
      promise.catch(() => {});
    }
  };

  const ensureWatcher = async (nextSnapshot) => {
    if (closed || !watchFactory) return;
    if (watcher) {
      try { await watcher.updateSnapshot?.(nextSnapshot); }
      catch (error) { setWatchHealth({ healthy: false, error }); }
      return;
    }
    if (!watcherStarting) {
      let healthReported = false;
      watcherStarting = Promise.resolve().then(() => watchFactory({
        context: immutableContext,
        snapshot: nextSnapshot,
        onInvalidation,
        onHealth: (health) => {
          healthReported = true;
          setWatchHealth(health);
        },
      })).then(async (created) => {
        if (closed) {
          await created?.close?.();
          return;
        }
        watcher = created || null;
        if (!healthReported) setWatchHealth({ healthy: Boolean(watcher) });
      }, (error) => {
        setWatchHealth({ healthy: false, error });
      }).finally(() => { watcherStarting = undefined; });
    }
    await watcherStarting;
  };

  const run = async ({ inputGeneration, kinds, reasons, signal }) => {
    if (closed) throw new Error("Repository engine is closed");
    for (const kind of kinds) debugLog("refresh-trigger", { source: kind, engineId, inputGeneration });
    if (snapshot && kinds.some((kind) => kind === "reconcile" || kind === "fallback")) {
      preReadCoverage = true;
      try { await watcher?.reconcile?.(snapshot); }
      catch (error) { setWatchHealth({ healthy: false, error }); }
      finally { preReadCoverage = false; }
    }
    const providerStartedAt = now();
    debugLog("repository-provider", {
      phase: "start",
      engineId,
      kinds,
      reasons: reasons.map(safeReason),
      inputGeneration,
    });
    let providerFinished = false;
    try {
      const nextSnapshot = await readState({ context: immutableContext, signal });
      providerFinished = true;
      debugLog("repository-provider", {
        phase: "finish",
        outcome: "ok",
        engineId,
        kinds,
        reasons: reasons.map(safeReason),
        inputGeneration,
        durationMs: Math.max(0, now() - providerStartedAt),
      });
      if (closed || signal.aborted) throw signal.reason || new Error("Repository refresh was cancelled");
      scheduler.updateConfig?.({
        fallbackIntervalMs: nextSnapshot?.config?.refresh?.pollIntervalMs,
        reconcileIntervalMs: nextSnapshot?.config?.refresh?.reconcileIntervalMs,
      });
      await ensureWatcher(nextSnapshot);
      if (closed || signal.aborted) throw signal.reason || new Error("Repository refresh was cancelled");
      snapshot = nextSnapshot;
      stateGeneration += 1;
      lastError = null;
      const next = {
        engineKey,
        stateGeneration,
        inputGeneration,
        status: deliveryStatus(),
        snapshot,
        refreshedAt: now(),
        reconciliationDueAt: scheduler.status.reconciliationDueAt,
      };
      notify(next);
      return next;
    } catch (error) {
      if (!providerFinished) {
        debugLog("repository-provider", {
          phase: "finish",
          outcome: signal.aborted ? "aborted" : "error",
          engineId,
          kinds,
          reasons: reasons.map(safeReason),
          inputGeneration,
          durationMs: Math.max(0, now() - providerStartedAt),
          errorKind: safeReason(error?.code || error?.name || "error"),
        });
      }
      if (!closed) {
        lastError = error;
        notify(delivery());
      }
      throw error;
    }
  };

  scheduler = schedulerFactory({
    fallbackIntervalMs: immutableContext.schedulerConfig?.pollIntervalMs,
    reconcileIntervalMs: immutableContext.schedulerConfig?.reconcileIntervalMs,
    ...schedulerOptions,
    watchHealthy: Boolean(watchFactory),
    now,
    run,
    onStatus: () => queueMicrotask(publishStatus),
  });

  const startup = scheduler.request({ kind: "manual", reason: "startup" });
  startup.then((initial) => {
    if (!readySettled) {
      readySettled = true;
      resolveReady(initial);
    }
  }, (error) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
  });

  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("repository subscription requires a listener");
    if (closed) throw new Error("Repository engine is closed");
    listeners.add(listener);
    if (latestDelivery) queueMicrotask(() => {
      if (!closed && listeners.has(listener)) {
        try { listener(latestDelivery); } catch {}
      }
    });
    return () => { listeners.delete(listener); };
  }

  function refresh(reason = "manual") {
    return scheduler.request({ kind: "manual", reason });
  }

  function invalidate(reason = "watch") {
    return scheduler.request({ kind: "dirty", reason });
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error("Repository engine closed before its initial snapshot"));
    }
    await scheduler.close();
    observedDirtyPromise = undefined;
    await watcherStarting;
    debugLog("repository-watcher", {
      phase: "finish",
      engineId,
      metrics: numericMetrics(watcher?.metrics),
      classifierMetrics: numericMetrics(watcher?.classifierMetrics),
    });
    try { await watcher?.close?.(); } catch {}
    watcher = undefined;
    latestDelivery = {
      ...delivery(),
      status: "closed",
      reconciliationDueAt: null,
    };
    listeners.clear();
  }

  return {
    context: immutableContext,
    ready,
    subscribe,
    latest: () => latestDelivery || null,
    refresh,
    invalidate,
    setWatchHealth,
    close,
  };
}
