import { randomUUID } from "node:crypto";

export function openEngineSubscription({ engine, onDelivery, closeEngine = false }) {
  if (!engine || typeof engine.subscribe !== "function") throw new TypeError("in-process subscription requires an engine");
  const unsubscribe = engine.subscribe(onDelivery);
  let closed = false;
  return {
    ready: engine.ready,
    latest: engine.latest,
    refresh: (reason) => engine.refresh(reason),
    async close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (closeEngine) await engine.close();
    },
  };
}

export function createRepositoryClient({ openSubscription, createToken = randomUUID } = {}) {
  if (typeof openSubscription !== "function") throw new TypeError("repository client requires openSubscription");
  if (typeof createToken !== "function") throw new TypeError("repository client requires createToken");
  const handles = new Set();
  const issuedTokens = new Set();
  let closed = false;

  function subscribe(context, listener) {
    if (closed) throw new Error("Repository client is closed");
    if (!context || typeof context !== "object") throw new TypeError("repository subscription requires context");
    if (typeof listener !== "function") throw new TypeError("repository subscription requires a listener");
    const immutableContext = Object.freeze({ ...context });
    const contextToken = String(createToken());
    if (!contextToken) throw new Error("Repository subscription token must not be empty");
    if (issuedTokens.has(contextToken)) throw new Error("Repository subscription token must be unique");
    issuedTokens.add(contextToken);
    let handleClosed = false;
    let latestDelivery = null;

    const wrap = (value) => value && typeof value === "object"
      ? Object.freeze({ ...value, contextToken })
      : value;
    const receive = (value) => {
      if (closed || handleClosed) return;
      const wrapped = wrap(value);
      if (!wrapped) return;
      latestDelivery = wrapped;
      queueMicrotask(() => {
        if (!closed && !handleClosed) {
          try { listener(wrapped); } catch {}
        }
      });
    };
    const connection = openSubscription({
      context: immutableContext,
      onDelivery: receive,
    });
    if (!connection || typeof connection !== "object") {
      throw new TypeError("openSubscription must return a connection");
    }
    for (const method of ["latest", "refresh", "close"]) {
      if (typeof connection[method] !== "function") throw new TypeError(`subscription connection requires ${method}()`);
    }

    const ready = Promise.resolve(connection.ready).then((value) => {
      if (closed || handleClosed) throw new Error("Repository subscription closed before ready");
      const wrapped = wrap(value);
      if (wrapped && (!latestDelivery || (wrapped.stateGeneration ?? -1) > (latestDelivery.stateGeneration ?? -1))) {
        latestDelivery = wrapped;
        queueMicrotask(() => {
          if (!closed && !handleClosed) {
            try { listener(wrapped); } catch {}
          }
        });
      }
      return latestDelivery || wrapped;
    });
    ready.catch(() => {});

    const handle = {
      context: immutableContext,
      contextToken,
      ready,
      latest() {
        if (handleClosed) return latestDelivery;
        if (latestDelivery) return latestDelivery;
        const value = connection.latest();
        if (value) latestDelivery = wrap(value);
        return latestDelivery;
      },
      async refresh(reason = "manual") {
        if (closed || handleClosed) throw new Error("Repository subscription is closed");
        const value = await connection.refresh(reason);
        if (closed || handleClosed) throw new Error("Repository subscription closed during refresh");
        const wrapped = wrap(value);
        if (wrapped) latestDelivery = wrapped;
        return wrapped;
      },
      async close() {
        if (handleClosed) return;
        handleClosed = true;
        handles.delete(handle);
        await connection.close();
      },
    };
    handles.add(handle);
    return handle;
  }

  async function close() {
    if (closed) return;
    closed = true;
    await Promise.allSettled([...handles].map((handle) => handle.close()));
    handles.clear();
  }

  return { subscribe, close };
}
