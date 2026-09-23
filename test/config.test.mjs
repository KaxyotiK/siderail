import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clientMode, DEFAULT_CONFIG, executableAvailable, launchExecutable, loadConfig, resolveDirectMarkdownOpen, resolveViewer, resolveViewerActions, resolveViewers, validateConfig } from "../src/config.mjs";
import { hermeticEnvironment } from "./helpers/environment.mjs";

async function writeUserConfig(environment, value) {
  const directory = path.join(environment.XDG_CONFIG_HOME, "siderail");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "config.json"), JSON.stringify(value));
}

test("live pane owns the single product title", async () => {
  const manifest = await fs.readFile("herdr-plugin.toml", "utf8");
  assert.match(manifest, /title = "SIDERAIL"/);
});

test("Herdr opens SideRail for restored and newly created tabs", async () => {
  const manifest = await fs.readFile("herdr-plugin.toml", "utf8");
  assert.match(manifest, /\[\[startup\]\][\s\S]*?auto-open-herdr-tabs\.mjs/);
  assert.match(manifest, /\[\[events\]\]\s*on = "workspace\.created"[\s\S]*?auto-open-herdr-tabs\.mjs/);
  assert.match(manifest, /\[\[events\]\]\s*on = "tab\.created"[\s\S]*?auto-open-herdr-tabs\.mjs/);
  assert.match(manifest, /\[\[events\]\]\s*on = "tab\.closed"[\s\S]*?auto-open-herdr-tabs\.mjs/);
  assert.match(manifest, /\[\[events\]\]\s*on = "workspace\.closed"[\s\S]*?auto-open-herdr-tabs\.mjs/);
});

test("Herdr exposes a current-tab SideRail toggle action", async () => {
  const manifest = await fs.readFile("herdr-plugin.toml", "utf8");
  assert.match(manifest, /id = "toggle-siderail"[\s\S]*?open-herdr-panel\.sh", "git-tui", "toggle"/);
});

test("file previews open in a dedicated Herdr tab", async () => {
  const manifest = await fs.readFile("herdr-plugin.toml", "utf8");
  const rail = await fs.readFile("scripts/siderail.mjs", "utf8");
  assert.match(manifest, /id = "file-preview"[\s\S]*?placement = "tab"/);
  assert.match(rail, /resolveDirectMarkdownOpen\(state\.config, file\.path\)/);
  assert.match(rail, /openExternalFile/);
  assert.match(rail, /"--entrypoint", "file-preview", "--placement", "tab"/);
  assert.match(rail, /oldSubmodule: file\.oldSubmodule/);
  assert.match(rail, /oldSymlink: file\.oldSymlink/);
  assert.match(rail, /openOwnedPreview/);
});

test("cmux previews use native file tabs without changing the Herdr preview", async () => {
  const rail = await fs.readFile("scripts/siderail.mjs", "utf8");
  const cmuxLifecycle = await fs.readFile("src/cmux-preview-lifecycle.mjs", "utf8");
  const herdrPreview = await fs.readFile("scripts/file-preview.mjs", "utf8");
  assert.match(rail, /targetSurfaceId: cmuxMainSurfaceId/);
  assert.match(rail, /ownerSurfaceId: cmuxDockSurfaceId/);
  assert.match(cmuxLifecycle, /"open", materialized\.filePath/);
  assert.doesNotMatch(cmuxLifecycle, /"diff", "-"/);
  assert.match(cmuxLifecycle, /CMUX_SURFACE_ID: ""/);
  assert.doesNotMatch(herdrPreview, /cmux|CMUX/);
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
  assert.match(preview, /resolveViewerActions\(config, filePath\)/);
  assert.match(preview, /viewerActions\.find/);
  assert.match(preview, /if \(!executableAvailable\(viewer\)\)[\s\S]*?Glow is not installed/);
  assert.match(preview, /if \(!executableAvailable\(viewer\)\)[\s\S]*?if \(clientMode\(viewer\) === "embedded"\)/);
  assert.match(preview, /wrapAnsiTerminalLines/);
  assert.match(preview, /PgUp\/PgDn/);
  assert.doesNotMatch(preview, /Math\.max\([^)]*\.\.\.(?:content|rows)/);
  assert.match(preview, /repeat\(contentGutterColumns\)/);
  assert.match(preview, /MAX_PREVIEW_LINES = 100_000/);
  assert.ok(preview.indexOf("assertPreviewLineLimit(result.text)") < preview.indexOf("diffLines(result.text)"));
});

test("manual refresh confirmation is transient", async () => {
  const rail = await fs.readFile("scripts/siderail.mjs", "utf8");
  assert.match(rail, /showTransientStatus\("Git state refreshed"\)/);
  assert.match(rail, /showTransientStatus\(previewStatus\)/);
  assert.doesNotMatch(rail, /statusMessage = `Preview opened/);
  assert.match(rail, /statusMessage = transientRestoreStatus;[\s\S]*?draw\(\)/);
  assert.match(rail, /clearTimeout\(statusTimer\)/);
});

test("configuration validates version, launch mode, and refresh bounds", () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
  assert.deepEqual(validateConfig({ version: 1, herdr: { autoOpen: false, sidebarWidth: 34 }, editor: { client: "nvim", args: [], mode: "terminal" }, refresh: { pollIntervalMs: 5000, reconcileIntervalMs: 60_000 } }), []);
  assert.ok(validateConfig({ version: 2, editor: { client: "" }, refresh: { pollIntervalMs: 2, reconcileIntervalMs: 0 } }).length >= 4);
});

test("the shipped example is governed by runtime validation alone", async () => {
  const example = JSON.parse(await fs.readFile("siderail.config.example.json", "utf8"));
  assert.deepEqual(validateConfig(example), []);
  assert.ok(validateConfig({ ...example, $schema: "removed" }).includes("unknown configuration key: $schema"));
});

test("configuration requires a version and rejects nested unknown keys", () => {
  assert.match(validateConfig({})[0], /version must be 1/);
  assert.ok(validateConfig({ version: 1, herdr: { autoOpen: "yes", typo: true } }).includes("herdr.autoOpen must be boolean"));
  assert.ok(validateConfig({ version: 1, herdr: { autoOpen: "yes", typo: true } }).includes("unknown herdr key: typo"));
  assert.ok(validateConfig({ version: 1, herdr: { sidebarWidth: 19 } }).includes("herdr.sidebarWidth must be an integer from 20 to 200"));
  assert.ok(validateConfig({ version: 1, editor: { client: "vim", autoOpen: true } }).includes("unknown editor key: autoOpen"));
  assert.ok(validateConfig({ version: 1, viewers: { ".md": { label: "View Markdown", client: "glow", key: "3", autoOpen: false } } }).length === 0);
  assert.ok(validateConfig({ version: 1, viewers: { ".md": { client: "glow", mode: "embedded", args: ["--width", "{width}"] } } }).length === 0);
  assert.ok(validateConfig({ version: 1, viewers: { ".md": { client: "glow", typo: true } } }).includes('unknown viewers[".md"] key: typo'));
  assert.ok(validateConfig({ version: 1, viewers: { ".md": { label: "", client: "glow" } } }).includes('viewers[".md"].label must be a non-empty string'));
  assert.ok(validateConfig({ version: 1, viewers: { ".md": { client: "glow", order: 1.5 } } }).includes('viewers[".md"].order must be an integer from -10000 to 10000'));
  assert.ok(validateConfig({ version: 1, viewers: { ".md": { client: "glow", key: "q" } } }).includes('viewers[".md"].key must be one unreserved letter or digit'));
  assert.ok(validateConfig({ version: 1, viewers: { ".md": { client: "glow", key: "w" } } }).includes('viewers[".md"].key must be one unreserved letter or digit'));
  assert.deepEqual(validateConfig({ version: 1, viewers: { "*": [{ client: "system", key: "o" }, { client: "code", key: "9" }] } }), []);
  assert.ok(validateConfig({ version: 1, viewers: { "*": [] } }).includes('viewers["*"] must contain at least one viewer action'));
  assert.ok(validateConfig({ version: 1, viewers: { "": { client: "open" } } }).includes("viewer patterns must not be empty"));
  for (const pattern of ["*.md", "docs/*.md", "file?.txt", "[ab].txt", "{a,b}.txt", "."]) {
    assert.ok(validateConfig({ version: 1, viewers: { [pattern]: { client: "open" } } }).some((error) => error.includes("dot-prefixed suffix")));
  }
  assert.ok(validateConfig({ version: 1, refresh: { intervalMs: 5000 } }).includes("unknown refresh key: intervalMs"));
  assert.ok(validateConfig({ version: 1, limits: { maxFilesBytes: 4096 } }).includes("unknown limits key: maxFilesBytes"));
});

test("viewer actions resolve conditionally by selected filename", () => {
  const markdown = resolveViewer(DEFAULT_CONFIG, "docs/README.md");
  assert.equal(markdown.client, "system");
  assert.equal(markdown.label, "Open");
  assert.equal(markdown.mode, "external");
  assert.deepEqual(markdown.args, []);
  assert.equal(markdown.autoOpen, true);
  assert.deepEqual(resolveViewerActions(DEFAULT_CONFIG, "docs/README.md").map(({ key, viewer }) => [key, viewer.label]), [
    ["o", "Open"],
  ]);
  assert.deepEqual(resolveViewerActions(DEFAULT_CONFIG, "docs/README.txt").map(({ key, viewer }) => [key, viewer.label]), [
    ["o", "Open"],
  ]);

  const config = {
    viewers: {
      "*": [
        { label: "Open File", client: "system", key: "o" },
        { label: "Open in Code", client: "code", key: "9" },
      ],
      ".pdf": { label: "Open PDF", client: "system", key: "3" },
      "makefile": { label: "Build file", client: "less", key: "3" },
    },
  };
  assert.deepEqual(resolveViewers(config, "reports/summary.PDF").map(({ label }) => label), ["Open PDF", "Open File", "Open in Code"]);
  assert.deepEqual(resolveViewers(config, "Makefile").map(({ label }) => label), ["Build file", "Open File", "Open in Code"]);
  assert.deepEqual(resolveViewers(config, "NotMakefile").map(({ label }) => label), ["Open File", "Open in Code"]);
  assert.deepEqual(resolveViewers(config, "report.notpdf").map(({ label }) => label), ["Open File", "Open in Code"]);
  assert.equal(resolveViewer(config, "package.json").label, "Open File");
  assert.deepEqual(resolveViewerActions(config, "reports/summary.PDF").map(({ key, viewer }) => [key, viewer.label]), [
    ["3", "Open PDF"], ["o", "Open File"], ["9", "Open in Code"],
  ]);

  const legacy = { viewers: { "*": [
    { label: "Second", client: "system", order: 20 },
    { label: "First", client: "system", order: 10 },
  ] } };
  assert.deepEqual(resolveViewerActions(legacy, "README.txt").map(({ key, viewer }) => [key, viewer.label]), [
    ["3", "First"], ["4", "Second"],
  ]);
});

test("viewer executable preflight detects commands without invoking them", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-viewer-bin-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "test-viewer");
  await fs.writeFile(executable, "#!/bin/sh\nexit 0\n");
  await fs.chmod(executable, 0o700);

  assert.equal(executableAvailable({ client: "test-viewer", mode: "external" }, { PATH: root }), true);
  assert.equal(executableAvailable({ client: "missing-viewer", mode: "external" }, { PATH: root }), false);
  assert.equal(executableAvailable({ client: "none", mode: "auto" }, { PATH: root }), false);
  assert.equal(executableAvailable({ client: "builtin", mode: "auto" }, { PATH: "" }), true);
  assert.equal(launchExecutable({ client: "system" }, "darwin"), "open");
  assert.equal(launchExecutable({ client: "system" }, "linux"), "xdg-open");
});

test("installed Markdown rules bypass the generic preview only when system open is directly usable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-direct-markdown-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const open = path.join(root, "open");
  await fs.writeFile(open, "#!/bin/sh\nexit 0\n");
  await fs.chmod(open, 0o700);
  const environment = { PATH: root };

  assert.equal(resolveDirectMarkdownOpen(DEFAULT_CONFIG, "docs/README.md", environment, "darwin")?.viewer.client, "system");
  assert.equal(resolveDirectMarkdownOpen(DEFAULT_CONFIG, "docs/README.MDX", environment, "darwin")?.key, "o");
  assert.equal(resolveDirectMarkdownOpen(DEFAULT_CONFIG, "docs/README.txt", environment, "darwin"), null);
  assert.equal(resolveDirectMarkdownOpen(DEFAULT_CONFIG, "docs/README.md", { PATH: "" }, "darwin"), null);
  assert.equal(resolveDirectMarkdownOpen({ viewers: { ".md": { client: "system", mode: "external", autoOpen: false, key: "o" } } }, "README.md", environment, "darwin"), null);
  assert.equal(resolveDirectMarkdownOpen({ viewers: { ".md": { client: "glow", mode: "embedded", autoOpen: true, key: "3" } } }, "README.md", environment, "darwin"), null);
});

test("configuration rejects mistyped structured values", () => {
  for (const [key, value] of [["herdr", []], ["editor", []], ["viewers", []], ["refresh", "fast"], ["limits", null]]) {
    assert.ok(validateConfig({ version: 1, [key]: value }).includes(`${key} must be an object`));
  }
});

test("user configuration merges by key and environment wins", async (t) => {
  const { environment } = hermeticEnvironment(t, { SIDERAIL_BASE: "upstream/trunk", SIDERAIL_CLIENT: "nvim" });
  await writeUserConfig(environment, { version: 1, editor: { client: "hx", mode: "terminal" }, refresh: { pollIntervalMs: 7000 } });
  const { config, errors } = loadConfig(environment);
  assert.deepEqual(errors, []);
  assert.equal(config.baseRef, "upstream/trunk");
  assert.equal(config.editor.client, "nvim");
  assert.equal(config.editor.mode, "terminal");
  assert.equal(config.refresh.pollIntervalMs, 7000);
});

test("an explicit Glow TUI rule is preserved", async (t) => {
  const { environment } = hermeticEnvironment(t);
  await writeUserConfig(environment, {
    version: 1,
    viewers: {
      ".md": { label: "View Markdown", client: "glow", args: ["--tui", "--style", "dark"], mode: "terminal", key: "3", autoOpen: true },
      ".txt": { label: "Custom Glow", client: "glow", args: ["--tui"], mode: "terminal", key: "4", autoOpen: false },
    },
  });
  const { config, errors } = loadConfig(environment);
  assert.deepEqual(errors, []);
  assert.deepEqual(config.viewers[".md"], {
    label: "View Markdown",
    client: "glow",
    args: ["--tui", "--style", "dark"],
    mode: "terminal",
    key: "3",
    autoOpen: true,
  });
  assert.equal(config.viewers[".txt"].mode, "terminal");
  assert.deepEqual(config.viewers[".txt"].args, ["--tui"]);
});

test("environment overrides do not mutate built-in defaults", (t) => {
  const { environment } = hermeticEnvironment(t);
  const before = JSON.stringify(DEFAULT_CONFIG);
  const first = loadConfig({ ...environment, SIDERAIL_CLIENT_ARGS: '["-f"]', SIDERAIL_POLL_INTERVAL_MS: "2000", SIDERAIL_RECONCILE_INTERVAL_MS: "60000" });
  const second = loadConfig(environment);
  assert.deepEqual(first.errors, []);
  assert.equal(JSON.stringify(DEFAULT_CONFIG), before);
  assert.deepEqual(second.config.editor.args, []);
  assert.equal(second.config.refresh.pollIntervalMs, 10_000);
  assert.equal(first.config.refresh.reconcileIntervalMs, 60_000);
  assert.equal(second.config.refresh.reconcileIntervalMs, 300_000);
});

test("editor integration is optional and EDITOR remains a fallback", (t) => {
  const { environment } = hermeticEnvironment(t);
  const disabled = loadConfig(environment);
  assert.deepEqual(disabled.errors, []);
  assert.equal(clientMode(disabled.config.editor), "disabled");
  const fallback = loadConfig({ ...environment, EDITOR: "hx --tutor" });
  assert.deepEqual(fallback.errors, []);
  assert.equal(fallback.config.editor.client, "hx");
  assert.deepEqual(fallback.config.editor.args, ["--tutor"]);
  assert.equal(clientMode(fallback.config.editor), "terminal");
});

test("invalid environment overrides report errors without replacing valid defaults", (t) => {
  const { environment } = hermeticEnvironment(t);
  const { config, errors } = loadConfig({ ...environment,
    SIDERAIL_BASE: "   ",
    SIDERAIL_CLIENT: "   ",
    SIDERAIL_CLIENT_ARGS: "not-json",
    SIDERAIL_CLIENT_MODE: "embedded",
    SIDERAIL_POLL_INTERVAL_MS: "NaN",
    SIDERAIL_RECONCILE_INTERVAL_MS: "0",
  });
  assert.equal(config.baseRef, undefined);
  assert.deepEqual(config.editor, DEFAULT_CONFIG.editor);
  assert.equal(config.refresh.pollIntervalMs, DEFAULT_CONFIG.refresh.pollIntervalMs);
  assert.equal(config.refresh.reconcileIntervalMs, DEFAULT_CONFIG.refresh.reconcileIntervalMs);
  for (const variable of ["SIDERAIL_BASE", "SIDERAIL_CLIENT", "SIDERAIL_CLIENT_ARGS", "SIDERAIL_CLIENT_MODE", "SIDERAIL_POLL_INTERVAL_MS", "SIDERAIL_RECONCILE_INTERVAL_MS"]) {
    assert.ok(errors.some((error) => error.startsWith(`${variable}:`)), `${variable} should report its invalid value`);
  }
});

test("out-of-range polling overrides preserve a user interval", async (t) => {
  const { environment } = hermeticEnvironment(t, { SIDERAIL_POLL_INTERVAL_MS: "999" });
  await writeUserConfig(environment, { version: 1, refresh: { pollIntervalMs: 7000 } });
  const { config, errors } = loadConfig(environment);
  assert.equal(config.refresh.pollIntervalMs, 7000);
  assert.ok(errors.some((error) => error.startsWith("SIDERAIL_POLL_INTERVAL_MS:")));
});
