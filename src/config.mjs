import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_VERSION = 1;
export const DEFAULT_CONFIG = Object.freeze({
  version: CONFIG_VERSION,
  editor: { client: "vim", args: [], mode: "auto" },
  viewers: {
    ".md": { client: "glow", args: ["--tui", "--style", "dark"], mode: "terminal", autoOpen: false },
    ".mdx": { client: "glow", args: ["--tui", "--style", "dark"], mode: "terminal", autoOpen: false },
    ".markdown": { client: "glow", args: ["--tui", "--style", "dark"], mode: "terminal", autoOpen: false },
  },
  refresh: { pollIntervalMs: 10_000 },
  limits: { maxFileBytes: 4 * 1024 * 1024, maxDiffBytes: 8 * 1024 * 1024 },
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function merge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    result[key] = isObject(value) && isObject(base[key]) ? merge(base[key], value) : value;
  }
  return result;
}

function validateLaunch(value, label, errors) {
  if (!isObject(value)) return errors.push(`${label} must be an object`);
  if (typeof value.client !== "string" || !value.client.trim()) errors.push(`${label}.client must be a non-empty string`);
  if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string"))) {
    errors.push(`${label}.args must be an array of strings`);
  }
  if (value.mode !== undefined && !["auto", "terminal", "external"].includes(value.mode)) {
    errors.push(`${label}.mode must be auto, terminal, or external`);
  }
  if (value.autoOpen !== undefined && typeof value.autoOpen !== "boolean") errors.push(`${label}.autoOpen must be boolean`);
}

export function validateConfig(config) {
  const errors = [];
  if (!isObject(config)) return ["configuration must be a JSON object"];
  const allowed = new Set(["$schema", "version", "baseRef", "editor", "viewers", "refresh", "limits"]);
  for (const key of Object.keys(config)) if (!allowed.has(key)) errors.push(`unknown configuration key: ${key}`);
  if (config.version !== undefined && config.version !== CONFIG_VERSION) errors.push(`version must be ${CONFIG_VERSION}`);
  if (config.baseRef !== undefined && (typeof config.baseRef !== "string" || !config.baseRef.trim())) errors.push("baseRef must be a non-empty string");
  if (config.editor !== undefined) validateLaunch(config.editor, "editor", errors);
  if (config.viewers !== undefined) {
    if (!isObject(config.viewers)) errors.push("viewers must be an object");
    else for (const [pattern, value] of Object.entries(config.viewers)) validateLaunch(value, `viewers.${pattern}`, errors);
  }
  const interval = config.refresh?.pollIntervalMs;
  if (interval !== undefined && (!Number.isInteger(interval) || interval < 1_000 || interval > 300_000)) {
    errors.push("refresh.pollIntervalMs must be an integer from 1000 to 300000");
  }
  for (const key of ["maxFileBytes", "maxDiffBytes"]) {
    const value = config.limits?.[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 1_024 || value > 64 * 1024 * 1024)) {
      errors.push(`limits.${key} must be an integer from 1024 to 67108864`);
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

export function loadConfig(repoRoot, env = process.env) {
  const userPath = path.join(os.homedir(), ".config", "git-rail", "config.json");
  const repoPath = repoRoot ? path.join(repoRoot, ".git-rail.json") : "";
  const user = readConfig(userPath);
  const project = repoPath ? readConfig(repoPath) : { value: {}, errors: [] };
  let config = merge(merge(DEFAULT_CONFIG, user.value), project.value);
  const errors = [...user.errors, ...project.errors];

  const editorText = env.GIT_RAIL_CLIENT || (!project.value.editor && !user.value.editor ? env.EDITOR : "");
  if (editorText) {
    const [client, ...args] = editorText.trim().split(/\s+/);
    config.editor = { ...config.editor, client, args };
  }
  if (env.GIT_RAIL_CLIENT_ARGS) {
    try {
      const args = JSON.parse(env.GIT_RAIL_CLIENT_ARGS);
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("expected an array of strings");
      config.editor.args = args;
    } catch (error) {
      errors.push(`GIT_RAIL_CLIENT_ARGS: ${error.message}`);
    }
  }
  if (env.GIT_RAIL_CLIENT_MODE) config.editor.mode = env.GIT_RAIL_CLIENT_MODE;
  if (env.GIT_RAIL_BASE) config.baseRef = env.GIT_RAIL_BASE;
  if (env.GIT_RAIL_POLL_INTERVAL_MS) config.refresh.pollIntervalMs = Number(env.GIT_RAIL_POLL_INTERVAL_MS);
  errors.push(...validateConfig(config));
  return { config, errors: [...new Set(errors)] };
}

export function resolveViewer(config, filePath) {
  const name = path.basename(filePath).toLocaleLowerCase();
  const pattern = Object.keys(config.viewers || {})
    .sort((a, b) => b.length - a.length)
    .find((candidate) => candidate === "*" || name === candidate.toLocaleLowerCase() || name.endsWith(candidate.toLocaleLowerCase()));
  return pattern ? { pattern, ...config.viewers[pattern] } : null;
}

export function clientMode(config) {
  if (config.client === "none") return "disabled";
  if (config.client === "builtin") return "builtin";
  if (config.client === "system") return "external";
  if (config.mode !== "auto") return config.mode;
  return new Set(["vi", "vim", "nvim", "nano", "micro", "hx", "helix", "kak", "kakoune"])
    .has(path.basename(config.client)) ? "terminal" : "external";
}
