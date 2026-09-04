import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ESC = "\u001b[";
const THEME_SECTION = "theme.custom";
const UI_SECTION = "ui";
const MAX_CONFIG_LINES = 2_000;

// Herdr renders every pane through its own emulator but re-emits pane colors
// verbatim, so indexed defaults inherit the terminal theme and stay legible in
// light mode. Only the tokens Herdr documents as user-facing override them.
const ANSI_COLOR_INDEX = new Map(Object.entries({
  black: 0, red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, white: 7,
  purple: 5, gray: 8, grey: 8,
  "bright-black": 8, "bright-red": 9, "bright-green": 10, "bright-yellow": 11,
  "bright-blue": 12, "bright-magenta": 13, "bright-cyan": 14, "bright-white": 15,
}));

export const DEFAULT_PALETTE = Object.freeze({
  reset: `${ESC}0m`, bold: `${ESC}1m`, dim: `${ESC}2m`,
  gold: `${ESC}38;5;3m`, amber: `${ESC}38;5;11m`, leaf: `${ESC}38;5;2m`,
  red: `${ESC}38;5;1m`, blue: `${ESC}38;5;4m`, purple: `${ESC}38;5;5m`,
  fog: `${ESC}38;5;7m`, faint: `${ESC}38;5;8m`, selected: `${ESC}48;5;8m`,
});

export function parseColorValue(value, { background = false } = {}) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text || text === "reset") return "";
  const layer = background ? 48 : 38;
  const named = ANSI_COLOR_INDEX.get(text);
  if (named !== undefined) return `${ESC}${layer};5;${named}m`;
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => `${digit}${digit}`).join("") : hex[1];
    const channels = [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16));
    return `${ESC}${layer};2;${channels.join(";")}m`;
  }
  const rgb = text.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/);
  if (rgb) {
    const channels = rgb.slice(1, 4).map(Number);
    if (channels.every((channel) => channel <= 255)) return `${ESC}${layer};2;${channels.join(";")}m`;
  }
  return "";
}

// A four-token reader, not a TOML implementation. Quoted values are read before
// comment stripping so a "#rrggbb" color survives, and any line that is not a
// bare section header or scalar assignment is skipped rather than guessed at.
function readScalar(raw) {
  const text = raw.trim();
  if (text.startsWith("\"") || text.startsWith("'")) {
    const quote = text[0];
    let value = "";
    for (let index = 1; index < text.length; index += 1) {
      const character = text[index];
      if (character === "\\" && quote === "\"" && index + 1 < text.length) {
        index += 1;
        value += text[index];
        continue;
      }
      if (character === quote) return value;
      value += character;
    }
    return "";
  }
  return text.split("#")[0].trim();
}

export function parseHerdrThemeTokens(source) {
  const custom = {};
  let uiAccent = "";
  let section = "";
  const lines = String(source ?? "").split("\n").slice(0, MAX_CONFIG_LINES);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[([^[\]]+)\]$/);
    if (header) { section = header[1].trim(); continue; }
    if (section !== THEME_SECTION && section !== UI_SECTION) continue;
    const entry = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/);
    if (!entry) continue;
    const value = readScalar(entry[2]);
    if (!value) continue;
    if (section === UI_SECTION) {
      if (entry[1] === "accent") uiAccent = value;
      continue;
    }
    custom[entry[1]] = value;
  }
  return {
    accent: custom.accent || uiAccent,
    red: custom.red || "",
    green: custom.green || "",
    selectionBg: custom.selection_bg || "",
  };
}

export function herdrConfigPath(environment = process.env) {
  if (environment.HERDR_CONFIG_PATH) return environment.HERDR_CONFIG_PATH;
  const base = environment.XDG_CONFIG_HOME || path.join(environment.HOME || os.homedir(), ".config");
  return path.join(base, "herdr", "config.toml");
}

export function buildPalette(tokens = {}) {
  const accent = parseColorValue(tokens.accent);
  const red = parseColorValue(tokens.red);
  const leaf = parseColorValue(tokens.green);
  const selected = parseColorValue(tokens.selectionBg, { background: true });
  return {
    ...DEFAULT_PALETTE,
    ...(accent ? { gold: accent } : {}),
    ...(red ? { red } : {}),
    ...(leaf ? { leaf } : {}),
    ...(selected ? { selected } : {}),
  };
}

export function resolvePalette(environment = process.env, { host = "herdr", readFile = fs.readFileSync } = {}) {
  if (host !== "herdr") return { ...DEFAULT_PALETTE };
  try {
    return buildPalette(parseHerdrThemeTokens(readFile(herdrConfigPath(environment), "utf8")));
  } catch {
    return { ...DEFAULT_PALETTE };
  }
}
