import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { debugLog } from "./debug-log.mjs";
import { resolveGitWatchRoots, shouldInstallWatchers } from "./git-watch.mjs";
import { runGit, withGitProcessContext } from "./process.mjs";

function relativeInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/") : null;
}

/** Classify metadata by dependency, never by a blanket *.lock exclusion. */
export function gitMetadataRelevant(relative, { own = true, healthy = true } = {}) {
  if (!healthy || !relative) return true;
  if (relative === "objects/info/alternates" || relative === "objects/info/http-alternates") return true;
  if (relative === "objects" || relative.startsWith("objects/")) return false;
  if (!own && relative.startsWith("worktrees/")) {
    const child = relative.split("/").slice(2).join("/");
    // Only known private sibling state is irrelevant. Unknown new metadata is
    // deliberately conservative, including linkage/layout changes.
    return !/^(?:index(?:\.lock)?|HEAD(?:\.lock)?|ORIG_HEAD|COMMIT_EDITMSG|logs\/HEAD|sharedindex\.[^/]+|(?:rebase-merge|rebase-apply|sequencer)(?:\/.*)?|(?:MERGE|CHERRY_PICK|REVERT|BISECT)_[^/]+)$/.test(child);
  }
  return true;
}

function trackedPaths(snapshot) {
  return new Set((snapshot?.tracked || []).map((entry) => typeof entry === "string" ? entry : entry.path));
}

function parentPaths(paths) {
  const parents = new Set();
  for (const entry of paths) {
    let parent = path.posix.dirname(entry);
    while (parent !== ".") { parents.add(parent); parent = path.posix.dirname(parent); }
  }
  return parents;
}

// Keep the default above the performance witness's distinct ignored-path
// working set (currently directory + file), preserving its two classifier
// launches. Tiny limits are injected only by classifier unit tests, not witnesses.
const DEFAULT_IGNORE_CACHE_LIMIT = 4_096;

/** One exact, NUL-safe ignore query per burst; no per-event Git subprocess. */
export function createGitInvalidationClassifier({
  repoRoot, gitDir = "", commonGitDir = gitDir, snapshot, run = runGit,
  onInvalidation, onConfigChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, delayMs = 125,
  ignoreCacheLimit = DEFAULT_IGNORE_CACHE_LIMIT,
}) {
  if (!Number.isInteger(ignoreCacheLimit) || ignoreCacheLimit < 1) {
    throw new TypeError("ignoreCacheLimit must be a positive integer");
  }
  let tracked = trackedPaths(snapshot);
  let trackedParents = parentPaths(tracked);
  let healthy = !snapshot?.error;
  let closed = false;
  let generation = 0;
  let timer;
  let running = false;
  const pending = new Set();
  const ignored = new Map();
  const metrics = {
    events: 0, classifierLaunches: 0, ignoredEvents: 0, invalidations: 0,
    get ignoreCacheEntries() { return ignored.size; },
  };
  function rememberIgnored(entry, value) {
    ignored.delete(entry);
    ignored.set(entry, value);
    if (ignored.size > ignoreCacheLimit) ignored.delete(ignored.keys().next().value);
  }
  function invalidate(reason) {
    if (closed) return;
    metrics.invalidations += 1;
    debugLog("watch-invalidation", { reason });
    onInvalidation({ reason });
  }
  function clearIgnore() { generation += 1; ignored.clear(); }
  function schedule() {
    if (closed || timer || running || !pending.size) return;
    timer = setTimer(() => { timer = undefined; flush().catch(() => invalidate("classification-failed")); }, delayMs);
    timer.unref?.();
  }
  async function flush() {
    if (closed || running || !pending.size) return;
    running = true;
    const paths = [...pending]; pending.clear();
    const capturedGeneration = generation;
    try {
      metrics.classifierLaunches += 1;
      const result = await run(repoRoot, ["check-ignore", "--stdin", "-z"], {
        stdinInput: `${paths.join("\0")}\0`, allowExitCodes: [0, 1], stdoutEncoding: "utf8-strict",
      });
      if (closed) return;
      if (capturedGeneration !== generation) { invalidate("classification-generation-changed"); return; }
      const matches = new Set(result.stdout.split("\0").filter(Boolean));
      let relevant = false;
      for (const entry of paths) {
        rememberIgnored(entry, matches.has(entry));
        if (matches.has(entry)) metrics.ignoredEvents += 1;
        else relevant = true;
      }
      if (relevant) invalidate("worktree");
    } catch { invalidate("classification-failed"); }
    finally { running = false; schedule(); }
  }
  function event(target, filename) {
    if (closed) return;
    metrics.events += 1;
    if (filename === null || filename === undefined || String(filename) === "" || String(filename).includes("\ufffd")) {
      clearIgnore(); invalidate("unknown-filename"); return;
    }
    const absolute = path.resolve(target, String(filename));
    const own = gitDir ? relativeInside(gitDir, absolute) : null;
    const common = commonGitDir ? relativeInside(commonGitDir, absolute) : null;
    if (own !== null || common !== null) {
      const name = own !== null ? own : common;
      const ownMetadata = own !== null && !(gitDir === commonGitDir && name.startsWith("worktrees/"));
      if (!gitMetadataRelevant(name, { own: ownMetadata, healthy })) { metrics.ignoredEvents += 1; return; }
      clearIgnore();
      if (/^(?:HEAD|config(?:\.worktree)?)(?:\.lock)?$/.test(name)) onConfigChange();
      invalidate("git-metadata"); return;
    }
    const entry = relativeInside(repoRoot, absolute);
    if (entry === null || !entry || /(?:^|\/)(?:\.git|\.gitignore|\.gitattributes|\.gitmodules)(?:\/|$)/.test(entry)) {
      clearIgnore(); onConfigChange(); invalidate("configuration-or-root"); return;
    }
    // Directory renames and submodule descendants can affect tracked paths too.
    let ancestor = entry;
    while (ancestor !== "." && !tracked.has(ancestor)) ancestor = path.posix.dirname(ancestor);
    if (trackedParents.has(entry) || ancestor !== ".") {
      invalidate("tracked-worktree"); return;
    }
    if (!healthy || !gitDir) { invalidate("uncertain-worktree"); return; }
    if (ignored.has(entry)) {
      const value = ignored.get(entry);
      rememberIgnored(entry, value);
      if (value) metrics.ignoredEvents += 1;
      else invalidate("worktree");
      return;
    }
    pending.add(entry); schedule();
  }
  return {
    event, metrics, clearIgnore,
    setRoots(next) { repoRoot = next.repoRoot; gitDir = next.gitDir; commonGitDir = next.commonGitDir; clearIgnore(); },
    updateSnapshot(next) {
      const nextTracked = trackedPaths(next);
      if (nextTracked.size !== tracked.size || [...nextTracked].some((entry) => !tracked.has(entry))) clearIgnore();
      tracked = nextTracked; trackedParents = parentPaths(tracked); healthy = !next?.error;
    },
    setHealthy(value) { healthy = value; },
    close() { closed = true; clearTimer(timer); timer = undefined; pending.clear(); ignored.clear(); },
  };
}

export async function watchedRootIdentity(target) {
  try {
    const realpath = await fsp.realpath(target);
    const stat = await fsp.stat(realpath, { bigint: true });
    return { realpath, dev: String(stat.dev), ino: String(stat.ino) };
  } catch { return null; }
}

async function existingParent(target) {
  let parent = path.dirname(target);
  while (!await watchedRootIdentity(parent)) {
    const next = path.dirname(parent);
    if (next === parent) return parent;
    parent = next;
  }
  return parent;
}

/** Engine-owned native watchers. Reconciliation repairs identity changes. */
export async function createRepositoryWatcher({
  context, snapshot, onInvalidation, onHealth, watch = fs.watch,
  setTimer = setTimeout, clearTimer = clearTimeout, retryMs = 1_000,
}) {
  const environment = context.environment || process.env;
  let root = snapshot.repoRoot || snapshot.cwd || context.cwd;
  const run = (cwd, args, options) => withGitProcessContext({ environment, executable: context.gitExecutable }, () => runGit(cwd, args, options));
  let gitDir = "";
  let commonGitDir = "";
  let closed = false;
  let retryTimer;
  let retryDelay = retryMs;
  let installing;
  let configDirty = true;
  let refreshAfterRecovery = false;
  let dependencies = new Set();
  const watchers = new Map();
  const rootIdentities = new Map();
  const metrics = { installed: 0, closed: 0, retries: 0, identityChanges: 0, configQueries: 0 };
  const notifyHealth = (healthy, error) => { if (!closed) onHealth({ healthy, error }); };
  if (snapshot.repoRoot) {
    const roots = await resolveGitWatchRoots(snapshot.repoRoot, { run });
    [gitDir, commonGitDir = gitDir] = roots;
  }
  const classifier = createGitInvalidationClassifier({
    repoRoot: root, gitDir, commonGitDir, snapshot, run, onInvalidation, setTimer, clearTimer,
    onConfigChange() { configDirty = true; },
  });
  function release(key) {
    const installed = watchers.get(key);
    if (!installed) return;
    watchers.delete(key); installed.watcher.close(); metrics.closed += 1;
  }
  function retry(error) {
    refreshAfterRecovery = true;
    classifier.setHealthy(false); notifyHealth(false, error);
    if (closed || retryTimer || !shouldInstallWatchers(environment)) return;
    retryTimer = setTimer(() => {
      retryTimer = undefined; metrics.retries += 1;
      install().catch(retry);
    }, retryDelay);
    retryTimer.unref?.(); retryDelay = Math.min(10_000, retryDelay * 2);
  }
  async function discoverDependencies() {
    const home = environment.HOME || process.cwd();
    const xdg = environment.XDG_CONFIG_HOME || path.join(home, ".config");
    const files = new Set([
      path.join(xdg, "siderail", "config.json"), path.join(home, ".gitconfig"),
      path.join(xdg, "git", "config"), path.join(xdg, "git", "ignore"), path.join(xdg, "git", "attributes"),
    ]);
    for (const variable of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_INDEX_FILE", "GIT_CONFIG"]) {
      if (environment[variable]) files.add(path.resolve(context.cwd, environment[variable]));
    }
    if (gitDir) {
      metrics.configQueries += 1;
      const origins = await run(root, ["config", "--null", "--list", "--show-origin"]);
      const fields = origins.stdout.split("\0");
      for (let index = 0; index + 1 < fields.length; index += 2) {
        if (fields[index].startsWith("file:")) files.add(path.resolve(root, fields[index].slice(5)));
      }
      for (const key of ["core.excludesFile", "core.attributesFile"]) {
        metrics.configQueries += 1;
        const value = await run(root, ["config", "--path", "--null", "--get", key], { allowExitCodes: [0, 1] });
        const filename = value.stdout.replace(/\0$/, "");
        if (filename) files.add(path.resolve(root, filename));
      }
    }
    // Watching the discovery parents catches creation and atomic replacement.
    dependencies = files; configDirty = false;
  }
  async function installNow() {
    if (closed || !shouldInstallWatchers(environment)) return;
    if (configDirty) await discoverDependencies();
    // Keep a dedicated Git metadata watch even when .git is nested below the
    // worktree. Linux recursive inotify can miss an atomically replaced index
    // through the ancestor watch. Git roots may still deduplicate each other:
    // a recursive common-dir watch covers its linked-worktree gitdirs.
    const metadataRoots = [gitDir, commonGitDir].filter(Boolean)
      .filter((entry, index, entries) => entries.indexOf(entry) === index)
      .filter((entry, _index, entries) => !entries.some((other) => other !== entry && relativeInside(other, entry) !== null));
    const recursiveRoots = [...new Set([root, ...metadataRoots].filter(Boolean))];
    const requestedRoots = new Set([root, gitDir, commonGitDir].filter(Boolean));
    for (const requested of rootIdentities.keys()) if (!requestedRoots.has(requested)) rootIdentities.delete(requested);
    for (const requested of requestedRoots) {
      const identity = await watchedRootIdentity(requested);
      if (rootIdentities.has(requested) && JSON.stringify(rootIdentities.get(requested)) !== JSON.stringify(identity)) {
        metrics.identityChanges += 1; classifier.clearIgnore();
        for (const [key, installed] of watchers) {
          if (relativeInside(installed.target, requested) !== null) release(key);
        }
      }
      rootIdentities.set(requested, identity);
    }
    const desired = new Map(recursiveRoots.map((target) => [`recursive:${target}`, { target, recursive: true }]));
    // Atomic index/HEAD replacement must be observed through a directory
    // watch. Node's Linux recursive watcher can retain a now-stale file inode
    // after replacement, so this nonrecursive watch is intentionally kept in
    // addition to the recursive metadata watch.
    for (const target of new Set([gitDir, commonGitDir].filter(Boolean))) {
      desired.set(`directory:${target}`, { target, recursive: false });
    }
    for (const dependency of dependencies) {
      if (recursiveRoots.some((entry) => relativeInside(entry, dependency) !== null)) continue;
      const target = await existingParent(dependency);
      desired.set(`directory:${target}`, { target, recursive: false });
    }
    if (closed) return;
    let failure;
    for (const key of watchers.keys()) if (!desired.has(key)) release(key);
    for (const [key, { target, recursive }] of desired) {
      const identity = await watchedRootIdentity(target);
      if (closed) return;
      const previous = watchers.get(key);
      if (previous && JSON.stringify(previous.identity) === JSON.stringify(identity)) continue;
      if (previous) { metrics.identityChanges += 1; release(key); classifier.clearIgnore(); }
      if (!identity) { failure = new Error(`Watch root unavailable: ${target}`); continue; }
      try {
        const watcher = watch(target, { recursive, encoding: "buffer" }, (_event, filename) => {
          if (closed) return;
          const absolute = filename == null ? null : path.resolve(target, String(filename));
          if (absolute && target === root && metadataRoots.some((metadataRoot) => (
            metadataRoot !== root && relativeInside(metadataRoot, absolute) !== null
          ))) return;
          if (absolute && dependencies.has(absolute)) {
            configDirty = true; classifier.event(target, null); return;
          }
          const metadataDirectory = !recursive && metadataRoots.includes(target);
          if (!recursive && !metadataDirectory && filename != null) {
            if (![...dependencies].some((file) => file === absolute || relativeInside(absolute, file) !== null)) return;
            configDirty = true;
          }
          classifier.event(target, filename);
        });
        watcher.on("error", (error) => { release(key); retry(error); });
        watchers.set(key, { watcher, identity, recursive, target }); metrics.installed += 1;
      } catch (error) { failure = error; }
    }
    if (failure) { retry(failure); return; }
    clearTimer(retryTimer); retryTimer = undefined; retryDelay = retryMs;
    classifier.setHealthy(!snapshot?.error);
    // A watcher outage can hide relevant changes. Queue a full read before
    // reporting healthy so the scheduler cannot clear degraded fallback
    // coverage and leave the missed state stale until the long reconciliation.
    if (refreshAfterRecovery) {
      refreshAfterRecovery = false;
      onInvalidation({ reason: "watch-recovered" });
    }
    notifyHealth(true);
  }
  function install() {
    if (!installing) installing = installNow().finally(() => { installing = undefined; });
    return installing;
  }
  if (shouldInstallWatchers(environment)) {
    try { await install(); } catch (error) { retry(error); }
  } else notifyHealth(false, new Error("Filesystem watchers disabled by poll-only mode"));
  return {
    metrics, classifierMetrics: classifier.metrics,
    async updateSnapshot(next) {
      if (snapshot.repoRoot !== next.repoRoot || snapshot.cwd !== next.cwd) {
        root = next.repoRoot || next.cwd || context.cwd;
        const roots = next.repoRoot ? await resolveGitWatchRoots(next.repoRoot, { run }) : [];
        [gitDir = "", commonGitDir = gitDir] = roots;
        classifier.setRoots({ repoRoot: root, gitDir, commonGitDir }); configDirty = true;
      }
      snapshot = next; classifier.updateSnapshot(next);
      if (configDirty) await install();
    },
    async reconcile(next) {
      snapshot = next || snapshot;
      classifier.clearIgnore(); configDirty = true;
      if (shouldInstallWatchers(environment)) {
        await installing;
        const roots = snapshot.repoRoot ? await resolveGitWatchRoots(snapshot.repoRoot, { run }) : [];
        root = snapshot.repoRoot || snapshot.cwd || context.cwd;
        [gitDir = "", commonGitDir = gitDir] = roots;
        classifier.setRoots({ repoRoot: root, gitDir, commonGitDir });
      }
      await install();
    },
    async close() {
      if (closed) return;
      closed = true; clearTimer(retryTimer); classifier.close();
      await installing;
      for (const key of watchers.keys()) release(key);
    },
  };
}
