#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFixtureRepository, removeFixtureRepository } from "../src/fixture.mjs";
import { getCommitFiles, getRepositoryState } from "../src/git-provider.mjs";
import { resolveHerdrTabCwd } from "../src/herdr-context.mjs";
import { displayState, filesAgainstBase, selectionKey } from "../src/model.mjs";
import { runCommand } from "../src/process.mjs";
import {
  compactTerminalPath,
  commitExpansionState,
  createLatestSerialQueue,
  createTerminalInputDecoder,
  fitAnsiTerminalColumns,
  padAnsiTerminalColumns,
  previewTabName,
  revealScrollOffset,
  sanitizeTerminalText,
  terminalColumns,
  truncateTerminalColumns,
  validPollInterval,
  startupFailureState,
} from "../src/terminal-ui.mjs";
import { compactAge, compareFolderGroups } from "../src/tui-format.mjs";

const ESC = "\u001b[";
const rgb = (r, g, b) => `${ESC}38;2;${r};${g};${b}m`;
const bg = (r, g, b) => `${ESC}48;2;${r};${g};${b}m`;
const C = {
  reset: `${ESC}0m`, bold: `${ESC}1m`, dim: `${ESC}2m`,
  gold: rgb(214, 176, 91), leaf: rgb(91, 190, 112), red: rgb(224, 108, 117),
  amber: rgb(229, 180, 84), blue: rgb(105, 169, 230), purple: rgb(190, 132, 220),
  fog: rgb(139, 139, 139), faint: rgb(84, 84, 84), selected: bg(45, 41, 34),
};
const cliArgs = new Set(process.argv.slice(2));
const snapshotMode = cliArgs.has("--snapshot");
const demoMode = cliArgs.has("--demo") || process.env.GIT_RAIL_DEMO === "1";
const forcedWidth = numberArg("--width");
const forcedHeight = numberArg("--height");
const initialSearch = stringArg("--search");
const PAGE_SIZE = 100;
const NARROW_RAIL_MAX = 88;

function numberArg(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? NaN : Number.parseInt(process.argv[index + 1] || "", 10);
  return Number.isFinite(value) ? value : null;
}
function stringArg(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : String(process.argv[index + 1] || "");
}
function safe(value) { return sanitizeTerminalText(value); }
function visibleLength(value) { return terminalColumns(value); }
function truncate(value, width) { return truncateTerminalColumns(value, width); }
function fitAnsi(value, width) { return fitAnsiTerminalColumns(value, width); }
function padAnsi(value, width) { return padAnsiTerminalColumns(value, width); }
function compactPath(value, width) { return compactTerminalPath(value, width); }
function parseContext() {
  try { return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}"); } catch { return {}; }
}

const context = parseContext();
const initialCwd = process.env.GIT_RAIL_REPO_ROOT || context.focused_pane_cwd || context.workspace_cwd || process.env.HERDR_WORKSPACE_CWD || process.cwd();
let sourcePaneId = process.env.GIT_RAIL_SOURCE_PANE_ID || context.focused_pane_id || "";
let fixtureRoot = demoMode ? await createFixtureRepository() : "";
let currentProviderCwd = initialCwd;
let currentWorkspaceId = process.env.HERDR_WORKSPACE_ID || context.workspace_id || "";
async function liveProviderCwd() {
  if (demoMode) return fixtureRoot;
  const resolved = await resolveHerdrTabCwd({
    run: runCommand,
    herdr: process.env.HERDR_BIN_PATH || "herdr",
    workspaceId: currentWorkspaceId,
    railPaneId: process.env.HERDR_PANE_ID || "",
    sourcePaneId,
    fallbackCwd: currentProviderCwd,
  });
  sourcePaneId = resolved.sourcePaneId;
  currentWorkspaceId = resolved.workspaceId || currentWorkspaceId;
  currentProviderCwd = resolved.cwd || currentProviderCwd;
  return currentProviderCwd;
}
currentProviderCwd = fixtureRoot || await liveProviderCwd();
let state;
try { state = await getRepositoryState(currentProviderCwd); }
catch (error) { state = startupFailureState(currentProviderCwd, error); }
if (demoMode) state.repository = "gitrail-fixture";
let mainTab = cliArgs.has("--files") ? "files" : "changes";
let viewModePreference = "auto";
let selectedSection = 0;
let scrollOffset = 0;
let selectedIdentity = "";
let revealSelected = false;
let keyboardItems = [];
let statusMessage = state.configErrors?.[0] || "Click a section or file";
let fileSearchQuery = "";
let diffSearchQuery = initialSearch;
let activeSearch = "";
let hitTargets = [];
let lastClick = { label: "", at: 0 };
let refreshGeneration = 0;
let refreshRunning = false;
let refreshVisible = false;
let refreshQueued = false;
let refreshTimer;
let watchTimer;
let renderTimer;
let statusTimer;
let transientRestoreStatus = "";
let transientStatusMessage = "";
let watchers = [];
let invalidationRepoRoot = "";
const expanded = { against: false, commits: false, staged: true, unstaged: true };
const sectionIds = ["against", "commits", "staged", "unstaged"];
const collapsedGroups = new Set();
const collapsedFolders = new Map();
const expandedCommits = new Set();
const commitFiles = new Map();
const pageSizes = new Map();

function interactive(text, onClick, label, onDoubleClick = null) { return { text, onClick, label, onDoubleClick }; }
function regions(text, targets) { return { text, targets }; }
function textOf(line) { return typeof line === "string" ? line : line.text; }
function showTransientStatus(message, durationMs = 1_500) {
  if (!statusTimer || statusMessage !== transientStatusMessage) transientRestoreStatus = statusMessage;
  clearTimeout(statusTimer);
  statusMessage = message;
  transientStatusMessage = message;
  statusTimer = setTimeout(() => {
    statusTimer = undefined;
    if (statusMessage === message) {
      statusMessage = transientRestoreStatus;
      draw();
    }
    transientRestoreStatus = "";
    transientStatusMessage = "";
  }, durationMs);
  statusTimer.unref();
}
function resolvedViewMode(width) { return viewModePreference === "auto" ? (width <= NARROW_RAIL_MAX ? "grouped" : "tree") : viewModePreference; }
function toggleViewMode(width) {
  viewModePreference = resolvedViewMode(width) === "tree" ? "grouped" : "tree";
  statusMessage = `Layout: ${viewModePreference === "tree" ? "Tree" : "Folders"}`;
}
function statusGlyph(file) {
  const status = file.status || displayState(file).status;
  if (status === "clean") return `${C.fog}${file.descriptor?.kind === "filesystem" ? "⊠" : "□"}${C.reset}`;
  if (file.binary) return `${C.purple}◆${C.reset}`;
  if (status === "added") return `${C.leaf}⊞${C.reset}`;
  if (status === "deleted") return `${C.red}⊟${C.reset}`;
  if (status === "renamed") return `${C.blue}↪${C.reset}`;
  if (status === "copied") return `${C.purple}⧉${C.reset}`;
  if (status === "conflicted") return `${C.red}!${C.reset}`;
  if (status === "type-changed") return `${C.blue}◇${C.reset}`;
  return `${C.amber}⊡${C.reset}`;
}
function statsLabel(file) {
  if ((file.status || displayState(file).status) === "clean") return "";
  if (file.statsUnavailable) return `${C.dim}?${C.reset}`;
  if (file.binary) return `${C.purple}binary${C.reset}`;
  const additions = file.additions > 0 ? `${C.leaf}+${file.additions}${C.reset}` : "";
  const deletions = file.deletions > 0 ? `${C.red}−${file.deletions}${C.reset}` : "";
  return [additions, deletions].filter(Boolean).join(" ");
}
function rule(width) { return `${C.faint}${"─".repeat(width)}${C.reset}`; }
function tab(label, active, width) {
  const line = padAnsi(` ${label} `, width);
  return active ? `${C.selected}${C.gold}${C.bold}${line}${C.reset}` : `${C.dim}${line}${C.reset}`;
}
function searchField(query, active, placeholder, count, width) {
  const countText = count ? `${C.dim}${count}${C.reset}` : "";
  const fieldWidth = Math.max(8, width - visibleLength(countText) - (countText ? 1 : 0));
  const cleanQuery = safe(query);
  const value = active ? `${cleanQuery}▏` : cleanQuery || placeholder;
  const tone = active ? C.gold : query ? C.bold : C.dim;
  return `${C.selected}${tone}${padAnsi(` ⌕ ${truncate(value, Math.max(1, fieldWidth - 4))}`, fieldWidth)}${C.reset}${countText ? ` ${countText}` : ""}`;
}
function treeGuides(depth, width) { return `${C.faint}${(width <= 46 ? "│" : "│ ").repeat(depth)}${C.reset}`; }

function page(files, scope) {
  const limit = pageSizes.get(scope) || PAGE_SIZE;
  return { visible: files.slice(0, limit), remaining: Math.max(0, files.length - limit) };
}
function showMoreRow(scope, remaining) {
  if (!remaining) return [];
  return [interactive(
    `${C.gold}  Show ${Math.min(PAGE_SIZE, remaining)} more${C.reset}  ${C.dim}(${remaining} remaining)${C.reset}`,
    () => { pageSizes.set(scope, (pageSizes.get(scope) || PAGE_SIZE) + PAGE_SIZE); statusMessage = `Loaded more ${scope}`; },
    `Show more ${scope}`,
  )];
}
function buildTree(files, collapsed) {
  const root = { children: new Map() };
  for (const file of files) {
    let node = root;
    file.path.split("/").forEach((part, index, parts) => {
      if (!node.children.has(part)) node.children.set(part, { name: part, file: index === parts.length - 1 ? file : null, children: new Map() });
      node = node.children.get(part);
    });
  }
  const rows = [];
  const visit = (node, depth, parent = "") => {
    const children = [...node.children.values()].sort((a, b) => Boolean(a.file) - Boolean(b.file) || a.name.localeCompare(b.name));
    for (const child of children) {
      const nodePath = parent ? `${parent}/${child.name}` : child.name;
      if (child.file) rows.push({ kind: "file", depth, file: child.file, name: child.name });
      else {
        rows.push({ kind: "folder", depth, path: nodePath, name: child.name });
        if (!collapsed.has(nodePath)) visit(child, depth + 1, nodePath);
      }
    }
  };
  visit(root, 0);
  return rows;
}
function selectFile(file) {
  selectedIdentity = selectionKey(state.repoRoot || state.cwd, file);
  revealSelected = true;
  statusMessage = file.statsUnavailable
    ? `${descriptorLabel(file.descriptor)} · ${file.path} · ? stats unavailable (inspection budget)`
    : `${descriptorLabel(file.descriptor)} · ${file.path}`;
}
function selectKeyboardItem(item) {
  if (item.file) selectFile(item.file);
  else {
    selectedIdentity = item.identity;
    revealSelected = true;
    statusMessage = item.status;
  }
}
function descriptorLabel(descriptor = { kind: "clean" }) {
  if (descriptor.kind === "workspace") return `Against ${safe(descriptor.baseRef)}`;
  if (descriptor.kind === "against") return `Against ${safe(descriptor.baseRef)}`;
  if (descriptor.kind === "commit") return `Commit ${safe(descriptor.commitHash).slice(0, 8)}`;
  const kind = safe(descriptor.kind || "file");
  return kind[0].toUpperCase() + kind.slice(1);
}
function fileRow(file, width, prefix = " ") {
  const stats = statsLabel(file);
  const suffix = stats;
  const available = Math.max(1, width - visibleLength(prefix) - 2 - visibleLength(suffix) - (suffix ? 1 : 0));
  const body = `${prefix}${statusGlyph(file)} ${truncate(safe(path.basename(file.path)), available)}`;
  const line = suffix ? `${padAnsi(body, width - visibleLength(suffix) - 1)} ${suffix}` : body;
  const identity = selectionKey(state.repoRoot || state.cwd, file);
  keyboardItems.push({
    identity,
    file,
    status: `${descriptorLabel(file.descriptor)} · ${file.path}`,
    action: () => void requestPreview(file),
  });
  const row = interactive(
    identity === selectedIdentity ? `${C.selected}${padAnsi(line, width)}${C.reset}` : fitAnsi(line, width),
    () => selectFile(file),
    `Select ${descriptorLabel(file.descriptor)}: ${file.path}`,
    () => void requestPreview(file),
  );
  row.keyboardIdentity = identity;
  return row;
}
function renderTree(files, width, scope) {
  if (!collapsedFolders.has(scope)) collapsedFolders.set(scope, new Set());
  const paged = page(files, scope);
  const collapsed = collapsedFolders.get(scope);
  const rows = buildTree(paged.visible, collapsed).map((row) => {
    const guides = treeGuides(row.depth, width);
    if (row.kind === "file") return fileRow(row.file, width, ` ${guides}`);
    const open = !collapsed.has(row.path);
    return interactive(fitAnsi(` ${guides}${C.fog}${open ? "⌄" : "›"} ${safe(row.name)}/${C.reset}`, width), () => {
      if (open) collapsed.add(row.path); else collapsed.delete(row.path);
      statusMessage = `${open ? "Collapsed" : "Expanded"} ${safe(row.path)}`;
    }, `${open ? "Collapse" : "Expand"} folder: ${row.path}`);
  });
  return [...rows, ...showMoreRow(scope, paged.remaining)];
}
function renderGrouped(files, width, scope) {
  const paged = page(files, scope);
  const groups = new Map();
  for (const file of paged.visible) {
    const folder = path.dirname(file.path) === "." ? "" : path.dirname(file.path);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(file);
  }
  const lines = [];
  for (const [folder, entries] of [...groups.entries()].sort(compareFolderGroups)) {
    if (!folder) {
      lines.push(...entries.sort((a, b) => a.path.localeCompare(b.path)).map((file) => fileRow(file, width)));
      continue;
    }
    const key = `${scope}:${folder}`;
    const open = !collapsedGroups.has(key);
    lines.push(interactive(
      `${C.fog} ${open ? "⌄" : "›"} ${compactPath(folder, Math.max(5, width - 8))}${C.reset} ${C.dim}${entries.length}${C.reset}`,
      () => { if (open) collapsedGroups.add(key); else collapsedGroups.delete(key); },
      `${open ? "Collapse" : "Expand"} folder: ${folder}`,
    ));
    if (open) entries.sort((a, b) => a.path.localeCompare(b.path)).forEach((file, index) => {
      lines.push(fileRow(file, width, `  ${C.faint}${index === entries.length - 1 ? "└─" : "├─"}${C.reset} `));
    });
  }
  return [...lines, ...showMoreRow(scope, paged.remaining)];
}
function renderFilesList(files, width, scope) { return resolvedViewMode(width) === "tree" ? renderTree(files, width, scope) : renderGrouped(files, width, scope); }
function search(files, rawQuery) {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return files;
  return files.filter((file) => file.path.toLocaleLowerCase().includes(query)).sort((a, b) => a.path.localeCompare(b.path));
}
function searchCommits(commits, rawQuery) {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return commits.map((commit) => ({ ...commit, summaryMatch: false, matchingPaths: [] }));
  return commits.flatMap((commit) => {
    const summary = [commit.hash, commit.shortHash, commit.message, commit.author, commit.age, compactAge(commit.age)]
      .filter(Boolean)
      .join("\n")
      .toLocaleLowerCase();
    const matchingPaths = (state.commitPathIndex?.get(commit.hash) || [])
      .filter((filePath) => filePath.toLocaleLowerCase().includes(query));
    const summaryMatch = summary.includes(query);
    return summaryMatch || matchingPaths.length ? [{ ...commit, summaryMatch, matchingPaths }] : [];
  });
}
function toolbar(width) {
  const layout = resolvedViewMode(width) === "tree" ? "≡ Tree" : "≣ Folders";
  const refresh = refreshVisible ? "↻ Refreshing…" : "↻ Refresh";
  const text = ` ${C.gold}${layout}${C.reset}   ${C.fog}${refresh}${C.reset}`;
  return regions(fitAnsi(text, width), [
    { x1: 1, x2: 1 + visibleLength(layout), action: () => toggleViewMode(width), label: "Toggle layout" },
    { x1: 5 + visibleLength(layout), x2: 4 + visibleLength(layout) + visibleLength(refresh), action: () => void refreshState(true), label: "Refresh" },
  ]);
}
function sectionHeader(id, label, count, index, width, forced = false) {
  const open = forced || expanded[id];
  const marker = selectedSection === index ? `${C.gold}▏${C.reset}` : " ";
  return interactive(fitAnsi(`${marker}${open ? "⌄" : "›"} ${label}  ${C.dim}${count}${C.reset}`, width), () => {
    selectedSection = index;
    if (!forced) expanded[id] = !expanded[id];
  }, `${open ? "Collapse" : "Expand"} ${label}`);
}
function renderChanges(width) {
  const query = diffSearchQuery.trim();
  const sections = [
    { id: "against", label: `Against ${safe(width < 36 ? String(state.baseLabel).split("/").at(-1) : state.baseLabel)}`, files: search(state.againstBase || [], query) },
    { id: "commits", label: "Commits", commits: searchCommits(state.commits || [], query) },
    { id: "staged", label: "Staged", files: search(state.staged || [], query) },
    { id: "unstaged", label: "Unstaged", files: search(state.unstaged || [], query) },
  ];
  const matchCount = sections.reduce((sum, item) => {
    if (item.files) return sum + item.files.length;
    return sum + item.commits.reduce((commitSum, commit) => commitSum + (commit.summaryMatch ? 1 : 0) + commit.matchingPaths.length, 0);
  }, 0);
  const resultCount = `${matchCount} result${matchCount === 1 ? "" : "s"}`;
  const lines = [
    interactive(searchField(diffSearchQuery, activeSearch === "changes", "Search changes & commits…", query ? resultCount : "", width), () => { activeSearch = "changes"; }, "Search changes and commits"),
    toolbar(width), rule(width),
  ];
  if (state.historyTruncated) lines.push(` ${C.dim}Commit history: newest ${state.commits.length} of ${state.totalCommits}${C.reset}`);
  if (query && state.historyPathsAvailable === false) lines.push(` ${C.dim}Commit path search unavailable; searching summaries only${C.reset}`);
  if (query && !matchCount) return [...lines, ` ${C.dim}No changes or commits match “${truncate(safe(diffSearchQuery), Math.max(4, width - 31))}”${C.reset}`];
  if (!query && sections.every((section) => !(section.files?.length || section.commits?.length))) {
    return [...lines, ` ${C.dim}No changes against ${safe(state.baseLabel)} · working tree clean${C.reset}`];
  }
  sections.forEach((section, index) => {
    const count = section.files?.length ?? (query
      ? section.commits.length
      : state.historyTruncated ? `${state.commits.length}/${state.totalCommits}` : state.totalCommits);
    if (!count) return;
    const forced = Boolean(query);
    lines.push(sectionHeader(section.id, section.label, count, index, width, forced));
    if (!forced && !expanded[section.id]) return;
    if (section.files) {
      lines.push(...renderFilesList(section.files, width, `${section.id}:${query}`));
      return;
    }
    const paged = page(section.commits, `commits:${query}`);
    for (const commit of paged.visible) {
      const manuallyOpen = expandedCommits.has(commit.hash);
      const expansion = commitExpansionState(query, commit.matchingPaths, manuallyOpen, commitFiles.has(commit.hash));
      const open = expansion.open;
      const age = safe(compactAge(commit.age));
      const prefix = ` ${C.faint}${open ? "⌄" : "›"}${C.reset} ${C.gold}${safe(commit.shortHash)}${C.reset} `;
      const identity = `commit:${commit.hash}`;
      const line = `${prefix}${truncate(safe(commit.message), Math.max(3, width - visibleLength(prefix) - age.length - 1))} ${C.dim}${age}${C.reset}`;
      const keyboardItem = {
        identity,
        status: `Commit ${safe(commit.shortHash)} · ${safe(commit.message)}`,
        action: () => void toggleCommit(commit),
      };
      keyboardItems.push(keyboardItem);
      const row = interactive(
        identity === selectedIdentity ? `${C.selected}${padAnsi(line, width)}${C.reset}` : fitAnsi(line, width),
        () => { selectKeyboardItem(keyboardItem); void toggleCommit(commit); },
        `${open ? "Collapse" : "Expand"} commit ${safe(commit.shortHash)}`,
      );
      row.keyboardIdentity = identity;
      lines.push(row);
      if (!open) continue;
      if (query) {
        const loaded = commitFiles.get(commit.hash);
        const matchingFiles = loaded
          ? expansion.showAllFiles ? loaded : search(loaded, query)
          : commit.matchingPaths.map((filePath) => ({ path: filePath, status: "modified", additions: 0, deletions: 0, descriptor: { kind: "commit", commitHash: commit.hash } }));
        if (expansion.loading) lines.push(`   ${C.dim}Loading commit files…${C.reset}`);
        else lines.push(...renderFilesList(matchingFiles, width, `commit:${commit.hash}:${query}`));
      } else if (!commitFiles.has(commit.hash)) lines.push(`   ${C.dim}Loading commit files…${C.reset}`);
      else lines.push(...renderFilesList(commitFiles.get(commit.hash), width, `commit:${commit.hash}`));
    }
    lines.push(...showMoreRow(`commits:${query}`, paged.remaining));
  });
  return lines;
}
function canonicalFiles() {
  return filesAgainstBase(state.files || [], state.workspaceChanges || [], state.workspaceDescriptor);
}
function renderFiles(width) {
  const query = fileSearchQuery.trim();
  const files = search(canonicalFiles(), query);
  const lines = [
    interactive(searchField(fileSearchQuery, activeSearch === "files", "Search files…", query ? `${files.length} matches` : "", width), () => { activeSearch = "files"; }, "Search files"),
    toolbar(width), rule(width),
  ];
  if (!files.length) return [...lines, ` ${C.dim}${query ? `No files match “${truncate(safe(query), width - 19)}”` : state.repoRoot ? "Repository has no files" : "Directory has no files"}${C.reset}`];
  if (state.directoryFilesTruncated) lines.push(` ${C.dim}Showing the first ${(state.files || []).length.toLocaleString("en-US")} files · scan limit reached${C.reset}`);
  return [...lines, ...renderFilesList(files, width, `files:${query}`)];
}
function renderBody(width) {
  keyboardItems = [];
  if (state.error && !state.repoRoot && mainTab === "changes") return ["", `${C.red}${safe(state.error)}${C.reset}`, `${C.dim}${truncate(safe(state.cwd), width)}${C.reset}`, "", "Changes requires Git · Files remains available."];
  return mainTab === "changes" ? renderChanges(width) : renderFiles(width);
}
function renderHeader(width) {
  const half = Math.floor(width / 2);
  return { half, lines: [
    ` ${C.bold}${truncate(safe(state.repository || "repository"), width - 1)}${C.reset}`,
    `  ${C.fog}⑂ ${truncate(safe(state.branch || "—"), width - 4)}${C.reset}`,
    rule(width),
    `${tab("CHANGES", mainTab === "changes", half)}${tab("FILES", mainTab === "files", width - half)}`,
  ] };
}
function renderFrame() {
  const width = Math.max(24, forcedWidth || process.stdout.columns || 52);
  const height = Math.max(18, forcedHeight || process.stdout.rows || 42);
  const { half, lines: header } = renderHeader(width);
  const body = renderBody(width);
  const controls = activeSearch ? "type to filter · Enter done · Esc close · Ctrl-U clear" : "j/k select · Enter open · h/l section · / search · q";
  const footerMessage = statusMessage && statusMessage !== "Click a section or file" ? statusMessage : controls;
  const footer = [rule(width), `${C.dim}${fitAnsi(safe(footerMessage), width)}${C.reset}`];
  const fixedCount = mainTab === "files" ? 3 + (state.directoryFilesTruncated ? 1 : 0) : state.repoRoot ? 3 : 0;
  const bodyHeight = Math.max(1, height - header.length - footer.length);
  const fixed = body.slice(0, Math.min(fixedCount, bodyHeight));
  const scrollable = body.slice(fixed.length);
  const visibleHeight = Math.max(0, bodyHeight - fixed.length);
  if (revealSelected) {
    const selectedRow = scrollable.findIndex((entry) => typeof entry !== "string" && entry.keyboardIdentity === selectedIdentity);
    scrollOffset = revealScrollOffset(selectedRow, scrollOffset, visibleHeight, scrollable.length);
    revealSelected = false;
  }
  scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, scrollable.length - visibleHeight)));
  const viewport = [...fixed, ...scrollable.slice(scrollOffset, scrollOffset + visibleHeight)];
  while (viewport.length < bodyHeight) viewport.push("");
  hitTargets = [
    { row: 4, x1: 1, x2: half, label: "Changes", action: () => { mainTab = "changes"; activeSearch = ""; scrollOffset = 0; } },
    { row: 4, x1: half + 1, x2: width, label: "Files", action: () => { mainTab = "files"; activeSearch = ""; scrollOffset = 0; } },
  ];
  viewport.forEach((entry, index) => {
    if (typeof entry === "string") return;
    const row = header.length + index + 1;
    if (entry.targets) entry.targets.forEach((target) => hitTargets.push({ row, ...target }));
    if (entry.onClick) hitTargets.push({ row, x1: 1, x2: width, label: entry.label, action: entry.onClick, doubleAction: entry.onDoubleClick });
  });
  return [...header, ...viewport, ...footer].map((line) => padAnsi(textOf(line), width)).join("\n");
}
function draw() {
  const frame = renderFrame();
  if (snapshotMode) { process.stdout.write(`${frame}\n`); return; }
  const painted = frame.split("\n").map((line) => `${ESC}2K${line}`).join("\r\n");
  process.stdout.write(`${ESC}?2026h${ESC}H${painted}${ESC}?2026l`);
}
function scheduleDraw() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = undefined; draw(); }, 16);
}

async function currentPaneId() {
  if (process.env.HERDR_PANE_ID) return process.env.HERDR_PANE_ID;
  try {
    const result = await runCommand(process.env.HERDR_BIN_PATH || "herdr", ["pane", "current", "--current"], { cwd: currentProviderCwd });
    return JSON.parse(result.stdout)?.result?.pane?.pane_id || "";
  } catch { return ""; }
}
function paneStateFile(workspaceId) {
  const directory = path.join(os.homedir(), ".cache", "herdr-gitrail", "panes");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return path.join(directory, `${workspaceId.replace(/[^A-Za-z0-9._-]/g, "_")}.preview`);
}
async function openPreview(file) {
  if (file.descriptor?.kind === "commit" && !Object.hasOwn(file.descriptor, "parentHash")) {
    try {
      let details = commitFiles.get(file.descriptor.commitHash);
      if (!details) {
        details = await getCommitFiles(state.repoRoot, file.descriptor.commitHash, state.config.limits.maxDiffBytes);
        commitFiles.set(file.descriptor.commitHash, details);
      }
      file = details.find((candidate) => candidate.path === file.path)
        || details.find((candidate) => candidate.oldPath === file.path)
        || file;
    } catch (error) {
      statusMessage = `Commit file details failed: ${error.message}`;
      draw();
      return;
    }
  }
  const herdr = process.env.HERDR_BIN_PATH || "herdr";
  const workspaceId = currentWorkspaceId;
  const selfPaneId = await currentPaneId();
  let stalePaneId = "";
  if (workspaceId) {
    const stateFile = paneStateFile(workspaceId);
    try {
      stalePaneId = fs.readFileSync(stateFile, "utf8").trim();
    } catch {}
  }
  const descriptor = Buffer.from(JSON.stringify(file.descriptor || { kind: "clean" })).toString("base64url");
  const metadata = Buffer.from(JSON.stringify({
    status: file.status,
    oldPath: file.oldPath,
    binary: file.binary,
    submodule: file.submodule,
    symlink: file.symlink,
    oldSubmodule: file.oldSubmodule,
    oldSymlink: file.oldSymlink,
  })).toString("base64url");
  const openArgs = ["plugin", "pane", "open", "--plugin", process.env.HERDR_PLUGIN_ID || "local.git-rail", "--entrypoint", "file-preview", "--placement", "tab",
    "--env", `GIT_RAIL_PREVIEW_PATH=${file.path}`, "--env", `GIT_RAIL_PREVIEW_REPO=${state.repoRoot || state.cwd}`, "--env", `GIT_RAIL_PREVIEW_DESCRIPTOR=${descriptor}`, "--env", `GIT_RAIL_PREVIEW_METADATA=${metadata}`, "--env", `GIT_RAIL_PREVIEW_TEMPORARY=${demoMode ? "1" : "0"}`, "--focus"];
  if (workspaceId) openArgs.push("--workspace", workspaceId);
  try {
    const result = await runCommand(herdr, openArgs, { cwd: currentProviderCwd });
    const payload = JSON.parse(result.stdout);
    const paneId = payload?.result?.plugin_pane?.pane?.pane_id || payload?.result?.pane?.pane_id || payload?.result?.pane_id || "";
    const tabId = payload?.result?.plugin_pane?.pane?.tab_id || payload?.result?.pane?.tab_id || payload?.result?.tab_id || "";
    if (workspaceId && paneId) fs.writeFileSync(paneStateFile(workspaceId), `${paneId}\n`, { mode: 0o600 });
    if (paneId && stalePaneId && stalePaneId !== selfPaneId && stalePaneId !== paneId) {
      try { await runCommand(herdr, ["pane", "close", stalePaneId], { cwd: currentProviderCwd }); } catch {}
    }
    let previewStatus = `Preview opened · ${descriptorLabel(file.descriptor)}`;
    if (tabId) {
      try { await runCommand(herdr, ["tab", "rename", tabId, previewTabName(file.path)], { cwd: currentProviderCwd }); }
      catch (error) { previewStatus += ` · tab name unavailable: ${safe(error.message)}`; }
    }
    showTransientStatus(previewStatus);
  } catch (error) { statusMessage = `Preview failed: ${error.message}`; }
  draw();
}
const requestPreview = createLatestSerialQueue(openPreview);
async function toggleCommit(commit) {
  if (expandedCommits.has(commit.hash)) { expandedCommits.delete(commit.hash); draw(); return; }
  expandedCommits.add(commit.hash);
  draw();
  if (!commitFiles.has(commit.hash)) {
    try { commitFiles.set(commit.hash, await getCommitFiles(state.repoRoot, commit.hash, state.config.limits.maxDiffBytes)); }
    catch (error) { commitFiles.set(commit.hash, []); statusMessage = `Commit files failed: ${error.message}`; }
  }
  draw();
}
async function refreshState(announce = false) {
  if (refreshRunning) { refreshQueued = true; return; }
  refreshRunning = true;
  const generation = ++refreshGeneration;
  let indicatorTimer;
  if (announce) { refreshVisible = true; draw(); }
  else {
    indicatorTimer = setTimeout(() => {
      if (refreshRunning && generation === refreshGeneration) { refreshVisible = true; draw(); }
    }, 150);
  }
  try {
    const providerCwd = fixtureRoot || await liveProviderCwd();
    const previousRepoRoot = state.repoRoot;
    const previousCwd = state.cwd;
    const next = await getRepositoryState(providerCwd);
    if (generation === refreshGeneration) {
      if (demoMode) next.repository = "gitrail-fixture";
      const previousInterval = state.config?.refresh?.pollIntervalMs;
      state = next;
      if (previousRepoRoot !== next.repoRoot || previousCwd !== next.cwd) {
        selectedIdentity = "";
        scrollOffset = 0;
        commitFiles.clear();
        expandedCommits.clear();
        collapsedGroups.clear();
        collapsedFolders.clear();
      }
      if ((state.repoRoot || state.cwd) !== invalidationRepoRoot) startInvalidation();
      else if (refreshTimer && previousInterval !== next.config?.refresh?.pollIntervalMs) resetRefreshTimer();
      if (announce) showTransientStatus("Git state refreshed");
      else if (next.configErrors?.[0]) statusMessage = next.configErrors[0];
    }
  } catch (error) { statusMessage = `Refresh failed: ${error.message} · showing previous state`; }
  finally {
    clearTimeout(indicatorTimer);
    refreshRunning = false;
    refreshVisible = false;
    draw();
    if (refreshQueued) { refreshQueued = false; void refreshState(false); }
  }
}
function startInvalidation() {
  if (demoMode) return;
  const watchRoot = state.repoRoot || state.cwd;
  if (invalidationRepoRoot === watchRoot && refreshTimer) return;
  stopInvalidation();
  invalidationRepoRoot = watchRoot || "";
  const debounce = () => { clearTimeout(watchTimer); watchTimer = setTimeout(() => void refreshState(false), 125); };
  if (watchRoot) {
    try {
      watchers.push(fs.watch(watchRoot, { recursive: process.platform === "darwin" }, (_event, filename) => {
        if (filename && String(filename).startsWith(`.git${path.sep}`)) return;
        debounce();
      }));
    } catch {}
    try { watchers.push(fs.watch(path.join(state.repoRoot, ".git"), { recursive: process.platform === "darwin" }, debounce)); } catch {}
  }
  resetRefreshTimer();
}
function resetRefreshTimer() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => void refreshState(false), validPollInterval(state.config?.refresh?.pollIntervalMs));
  refreshTimer.unref();
}
function stopInvalidation() {
  clearInterval(refreshTimer); refreshTimer = undefined;
  clearTimeout(watchTimer); watchTimer = undefined;
  watchers.forEach((watcher) => watcher.close()); watchers = [];
  invalidationRepoRoot = "";
}
async function cleanup() {
  stopInvalidation(); clearTimeout(renderTimer); clearTimeout(statusTimer);
  if (fixtureRoot) { const root = fixtureRoot; fixtureRoot = ""; await removeFixtureRepository(root); }
  if (!snapshotMode) process.stdout.write(`${ESC}?1000l${ESC}?1006l${ESC}?25h${ESC}?1049l`);
}
async function quit() { await cleanup(); process.exit(0); }

if (snapshotMode) {
  draw();
  await cleanup();
  process.exit(0);
}
process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}?1000h${ESC}?1006h`);
process.stdin.setEncoding("utf8");
process.stdin.setRawMode?.(true);
process.stdin.resume();
function handleInput(key) {
  if (!key) return;
  const match = key.match(/^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (match) {
    const button = Number(match[1]); const column = Number(match[2]); const row = Number(match[3]); const phase = match[4];
    if (button === 64 && phase === "M") scrollOffset = Math.max(0, scrollOffset - 3);
    if (button === 65 && phase === "M") scrollOffset += 3;
    if (button === 0 && phase === "M") {
      const target = hitTargets.find((item) => item.row === row && column >= item.x1 && column <= item.x2);
      if (target) {
        const now = Date.now();
        if (target.doubleAction && lastClick.label === target.label && now - lastClick.at <= 450) { void target.doubleAction(); lastClick = { label: "", at: 0 }; }
        else { target.action(); lastClick = { label: target.label, at: now }; }
      }
    }
    scheduleDraw();
    return;
  }
  if (key === "\u0003" || (!activeSearch && (key === "q" || key === "\u001b"))) { void quit(); return; }
  if (activeSearch) {
    let query = activeSearch === "files" ? fileSearchQuery : diffSearchQuery;
    const searchKind = activeSearch;
    if (key === "\u001b" || key === "\r" || key === "\n") activeSearch = "";
    else if (key === "\u007f" || key === "\b") query = [...query].slice(0, -1).join("");
    else if (key === "\u0015") query = "";
    else query += key.replaceAll("\u001b[200~", "").replaceAll("\u001b[201~", "").replace(/\u001b\[[0-9;]*[A-Za-z~]/g, "").replace(/[\x00-\x1f\x7f]/g, "");
    if (searchKind === "files") fileSearchQuery = query; else if (searchKind === "changes") diffSearchQuery = query;
    scrollOffset = 0; scheduleDraw(); return;
  }
  if (key === "\t") { mainTab = mainTab === "changes" ? "files" : "changes"; scrollOffset = 0; }
  else if (key === "/") activeSearch = mainTab;
  else if (/^(?:j|\u001b\[B)+$/.test(key)) {
    const steps = key.match(/j|\u001b\[B/g)?.length || 1;
    const index = keyboardItems.findIndex((item) => item.identity === selectedIdentity);
    const next = keyboardItems[Math.min(keyboardItems.length - 1, Math.max(0, index + steps))];
    if (next) selectKeyboardItem(next);
  }
  else if (/^(?:k|\u001b\[A)+$/.test(key)) {
    const steps = key.match(/k|\u001b\[A/g)?.length || 1;
    const index = keyboardItems.findIndex((item) => item.identity === selectedIdentity);
    const next = keyboardItems[Math.max(0, index < 0 ? 0 : index - steps)];
    if (next) selectKeyboardItem(next);
  }
  else if (key === "\r" || key === "\n" || key === "o") {
    const selected = keyboardItems.find((item) => item.identity === selectedIdentity);
    if (selected && (key !== "o" || selected.file)) selected.action();
  }
  else if (key === "l" || key === "\u001b[C") selectedSection = Math.min(sectionIds.length - 1, selectedSection + 1);
  else if (key === "h" || key === "\u001b[D") selectedSection = Math.max(0, selectedSection - 1);
  else if (key === "J") scrollOffset += 3;
  else if (key === "K") scrollOffset = Math.max(0, scrollOffset - 3);
  else if (key === " ") expanded[sectionIds[selectedSection]] = !expanded[sectionIds[selectedSection]];
  else if (key === "g") toggleViewMode(Math.max(24, process.stdout.columns || 52));
  else if (key === "r") { void refreshState(true); return; }
  scheduleDraw();
}
const inputDecoder = createTerminalInputDecoder(handleInput);
process.stdin.on("data", (key) => inputDecoder.push(key));
process.on("SIGTERM", () => void quit());
process.on("SIGINT", () => void quit());
process.stdout.on("resize", scheduleDraw);
draw();
startInvalidation();
