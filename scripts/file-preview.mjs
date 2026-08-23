#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { clientMode, executableAvailable, launchExecutable, loadConfig, resolveViewerActions } from "../src/config.mjs";
import { parseUnifiedDiff } from "../src/diff-view.mjs";
import { loadDiff, loadRaw, loadRawBytes, safeWorktreePath } from "../src/preview-provider.mjs";
import { runCommand } from "../src/process.mjs";
import {
  commitComparisonSource,
  createTerminalInputDecoder,
  fitAnsiTerminalColumns,
  padAnsiTerminalColumns,
  previewInitialMode,
  sanitizeRendererAnsi,
  sanitizeTerminalText,
  sliceAnsiTerminalColumns,
  stripTerminalAnsi,
  terminalColumns,
  wrapAnsiTerminalLines,
} from "../src/terminal-ui.mjs";

const ESC = "\u001b[";
const C = {
  reset: `${ESC}0m`, bold: `${ESC}1m`, dim: `${ESC}2m`,
  gold: `${ESC}38;2;214;176;91m`, green: `${ESC}38;2;91;190;112m`,
  red: `${ESC}38;2;224;108;117m`, blue: `${ESC}38;2;105;169;230m`,
  faint: `${ESC}38;2;84;84;84m`, selected: `${ESC}48;2;45;41;34m`,
};
const MAX_PREVIEW_LINES = 100_000;
const MAX_WRAPPED_LINE_COLUMNS = 100_000;
const forcedWidth = numberArg("--width");
const forcedHeight = numberArg("--height");
const filePath = process.env.GIT_RAIL_PREVIEW_PATH || "";
const repoRoot = process.env.GIT_RAIL_PREVIEW_REPO || process.cwd();
const descriptor = decode("GIT_RAIL_PREVIEW_DESCRIPTOR", { kind: "clean" });
const metadata = decode("GIT_RAIL_PREVIEW_METADATA", {});
const temporarySource = process.env.GIT_RAIL_PREVIEW_TEMPORARY === "1";
const { config, errors: configErrors } = loadConfig(repoRoot);
const viewerActions = resolveViewerActions(config, filePath);
let activeMode = previewInitialMode(descriptor, metadata);
let scrollOffset = 0;
let horizontalOffset = 0;
let statusMessage = configErrors[0] || "Read-only preview";
let revisionLabel = "";
let content = [];
let contentGutterColumns = 0;
let maximumContentWidth = 0;
let contentWidths = [];
let contentGeneration = 0;
let layoutCache;
let pendingLayoutAnchor;
const wrapByMode = new Map([["diff", false], ["raw", true]]);
let activeEmbeddedAction;
let loading = false;
let loadGeneration = 0;
let hitTargets = [];
let searchActive = false;
let searchQuery = "";
let currentMatch = -1;
let currentMatchColumn = 0;
let cachedMatchesQuery = null;
let cachedMatches = [];
let temporaryDirectory = "";
let renderTimer;
let embeddedResizeTimer;
let visibleBodyRows = 1;

function numberArg(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? NaN : Number.parseInt(process.argv[index + 1] || "", 10);
  return Number.isFinite(value) ? value : null;
}

function decode(name, fallback) {
  try { return JSON.parse(Buffer.from(process.env[name] || "", "base64url").toString("utf8")); } catch { return fallback; }
}
function safe(value) { return sanitizeTerminalText(value); }
function stripAnsi(value) { return stripTerminalAnsi(value); }
function visibleLength(value) { return terminalColumns(value); }
function fit(value, width) { return fitAnsiTerminalColumns(value, width); }
function terminalWidth() { return Math.max(24, forcedWidth || process.stdout.columns || 90); }
function terminalHeight() { return Math.max(14, forcedHeight || process.stdout.rows || 36); }
function bodyWidth() { return Math.max(1, terminalWidth() - 1); }
function wrapping() { return wrapByMode.get(activeMode) ?? true; }
function rememberLayoutAnchor() {
  if (!layoutCache?.rows.length) return;
  pendingLayoutAnchor = layoutCache.rows[Math.max(0, Math.min(scrollOffset, layoutCache.rows.length - 1))];
}
function invalidateLayout({ preserveAnchor = false } = {}) {
  if (preserveAnchor) rememberLayoutAnchor();
  layoutCache = undefined;
}
function setContent(lines, gutterColumns) {
  content = lines;
  contentGutterColumns = gutterColumns;
  contentWidths = content.map((line) => visibleLength(line));
  maximumContentWidth = contentWidths.reduce((maximum, lineWidth) => Math.max(maximum, lineWidth), 0);
  contentGeneration += 1;
  pendingLayoutAnchor = undefined;
  layoutCache = undefined;
}
function visualRows() {
  const width = bodyWidth();
  let shouldWrap = wrapping();
  const wrappedTextWidth = Math.max(1, width - Math.min(contentGutterColumns, Math.max(0, width - 1)));
  const estimatedRows = shouldWrap ? contentWidths.reduce((total, lineWidth) => total
    + Math.max(1, Math.ceil(Math.max(0, lineWidth - contentGutterColumns) / wrappedTextWidth)), 0) : content.length;
  if (shouldWrap && (maximumContentWidth > MAX_WRAPPED_LINE_COLUMNS || estimatedRows > MAX_PREVIEW_LINES)) {
    wrapByMode.set(activeMode, false);
    shouldWrap = false;
    statusMessage = `Word wrap disabled · content would exceed ${MAX_PREVIEW_LINES.toLocaleString("en-US")} visual rows`;
  }
  const key = `${contentGeneration}:${width}:${contentGutterColumns}:${shouldWrap}`;
  if (layoutCache?.key === key) return layoutCache.rows;
  const continuation = contentGutterColumns
    ? `${C.dim}${" ".repeat(Math.max(0, contentGutterColumns - 2))}↳ ${C.reset}`
    : "";
  const rows = shouldWrap
    ? wrapAnsiTerminalLines(content, width, contentGutterColumns, continuation)
    : content.map((text, sourceRow) => ({ text, sourceRow, startColumn: 0, endColumn: visibleLength(text) }));
  layoutCache = { key, rows };
  if (pendingLayoutAnchor && rows.length) {
    let anchorIndex = rows.findIndex((row) => row.sourceRow === pendingLayoutAnchor.sourceRow
      && row.startColumn <= pendingLayoutAnchor.startColumn
      && row.endColumn >= pendingLayoutAnchor.startColumn);
    if (anchorIndex < 0) anchorIndex = rows.findIndex((row) => row.sourceRow === pendingLayoutAnchor.sourceRow);
    if (anchorIndex >= 0) scrollOffset = anchorIndex;
  }
  pendingLayoutAnchor = undefined;
  return rows;
}
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
function assertPreviewLineLimit(value) {
  let lines = value.length && value.endsWith("\n") ? 0 : 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x0a) continue;
    lines += 1;
    if (lines <= MAX_PREVIEW_LINES) continue;
    const error = new Error(`Preview has more than ${MAX_PREVIEW_LINES.toLocaleString("en-US")} lines; use Open or another external viewer`);
    error.kind = "too-many-lines";
    throw error;
  }
}
function diffLines(value) {
  const rows = parseUnifiedDiff(value);
  const oldLabel = (row) => row.oldLines ? row.oldLines.map((line) => line ?? "·").join(",") : row.oldLine;
  const gutterWidth = rows.reduce((maximum, row) => Math.max(
    maximum,
    String(oldLabel(row) ?? "").length,
    String(row.newLine ?? "").length,
  ), 2);
  contentGutterColumns = gutterWidth * 2 + 6;
  const number = (value) => value === null || value === undefined ? " ".repeat(gutterWidth) : String(value).padStart(gutterWidth);
  return rows.map((row) => {
    if (row.kind === "hunk") return `${C.blue}${" ".repeat(contentGutterColumns)}${row.text}${C.reset}`;
    if (row.kind === "meta") return `${C.gold}${" ".repeat(contentGutterColumns)}${row.text}${C.reset}`;
    if (row.kind === "note") return `${C.dim}${" ".repeat(contentGutterColumns)}${row.text}${C.reset}`;
    const marker = row.kind === "added" ? "+" : row.kind === "deleted" ? "−" : " ";
    const color = row.kind === "added" ? C.green : row.kind === "deleted" ? C.red : "";
    return `${C.dim}${number(oldLabel(row))} ${number(row.newLine)} │${C.reset} ${color}${marker} ${safe(row.text)}${C.reset}`;
  });
}
function matches() {
  if (!searchQuery) return [];
  if (cachedMatchesQuery === searchQuery) return cachedMatches;
  const query = searchQuery.toLowerCase();
  cachedMatches = content.flatMap((line, row) => {
    const plain = stripAnsi(line);
    const index = plain.toLowerCase().indexOf(query);
    return index < 0 ? [] : [{ row, column: terminalColumns(plain.slice(0, index)) }];
  });
  cachedMatchesQuery = searchQuery;
  return cachedMatches;
}
function matchLabel() {
  const found = matches();
  if (!searchQuery) return "";
  const position = currentMatch >= 0 ? found.findIndex((match) => match.row === currentMatch) + 1 : 0;
  return `${position}/${found.length}`;
}
function moveMatch(direction) {
  const found = matches();
  if (!found.length) { currentMatch = -1; statusMessage = `No matches for “${safe(searchQuery)}”`; return; }
  const index = found.findIndex((match) => match.row === currentMatch);
  const next = found[(index + direction + found.length) % found.length];
  currentMatch = next.row;
  currentMatchColumn = next.column;
  const rows = visualRows();
  const visualMatch = rows.findIndex((row) => row.sourceRow === currentMatch
    && row.startColumn <= currentMatchColumn
    && row.endColumn >= currentMatchColumn);
  scrollOffset = visualMatch >= 0 ? visualMatch : Math.max(0, rows.findIndex((row) => row.sourceRow === currentMatch));
  horizontalOffset = wrapping() ? 0 : Math.max(0, currentMatchColumn - contentGutterColumns);
  statusMessage = `Match ${found.findIndex((match) => match.row === currentMatch) + 1} of ${found.length}`;
}
async function loadMode(mode) {
  const generation = ++loadGeneration;
  activeMode = mode;
  activeEmbeddedAction = undefined;
  clearTimeout(embeddedResizeTimer);
  loading = true;
  statusMessage = `Loading ${mode}…`;
  render();
  try {
    const result = mode === "diff"
      ? await loadDiff({ repoRoot, filePath, descriptor, metadata, maxOutputBytes: config.limits.maxDiffBytes })
      : await loadRaw({ repoRoot, filePath, descriptor, metadata, maxFileBytes: config.limits.maxFileBytes });
    if (generation !== loadGeneration) return;
    assertPreviewLineLimit(result.text);
    revisionLabel = safe(result.revision);
    const lines = mode === "diff"
      ? diffLines(result.text)
      : result.text.replace(/\n$/, "").split("\n").map((line, index) => `${C.dim}${String(index + 1).padStart(5)}${C.reset}  ${safe(line)}`);
    setContent(lines, mode === "raw" ? 7 : contentGutterColumns);
    cachedMatchesQuery = null;
    cachedMatches = [];
    scrollOffset = 0;
    horizontalOffset = 0;
    statusMessage = mode === "diff" ? comparisonLabel() : `${descriptorLabel()} · ${revisionLabel}`;
  } catch (error) {
    if (generation !== loadGeneration) return;
    setContent([`${C.red}${safe(error.message)}${C.reset}`, "", `${C.dim}Press 1 or 2 to retry another view.${C.reset}`], 0);
    cachedMatchesQuery = null;
    cachedMatches = [];
    statusMessage = error.kind === "oversized"
      ? "Preview is larger than the configured safety limit"
      : error.kind === "too-many-lines" ? "Preview exceeds the terminal line safety limit" : "Preview failed";
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
  const executable = launchExecutable(configValue);
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
  const raw = await loadRawBytes({ repoRoot, filePath, descriptor, metadata, maxFileBytes: config.limits.maxFileBytes });
  if (fs.existsSync(copy)) fs.chmodSync(copy, 0o600);
  fs.writeFileSync(copy, raw.bytes, { mode: 0o600 });
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
function embeddedViewerReadsStdin(viewer) {
  return path.basename(viewer.client || "").toLowerCase().replace(/\.exe$/, "") === "glow";
}
function embeddedArguments(viewer, width, sourcePath = "") {
  const args = (viewer.args || []).map((argument) => argument.replaceAll("{width}", String(width)));
  return sourcePath ? [...args, sourcePath] : args;
}
async function loadEmbeddedViewer(viewer, key, { resized = false } = {}) {
  const generation = ++loadGeneration;
  const mode = `viewer-${key}`;
  const previousRows = visualRows();
  const previousMaximum = Math.max(1, previousRows.length - 1);
  const previousRatio = scrollOffset / previousMaximum;
  activeMode = mode;
  activeEmbeddedAction = { viewer, key };
  if (!wrapByMode.has(mode)) wrapByMode.set(mode, true);
  loading = true;
  statusMessage = `Rendering ${safe(viewer.label || path.basename(viewer.client))}…`;
  render();
  try {
    const readsStdin = embeddedViewerReadsStdin(viewer);
    const raw = readsStdin
      ? await loadRawBytes({ repoRoot, filePath, descriptor, metadata, maxFileBytes: config.limits.maxFileBytes })
      : null;
    const sourcePath = readsStdin ? "" : await sourceForLaunch(false, true);
    const executable = launchExecutable(viewer);
    const result = await runCommand(executable, embeddedArguments(viewer, bodyWidth(), sourcePath), {
      cwd: repoRoot,
      timeoutMs: 15_000,
      maxOutputBytes: Math.min(16 * 1024 * 1024, Math.max(1024 * 1024, config.limits.maxFileBytes * 2)),
      stdinInput: raw?.bytes,
    });
    if (generation !== loadGeneration) return;
    assertPreviewLineLimit(result.stdout);
    const lines = result.stdout.replace(/\n$/, "").split("\n").map((line) => sanitizeRendererAnsi(line));
    while (lines.length && !stripAnsi(lines[0]).trim()) lines.shift();
    while (lines.length && !stripAnsi(lines.at(-1)).trim()) lines.pop();
    setContent(lines.length ? lines : [`${C.dim}Renderer returned no content.${C.reset}`], 0);
    cachedMatchesQuery = null;
    cachedMatches = [];
    horizontalOffset = 0;
    scrollOffset = resized ? Math.round(previousRatio * Math.max(0, visualRows().length - 1)) : 0;
    statusMessage = `${safe(viewer.label || path.basename(viewer.client))} · ${descriptorLabel()} · ${revisionLabel || "exact revision"}`;
  } catch (error) {
    if (generation !== loadGeneration) return;
    setContent([
      `${C.red}${safe(error.message)}${C.reset}`,
      "",
      `${C.dim}Press 2 for wrapped Raw or update the viewer configuration.${C.reset}`,
    ], 0);
    scrollOffset = 0;
    horizontalOffset = 0;
    statusMessage = error.kind === "oversized" ? "Rendered output exceeded the safety limit" : "Markdown rendering failed";
  } finally {
    if (generation === loadGeneration) { loading = false; render(); }
  }
}
async function launchViewer(viewer, key) {
  if (!viewer) { statusMessage = "No viewer is configured for this file"; render(); return; }
  if (!executableAvailable(viewer)) {
    const client = path.basename(viewer.client);
    statusMessage = client.toLocaleLowerCase() === "glow"
      ? "Glow is not installed · install glow or set autoOpen to false"
      : `${client || "Viewer"} is not available · install it or update viewer config`;
    render();
    return;
  }
  if (clientMode(viewer) === "embedded") return loadEmbeddedViewer(viewer, key);
  const label = viewer.label || `View with ${path.basename(viewer.client)}`;
  try { launch(viewer, await sourceForLaunch(false, true), label); }
  catch (error) { statusMessage = `Viewer source unavailable: ${safe(error.message)}`; }
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
  const modes = [
    ["diff", "1 Diff", () => void loadMode("diff")],
    ["raw", "2 Raw", () => void loadMode("raw")],
    ...viewerActions.map(({ key, viewer }) => [
      `viewer-${key}`,
      `${key} ${safe(viewer.label || `View with ${path.basename(viewer.client)}`)}`,
      () => void launchViewer(viewer, key),
    ]),
  ];
  const editorMode = clientMode(config.editor);
  if (editorMode !== "disabled") modes.push([
    "editor",
    `e Open ${editorMode === "terminal" ? "in" : "with"} ${safe(path.basename(config.editor.client))}`,
    () => void launchEditor(),
  ]);
  hitTargets = [];
  const lines = [];
  let line = "";
  let column = 1;
  for (const [mode, label, action] of modes) {
    const text = ` ${label} `;
    if (line && column + visibleLength(text) - 1 > width) {
      lines.push(fit(line, width));
      line = "";
      column = 1;
    }
    line += mode === activeMode ? `${C.selected}${C.gold}${C.bold}${text}${C.reset}` : `${C.dim}${text}${C.reset}`;
    hitTargets.push({ row: 4 + lines.length, x1: column, x2: Math.min(width, column + visibleLength(text) - 1), action });
    column += visibleLength(text);
  }
  if (line || !lines.length) lines.push(fit(line, width));
  return lines;
}
function render() {
  const width = terminalWidth();
  const height = terminalHeight();
  const viewportWidth = bodyWidth();
  const rows = visualRows();
  if (wrapping()) horizontalOffset = 0;
  horizontalOffset = Math.max(0, Math.min(horizontalOffset, Math.max(0, maximumContentWidth - viewportWidth)));
  const horizontal = !wrapping() && maximumContentWidth > viewportWidth ? `↔ col ${horizontalOffset + 1} · ` : "";
  const search = searchActive ? `⌕ ${safe(searchQuery)}▏  ${matchLabel()}` : `${horizontal}${loading ? `${descriptorLabel()} · loading` : activeMode === "diff" ? comparisonLabel() : `${descriptorLabel()} · ${revisionLabel || "ready"}`}`;
  const header = [
    `${C.gold}${C.bold}◆ HERDR GITRAIL PREVIEW${C.reset}  ${C.dim}read-only${C.reset}`,
    fit(`${C.bold}${safe(filePath) || "No file selected"}${C.reset}`, width),
    fit(`${C.dim}${search}${C.reset}`, width),
    ...renderTabs(width),
    `${C.faint}${"─".repeat(width)}${C.reset}`,
  ];
  const horizontalHelp = !wrapping() && maximumContentWidth > viewportWidth ? " · ←/→ horizontal" : "";
  const footer = [
    `${C.faint}${"─".repeat(width)}${C.reset}`,
    `${C.dim}${fit(safe(statusMessage), width)}${C.reset}`,
    `${C.dim}${fit(`w wrap:${wrapping() ? "on" : "off"} · j/k scroll · PgUp/PgDn${horizontalHelp} · / search · q close`, width)}${C.reset}`,
  ];
  const bodyHeight = Math.max(1, height - header.length - footer.length);
  visibleBodyRows = bodyHeight;
  const maximumScrollOffset = Math.max(0, rows.length - bodyHeight);
  scrollOffset = Math.max(0, Math.min(scrollOffset, maximumScrollOffset));
  const fixedColumns = Math.min(contentGutterColumns, Math.max(0, viewportWidth - 4));
  const body = rows.slice(scrollOffset, scrollOffset + bodyHeight).map((row) => {
    if (wrapping()) return row.text;
    if (!fixedColumns || !horizontalOffset) return sliceAnsiTerminalColumns(row.text, horizontalOffset, viewportWidth);
    const gutter = sliceAnsiTerminalColumns(row.text, 0, fixedColumns);
    const text = sliceAnsiTerminalColumns(row.text, fixedColumns + horizontalOffset, viewportWidth - fixedColumns);
    return `${gutter}${text}`;
  });
  while (body.length < bodyHeight) body.push("");
  if (maximumScrollOffset > 0) {
    const thumbOffset = Math.round((scrollOffset / maximumScrollOffset) * Math.max(0, bodyHeight - 1));
    body[thumbOffset] = `${padAnsiTerminalColumns(body[thumbOffset], viewportWidth)}${C.gold}▐${C.reset}`;
  }
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
  clearTimeout(renderTimer);
  clearTimeout(embeddedResizeTimer);
  if (temporaryDirectory) { try { fs.rmSync(temporaryDirectory, { recursive: true, force: true }); } catch {} temporaryDirectory = ""; }
  process.stdout.write(`${ESC}?1000l${ESC}?1006l${ESC}?25h${ESC}?1049l`);
}
function quit() { cleanup(); process.exit(0); }

process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}?1000h${ESC}?1006h`);
process.stdin.setEncoding("utf8");
process.stdin.setRawMode?.(true);
process.stdin.resume();
function handleInput(key) {
  if (key === "\u0003" || (!searchActive && (key === "q" || key === "\u001b"))) return quit();
  const match = key.match(/^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (match) {
    const button = Number(match[1]); const column = Number(match[2]); const row = Number(match[3]); const phase = match[4];
    if (button === 64 && phase === "M") scrollOffset -= 3;
    if (button === 65 && phase === "M") scrollOffset += 3;
    if (button === 0 && phase === "M") hitTargets.find((target) => target.row === row && column >= target.x1 && column <= target.x2)?.action();
    scheduleRender();
    return;
  }
  if (searchActive) {
    if (key === "\u001b" || key === "\r" || key === "\n") { searchActive = false; if (searchQuery) moveMatch(1); }
    else {
      const previousQuery = searchQuery;
      if (key === "\u007f" || key === "\b") searchQuery = [...searchQuery].slice(0, -1).join("");
      else if (key === "\u0015") searchQuery = "";
      else searchQuery += key.replace(/\u001b\[[0-9;]*[A-Za-z~]/g, "").replace(/[\x00-\x1f\x7f]/g, "");
      if (searchQuery !== previousQuery) { currentMatch = -1; currentMatchColumn = 0; }
    }
  } else {
    if (key === "1") void loadMode("diff");
    if (key === "2") void loadMode("raw");
    const viewerAction = viewerActions.find((action) => action.key === key);
    if (viewerAction) void launchViewer(viewerAction.viewer, viewerAction.key);
    if (key === "\t") void loadMode(activeMode === "diff" ? "raw" : "diff");
    if (key === "e") void launchEditor();
    if (key === "/") searchActive = true;
    if (key === "n") moveMatch(1);
    if (key === "N") moveMatch(-1);
    if (key === "j" || key === "\u001b[B") scrollOffset += 1;
    if (key === "k" || key === "\u001b[A") scrollOffset -= 1;
    const pageRows = visibleBodyRows;
    if (key === "\u001b[6~") scrollOffset += pageRows;
    if (key === "\u001b[5~") scrollOffset -= pageRows;
    if (key === "\u0004") scrollOffset += Math.max(1, Math.floor(pageRows / 2));
    if (key === "\u0015") scrollOffset -= Math.max(1, Math.floor(pageRows / 2));
    if (key === "g") scrollOffset = 0;
    if (key === "G") scrollOffset = visualRows().length;
    if (key === "w") {
      invalidateLayout({ preserveAnchor: true });
      wrapByMode.set(activeMode, !wrapping());
      if (wrapping()) horizontalOffset = 0;
      statusMessage = wrapping() ? "Word wrap enabled" : "Word wrap disabled";
    }
    if (!wrapping() && key === "\u001b[D") horizontalOffset = Math.max(0, horizontalOffset - 8);
    if (!wrapping() && key === "\u001b[C") horizontalOffset += 8;
  }
  scheduleRender();
}
const inputDecoder = createTerminalInputDecoder(handleInput);
process.stdin.on("data", (key) => inputDecoder.push(key));
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
process.on("exit", cleanup);
process.stdout.on("resize", () => {
  invalidateLayout({ preserveAnchor: true });
  scheduleRender();
  if (!activeEmbeddedAction) return;
  clearTimeout(embeddedResizeTimer);
  embeddedResizeTimer = setTimeout(() => void loadEmbeddedViewer(
    activeEmbeddedAction.viewer,
    activeEmbeddedAction.key,
    { resized: true },
  ), 150);
});
render();
void loadMode(activeMode).then(() => {
  for (const { key, viewer } of viewerActions) if (viewer.autoOpen) void launchViewer(viewer, key);
});
