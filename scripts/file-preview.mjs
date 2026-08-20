#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { clientMode, loadConfig, resolveViewer } from "../src/config.mjs";
import { parseUnifiedDiff } from "../src/diff-view.mjs";
import { loadDiff, loadRaw, safeWorktreePath } from "../src/preview-provider.mjs";
import {
  commitComparisonSource,
  fitAnsiTerminalColumns,
  previewInitialMode,
  sanitizeTerminalText,
  stripSgrMouseEvents,
  stripTerminalAnsi,
  terminalColumns,
} from "../src/terminal-ui.mjs";

const ESC = "\u001b[";
const C = {
  reset: `${ESC}0m`, bold: `${ESC}1m`, dim: `${ESC}2m`,
  gold: `${ESC}38;2;214;176;91m`, green: `${ESC}38;2;91;190;112m`,
  red: `${ESC}38;2;224;108;117m`, blue: `${ESC}38;2;105;169;230m`,
  faint: `${ESC}38;2;84;84;84m`, selected: `${ESC}48;2;45;41;34m`,
};
const filePath = process.env.GIT_RAIL_PREVIEW_PATH || "";
const repoRoot = process.env.GIT_RAIL_PREVIEW_REPO || process.cwd();
const descriptor = decode("GIT_RAIL_PREVIEW_DESCRIPTOR", { kind: "clean" });
const metadata = decode("GIT_RAIL_PREVIEW_METADATA", {});
const temporarySource = process.env.GIT_RAIL_PREVIEW_TEMPORARY === "1";
const { config, errors: configErrors } = loadConfig(repoRoot);
const viewer = resolveViewer(config, filePath);
const markdownEligible = /\.(md|mdx|markdown)$/i.test(filePath);
let activeMode = previewInitialMode(descriptor, metadata);
let scrollOffset = 0;
let statusMessage = configErrors[0] || "Read-only preview";
let revisionLabel = "";
let content = [];
let loading = false;
let loadGeneration = 0;
let hitTargets = [];
let searchActive = false;
let searchQuery = "";
let currentMatch = -1;
let temporaryDirectory = "";
let renderTimer;

function decode(name, fallback) {
  try { return JSON.parse(Buffer.from(process.env[name] || "", "base64url").toString("utf8")); } catch { return fallback; }
}
function safe(value) { return sanitizeTerminalText(value); }
function stripAnsi(value) { return stripTerminalAnsi(value); }
function visibleLength(value) { return terminalColumns(value); }
function fit(value, width) { return fitAnsiTerminalColumns(value, width); }
function descriptorLabel() {
  if (descriptor.kind === "workspace") return `Against ${safe(descriptor.baseRef)}`;
  if (descriptor.kind === "against") return `Against ${safe(descriptor.baseRef)}`;
  if (descriptor.kind === "commit") return `Commit ${safe(descriptor.commitHash).slice(0, 8)}`;
  const kind = safe(descriptor.kind || "file");
  return kind[0].toUpperCase() + kind.slice(1);
}
function comparisonLabel() {
  if (descriptor.kind === "workspace") return `Against ${safe(descriptor.baseRef)} · merge base → worktree`;
  if (descriptor.kind === "against") return `Against ${safe(descriptor.baseRef)} · merge base → HEAD`;
  if (descriptor.kind === "commit") return `Commit ${safe(descriptor.commitHash).slice(0, 8)} · ${commitComparisonSource(descriptor)} → commit`;
  if (descriptor.kind === "staged") return "Staged · HEAD → index";
  if (descriptor.kind === "unstaged") return "Unstaged · index → worktree";
  if (descriptor.kind === "untracked") return "Untracked · new file";
  return "Worktree file";
}
function diffLines(value) {
  const rows = parseUnifiedDiff(value);
  const oldLabel = (row) => row.oldLines ? row.oldLines.map((line) => line ?? "·").join(",") : row.oldLine;
  const gutterWidth = Math.max(2, ...rows.map((row) => String(oldLabel(row) ?? "").length), ...rows.map((row) => String(row.newLine ?? "").length));
  const number = (value) => value === null || value === undefined ? " ".repeat(gutterWidth) : String(value).padStart(gutterWidth);
  return rows.map((row) => {
    if (row.kind === "hunk") return `${C.blue}${" ".repeat(gutterWidth * 2 + 3)}  ${row.text}${C.reset}`;
    if (row.kind === "meta") return `${C.gold}${" ".repeat(gutterWidth * 2 + 3)}  ${row.text}${C.reset}`;
    if (row.kind === "note") return `${C.dim}${" ".repeat(gutterWidth * 2 + 3)}  ${row.text}${C.reset}`;
    const marker = row.kind === "added" ? "+" : row.kind === "deleted" ? "−" : " ";
    const color = row.kind === "added" ? C.green : row.kind === "deleted" ? C.red : "";
    return `${C.dim}${number(oldLabel(row))} ${number(row.newLine)} │${C.reset} ${color}${marker} ${safe(row.text)}${C.reset}`;
  });
}
function matches() {
  if (!searchQuery) return [];
  const query = searchQuery.toLocaleLowerCase();
  return content.flatMap((line, index) => stripAnsi(line).toLocaleLowerCase().includes(query) ? [index] : []);
}
function matchLabel() {
  const found = matches();
  if (!searchQuery) return "";
  const position = currentMatch >= 0 ? found.indexOf(currentMatch) + 1 : 0;
  return `${position}/${found.length}`;
}
function moveMatch(direction) {
  const found = matches();
  if (!found.length) { currentMatch = -1; statusMessage = `No matches for “${safe(searchQuery)}”`; return; }
  const index = found.indexOf(currentMatch);
  currentMatch = found[(index + direction + found.length) % found.length];
  scrollOffset = currentMatch;
  statusMessage = `Match ${found.indexOf(currentMatch) + 1} of ${found.length}`;
}
async function loadMode(mode) {
  if (mode === "markdown") { await launchViewer(); return; }
  const generation = ++loadGeneration;
  activeMode = mode;
  loading = true;
  statusMessage = `Loading ${mode}…`;
  render();
  try {
    const result = mode === "diff"
      ? await loadDiff({ repoRoot, filePath, descriptor, metadata, maxOutputBytes: config.limits.maxDiffBytes })
      : await loadRaw({ repoRoot, filePath, descriptor, metadata, maxFileBytes: config.limits.maxFileBytes });
    if (generation !== loadGeneration) return;
    revisionLabel = safe(result.revision);
    content = mode === "diff"
      ? diffLines(result.text)
      : result.text.replace(/\n$/, "").split("\n").map((line, index) => `${C.dim}${String(index + 1).padStart(5)}${C.reset}  ${safe(line)}`);
    scrollOffset = 0;
    statusMessage = mode === "diff" ? comparisonLabel() : `${descriptorLabel()} · ${revisionLabel}`;
  } catch (error) {
    if (generation !== loadGeneration) return;
    content = [`${C.red}${safe(error.message)}${C.reset}`, "", `${C.dim}Press 1 or 2 to retry another view.${C.reset}`];
    statusMessage = error.kind === "oversized" ? "Preview is larger than the configured safety limit" : "Preview failed";
  } finally {
    if (generation === loadGeneration) { loading = false; render(); }
  }
}
function suspend() {
  process.stdout.write(`${ESC}?1000l${ESC}?1006l${ESC}?25h${ESC}?1049l`);
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
}
function resume() {
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}?1000h${ESC}?1006h`);
}
function launch(configValue, sourcePath, label) {
  if (!configValue || configValue.client === "builtin") return;
  const mode = clientMode(configValue);
  if (mode === "disabled") { statusMessage = `${label} is disabled`; return; }
  const executable = configValue.client === "system" ? (process.platform === "darwin" ? "open" : "xdg-open") : configValue.client;
  if (mode === "external") {
    const child = spawn(executable, [...configValue.args, sourcePath], { detached: true, stdio: "ignore", shell: false });
    child.on("error", (error) => { statusMessage = `${label} failed: ${safe(error.message)}`; render(); });
    child.on("close", (status) => {
      if (status !== 0) { statusMessage = `${label} exited with status ${status}`; render(); }
    });
    child.unref();
    statusMessage = `Opened with ${safe(path.basename(configValue.client))}`;
    return;
  }
  suspend();
  const result = spawnSync(executable, [...configValue.args, sourcePath], { stdio: "inherit", shell: false });
  resume();
  statusMessage = result.error ? `${label} failed: ${safe(result.error.message)}` : result.status === 0 ? `Returned from ${safe(path.basename(configValue.client))}` : `${label} exited with status ${result.status}`;
}
async function materializedRawSource() {
  if (!temporaryDirectory) temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-gitrail-preview-"));
  fs.chmodSync(temporaryDirectory, 0o700);
  const copy = path.join(temporaryDirectory, path.basename(filePath) || "preview.txt");
  const raw = await loadRaw({ repoRoot, filePath, descriptor, metadata, maxFileBytes: config.limits.maxFileBytes });
  if (fs.existsSync(copy)) fs.chmodSync(copy, 0o600);
  fs.writeFileSync(copy, raw.text, { mode: 0o600 });
  fs.chmodSync(copy, 0o400);
  return copy;
}
async function sourceForLaunch(copyForDemo = false, exactRevision = false) {
  const materialize = exactRevision && (["commit", "against", "staged"].includes(descriptor.kind) || metadata.status === "deleted");
  if (materialize) return materializedRawSource();
  const source = await safeWorktreePath(repoRoot, filePath);
  if (!copyForDemo || !temporarySource) return source;
  if (!temporaryDirectory) temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-gitrail-preview-"));
  fs.chmodSync(temporaryDirectory, 0o700);
  const copy = path.join(temporaryDirectory, path.basename(filePath) || "preview.txt");
  fs.copyFileSync(source, copy);
  fs.chmodSync(copy, 0o600);
  return copy;
}
async function launchViewer() {
  if (!markdownEligible) { statusMessage = "Markdown is only available for Markdown files"; render(); return; }
  try { launch(viewer || config.viewers[".md"], await sourceForLaunch(false, true), "Markdown viewer"); }
  catch (error) { statusMessage = `Markdown source unavailable: ${safe(error.message)}`; }
  render();
}
async function launchEditor() {
  if (clientMode(config.editor) === "disabled") {
    statusMessage = "Editor is not configured";
    render();
    return;
  }
  try {
    const materializedRevision = ["commit", "against", "staged"].includes(descriptor.kind) || metadata.status === "deleted";
    const source = await sourceForLaunch(true, true);
    if (materializedRevision) {
      statusMessage = "Opening read-only temporary revision copy";
      render();
    }
    launch(config.editor, source, "Editor");
    if (materializedRevision) statusMessage += " · read-only temporary revision copy";
    else if (temporarySource) statusMessage += " · temporary demo copy";
  } catch (error) { statusMessage = `File unavailable: ${safe(error.message)}`; }
  render();
}
function renderTabs(width) {
  const modes = [["diff", "1 Diff"], ["raw", "2 Raw"], ["markdown", "3 View Markdown"]];
  hitTargets = [];
  let line = "";
  let column = 1;
  for (const [mode, label] of modes) {
    const enabled = mode !== "markdown" || markdownEligible;
    const text = ` ${label} `;
    line += mode === activeMode ? `${C.selected}${C.gold}${C.bold}${text}${C.reset}` : enabled ? `${C.dim}${text}${C.reset}` : `${C.faint}${text}${C.reset}`;
    hitTargets.push({ row: 4, x1: column, x2: column + visibleLength(text) - 1, action: () => void loadMode(mode) });
    column += visibleLength(text);
  }
  const editorMode = clientMode(config.editor);
  const editorLabel = ` e Open ${editorMode === "terminal" ? "in" : "with"} ${safe(path.basename(config.editor.client))} `;
  if (editorMode !== "disabled" && column + visibleLength(editorLabel) <= width) {
    line += `${C.dim}${editorLabel}${C.reset}`;
    hitTargets.push({ row: 4, x1: column, x2: column + visibleLength(editorLabel) - 1, action: () => void launchEditor() });
  }
  return fit(line, width);
}
function render() {
  const width = Math.max(24, process.stdout.columns || 90);
  const height = Math.max(14, process.stdout.rows || 36);
  const search = searchActive ? `⌕ ${safe(searchQuery)}▏  ${matchLabel()}` : loading ? `${descriptorLabel()} · loading` : activeMode === "diff" ? comparisonLabel() : `${descriptorLabel()} · ${revisionLabel || "ready"}`;
  const header = [
    `${C.gold}${C.bold}◆ HERDR GITRAIL PREVIEW${C.reset}  ${C.dim}read-only${C.reset}`,
    fit(`${C.bold}${safe(filePath) || "No file selected"}${C.reset}`, width),
    fit(`${C.dim}${search}${C.reset}`, width),
    renderTabs(width),
    `${C.faint}${"─".repeat(width)}${C.reset}`,
  ];
  const footer = [
    `${C.faint}${"─".repeat(width)}${C.reset}`,
    `${C.dim}${fit(safe(statusMessage), width)}${C.reset}`,
    `${C.dim}${fit(`1/2/3 view · / search · n/N match${clientMode(config.editor) === "disabled" ? "" : " · e open"} · j/k · q close`, width)}${C.reset}`,
  ];
  const bodyHeight = Math.max(1, height - header.length - footer.length);
  scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, content.length - bodyHeight)));
  const body = content.slice(scrollOffset, scrollOffset + bodyHeight);
  while (body.length < bodyHeight) body.push("");
  const frame = [...header, ...body, ...footer]
    .map((line) => `${ESC}2K${fit(line, width)}`)
    .join("\r\n");
  process.stdout.write(`${ESC}?2026h${ESC}H${frame}${ESC}?2026l`);
}
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = undefined;
    render();
  }, 16);
}
function cleanup() {
  if (temporaryDirectory) { try { fs.rmSync(temporaryDirectory, { recursive: true, force: true }); } catch {} temporaryDirectory = ""; }
  process.stdout.write(`${ESC}?1000l${ESC}?1006l${ESC}?25h${ESC}?1049l`);
}
function quit() { cleanup(); process.exit(0); }

process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}?1000h${ESC}?1006h`);
process.stdin.setEncoding("utf8");
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (key) => {
  if (key === "\u0003" || (!searchActive && (key === "q" || key === "\u001b"))) return quit();
  const mousePattern = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
  let match; let mouse = false;
  while ((match = mousePattern.exec(key))) {
    mouse = true;
    const button = Number(match[1]); const column = Number(match[2]); const row = Number(match[3]); const phase = match[4];
    if (button === 64 && phase === "M") scrollOffset -= 3;
    if (button === 65 && phase === "M") scrollOffset += 3;
    if (button === 0 && phase === "M") hitTargets.find((target) => target.row === row && column >= target.x1 && column <= target.x2)?.action();
  }
  if (mouse) {
    key = stripSgrMouseEvents(key);
    if (!key) { scheduleRender(); return; }
  }
  if (searchActive) {
    if (key === "\u001b" || key === "\r" || key === "\n") { searchActive = false; if (searchQuery) moveMatch(1); }
    else if (key === "\u007f" || key === "\b") searchQuery = [...searchQuery].slice(0, -1).join("");
    else if (key === "\u0015") searchQuery = "";
    else searchQuery += key.replace(/\u001b\[[0-9;]*[A-Za-z~]/g, "").replace(/[\x00-\x1f\x7f]/g, "");
    currentMatch = -1;
  } else if (!mouse) {
    if (key === "1") void loadMode("diff");
    if (key === "2") void loadMode("raw");
    if (key === "3") void loadMode("markdown");
    if (key === "\t") void loadMode(activeMode === "diff" ? "raw" : activeMode === "raw" && markdownEligible ? "markdown" : "diff");
    if (key === "e") void launchEditor();
    if (key === "/") searchActive = true;
    if (key === "n") moveMatch(1);
    if (key === "N") moveMatch(-1);
    scrollOffset += (key.match(/j|\u001b\[B/g)?.length || 0);
    scrollOffset -= (key.match(/k|\u001b\[A/g)?.length || 0);
    if (key === "g") scrollOffset = 0;
    if (key === "G") scrollOffset = content.length;
  }
  scheduleRender();
});
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
process.on("exit", cleanup);
process.stdout.on("resize", scheduleRender);
render();
void loadMode(activeMode).then(() => {
  if (viewer?.autoOpen) void launchViewer();
});
