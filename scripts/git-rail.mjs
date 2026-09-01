#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cmuxExecutable, registerCmuxDockControl, resolveCmuxProjectContext } from "../src/cmux-context.mjs";
import { startCmuxContextWatcher } from "../src/cmux-context-watch.mjs";
import { openCmuxPreview } from "../src/cmux-preview-lifecycle.mjs";
import { resolveDirectMarkdownOpen } from "../src/config.mjs";
import { openExternalFile } from "../src/direct-file-open.mjs";
import { createFixtureRepository } from "../src/fixture.mjs";
import { getCommitFiles, getRepositoryState } from "../src/git-provider.mjs";
import {
  closeWatcherOnError,
  resolveGitWatchRoots,
  shouldInstallRecoveryPoll,
  shouldInstallWatchers,
} from "../src/git-watch.mjs";
import {
  FilesViewModelCache,
  filesContentSignature,
  filesSourceSignature,
  folderCollapseKeys,
  folderStateScope,
  syncFolderCollapseState,
  toggleFolderCollapseState,
  treeBranchPrefix,
} from "../src/files-view-model.mjs";
import { debugLog } from "../src/debug-log.mjs";
import { assertSupportedNode } from "../src/node-version.mjs";
import { resolveHerdrTabCwd } from "../src/herdr-context.mjs";
import { displayState, filesAgainstBase, reconcileSelectionIdentity, selectionKey, selectionPathKey } from "../src/model.mjs";
import { runCommand } from "../src/process.mjs";
import { openOwnedPreview } from "../src/preview-pane-lifecycle.mjs";
import {
  compactTerminalPath,
  commitExpansionState,
  activatePointerTarget,
  createCoalescedScheduler,
  createLatestSerialQueue,
  createPointerClickTracker,
  createTerminalInputDecoder,
  fitAnsiTerminalColumns,
  filePointerActions,
  filesViewNotices,
  jitteredPollInterval,
  interruptPointerClickSequence,
  padAnsiTerminalColumns,
  previewTabName,
  refreshStatusAfterSuccess,
  reconcileSelectionStatus,
  revealScrollOffset,
  statusAfterBusy,
  sanitizeTerminalText,
  sliceAnsiTerminalColumns,
  terminalColumns,
  truncateTerminalColumns,
  validPollInterval,
  startupFailureState,
} from "../src/terminal-ui.mjs";
import { compactAge } from "../src/tui-format.mjs";
import { resolvePalette } from "../src/theme.mjs";

const ESC = "\u001b[";
assertSupportedNode();
const HOST = process.env.GIT_RAIL_HOST === "cmux" ? "cmux" : "herdr";
const C = resolvePalette(process.env, { host: HOST });
const cliArgs = new Set(process.argv.slice(2));
const snapshotMode = cliArgs.has("--snapshot");
const demoMode = cliArgs.has("--demo") || process.env.GIT_RAIL_DEMO === "1";
const forcedWidth = numberArg("--width");
const forcedHeight = numberArg("--height");
const initialSearch = stringArg("--search");
const viewportFixtureCount = snapshotMode || process.env.NODE_ENV === "test"
  ? numberArg("--viewport-fixture-count")
  : null;
const snapshotFrameCount = Math.max(1, snapshotMode ? numberArg("--snapshot-frames") || 1 : 1);
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
function reportAsync(promise) {
  Promise.resolve(promise).catch((error) => {
    statusMessage = `Action failed: ${safe(error.message)}`;
    draw();
  });
}
function visibleLength(value) { return terminalColumns(value); }
function truncate(value, width) { return truncateTerminalColumns(value, width); }
function fitAnsi(value, width) { return fitAnsiTerminalColumns(value, width); }
function padAnsi(value, width) { return padAnsiTerminalColumns(value, width); }
function compactPath(value, width) { return compactTerminalPath(value, width); }
function parseContext() {
  try { return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}"); } catch { return {}; }
}

const context = parseContext();
const initialCwd = process.env.GIT_RAIL_REPO_ROOT
  || (HOST === "cmux" ? process.env.GIT_RAIL_PROJECT_CWD : "")
  || context.focused_pane_cwd || context.workspace_cwd || process.env.HERDR_WORKSPACE_CWD || process.cwd();
let sourcePaneId = process.env.GIT_RAIL_SOURCE_PANE_ID || context.focused_pane_id || "";
let cmuxDockSurfaceId = process.env.CMUX_SURFACE_ID || "";
let cmuxMainSurfaceId = "";
let cmuxOwnerWindowId = process.env.GIT_RAIL_WINDOW_ID || "";
let fixtureRoot = demoMode ? await createFixtureRepository() : "";
let snapshotEnvironmentRoot = "";
if (snapshotMode && demoMode) {
  snapshotEnvironmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gitrail-snapshot-env-"));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_RAIL_")) delete process.env[key];
  }
  process.env.HOME = path.join(snapshotEnvironmentRoot, "home");
  process.env.XDG_CONFIG_HOME = path.join(snapshotEnvironmentRoot, "config");
  process.env.XDG_CACHE_HOME = path.join(snapshotEnvironmentRoot, "cache");
  process.env.XDG_STATE_HOME = path.join(snapshotEnvironmentRoot, "state");
}
let currentProviderCwd = initialCwd;
let currentWorkspaceId = process.env.HERDR_WORKSPACE_ID || context.workspace_id || "";
let currentSourceTabId = process.env.GIT_RAIL_SOURCE_TAB_ID || process.env.HERDR_TAB_ID || context.tab_id || "";
const cmuxControlInstanceId = HOST === "cmux" ? randomUUID() : "";
async function registerCmuxOwner(workspaceId) {
  if (HOST !== "cmux" || !workspaceId || !cmuxDockSurfaceId) return false;
  try {
    return await registerCmuxDockControl({
      workspaceId,
      surfaceId: cmuxDockSurfaceId,
      controlId: process.env.CMUX_DOCK_CONTROL_ID || "git-rail",
      instanceId: cmuxControlInstanceId,
      processId: process.pid,
      environment: process.env,
    });
  } catch (error) {
    debugLog("cmux-control-registration", { outcome: "failed", workspaceId, error: safe(error.message) });
    return false;
  }
}
async function liveProviderCwd() {
  if (HOST === "cmux") {
    const environment = cmuxOwnerWindowId
      ? { ...process.env, GIT_RAIL_WINDOW_ID: cmuxOwnerWindowId }
      : process.env;
    const resolved = await resolveCmuxProjectContext({
      run: runCommand,
      cmux: cmuxExecutable(environment),
      environment,
      fallbackCwd: currentProviderCwd,
    });
    if (!cmuxOwnerWindowId && resolved.windowId) {
      cmuxOwnerWindowId = resolved.windowId;
      process.env.GIT_RAIL_WINDOW_ID = resolved.windowId;
    }
    currentWorkspaceId = resolved.workspaceId || currentWorkspaceId;
    cmuxDockSurfaceId = resolved.dockSurfaceId || cmuxDockSurfaceId;
    cmuxMainSurfaceId = resolved.mainSurfaceId || "";
    currentProviderCwd = demoMode ? fixtureRoot : resolved.cwd || currentProviderCwd;
    await registerCmuxOwner(currentWorkspaceId);
    return currentProviderCwd;
  }
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
  currentSourceTabId = resolved.tabId || currentSourceTabId;
  currentProviderCwd = resolved.cwd || currentProviderCwd;
  return currentProviderCwd;
}
await registerCmuxOwner(process.env.CMUX_WORKSPACE_ID);
currentProviderCwd = fixtureRoot || await liveProviderCwd();
if (HOST === "cmux" && fixtureRoot) currentProviderCwd = await liveProviderCwd();
let state;
try { state = await getRepositoryState(currentProviderCwd); }
catch (error) { state = startupFailureState(currentProviderCwd, error); }
if (demoMode) state.repository = "gitrail-fixture";
if (viewportFixtureCount) {
  state.files = Array.from({ length: viewportFixtureCount }, (_value, index) => ({
    path: `folder-${String(index % 100).padStart(3, "0")}/file-${String(index).padStart(5, "0")}.txt`,
    clean: true,
    states: [],
    descriptor: { kind: "clean" },
  }));
  state.workspaceChanges = [];
  state.workspaceDescriptor = { kind: "workspace", baseRef: state.baseLabel || "HEAD" };
}
let mainTab = cliArgs.has("--files") ? "files" : "changes";
let viewModePreference = "auto";
let selectedSection = 0;
let scrollOffset = 0;
let selectedIdentity = "";
let selectedPathIdentity = "";
let selectedStatusMessage = "";
let revealSelected = false;
let keyboardItems = [];
let keyboardIndexByIdentity = new Map();
let statusMessage = state.configErrors?.[0] || "Click a section or file";
let fileSearchQuery = "";
let diffSearchQuery = initialSearch;
let activeSearch = "";
let helpVisible = false;
let helpScrollOffset = 0;
let hitTargets = [];
const isDoubleClick = createPointerClickTracker();
let refreshGeneration = 0;
let refreshRunning = false;
let refreshVisible = false;
let refreshQueued = false;
let refreshQueuedAnnounce = false;
let refreshTimer;
let watchRecoveryPoll = false;
let cmuxContextWatcher;
let invalidationScheduler;
let renderTimer;
let statusTimer;
let transientRestoreStatus = "";
let transientStatusMessage = "";
let watchers = [];
let invalidationRepoRoot = "";
let invalidationSignature = "";
let invalidationGeneration = 0;
const expanded = { against: false, commits: false, staged: true, unstaged: true, untracked: true };
const sectionIds = ["against", "commits", "staged", "unstaged", "untracked"];
const collapsedGroups = new Set();
const collapsedFolders = new Map();
const knownFolders = new Map();
const expandedCommits = new Set();
const commitFiles = new Map();
const filesViewModels = new FilesViewModelCache();
let filesViewGeneration = 0;
let filesTabViewCache = null;

function interactive(text, onClick, label, onDoubleClick = null) { return { text, onClick, label, onDoubleClick }; }
function regions(text, targets) { return { text, targets }; }
function textOf(line) { return typeof line === "string" ? line : line.text; }
function focusedLine(line, width) {
  const content = sliceAnsiTerminalColumns(padAnsi(fitAnsi(line, width), width), 1, Math.max(0, width - 1))
    .replaceAll(C.reset, `${C.reset}${C.selected}`);
  return `${C.selected}${C.gold}▏${C.reset}${C.selected}${content}${C.reset}`;
}
function showTransientStatus(message, durationMs = 1_500, restoreStatus = statusMessage) {
  if (!statusTimer || statusMessage !== transientStatusMessage) transientRestoreStatus = restoreStatus;
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
  if (file.descriptor?.kind === "untracked") return `${C.leaf}?${C.reset}`;
  if (status === "clean") return `${C.fog}${file.descriptor?.kind === "filesystem" ? "⊠" : "□"}${C.reset}`;
  if (file.binary) return `${C.purple}◆${C.reset}`;
  if (status === "added") return `${C.leaf}⊞${C.reset}`;
  if (status === "deleted") return `${C.red}⊟${C.reset}`;
  if (status === "renamed") return `${C.blue}↪${C.reset}`;
  if (status === "copied") return `${C.purple}◫${C.reset}`;
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
// The rule character is East Asian Ambiguous, so repeat by columns rather than
// by count or a wide-ambiguous terminal truncates the last cell to an ellipsis.
function rule(width) {
  const columns = Math.max(1, visibleLength("─"));
  return `${C.faint}${"─".repeat(Math.max(0, Math.floor(width / columns)))}${C.reset}`;
}
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
function treeGuides(row, width) { return `${C.faint}${treeBranchPrefix(row, width)}${C.reset}`; }

function selectFile(file) {
  selectedIdentity = selectionKey(state.repoRoot || state.cwd, file);
  selectedPathIdentity = selectionPathKey(state.repoRoot || state.cwd, file);
  revealSelected = true;
  selectedStatusMessage = file.statsUnavailable
    ? `${descriptorLabel(file.descriptor)} · ${file.path} · ? stats unavailable (inspection budget)`
    : `${descriptorLabel(file.descriptor)} · ${file.path}`;
  statusMessage = selectedStatusMessage;
}
function selectKeyboardItem(item) {
  if (item.file) selectFile(item.file);
  else {
    selectedIdentity = item.identity;
    selectedPathIdentity = "";
    revealSelected = true;
    selectedStatusMessage = item.status;
    statusMessage = selectedStatusMessage;
  }
}
function descriptorLabel(descriptor = { kind: "clean" }) {
  if (descriptor.kind === "workspace") return `Against ${safe(descriptor.baseRef)}`;
  if (descriptor.kind === "against") return `Against ${safe(descriptor.baseRef)}`;
  if (descriptor.kind === "commit") return `Commit ${safe(descriptor.commitHash).slice(0, 8)}`;
  const kind = safe(descriptor.kind || "file");
  return kind[0].toUpperCase() + kind.slice(1);
}
function keyboardItemForFile(file) {
  const identity = selectionKey(state.repoRoot || state.cwd, file);
  return {
    identity,
    pathIdentity: selectionPathKey(state.repoRoot || state.cwd, file),
    file,
    status: `${descriptorLabel(file.descriptor)} · ${file.path}`,
    action: () => reportAsync(requestPreview(file)),
  };
}
function fileRow(file, width, prefix = " ", keyboardItem = keyboardItemForFile(file)) {
  const { identity } = keyboardItem;
  return { keyboardIdentity: identity, keyboardItem, materialize() {
    const suffix = statsLabel(file);
    const available = Math.max(1, width - visibleLength(prefix) - 2 - visibleLength(suffix) - (suffix ? 1 : 0));
    const body = `${prefix}${statusGlyph(file)} ${truncate(safe(path.basename(file.path)), available)}`;
    const line = suffix ? `${padAnsi(body, width - visibleLength(suffix) - 1)} ${suffix}` : body;
    const pointerActions = filePointerActions(
      HOST,
      () => selectFile(file),
      () => reportAsync(requestPreview(file)),
    );
    const row = interactive(
      identity === selectedIdentity ? focusedLine(line, width) : fitAnsi(line, width),
      pointerActions.click,
      `Select ${descriptorLabel(file.descriptor)}: ${file.path}`,
      pointerActions.doubleClick,
    );
    row.keyboardIdentity = identity;
    return row;
  } };
}
function folderState(files, mode, scope, expandByDefault = false) {
  if (mode === "tree" && !collapsedFolders.has(scope)) collapsedFolders.set(scope, new Set());
  const collapsed = mode === "tree" ? collapsedFolders.get(scope) : collapsedGroups;
  if (!knownFolders.has(`${mode}:${scope}`)) knownFolders.set(`${mode}:${scope}`, new Set());
  const known = knownFolders.get(`${mode}:${scope}`);
  syncFolderCollapseState(collapsed, known, folderCollapseKeys(files, { mode, scope }), expandByDefault);
  return collapsed;
}
function folderKeyboardItem({ mode, scope, key, label, collapsed }) {
  const identity = `${state.repoRoot || state.cwd}\0folder\0${mode}\0${scope}\0${key}`;
  return {
    identity,
    status: `Folder · ${label}`,
    action: () => {
      const open = !collapsed.has(key);
      toggleFolderCollapseState(collapsed, key);
      filesViewModels.invalidate();
      statusMessage = `${open ? "Collapsed" : "Expanded"} ${safe(label)}`;
    },
  };
}
function renderTree(files, width, scope, expandByDefault = false) {
  const collapsed = folderState(files, "tree", scope, expandByDefault);
  const cacheKey = `${filesViewGeneration}:tree:${scope}:${filesContentSignature(files)}:${[...collapsed].sort().join("\0")}`;
  return filesViewModels.rows(cacheKey, files, { mode: "tree", collapsed, scope }).map((row) => {
    const guides = treeGuides(row, width);
    if (row.kind === "file") return fileRow(row.file, width, ` ${guides}`);
    const open = !collapsed.has(row.path);
    const keyboardItem = folderKeyboardItem({ mode: "tree", scope, key: row.path, label: row.path, collapsed });
    return { keyboardIdentity: keyboardItem.identity, keyboardItem, materialize: () => interactive(
      keyboardItem.identity === selectedIdentity
        ? focusedLine(` ${guides}${C.fog}${open ? "⌄" : "›"} ${safe(row.name)}/${C.reset}`, width)
        : fitAnsi(` ${guides}${C.fog}${open ? "⌄" : "›"} ${safe(row.name)}/${C.reset}`, width),
      () => { selectKeyboardItem(keyboardItem); keyboardItem.action(); },
      `${open ? "Collapse" : "Expand"} folder: ${row.path}`,
    ) };
  });
}
function renderGrouped(files, width, scope, expandByDefault = false) {
  const lines = [];
  folderState(files, "grouped", scope, expandByDefault);
  const cacheKey = `${filesViewGeneration}:grouped:${scope}:${filesContentSignature(files)}:${[...collapsedGroups].sort().join("\0")}`;
  for (const row of filesViewModels.rows(cacheKey, files, { mode: "grouped", collapsed: collapsedGroups, scope })) {
    if (row.kind === "file") {
      const prefix = row.prefix === "last" ? `  ${C.faint}└─${C.reset} ` : row.prefix === "middle" ? `  ${C.faint}├─${C.reset} ` : " ";
      lines.push(fileRow(row.file, width, prefix));
      continue;
    }
    const keyboardItem = folderKeyboardItem({ mode: "grouped", scope, key: row.key, label: row.folder, collapsed: collapsedGroups });
    const line = `${C.fog} ${row.open ? "⌄" : "›"} ${compactPath(row.folder, Math.max(5, width - 8))}${C.reset} ${C.dim}${row.count}${C.reset}`;
    lines.push({ keyboardIdentity: keyboardItem.identity, keyboardItem, materialize: () => interactive(
      keyboardItem.identity === selectedIdentity ? focusedLine(line, width) : line,
      () => { selectKeyboardItem(keyboardItem); keyboardItem.action(); },
      `${row.open ? "Collapse" : "Expand"} folder: ${row.folder}`,
    ) });
  }
  return lines;
}
function renderFilesList(files, width, scope, expandByDefault = false) {
  return resolvedViewMode(width) === "tree"
    ? renderTree(files, width, scope, expandByDefault)
    : renderGrouped(files, width, scope, expandByDefault);
}
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
    { x1: 5 + visibleLength(layout), x2: 4 + visibleLength(layout) + visibleLength(refresh), action: () => reportAsync(refreshState(true)), label: "Refresh" },
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
    { id: "untracked", label: "Untracked", files: search(state.untracked || [], query) },
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
      lines.push(...renderFilesList(section.files, width, folderStateScope(section.id, query), Boolean(query)));
      return;
    }
    for (const commit of section.commits) {
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
        action: () => reportAsync(toggleCommit(commit)),
      };
      const row = interactive(
        identity === selectedIdentity ? focusedLine(line, width) : fitAnsi(line, width),
        () => { selectKeyboardItem(keyboardItem); reportAsync(toggleCommit(commit)); },
        `${open ? "Collapse" : "Expand"} commit ${safe(commit.shortHash)}`,
      );
      row.keyboardIdentity = identity;
      row.keyboardItem = keyboardItem;
      lines.push(row);
      if (!open) continue;
      if (query) {
        const loaded = commitFiles.get(commit.hash);
        const matchingFiles = loaded
          ? expansion.showAllFiles ? loaded : search(loaded, query)
          : commit.matchingPaths.map((filePath) => ({ path: filePath, status: "modified", additions: 0, deletions: 0, descriptor: { kind: "commit", commitHash: commit.hash } }));
        if (expansion.loading) lines.push(`   ${C.dim}Loading commit files…${C.reset}`);
        else lines.push(...renderFilesList(matchingFiles, width, folderStateScope(`commit:${commit.hash}`, query), true));
      } else if (!commitFiles.has(commit.hash)) lines.push(`   ${C.dim}Loading commit files…${C.reset}`);
      else lines.push(...renderFilesList(commitFiles.get(commit.hash), width, `commit:${commit.hash}`));
    }
  });
  return lines;
}
function canonicalFiles() {
  return filesAgainstBase(state.files || [], state.workspaceChanges || [], state.workspaceDescriptor);
}
function renderFiles(width) {
  const query = fileSearchQuery.trim();
  const mode = resolvedViewMode(width);
  const scope = folderStateScope("files", query);
  const sourceKey = [filesViewGeneration, filesSourceSignature(state), mode, width, query].join(":");
  const files = filesTabViewCache?.sourceKey === sourceKey
    ? filesTabViewCache.files
    : search(canonicalFiles(), query);
  const collapsed = folderState(files, mode, scope, Boolean(query));
  const cacheKey = [
    sourceKey,
    [...collapsed].sort().join("\0"),
  ].join(":");
  if (filesTabViewCache?.key !== cacheKey) {
    const rows = files.length
      ? filesViewModels.rows(cacheKey, files, { mode, collapsed, scope })
      : [];
    const rowKeyboardItems = rows.map((row) => row.kind === "file"
      ? keyboardItemForFile(row.file)
      : folderKeyboardItem({
        mode,
        scope,
        key: row.kind === "folder" ? row.path : row.key,
        label: row.kind === "folder" ? row.path : row.folder,
        collapsed,
      }));
    filesTabViewCache = {
      sourceKey,
      key: cacheKey,
      files,
      rows,
      keyboardItems: rowKeyboardItems,
      keyboardItemByRow: new Map(rows.map((row, index) => [row, rowKeyboardItems[index]])),
      keyboardIndexByIdentity: new Map(rowKeyboardItems.map((item, index) => [item.identity, index])),
      rowIndexByIdentity: new Map(rowKeyboardItems.map((item, index) => [item.identity, index])),
      mode,
      scope,
      collapsed,
    };
  }
  const fixed = [
    interactive(searchField(fileSearchQuery, activeSearch === "files", "Search files…", query ? `${files.length} matches` : "", width), () => { activeSearch = "files"; }, "Search files"),
    toolbar(width), rule(width),
  ];
  for (const notice of filesViewNotices(state, (state.files || []).length)) fixed.push(` ${C.dim}${notice}${C.reset}`);
  const rows = files.length
    ? filesTabViewCache.rows
    : [` ${C.dim}${query ? `No files match “${truncate(safe(query), width - 19)}”` : state.repoRoot ? "Repository has no files" : "Directory has no files"}${C.reset}`];
  return { virtualFiles: true, fixed, ...filesTabViewCache, rows };
}

function materializeFilesTabRow(row, width) {
  if (typeof row === "string") return row;
  const item = filesTabViewCache.keyboardItemByRow.get(row);
  if (row.kind === "file") {
    const prefix = Number.isInteger(row.depth)
      ? ` ${treeGuides(row, width)}`
      : row.prefix === "last" ? `  ${C.faint}└─${C.reset} `
        : row.prefix === "middle" ? `  ${C.faint}├─${C.reset} ` : " ";
    return fileRow(row.file, width, prefix, item).materialize();
  }
  if (row.kind === "folder") {
    const guides = treeGuides(row, width);
    const collapsed = filesTabViewCache.collapsed;
    const open = !collapsed.has(row.path);
    const line = ` ${guides}${C.fog}${open ? "⌄" : "›"} ${safe(row.name)}/${C.reset}`;
    return interactive(
      item.identity === selectedIdentity ? focusedLine(line, width) : fitAnsi(line, width),
      () => { selectKeyboardItem(item); item.action(); },
      `${open ? "Collapse" : "Expand"} folder: ${row.path}`,
    );
  }
  const line = `${C.fog} ${row.open ? "⌄" : "›"} ${compactPath(row.folder, Math.max(5, width - 8))}${C.reset} ${C.dim}${row.count}${C.reset}`;
  return interactive(
    item.identity === selectedIdentity ? focusedLine(line, width) : line,
    () => { selectKeyboardItem(item); item.action(); },
    `${row.open ? "Collapse" : "Expand"} folder: ${row.folder}`,
  );
}
function renderBody(width) {
  keyboardItems = [];
  if (state.error && !state.repoRoot && mainTab === "changes") {
    if (/^No Git repository\b/.test(state.error)) {
      return ["", `${C.fog}Changes unavailable outside Git${C.reset}`, `${C.dim}${truncate(safe(state.cwd), width)}${C.reset}`, "", "Press Tab to browse files."];
    }
    return [
      "",
      `${C.red}${C.bold}Git state unavailable${C.reset}`,
      `${C.red}${truncate(safe(state.error), width)}${C.reset}`,
      `${C.dim}${truncate(safe(state.cwd), width)}${C.reset}`,
      "",
      "Press r to retry or Tab to browse the last available Files state.",
    ];
  }
  return mainTab === "changes" ? renderChanges(width) : renderFiles(width);
}
function helpEntry(icon, label, color = C.fog) {
  return `${color}${icon}${C.reset} ${label}`;
}
function helpRows(width) {
  keyboardItems = [];
  const keys = [
    " ↑/↓ · j/k   Select row",
    " Enter       Open / toggle selected",
    " o           Open selected file",
    " J/K         Scroll viewport",
    " h/l · Space Select/toggle section",
    " Tab         Changes / Files",
    " /           Search current view",
    " g           Tree / Folders",
    " r           Refresh",
    " Esc         Clear selection / close",
    " q           Close GitRail",
  ];
  const states = [
    helpEntry("⊡", "Modified", C.amber),
    helpEntry("⊞", "Added", C.leaf),
    helpEntry("⊟", "Deleted", C.red),
    helpEntry("↪", "Renamed", C.blue),
    helpEntry("◫", "Copied", C.purple),
    helpEntry("!", "Conflicted", C.red),
    helpEntry("◇", "Type changed", C.blue),
    helpEntry("◆", "Binary", C.purple),
    helpEntry("?", "Untracked", C.leaf),
    helpEntry("□", "Clean Git file"),
    helpEntry("⊠", "Filesystem-only file"),
  ];
  const legendRows = width >= 44
    ? Array.from({ length: Math.ceil(states.length / 2) }, (_, index) => {
      const left = states[index * 2];
      const right = states[index * 2 + 1];
      const columnWidth = Math.floor((width - 3) / 2);
      return ` ${padAnsi(left, columnWidth)}${right ? `  ${right}` : ""}`;
    })
    : states.map((entry) => ` ${entry}`);
  return [
    ` ${C.gold}${C.bold}?  HELP & LEGEND${C.reset}`,
    ` ${C.dim}Keyboard map and repository marks${C.reset}`,
    rule(width),
    ` ${C.gold}${C.bold}KEYS${C.reset}`,
    ...keys,
    "",
    ` ${C.gold}${C.bold}FILE STATES${C.reset}`,
    ...legendRows,
    ` ${C.dim}Unstaged: tracked change not staged${C.reset}`,
    ` ${C.dim}Untracked: not added to Git${C.reset}`,
    "",
    ` ${C.gold}${C.bold}STRUCTURE & STATS${C.reset}`,
    ` ${C.fog}› / ⌄${C.reset} Collapsed / expanded`,
    ` ${C.leaf}+${C.reset} / ${C.red}−${C.reset} Added / removed lines`,
    ` ${C.fog}?${C.reset} Statistics unavailable`,
  ];
}
function renderHeader(width) {
  const half = Math.floor(width / 2);
  return { half, lines: [
    ` ${C.bold}${truncate(safe(state.repository || "repository"), width - 1)}${C.reset}`,
    `  ${C.fog}↱ ${truncate(safe(state.branch || "—"), width - 4)}${C.reset}`,
    rule(width),
    `${tab("CHANGES", mainTab === "changes", half)}${tab("FILES", mainTab === "files", width - half)}`,
  ] };
}
function renderFrame() {
  const width = Math.max(24, forcedWidth || process.stdout.columns || 52);
  const height = Math.max(18, forcedHeight || process.stdout.rows || 42);
  const { half, lines: header } = renderHeader(width);
  const body = helpVisible ? helpRows(width) : renderBody(width);
  if (!helpVisible) {
    keyboardItems = body?.virtualFiles
      ? body.keyboardItems
      : body.flatMap((entry) => entry?.keyboardItem ? [entry.keyboardItem] : []);
    keyboardIndexByIdentity = body?.virtualFiles
      ? body.keyboardIndexByIdentity
      : new Map(keyboardItems.map((item, index) => [item.identity, index]));
    const reconciledIdentity = reconcileSelectionIdentity(selectedIdentity, selectedPathIdentity, keyboardItems);
    if (reconciledIdentity !== selectedIdentity) {
      selectedIdentity = reconciledIdentity;
      const nextSelectionStatus = keyboardItems.find((item) => item.identity === reconciledIdentity)?.status || selectedStatusMessage;
      const reconciledStatus = reconcileSelectionStatus({
        currentStatus: statusMessage,
        previousSelectionStatus: selectedStatusMessage,
        nextSelectionStatus,
        transientStatus: transientStatusMessage,
        transientRestoreStatus,
      });
      statusMessage = reconciledStatus.currentStatus;
      transientRestoreStatus = reconciledStatus.transientRestoreStatus;
      selectedStatusMessage = nextSelectionStatus;
    }
  }
  const controls = helpVisible
    ? "↑/↓ or j/k scroll · ?/Esc/q close help"
    : activeSearch ? "type to filter · Enter done · Esc close · Ctrl-U clear" : "j/k select · Enter open · ? help · / search · q";
  const footerMessage = helpVisible ? controls : statusMessage && statusMessage !== "Click a section or file" ? statusMessage : controls;
  const footer = [rule(width), `${C.dim}${fitAnsi(safe(footerMessage), width)}${C.reset}`];
  const bodyHeight = Math.max(1, height - header.length - footer.length);
  const fixedCount = helpVisible ? 3 : body?.virtualFiles ? body.fixed.length : state.repoRoot ? 3 : 0;
  const fixedSource = body?.virtualFiles ? body.fixed : body;
  const fixed = fixedSource.slice(0, Math.min(fixedCount, bodyHeight));
  const scrollable = body?.virtualFiles ? body.rows : body.slice(fixed.length);
  const visibleHeight = Math.max(0, bodyHeight - fixed.length);
  let activeScrollOffset = helpVisible ? helpScrollOffset : scrollOffset;
  if (!helpVisible && revealSelected) {
    const selectedRow = body?.virtualFiles
      ? (body.rowIndexByIdentity.get(selectedIdentity) ?? -1)
      : scrollable.findIndex((entry) => typeof entry !== "string" && entry.keyboardIdentity === selectedIdentity);
    activeScrollOffset = revealScrollOffset(selectedRow, activeScrollOffset, visibleHeight, scrollable.length);
    revealSelected = false;
  }
  const maxScrollOffset = Math.max(0, scrollable.length - visibleHeight);
  activeScrollOffset = Math.max(0, Math.min(activeScrollOffset, maxScrollOffset));
  if (helpVisible) helpScrollOffset = activeScrollOffset; else scrollOffset = activeScrollOffset;
  const visibleRows = body?.virtualFiles
    ? filesViewModels.materialize(
      scrollable,
      activeScrollOffset,
      visibleHeight,
      (entry) => materializeFilesTabRow(entry, width),
    )
    : scrollable.slice(activeScrollOffset, activeScrollOffset + visibleHeight)
      .map((entry) => entry?.materialize ? entry.materialize() : entry);
  const viewport = [
    ...fixed.map((entry) => entry?.materialize ? entry.materialize() : entry),
    ...visibleRows,
  ];
  while (viewport.length < bodyHeight) viewport.push("");
  hitTargets = helpVisible ? [] : [
    { row: 4, x1: 1, x2: half, label: "Changes", action: () => { mainTab = "changes"; activeSearch = ""; scrollOffset = 0; } },
    { row: 4, x1: half + 1, x2: width, label: "Files", action: () => { mainTab = "files"; activeSearch = ""; scrollOffset = 0; } },
  ];
  viewport.forEach((entry, index) => {
    if (typeof entry === "string") return;
    const row = header.length + index + 1;
    if (entry.targets) entry.targets.forEach((target) => hitTargets.push({ row, ...target }));
    if (entry.onClick) hitTargets.push({ row, x1: 1, x2: width, label: entry.label, action: entry.onClick, doubleAction: entry.onDoubleClick });
  });
  const frame = [...header, ...viewport, ...footer].map((line) => padAnsi(textOf(line), width));
  if (maxScrollOffset > 0 && visibleHeight > 0) {
    const thumbOffset = Math.round((activeScrollOffset / maxScrollOffset) * Math.max(0, visibleHeight - 1));
    const thumbRow = header.length + fixed.length + thumbOffset;
    frame[thumbRow] = `${sliceAnsiTerminalColumns(frame[thumbRow], 0, width - 1)}${C.gold}▐${C.reset}`;
  }
  return frame.join("\n");
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

async function openPreview(file) {
  let statusBeforeOpen = statusMessage;
  let openingStatus = "";
  if (HOST === "cmux") {
    if (statusTimer && statusMessage === transientStatusMessage) statusBeforeOpen = transientRestoreStatus;
    clearTimeout(statusTimer);
    statusTimer = undefined;
    transientRestoreStatus = "";
    transientStatusMessage = "";
    openingStatus = `Opening ${safe(file.path)}…`;
    statusMessage = openingStatus;
    draw();
  }
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
  const previewDescriptor = file.descriptor || { kind: "clean" };
  const previewMetadata = {
    status: file.status,
    oldPath: file.oldPath,
    binary: file.binary,
    submodule: file.submodule,
    symlink: file.symlink,
    oldSubmodule: file.oldSubmodule,
    oldSymlink: file.oldSymlink,
  };
  if (HOST === "cmux") {
    try {
      const selectedCwd = path.resolve(state.cwd || currentProviderCwd);
      await liveProviderCwd();
      if (path.resolve(currentProviderCwd) !== selectedCwd) {
        const refreshed = await refreshState(false);
        if (refreshed) showTransientStatus(
          "Workspace changed · selection refreshed",
          1_500,
          statusAfterBusy(statusBeforeOpen, openingStatus, statusMessage),
        );
        else if (!statusMessage.startsWith("Refresh failed:")) statusMessage = "Workspace changed · refresh queued";
        draw();
        return;
      }
      const opened = await openCmuxPreview({
        run: runCommand,
        cmux: cmuxExecutable(process.env),
        cwd: currentProviderCwd,
        workspaceId: currentWorkspaceId,
        targetSurfaceId: cmuxMainSurfaceId,
        ownerSurfaceId: cmuxDockSurfaceId,
        ownerControlId: process.env.CMUX_DOCK_CONTROL_ID || "git-rail",
        previewPath: file.path,
        repoRoot: state.repoRoot || state.cwd,
        descriptor: previewDescriptor,
        metadata: previewMetadata,
        maxFileBytes: state.config.limits.maxFileBytes,
        tabName: previewTabName(file.path),
        environment: process.env,
      });
      let previewStatus = `File opened · ${descriptorLabel(file.descriptor)}`;
      if (opened.cleanupWarning) previewStatus += ` · ${safe(opened.cleanupWarning)}`;
      if (opened.renameWarning) previewStatus += ` · ${safe(opened.renameWarning)}`;
      showTransientStatus(
        previewStatus,
        1_500,
        statusAfterBusy(statusBeforeOpen, openingStatus, statusMessage),
      );
    } catch (error) { statusMessage = `Preview failed: ${error.message}`; }
    draw();
    return;
  }
  const directMarkdown = resolveDirectMarkdownOpen(state.config, file.path);
  if (directMarkdown) {
    try {
      const opened = await openExternalFile({
        viewer: directMarkdown.viewer,
        repoRoot: state.repoRoot || state.cwd,
        filePath: file.path,
        descriptor: previewDescriptor,
        metadata: previewMetadata,
        maxFileBytes: state.config.limits.maxFileBytes,
        temporarySource: demoMode,
        environment: process.env,
      });
      let directStatus = `Opened ${safe(file.path)} with the system app`;
      if (opened.retentionWarning) directStatus += ` · ${safe(opened.retentionWarning)}`;
      showTransientStatus(directStatus);
    } catch (error) { statusMessage = `Open failed: ${safe(error.message)}`; }
    draw();
    return;
  }
  const herdr = process.env.HERDR_BIN_PATH || "herdr";
  const workspaceId = currentWorkspaceId;
  const sourceTabId = currentSourceTabId;
  const descriptor = Buffer.from(JSON.stringify(previewDescriptor)).toString("base64url");
  const metadata = Buffer.from(JSON.stringify(previewMetadata)).toString("base64url");
  const openArgs = ["plugin", "pane", "open", "--plugin", process.env.HERDR_PLUGIN_ID || "local.git-rail", "--entrypoint", "file-preview", "--placement", "tab",
    "--env", `GIT_RAIL_PREVIEW_PATH=${file.path}`, "--env", `GIT_RAIL_PREVIEW_REPO=${state.repoRoot || state.cwd}`, "--env", `GIT_RAIL_PREVIEW_DESCRIPTOR=${descriptor}`, "--env", `GIT_RAIL_PREVIEW_METADATA=${metadata}`, "--env", `GIT_RAIL_PREVIEW_TEMPORARY=${demoMode ? "1" : "0"}`, "--focus"];
  if (workspaceId) openArgs.push("--workspace", workspaceId);
  try {
    const opened = await openOwnedPreview({
      run: runCommand,
      herdr,
      openArgs,
      cwd: currentProviderCwd,
      workspaceId,
      sourceTabId,
      environment: process.env,
      tabName: previewTabName(file.path),
    });
    let previewStatus = `Preview opened · ${descriptorLabel(file.descriptor)}`;
    if (opened.cleanupWarning) previewStatus += ` · ${safe(opened.cleanupWarning)}`;
    if (opened.renameWarning) previewStatus += ` · ${safe(opened.renameWarning)}`;
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
    filesViewModels.invalidate();
  }
  draw();
}
async function refreshState(announce = false) {
  if (refreshRunning) {
    refreshQueued = true;
    refreshQueuedAnnounce ||= announce;
    if (announce && !refreshVisible) { refreshVisible = true; draw(); }
    return false;
  }
  refreshRunning = true;
  let succeeded = false;
  const generation = ++refreshGeneration;
  if (announce) { refreshVisible = true; draw(); }
  try {
    const providerCwd = fixtureRoot || await liveProviderCwd();
    const previousRepoRoot = state.repoRoot;
    const previousCwd = state.cwd;
    const next = await getRepositoryState(providerCwd);
    if (generation === refreshGeneration) {
      if (demoMode) next.repository = "gitrail-fixture";
      const previousInterval = state.config?.refresh?.pollIntervalMs;
      state = next;
      filesViewGeneration += 1;
      filesViewModels.invalidate();
      if (previousRepoRoot !== next.repoRoot || previousCwd !== next.cwd) {
        selectedIdentity = "";
        selectedPathIdentity = "";
        selectedStatusMessage = "";
        scrollOffset = 0;
        commitFiles.clear();
        expandedCommits.clear();
        collapsedGroups.clear();
        collapsedFolders.clear();
        knownFolders.clear();
      }
      if ((state.repoRoot || state.cwd) !== invalidationRepoRoot) reportAsync(startInvalidation());
      else if (refreshTimer && previousInterval !== next.config?.refresh?.pollIntervalMs) resetRefreshTimer();
      if (announce) showTransientStatus("Git state refreshed");
      else statusMessage = refreshStatusAfterSuccess(statusMessage, next.configErrors);
      succeeded = true;
    }
  } catch (error) { statusMessage = `Refresh failed: ${error.message} · showing previous state`; }
  finally {
    refreshRunning = false;
    refreshVisible = false;
    draw();
    if (refreshQueued) {
      const queuedAnnounce = refreshQueuedAnnounce;
      refreshQueued = false;
      refreshQueuedAnnounce = false;
      reportAsync(refreshState(queuedAnnounce));
    }
  }
  return succeeded;
}
async function startInvalidation() {
  if (demoMode) return;
  const generation = ++invalidationGeneration;
  const watchRoot = state.repoRoot || state.cwd;
  let gitRoots = [];
  let watchFailed = false;
  if (state.repoRoot) {
    try { gitRoots = await resolveGitWatchRoots(state.repoRoot); }
    catch (error) { watchFailed = true; debugLog("watch", { outcome: "poll-fallback", error: safe(error.message) }); }
  }
  const signature = JSON.stringify([watchRoot, ...gitRoots]);
  if (generation !== invalidationGeneration) return;
  if (invalidationSignature === signature && refreshTimer) return;
  stopInvalidation(false);
  watchRecoveryPoll = false;
  if (cleanupComplete) return;
  invalidationGeneration = generation;
  invalidationRepoRoot = watchRoot || "";
  invalidationSignature = signature;
  invalidationScheduler = createCoalescedScheduler(() => {
    debugLog("refresh-trigger", { source: "filesystem" });
    reportAsync(refreshState(false));
  });
  const debounce = () => invalidationScheduler.schedule();
  const addWatcher = (watcher, target) => {
    watchers.push(watcher);
    closeWatcherOnError(watcher, (error) => {
      watchers = watchers.filter((candidate) => candidate !== watcher);
      debugLog("watch", { target, outcome: "poll-fallback", error: safe(error.message) });
      resetRefreshTimer(true);
    });
  };
  if (watchRoot && shouldInstallWatchers()) {
    try {
      addWatcher(fs.watch(watchRoot, { recursive: true }, (_event, filename) => {
        if (filename && String(filename).startsWith(`.git${path.sep}`)) return;
        debounce();
      }), watchRoot);
    } catch (error) { watchFailed = true; debugLog("watch", { target: watchRoot, outcome: "poll-fallback", error: safe(error.message) }); }
    for (const root of gitRoots) {
      try { addWatcher(fs.watch(root, { recursive: true }, debounce), root); }
      catch (error) { watchFailed = true; debugLog("watch", { target: root, outcome: "poll-fallback", error: safe(error.message) }); }
    }
  } else if (watchRoot) debugLog("watch", { target: watchRoot, outcome: "poll-only" });
  resetRefreshTimer(watchFailed);
}
function resetRefreshTimer(watchFailed = false) {
  clearTimeout(refreshTimer);
  refreshTimer = undefined;
  watchRecoveryPoll ||= watchFailed;
  if (!shouldInstallRecoveryPoll(process.env, { watchFailed: watchRecoveryPoll })) {
    debugLog("watch", { outcome: "watch-only" });
    return;
  }
  const interval = validPollInterval(state.config?.refresh?.pollIntervalMs);
  const poll = () => {
    refreshTimer = setTimeout(poll, jitteredPollInterval(interval));
    refreshTimer.unref();
    debugLog("refresh-trigger", { source: "poll" });
    reportAsync(refreshState(false));
  };
  refreshTimer = setTimeout(poll, jitteredPollInterval(interval));
  refreshTimer.unref();
}
function stopInvalidation(invalidatePending = true) {
  if (invalidatePending) invalidationGeneration += 1;
  clearTimeout(refreshTimer); refreshTimer = undefined;
  invalidationScheduler?.cancel(); invalidationScheduler = undefined;
  watchers.forEach((watcher) => watcher.close()); watchers = [];
  invalidationRepoRoot = "";
  invalidationSignature = "";
}
function startCmuxInvalidation() {
  if (HOST !== "cmux" || cmuxContextWatcher) return;
  cmuxContextWatcher = startCmuxContextWatcher({
    cmux: cmuxExecutable(process.env),
    environment: process.env,
    windowId: cmuxOwnerWindowId,
    onChange: (event) => {
      debugLog("refresh-trigger", { source: "cmux-event", event: event.name });
      reportAsync(refreshState(false));
    },
    onError: (error) => debugLog("cmux-context-watch", { outcome: "failed", error: safe(error.message) }),
  });
}
let cleanupComplete = false;
function cleanup() {
  if (cleanupComplete) return;
  cleanupComplete = true;
  stopInvalidation(); cmuxContextWatcher?.close(); cmuxContextWatcher = undefined; clearTimeout(renderTimer); clearTimeout(statusTimer);
  if (fixtureRoot) { const root = fixtureRoot; fixtureRoot = ""; fs.rmSync(root, { recursive: true, force: true }); }
  if (snapshotEnvironmentRoot) { const root = snapshotEnvironmentRoot; snapshotEnvironmentRoot = ""; fs.rmSync(root, { recursive: true, force: true }); }
  if (!snapshotMode) process.stdout.write(`${ESC}?1000l${ESC}?1006l${ESC}?25h${ESC}?1049l`);
}
function quit() { cleanup(); process.exit(0); }
function fatal(error) {
  cleanup();
  process.stderr.write(`GitRail fatal error: ${safe(error?.stack || error?.message || error)}\n`);
  process.exit(1);
}

if (snapshotMode) {
  for (let index = 0; index < snapshotFrameCount; index += 1) draw();
  if (cliArgs.has("--viewport-metrics")) {
    process.stderr.write(`${JSON.stringify(filesViewModels.instrumentation)}\n`);
  }
  cleanup();
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
    interruptPointerClickSequence({ button, phase }, isDoubleClick);
    if (button === 64 && phase === "M") {
      if (helpVisible) helpScrollOffset = Math.max(0, helpScrollOffset - 3); else scrollOffset = Math.max(0, scrollOffset - 3);
    }
    if (button === 65 && phase === "M") {
      if (helpVisible) helpScrollOffset += 3; else scrollOffset += 3;
    }
    if (!helpVisible && button === 0 && phase === "M") {
      const target = hitTargets.find((item) => item.row === row && column >= item.x1 && column <= item.x2);
      activatePointerTarget(target, isDoubleClick, reportAsync);
    }
    scheduleDraw();
    return;
  }
  interruptPointerClickSequence({ key }, isDoubleClick);
  if (key === "\u0003") { quit(); return; }
  if (helpVisible) {
    if (key === "?" || key === "q" || key === "\u001b") helpVisible = false;
    else if (/^(?:j|\u001b\[B)+$/.test(key)) helpScrollOffset += key.match(/j|\u001b\[B/g)?.length || 1;
    else if (/^(?:k|\u001b\[A)+$/.test(key)) helpScrollOffset = Math.max(0, helpScrollOffset - (key.match(/k|\u001b\[A/g)?.length || 1));
    else if (key === "J") helpScrollOffset += 3;
    else if (key === "K") helpScrollOffset = Math.max(0, helpScrollOffset - 3);
    scheduleDraw(); return;
  }
  if (!activeSearch && key === "q") { quit(); return; }
  if (!activeSearch && key === "\u001b") {
    if (selectedIdentity) {
      selectedIdentity = "";
      selectedPathIdentity = "";
      selectedStatusMessage = "";
      revealSelected = false;
      statusMessage = "Click a section or file";
      scheduleDraw(); return;
    }
    quit(); return;
  }
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
  else if (key === "?") { helpVisible = true; helpScrollOffset = 0; }
  else if (key === "/") activeSearch = mainTab;
  else if (/^(?:j|\u001b\[B)+$/.test(key)) {
    const steps = key.match(/j|\u001b\[B/g)?.length || 1;
    const index = keyboardIndexByIdentity.get(selectedIdentity) ?? -1;
    const next = keyboardItems[Math.min(keyboardItems.length - 1, Math.max(0, index + steps))];
    if (next) selectKeyboardItem(next);
  }
  else if (/^(?:k|\u001b\[A)+$/.test(key)) {
    const steps = key.match(/k|\u001b\[A/g)?.length || 1;
    const index = keyboardIndexByIdentity.get(selectedIdentity) ?? -1;
    const next = keyboardItems[Math.max(0, index < 0 ? 0 : index - steps)];
    if (next) selectKeyboardItem(next);
  }
  else if (key === "\r" || key === "\n" || key === "o") {
    const selectedIndex = keyboardIndexByIdentity.get(selectedIdentity);
    const selected = selectedIndex === undefined ? null : keyboardItems[selectedIndex];
    if (selected && (key !== "o" || selected.file)) selected.action();
  }
  else if (key === "l" || key === "\u001b[C") selectedSection = Math.min(sectionIds.length - 1, selectedSection + 1);
  else if (key === "h" || key === "\u001b[D") selectedSection = Math.max(0, selectedSection - 1);
  else if (key === "J") scrollOffset += 3;
  else if (key === "K") scrollOffset = Math.max(0, scrollOffset - 3);
  else if (key === " ") expanded[sectionIds[selectedSection]] = !expanded[sectionIds[selectedSection]];
  else if (key === "g") toggleViewMode(Math.max(24, forcedWidth || process.stdout.columns || 52));
  else if (key === "r") { reportAsync(refreshState(true)); return; }
  scheduleDraw();
}
const inputDecoder = createTerminalInputDecoder(handleInput);
process.stdin.on("data", (key) => inputDecoder.push(key));
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
process.on("exit", cleanup);
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
process.stdout.on("resize", scheduleDraw);
draw();
startCmuxInvalidation();
reportAsync(startInvalidation());
if (process.env.NODE_ENV === "test" && process.env.GIT_RAIL_TEST_FATAL === "1") {
  queueMicrotask(() => { throw new Error("injected fatal error"); });
}
