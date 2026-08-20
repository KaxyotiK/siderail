#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ESC = "\u001b[";
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;
const RGB = (r, g, b) => `${ESC}38;2;${r};${g};${b}m`;
const BG = (r, g, b) => `${ESC}48;2;${r};${g};${b}m`;
const C = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  inverse: `${ESC}7m`,
  gold: RGB(214, 176, 91),
  leaf: RGB(91, 190, 112),
  red: RGB(224, 108, 117),
  amber: RGB(229, 180, 84),
  blue: RGB(105, 169, 230),
  purple: RGB(190, 132, 220),
  fog: RGB(139, 139, 139),
  faint: RGB(84, 84, 84),
  selected: BG(45, 41, 34),
};

const args = new Set(process.argv.slice(2));
const snapshotMode = args.has("--snapshot");
const demoMode = args.has("--demo") || process.env.GIT_RAIL_DEMO === "1";
const forcedWidth = readNumberArg("--width");
const forcedHeight = readNumberArg("--height");

function readNumberArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = Number.parseInt(process.argv[index + 1] || "", 10);
  return Number.isFinite(value) ? value : null;
}

function stripAnsi(value) {
  return String(value ?? "").replace(ANSI_RE, "");
}

function visibleLength(value) {
  return [...stripAnsi(value)].length;
}

function truncate(value, width) {
  const source = String(value ?? "");
  if (width <= 0) return "";
  if ([...source].length <= width) return source;
  if (width === 1) return "…";
  return `${[...source].slice(0, width - 1).join("")}…`;
}

function compactFolderPath(value, width) {
  const source = String(value ?? "");
  if (width <= 0) return "";
  if ([...source].length <= width) return source;

  const parts = source.split("/").filter(Boolean);
  if (parts.length <= 1) return truncate(source, width);

  const first = parts[0];
  const last = parts.at(-1);
  const lastTwo = parts.slice(-2).join("/");
  const anchoredCandidates = [
    parts.length > 3 ? `${first}/…/${lastTwo}` : "",
    `${first}/…/${last}`,
  ].filter(Boolean);
  const anchored = anchoredCandidates.find((candidate) => [...candidate].length <= width);
  if (anchored) return anchored;

  const anchor = `${first}/…/`;
  if (width >= [...anchor].length + 6) {
    return `${anchor}${truncate(last, width - [...anchor].length)}`;
  }

  const tailCandidates = [
    parts.length > 2 ? `…/${lastTwo}` : "",
    `…/${last}`,
  ].filter(Boolean);

  return tailCandidates.find((candidate) => [...candidate].length <= width)
    || `…${[...last].slice(-Math.max(0, width - 1)).join("")}`;
}

function fitAnsi(value, width) {
  const plain = stripAnsi(value);
  if ([...plain].length <= width) return value;
  return truncate(plain, width);
}

function padAnsi(value, width) {
  const fitted = fitAnsi(value, width);
  return `${fitted}${" ".repeat(Math.max(0, width - visibleLength(fitted)))}`;
}

function parseContext() {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    return {};
  }
}

function run(cwd, command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    timeout: 8_000,
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
}

function runGit(cwd, commandArgs) {
  return run(cwd, "git", commandArgs);
}

function getRepoRoot(cwd) {
  const result = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  return result.ok ? result.stdout.trim() : "";
}

function getBranch(repoRoot) {
  const symbolic = runGit(repoRoot, ["symbolic-ref", "--short", "HEAD"]);
  if (symbolic.ok && symbolic.stdout.trim()) return symbolic.stdout.trim();
  const detached = runGit(repoRoot, ["rev-parse", "--short", "HEAD"]);
  return detached.stdout.trim() || "detached";
}

function resolveBase(repoRoot) {
  const requested = process.env.GIT_RAIL_BASE;
  const remoteHead = runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const defaultRemoteBranch = remoteHead.ok ? remoteHead.stdout.trim() : "";
  const candidates = [requested, defaultRemoteBranch, "origin/main", "origin/master", "main", "master"].filter(Boolean);
  for (const candidate of candidates) {
    const result = runGit(repoRoot, ["rev-parse", "--verify", "--quiet", candidate]);
    if (result.ok) return candidate;
  }
  return "HEAD";
}

function parseNumstat(output) {
  const stats = new Map();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [adds, deletes, ...pathParts] = line.split("\t");
    const filePath = pathParts.join("\t").replace(/^.* => /, "");
    if (!filePath) continue;
    stats.set(filePath, {
      additions: adds === "-" ? 0 : Number.parseInt(adds || "0", 10) || 0,
      deletions: deletes === "-" ? 0 : Number.parseInt(deletes || "0", 10) || 0,
      binary: adds === "-" && deletes === "-",
    });
  }
  return stats;
}

function mapStatus(code) {
  if (code === "A" || code === "?") return "added";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  if (code === "C") return "copied";
  return "modified";
}

function withStats(file, stats) {
  return { ...file, ...(stats.get(file.path) || { additions: 0, deletions: 0 }) };
}

function parseWorkingStatus(repoRoot) {
  const result = runGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!result.ok) return { staged: [], unstaged: [] };
  const stagedStats = parseNumstat(runGit(repoRoot, ["diff", "--cached", "--numstat"]).stdout);
  const unstagedStats = parseNumstat(runGit(repoRoot, ["diff", "--numstat"]).stdout);
  const staged = [];
  const unstaged = [];
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const indexCode = line[0] || " ";
    const workCode = line[1] || " ";
    const rawPath = line.slice(3);
    const filePath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) : rawPath;
    if (!filePath) continue;
    if (indexCode === "?" && workCode === "?") {
      let additions = 0;
      try {
        const content = fs.readFileSync(path.join(repoRoot, filePath));
        additions = content.length > 1_048_576 || content.includes(0) ? 0 : String(content).split("\n").length;
      } catch {}
      unstaged.push({ path: filePath, status: "added", additions, deletions: 0, untracked: true });
      continue;
    }
    if (indexCode !== " " && indexCode !== "?") {
      staged.push(withStats({ path: filePath, status: mapStatus(indexCode) }, stagedStats));
    }
    if (workCode !== " " && workCode !== "?") {
      unstaged.push(withStats({ path: filePath, status: mapStatus(workCode) }, unstagedStats));
    }
  }
  return { staged, unstaged };
}

function parseNameStatus(output, stats) {
  const files = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0]?.[0] || "M";
    const renamed = code === "R" || code === "C";
    const filePath = renamed ? parts[2] : parts[1];
    if (!filePath) continue;
    files.push(withStats({ path: filePath, status: mapStatus(code), oldPath: renamed ? parts[1] : undefined }, stats));
  }
  return files;
}

function getTracking(repoRoot) {
  const result = runGit(repoRoot, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  if (!result.ok) return { hasUpstream: false, pull: 0, push: 0 };
  const [pull, push] = result.stdout.trim().split(/\s+/).map((value) => Number.parseInt(value || "0", 10));
  return { hasUpstream: true, pull: pull || 0, push: push || 0 };
}

function getCommitFiles(repoRoot, commitHash) {
  if (!repoRoot || !commitHash) return [];
  const stats = parseNumstat(runGit(repoRoot, ["show", "--format=", "--find-renames", "--numstat", commitHash]).stdout);
  return parseNameStatus(
    runGit(repoRoot, ["show", "--format=", "--find-renames", "--name-status", commitHash]).stdout,
    stats,
  ).map((file) => ({ ...file, commitHash }));
}

function getLiveState(cwd) {
  const repoRoot = getRepoRoot(cwd);
  if (!repoRoot) {
    return {
      cwd,
      repoRoot: "",
      repository: path.basename(cwd),
      branch: "—",
      error: "No Git repository in the focused Herdr pane",
    };
  }
  const branch = getBranch(repoRoot);
  const baseRef = resolveBase(repoRoot);
  const baseLabel = baseRef.replace(/^origin\//, "");
  const working = parseWorkingStatus(repoRoot);
  const range = baseRef === "HEAD" ? "" : `${baseRef}...HEAD`;
  const againstStats = range
    ? parseNumstat(runGit(repoRoot, ["diff", "--numstat", range]).stdout)
    : new Map();
  const againstBase = range
    ? parseNameStatus(runGit(repoRoot, ["diff", "--name-status", "--find-renames", range]).stdout, againstStats)
    : [];
  const commitRange = baseRef === "HEAD" ? "" : `${baseRef}..HEAD`;
  const logArgs = ["log", "--max-count=40", "--format=%h%x1f%s%x1f%an%x1f%cr"];
  if (commitRange) logArgs.push(commitRange);
  const commits = runGit(repoRoot, logArgs).stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [shortHash, message, author, age] = line.split("\x1f");
      return { shortHash, message, author, age };
    });
  const countResult = commitRange ? runGit(repoRoot, ["rev-list", "--count", commitRange]) : { stdout: "0" };
  const totalCommits = Number.parseInt(countResult.stdout.trim() || "0", 10) || 0;
  const tracked = runGit(repoRoot, ["ls-files"]).stdout.split("\n").filter(Boolean);
  const tracking = getTracking(repoRoot);
  return {
    cwd,
    repoRoot,
    repository: path.basename(repoRoot),
    branch,
    baseLabel,
    againstBase,
    commits,
    totalCommits,
    staged: working.staged,
    unstaged: working.unstaged,
    tracked,
    tracking,
    reviewCount: 0,
    error: "",
  };
}

function getDemoState(cwd) {
  return {
    cwd,
    repoRoot: "/demo/git-rail",
    repository: "git-rail",
    branch: "feature/sidebar",
    baseLabel: "main",
    tracking: { hasUpstream: true, pull: 0, push: 3 },
    reviewCount: 2,
    totalCommits: 4,
    commits: [
      {
        shortHash: "9f14c2a", message: "add terminal Git rail model", author: "John", age: "12 minutes ago",
        files: [
          { path: "prototypes/herdr-git-rail/scripts/git-rail.mjs", status: "added", additions: 486, deletions: 0, commitHash: "9f14c2a" },
          { path: "prototypes/herdr-git-rail/README.md", status: "modified", additions: 22, deletions: 5, commitHash: "9f14c2a" },
        ],
      },
      {
        shortHash: "47b8d11", message: "preserve worktree context across focus", author: "John", age: "1 hour ago",
        files: [
          { path: "packages/core/src/workspace/context.ts", status: "modified", additions: 64, deletions: 8, commitHash: "47b8d11" },
        ],
      },
      {
        shortHash: "ca93e20", message: "render nested change paths", author: "John", age: "3 hours ago",
        files: [
          { path: "packages/core/src/git/status.ts", status: "modified", additions: 47, deletions: 12, commitHash: "ca93e20" },
          { path: "packages/core/src/git/status.test.ts", status: "added", additions: 91, deletions: 0, commitHash: "ca93e20" },
        ],
      },
      {
        shortHash: "1a4df83", message: "define Herdr panel entrypoint", author: "John", age: "yesterday",
        files: [
          { path: "prototypes/herdr-git-rail/herdr-plugin.toml", status: "added", additions: 8, deletions: 0, commitHash: "1a4df83" },
        ],
      },
    ],
    againstBase: [
      { path: "packages/cli/src/commands/status.ts", status: "modified", additions: 118, deletions: 21 },
      { path: "packages/core/src/workspace/context.ts", status: "modified", additions: 64, deletions: 8 },
      { path: "prototypes/herdr-git-rail/scripts/git-rail.mjs", status: "added", additions: 486, deletions: 0 },
      { path: "prototypes/herdr-git-rail/README.md", status: "modified", additions: 22, deletions: 5 },
      { path: "docs/work/git-rail.md", status: "added", additions: 91, deletions: 0 },
      { path: "packages/core/src/git/status.test.ts", status: "modified", additions: 47, deletions: 12 },
    ],
    staged: [
      { path: "prototypes/herdr-git-rail/herdr-plugin.toml", status: "modified", additions: 8, deletions: 2 },
      { path: "prototypes/herdr-git-rail/README.md", status: "modified", additions: 22, deletions: 5 },
    ],
    unstaged: [
      { path: "packages/cli/src/commands/status.ts", status: "modified", additions: 118, deletions: 21 },
      { path: "packages/core/src/workspace/context.ts", status: "modified", additions: 64, deletions: 8 },
      { path: "packages/core/src/git/status.test.ts", status: "modified", additions: 47, deletions: 12 },
      { path: "prototypes/herdr-git-rail/scripts/git-rail.mjs", status: "added", additions: 486, deletions: 0, untracked: true },
    ],
    tracked: [
      "README.md",
      "package.json",
      "packages/cli/src/commands/status.ts",
      "packages/cli/src/index.ts",
      "packages/core/src/git/status.ts",
      "packages/core/src/git/status.test.ts",
      "packages/core/src/workspace/context.ts",
      "prototypes/herdr-git-rail/README.md",
      "prototypes/herdr-git-rail/herdr-plugin.toml",
      "prototypes/herdr-git-rail/scripts/git-rail.mjs",
      "docs/work/git-rail.md",
    ],
    error: "",
  };
}

const context = parseContext();
const contextCwd =
  context.focused_pane_cwd ||
  context.workspace_cwd ||
  process.env.HERDR_WORKSPACE_CWD ||
  process.cwd();

let state = demoMode ? getDemoState(contextCwd) : getLiveState(contextCwd);
let mainTab = "changes";
let viewModePreference = "auto";
let selectedSection = 0;
let scrollOffset = 0;
let selectedPath = "";
let statusMessage = "Click a tab, section, commit, or file";
let fileSearchQuery = "";
let fileSearchActive = false;
let diffSearchQuery = "";
let diffSearchActive = false;
let hitTargets = [];
let lastClick = { label: "", at: 0 };
const expanded = { against: false, commits: false, staged: true, unstaged: true };
const sectionIds = ["against", "commits", "staged", "unstaged"];
const collapsedGroups = new Set();
const collapsedFileFolders = new Set();
const collapsedTreeFolders = new Map();
const expandedCommits = new Set();
const NARROW_RAIL_MAX = 88;

function resolvedViewMode(width) {
  if (viewModePreference !== "auto") return viewModePreference;
  return width <= NARROW_RAIL_MAX ? "grouped" : "tree";
}

function toggleViewMode(width) {
  const current = resolvedViewMode(width);
  viewModePreference = current === "tree" ? "grouped" : "tree";
  statusMessage = `File layout: ${viewModePreference}`;
}

function interactive(text, onClick, label, onDoubleClick = null) {
  return { text, onClick, label, onDoubleClick };
}

function interactiveRegions(text, targets) {
  return { text, targets };
}

function lineText(value) {
  return typeof value === "string" ? value : value.text;
}

function statusGlyph(file) {
  switch (file.status) {
    case "added": return `${C.leaf}⊞${C.reset}`;
    case "deleted": return `${C.red}⊟${C.reset}`;
    case "renamed": return `${C.blue}↪${C.reset}`;
    case "copied": return `${C.purple}⧉${C.reset}`;
    default: return `${C.amber}⊡${C.reset}`;
  }
}

function displayGlyph(file, surface) {
  return surface === "file" && file.clean ? `${C.dim}·${C.reset}` : statusGlyph(file);
}

function statsLabel(file) {
  const added = file.additions > 0 ? `${C.leaf}+${file.additions}${C.reset}` : "";
  const deleted = file.deletions > 0 ? `${C.red}−${file.deletions}${C.reset}` : "";
  return [added, deleted].filter(Boolean).join(" ");
}

function tab(label, active, width) {
  const content = ` ${label} `;
  const padded = padAnsi(content, width);
  return active ? `${C.selected}${C.gold}${C.bold}${padded}${C.reset}` : `${C.dim}${padded}${C.reset}`;
}

function searchField(query, active, placeholder, countText, width) {
  const countWidth = visibleLength(countText);
  const fieldWidth = Math.max(8, width - countWidth - (countText ? 1 : 0));
  const value = active ? query : query || placeholder;
  const caret = active ? "▏" : "";
  const content = ` ⌕ ${truncate(value, Math.max(1, fieldWidth - 4 - visibleLength(caret)))}${caret}`;
  const tone = active ? C.gold : query ? C.bold : C.dim;
  const field = `${C.selected}${tone}${padAnsi(content, fieldWidth)}${C.reset}`;
  return `${field}${countText ? ` ${countText}` : ""}`;
}

function rule(width) {
  return `${C.faint}${"─".repeat(width)}${C.reset}`;
}

function treeGuides(depth, width) {
  if (depth <= 0) return "";
  const unit = width <= 46 ? "│" : "│ ";
  return `${C.faint}${unit.repeat(depth)}${C.reset}`;
}

function buildTree(files, collapsedFolders = null) {
  const root = { children: new Map() };
  for (const file of files) {
    const parts = file.path.split("/");
    let current = root;
    parts.forEach((part, index) => {
      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          type: index === parts.length - 1 ? "file" : "folder",
          file: index === parts.length - 1 ? file : null,
          children: new Map(),
        });
      }
      current = current.children.get(part);
    });
  }
  const sortNodes = (node) => [...node.children.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const rows = [];
  const visit = (node, depth, parentPath = "") => {
    const children = sortNodes(node);
    children.forEach((child) => {
      const nodePath = parentPath ? `${parentPath}/${child.name}` : child.name;
      if (child.type === "folder") {
        rows.push({ kind: "folder", depth, name: child.name, path: nodePath });
        if (!collapsedFolders?.has(nodePath)) visit(child, depth + 1, nodePath);
      } else {
        rows.push({ kind: "file", depth, name: child.name, file: child.file });
      }
    });
  };
  visit(root, 0);
  return rows;
}

function selectFile(file, surface = "diff") {
  selectedPath = file.path;
  statusMessage = `${surface === "file" ? "File" : "Diff"}: ${file.path}`;
}

function currentHerdrPaneId() {
  if (process.env.HERDR_PANE_ID) return process.env.HERDR_PANE_ID;
  const result = run(contextCwd, process.env.HERDR_BIN_PATH || "herdr", ["pane", "current", "--current"]);
  if (!result.ok) return "";
  try {
    return JSON.parse(result.stdout)?.result?.pane?.pane_id || "";
  } catch {
    return "";
  }
}

function openExternally(file) {
  if (!state.repoRoot || demoMode) return false;
  const absolutePath = path.resolve(state.repoRoot, file.path);
  const rootPrefix = `${path.resolve(state.repoRoot)}${path.sep}`;
  if (!absolutePath.startsWith(rootPrefix) || !fs.existsSync(absolutePath)) return false;
  const launcher = process.platform === "darwin" ? "open" : "xdg-open";
  const result = spawnSync(launcher, [absolutePath], { stdio: "ignore", timeout: 8_000 });
  return result.status === 0;
}

function openPreview(file, surface = "diff") {
  const herdr = process.env.HERDR_BIN_PATH || "herdr";
  const pluginId = process.env.HERDR_PLUGIN_ID || "local.git-rail";
  const workspaceId = process.env.HERDR_WORKSPACE_ID || context.workspace_id || "";
  const paneId = currentHerdrPaneId();

  if (workspaceId) {
    const paneList = run(contextCwd, herdr, ["pane", "list", "--workspace", workspaceId]);
    if (paneList.ok) {
      try {
        const panes = JSON.parse(paneList.stdout)?.result?.panes || [];
        for (const pane of panes) {
          if (pane.label === "Git File Preview" && pane.pane_id !== paneId) {
            run(contextCwd, herdr, ["pane", "close", pane.pane_id]);
          }
        }
      } catch {
        // A stale preview is harmless; opening the new one is the useful action.
      }
    }
  }

  const previewArgs = [
    "plugin", "pane", "open",
    "--plugin", pluginId,
    "--entrypoint", "file-preview",
    "--placement", "overlay",
    "--env", `GIT_RAIL_PREVIEW_PATH=${file.path}`,
    "--env", `GIT_RAIL_PREVIEW_MODE=${surface}`,
    "--env", `GIT_RAIL_PREVIEW_REPO=${state.repoRoot || ""}`,
    "--env", `GIT_RAIL_PREVIEW_DEMO=${demoMode ? "1" : "0"}`,
    "--env", `GIT_RAIL_PREVIEW_COMMIT=${file.commitHash || ""}`,
    "--env", `GIT_RAIL_PREVIEW_STATUS=${file.status || "modified"}`,
    "--focus",
  ];

  const result = run(contextCwd, herdr, previewArgs);
  if (result.ok) {
    statusMessage = `Preview opened: ${file.path}`;
    return;
  }
  statusMessage = openExternally(file)
    ? `Opened externally: ${file.path}`
    : `Could not open preview: ${file.path}`;
}

function renderTree(files, width, limit = 18, surface = "diff", baseIndent = 1, treeScope = "") {
  if (treeScope && !collapsedTreeFolders.has(treeScope)) collapsedTreeFolders.set(treeScope, new Set());
  const collapsedFolders = treeScope ? collapsedTreeFolders.get(treeScope) : null;
  const rows = buildTree(files, collapsedFolders).slice(0, limit);
  return rows.map((row) => {
    const guides = treeGuides(row.depth, width);
    const indentation = " ".repeat(baseIndent);
    if (row.kind === "folder") {
      const isOpen = !collapsedFolders?.has(row.path);
      const folderLine = fitAnsi(`${indentation}${guides}${C.fog}${isOpen ? "⌄" : "›"} ${row.name}/${C.reset}`, width);
      if (!collapsedFolders) return folderLine;
      return interactive(folderLine, () => {
        if (isOpen) collapsedFolders.add(row.path);
        else collapsedFolders.delete(row.path);
        statusMessage = `${isOpen ? "Collapsed" : "Expanded"} ${row.path}`;
      }, `${isOpen ? "Collapse" : "Expand"} folder: ${row.path}`);
    }
    const prefix = `${indentation}${guides}${displayGlyph(row.file, surface)} `;
    const stats = statsLabel(row.file);
    const available = Math.max(1, width - visibleLength(prefix) - visibleLength(stats) - (stats ? 1 : 0));
    const fileLabel = `${prefix}${truncate(row.name, available)}`;
    const text = stats
      ? `${padAnsi(fileLabel, width - visibleLength(stats) - 1)} ${stats}`
      : fileLabel;
    return interactive(
      row.file.path === selectedPath ? `${C.selected}${padAnsi(text, width)}${C.reset}` : text,
      () => selectFile(row.file, surface),
      `${surface === "file" ? "Select file" : "Select diff"}: ${row.file.path}`,
      () => openPreview(row.file, surface),
    );
  });
}

function renderGrouped(files, width, limit = 18, surface = "diff", groupScope = surface, baseIndent = 1) {
  const groups = new Map();
  for (const file of files) {
    const folder = path.dirname(file.path) === "." ? "" : path.dirname(file.path);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(file);
  }
  const lines = [];
  for (const [folder, entries] of [...groups.entries()].sort()) {
    const indentation = " ".repeat(baseIndent);
    const sortedEntries = entries.sort((a, b) => a.path.localeCompare(b.path));
    if (!folder) {
      for (const file of sortedEntries) {
        const prefix = `${indentation}${displayGlyph(file, surface)} `;
        const stats = statsLabel(file);
        const available = Math.max(1, width - visibleLength(prefix) - visibleLength(stats) - (stats ? 1 : 0));
        const fileLabel = `${prefix}${truncate(path.basename(file.path), available)}`;
        const text = stats
          ? `${padAnsi(fileLabel, width - visibleLength(stats) - 1)} ${stats}`
          : fileLabel;
        lines.push(interactive(
          file.path === selectedPath ? `${C.selected}${padAnsi(text, width)}${C.reset}` : text,
          () => selectFile(file, surface),
          `${surface === "file" ? "Select file" : "Select diff"}: ${file.path}`,
          () => openPreview(file, surface),
        ));
        if (lines.length >= limit) return lines;
      }
      continue;
    }

    const groupKey = `${groupScope}:${folder}`;
    const isOpen = !collapsedGroups.has(groupKey);
    const folderPrefix = `${indentation}${C.fog}${isOpen ? "⌄" : "›"} ${C.reset}`;
    const folderCount = `${C.dim}${entries.length}${C.reset}`;
    const folderWidth = Math.max(1, width - visibleLength(folderPrefix) - visibleLength(folderCount) - 1);
    const folderName = compactFolderPath(folder, folderWidth);
    const folderLeft = `${folderPrefix}${C.fog}${folderName}${C.reset}`;
    const folderLine = `${padAnsi(folderLeft, width - visibleLength(folderCount) - 1)} ${folderCount}`;
    lines.push(interactive(folderLine, () => {
      if (isOpen) collapsedGroups.add(groupKey);
      else collapsedGroups.delete(groupKey);
      statusMessage = `${isOpen ? "Collapsed" : "Expanded"} ${folder}`;
    }, `${isOpen ? "Collapse" : "Expand"} folder: ${folder}`));
    if (!isOpen) {
      if (lines.length >= limit) return lines;
      continue;
    }

    for (const [entryIndex, file] of sortedEntries.entries()) {
      const name = path.basename(file.path);
      const connector = entryIndex === sortedEntries.length - 1 ? "└─" : "├─";
      const prefix = `${indentation} ${C.faint}${connector}${C.reset} ${displayGlyph(file, surface)} `;
      const stats = statsLabel(file);
      const available = Math.max(1, width - visibleLength(prefix) - visibleLength(stats) - (stats ? 1 : 0));
      const fileLabel = `${prefix}${truncate(name, available)}`;
      const text = stats
        ? `${padAnsi(fileLabel, width - visibleLength(stats) - 1)} ${stats}`
        : fileLabel;
      lines.push(interactive(
        file.path === selectedPath ? `${C.selected}${padAnsi(text, width)}${C.reset}` : text,
        () => selectFile(file, surface),
        `${surface === "file" ? "Select file" : "Select diff"}: ${file.path}`,
        () => openPreview(file, surface),
      ));
      if (lines.length >= limit) return lines;
    }
    if (lines.length >= limit) return lines;
  }
  return lines;
}

function sectionHeader(id, label, count, index, width, badgeColor = C.dim, forceExpanded = false) {
  const isSelected = selectedSection === index;
  const isOpen = forceExpanded || expanded[id];
  const chevron = isOpen ? "⌄" : "›";
  const badge = `${badgeColor}${count}${C.reset}`;
  const marker = isSelected ? `${C.gold}▏${C.reset}` : " ";
  const content = `${marker}${chevron} ${isSelected ? `${C.bold}${label}${C.reset}` : label}  ${badge}`;
  return interactive(fitAnsi(content, width), () => {
    selectedSection = index;
    if (forceExpanded) {
      statusMessage = "Clear the search to collapse filtered sections";
      return;
    }
    expanded[id] = !expanded[id];
    statusMessage = `${expanded[id] ? "Expanded" : "Collapsed"} ${label}`;
  }, `${isOpen ? "Collapse" : "Expand"} ${label}`);
}

function filesForCommit(commit) {
  if (!Array.isArray(commit.files)) {
    commit.files = getCommitFiles(state.repoRoot, commit.shortHash);
  }
  return commit.files;
}

function toggleCommit(commit) {
  if (expandedCommits.has(commit.shortHash)) {
    expandedCommits.delete(commit.shortHash);
    statusMessage = `Collapsed commit ${commit.shortHash}`;
    return;
  }
  filesForCommit(commit);
  expandedCommits.add(commit.shortHash);
  statusMessage = `Expanded commit ${commit.shortHash}`;
}

function gitToolbar(width) {
  const viewMode = resolvedViewMode(width);
  const layoutLabel = viewMode === "tree" ? "≡ Tree" : "≣ Folders";
  const refreshLabel = "↻ Refresh";
  const separator = "   ";
  const refreshStart = 2 + visibleLength(layoutLabel) + visibleLength(separator);
  const toolLine = ` ${C.gold}${layoutLabel}${C.reset}${separator}${C.fog}${refreshLabel}${C.reset}`;
  return interactiveRegions(fitAnsi(toolLine, width), [
    {
      x1: 1,
      x2: 1 + visibleLength(layoutLabel),
      label: "Toggle tree/folder layout",
      action: () => toggleViewMode(width),
    },
    {
      x1: refreshStart,
      x2: refreshStart + visibleLength(refreshLabel) - 1,
      label: "Refresh Git state",
      action: () => refresh(true),
    },
  ]);
}

function renderDiffs(width) {
  const lines = [];
  const viewMode = resolvedViewMode(width);
  const query = diffSearchQuery.trim();
  const againstFiles = query ? searchFiles(state.againstBase, query) : state.againstBase;
  const stagedFiles = query ? searchFiles(state.staged, query) : state.staged;
  const unstagedFiles = query ? searchFiles(state.unstaged, query) : state.unstaged;
  const matchCount = againstFiles.length + stagedFiles.length + unstagedFiles.length;
  const countText = query
    ? `${C.dim}${matchCount} match${matchCount === 1 ? "" : "es"}${C.reset}`
    : "";
  lines.push(interactive(
    searchField(diffSearchQuery, diffSearchActive, "Search changed files…", countText, width),
    () => {
      diffSearchActive = true;
      fileSearchActive = false;
      scrollOffset = 0;
      statusMessage = "Type to search changed files";
    },
    "Search changed files",
  ));

  lines.push(gitToolbar(width));

  lines.push(rule(width));

  if (query && matchCount === 0) {
    lines.push(` ${C.dim}No changed files match “${truncate(diffSearchQuery, Math.max(4, width - 27))}”${C.reset}`);
    return lines;
  }

  const sections = [
    ["against", `Against ${state.baseLabel}`, againstFiles.length, againstFiles],
    ...(query ? [] : [["commits", "Commits", state.totalCommits, state.commits]]),
    ["staged", "Staged", stagedFiles.length, stagedFiles],
    ["unstaged", "Unstaged", unstagedFiles.length, unstagedFiles],
  ];

  sections.forEach(([id, label, count, items], index) => {
    if (count === 0) return;
    const badgeColor = id === "staged" ? C.leaf : id === "unstaged" ? C.amber : C.dim;
    const forceExpanded = Boolean(query) && id !== "commits";
    lines.push(sectionHeader(id, label, count, index, width, badgeColor, forceExpanded));
    if (!forceExpanded && !expanded[id]) return;
    if (id === "commits") {
      for (const commit of items.slice(0, 7)) {
        const isOpen = expandedCommits.has(commit.shortHash);
        const prefix = ` ${C.faint}${isOpen ? "⌄" : "›"}${C.reset} ${C.gold}${commit.shortHash}${C.reset} `;
        const age = commit.age?.replace(" ago", "") || "";
        const available = Math.max(1, width - visibleLength(prefix) - age.length - 1);
        const commitLine = `${prefix}${truncate(commit.message, available)} ${C.dim}${age}${C.reset}`;
        lines.push(interactive(commitLine, () => toggleCommit(commit), `${isOpen ? "Collapse" : "Expand"} commit ${commit.shortHash}`));
        if (!isOpen) continue;

        const commitFiles = filesForCommit(commit);
        if (commitFiles.length === 0) {
          lines.push(`    ${C.dim}No changed files${C.reset}`);
        } else if (viewMode === "tree") {
          lines.push(...renderTree(commitFiles, width, 40, "diff", 1, `commit:${commit.shortHash}`));
        } else {
          lines.push(...renderGrouped(commitFiles, width, 40, "diff", `commit:${commit.shortHash}`, 1));
        }
      }
    } else {
      lines.push(...(viewMode === "tree" ? renderTree(items, width, 18, "diff", 1, id) : renderGrouped(items, width, 18, "diff", id)));
    }
  });
  return lines;
}

function fileEntries() {
  const byPath = new Map();
  for (const filePath of state.tracked || []) {
    byPath.set(filePath, {
      path: filePath,
      status: "modified",
      additions: 0,
      deletions: 0,
      clean: true,
    });
  }
  for (const file of [...(state.staged || []), ...(state.unstaged || [])]) {
    byPath.set(file.path, { ...file, clean: false });
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function searchFiles(files, rawQuery) {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return files;
  return files
    .filter((file) => file.path.toLocaleLowerCase().includes(query))
    .sort((a, b) => {
      const aName = path.basename(a.path).toLocaleLowerCase();
      const bName = path.basename(b.path).toLocaleLowerCase();
      const score = (name, fullPath) => {
        if (name === query) return 0;
        if (name.startsWith(query)) return 1;
        if (name.includes(query)) return 2;
        if (fullPath.toLocaleLowerCase().startsWith(query)) return 3;
        return 4;
      };
      return score(aName, a.path) - score(bName, b.path) || a.path.localeCompare(b.path);
    });
}

function renderFiles(width) {
  const files = fileEntries();
  const results = searchFiles(files, fileSearchQuery);
  const query = fileSearchQuery.trim();
  const viewMode = resolvedViewMode(width);
  const countText = query ? `${C.dim}${results.length} match${results.length === 1 ? "" : "es"}${C.reset}` : "";
  const searchRow = interactive(
    searchField(fileSearchQuery, fileSearchActive, "Search files…", countText, width),
    () => {
      fileSearchActive = true;
      scrollOffset = 0;
      statusMessage = "Type to search files";
    },
    "Search files",
  );
  const toolbarRow = gitToolbar(width);

  if (query) {
    const resultRows = results.slice(0, 200).map((file) => {
      const glyph = file.clean ? `${C.dim}·${C.reset}` : statusGlyph(file);
      const name = path.basename(file.path);
      const parent = path.dirname(file.path) === "." ? "" : path.dirname(file.path);
      const prefix = ` ${glyph} `;
      const parentWidth = Math.max(8, Math.floor(width * 0.46));
      const parentLabel = parent ? compactFolderPath(parent, parentWidth) : "";
      const suffix = parentLabel ? `  ${C.dim}${parentLabel}${C.reset}` : "";
      const available = Math.max(1, width - visibleLength(prefix) - visibleLength(suffix));
      const text = `${prefix}${truncate(name, available)}${suffix}`;
      return interactive(
        file.path === selectedPath ? `${C.selected}${padAnsi(text, width)}${C.reset}` : fitAnsi(text, width),
        () => selectFile(file, "file"),
        `Select file: ${file.path}`,
        () => openPreview(file, "file"),
      );
    });
    return [
      searchRow,
      toolbarRow,
      rule(width),
      ...(resultRows.length ? resultRows : [` ${C.dim}No files match “${truncate(fileSearchQuery, Math.max(4, width - 19))}”${C.reset}`]),
    ];
  }

  if (viewMode === "grouped") {
    return [
      searchRow,
      toolbarRow,
      rule(width),
      ...renderGrouped(files, width, 200, "file", "files"),
    ];
  }

  const rows = buildTree(files, collapsedFileFolders).slice(0, 200);
  return [
    searchRow,
    toolbarRow,
    rule(width),
    ...rows.map((row) => {
      const guides = treeGuides(row.depth, width);
      if (row.kind === "folder") {
        const isOpen = !collapsedFileFolders.has(row.path);
        const folderLine = fitAnsi(` ${guides}${C.fog}${isOpen ? "⌄" : "›"} ${row.name}/${C.reset}`, width);
        return interactive(folderLine, () => {
          if (isOpen) collapsedFileFolders.add(row.path);
          else collapsedFileFolders.delete(row.path);
          statusMessage = `${isOpen ? "Collapsed" : "Expanded"} ${row.path}`;
        }, `${isOpen ? "Collapse" : "Expand"} folder: ${row.path}`);
      }
      const glyph = displayGlyph(row.file, "file");
      const text = fitAnsi(` ${guides}${glyph} ${row.name}`, width);
      return interactive(
        row.file.path === selectedPath ? `${C.selected}${padAnsi(text, width)}${C.reset}` : text,
        () => selectFile(row.file, "file"),
        `Select file: ${row.file.path}`,
        () => openPreview(row.file, "file"),
      );
    }),
  ];
}

function renderBody(width) {
  if (state.error) {
    return ["", `${C.red}${state.error}${C.reset}`, `${C.dim}${truncate(state.cwd, width)}${C.reset}`, "", "Focus a pane inside a Git worktree, then press r."];
  }
  if (mainTab === "files") return renderFiles(width);
  return renderDiffs(width);
}

function renderHeader(width) {
  const changedCount = state.error ? 0 : new Set([...state.staged, ...state.unstaged].map((file) => file.path)).size;
  const primaryWidth = Math.floor(width / 2);
  const repository = state.repository || "repository";
  const branch = state.branch || "—";
  return {
    primaryWidth,
    primaryRow: 4,
    lines: [
      ` ${C.bold}${truncate(repository, Math.max(1, width - 1))}${C.reset}`,
      `  ${C.fog}⑂ ${truncate(branch, Math.max(1, width - 4))}${C.reset}`,
      rule(width),
      `${tab(`CHANGES ${changedCount}`, mainTab === "changes", primaryWidth)}${tab("FILES", mainTab === "files", width - primaryWidth)}`,
    ],
  };
}

function renderFrame() {
  const width = Math.max(20, forcedWidth || process.stdout.columns || 52);
  const height = Math.max(18, forcedHeight || process.stdout.rows || 42);
  const { lines: header, primaryWidth, primaryRow } = renderHeader(width);
  const searchActive = fileSearchActive || diffSearchActive;
  const controls = searchActive
    ? "type to filter · Enter done · Esc close · Ctrl-U clear"
    : mainTab === "files"
      ? "/ search · Tab changes · g layout · dbl-click open · q"
      : "/ search · Tab files · g layout · q close";
  const genericStatuses = new Set([
    "Click a tab, section, commit, or file",
    "Changes",
    "Files",
    "Diffs",
    "Review",
    "Git state refreshed",
  ]);
  const footerText = searchActive || genericStatuses.has(statusMessage) ? controls : statusMessage;
  const footer = [
    rule(width),
    `${C.dim}${fitAnsi(footerText, width)}${C.reset}`,
  ];
  const bodyHeight = Math.max(1, height - header.length - footer.length);
  const body = renderBody(width);
  const fixedBodyCount = state.error
    ? 0
    : mainTab === "files"
      ? 3
      : 3;
  const fixedBody = body.slice(0, Math.min(fixedBodyCount, bodyHeight));
  const scrollableBody = body.slice(fixedBody.length);
  const scrollableHeight = Math.max(0, bodyHeight - fixedBody.length);
  const maxOffset = Math.max(0, scrollableBody.length - scrollableHeight);
  scrollOffset = Math.max(0, Math.min(scrollOffset, maxOffset));
  const viewport = [
    ...fixedBody,
    ...scrollableBody.slice(scrollOffset, scrollOffset + scrollableHeight),
  ];
  while (viewport.length < bodyHeight) viewport.push("");
  hitTargets = [];
  hitTargets.push(
    { row: primaryRow, x1: 1, x2: primaryWidth, label: "Show Changes", action: () => { mainTab = "changes"; fileSearchActive = false; scrollOffset = 0; statusMessage = "Changes"; } },
    { row: primaryRow, x1: primaryWidth + 1, x2: width, label: "Show Files", action: () => { mainTab = "files"; diffSearchActive = false; scrollOffset = 0; statusMessage = "Files"; } },
  );
  viewport.forEach((entry, index) => {
    if (typeof entry === "string") return;
    const row = header.length + index + 1;
    if (Array.isArray(entry.targets)) {
      for (const target of entry.targets) {
        hitTargets.push({ row, ...target });
      }
    }
    if (!entry.onClick) return;
    hitTargets.push({
      row,
      x1: 1,
      x2: width,
      label: entry.label,
      action: entry.onClick,
      doubleAction: entry.onDoubleClick,
    });
  });
  return [...header, ...viewport, ...footer]
    .map((line) => padAnsi(lineText(line), width))
    .join("\n");
}

function draw() {
  const frame = renderFrame();
  process.stdout.write(snapshotMode ? `${frame}\n` : `${ESC}2J${ESC}H${frame}`);
}

function refresh(announce = false) {
  state = demoMode ? getDemoState(contextCwd) : getLiveState(contextCwd);
  scrollOffset = 0;
  if (announce) statusMessage = "Git state refreshed";
  draw();
}

function cleanup() {
  if (!snapshotMode) process.stdout.write(`${ESC}?1000l${ESC}?1006l${ESC}?25h${ESC}?1049l`);
}

function quit() {
  cleanup();
  process.exit(0);
}

if (snapshotMode) {
  draw();
  process.exit(0);
}

process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}?1000h${ESC}?1006h`);
process.stdout.on("error", () => {});
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
process.on("exit", cleanup);
process.stdout.on("resize", draw);

process.stdin.setEncoding("utf8");
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (key) => {
  if (!key) return;
  const mousePattern = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
  let mouseMatch;
  let handledMouse = false;
  while ((mouseMatch = mousePattern.exec(key)) !== null) {
    handledMouse = true;
    const button = Number.parseInt(mouseMatch[1], 10);
    const column = Number.parseInt(mouseMatch[2], 10);
    const row = Number.parseInt(mouseMatch[3], 10);
    const phase = mouseMatch[4];
    if (button === 64 && phase === "M") {
      scrollOffset = Math.max(0, scrollOffset - 3);
    } else if (button === 65 && phase === "M") {
      scrollOffset += 3;
    } else if (button === 0 && phase === "M") {
      const target = hitTargets.find((hit) => hit.row === row && column >= hit.x1 && column <= hit.x2);
      if (target) {
        const now = Date.now();
        const isDoubleClick = Boolean(target.doubleAction) && lastClick.label === target.label && now - lastClick.at <= 450;
        if (isDoubleClick) {
          target.doubleAction();
          lastClick = { label: "", at: 0 };
        } else {
          target.action();
          lastClick = { label: target.label, at: now };
        }
      } else {
        lastClick = { label: "", at: 0 };
      }
    }
  }
  if (handledMouse) {
    draw();
    return;
  }
  if (key === "\u0003") return quit();
  const activeSearch = fileSearchActive ? "files" : diffSearchActive ? "diffs" : "";
  if (activeSearch) {
    let query = activeSearch === "files" ? fileSearchQuery : diffSearchQuery;
    if (key === "\u001b") {
      if (activeSearch === "files") fileSearchActive = false;
      else diffSearchActive = false;
      statusMessage = query.trim() ? `Search: ${query.trim()}` : activeSearch === "files" ? "Files" : "Diffs";
    } else if (key === "\r" || key === "\n") {
      if (activeSearch === "files") fileSearchActive = false;
      else diffSearchActive = false;
      statusMessage = query.trim() ? `Search: ${query.trim()}` : activeSearch === "files" ? "Files" : "Diffs";
    } else if (key === "\u007f" || key === "\b") {
      query = [...query].slice(0, -1).join("");
      scrollOffset = 0;
    } else if (key === "\u0015") {
      query = "";
      scrollOffset = 0;
    } else {
      const textInput = key
        .replaceAll("\u001b[200~", "")
        .replaceAll("\u001b[201~", "")
        .replace(/\u001b\[[0-9;]*[A-Za-z~]/g, "");
      for (const character of textInput) {
        if (character >= " " && character !== "\u007f") query += character;
      }
      scrollOffset = 0;
    }
    if (activeSearch === "files") fileSearchQuery = query;
    else diffSearchQuery = query;
    draw();
    return;
  }
  if (key === "q" || key === "\u001b") return quit();
  if (key === "\t") {
    mainTab = mainTab === "changes" ? "files" : "changes";
    fileSearchActive = false;
    diffSearchActive = false;
    scrollOffset = 0;
  } else if (key === "/") {
    fileSearchActive = mainTab === "files";
    diffSearchActive = mainTab === "changes";
    scrollOffset = 0;
    statusMessage = mainTab === "files" ? "Type to search files" : "Type to search changed files";
  } else if (key === "j" || key === "\u001b[B") {
    selectedSection = Math.min(sectionIds.length - 1, selectedSection + 1);
    scrollOffset++;
  } else if (key === "k" || key === "\u001b[A") {
    selectedSection = Math.max(0, selectedSection - 1);
    scrollOffset--;
  } else if (key === " ") {
    const id = sectionIds[selectedSection];
    expanded[id] = !expanded[id];
  } else if (key === "g") {
    toggleViewMode(Math.max(20, forcedWidth || process.stdout.columns || 52));
  } else if (key === "r") {
    return refresh(true);
  }
  draw();
});

draw();
setInterval(() => {
  if (!demoMode) refresh(false);
}, 2_500);
