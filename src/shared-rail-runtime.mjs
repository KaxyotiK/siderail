import { loadConfig } from "./config.mjs";
import { createGitStateClient, createGitStateCoordinatorLauncher } from "./git-state-client.mjs";
import {
  collectEffectiveRuntimeSemantics,
  digestEffectiveGitEnvironment,
  digestEffectiveRuntimeSemantics,
} from "./git-state-identity.mjs";
import { resolveGitStateRuntime } from "./git-state-runtime.mjs";
import { createRepositoryWatcher } from "./git-invalidation.mjs";
import { openEngineSubscription } from "./repository-client.mjs";
import { createRepositoryEngine } from "./repository-engine.mjs";

const WATCH_MODES = new Set(["watch-and-poll", "watch-only", "poll-only"]);
const IDENTITY_FALLBACK_CODES = new Set([
  "GIT_STATE_IDENTITY_UNSUPPORTED",
  "UNSUPPORTED_ENVIRONMENT",
  "GIT_EXECUTABLE_UNAVAILABLE",
  "UNSUPPORTED_EXECUTABLE",
  "PATH_UNAVAILABLE",
  "AMBIGUOUS_REPOSITORY",
]);
const OVERSIZE_FALLBACK_CODES = new Set([
  "FRAME_TOO_LARGE",
  "SNAPSHOT_TOO_LARGE",
  "GIT_STATE_SNAPSHOT_TOO_LARGE",
]);

function codedError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

export function resolveRailStateMode(environment = process.env) {
  const value = String(environment.SIDERAIL_STATE_MODE || "shared").trim();
  if (value === "shared" || value === "in-process") return value;
  throw codedError(
    "GIT_STATE_MODE_UNSUPPORTED",
    `SIDERAIL_STATE_MODE must be shared or in-process, received ${JSON.stringify(value)}`,
  );
}

export function resolveSharedRuntimeSemantics(environment = process.env, {
  loadConfiguration = loadConfig,
} = {}) {
  const { config, errors } = loadConfiguration(environment);
  const watchMode = String(environment.SIDERAIL_WATCH_MODE || "watch-and-poll").trim();
  if (!WATCH_MODES.has(watchMode)) {
    throw codedError(
      "GIT_STATE_WATCH_MODE_UNSUPPORTED",
      `SIDERAIL_WATCH_MODE must be watch-and-poll, watch-only, or poll-only, received ${JSON.stringify(watchMode)}`,
    );
  }
  const providerConfig = Object.freeze({
    baseRef: String(config.baseRef || ""),
    maxFileBytes: config.limits.maxFileBytes,
  });
  const schedulerConfig = Object.freeze({
    pollIntervalMs: config.refresh.pollIntervalMs,
    reconcileIntervalMs: config.refresh.reconcileIntervalMs,
    watchMode,
  });
  const configErrors = Object.freeze([...errors]);
  const { environmentOverrides } = collectEffectiveRuntimeSemantics(environment);
  return Object.freeze({
    config,
    configErrors,
    providerConfig,
    schedulerConfig,
    environmentOverrides,
    effectiveConfigId: digestEffectiveRuntimeSemantics({ environmentOverrides }),
  });
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
}

export function localizeRepositoryDelivery(delivery, {
  cwd,
  environment = process.env,
  loadConfiguration = loadConfig,
} = {}) {
  if (!delivery?.snapshot) return delivery;
  const { config, errors: configErrors } = loadConfiguration(environment);
  const remote = delivery.snapshot;
  const combinedErrors = uniqueStrings([...(remote.configErrors || []), ...configErrors]);
  const snapshot = {
    ...remote,
    cwd,
    config,
    configErrors: combinedErrors,
    error: remote.error || combinedErrors[0] || "",
  };
  return Object.freeze({ ...delivery, snapshot });
}

export function classifySharedRuntimeFallback(error) {
  const code = String(error?.code || "");
  if (IDENTITY_FALLBACK_CODES.has(code)) return "identity-unsupported";
  if (OVERSIZE_FALLBACK_CODES.has(code)) return "snapshot-oversize";
  return "";
}

function defaultInProcessSubscription({ context, onDelivery, environment, loadConfiguration, gitExecutable }) {
  const localEnvironment = context.environment || environment;
  const semantics = resolveSharedRuntimeSemantics(localEnvironment, { loadConfiguration });
  const engineContext = Object.freeze({
    ...context,
    environment: Object.freeze({ ...localEnvironment }),
    gitExecutable,
    providerConfig: semantics.providerConfig,
    schedulerConfig: semantics.schedulerConfig,
  });
  const engine = createRepositoryEngine({
    context: engineContext,
    watchFactory: createRepositoryWatcher,
    schedulerOptions: {
      fallbackIntervalMs: semantics.schedulerConfig.pollIntervalMs,
      reconcileIntervalMs: semantics.schedulerConfig.reconcileIntervalMs,
    },
  });
  return openEngineSubscription({ engine, onDelivery, closeEngine: true });
}

function adaptiveRepositorySubscription({
  context,
  listener,
  openShared,
  openFallback,
  localize,
  onFallback,
  onClose,
  closeTimeoutMs = 1_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let active;
  let latest = null;
  let closed = false;
  let transport = "starting";
  let fallbackReason = "";
  let epoch = 0;
  let transition;
  let publishedEpoch;
  let publishedGeneration;
  let localGeneration = 0;
  const isCurrent = (delivery, deliveryEpoch = epoch) => latest
    && publishedEpoch === deliveryEpoch && publishedGeneration === delivery?.stateGeneration;

  const closeBounded = async (handle) => {
    if (!handle?.close) return;
    const closing = Promise.resolve().then(() => handle.close()).catch(() => {});
    let timer;
    await Promise.race([
      closing,
      new Promise((resolve) => { timer = setTimer(resolve, closeTimeoutMs); }),
    ]);
    clearTimer(timer);
  };

  const publish = (delivery, deliveryEpoch = epoch) => {
    if (closed || deliveryEpoch !== epoch || !delivery) return delivery;
    if (!isCurrent(delivery, deliveryEpoch)) {
      localGeneration += 1;
      publishedEpoch = deliveryEpoch;
      publishedGeneration = delivery.stateGeneration;
    }
    const localized = localize({ ...delivery, stateGeneration: localGeneration });
    latest = localized;
    try { listener(localized); } catch {}
    return localized;
  };
  const startFallback = (error, reason, expectedEpoch = epoch) => {
    if (transition) return transition;
    transition = (async () => {
      if (closed || expectedEpoch !== epoch) throw codedError("GIT_STATE_SUBSCRIPTION_CLOSED", "Repository subscription is closed");
      const previous = active;
      active = undefined;
      epoch += 1;
      const fallbackEpoch = epoch;
      transport = "switching";
      closeBounded(previous).catch(() => {});
      if (closed || fallbackEpoch !== epoch) throw codedError("GIT_STATE_SUBSCRIPTION_CLOSED", "Repository subscription is closed");
      transport = "in-process";
      fallbackReason = reason;
      onFallback({
        status: "fallback",
        transport,
        reason,
        code: String(error?.code || "GIT_STATE_IDENTITY_UNSUPPORTED"),
        error,
        cwd: context.cwd,
      });
      const candidate = openFallback({
        context,
        onDelivery: (delivery) => publish(delivery, fallbackEpoch),
      });
      if (closed || fallbackEpoch !== epoch) {
        closeBounded(candidate).catch(() => {});
        throw codedError("GIT_STATE_SUBSCRIPTION_CLOSED", "Repository subscription is closed");
      }
      active = candidate;
      const initial = await candidate.ready;
      if (closed || fallbackEpoch !== epoch) throw codedError("GIT_STATE_SUBSCRIPTION_CLOSED", "Repository subscription is closed");
      if (isCurrent(initial, fallbackEpoch)) return latest;
      return publish(initial, fallbackEpoch);
    })().finally(() => { transition = undefined; });
    transition.catch(() => {});
    return transition;
  };
  const sharedEpoch = ++epoch;
  const start = async () => {
    if (closed || sharedEpoch !== epoch) throw codedError("GIT_STATE_SUBSCRIPTION_CLOSED", "Repository subscription is closed");
    transport = "shared";
    const candidate = openShared({
      context,
      onDelivery: (delivery) => publish(delivery, sharedEpoch),
      onError: (error) => {
        const reason = classifySharedRuntimeFallback(error);
        if (reason) startFallback(error, reason, sharedEpoch).catch(() => {});
      },
    });
    if (closed || sharedEpoch !== epoch) {
      closeBounded(candidate).catch(() => {});
      throw codedError("GIT_STATE_SUBSCRIPTION_CLOSED", "Repository subscription is closed");
    }
    active = candidate;
    try {
      const initial = await candidate.ready;
      if (closed || sharedEpoch !== epoch) throw codedError("GIT_STATE_SUBSCRIPTION_CLOSED", "Repository subscription is closed");
      if (isCurrent(initial, sharedEpoch)) return latest;
      return publish(initial, sharedEpoch);
    } catch (error) {
      const reason = classifySharedRuntimeFallback(error);
      if (reason) return startFallback(error, reason, sharedEpoch);
      throw error;
    }
  };
  const ready = start();
  ready.catch(() => {});

  return {
    ready,
    latest: () => latest,
    get transport() { return transport; },
    get fallbackReason() { return fallbackReason; },
    async refresh(reason = "manual") {
      await ready;
      await transition;
      if (closed) throw codedError("GIT_STATE_SUBSCRIPTION_CLOSED", "Repository subscription is closed");
      const refreshEpoch = epoch;
      try {
        const delivery = await active.refresh(reason);
        if (isCurrent(delivery, refreshEpoch)) return latest;
        return publish(delivery, refreshEpoch);
      }
      catch (error) {
        const selected = classifySharedRuntimeFallback(error);
        if (!selected || transport === "in-process") throw error;
        await startFallback(error, selected, refreshEpoch);
        const delivery = await active.refresh(reason);
        if (isCurrent(delivery)) return latest;
        return publish(delivery, epoch);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      epoch += 1;
      const previous = active;
      active = undefined;
      await closeBounded(previous);
      onClose();
    },
  };
}

export async function createSharedRailRuntime({
  environment = process.env,
  resolveRuntime = resolveGitStateRuntime,
  launcherFactory = createGitStateCoordinatorLauncher,
  clientFactory = createGitStateClient,
  loadConfiguration = loadConfig,
  openInProcessSubscription,
  onStatus = () => {},
  subscriptionCloseTimeoutMs = 1_000,
} = {}) {
  const mode = resolveRailStateMode(environment);
  if (mode === "in-process") {
    throw codedError("GIT_STATE_IN_PROCESS_REQUESTED", "Shared Git state is disabled by SIDERAIL_STATE_MODE=in-process");
  }
  const semantics = resolveSharedRuntimeSemantics(environment, { loadConfiguration });
  const runtime = await resolveRuntime({ environment });
  if (!runtime?.identity?.namespaceId || !runtime?.paths?.socketPath || !runtime?.paths?.leasePath) {
    throw new TypeError("resolveRuntime returned an incomplete shared runtime identity");
  }
  if (runtime.identity.effectiveConfigId !== semantics.effectiveConfigId) {
    throw codedError("GIT_STATE_RUNTIME_SEMANTICS_MISMATCH", "Shared runtime resolved different provider or scheduler semantics");
  }
  const launcher = launcherFactory({
    namespaceId: runtime.identity.namespaceId,
    socketPath: runtime.paths.socketPath,
    leasePath: runtime.paths.leasePath,
    environment,
  });
  const client = clientFactory({
    namespaceId: runtime.identity.namespaceId,
    socketPath: runtime.paths.socketPath,
    launchCoordinator: launcher.launch,
  });
  const handles = new Set();
  let closed = false;
  let fallbackSubscriptions = 0;
  const fallbackFactory = openInProcessSubscription || ((options) => defaultInProcessSubscription({
    ...options,
    environment,
    loadConfiguration,
    gitExecutable: runtime.gitExecutableIdentity.realpath,
  }));

  function localContext(context) {
    const localEnvironment = context.environment || environment;
    const localSemantics = resolveSharedRuntimeSemantics(localEnvironment, { loadConfiguration });
    if (digestEffectiveGitEnvironment(localEnvironment) !== runtime.identity.providerEnvironmentId
      || localSemantics.effectiveConfigId !== runtime.identity.effectiveConfigId) {
      throw codedError(
        "GIT_STATE_CONTEXT_INCOMPATIBLE",
        "Repository context does not match this shared runtime namespace",
      );
    }
    return { localEnvironment, localSemantics };
  }

  function openRepositorySubscription({ context, onDelivery }) {
    if (closed) throw codedError("GIT_STATE_RUNTIME_CLOSED", "Shared rail runtime is closed");
    if (!context || typeof context.cwd !== "string" || !context.cwd) {
      throw new TypeError("repository subscription requires context.cwd");
    }
    if (typeof onDelivery !== "function") throw new TypeError("repository subscription requires onDelivery");
    const { localEnvironment } = localContext(context);
    const handle = adaptiveRepositorySubscription({
      context,
      listener: onDelivery,
      openShared: client.openRepositorySubscription,
      openFallback: fallbackFactory,
      localize: (delivery) => localizeRepositoryDelivery(delivery, {
        cwd: context.cwd,
        environment: localEnvironment,
        loadConfiguration,
      }),
      onFallback: (status) => { fallbackSubscriptions += 1; onStatus(status); },
      onClose: () => handles.delete(handle),
      closeTimeoutMs: subscriptionCloseTimeoutMs,
    });
    handles.add(handle);
    return handle;
  }

  function subscribeHost(selector, listener) {
    if (closed) throw codedError("GIT_STATE_RUNTIME_CLOSED", "Shared rail runtime is closed");
    return client.subscribeHost(selector, listener);
  }

  async function close() {
    if (closed) return;
    closed = true;
    await Promise.allSettled([...handles].map((handle) => handle.close()));
    handles.clear();
    await client.close();
  }

  return {
    mode: "shared",
    identity: runtime.identity,
    paths: runtime.paths,
    client,
    openRepositorySubscription,
    subscribeHost,
    close,
    get status() {
      return {
        closed,
        repositorySubscriptions: handles.size,
        fallbackSubscriptions,
        client: client.status,
      };
    },
  };
}
