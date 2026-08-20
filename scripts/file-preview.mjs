#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ESC = "\u001b[";
const C = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  gold: `${ESC}38;2;214;176;91m`,
  green: `${ESC}38;2;91;190;112m`,
  red: `${ESC}38;2;224;108;117m`,
  blue: `${ESC}38;2;105;169;230m`,
  faint: `${ESC}38;2;84;84;84m`,
  selected: `${ESC}48;2;45;41;34m`,
};
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;
const previewPath = process.env.GIT_RAIL_PREVIEW_PATH || "";
const requestedMode = process.env.GIT_RAIL_PREVIEW_MODE === "file" ? "raw" : "diff";
const repoRoot = process.env.GIT_RAIL_PREVIEW_REPO || process.cwd();
const demoMode = process.env.GIT_RAIL_PREVIEW_DEMO === "1";
const previewCommit = process.env.GIT_RAIL_PREVIEW_COMMIT || "";
const previewStatus = process.env.GIT_RAIL_PREVIEW_STATUS || "modified";
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const markdownEligible = /\.(md|mdx|markdown)$/i.test(previewPath);
const clientConfig = resolveClientConfig();
const viewerConfig = resolveViewerConfig(previewPath);
let activeMode = requestedMode;
let scrollOffset = 0;
let statusMessage = "Click a mode or press 1/2/3";
let hitTargets = [];
let demoPreviewFile = "";
const contentCache = new Map();

function stripAnsi(value) {
  return String(value ?? "").replace(ANSI_RE, "");
}

function visibleLength(value) {
  return [...stripAnsi(value)].length;
}

function truncate(value, width) {
  const chars = [...String(value ?? "")];
  if (chars.length <= width) return chars.join("");
  return width > 1 ? `${chars.slice(0, width - 1).join("")}…` : "…";
}

function fit(value, width) {
  return visibleLength(value) <= width ? value : truncate(stripAnsi(value), width);
}

function pad(value, width) {
  const fitted = fit(value, width);
  return `${fitted}${" ".repeat(Math.max(0, width - visibleLength(fitted)))}`;
}

function safeAbsolutePath() {
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, previewPath);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : "";
}

function runGit(args) {
  return spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", timeout: 8_000 });
}

function parseClientValue(value) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  return parts.length ? { client: parts[0], args: parts.slice(1), mode: "auto" } : null;
}

function normalizeLaunchConfig(value) {
  if (typeof value === "string") return parseClientValue(value);
  if (!value || typeof value !== "object" || typeof value.client !== "string" || !value.client.trim()) return null;
  return {
    client: value.client.trim(),
    args: Array.isArray(value.args) ? value.args.filter((arg) => typeof arg === "string") : [],
    mode: ["auto", "terminal", "external"].includes(value.mode) ? value.mode : "auto",
    autoOpen: value.autoOpen !== false,
  };
}

function normalizeViewers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([pattern, config]) => [pattern, normalizeLaunchConfig(config)])
      .filter(([, config]) => config),
  );
}

function readClientConfig(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const openClient = normalizeLaunchConfig(parsed);
    const viewers = normalizeViewers(parsed.viewers);
    return openClient || Object.keys(viewers).length ? { ...(openClient || {}), viewers } : null;
  } catch {
    return null;
  }
}

function resolveClientConfig() {
  const projectConfig = readClientConfig(path.join(repoRoot, ".git-rail.json"));
  const userConfig = readClientConfig(path.join(os.homedir(), ".config", "git-rail", "config.json"));
  const fileConfig = projectConfig || userConfig || {};
  const environmentClient = parseClientValue(process.env.GIT_RAIL_CLIENT);
  if (environmentClient) {
    try {
      const environmentArgs = JSON.parse(process.env.GIT_RAIL_CLIENT_ARGS || "[]");
      if (Array.isArray(environmentArgs) && environmentArgs.every((arg) => typeof arg === "string")) {
        environmentClient.args.push(...environmentArgs);
      }
    } catch {
      // Ignore malformed optional args and retain the configured executable.
    }
    if (["auto", "terminal", "external"].includes(process.env.GIT_RAIL_CLIENT_MODE)) {
      environmentClient.mode = process.env.GIT_RAIL_CLIENT_MODE;
    }
    return { ...environmentClient, viewers: fileConfig.viewers || {} };
  }
  const fallbackClient = parseClientValue(process.env.EDITOR) || { client: "vim", args: [], mode: "terminal" };
  return {
    ...fallbackClient,
    ...fileConfig,
    viewers: fileConfig.viewers || {},
  };
}

function clientMode(config = clientConfig) {
  if (config.client === "none") return "disabled";
  if (config.client === "builtin") return "builtin";
  if (config.client === "system") return "external";
  if (config.mode !== "auto") return config.mode;
  const terminalClients = new Set(["vi", "vim", "nvim", "nano", "micro", "hx", "helix", "kak", "kakoune"]);
  return terminalClients.has(path.basename(config.client)) ? "terminal" : "external";
}

function resolveViewerConfig(filePath) {
  const defaults = {
    ".md": { client: "glow", args: ["--tui", "--style", "dark"], mode: "terminal", autoOpen: true },
    ".mdx": { client: "glow", args: ["--tui", "--style", "dark"], mode: "terminal", autoOpen: true },
    ".markdown": { client: "glow", args: ["--tui", "--style", "dark"], mode: "terminal", autoOpen: true },
  };
  const viewers = { ...defaults, ...(clientConfig.viewers || {}) };
  const name = path.basename(filePath).toLocaleLowerCase();
  const match = Object.keys(viewers)
    .sort((a, b) => b.length - a.length)
    .find((pattern) => pattern === "*" || name === pattern.toLocaleLowerCase() || name.endsWith(pattern.toLocaleLowerCase()));
  return match ? { pattern: match, ...viewers[match] } : null;
}

function mappedDemoPath() {
  const prefix = "prototypes/herdr-git-rail/";
  if (!previewPath.startsWith(prefix)) return "";
  const relativePath = previewPath.slice(prefix.length);
  const candidate = path.resolve(pluginRoot, relativePath);
  const rootPrefix = `${pluginRoot}${path.sep}`;
  return candidate.startsWith(rootPrefix) && fs.existsSync(candidate) ? candidate : "";
}

function demoSource() {
  const mappedPath = mappedDemoPath();
  if (mappedPath) return fs.readFileSync(mappedPath, "utf8");
  if (markdownEligible) {
    return `# Git rail

The right rail keeps repository and branch context visible while you browse Git state.

## Preview behavior

- **Diff** shows the working change against \`HEAD\`.
- **Raw** shows the source with line numbers.
- **Markdown** renders this document for reading.

> Double-click a changed file to open its preview without leaving Herdr.

\`\`\`bash
herdr plugin action invoke local.git-rail.open-git-rail-mockup
\`\`\`
`;
  }
  const name = path.basename(previewPath) || "file";
  return `// Read-only demo preview
export function open${name.replace(/\W+/g, "_")}() {
  return { repository: "git-rail", branch: "feature/sidebar" };
}
`;
}

function sourceText() {
  if (demoMode) return demoSource();
  const absolutePath = safeAbsolutePath();
  if (!absolutePath) throw new Error("Refusing to preview a path outside the repository.");
  const buffer = fs.readFileSync(absolutePath);
  if (buffer.subarray(0, 8_192).includes(0)) throw new Error("Binary file — textual preview unavailable.");
  return buffer.toString("utf8");
}

function diffContent() {
  if (demoMode) {
    if (previewStatus === "added") {
      const sourceLines = sourceText().replace(/\n$/, "").split("\n");
      return [
        ...(previewCommit ? [`${C.dim}commit ${previewCommit}${C.reset}`] : []),
        `${C.bold}diff --git a/${previewPath} b/${previewPath}${C.reset}`,
        `${C.dim}new file mode 100644${C.reset}`,
        `${C.red}--- /dev/null${C.reset}`,
        `${C.green}+++ b/${previewPath}${C.reset}`,
        `${C.blue}@@ -0,0 +1,${sourceLines.length} @@${C.reset}`,
        ...sourceLines.map((line) => `${C.green}+${line}${C.reset}`),
      ];
    }
    return [
      ...(previewCommit ? [`${C.dim}commit ${previewCommit}${C.reset}`] : []),
      `${C.bold}diff --git a/${previewPath} b/${previewPath}${C.reset}`,
      `${C.red}--- a/${previewPath}${C.reset}`,
      `${C.green}+++ b/${previewPath}${C.reset}`,
      `${C.blue}@@ -18,3 +18,8 @@${C.reset}`,
      `${C.red}-const panel = "files";${C.reset}`,
      `${C.green}+const panel = "git-rail";${C.reset}`,
      `${C.green}+const preview = { mode: "diff", readOnly: true };${C.reset}`,
    ];
  }
  const result = previewCommit
    ? runGit(["show", "--format=", "--no-ext-diff", "--color=always", "--find-renames", previewCommit, "--", previewPath])
    : runGit(["diff", "--no-ext-diff", "--color=always", "HEAD", "--", previewPath]);
  if (result.status === 0 && result.stdout) return result.stdout.replace(/\n$/, "").split("\n");
  return [`${C.dim}${previewCommit ? `No diff for this file in ${previewCommit}.` : "No working-tree diff for this file."}${C.reset}`];
}

function rawContent() {
  try {
    return sourceText().split("\n").map((line, index) => `${C.dim}${String(index + 1).padStart(4)}${C.reset}  ${line}`);
  } catch (error) {
    return [`${C.red}${error.message}${C.reset}`];
  }
}

function markdownContent() {
  if (!markdownEligible) return [`${C.dim}Markdown preview is available for .md, .mdx, and .markdown files.${C.reset}`];
  return [
    "",
    `${C.bold}Markdown is viewed by Glow.${C.reset}`,
    `${C.dim}Press 3 or click Markdown to open the rendered pager.${C.reset}`,
  ];
}

function contentFor(mode, width) {
  const cacheKey = `${mode}:${width}`;
  if (!contentCache.has(cacheKey)) {
    const content = mode === "diff" ? diffContent() : mode === "raw" ? rawContent() : markdownContent();
    contentCache.set(cacheKey, content);
  }
  return contentCache.get(cacheKey);
}

function selectMode(mode) {
  if (mode === "markdown" && !markdownEligible) {
    statusMessage = "Markdown mode requires a Markdown file";
    return;
  }
  if (mode === "markdown") {
    launchMarkdownViewer();
    return;
  }
  activeMode = mode;
  scrollOffset = 0;
  statusMessage = `${mode[0].toUpperCase()}${mode.slice(1)} preview`;
}

function previewSourcePath() {
  if (!demoMode) return safeAbsolutePath();
  if (!demoPreviewFile) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "git-rail-preview-"));
    demoPreviewFile = path.join(directory, path.basename(previewPath) || "preview.txt");
    fs.writeFileSync(demoPreviewFile, demoSource(), "utf8");
  }
  return demoPreviewFile;
}

function suspendPreview() {
  process.stdout.write(`${ESC}?1000l${ESC}?1006l${ESC}?25h${ESC}?1049l`);
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
}

function resumePreview() {
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}?1000h${ESC}?1006h`);
}

function launchConfiguredViewer(config, sourcePath, label = "viewer") {
  if (!config || config.client === "builtin") return false;
  const mode = clientMode(config);
  if (mode === "disabled") {
    statusMessage = `${label} is disabled by configuration`;
    return false;
  }
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    statusMessage = `${label} source is unavailable`;
    return false;
  }
  const executable = config.client === "system"
    ? process.platform === "darwin" ? "open" : "xdg-open"
    : config.client;
  if (mode === "external") {
    const result = spawnSync(executable, [...config.args, sourcePath], { stdio: "ignore", timeout: 8_000 });
    statusMessage = result.error
      ? `${label} failed: ${result.error.message}`
      : `Opened with ${config.client === "system" ? "system default" : path.basename(config.client)}`;
    return !result.error;
  }
  suspendPreview();
  const result = spawnSync(executable, [...config.args, sourcePath], { stdio: "inherit" });
  resumePreview();
  statusMessage = result.error
    ? `${label} failed: ${result.error.message}`
    : `Returned from ${path.basename(config.client)}`;
  return !result.error;
}

function launchMarkdownViewer() {
  if (!markdownEligible) {
    statusMessage = "Markdown mode requires a Markdown file";
    return;
  }
  const sourcePath = previewSourcePath();
  const markdownViewer = viewerConfig || {
    client: "glow",
    args: ["--tui", "--style", "dark"],
    mode: "terminal",
  };
  activeMode = "markdown";
  launchConfiguredViewer(markdownViewer, sourcePath, "Markdown viewer");
}

function launchEditor() {
  const sourcePath = demoMode ? previewSourcePath() : safeAbsolutePath();
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    statusMessage = "The selected file is unavailable";
    return;
  }
  const mode = clientMode();
  if (mode === "disabled") {
    statusMessage = "Editor opening is disabled by configuration";
    return;
  }
  const executable = clientConfig.client === "system"
    ? process.platform === "darwin" ? "open" : "xdg-open"
    : clientConfig.client;
  if (mode === "external") {
    const result = spawnSync(executable, [...clientConfig.args, sourcePath], { stdio: "ignore", timeout: 8_000 });
    statusMessage = result.error
      ? `Client failed: ${result.error.message}`
      : `Opened with ${clientConfig.client === "system" ? "system default" : path.basename(clientConfig.client)}`;
    return;
  }
  suspendPreview();
  const result = spawnSync(executable, [...clientConfig.args, sourcePath], { stdio: "inherit" });
  resumePreview();
  contentCache.clear();
  statusMessage = result.error
    ? `Editor failed: ${result.error.message}`
    : demoMode ? "Returned from editor · demo copy" : "Returned from editor";
}

function renderTabs(width) {
  const modes = [
    ["diff", "1 Diff"],
    ["raw", "2 Raw"],
    ["markdown", "3 Markdown"],
  ];
  hitTargets = [];
  let line = "";
  let column = 1;
  for (const [mode, label] of modes) {
    const enabled = mode !== "markdown" || markdownEligible;
    const text = ` ${label} `;
    const styled = mode === activeMode
      ? `${C.selected}${C.gold}${C.bold}${text}${C.reset}`
      : enabled ? `${C.dim}${text}${C.reset}` : `${C.faint}${text}${C.reset}`;
    line += styled;
    hitTargets.push({ row: 3, x1: column, x2: column + visibleLength(text) - 1, action: () => selectMode(mode) });
    column += visibleLength(text);
  }
  const clientLabel = clientConfig.client === "none" ? "disabled" : path.basename(clientConfig.client);
  const editLabel = ` e Open ${clientMode() === "terminal" ? "in" : "with"} ${clientLabel} `;
  if (column + visibleLength(editLabel) <= width) {
    line += `${C.dim}${editLabel}${C.reset}`;
    hitTargets.push({ row: 3, x1: column, x2: column + visibleLength(editLabel) - 1, action: launchEditor });
  }
  return fit(line, width);
}

function render() {
  const width = Math.max(20, process.stdout.columns || 90);
  const height = Math.max(14, process.stdout.rows || 36);
  const content = contentFor(activeMode, width);
  const header = [
    `${C.gold}${C.bold}◆ GIT PREVIEW${C.reset}  ${C.dim}read-only${C.reset}`,
    fit(`${C.bold}${previewPath || "No file selected"}${C.reset}`, width),
    renderTabs(width),
    `${C.faint}${"─".repeat(width)}${C.reset}`,
  ];
  const footer = [
    `${C.faint}${"─".repeat(width)}${C.reset}`,
    `${C.dim}${fit(statusMessage, width)}${C.reset}`,
    `${C.dim}Tab or 1/2/3 · e ${path.basename(clientConfig.client)} (${clientMode()}) · j/k · q close${C.reset}`,
  ];
  const bodyHeight = Math.max(1, height - header.length - footer.length);
  const maxOffset = Math.max(0, content.length - bodyHeight);
  scrollOffset = Math.max(0, Math.min(scrollOffset, maxOffset));
  const body = content.slice(scrollOffset, scrollOffset + bodyHeight);
  while (body.length < bodyHeight) body.push("");
  process.stdout.write(`${ESC}H${ESC}2J${[...header, ...body, ...footer].map((line) => pad(line, width)).join("\n")}`);
}

function cleanup() {
  if (demoPreviewFile) {
    try {
      fs.rmSync(path.dirname(demoPreviewFile), { recursive: true, force: true });
    } catch {
      // Temporary preview cleanup is best-effort.
    }
    demoPreviewFile = "";
  }
  process.stdout.write(`${ESC}?1000l${ESC}?1006l${ESC}?25h${ESC}?1049l`);
}

function quit() {
  cleanup();
  process.exit(0);
}

process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}?1000h${ESC}?1006h`);
process.stdin.setEncoding("utf8");
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (key) => {
  if (key === "q" || key === "\u001b" || key === "\u0003") return quit();
  const mousePattern = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
  let match;
  let handledMouse = false;
  while ((match = mousePattern.exec(key)) !== null) {
    handledMouse = true;
    const button = Number.parseInt(match[1], 10);
    const column = Number.parseInt(match[2], 10);
    const row = Number.parseInt(match[3], 10);
    const phase = match[4];
    if (button === 64 && phase === "M") scrollOffset -= 3;
    if (button === 65 && phase === "M") scrollOffset += 3;
    if (button === 0 && phase === "M") hitTargets.find((target) => target.row === row && column >= target.x1 && column <= target.x2)?.action();
  }
  if (!handledMouse) {
    if (key === "1") selectMode("diff");
    if (key === "2") selectMode("raw");
    if (key === "3") selectMode("markdown");
    if (key === "\t") selectMode(activeMode === "diff" ? "raw" : activeMode === "raw" ? (markdownEligible ? "markdown" : "diff") : "diff");
    if (key === "e") launchEditor();
    if (key === "j" || key === "\u001b[B") scrollOffset++;
    if (key === "k" || key === "\u001b[A") scrollOffset--;
    if (key === "g") scrollOffset = 0;
    if (key === "G") scrollOffset = contentFor(activeMode, process.stdout.columns || 90).length;
  }
  render();
});
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
process.on("exit", cleanup);
process.stdout.on("resize", render);
render();
if (viewerConfig && viewerConfig.autoOpen !== false && viewerConfig.client !== "builtin") {
  setTimeout(() => {
    if (markdownEligible) activeMode = "markdown";
    launchConfiguredViewer(viewerConfig, previewSourcePath(), `${viewerConfig.pattern} viewer`);
    render();
  }, 0);
}
