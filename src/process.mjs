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
  } = options;

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let oversized = false;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const capture = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        oversized = true;
        child.kill("SIGTERM");
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
      const result = {
        command,
        args,
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Date.now() - startedAt,
      };
      debugLog(command, { durationMs: result.durationMs, exitCode, signal, outcome: timedOut ? "timeout" : oversized ? "oversized" : allowExitCodes.includes(exitCode) ? "ok" : "error" });
      if (timedOut) {
        reject(new ProcessError(`${command} timed out after ${timeoutMs}ms`, { kind: "timeout", ...result }));
      } else if (oversized) {
        reject(new ProcessError(`${command} output exceeded ${maxOutputBytes} bytes`, { kind: "oversized", ...result }));
      } else if (!allowExitCodes.includes(exitCode)) {
        reject(new ProcessError(
          result.stderr.trim() || `${command} exited with status ${exitCode}`,
          { kind: "exit", ...result },
        ));
      } else {
        resolve(result);
      }
    }));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 250).unref();
    }, timeoutMs);
    timer.unref();
  });
}

export function runGit(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
}
