import { spawn } from "node:child_process";
import { debugLog } from "./debug-log.mjs";

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
  } = options;

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: [stdinInput === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let timer;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const resultSoFar = (exitCode = null, signal = null) => {
      const stdoutBuffer = Buffer.concat(stdout);
      return {
        command,
        args,
        exitCode,
        signal,
        stdout: stdoutEncoding === null ? stdoutBuffer : stdoutBuffer.toString(stdoutEncoding),
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
      signalTree("SIGTERM");
      child.stdout.destroy();
      child.stderr.destroy();
      setTimeout(() => signalTree("SIGKILL"), 250).unref();
      finish(() => {
        const result = resultSoFar();
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
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.on("error", (cause) => finish(() => reject(new ProcessError(
      cause.code === "ENOENT" ? `${command} is not installed` : `${command} failed to start: ${cause.message}`,
      { kind: cause.code === "ENOENT" ? "missing-executable" : "spawn", command, args, cause },
    ))));
    child.on("close", (exitCode, signal) => finish(() => {
      const result = resultSoFar(exitCode, signal);
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
  return runCommand("git", args, {
    cwd,
    ...options,
    env: { GIT_OPTIONAL_LOCKS: "0", ...(options.env || {}) },
  });
}
