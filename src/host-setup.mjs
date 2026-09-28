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

export const TOGGLE_ACTION = `${PLUGIN_ID}.toggle-siderail`;
export const DEFAULT_TOGGLE_KEY = "ctrl+shift+g";
const TOGGLE_BINDING_MARKER = "# Added by `siderail setup`; `siderail uninstall` removes it.";
const TOGGLE_BINDING = [
  TOGGLE_BINDING_MARKER,
  "[[keys.command]]",
  `key = "${DEFAULT_TOGGLE_KEY}"`,
  "type = \"plugin_action\"",
  `command = "${TOGGLE_ACTION}"`,
  "description = \"toggle SideRail sidebar\"",
  "",
].join("\n");

// Herdr reads HERDR_CONFIG_PATH, then $XDG_CONFIG_HOME/herdr/config.toml, then ~/.config.
export function herdrConfigPath(environment = process.env) {
  if (environment.HERDR_CONFIG_PATH) return environment.HERDR_CONFIG_PATH;
  const base = environment.XDG_CONFIG_HOME
    || (environment.HOME ? path.join(environment.HOME, ".config") : "");
  if (!base) throw new Error("HOME is not set; cannot locate Herdr's config.toml");
  return path.join(base, "herdr", "config.toml");
}

function readTextIfPresent(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function writeTextAtomically(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let mode = 0o644;
  try { mode = fs.statSync(file).mode & 0o777; } catch {}
  const temporary = `${file}.siderail-${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode });
  fs.renameSync(temporary, file);
}

function bindsToggle(text) {
  const action = TOGGLE_ACTION.replaceAll(".", "\\.");
  return new RegExp(`^\\s*command\\s*=\\s*["']${action}["']`, "m").test(text || "");
}

async function checkHerdrConfig({ environment, run, configPath }) {
  const result = await run(herdrExecutable(environment), ["config", "check"], {
    env: { ...environment, HERDR_CONFIG_PATH: configPath },
    timeoutMs: 8_000,
    maxOutputBytes: 1_024 * 1_024,
    allowExitCodes: [0, 1],
  });
  const lines = `${result.stdout || ""}\n${result.stderr || ""}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return { ok: result.exitCode === 0, issues: lines.filter((line) => !/^config: /i.test(line)) };
}

async function reloadHerdrConfig({ environment, run }) {
  try {
    await run(herdrExecutable(environment), ["server", "reload-config"], { timeoutMs: 8_000, maxOutputBytes: 1_024 * 1_024 });
    return true;
  } catch {
    return false;
  }
}

// Herdr plugins cannot declare key bindings, so setup adds a default one to
// Herdr's config.toml. It never replaces a binding the user chose, and it
// keeps a config Herdr would reject exactly as it was.
export async function bindHerdrToggleKey({ environment = process.env, run = runCommand, configPath = herdrConfigPath(environment) } = {}) {
  const original = readTextIfPresent(configPath);
  if (bindsToggle(original)) return { action: "unchanged", configPath };
  if (original !== null) {
    const before = await checkHerdrConfig({ environment, run, configPath });
    if (!before.ok) return { action: "config-invalid", configPath, issues: before.issues };
  }
  const separator = !original ? "" : original.endsWith("\n\n") ? "" : original.endsWith("\n") ? "\n" : "\n\n";
  writeTextAtomically(configPath, `${original || ""}${separator}${TOGGLE_BINDING}`);
  const after = await checkHerdrConfig({ environment, run, configPath });
  if (!after.ok) {
    if (original === null) fs.rmSync(configPath, { force: true });
    else writeTextAtomically(configPath, original);
    return { action: "key-taken", configPath, issues: after.issues };
  }
  return { action: "bound", configPath, reloaded: await reloadHerdrConfig({ environment, run }) };
}

// Removes only the binding setup wrote, byte for byte; an edited one is the user's.
export async function unbindHerdrToggleKey({ environment = process.env, run = runCommand, configPath = herdrConfigPath(environment) } = {}) {
  const text = readTextIfPresent(configPath);
  const index = text === null ? -1 : text.indexOf(TOGGLE_BINDING);
  if (index < 0) return { action: bindsToggle(text) ? "kept" : "absent", configPath };
  const before = text.slice(0, index).replace(/\n\n$/, "\n");
  writeTextAtomically(configPath, `${before}${text.slice(index + TOGGLE_BINDING.length)}`);
  return { action: "removed", configPath, reloaded: await reloadHerdrConfig({ environment, run }) };
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
