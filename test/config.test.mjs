import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clientMode, DEFAULT_CONFIG, loadConfig, resolveViewer, resolveViewers, validateConfig } from "../src/config.mjs";

test("live pane owns the single product title", async () => {
  const manifest = await fs.readFile("herdr-plugin.toml", "utf8");
  assert.match(manifest, /title = "HERDER GITRAIL"/);
});

test("file previews open in a dedicated Herdr tab", async () => {
  const manifest = await fs.readFile("herdr-plugin.toml", "utf8");
  const rail = await fs.readFile("scripts/git-rail.mjs", "utf8");
  assert.match(manifest, /id = "file-preview"[\s\S]*?placement = "tab"/);
  assert.match(rail, /"--entrypoint", "file-preview", "--placement", "tab"/);
  assert.match(rail, /oldSubmodule: file\.oldSubmodule/);
  assert.match(rail, /oldSymlink: file\.oldSymlink/);
  assert.match(rail, /createLatestSerialQueue\(openPreview\)/);
  assert.match(rail, /if \(paneId && stalePaneId/);
});

test("preview scrolling repaints in place without clearing the screen", async () => {
  const preview = await fs.readFile("scripts/file-preview.mjs", "utf8");
  assert.equal(preview.includes("${ESC}2J"), false);
  assert.equal(preview.includes("${ESC}?2026h"), true);
  assert.match(preview, /fs\.chmodSync\(copy, 0o400\)/);
  assert.match(preview, /Opening read-only temporary revision copy/);
  assert.match(preview, /editorMode !== "disabled"/);
  assert.match(preview, /Editor is not configured/);
  assert.equal(preview.includes("markdownEligible"), false);
  assert.match(preview, /resolveViewers\(config, filePath\)/);
  assert.match(preview, /viewerActions\.find/);
});

test("manual refresh confirmation is transient", async () => {
  const rail = await fs.readFile("scripts/git-rail.mjs", "utf8");
  assert.match(rail, /showTransientStatus\("Git state refreshed"\)/);
  assert.match(rail, /statusMessage = transientRestoreStatus;[\s\S]*?draw\(\)/);
  assert.match(rail, /clearTimeout\(statusTimer\)/);
});

test("configuration validates version, launch mode, and refresh bounds", () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
  assert.deepEqual(validateConfig({ version: 1, editor: { client: "nvim", args: [], mode: "terminal" }, refresh: { pollIntervalMs: 5000 } }), []);
  assert.ok(validateConfig({ version: 2, editor: { client: "" }, refresh: { pollIntervalMs: 2 } }).length >= 3);
});

test("published schema exposes labels only on viewer rules", async () => {
  const schema = JSON.parse(await fs.readFile("schema/v1/git-rail.schema.json", "utf8"));
  assert.equal(schema.$defs.launch.properties.label, undefined);
  assert.deepEqual(schema.$defs.viewer.properties.label, { type: "string", pattern: "\\S" });
  assert.deepEqual(schema.$defs.viewer.properties.order, { type: "integer", minimum: -10000, maximum: 10000 });
});

test("configuration requires a version and rejects nested unknown keys", () => {
  assert.match(validateConfig({})[0], /version must be 1/);
  assert.ok(validateConfig({ version: 1, editor: { client: "vim", autoOpen: true } }).includes("unknown editor key: autoOpen"));
  assert.ok(validateConfig({ version: 1, viewers: { ".md": { label: "View Markdown", client: "glow", order: 10, autoOpen: false } } }).length === 0);
  assert.ok(validateConfig({ version: 1, viewers: { ".md": { client: "glow", typo: true } } }).includes('unknown viewers[".md"] key: typo'));
  assert.ok(validateConfig({ version: 1, viewers: { ".md": { label: "", client: "glow" } } }).includes('viewers[".md"].label must be a non-empty string'));
  assert.ok(validateConfig({ version: 1, viewers: { ".md": { client: "glow", order: 1.5 } } }).includes('viewers[".md"].order must be an integer from -10000 to 10000'));
  assert.ok(validateConfig({ version: 1, refresh: { intervalMs: 5000 } }).includes("unknown refresh key: intervalMs"));
  assert.ok(validateConfig({ version: 1, limits: { maxFilesBytes: 4096 } }).includes("unknown limits key: maxFilesBytes"));
});

test("viewer actions resolve conditionally by selected filename", () => {
  const markdown = resolveViewer(DEFAULT_CONFIG, "docs/README.md");
  assert.equal(markdown.client, "glow");
  assert.equal(markdown.label, "View Markdown");
  assert.equal(resolveViewer(DEFAULT_CONFIG, "docs/README.txt"), null);

  const config = {
    viewers: {
      "*": { label: "Open File", client: "system", order: 200 },
      ".pdf": { label: "Open PDF", client: "system", order: 100 },
      "makefile": { label: "Build file", client: "less" },
    },
  };
  assert.deepEqual(resolveViewers(config, "reports/summary.PDF").map(({ label }) => label), ["Open PDF", "Open File"]);
  assert.deepEqual(resolveViewers(config, "Makefile").map(({ label }) => label), ["Build file", "Open File"]);
  assert.equal(resolveViewer(config, "package.json").label, "Open File");
});

test("configuration rejects mistyped structured values", () => {
  for (const [key, value] of [["editor", []], ["viewers", []], ["refresh", "fast"], ["limits", null]]) {
    assert.ok(validateConfig({ version: 1, [key]: value }).includes(`${key} must be an object`));
  }
});

test("project configuration without a version is rejected instead of merged", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-config-version-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, ".git-rail.json"), JSON.stringify({ editor: { client: "hx" } }));
  const { config, errors } = loadConfig(root, {});
  assert.ok(errors.some((error) => error.includes("version must be 1")));
  assert.equal(config.editor.client, "none");
});

test("repository config merges by key and environment wins", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, ".git-rail.json"), JSON.stringify({ version: 1, editor: { client: "hx", mode: "terminal" }, refresh: { pollIntervalMs: 7000 } }));
  const { config, errors } = loadConfig(root, { GIT_RAIL_BASE: "upstream/trunk", GIT_RAIL_CLIENT: "nvim" });
  assert.deepEqual(errors, []);
  assert.equal(config.baseRef, "upstream/trunk");
  assert.equal(config.editor.client, "nvim");
  assert.equal(config.editor.mode, "terminal");
  assert.equal(config.refresh.pollIntervalMs, 7000);
});

test("environment overrides do not mutate built-in defaults", () => {
  const before = JSON.stringify(DEFAULT_CONFIG);
  const first = loadConfig("", { GIT_RAIL_CLIENT_ARGS: '["-f"]', GIT_RAIL_POLL_INTERVAL_MS: "2000" });
  const second = loadConfig("", {});
  assert.deepEqual(first.errors, []);
  assert.equal(JSON.stringify(DEFAULT_CONFIG), before);
  assert.deepEqual(second.config.editor.args, []);
  assert.equal(second.config.refresh.pollIntervalMs, 10_000);
});

test("editor integration is optional and EDITOR remains a fallback", () => {
  const disabled = loadConfig("", {});
  assert.deepEqual(disabled.errors, []);
  assert.equal(clientMode(disabled.config.editor), "disabled");
  const fallback = loadConfig("", { EDITOR: "hx --tutor" });
  assert.deepEqual(fallback.errors, []);
  assert.equal(fallback.config.editor.client, "hx");
  assert.deepEqual(fallback.config.editor.args, ["--tutor"]);
  assert.equal(clientMode(fallback.config.editor), "terminal");
});

test("invalid environment overrides report errors without replacing valid defaults", () => {
  const { config, errors } = loadConfig("", {
    GIT_RAIL_BASE: "   ",
    GIT_RAIL_CLIENT: "   ",
    GIT_RAIL_CLIENT_ARGS: "not-json",
    GIT_RAIL_CLIENT_MODE: "embedded",
    GIT_RAIL_POLL_INTERVAL_MS: "NaN",
  });
  assert.equal(config.baseRef, undefined);
  assert.deepEqual(config.editor, DEFAULT_CONFIG.editor);
  assert.equal(config.refresh.pollIntervalMs, DEFAULT_CONFIG.refresh.pollIntervalMs);
  for (const variable of ["GIT_RAIL_BASE", "GIT_RAIL_CLIENT", "GIT_RAIL_CLIENT_ARGS", "GIT_RAIL_CLIENT_MODE", "GIT_RAIL_POLL_INTERVAL_MS"]) {
    assert.ok(errors.some((error) => error.startsWith(`${variable}:`)), `${variable} should report its invalid value`);
  }
});

test("out-of-range polling overrides preserve a project interval", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-config-poll-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, ".git-rail.json"), JSON.stringify({ version: 1, refresh: { pollIntervalMs: 7000 } }));
  const { config, errors } = loadConfig(root, { GIT_RAIL_POLL_INTERVAL_MS: "999" });
  assert.equal(config.refresh.pollIntervalMs, 7000);
  assert.ok(errors.some((error) => error.startsWith("GIT_RAIL_POLL_INTERVAL_MS:")));
});
