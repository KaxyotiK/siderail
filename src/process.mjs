import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { debugLog } from "./debug-log.mjs";

const gitProcessStorage = new AsyncLocalStorage();

export class ProcessError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProcessError";
    Object.assign(this, details);
  }
}

export function runCommand(command, args = [], options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 8_000,
    maxOutputBytes = 16 * 1024 * 1024,
    allowExitCodes = [0],
    stdoutEncoding = "utf8",
    stdinInput,
    killGraceMs = 250,
    waitForTermination = false,
    signal,
    baseEnv,
  } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProcessError(`${command} was cancelled`, { kind: "aborted", command, args }));
      return;
    }
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...(baseEnv || process.env), ...env } : baseEnv || process.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: [stdinInput === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let timer;
    let forceKillTimer;
    let termination;
    let abortListener;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (waitForTermination) clearTimeout(forceKillTimer);
      if (abortListener) signal?.removeEventListener("abort", abortListener);
      callback();
    };
    const resultSoFar = (exitCode = null, signal = null, { allowLossy = false } = {}) => {
      const stdoutBuffer = Buffer.concat(stdout);
      return {
        command,
        args,
        exitCode,
        signal,
        stdout: stdoutEncoding === null
          ? stdoutBuffer
          : stdoutEncoding === "utf8-strict" && !allowLossy
            ? new TextDecoder("utf-8", { fatal: true }).decode(stdoutBuffer)
            : stdoutBuffer.toString(stdoutEncoding === "utf8-strict" ? "utf8" : stdoutEncoding),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Date.now() - startedAt,
      };
    };
    const terminate = (kind, message) => {
      if (settled) return;
      const signalTree = (signal) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch { try { child.kill(signal); } catch {} }
      };
      termination = { kind, message };
      signalTree("SIGTERM");
      child.stdout.destroy();
      child.stderr.destroy();
      forceKillTimer = setTimeout(() => {
        signalTree("SIGKILL");
        if (waitForTermination) finish(() => {
          const result = resultSoFar(null, "SIGKILL", { allowLossy: true });
          debugLog(command, { durationMs: result.durationMs, exitCode: null, signal: "SIGKILL", outcome: kind });
          reject(new ProcessError(message, { kind, ...result }));
        });
      }, killGraceMs);
      forceKillTimer.unref();
      if (!waitForTermination) finish(() => {
        const result = resultSoFar(null, null, { allowLossy: true });
        debugLog(command, { durationMs: result.durationMs, exitCode: null, signal: "SIGTERM", outcome: kind });
        reject(new ProcessError(message, { kind, ...result }));
      });
    };
    const capture = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        terminate("oversized", `${command} output exceeded ${maxOutputBytes} bytes`);
        return;
      }
      target.push(chunk);
    };
    if (signal) {
      abortListener = () => terminate("aborted", `${command} was cancelled`);
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
    }
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.on("error", (cause) => finish(() => reject(new ProcessError(
      cause.code === "ENOENT" ? `${command} is not installed` : `${command} failed to start: ${cause.message}`,
      { kind: cause.code === "ENOENT" ? "missing-executable" : "spawn", command, args, cause },
    ))));
    child.on("close", (exitCode, signal) => finish(() => {
      let result;
      try {
        result = resultSoFar(exitCode, signal);
      } catch (cause) {
        const lossyResult = resultSoFar(exitCode, signal, { allowLossy: true });
        debugLog(command, { durationMs: lossyResult.durationMs, exitCode, signal, outcome: "invalid-output" });
        reject(new ProcessError(`${command} stdout was not valid UTF-8`, {
          kind: "invalid-output",
          ...lossyResult,
          cause,
        }));
        return;
      }
      if (termination) {
        debugLog(command, { durationMs: result.durationMs, exitCode, signal, outcome: termination.kind });
        reject(new ProcessError(termination.message, { kind: termination.kind, ...result }));
        return;
      }
      debugLog(command, { durationMs: result.durationMs, exitCode, signal, outcome: allowExitCodes.includes(exitCode) ? "ok" : "error" });
      if (!allowExitCodes.includes(exitCode)) {
        reject(new ProcessError(
          result.stderr.trim() || `${command} exited with status ${exitCode}`,
          { kind: "exit", ...result },
        ));
      } else {
        resolve(result);
      }
    }));

    timer = setTimeout(() => terminate("timeout", `${command} timed out after ${timeoutMs}ms`), timeoutMs);
    timer.unref();
    if (stdinInput !== undefined) {
      child.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") terminate("stdin", `${command} could not read input: ${error.message}`);
      });
      child.stdin.end(stdinInput);
    }
  });
}

export function runGit(cwd, args, options = {}) {
  const context = gitProcessStorage.getStore();
  const {
    gitExecutable = context?.executable || "git",
    baseEnv = context?.environment,
    ...commandOptions
  } = options;
  if (commandOptions.signal === undefined && context?.signal) commandOptions.signal = context.signal;
  return runCommand(gitExecutable, args, {
    cwd,
    ...commandOptions,
    baseEnv,
    // Background reads must never refresh the index, even if a caller passes
    // an environment that enables Git's optional locks.
    env: { ...(commandOptions.env || {}), GIT_OPTIONAL_LOCKS: "0" },
  });
}

export function withGitProcessContext({ environment = process.env, executable = "git", signal } = {}, callback) {
  if (typeof callback !== "function") throw new TypeError("withGitProcessContext requires a callback");
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("Git process environment must be an object");
  }
  if (typeof executable !== "string" || !executable.trim()) {
    throw new TypeError("Git executable must be a non-empty string");
  }
  const context = Object.freeze({
    environment: Object.freeze({ ...environment }),
    executable,
    signal,
  });
  return gitProcessStorage.run(context, callback);
}
