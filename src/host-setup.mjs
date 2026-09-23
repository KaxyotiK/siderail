import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./process.mjs";

export const PLUGIN_ID = "siderail";
const DOCK_CONTROL_ID = "siderail";
const DOCK_ENTRYPOINT = "scripts/cmux-siderail.mjs";
const DOCK_LAUNCHER = "scripts/cmux-node-launcher.sh";

export function readPackageInfo(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  return { name: manifest.name, version: manifest.version };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function herdrExecutable(environment) {
  return environment.HERDR_BIN_PATH || "herdr";
}

export async function findHerdrPlugin({ environment = process.env, run = runCommand } = {}) {
  const listed = await run(herdrExecutable(environment), ["plugin", "list", "--json"], {
    timeoutMs: 8_000,
    maxOutputBytes: 4 * 1_024 * 1_024,
  });
  let plugins;
  try {
    plugins = JSON.parse(listed.stdout)?.result?.plugins;
  } catch {
    throw new Error("herdr plugin list returned invalid JSON");
  }
  if (!Array.isArray(plugins)) throw new Error("herdr plugin list returned no plugin array");
  const plugin = plugins.find((candidate) => candidate?.plugin_id === PLUGIN_ID);
  if (!plugin) return null;
  return {
    root: typeof plugin.plugin_root === "string" ? plugin.plugin_root : null,
    source: typeof plugin.source?.kind === "string" ? plugin.source.kind : null,
    enabled: plugin.enabled !== false,
    version: typeof plugin.version === "string" ? plugin.version : null,
  };
}

export async function setupHerdr({ root, environment = process.env, run = runCommand } = {}) {
  const existing = await findHerdrPlugin({ environment, run });
  if (existing && existing.source !== "local") {
    throw new Error(`Herdr already has a ${existing.source || "non-local"} ${PLUGIN_ID} plugin; run "herdr plugin uninstall ${PLUGIN_ID}" first`);
  }
  if (existing?.root && path.resolve(existing.root) === path.resolve(root)) {
    return { action: "unchanged", root, previousRoot: existing.root };
  }
  await run(herdrExecutable(environment), ["plugin", "link", root], {
    timeoutMs: 15_000,
    maxOutputBytes: 1_024 * 1_024,
  });
  return { action: existing ? "moved" : "linked", root, previousRoot: existing?.root || null };
}

export async function assertHerdrLinkedHere({ root, environment = process.env, run = runCommand } = {}) {
  const existing = await findHerdrPlugin({ environment, run });
  if (!existing) return false;
  if (existing.source !== "local" || !existing.root || path.resolve(existing.root) !== path.resolve(root)) {
    throw new Error(`Herdr's ${PLUGIN_ID} plugin belongs to ${existing.root || existing.source || "another install"}, not ${root}; leaving it in place`);
  }
  return true;
}

export function dockConfigPath(environment = process.env) {
  if (!environment.HOME) throw new Error("HOME is not set; cannot locate ~/.config/cmux/dock.json");
  return path.join(environment.HOME, ".config", "cmux", "dock.json");
}

export function dockControl(root) {
  return {
    id: DOCK_CONTROL_ID,
    title: "SideRail",
    command: `/bin/bash ${shellQuote(path.join(root, DOCK_LAUNCHER))} ${shellQuote(path.join(root, DOCK_ENTRYPOINT))}`,
    cwd: ".",
  };
}

// The exact inverse of dockControl's command: two single-quoted absolute
// paths, where a quote inside a path is written '\'', naming the launcher and
// entrypoint of one install root. Anything else is not a SideRail control.
function parseDockCommand(command) {
  if (typeof command !== "string") return null;
  const quoted = "'((?:[^']|'\\\\'')*)'";
  const match = new RegExp(`^/bin/bash ${quoted} ${quoted}$`).exec(command);
  if (!match) return null;
  const [launcher, entrypoint] = [match[1], match[2]].map((value) => value.replaceAll("'\\''", "'"));
  const launcherSuffix = `/${DOCK_LAUNCHER}`;
  const entrypointSuffix = `/${DOCK_ENTRYPOINT}`;
  if (!launcher.endsWith(launcherSuffix) || !entrypoint.endsWith(entrypointSuffix)) return null;
  const root = launcher.slice(0, -launcherSuffix.length);
  if (!path.isAbsolute(root) || entrypoint.slice(0, -entrypointSuffix.length) !== root) return null;
  return dockControl(root).command === command ? root : null;
}

function isOwnedDockControl(control) {
  return control?.id === DOCK_CONTROL_ID && parseDockCommand(control.command) !== null;
}

function readDockConfig(configPath) {
  let text;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error(`${configPath} is not valid JSON; fix it before running setup`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${configPath} must contain a JSON object`);
  }
  if (config.controls !== undefined && !Array.isArray(config.controls)) {
    throw new Error(`${configPath} has a non-array "controls" field`);
  }
  return config;
}

function writeDockConfig(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  let mode = 0o644;
  try { mode = fs.statSync(configPath).mode & 0o777; } catch {}
  const temporary = `${configPath}.siderail-${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode });
  fs.renameSync(temporary, configPath);
}

export function findDockControl({ environment = process.env, configPath = dockConfigPath(environment) } = {}) {
  const config = readDockConfig(configPath);
  const control = config?.controls?.find((candidate) => candidate?.id === DOCK_CONTROL_ID) || null;
  return { configPath, control };
}

export function setupCmux({ root, environment = process.env, configPath = dockConfigPath(environment) } = {}) {
  const config = readDockConfig(configPath) || {};
  const controls = Array.isArray(config.controls) ? config.controls : [];
  const desired = dockControl(root);
  const index = controls.findIndex((control) => control?.id === DOCK_CONTROL_ID);
  if (index >= 0 && !isOwnedDockControl(controls[index])) {
    throw new Error(`${configPath} already has a "${DOCK_CONTROL_ID}" control that does not launch SideRail; rename or remove it first`);
  }
  if (index >= 0 && controls[index].command === desired.command) {
    return { action: "unchanged", configPath, control: controls[index] };
  }
  const next = index >= 0
    ? controls.map((control, position) => (position === index ? { ...control, command: desired.command } : control))
    : [...controls, desired];
  writeDockConfig(configPath, { ...config, controls: next });
  return { action: index >= 0 ? "updated" : "added", configPath, control: next[index >= 0 ? index : next.length - 1] };
}

export function uninstallCmux({ environment = process.env, configPath = dockConfigPath(environment) } = {}) {
  const config = readDockConfig(configPath);
  const controls = Array.isArray(config?.controls) ? config.controls : [];
  const index = controls.findIndex((control) => control?.id === DOCK_CONTROL_ID);
  if (index < 0) return { action: "absent", configPath };
  if (!isOwnedDockControl(controls[index])) {
    throw new Error(`${configPath} has a "${DOCK_CONTROL_ID}" control that does not launch SideRail; leaving it in place`);
  }
  writeDockConfig(configPath, { ...config, controls: controls.filter((_control, position) => position !== index) });
  return { action: "removed", configPath };
}

export function dockControlRoot(control) {
  return control?.id === DOCK_CONTROL_ID ? parseDockCommand(control.command) : null;
}
