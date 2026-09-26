import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearInterval, setInterval } from "node:timers";
import { runGit } from "./process.mjs";

// A rail follows its tab's focused pane unless a target pins it to one of the
// Git worktrees Herdr has open for the same repository. The target lives in a
// file per rail tab so the rail's own picker and `siderail target` share it.

function safeToken(value) {
  return String(value || "").replace(/[^A-Za-z0-9._-]+/g, "_");
}

function targetDirectory(environment = process.env) {
  const cacheRoot = environment.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(cacheRoot, "siderail", "targets");
}

export function railTargetPath({ workspaceId, tabId, environment = process.env }) {
  return path.join(targetDirectory(environment), `${safeToken(workspaceId)}-${safeToken(tabId)}.json`);
}

export function readRailTarget(targetPath) {
  try {
    const target = JSON.parse(fs.readFileSync(targetPath, "utf8"));
    return typeof target?.checkoutPath === "string" && target.checkoutPath ? target : null;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function writeRailTarget(targetPath, { workspaceId, label, checkoutPath, branch }) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporary = `${targetPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ workspaceId, label, checkoutPath, branch: branch || undefined })}\n`, { mode: 0o600 });
  fs.renameSync(temporary, targetPath);
}

export function clearRailTarget(targetPath) {
  fs.rmSync(targetPath, { force: true });
}

export function cleanupRailTargets({ workspaceId, tabId = "", environment = process.env }) {
  const directory = targetDirectory(environment);
  const prefix = `${safeToken(workspaceId)}-${tabId ? `${safeToken(tabId)}.json` : ""}`;
  let entries;
  try { entries = fs.readdirSync(directory); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const name of entries) {
    if (tabId ? name === prefix : name.startsWith(prefix)) fs.rmSync(path.join(directory, name), { force: true });
  }
}

function targetContents(targetPath) {
  try { return fs.readFileSync(targetPath, "utf8"); } catch { return null; }
}

/**
 * Call `onChange` when one rail's target file changes. A directory watch gives
 * the fast path; events for the atomic write's temporary name count because
 * macOS can report the rename under that name alone. File events can also be
 * delayed or dropped, so a cheap poll of the file's contents backs it up.
 */
export function watchRailTarget(targetPath, onChange, { settleMs = 50, pollMs = 1_000 } = {}) {
  const directory = path.dirname(targetPath);
  const name = path.basename(targetPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let last = targetContents(targetPath);
  let settleTimer;
  const check = () => {
    const next = targetContents(targetPath);
    if (next === last) return;
    last = next;
    onChange();
  };
  let watcher;
  try {
    watcher = fs.watch(directory, (_event, changed) => {
      if (changed && !String(changed).startsWith(name)) return;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(check, settleMs);
      settleTimer.unref?.();
    });
    watcher.on("error", () => watcher.close());
    watcher.unref?.();
  } catch { watcher = null; }
  const pollTimer = setInterval(check, pollMs);
  pollTimer.unref?.();
  return {
    // The rail reads the file itself whenever it applies a target; this keeps
    // a change it has already applied from being reported, and a change made
    // before the next poll (such as a quick clear) from being missed.
    sync() { last = targetContents(targetPath); },
    close() {
      clearTimeout(settleTimer);
      clearInterval(pollTimer);
      watcher?.close();
    },
  };
}

function canonicalPath(value) {
  try { return fs.realpathSync.native(value); } catch { return path.resolve(value); }
}

/** Whether two paths name the same checkout, whatever their spelling. */
export function sameCheckout(left, right) {
  return Boolean(left && right) && canonicalPath(left) === canonicalPath(right);
}

/** The worktree workspaces Herdr has open for the repository of `workspaceId`. */
export function listSiblingWorktrees(snapshot, workspaceId) {
  const workspaces = Array.isArray(snapshot?.workspaces) ? snapshot.workspaces : [];
  const repoKey = workspaces.find((workspace) => workspace.workspace_id === workspaceId)?.worktree?.repo_key;
  if (!repoKey) return [];
  return workspaces
    .filter((workspace) => workspace.worktree?.repo_key === repoKey && workspace.worktree.checkout_path)
    .map((workspace) => ({
      workspaceId: workspace.workspace_id,
      label: workspace.label || path.basename(workspace.worktree.checkout_path),
      checkoutPath: canonicalPath(workspace.worktree.checkout_path),
      linked: Boolean(workspace.worktree.is_linked_worktree),
      number: Number(workspace.number) || 0,
    }))
    .sort((left, right) => Number(left.linked) - Number(right.linked) || left.number - right.number);
}

/** Add each worktree's checked-out branch; "" when Git cannot say. */
export async function withWorktreeBranches(worktrees, { run = runGit } = {}) {
  return Promise.all(worktrees.map(async (worktree) => {
    try {
      const { stdout } = await run(worktree.checkoutPath, ["branch", "--show-current"], { timeoutMs: 2_000 });
      return { ...worktree, branch: stdout.trim() || "detached HEAD" };
    } catch {
      return { ...worktree, branch: "" };
    }
  }));
}

/**
 * The checkout a folder belongs to: its canonical root and branch. `null`
 * when the folder is outside Git; `undefined` when Git could not say.
 */
export async function describeCheckout(cwd, { run = runGit } = {}) {
  try {
    const { stdout } = await run(cwd, ["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"], { timeoutMs: 2_000 });
    const [root = "", branch = ""] = stdout.split(/\r?\n/);
    return { root: canonicalPath(root), branch: branch === "HEAD" ? "detached HEAD" : branch };
  } catch (error) {
    return error?.kind === "exit" ? null : undefined;
  }
}

/** Match a worktree by label, branch, workspace id, or checkout path. */
export function resolveWorktree(worktrees, query) {
  const wanted = String(query || "").trim();
  if (!wanted) return null;
  const wantedPath = canonicalPath(wanted);
  return worktrees.find((worktree) => worktree.label === wanted)
    || worktrees.find((worktree) => worktree.branch === wanted)
    || worktrees.find((worktree) => worktree.workspaceId === wanted)
    || worktrees.find((worktree) => worktree.checkoutPath === wantedPath)
    || worktrees.find((worktree) => worktree.label.toLowerCase() === wanted.toLowerCase())
    || null;
}

/**
 * Point a host context at its pinned worktree. A target whose checkout no
 * longer exists is reported as stale and the context keeps following its pane.
 */
export function applyRailTarget(context, target, { isDirectory = defaultIsDirectory } = {}) {
  if (!context || !target) return { context, stale: false };
  if (!isDirectory(target.checkoutPath)) return { context, stale: true };
  return { context: { ...context, cwd: target.checkoutPath, hasContent: true }, stale: false };
}

function defaultIsDirectory(candidate) {
  try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
}
