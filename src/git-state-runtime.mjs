import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { createGitStateCoordinator } from "./git-state-coordinator.mjs";
import {
  computeCodeFingerprint,
  collectEffectiveRuntimeSemantics,
  createCoordinatorIdentity,
  digestEffectiveGitEnvironment,
  digestEffectiveRuntimeSemantics,
  preparePrivateRuntimePaths,
  resolveGitExecutableIdentity,
  GitStateIdentityError,
} from "./git-state-identity.mjs";
import { loadConfig } from "./config.mjs";
import { createHerdrContextSource } from "./herdr-context-watch.mjs";
import { runCommand } from "./process.mjs";

const GIT_STATE_CHECKOUT_PATH = fileURLToPath(new URL("..", import.meta.url));

async function runtimeSourceFiles(checkoutPath) {
  const result = ["scripts/git-state-coordinator.mjs"];
  async function visit(directory) {
    for (const entry of await fs.readdir(path.join(checkoutPath, directory), { withFileTypes: true })) {
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile() && entry.name.endsWith(".mjs")) result.push(relative);
    }
  }
  await visit("src");
  return result.sort();
}

export async function readProcessStartIdentity(pid, {
  run = runCommand,
  platform = process.platform,
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError("pid must be a positive integer");
  if (platform === "win32") {
    const error = new Error("process-start identity is unavailable on Windows");
    error.code = "GIT_STATE_PROCESS_IDENTITY_UNAVAILABLE";
    throw error;
  }
  const result = await run("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    timeoutMs: 2_000,
    maxOutputBytes: 4_096,
    stdoutEncoding: "utf8-strict",
    env: { LC_ALL: "C", LANG: "C" },
  });
  const value = result.stdout.trim().replace(/\s+/g, " ");
  if (!value) {
    const error = new Error(`process ${pid} has no start identity`);
    error.code = "GIT_STATE_PROCESS_IDENTITY_UNAVAILABLE";
    throw error;
  }
  return value;
}

export async function resolveGitStateRuntime({
  environment = process.env,
  checkoutPath = GIT_STATE_CHECKOUT_PATH,
  runtimeFiles,
  hostSocketPath = environment.HERDR_SOCKET_PATH || "",
  gitExecutable = "git",
} = {}) {
  if (!hostSocketPath) {
    const error = new Error("HERDR_SOCKET_PATH is required for the shared Git state coordinator");
    error.code = "GIT_STATE_HOST_SOCKET_UNAVAILABLE";
    throw error;
  }
  // A shared engine runs at the canonical worktree root. Relative executable
  // and configuration paths can change meaning when the selected cwd differs.
  // Keep these contexts local; relative GIT_INDEX_FILE is separately resolved
  // by Git from the provider's worktree root and remains supported.
  const relativeInput = [
    ...String(environment.PATH || "").split(path.delimiter),
    ...["HOME", "XDG_CONFIG_HOME", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR",
      "GIT_CONFIG", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL", "GIT_OBJECT_DIRECTORY"]
      .filter((name) => environment[name]).map((name) => environment[name]),
    ...(environment.GIT_ALTERNATE_OBJECT_DIRECTORIES
      ? String(environment.GIT_ALTERNATE_OBJECT_DIRECTORIES).split(path.delimiter) : []),
  ].some((value) => !path.isAbsolute(value));
  if (relativeInput) {
    throw new GitStateIdentityError("UNSUPPORTED_ENVIRONMENT", "Relative Git executable or configuration paths require in-process state");
  }
  const selectedRuntimeFiles = runtimeFiles || await runtimeSourceFiles(checkoutPath);
  const { config, errors } = loadConfig(environment);
  const watchMode = ["watch-only", "poll-only", "watch-and-poll"].includes(environment.GIT_RAIL_WATCH_MODE)
    ? environment.GIT_RAIL_WATCH_MODE
    : "watch-and-poll";
  const providerConfig = Object.freeze({
    baseRef: config.baseRef || "",
    maxFileBytes: config.limits.maxFileBytes,
  });
  const schedulerConfig = Object.freeze({
    pollIntervalMs: config.refresh.pollIntervalMs,
    reconcileIntervalMs: config.refresh.reconcileIntervalMs,
    watchMode,
  });
  const configErrors = Object.freeze([...errors].sort());
  const effectiveConfigId = digestEffectiveRuntimeSemantics(
    collectEffectiveRuntimeSemantics(environment),
  );
  const [codeFingerprint, gitExecutableIdentity] = await Promise.all([
    computeCodeFingerprint(selectedRuntimeFiles, { checkoutPath }),
    resolveGitExecutableIdentity({ environment, executable: gitExecutable, cwd: checkoutPath }),
  ]);
  const providerEnvironmentId = digestEffectiveGitEnvironment(environment);
  const identity = await createCoordinatorIdentity({
    hostSocketPath,
    codeFingerprint,
    providerEnvironmentId,
    gitExecutableIdentity,
    effectiveConfigId,
  });
  const paths = await preparePrivateRuntimePaths({ environment, namespaceId: identity.namespaceId });
  return Object.freeze({
    identity,
    paths,
    checkoutPath,
    runtimeFiles: Object.freeze([...selectedRuntimeFiles]),
    gitExecutableIdentity,
    providerConfig,
    schedulerConfig,
    configErrors,
    effectiveConfigId,
  });
}

async function readJson(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch { return null; }
}

export async function runGitStateCoordinator({
  expectedNamespaceId,
  expectedSocketPath,
  expectedLeasePath,
  nonce,
  environment = process.env,
  resolveRuntime = resolveGitStateRuntime,
  coordinatorFactory = createGitStateCoordinator,
  hostSourceFactory = () => createHerdrContextSource({ environment, fallbackIntervalMs: 1_000 }),
  processObject = process,
  idleExitMs = 1_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!expectedNamespaceId || !expectedSocketPath || !expectedLeasePath || !nonce) {
    throw new TypeError("coordinator runtime requires expected namespace, socket, lease, and nonce");
  }
  const runtime = await resolveRuntime({ environment });
  const { namespaceId } = runtime.identity;
  const { socketPath, leasePath } = runtime.paths;
  if (namespaceId !== expectedNamespaceId || socketPath !== expectedSocketPath || leasePath !== expectedLeasePath) {
    const error = new Error("coordinator runtime identity does not match the launch claim");
    error.code = "GIT_STATE_NAMESPACE_MISMATCH";
    throw error;
  }
  const lease = await readJson(leasePath);
  if (lease?.nonce !== nonce || lease.namespaceId !== namespaceId) {
    const error = new Error("coordinator launch lease was lost before startup");
    error.code = "GIT_STATE_LEASE_LOST";
    throw error;
  }
  const processStartIdentity = await readProcessStartIdentity(processObject.pid);
  const ownerPath = `${leasePath}.${nonce}.owner.json`;
  await fs.writeFile(ownerPath, JSON.stringify({
    nonce,
    pid: processObject.pid,
    processStartIdentity,
    namespaceId,
    createdAt: Date.now(),
  }), { mode: 0o600, flag: "wx" });
  if ((await readJson(leasePath))?.nonce !== nonce) {
    await fs.rm(ownerPath, { force: true });
    const error = new Error("coordinator launch lease changed during startup");
    error.code = "GIT_STATE_LEASE_LOST";
    throw error;
  }
  try { await fs.unlink(socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }

  let idleTimer;
  let stopping = false;
  let settleDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => { settleDone = resolve; rejectDone = reject; });
  done.catch(() => {});
  let coordinator;

  const cleanup = async () => {
    const current = await readJson(leasePath);
    if (current?.nonce === nonce) {
      try { await fs.unlink(socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if ((await readJson(leasePath))?.nonce === nonce) await fs.rm(leasePath, { force: true });
    }
    await fs.rm(ownerPath, { force: true });
  };
  const removeSignals = () => {
    processObject.removeListener?.("SIGTERM", onSignal);
    processObject.removeListener?.("SIGINT", onSignal);
  };
  const stop = async (error) => {
    if (stopping) return done;
    stopping = true;
    clearTimer(idleTimer);
    removeSignals();
    try {
      await coordinator?.close();
      await cleanup();
      if (error) rejectDone(error);
      else settleDone();
    } catch (cleanupError) {
      rejectDone(error || cleanupError);
    }
    return done;
  };
  const onSignal = () => { stop().catch(() => {}); };
  const scheduleExit = () => {
    clearTimer(idleTimer);
    idleTimer = setTimer(() => {
      if (!coordinator.status.sessions && !coordinator.status.engines && !coordinator.status.hostSubscribers) {
        stop().catch(() => {});
      }
    }, idleExitMs);
    idleTimer.unref?.();
  };
  coordinator = coordinatorFactory({
    namespaceId,
    environment,
    providerConfig: runtime.providerConfig,
    schedulerConfig: runtime.schedulerConfig,
    hostSourceFactory,
    idleGraceMs: 0,
    onIdle: scheduleExit,
  });
  try {
    await coordinator.listen(socketPath);
  } catch (error) {
    await stop(error).catch(() => {});
    throw error;
  }
  processObject.once?.("SIGTERM", onSignal);
  processObject.once?.("SIGINT", onSignal);
  return { coordinator, done, stop, runtime, ownerPath };
}
