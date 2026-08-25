import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_VERSION = 1;
const RESERVED_VIEWER_KEYS = new Set(["1", "2", "e", "q", "j", "k", "g", "G", "n", "N", "w"]);
const LEGACY_VIEWER_KEYS = ["3", "4", "5", "6", "7", "8", "9", "0"];
export const DEFAULT_CONFIG = deepFreeze({
  version: CONFIG_VERSION,
  herdr: { autoOpen: true, sidebarWidth: 34 },
  editor: { client: "none", args: [], mode: "auto" },
  viewers: {
    ".md": { label: "Rendered", client: "ink", args: [], mode: "terminal", key: "3", autoOpen: true },
    ".mdx": { label: "Rendered", client: "ink", args: [], mode: "terminal", key: "3", autoOpen: true },
    ".markdown": { label: "Rendered", client: "ink", args: [], mode: "terminal", key: "3", autoOpen: true },
    "*": { label: "Open", client: "system", args: [], mode: "external", key: "o", autoOpen: false },
  },
  refresh: { pollIntervalMs: 10_000 },
  limits: { maxFileBytes: 4 * 1024 * 1024, maxDiffBytes: 8 * 1024 * 1024 },
});

function deepFreeze(value) {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") deepFreeze(nested);
  }
  return Object.freeze(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function merge(base, override) {
  const result = {};
  for (const [key, value] of Object.entries(base || {})) {
    Object.defineProperty(result, key, {
      value: isObject(value) ? merge(value, {}) : Array.isArray(value) ? [...value] : value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  for (const [key, value] of Object.entries(override || {})) {
    Object.defineProperty(result, key, {
      value: isObject(value) && isObject(base?.[key]) ? merge(base[key], value) : value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return result;
}

function validateKeys(value, label, allowed, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`unknown ${label} key: ${key}`);
  }
}

function validateLaunch(value, label, errors, { viewer = false } = {}) {
  if (!isObject(value)) return errors.push(`${label} must be an object`);
  validateKeys(value, label, new Set(["client", "args", "mode", ...(viewer ? ["label", "key", "order", "autoOpen"] : [])]), errors);
  if (typeof value.client !== "string" || !value.client.trim()) errors.push(`${label}.client must be a non-empty string`);
  if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string"))) {
    errors.push(`${label}.args must be an array of strings`);
  }
  const launchModes = viewer ? ["auto", "terminal", "external", "embedded"] : ["auto", "terminal", "external"];
  if (value.mode !== undefined && !launchModes.includes(value.mode)) {
    errors.push(`${label}.mode must be ${launchModes.slice(0, -1).join(", ")}, or ${launchModes.at(-1)}`);
  }
  if (viewer && value.label !== undefined && (typeof value.label !== "string" || !value.label.trim())) {
    errors.push(`${label}.label must be a non-empty string`);
  }
  if (viewer && value.key !== undefined && (typeof value.key !== "string" || !/^[A-Za-z0-9]$/.test(value.key) || RESERVED_VIEWER_KEYS.has(value.key))) {
    errors.push(`${label}.key must be one unreserved letter or digit`);
  }
  if (viewer && value.order !== undefined && (!Number.isInteger(value.order) || value.order < -10_000 || value.order > 10_000)) {
    errors.push(`${label}.order must be an integer from -10000 to 10000`);
  }
  if (viewer && value.autoOpen !== undefined && typeof value.autoOpen !== "boolean") errors.push(`${label}.autoOpen must be boolean`);
}

function validateViewer(value, label, errors) {
  if (!Array.isArray(value)) return validateLaunch(value, label, errors, { viewer: true });
  if (!value.length) errors.push(`${label} must contain at least one viewer action`);
  for (const [index, action] of value.entries()) validateLaunch(action, `${label}[${index}]`, errors, { viewer: true });
}

export function validateConfig(config) {
  const errors = [];
  if (!isObject(config)) return ["configuration must be a JSON object"];
  const allowed = new Set(["version", "baseRef", "herdr", "editor", "viewers", "refresh", "limits"]);
  for (const key of Object.keys(config)) if (!allowed.has(key)) errors.push(`unknown configuration key: ${key}`);
  if (config.version !== CONFIG_VERSION) errors.push(`version must be ${CONFIG_VERSION}`);
  if (config.baseRef !== undefined && (typeof config.baseRef !== "string" || !config.baseRef.trim())) errors.push("baseRef must be a non-empty string");
  if (config.herdr !== undefined) {
    if (!isObject(config.herdr)) errors.push("herdr must be an object");
    else {
      validateKeys(config.herdr, "herdr", new Set(["autoOpen", "sidebarWidth"]), errors);
      if (config.herdr.autoOpen !== undefined && typeof config.herdr.autoOpen !== "boolean") {
        errors.push("herdr.autoOpen must be boolean");
      }
      if (config.herdr.sidebarWidth !== undefined && (!Number.isInteger(config.herdr.sidebarWidth) || config.herdr.sidebarWidth < 20 || config.herdr.sidebarWidth > 200)) {
        errors.push("herdr.sidebarWidth must be an integer from 20 to 200");
      }
    }
  }
  if (config.editor !== undefined) validateLaunch(config.editor, "editor", errors);
  if (config.viewers !== undefined) {
    if (!isObject(config.viewers)) errors.push("viewers must be an object");
    else for (const [pattern, value] of Object.entries(config.viewers)) {
      if (!pattern) errors.push("viewer patterns must not be empty");
      else if (pattern !== "*" && (
        /[\\/]/.test(pattern)
        || /[*?\[\]{}]/.test(pattern)
        || pattern.startsWith(".") && pattern.length === 1
      )) {
        errors.push(`viewer pattern ${JSON.stringify(pattern)} must be *, a dot-prefixed suffix, or an exact basename without glob metacharacters or path separators`);
      }
      validateViewer(value, `viewers[${JSON.stringify(pattern)}]`, errors);
    }
  }
  if (config.refresh !== undefined) {
    if (!isObject(config.refresh)) errors.push("refresh must be an object");
    else {
      validateKeys(config.refresh, "refresh", new Set(["pollIntervalMs"]), errors);
      const interval = config.refresh.pollIntervalMs;
      if (interval !== undefined && (!Number.isInteger(interval) || interval < 1_000 || interval > 300_000)) {
        errors.push("refresh.pollIntervalMs must be an integer from 1000 to 300000");
      }
    }
  }
  if (config.limits !== undefined) {
    if (!isObject(config.limits)) errors.push("limits must be an object");
    else {
      validateKeys(config.limits, "limits", new Set(["maxFileBytes", "maxDiffBytes"]), errors);
      for (const key of ["maxFileBytes", "maxDiffBytes"]) {
        const value = config.limits[key];
        if (value !== undefined && (!Number.isInteger(value) || value < 1_024 || value > 64 * 1024 * 1024)) {
          errors.push(`limits.${key} must be an integer from 1024 to 67108864`);
        }
      }
    }
  }
  return errors;
}

function readConfig(filePath) {
  if (!fs.existsSync(filePath)) return { value: {}, errors: [] };
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const errors = validateConfig(value).map((error) => `${filePath}: ${error}`);
    return { value: errors.length ? {} : value, errors };
  } catch (error) {
    return { value: {}, errors: [`${filePath}: malformed JSON (${error.message})`] };
  }
}

export function loadConfig(env = process.env) {
  const homeDirectory = env.HOME || os.homedir();
  const configDirectory = env.XDG_CONFIG_HOME || path.join(homeDirectory, ".config");
  const userPath = path.join(configDirectory, "git-rail", "config.json");
  const user = readConfig(userPath);
  let config = merge(DEFAULT_CONFIG, user.value);
  const errors = [...user.errors];

  const editorVariable = env.GIT_RAIL_CLIENT !== undefined
    ? "GIT_RAIL_CLIENT"
    : !user.value.editor && env.EDITOR !== undefined ? "EDITOR" : "";
  if (editorVariable) {
    const editorText = String(env[editorVariable] ?? "").trim();
    if (!editorText) errors.push(`${editorVariable}: expected a non-empty command`);
    else {
      const [client, ...args] = editorText.split(/\s+/);
      config.editor = { ...config.editor, client, args };
    }
  }
  if (env.GIT_RAIL_CLIENT_ARGS !== undefined) {
    try {
      const args = JSON.parse(env.GIT_RAIL_CLIENT_ARGS);
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("expected an array of strings");
      config.editor.args = args;
    } catch (error) {
      errors.push(`GIT_RAIL_CLIENT_ARGS: ${error.message}`);
    }
  }
  if (env.GIT_RAIL_CLIENT_MODE !== undefined) {
    if (["auto", "terminal", "external"].includes(env.GIT_RAIL_CLIENT_MODE)) config.editor.mode = env.GIT_RAIL_CLIENT_MODE;
    else errors.push("GIT_RAIL_CLIENT_MODE: expected auto, terminal, or external");
  }
  if (env.GIT_RAIL_BASE !== undefined) {
    const baseRef = String(env.GIT_RAIL_BASE).trim();
    if (baseRef) config.baseRef = baseRef;
    else errors.push("GIT_RAIL_BASE: expected a non-empty Git reference");
  }
  if (env.GIT_RAIL_POLL_INTERVAL_MS !== undefined) {
    const text = String(env.GIT_RAIL_POLL_INTERVAL_MS).trim();
    const interval = /^\d+$/.test(text) ? Number(text) : NaN;
    if (Number.isSafeInteger(interval) && interval >= 1_000 && interval <= 300_000) config.refresh.pollIntervalMs = interval;
    else errors.push("GIT_RAIL_POLL_INTERVAL_MS: expected an integer from 1000 to 300000");
  }
  errors.push(...validateConfig(config));
  return { config, errors: [...new Set(errors)] };
}

export function resolveViewers(config, filePath) {
  const name = path.basename(filePath).toLowerCase();
  return Object.entries(config.viewers || {})
    .filter(([pattern]) => {
      const normalized = pattern.toLowerCase();
      if (pattern === "*") return true;
      return normalized.startsWith(".") ? name.endsWith(normalized) : name === normalized;
    })
    .flatMap(([pattern, value], patternOrder) => (Array.isArray(value) ? value : [value])
      .map((rule, ruleOrder) => ({ pattern, patternOrder, ruleOrder, ...rule })))
    .sort((left, right) => (left.order ?? 100) - (right.order ?? 100)
      || right.pattern.length - left.pattern.length
      || left.patternOrder - right.patternOrder
      || left.ruleOrder - right.ruleOrder)
    .map(({ patternOrder: _patternOrder, ruleOrder: _ruleOrder, ...viewer }) => viewer);
}

export function resolveViewer(config, filePath) {
  return resolveViewers(config, filePath)[0] || null;
}

export function resolveViewerActions(config, filePath) {
  const viewers = resolveViewers(config, filePath).filter((viewer) => clientMode(viewer) !== "disabled");
  const winners = new Map();
  for (const viewer of viewers) {
    if (!viewer.key || RESERVED_VIEWER_KEYS.has(viewer.key)) continue;
    const current = winners.get(viewer.key);
    if (!current || viewer.pattern.length > current.pattern.length) winners.set(viewer.key, viewer);
  }
  const used = new Set([...RESERVED_VIEWER_KEYS, ...winners.keys()]);
  return viewers.flatMap((viewer) => {
    if (viewer.key) return winners.get(viewer.key) === viewer ? [{ key: viewer.key, viewer }] : [];
    const key = LEGACY_VIEWER_KEYS.find((candidate) => !used.has(candidate));
    if (!key) return [];
    used.add(key);
    return [{ key, viewer }];
  });
}

export function launchExecutable(config, platform = process.platform) {
  if (config.client === "system") return platform === "darwin" ? "open" : "xdg-open";
  return config.client;
}

export function executableAvailable(config, env = process.env, platform = process.platform) {
  const mode = clientMode(config);
  if (mode === "disabled") return false;
  if (mode === "builtin") return true;
  const executable = launchExecutable(config, platform);
  const candidates = /[\\/]/.test(executable)
    ? [executable]
    : String(env.PATH || "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, executable));
  return candidates.some((candidate) => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; }
  });
}

export function clientMode(config) {
  if (config.client === "none") return "disabled";
  if (config.client === "builtin") return "builtin";
  if (config.client === "system") return "external";
  if (config.mode !== "auto") return config.mode;
  return new Set(["vi", "vim", "nvim", "nano", "micro", "hx", "helix", "kak", "kakoune"])
    .has(path.basename(config.client)) ? "terminal" : "external";
}
