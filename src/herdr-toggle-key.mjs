import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PLUGIN_ID, herdrExecutable } from "./host-setup.mjs";
import { runCommand } from "./process.mjs";

export const TOGGLE_ACTION = `${PLUGIN_ID}.toggle-siderail`;
export const DEFAULT_TOGGLE_KEY = "ctrl+shift+g";
const TOGGLE_BINDING = [
  "# Added by `siderail setup`; `siderail uninstall` removes it.",
  "[[keys.command]]",
  `key = "${DEFAULT_TOGGLE_KEY}"`,
  "type = \"plugin_action\"",
  `command = "${TOGGLE_ACTION}"`,
  "description = \"toggle SideRail sidebar\"",
  "",
].join("\n");
const TOGGLE_BINDING_LINES = TOGGLE_BINDING.split("\n").length - 1;

// Herdr reads HERDR_CONFIG_PATH, then $XDG_CONFIG_HOME/herdr/config.toml, then ~/.config.
export function herdrConfigPath(environment = process.env) {
  if (environment.HERDR_CONFIG_PATH) return environment.HERDR_CONFIG_PATH;
  const base = environment.XDG_CONFIG_HOME
    || (environment.HOME ? path.join(environment.HOME, ".config") : "");
  if (!base) throw new Error("HOME is not set; cannot locate Herdr's config.toml");
  return path.join(base, "herdr", "config.toml");
}

/**
 * A conservative lexical pass over TOML. For each line it records whether the
 * line starts outside every multiline string, and the line's code with string
 * contents and comments removed. It returns null for text it cannot classify,
 * such as an unterminated string, so callers leave such a file alone.
 */
function scanToml(text) {
  const scanned = [];
  let open = null;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const topLevel = open === null;
    let code = "";
    let index = 0;
    while (index < line.length) {
      if (open) {
        if (open === "\"\"\"" && line[index] === "\\") {
          index += 2;
        } else if (line[index] === open[0]) {
          let run = 0;
          while (line[index + run] === open[0]) run += 1;
          if (run > 5) return null;
          if (run >= 3) {
            open = null;
            code += "S";
          }
          index += run;
        } else {
          index += 1;
        }
        continue;
      }
      const character = line[index];
      if (character === "#") break;
      if (line.startsWith("\"\"\"", index) || line.startsWith("'''", index)) {
        open = line.slice(index, index + 3);
        index += 3;
      } else if (character === "\"" || character === "'") {
        let end = index + 1;
        while (end < line.length && line[end] !== character) end += character === "\"" && line[end] === "\\" ? 2 : 1;
        if (end >= line.length) return null;
        code += "S";
        index = end + 1;
      } else {
        code += character;
        index += 1;
      }
    }
    scanned.push({ line, topLevel, code: code.trim() });
  }
  return open === null ? scanned : null;
}

function tableHeader(code) {
  const match = /^(\[\[?)([^[\]]*)(\]\]?)$/.exec(code);
  if (!match || match[1].length !== match[3].length) return null;
  return { name: match[2].replace(/\s+/g, ""), array: match[1] === "[[" };
}

const STRING_ASSIGNMENT = /^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/;

// What the config already says about the toggle action, or null when the
// lexical pass cannot classify the file.
function analyzeConfig(text) {
  const scanned = scanToml(text);
  if (!scanned) return null;
  const bindings = [];
  let table = "";
  let entry = null;
  let inlineArray = false;
  scanned.forEach(({ line, topLevel, code }, index) => {
    if (!topLevel) return;
    const header = tableHeader(code);
    if (header) {
      table = header.name;
      entry = header.array && header.name === "keys.command" ? { fields: {}, commandLine: -1 } : null;
      if (entry) bindings.push(entry);
      return;
    }
    if ((table === "" && /^keys\s*\.\s*command\s*=/.test(code)) || (table === "keys" && /^command\s*=/.test(code))) {
      inlineArray = true;
    }
    const assignment = entry && STRING_ASSIGNMENT.exec(line);
    if (assignment) {
      entry.fields[assignment[1]] = assignment[2] ?? assignment[3];
      if (assignment[1] === "command") entry.commandLine = index;
    }
  });
  const bound = bindings.filter((binding) => binding.fields.type === "plugin_action" && binding.fields.command === TOGGLE_ACTION);
  const explained = new Set(bound.map((binding) => binding.commandLine));
  const mentioned = scanned.some(({ line }, index) => line.includes(TOGGLE_ACTION) && !explained.has(index));
  return { bound: bound.length > 0, ambiguous: mentioned, inlineArray };
}

// The byte range of the entry setup wrote, only when it is a genuine top-level
// table that nothing has been added to: after it come only blank lines and
// comments until the next table header or the end of the file.
function ownedBindingRange(text, scanned) {
  for (let start = text.indexOf(TOGGLE_BINDING); start >= 0; start = text.indexOf(TOGGLE_BINDING, start + 1)) {
    if (start > 0 && text[start - 1] !== "\n") continue;
    const first = text.slice(0, start).split("\n").length - 1;
    if (!scanned[first]?.topLevel) continue;
    let owned = true;
    for (let index = first + TOGGLE_BINDING_LINES; index < scanned.length; index += 1) {
      const { topLevel, code } = scanned[index];
      if (!topLevel) { owned = false; break; }
      if (!code) continue;
      if (!tableHeader(code)) owned = false;
      break;
    }
    if (owned) return { start, end: start + TOGGLE_BINDING.length };
  }
  return null;
}

function resolveTarget(configPath) {
  const absolute = path.resolve(configPath);
  let link;
  try {
    link = fs.lstatSync(absolute);
  } catch (error) {
    if (error.code === "ENOENT") return { realPath: absolute };
    throw error;
  }
  if (!link.isSymbolicLink()) return { realPath: absolute };
  try {
    return { realPath: fs.realpathSync(absolute) };
  } catch (error) {
    if (error.code === "ENOENT") return { realPath: null };
    throw error;
  }
}

function snapshot(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false };
    throw error;
  }
  if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
  return { exists: true, dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777, bytes: fs.readFileSync(file) };
}

function sameSnapshot(before, after) {
  if (before.exists !== after.exists) return false;
  return !before.exists || (before.dev === after.dev && before.ino === after.ino && before.bytes.equals(after.bytes));
}

function createTemporary(directory, name, text, mode) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `.${name}.siderail-${crypto.randomBytes(8).toString("hex")}.tmp`);
  const descriptor = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeSync(descriptor, text);
    fs.fchmodSync(descriptor, mode);
  } catch (error) {
    fs.closeSync(descriptor);
    fs.rmSync(file, { force: true });
    throw error;
  }
  fs.closeSync(descriptor);
  return file;
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
    await run(herdrExecutable(environment), ["server", "reload-config"], {
      env: environment,
      timeoutMs: 8_000,
      maxOutputBytes: 1_024 * 1_024,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates `text` as a candidate config with `herdr config check`, then
 * replaces the config only if it is still the file `before` describes. The
 * candidate is checked beside the configured path, so it resolves anything
 * relative the way that path does, and committed beside the real file, so a
 * symbolic link keeps pointing at it. A final race with another editor remains
 * possible; the comparison detects edits made while Herdr checked the candidate.
 */
async function replaceValidated({ environment, run, configPath, realPath, before, text }) {
  const mode = before.exists ? before.mode : 0o644;
  const name = path.basename(realPath);
  const checkFile = createTemporary(path.dirname(path.resolve(configPath)), name, text, mode);
  let commitFile = null;
  try {
    let check;
    try {
      check = await checkHerdrConfig({ environment, run, configPath: checkFile });
    } catch (error) {
      return { action: "check-failed", issues: [error.message] };
    }
    if (!check.ok) return { action: "rejected", issues: check.issues };
    const directory = path.dirname(realPath);
    commitFile = directory === path.dirname(checkFile) ? checkFile : createTemporary(directory, name, text, mode);
    if (resolveTarget(configPath).realPath !== realPath || !sameSnapshot(before, snapshot(realPath))) {
      return { action: "changed" };
    }
    fs.renameSync(commitFile, realPath);
    commitFile = null;
    return { action: "replaced" };
  } finally {
    fs.rmSync(checkFile, { force: true });
    if (commitFile) fs.rmSync(commitFile, { force: true });
  }
}

// Herdr plugins cannot declare key bindings, so setup adds a default one to
// Herdr's config.toml. It never replaces a binding the user chose, and it
// leaves alone any file Herdr would reject or it cannot classify.
export async function bindHerdrToggleKey({ environment = process.env, run = runCommand, configPath = herdrConfigPath(environment) } = {}) {
  const { realPath } = resolveTarget(configPath);
  if (!realPath) return { action: "dangling-link", configPath };
  const before = snapshot(realPath);
  const original = before.exists ? before.bytes.toString("utf8") : "";
  if (before.exists) {
    const analysis = analyzeConfig(original);
    if (!analysis) return { action: "unreadable", configPath };
    if (analysis.bound) return { action: "unchanged", configPath };
    if (analysis.ambiguous) return { action: "ambiguous", configPath };
    if (analysis.inlineArray) return { action: "inline-array", configPath };
    let check;
    try {
      check = await checkHerdrConfig({ environment, run, configPath });
    } catch (error) {
      return { action: "check-failed", configPath, issues: [error.message] };
    }
    if (!check.ok) return { action: "config-invalid", configPath, issues: check.issues };
  }
  const separator = !original || original.endsWith("\n\n") ? "" : original.endsWith("\n") ? "\n" : "\n\n";
  const outcome = await replaceValidated({ environment, run, configPath, realPath, before, text: `${original}${separator}${TOGGLE_BINDING}` });
  if (outcome.action !== "replaced") return { ...outcome, configPath };
  return { action: "bound", configPath, reloaded: await reloadHerdrConfig({ environment, run }) };
}

// Removes only an unedited entry that setup wrote; anything else is the user's.
export async function unbindHerdrToggleKey({ environment = process.env, run = runCommand, configPath = herdrConfigPath(environment) } = {}) {
  const { realPath } = resolveTarget(configPath);
  if (!realPath) return { action: "dangling-link", configPath };
  const before = snapshot(realPath);
  if (!before.exists) return { action: "absent", configPath };
  const text = before.bytes.toString("utf8");
  const scanned = scanToml(text);
  const owned = scanned && ownedBindingRange(text, scanned);
  if (!owned) return { action: text.includes(TOGGLE_ACTION) ? "kept" : "absent", configPath };
  const next = `${text.slice(0, owned.start).replace(/\n\n$/, "\n")}${text.slice(owned.end)}`;
  const outcome = await replaceValidated({ environment, run, configPath, realPath, before, text: next });
  if (outcome.action !== "replaced") return { ...outcome, configPath };
  return { action: "removed", configPath, reloaded: await reloadHerdrConfig({ environment, run }) };
}
