import fs from "node:fs/promises";
import path from "node:path";
import { runGit } from "./process.mjs";

async function canonical(candidate) {
  try { return await fs.realpath(candidate); } catch { return path.resolve(candidate); }
}

export function shouldInstallWatchers(environment = process.env) {
  return environment.GIT_RAIL_WATCH_MODE !== "poll-only";
}

export function shouldInstallRecoveryPoll(environment = process.env) {
  return environment.GIT_RAIL_WATCH_MODE !== "watch-only";
}

export async function resolveGitWatchRoots(repoRoot, { run = runGit } = {}) {
  if (!repoRoot) return [];
  const [gitdirResult, commonResult] = await Promise.all([
    run(repoRoot, ["rev-parse", "--absolute-git-dir"], { timeoutMs: 2_000, maxOutputBytes: 64 * 1024 }),
    run(repoRoot, ["rev-parse", "--git-common-dir"], { timeoutMs: 2_000, maxOutputBytes: 64 * 1024 }),
  ]);
  const gitdir = gitdirResult.stdout.trim();
  const commonRaw = commonResult.stdout.trim();
  const common = path.isAbsolute(commonRaw) ? commonRaw : path.resolve(repoRoot, commonRaw);
  return [...new Set(await Promise.all([gitdir, common].filter(Boolean).map(canonical)))];
}
