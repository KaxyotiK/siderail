import path from "node:path";
import { cmuxExecutable } from "./cmux-context.mjs";
import { runCommand } from "./process.mjs";

function normalized(value) {
  return String(value || "").trim();
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function parseObject(stdout) {
  const parsed = JSON.parse(stdout || "{}");
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

/**
 * cmux stores no environment alongside a resume binding, so the restored Dock
 * shell only carries what the restart command itself restates. The owning
 * window id is deliberately excluded: window ids do not survive an app restart,
 * and a stale one would outrank live owner discovery.
 */
export function cmuxDockRestartCommand(scriptDirectory, variables = {}) {
  const launcher = path.join(scriptDirectory, "cmux-node-launcher.sh");
  const entrypoint = path.join(scriptDirectory, "cmux-git-rail.mjs");
  const command = `/bin/bash ${shellQuote(launcher)} ${shellQuote(entrypoint)}`;
  const assignments = Object.entries(variables)
    .filter(([, value]) => normalized(value))
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  return assignments.length ? `env ${assignments.join(" ")} ${command}` : command;
}

export async function ensureCmuxDockResume({
  run = runCommand,
  environment = process.env,
  scriptDirectory,
} = {}) {
  const surfaceId = normalized(environment.CMUX_SURFACE_ID);
  const ownerWindowId = normalized(environment.GIT_RAIL_WINDOW_ID);
  const controlId = normalized(environment.CMUX_DOCK_CONTROL_ID);
  if (!surfaceId || (controlId && controlId !== "git-rail")) {
    return { configured: false, autoResume: false };
  }
  const resolvedScriptDirectory = path.resolve(scriptDirectory);
  const projectRoot = path.dirname(resolvedScriptDirectory);
  const title = normalized(environment.CMUX_DOCK_CONTROL_TITLE) || "GitRail";
  const command = cmuxDockRestartCommand(resolvedScriptDirectory, {
    GIT_RAIL_HOST: "cmux",
    GIT_RAIL_NODE_PATH: environment.GIT_RAIL_NODE_PATH,
    GIT_RAIL_STAY_OPEN: "1",
    CMUX_DOCK_CONTROL_ID: "git-rail",
    CMUX_DOCK_CONTROL_TITLE: title,
  });
  const result = await run(cmuxExecutable(environment), [
    "--json",
    "surface", "resume", "set",
    ...(ownerWindowId ? ["--window", ownerWindowId] : []),
    "--surface", surfaceId,
    "--name", title,
    "--kind", "git-rail",
    "--source", "git-rail",
    "--cwd", projectRoot,
    "--shell", command,
  ], {
    cwd: projectRoot,
    env: environment,
    timeoutMs: 180_000,
    maxOutputBytes: 512 * 1_024,
  });
  const payload = parseObject(result.stdout);
  return {
    configured: true,
    autoResume: payload.resume_binding?.auto_resume === true,
    command,
    projectRoot,
  };
}
