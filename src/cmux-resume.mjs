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

export function cmuxDockRestartCommand(scriptDirectory) {
  const launcher = path.join(scriptDirectory, "cmux-node-launcher.sh");
  const entrypoint = path.join(scriptDirectory, "cmux-git-rail.mjs");
  return `/bin/bash ${shellQuote(launcher)} ${shellQuote(entrypoint)}`;
}

export async function ensureCmuxDockResume({
  run = runCommand,
  environment = process.env,
  scriptDirectory,
} = {}) {
  const surfaceId = normalized(environment.CMUX_SURFACE_ID);
  const ownerWindowId = normalized(environment.GIT_RAIL_WINDOW_ID || environment.CMUX_WORKSPACE_ID);
  const controlId = normalized(environment.CMUX_DOCK_CONTROL_ID);
  if (!surfaceId || !ownerWindowId || (controlId && controlId !== "git-rail")) {
    return { configured: false, autoResume: false };
  }
  const resolvedScriptDirectory = path.resolve(scriptDirectory);
  const projectRoot = path.dirname(resolvedScriptDirectory);
  const command = cmuxDockRestartCommand(resolvedScriptDirectory);
  const title = normalized(environment.CMUX_DOCK_CONTROL_TITLE) || "GitRail";
  const result = await run(cmuxExecutable(environment), [
    "--json",
    "surface", "resume", "set",
    "--window", ownerWindowId,
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
