import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import {
  mergeStats,
  mergeMetadata,
  parseLsFilesStageZ,
  parseNameStatusZ,
  parseNumstatZ,
  parsePorcelainV2Z,
  parseRawDiffZ,
  statusName,
} from "./git-parsers.mjs";
import { buildPathIndex } from "./model.mjs";
import { ProcessError, runGit } from "./process.mjs";

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

async function countUntracked(repoRoot, filePath, maxBytes) {
  try {
    const absolute = await fs.realpath(path.join(repoRoot, filePath));
    const root = await fs.realpath(repoRoot);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return { additions: 0, binary: false };
    const handle = await fs.open(absolute, "r");
    try {
      const stat = await handle.stat();
      if (stat.size > maxBytes) return { additions: 0, binary: false, oversized: true };
      const buffer = Buffer.alloc(stat.size);
      await handle.read(buffer, 0, stat.size, 0);
      const binary = buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0);
      return { additions: binary ? 0 : buffer.toString("utf8").split("\n").length, binary };
    } finally {
      await handle.close();
    }
  } catch {
    return { additions: 0, binary: false };
  }
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
  for (const record of records) {
    if (record.untracked) {
      const counted = await countUntracked(repoRoot, record.path, maxFileBytes);
      unstaged.push({
        ...record,
        status: "added",
        additions: counted.additions,
        deletions: 0,
        binary: counted.binary,
        oversized: counted.oversized,
        descriptor: { kind: "untracked" },
      });
      continue;
    }
    if (record.indexCode && ![".", " ", "?"].includes(record.indexCode)) {
      staged.push({
        ...record,
        status: statusName(record.indexCode),
        ...(stagedStats.get(record.path) || { additions: 0, deletions: 0, binary: false }),
        descriptor: { kind: "staged" },
      });
    }
    if (record.worktreeCode && ![".", " ", "?"].includes(record.worktreeCode)) {
      unstaged.push({
        ...record,
        status: statusName(record.worktreeCode),
        ...(unstagedStats.get(record.path) || { additions: 0, deletions: 0, binary: false }),
        descriptor: { kind: "unstaged" },
      });
    }
  }
  return { staged, unstaged };
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
  if (!baseRef || baseRef === "HEAD") return { commits: [], totalCommits: 0 };
  const range = `${baseRef}..HEAD`;
  const [log, countText] = await Promise.all([
    gitText(repoRoot, ["log", "-z", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar", range]),
    gitText(repoRoot, ["rev-list", "--count", range]),
  ]);
  const commits = log.split("\0").filter(Boolean).map((record) => {
    const [hash, shortHash, message, author, age] = record.replace(/^\n+/, "").split("\x1f");
    return { hash, shortHash, message, author, age };
  });
  return { commits, totalCommits: Number.parseInt(countText.trim(), 10) || 0 };
}

export async function getCommitFiles(repoRoot, commitHash, maxOutputBytes = 16 * 1024 * 1024) {
  const [names, stats, raw] = await Promise.all([
    gitText(repoRoot, ["show", "--format=", "--name-status", "-z", "--find-renames", "--find-copies-harder", commitHash], { maxOutputBytes }),
    gitText(repoRoot, ["show", "--format=", "--numstat", "-z", "--find-renames", "--find-copies-harder", commitHash], { maxOutputBytes }),
    gitText(repoRoot, ["show", "--format=", "--raw", "-z", "--abbrev=40", "--find-renames", "--find-copies-harder", commitHash], { maxOutputBytes }),
  ]);
  return withDescriptor(
    mergeMetadata(mergeStats(parseNameStatusZ(names), parseNumstatZ(stats)), parseRawDiffZ(raw)),
    { kind: "commit", commitHash },
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
  const [working, trackedData, againstBase, commitData, tracking] = await Promise.all([
    workingPromise,
    trackedPromise,
    againstPromise,
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
    staged: working.staged,
    unstaged: working.unstaged,
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
  for (const list of [state.againstBase, state.staged, state.unstaged]) {
    for (const file of list) Object.assign(file, trackedMetadata.get(file.path) || {});
  }
  state.files = buildPathIndex(state);
  return state;
}
