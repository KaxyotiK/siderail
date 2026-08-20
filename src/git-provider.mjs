import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import {
  mergeStats,
  mergeMetadata,
  parseCommitLogZ,
  parseCommitPathsRawLogZ,
  parseLsFilesStageZ,
  parseNameStatusZ,
  parseNumstatZ,
  parsePorcelainV2Z,
  parseRawDiffZ,
  statusName,
} from "./git-parsers.mjs";
import { buildPathIndex } from "./model.mjs";
import { ProcessError, runGit } from "./process.mjs";

const UNTRACKED_STATS_FILE_LIMIT = 256;
const UNTRACKED_STATS_BYTE_LIMIT = 16 * 1024 * 1024;
const UNTRACKED_STATS_TIME_MS = 250;

const HISTORY_LIMIT = 200;

async function gitText(cwd, args, options = {}) {
  return (await runGit(cwd, args, options)).stdout;
}

async function resolveRepository(cwd) {
  try {
    const repoRoot = (await gitText(cwd, ["rev-parse", "--show-toplevel"])).trim();
    return await fs.realpath(repoRoot);
  } catch (error) {
    if (error instanceof ProcessError && error.kind === "missing-executable") throw error;
    return "";
  }
}

async function resolveBranch(repoRoot) {
  try {
    return (await gitText(repoRoot, ["symbolic-ref", "--short", "HEAD"])).trim();
  } catch {
    try {
      return `detached ${(await gitText(repoRoot, ["rev-parse", "--short", "HEAD"])).trim()}`;
    } catch {
      return "unborn";
    }
  }
}

async function refExists(repoRoot, ref) {
  try {
    await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

async function resolveBase(repoRoot, requested) {
  let remoteHead = "";
  try {
    remoteHead = (await gitText(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).trim();
  } catch {}
  const candidates = [...new Set([requested, remoteHead, "origin/main", "origin/master", "main", "master"].filter(Boolean))];
  for (const candidate of candidates) if (await refExists(repoRoot, candidate)) return candidate;
  return (await refExists(repoRoot, "HEAD")) ? "HEAD" : "";
}

function withDescriptor(files, descriptor) {
  return files.map((file) => ({ ...file, descriptor }));
}

async function changedFiles(repoRoot, diffArgs, descriptor) {
  const [names, numstat, raw] = await Promise.all([
    gitText(repoRoot, ["diff", ...diffArgs, "--name-status", "-z", "--find-renames", "--find-copies-harder"]),
    gitText(repoRoot, ["diff", ...diffArgs, "--numstat", "-z", "--find-renames", "--find-copies-harder"]),
    gitText(repoRoot, ["diff", ...diffArgs, "--raw", "-z", "--abbrev=40", "--find-renames", "--find-copies-harder"]),
  ]);
  return withDescriptor(mergeMetadata(mergeStats(parseNameStatusZ(names), parseNumstatZ(numstat)), parseRawDiffZ(raw)), descriptor);
}

async function workspaceState(repoRoot, baseRef) {
  if (!baseRef) return { workspaceChanges: [], workspaceDescriptor: null };
  let mergeBase = baseRef;
  if (baseRef !== "HEAD") {
    try { mergeBase = (await gitText(repoRoot, ["merge-base", baseRef, "HEAD"])).trim() || baseRef; }
    catch {}
  }
  const workspaceDescriptor = { kind: "workspace", baseRef, mergeBase };
  return {
    workspaceChanges: await changedFiles(repoRoot, [mergeBase], workspaceDescriptor),
    workspaceDescriptor,
  };
}

async function countUntracked(repoRoot, filePath, maxBytes, budgetBytes, deadline) {
  try {
    const root = await fs.realpath(repoRoot);
    const lexical = path.resolve(root, filePath);
    if (lexical !== root && !lexical.startsWith(`${root}${path.sep}`)) return { additions: 0, binary: false };
    const lexicalStat = await fs.lstat(lexical);
    const symlink = lexicalStat.isSymbolicLink();
    if (symlink) {
      const buffer = await fs.readlink(lexical, { encoding: "buffer" });
      if (buffer.length > maxBytes) return { additions: 0, binary: false, oversized: true, symlink };
      if (buffer.length > budgetBytes || Date.now() >= deadline) return { additions: 0, binary: false, symlink, statsUnavailable: true, inspectedBytes: 0 };
      const binary = buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0);
      const additions = buffer.length === 0 ? 0 : buffer.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0) + (buffer.at(-1) === 0x0a ? 0 : 1);
      return { additions: binary ? 0 : additions, binary, symlink, inspectedBytes: buffer.length };
    }
    const absolute = await fs.realpath(lexical);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return { additions: 0, binary: false, statsUnavailable: true, inspectedBytes: 0 };
    const handle = await fs.open(absolute, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return { additions: 0, binary: false, statsUnavailable: true, inspectedBytes: 0 };
      if (stat.size > maxBytes) return { additions: 0, binary: false, oversized: true, inspectedBytes: 0 };
      if (stat.size > budgetBytes || Date.now() >= deadline) return { additions: 0, binary: false, statsUnavailable: true, inspectedBytes: 0 };
      const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1, stat.size)));
      let additions = 0;
      let binary = false;
      let offset = 0;
      let lastByte = -1;
      while (offset < stat.size) {
        if (Date.now() >= deadline) return { additions: 0, binary: false, statsUnavailable: true, inspectedBytes: offset };
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
        if (!bytesRead) break;
        const content = chunk.subarray(0, bytesRead);
        const binarySampleLength = Math.max(0, Math.min(bytesRead, 8_192 - offset));
        if (binarySampleLength && content.subarray(0, binarySampleLength).includes(0)) binary = true;
        if (!binary) additions += content.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0);
        offset += bytesRead;
        lastByte = content.at(-1);
        if (binary) break;
      }
      if (!binary && offset > 0 && lastByte !== 0x0a) additions += 1;
      return { additions: binary ? 0 : additions, binary, inspectedBytes: offset };
    } finally {
      await handle.close();
    }
  } catch {
    return { additions: 0, binary: false, statsUnavailable: true, inspectedBytes: 0 };
  }
}

function comparisonModeMetadata(oldMode, newMode) {
  if (!oldMode || !newMode) return {};
  return {
    mode: newMode,
    oldMode,
    newMode,
    executableChange: oldMode !== newMode && (oldMode === "100755" || newMode === "100755"),
    executable: newMode === "100755",
    oldSymlink: oldMode === "120000",
    symlink: newMode === "120000",
    oldSubmodule: oldMode === "160000",
    submodule: newMode === "160000",
  };
}

async function workingFiles(repoRoot, maxFileBytes) {
  const output = await gitText(repoRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  const records = parsePorcelainV2Z(output);
  const [stagedStatsOutput, unstagedStatsOutput] = await Promise.all([
    gitText(repoRoot, ["diff", "--cached", "--numstat", "-z", "--find-renames", "--find-copies"]),
    gitText(repoRoot, ["diff", "--numstat", "-z", "--find-renames", "--find-copies"]),
  ]);
  const stagedStats = parseNumstatZ(stagedStatsOutput);
  const unstagedStats = parseNumstatZ(unstagedStatsOutput);
  const staged = [];
  const unstaged = [];
  let untrackedFilesInspected = 0;
  let untrackedBytesRemaining = UNTRACKED_STATS_BYTE_LIMIT;
  let untrackedStatsLimited = false;
  const untrackedDeadline = Date.now() + UNTRACKED_STATS_TIME_MS;
  for (const record of records) {
    if (record.untracked) {
      const budgetAvailable = untrackedFilesInspected < UNTRACKED_STATS_FILE_LIMIT
        && untrackedBytesRemaining > 0
        && Date.now() < untrackedDeadline;
      const counted = budgetAvailable
        ? await countUntracked(repoRoot, record.path, maxFileBytes, untrackedBytesRemaining, untrackedDeadline)
        : { additions: 0, binary: false, statsUnavailable: true, inspectedBytes: 0 };
      untrackedFilesInspected += budgetAvailable ? 1 : 0;
      untrackedBytesRemaining = Math.max(0, untrackedBytesRemaining - (counted.inspectedBytes || 0));
      untrackedStatsLimited ||= Boolean(counted.statsUnavailable);
      unstaged.push({
        ...record,
        status: "added",
        additions: counted.additions,
        deletions: 0,
        binary: counted.binary,
        oversized: counted.oversized,
        statsUnavailable: counted.statsUnavailable,
        symlink: counted.symlink,
        descriptor: { kind: "untracked" },
      });
      continue;
    }
    if (record.indexCode && ![".", " ", "?"].includes(record.indexCode)) {
      staged.push({
        ...record,
        ...comparisonModeMetadata(record.headMode, record.indexMode),
        status: statusName(record.indexCode),
        ...(stagedStats.get(record.path) || { additions: 0, deletions: 0, binary: false }),
        descriptor: { kind: "staged" },
      });
    }
    if (record.worktreeCode && ![".", " ", "?"].includes(record.worktreeCode)) {
      unstaged.push({
        ...record,
        ...comparisonModeMetadata(record.indexMode, record.worktreeMode),
        status: statusName(record.worktreeCode),
        ...(unstagedStats.get(record.path) || { additions: 0, deletions: 0, binary: false }),
        descriptor: { kind: "unstaged" },
      });
    }
  }
  return { staged, unstaged, untrackedStatsLimited };
}

async function trackingState(repoRoot) {
  try {
    const output = (await gitText(repoRoot, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])).trim();
    const [pull, push] = output.split(/\s+/).map(Number);
    return { hasUpstream: true, pull: pull || 0, push: push || 0 };
  } catch {
    return { hasUpstream: false, pull: 0, push: 0 };
  }
}

async function commitState(repoRoot, baseRef) {
  if (!baseRef || baseRef === "HEAD") return {
    commits: [],
    totalCommits: 0,
    commitPathIndex: new Map(),
    historyLimit: HISTORY_LIMIT,
    historyTruncated: false,
    historyPathsAvailable: true,
  };
  const range = `${baseRef}..HEAD`;
  const [log, countText] = await Promise.all([
    gitText(repoRoot, ["log", "--first-parent", `--max-count=${HISTORY_LIMIT}`, "-z", "--format=%H%x00%h%x00%s%x00%an%x00%ar", range]),
    gitText(repoRoot, ["rev-list", "--first-parent", "--count", range]),
  ]);
  const commits = parseCommitLogZ(log);
  const totalCommits = Number.parseInt(countText.trim(), 10) || 0;
  let commitPathIndex = new Map();
  let historyPathsAvailable = true;
  try {
    const pathLog = await gitText(repoRoot, [
      "log", "--first-parent", `--max-count=${HISTORY_LIMIT}`, "-z", "--format=%H",
      "--raw", "--no-abbrev", "--no-renames", range,
    ]);
    commitPathIndex = parseCommitPathsRawLogZ(pathLog);
  } catch {
    historyPathsAvailable = false;
  }
  return {
    commits,
    totalCommits,
    commitPathIndex,
    historyLimit: HISTORY_LIMIT,
    historyTruncated: totalCommits > commits.length,
    historyPathsAvailable,
  };
}

export async function getCommitFiles(repoRoot, commitHash, maxOutputBytes = 16 * 1024 * 1024) {
  const parentLine = (await gitText(repoRoot, ["rev-list", "--parents", "-n", "1", commitHash], { maxOutputBytes })).trim();
  const parentHash = parentLine.split(/\s+/)[1] || "";
  const comparison = parentHash ? ["diff", parentHash, commitHash] : ["show", "--root", "--format=", commitHash];
  const [names, stats, raw] = await Promise.all([
    gitText(repoRoot, [...comparison, "--name-status", "-z", "--find-renames", "--find-copies-harder"], { maxOutputBytes }),
    gitText(repoRoot, [...comparison, "--numstat", "-z", "--find-renames", "--find-copies-harder"], { maxOutputBytes }),
    gitText(repoRoot, [...comparison, "--raw", "-z", "--abbrev=40", "--find-renames", "--find-copies-harder"], { maxOutputBytes }),
  ]);
  return withDescriptor(
    mergeMetadata(mergeStats(parseNameStatusZ(names), parseNumstatZ(stats)), parseRawDiffZ(raw)),
    { kind: "commit", commitHash, parentHash, comparison: "first-parent" },
  );
}

export async function getRepositoryState(cwd, options = {}) {
  const repoRoot = await resolveRepository(cwd);
  if (!repoRoot) {
    return {
      cwd,
      repoRoot: "",
      repository: path.basename(cwd),
      branch: "—",
      error: "No Git repository in the focused Herdr pane",
      config: loadConfig("").config,
      configErrors: [],
    };
  }
  const { config, errors: configErrors } = loadConfig(repoRoot, options.env || process.env);
  const [branch, baseRef] = await Promise.all([resolveBranch(repoRoot), resolveBase(repoRoot, config.baseRef)]);
  const workingPromise = workingFiles(repoRoot, config.limits.maxFileBytes);
  const trackedPromise = gitText(repoRoot, ["ls-files", "-z", "--stage"]).then((output) => {
    const entries = parseLsFilesStageZ(output);
    return { paths: [...new Set(entries.map((entry) => entry.path))], entries };
  });
  const againstPromise = baseRef && baseRef !== "HEAD"
    ? changedFiles(repoRoot, [`${baseRef}...HEAD`], { kind: "against", baseRef })
    : Promise.resolve([]);
  const workspacePromise = workspaceState(repoRoot, baseRef);
  const [working, trackedData, againstBase, workspace, commitData, tracking] = await Promise.all([
    workingPromise,
    trackedPromise,
    againstPromise,
    workspacePromise,
    commitState(repoRoot, baseRef),
    trackingState(repoRoot),
  ]);
  const state = {
    cwd,
    repoRoot,
    repository: path.basename(repoRoot),
    branch,
    baseRef,
    baseLabel: baseRef || "no base",
    againstBase,
    ...workspace,
    staged: working.staged,
    unstaged: working.unstaged,
    untrackedStatsLimited: working.untrackedStatsLimited,
    tracked: trackedData.paths,
    tracking,
    ...commitData,
    config,
    configErrors,
    error: configErrors[0] || "",
  };
  const trackedMetadata = new Map(trackedData.entries.filter((entry) => entry.stage === 0).map((entry) => [entry.path, {
    mode: entry.mode,
    submodule: entry.mode === "160000",
    symlink: entry.mode === "120000",
    executable: entry.mode === "100755",
  }]));
  for (const list of [state.againstBase, state.workspaceChanges, state.staged, state.unstaged]) {
    for (const file of list) {
      const tracked = trackedMetadata.get(file.path);
      if (!tracked) continue;
      for (const [key, value] of Object.entries(tracked)) {
        if (!Object.hasOwn(file, key)) file[key] = value;
      }
    }
  }
  state.files = buildPathIndex({
    ...state,
    tracked: trackedData.entries
      .filter((entry) => entry.stage === 0)
      .map((entry) => ({ path: entry.path, ...trackedMetadata.get(entry.path) })),
  });
  return state;
}
