import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRepositoryWatcher } from "../src/git-invalidation.mjs";
import { getRepositoryState } from "../src/git-provider.mjs";
import { runGit } from "../src/process.mjs";
import { createRefreshScheduler } from "../src/refresh-scheduler.mjs";
import { createRepositoryEngine } from "../src/repository-engine.mjs";
import { hermeticEnvironment } from "./helpers/environment.mjs";

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: "Git Rail fixture",
  GIT_AUTHOR_EMAIL: "fixture@siderail.invalid",
  GIT_COMMITTER_NAME: "Git Rail fixture",
  GIT_COMMITTER_EMAIL: "fixture@siderail.invalid",
};

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function eventually(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(25);
  }
  throw lastError || new Error(message);
}

function comparable(value) {
  if (value instanceof Map) return [...value.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, comparable(nested)]);
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, comparable(nested)]),
  );
  return value;
}

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-invalidation-integration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { environment } = hermeticEnvironment(t, {
    GIT_CONFIG_NOSYSTEM: "1",
  });
  environment.GIT_CONFIG_GLOBAL = path.join(root, "global.gitconfig");
  await fs.writeFile(environment.GIT_CONFIG_GLOBAL, "");
  const primary = path.join(root, "primary");
  const sibling = path.join(root, "sibling");
  await fs.mkdir(path.join(primary, "src"), { recursive: true });
  await fs.mkdir(path.join(primary, ".noise"));
  await runGit(primary, ["init", "--initial-branch=main"], { baseEnv: environment });
  await fs.writeFile(path.join(primary, ".gitignore"), ".noise/*\n!.noise/tracked.txt\n");
  await fs.writeFile(path.join(primary, "src", "tracked.txt"), "base\n");
  await fs.writeFile(path.join(primary, "conflict.txt"), "base\n");
  await fs.writeFile(path.join(primary, ".noise", "tracked.txt"), "tracked despite ignore\n");
  await runGit(primary, ["add", "--all"], { baseEnv: environment });
  await runGit(primary, ["commit", "-m", "base"], { baseEnv: { ...environment, ...COMMIT_ENV } });
  await runGit(primary, ["branch", "sibling"], { baseEnv: environment });
  await runGit(primary, ["worktree", "add", sibling, "sibling"], { baseEnv: environment });
  return { root, primary, sibling, environment };
}

async function createLiveEngine(fixture) {
  let builds = 0;
  const published = [];
  let watcher;
  const context = {
    cwd: fixture.primary,
    engineKey: `fixture:${fixture.primary}`,
    environment: fixture.environment,
    schedulerConfig: { pollIntervalMs: 10_000, reconcileIntervalMs: 300_000 },
  };
  const engine = createRepositoryEngine({
    context,
    readState: async ({ signal }) => {
      builds += 1;
      return getRepositoryState(fixture.primary, { env: fixture.environment, signal });
    },
    watchFactory: async (options) => {
      watcher = await createRepositoryWatcher({ ...options, retryMs: 50 });
      return watcher;
    },
    schedulerOptions: {
      burstDelayMs: 150,
      minimumIntervalMs: 0,
      random: () => 0.5,
    },
  });
  await engine.ready;
  engine.subscribe((delivery) => { if (delivery.snapshot) published.push(delivery); });
  await eventually(() => watcher, "repository watcher was not created");
  await delay(200);
  return { engine, watcher, published, get builds() { return builds; } };
}

async function assertNextOracle(live, fixture, label, mutate) {
  const previousGeneration = live.engine.latest().stateGeneration;
  const previousBuilds = live.builds;
  const previousWatcherMetrics = { ...live.watcher?.metrics };
  const previousClassifierMetrics = { ...live.watcher?.classifierMetrics };
  await mutate();
  try {
    await eventually(
      () => live.engine.latest().stateGeneration > previousGeneration,
      `${label} did not cause a provider build`,
    );
  } catch (error) {
    error.message += `; watcher=${JSON.stringify([previousWatcherMetrics, live.watcher?.metrics])} classifier=${JSON.stringify([previousClassifierMetrics, live.watcher?.classifierMetrics])}`;
    throw error;
  }
  const oracle = await getRepositoryState(fixture.primary, { env: fixture.environment });
  await delay(250);
  await eventually(() => {
    if (live.engine.latest().stateGeneration !== live.builds) return false;
    assert.deepEqual(comparable(live.engine.latest().snapshot), comparable(oracle), `${label} diverged from the full provider oracle`);
    return true;
  }, `${label} did not finish its provider read`);
  const buildCount = live.builds - previousBuilds;
  // This matrix intentionally removes the production two-second throttle.
  // A slow Git mutation can emit its index event after the first read starts;
  // that real invalidation requires one follow-up rather than being discarded.
  assert.ok(buildCount >= 1 && buildCount <= 2, `${label} must coalesce with at most one necessary follow-up; got ${buildCount}`);
  if (buildCount === 2) {
    const firstPublication = new Map();
    for (const item of live.published) {
      if (item.stateGeneration > previousGeneration && !firstPublication.has(item.stateGeneration)) {
        firstPublication.set(item.stateGeneration, item.inputGeneration);
      }
    }
    // Later status notifications for an existing snapshot carry current dirty
    // input, so only the initial publication identifies that read's coverage.
    const generations = [...firstPublication.values()];
    assert.equal(generations.length, 2);
    assert.ok(generations[1] > generations[0], `${label} follow-up must cover a newer invalidation`);
  }
}

test("real ignored noise and a sibling index do not rebuild the primary worktree", async (t) => {
  const fixture = await createFixture(t);
  const live = await createLiveEngine(fixture);
  t.after(() => live.engine.close());
  const initialBuilds = live.builds;
  const initialClassifiers = live.watcher.classifierMetrics.classifierLaunches;

  for (let index = 0; index < 12; index += 1) {
    await fs.writeFile(path.join(fixture.primary, ".noise", "generated.txt"), `${index}\n`);
  }
  await eventually(
    () => live.watcher.classifierMetrics.classifierLaunches > initialClassifiers,
    "ignored path was not classified",
  );
  await delay(300);
  assert.equal(live.builds, initialBuilds);
  assert.equal(live.watcher.classifierMetrics.classifierLaunches, initialClassifiers + 1);

  for (let index = 0; index < 12; index += 1) {
    await fs.writeFile(path.join(fixture.primary, ".noise", "generated.txt"), `cached ${index}\n`);
  }
  await delay(300);
  assert.equal(live.builds, initialBuilds);
  assert.equal(live.watcher.classifierMetrics.classifierLaunches, initialClassifiers + 1);

  await fs.appendFile(path.join(fixture.sibling, "src", "tracked.txt"), "sibling-only\n");
  await runGit(fixture.sibling, ["add", "src/tracked.txt"], { baseEnv: fixture.environment });
  await delay(500);
  assert.equal(live.builds, initialBuilds, "sibling index/object traffic rebuilt the primary worktree");

  await assertNextOracle(live, fixture, "tracked path matching an ignore pattern", () => (
    fs.appendFile(path.join(fixture.primary, ".noise", "tracked.txt"), "changed\n")
  ));
});

test("real worktree, index, ref, and configuration mutations match the full provider oracle", async (t) => {
  const fixture = await createFixture(t);
  const live = await createLiveEngine(fixture);
  t.after(() => live.engine.close());

  await assertNextOracle(live, fixture, "tracked edit", () => (
    fs.appendFile(path.join(fixture.primary, "src", "tracked.txt"), "edit\n")
  ));
  const replacement = path.join(fixture.root, "replacement.txt");
  await fs.writeFile(replacement, "atomic replacement\n");
  await assertNextOracle(live, fixture, "atomic tracked replacement", () => (
    fs.rename(replacement, path.join(fixture.primary, "src", "tracked.txt"))
  ));
  const unusual = "untracked-line\nbreak.txt";
  await assertNextOracle(live, fixture, "untracked create with unusual bytes", () => (
    fs.writeFile(path.join(fixture.primary, unusual), "untracked\n")
  ));
  const transient = path.join(fixture.primary, "transient-untracked.txt");
  await assertNextOracle(live, fixture, "untracked create", () => fs.writeFile(transient, "temporary\n"));
  await assertNextOracle(live, fixture, "untracked delete", () => fs.rm(transient));
  await assertNextOracle(live, fixture, "owning index replacement", () => (
    runGit(fixture.primary, ["add", "--all"], { baseEnv: fixture.environment })
  ));
  await assertNextOracle(live, fixture, "commit HEAD/index/ref burst", () => (
    runGit(fixture.primary, ["commit", "-m", "mutation"], { baseEnv: { ...fixture.environment, ...COMMIT_ENV } })
  ));
  await assertNextOracle(live, fixture, "shared ref update", () => (
    runGit(fixture.primary, ["update-ref", "refs/heads/external", "HEAD"], { baseEnv: fixture.environment })
  ));
  await assertNextOracle(live, fixture, "shared ref atomic replacement", () => (
    runGit(fixture.primary, ["update-ref", "refs/heads/external", "HEAD~1"], { baseEnv: fixture.environment })
  ));
  await assertNextOracle(live, fixture, "shared ref repeated atomic replacement", () => (
    runGit(fixture.primary, ["update-ref", "refs/heads/external", "HEAD"], { baseEnv: fixture.environment })
  ));
  await assertNextOracle(live, fixture, "tracked rename and index transition", () => (
    runGit(fixture.primary, ["mv", "src/tracked.txt", "src/renamed.txt"], { baseEnv: fixture.environment })
  ));
  await assertNextOracle(live, fixture, "tracked executable-bit change", () => (
    fs.chmod(path.join(fixture.primary, "src", "renamed.txt"), 0o755)
  ));
  await assertNextOracle(live, fixture, "assume-unchanged index transition", () => (
    runGit(fixture.primary, ["update-index", "--assume-unchanged", "src/renamed.txt"], { baseEnv: fixture.environment })
  ));
  await assertNextOracle(live, fixture, "detached checkout", () => (
    runGit(fixture.primary, ["checkout", "--detach"], { baseEnv: fixture.environment })
  ));
  await assertNextOracle(live, fixture, "packed refs", () => (
    runGit(fixture.primary, ["pack-refs", "--all"], { baseEnv: fixture.environment })
  ));
  await assertNextOracle(live, fixture, "repository Git config", () => (
    runGit(fixture.primary, ["config", "rail.fixture", "changed"], { baseEnv: fixture.environment })
  ));
  await assertNextOracle(live, fixture, "worktree-specific Git config", async () => {
    await runGit(fixture.primary, ["config", "extensions.worktreeConfig", "true"], { baseEnv: fixture.environment });
    await runGit(fixture.primary, ["config", "--worktree", "rail.worktree", "changed"], { baseEnv: fixture.environment });
  });
  await assertNextOracle(live, fixture, "ignore configuration", () => (
    fs.appendFile(path.join(fixture.primary, ".gitignore"), "generated/\n")
  ));
  const externalIgnore = path.join(fixture.environment.XDG_CONFIG_HOME, "git", "ignore");
  await assertNextOracle(live, fixture, "external ignore dependency creation", async () => {
    await fs.mkdir(path.dirname(externalIgnore), { recursive: true });
    await fs.writeFile(externalIgnore, "external-generated/\n");
  });
  await assertNextOracle(live, fixture, "external ignore dependency replacement", async () => {
    const replacementIgnore = path.join(fixture.root, "replacement-ignore");
    await fs.writeFile(replacementIgnore, "external-generated/\nsecond-pattern/\n");
    await fs.rename(replacementIgnore, externalIgnore);
  });
  const includedConfig = path.join(fixture.root, "included.gitconfig");
  await assertNextOracle(live, fixture, "global include origin creation", async () => {
    await fs.writeFile(includedConfig, "[rail]\n\tincluded = one\n");
    await fs.writeFile(fixture.environment.GIT_CONFIG_GLOBAL, `[include]\n\tpath = ${includedConfig}\n`);
  });
  await assertNextOracle(live, fixture, "discovered include origin replacement", async () => {
    const replacementConfig = path.join(fixture.root, "replacement-included.gitconfig");
    await fs.writeFile(replacementConfig, "[rail]\n\tincluded = two\n");
    await fs.rename(replacementConfig, includedConfig);
  });
});

test("real merge, rebase, cherry-pick, revert, bisect, and sibling-ref transitions stay on the oracle", async (t) => {
  const fixture = await createFixture(t);
  const live = await createLiveEngine(fixture);
  t.after(() => live.engine.close());

  await assertNextOracle(live, fixture, "sibling commit and shared branch ref", async () => {
    await fs.writeFile(path.join(fixture.sibling, "conflict.txt"), "sibling\n");
    await runGit(fixture.sibling, ["add", "conflict.txt"], { baseEnv: fixture.environment });
    await runGit(fixture.sibling, ["commit", "-m", "sibling conflict"], { baseEnv: { ...fixture.environment, ...COMMIT_ENV } });
  });
  await assertNextOracle(live, fixture, "main conflicting commit", async () => {
    await fs.writeFile(path.join(fixture.primary, "conflict.txt"), "main\n");
    await runGit(fixture.primary, ["add", "conflict.txt"], { baseEnv: fixture.environment });
    await runGit(fixture.primary, ["commit", "-m", "main conflict"], { baseEnv: { ...fixture.environment, ...COMMIT_ENV } });
  });
  await assertNextOracle(live, fixture, "merge conflict state", () => (
    runGit(fixture.primary, ["merge", "sibling"], { baseEnv: { ...fixture.environment, ...COMMIT_ENV }, allowExitCodes: [0, 1] })
  ));
  await assertNextOracle(live, fixture, "merge abort", () => (
    runGit(fixture.primary, ["merge", "--abort"], { baseEnv: fixture.environment })
  ));
  await assertNextOracle(live, fixture, "checkout rebase topic", () => (
    runGit(fixture.primary, ["checkout", "-B", "rebase-topic", "sibling"], { baseEnv: fixture.environment })
  ));
  await assertNextOracle(live, fixture, "rebase conflict state", () => (
    runGit(fixture.primary, ["rebase", "main"], { baseEnv: { ...fixture.environment, ...COMMIT_ENV }, allowExitCodes: [0, 1] })
  ));
  await assertNextOracle(live, fixture, "rebase abort", () => (
    runGit(fixture.primary, ["rebase", "--abort"], { baseEnv: fixture.environment })
  ));
  await assertNextOracle(live, fixture, "return to main", () => (
    runGit(fixture.primary, ["checkout", "main"], { baseEnv: fixture.environment })
  ));
  await assertNextOracle(live, fixture, "cherry-pick conflict and sequencer state", () => (
    runGit(fixture.primary, ["cherry-pick", "sibling"], { baseEnv: { ...fixture.environment, ...COMMIT_ENV }, allowExitCodes: [0, 1] })
  ));
  await assertNextOracle(live, fixture, "cherry-pick abort", () => (
    runGit(fixture.primary, ["cherry-pick", "--abort"], { baseEnv: fixture.environment })
  ));
  await assertNextOracle(live, fixture, "completed revert", () => (
    runGit(fixture.primary, ["revert", "--no-edit", "HEAD"], { baseEnv: { ...fixture.environment, ...COMMIT_ENV } })
  ));
  await assertNextOracle(live, fixture, "bisect operation state", async () => {
    await runGit(fixture.primary, ["bisect", "start"], { baseEnv: fixture.environment });
    await runGit(fixture.primary, ["bisect", "bad", "HEAD"], { baseEnv: fixture.environment });
    await runGit(fixture.primary, ["bisect", "good", "HEAD~1"], { baseEnv: fixture.environment });
  });
  await assertNextOracle(live, fixture, "bisect reset", () => (
    runGit(fixture.primary, ["bisect", "reset"], { baseEnv: fixture.environment })
  ));
});

test("quiet reads preserve index bytes and reconciliation repairs failed or replaced watch roots", async (t) => {
  const fixture = await createFixture(t);
  const indexPath = path.join(fixture.primary, ".git", "index");
  const beforeBytes = await fs.readFile(indexPath);
  const beforeStat = await fs.stat(indexPath, { bigint: true });
  await getRepositoryState(fixture.primary, { env: fixture.environment });
  await getRepositoryState(fixture.primary, { env: fixture.environment });
  const afterBytes = await fs.readFile(indexPath);
  const afterStat = await fs.stat(indexPath, { bigint: true });
  assert.equal(crypto.createHash("sha256").update(afterBytes).digest("hex"), crypto.createHash("sha256").update(beforeBytes).digest("hex"));
  assert.equal(afterStat.mtimeNs, beforeStat.mtimeNs);

  const watched = path.join(fixture.root, "replaceable-root");
  await fs.mkdir(watched);
  const created = [];
  const health = [];
  const invalidations = [];
  const watch = (target, options, listener) => {
    const emitter = new EventEmitter();
    const record = { target, options, listener, emitter, closed: 0 };
    emitter.close = () => { record.closed += 1; };
    created.push(record);
    return emitter;
  };
  const watcher = await createRepositoryWatcher({
    context: { cwd: watched, environment: fixture.environment },
    snapshot: { cwd: watched, repoRoot: "", tracked: [], error: "" },
    onInvalidation(event) { invalidations.push(event); },
    onHealth(event) { health.push(event); },
    watch,
    retryMs: 10,
  });
  const rootRecord = created.find(({ target }) => target === watched);
  assert.ok(rootRecord);
  rootRecord.emitter.emit("error", new Error("injected watcher failure"));
  await fs.writeFile(path.join(watched, "changed-during-outage.txt"), "missed\n");
  await eventually(() => watcher.metrics.retries >= 1 && health.at(-1)?.healthy, "watcher did not recover after an asynchronous failure");
  assert.deepEqual(invalidations, [{ reason: "watch-recovered" }]);

  const oldRoot = path.join(fixture.root, "old-replaceable-root");
  await fs.rename(watched, oldRoot);
  await fs.mkdir(watched);
  const installedBefore = watcher.metrics.installed;
  await watcher.reconcile({ cwd: watched, repoRoot: "", tracked: [], error: "" });
  assert.ok(watcher.metrics.identityChanges >= 1);
  assert.ok(watcher.metrics.installed > installedBefore);
  assert.ok(created.filter(({ target }) => target === watched).some(({ closed }) => closed > 0));
  await watcher.close();
  const installedAtClose = watcher.metrics.installed;
  await watcher.close();
  assert.equal(watcher.metrics.installed, installedAtClose, "watcher close must be idempotent");
});

test("an unborn repository becomes a committed repository through native invalidation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-unborn-integration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { environment } = hermeticEnvironment(t, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
  });
  await runGit(root, ["init", "--initial-branch=main"], { baseEnv: environment });
  const live = await createLiveEngine({ primary: root, environment });
  t.after(() => live.engine.close());
  assert.equal(live.engine.latest().snapshot.branch, "main");
  assert.equal(live.engine.latest().snapshot.baseRef, "");
  await assertNextOracle(live, { primary: root, environment }, "unborn first commit", async () => {
    await fs.writeFile(path.join(root, "first.txt"), "first\n");
    await runGit(root, ["add", "first.txt"], { baseEnv: environment });
    await runGit(root, ["commit", "-m", "first"], { baseEnv: { ...environment, ...COMMIT_ENV } });
  });
  assert.notEqual(live.engine.latest().snapshot.baseRef, "");
});

test("a missing-object provider error retains state and bounded fallback recovers it", async (t) => {
  const fixture = await createFixture(t);
  const configDirectory = path.join(fixture.environment.XDG_CONFIG_HOME, "siderail");
  await fs.mkdir(configDirectory, { recursive: true });
  await fs.writeFile(path.join(configDirectory, "config.json"), JSON.stringify({
    version: 1,
    refresh: { pollIntervalMs: 1_000, reconcileIntervalMs: 30_000 },
  }));
  const live = await createLiveEngine(fixture);
  t.after(() => live.engine.close());
  const previous = live.engine.latest().snapshot;
  const tree = (await runGit(fixture.primary, ["rev-parse", "HEAD^{tree}"], { baseEnv: fixture.environment })).stdout.trim();
  const objectPath = path.join(fixture.primary, ".git", "objects", tree.slice(0, 2), tree.slice(2));
  const objectBytes = await fs.readFile(objectPath);
  await fs.rm(objectPath);
  await assert.rejects(live.engine.refresh("missing-object-witness"));
  assert.equal(live.engine.latest().status, "error");
  assert.equal(live.engine.latest().snapshot, previous, "failed refresh must retain the prior snapshot object");
  const failedBuilds = live.builds;
  await fs.writeFile(objectPath, objectBytes);
  await eventually(() => live.builds > failedBuilds && live.engine.latest().status === "healthy", "fallback did not recover restored object", 4_000);
  const oracle = await getRepositoryState(fixture.primary, { env: fixture.environment });
  assert.deepEqual(comparable(live.engine.latest().snapshot), comparable(oracle));
});

test("reconciliation repairs a silently lost event and a replaced real watch root", async (t) => {
  const fixture = await createFixture(t);
  let scheduler;
  let watcher;
  let dropInvalidations = true;
  let dropped = 0;
  let builds = 0;
  const engine = createRepositoryEngine({
    context: {
      cwd: fixture.primary,
      engineKey: `replacement:${fixture.primary}`,
      environment: fixture.environment,
      schedulerConfig: { pollIntervalMs: 10_000, reconcileIntervalMs: 300_000 },
    },
    readState: async ({ signal }) => {
      builds += 1;
      return getRepositoryState(fixture.primary, { env: fixture.environment, signal });
    },
    watchFactory: async ({ onInvalidation, ...options }) => {
      watcher = await createRepositoryWatcher({
        ...options,
        onInvalidation(event) {
          if (dropInvalidations) dropped += 1;
          else onInvalidation(event);
        },
        retryMs: 50,
      });
      return watcher;
    },
    schedulerFactory(options) {
      scheduler = createRefreshScheduler(options);
      return scheduler;
    },
    schedulerOptions: { burstDelayMs: 125, minimumIntervalMs: 0, random: () => 0.5 },
  });
  t.after(() => engine.close());
  await engine.ready;

  const generationBeforeLost = engine.latest().stateGeneration;
  await fs.appendFile(path.join(fixture.primary, "src", "tracked.txt"), "lost event\n");
  await eventually(() => dropped > 0, "native watcher did not observe the intentionally dropped event");
  await delay(250);
  assert.equal(engine.latest().stateGeneration, generationBeforeLost);
  await scheduler.request({ kind: "reconcile", reason: "simulated-loss" });
  let oracle = await getRepositoryState(fixture.primary, { env: fixture.environment });
  assert.deepEqual(comparable(engine.latest().snapshot), comparable(oracle));

  const oldPrimary = path.join(fixture.root, "old-primary");
  await fs.rename(fixture.primary, oldPrimary);
  await fs.mkdir(fixture.primary);
  await runGit(fixture.primary, ["init", "--initial-branch=main"], { baseEnv: fixture.environment });
  await fs.writeFile(path.join(fixture.primary, "replacement.txt"), "replacement\n");
  await runGit(fixture.primary, ["add", "replacement.txt"], { baseEnv: fixture.environment });
  await runGit(fixture.primary, ["commit", "-m", "replacement root"], { baseEnv: { ...fixture.environment, ...COMMIT_ENV } });
  const installedBefore = watcher.metrics.installed;
  await scheduler.request({ kind: "reconcile", reason: "root-replaced" });
  assert.ok(watcher.metrics.identityChanges >= 1);
  assert.ok(watcher.metrics.installed > installedBefore);
  oracle = await getRepositoryState(fixture.primary, { env: fixture.environment });
  assert.deepEqual(comparable(engine.latest().snapshot), comparable(oracle));

  dropInvalidations = false;
  const generationBeforeEdit = engine.latest().stateGeneration;
  await fs.appendFile(path.join(fixture.primary, "replacement.txt"), "post-reinstall\n");
  await eventually(() => engine.latest().stateGeneration > generationBeforeEdit, "reinstalled native watcher missed a tracked edit");
  oracle = await getRepositoryState(fixture.primary, { env: fixture.environment });
  assert.deepEqual(comparable(engine.latest().snapshot), comparable(oracle));
  assert.ok(builds >= 4);

  // Git can relocate metadata without changing the worktree path. Reconcile
  // must resolve the new .git indirection, then observe index-only changes.
  dropInvalidations = true;
  const relocatedGitDir = path.join(fixture.root, "relocated-git");
  await runGit(fixture.primary, ["init", "--separate-git-dir", relocatedGitDir], { baseEnv: fixture.environment });
  await scheduler.request({ kind: "reconcile", reason: "git-directory-relocated" });
  oracle = await getRepositoryState(fixture.primary, { env: fixture.environment });
  assert.deepEqual(comparable(engine.latest().snapshot), comparable(oracle));
  await delay(250);
  dropInvalidations = false;
  const generationBeforeStage = engine.latest().stateGeneration;
  await runGit(fixture.primary, ["add", "replacement.txt"], { baseEnv: fixture.environment });
  await eventually(() => engine.latest().stateGeneration > generationBeforeStage, "relocated metadata watcher missed an index-only edit");
  oracle = await getRepositoryState(fixture.primary, { env: fixture.environment });
  assert.deepEqual(comparable(engine.latest().snapshot), comparable(oracle));
});

test("an eligible native event meets the production 125 ms / 2 second latency contract", async (t) => {
  const fixture = await createFixture(t);
  let builds = 0;
  let secondStartedAt = 0;
  const engine = createRepositoryEngine({
    context: { cwd: fixture.primary, engineKey: `latency:${fixture.primary}`, environment: fixture.environment },
    readState: async ({ signal }) => {
      builds += 1;
      if (builds === 2) secondStartedAt = Date.now();
      return getRepositoryState(fixture.primary, { env: fixture.environment, signal });
    },
    watchFactory: (options) => createRepositoryWatcher(options),
    schedulerOptions: { random: () => 0.5 },
  });
  t.after(() => engine.close());
  await engine.ready;
  await delay(2_100);
  const changedAt = Date.now();
  const generation = engine.latest().stateGeneration;
  await fs.appendFile(path.join(fixture.primary, "src", "tracked.txt"), "latency\n");
  await eventually(() => engine.latest().stateGeneration > generation, "eligible event did not publish", 2_500);
  const publishedAt = Date.now();
  assert.ok(secondStartedAt - changedAt <= 500, `provider started after ${secondStartedAt - changedAt} ms`);
  assert.ok(publishedAt - changedAt <= 2_000, `snapshot published after ${publishedAt - changedAt} ms`);
});
