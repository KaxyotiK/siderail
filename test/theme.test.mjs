import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_PALETTE,
  buildPalette,
  herdrConfigPath,
  parseColorValue,
  parseHerdrThemeTokens,
  resolvePalette,
} from "../src/theme.mjs";
import { hermeticEnvironment } from "./helpers/environment.mjs";

const HERDR_CONFIG = [
  "onboarding = false",
  "",
  "[theme]",
  "# name = \"catppuccin\"",
  "name = \"tokyo-night\"",
  "",
  "[theme.custom]",
  "selection_bg = \"#313244\"  # trailing comment",
  "accent = \"#f5c2e7\"",
  "red = \"rgb(255, 102, 136)\"",
  "green = \"bright-green\"",
  "panel_bg = \"reset\"",
  "",
  "[ui]",
  "accent = \"cyan\"",
  "",
  "[ui.sidebar.spaces]",
  "row_gap = 0",
  "rows = [[\"state_icon\", \"workspace\"], [\"$grove_summary\"]]",
  "",
].join("\n");

test("the fallback palette is indexed so it inherits the terminal theme", () => {
  // Herdr re-emits pane colors verbatim, so indexed values resolve against the
  // user's own terminal palette and stay readable under a light theme.
  for (const [token, value] of Object.entries(DEFAULT_PALETTE)) {
    assert.doesNotMatch(value, /38;2;|48;2;/, `${token} pins a 24-bit color`);
  }
  assert.equal(DEFAULT_PALETTE.selected, "\u001b[48;5;8m");
  assert.equal(DEFAULT_PALETTE.gold, "\u001b[38;5;3m");
});

test("color values accept every documented Herdr spelling", () => {
  assert.equal(parseColorValue("#f5c2e7"), "\u001b[38;2;245;194;231m");
  assert.equal(parseColorValue("#ABC"), "\u001b[38;2;170;187;204m");
  assert.equal(parseColorValue("rgb(12, 34, 56)"), "\u001b[38;2;12;34;56m");
  assert.equal(parseColorValue("cyan"), "\u001b[38;5;6m");
  assert.equal(parseColorValue("bright-yellow"), "\u001b[38;5;11m");
  assert.equal(parseColorValue("#313244", { background: true }), "\u001b[48;2;49;50;68m");
  assert.equal(parseColorValue("magenta", { background: true }), "\u001b[48;5;5m");
  for (const rejected of ["", "reset", "#12345", "rgb(300,0,0)", "chartreuse", "#f5c2e7; rm -rf /", null]) {
    assert.equal(parseColorValue(rejected), "", `accepted ${JSON.stringify(rejected)}`);
  }
});

test("token reading keeps hash colors and ignores unrelated sections", () => {
  const tokens = parseHerdrThemeTokens(HERDR_CONFIG);
  assert.deepEqual(tokens, {
    accent: "#f5c2e7",
    red: "rgb(255, 102, 136)",
    green: "bright-green",
    selectionBg: "#313244",
  });
  // Commented defaults, array rows, and a [ui.toast] accent must not leak in.
  assert.deepEqual(parseHerdrThemeTokens([
    "[theme.custom]",
    "# accent = \"#ffffff\"",
    "[ui.toast]",
    "accent = \"#000000\"",
  ].join("\n")), { accent: "", red: "", green: "", selectionBg: "" });
  assert.deepEqual(parseHerdrThemeTokens(""), { accent: "", red: "", green: "", selectionBg: "" });
});

test("scalar reading handles bare, escaped, and unterminated values", () => {
  const accentOf = (line) => parseHerdrThemeTokens(`[theme.custom]\n${line}`).accent;
  assert.equal(accentOf("accent = cyan"), "cyan");
  assert.equal(accentOf("accent = cyan # inline comment"), "cyan");
  assert.equal(accentOf("accent = 'bright-red'"), "bright-red");
  assert.equal(accentOf("accent = \"cy\\\"an\""), "cy\"an");
  assert.equal(accentOf("accent = \"unterminated"), "");
});

test("[ui] accent applies only when [theme.custom] omits one", () => {
  assert.equal(parseHerdrThemeTokens("[ui]\naccent = \"cyan\"").accent, "cyan");
  assert.equal(parseHerdrThemeTokens(HERDR_CONFIG).accent, "#f5c2e7");
});

test("only the four documented tokens override the fallback palette", () => {
  const palette = buildPalette(parseHerdrThemeTokens(HERDR_CONFIG));
  assert.equal(palette.gold, "\u001b[38;2;245;194;231m");
  assert.equal(palette.red, "\u001b[38;2;255;102;136m");
  assert.equal(palette.leaf, "\u001b[38;5;10m");
  assert.equal(palette.selected, "\u001b[48;2;49;50;68m");
  for (const untouched of ["reset", "bold", "dim", "amber", "blue", "purple", "fog", "faint"]) {
    assert.equal(palette[untouched], DEFAULT_PALETTE[untouched], `${untouched} changed`);
  }
  assert.deepEqual(buildPalette(), { ...DEFAULT_PALETTE });
});

test("the config path honours HERDR_CONFIG_PATH ahead of XDG and HOME", () => {
  assert.equal(herdrConfigPath({ HERDR_CONFIG_PATH: "/tmp/explicit.toml" }), "/tmp/explicit.toml");
  assert.equal(herdrConfigPath({ XDG_CONFIG_HOME: "/xdg" }), path.join("/xdg", "herdr", "config.toml"));
  assert.equal(herdrConfigPath({ HOME: "/home/u" }), path.join("/home/u", ".config", "herdr", "config.toml"));
});

test("a missing, unreadable, or cmux-hosted config leaves the fallback palette", (t) => {
  const { environment } = hermeticEnvironment(t);
  assert.deepEqual(resolvePalette(environment), { ...DEFAULT_PALETTE });

  const configured = path.join(environment.XDG_CONFIG_HOME, "herdr");
  fs.mkdirSync(configured, { recursive: true });
  fs.writeFileSync(path.join(configured, "config.toml"), HERDR_CONFIG);
  assert.equal(resolvePalette(environment).gold, "\u001b[38;2;245;194;231m");

  // cmux supplies its own chrome, so a Herdr theme must not follow the rail there.
  assert.deepEqual(resolvePalette(environment, { host: "cmux" }), { ...DEFAULT_PALETTE });
  assert.deepEqual(
    resolvePalette(environment, { readFile: () => { throw new Error("EACCES"); } }),
    { ...DEFAULT_PALETTE },
  );
});
