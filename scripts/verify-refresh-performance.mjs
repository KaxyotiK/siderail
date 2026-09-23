#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Read-only acceptance of completed isolated witness artifacts. No live probes.
const [baselineRoot, candidateRoot, reconciliationRoot, packagedRoot] = process.argv.slice(2);
if (!packagedRoot) throw new Error("Usage: node scripts/verify-refresh-performance.mjs BASELINE CANDIDATE RECONCILIATION PACKAGED");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const summary = (root) => read(path.join(root, "summary.json"));
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const baseline = summary(baselineRoot);
const candidate = summary(candidateRoot);
const reconciliation = summary(reconciliationRoot);
const packaged = summary(packagedRoot);
const projectRoot = path.resolve(import.meta.dirname, "..");
const result = (root, id) => read(path.join(root, "runs", id, "result.json"));
const jsonLines = (file) => fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const proof = { cpuRatios: {}, edits: [], runsVerified: 0 };
function runtimeFiles(directory = "src") {
  return fs.readdirSync(path.join(projectRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    return entry.isDirectory() ? runtimeFiles(relative) : entry.isFile() && entry.name.endsWith(".mjs") ? [relative] : [];
  });
}
const currentRuntime = [...runtimeFiles(), "scripts/siderail.mjs", "scripts/git-state-coordinator.mjs", "scripts/node-launcher.sh"].sort();

assert.equal(baseline.mode, "baseline");
assert.equal(candidate.mode, "compare");
assert.equal(candidate.baselineReference.summarySha256, digest(path.join(baselineRoot, "summary.json")));
for (const document of [candidate, reconciliation, packaged]) {
  assert.equal(document.candidateStage, "B");
  assert.equal(document.cleanup.temporaryRootRemoved, true);
  assert.deepEqual(document.source.runtimeHashes?.map(([relative]) => relative).sort(), currentRuntime, "complete runtime inventory required");
  for (const [relative, hash] of document.source.runtimeHashes) {
    assert.equal(digest(path.join(projectRoot, relative)), hash, `runtime changed since measurement: ${relative}`);
  }
  assert.deepEqual(document.source.runtimeHashes, candidate.source.runtimeHashes);
}

function verifyRun(root, run) {
  const { totals } = run.measurement;
  assert.equal(run.startup.totals.providerBuilds, 1, `${run.runId}: shared startup`);
  assert.equal(run.startup.totals.snapshotPublishes, run.clientCount);
  assert.equal(run.lifecycle.watcher.engineCount, 1);
  assert.equal(totals.registeredComponentCount, 2);
  assert.equal(totals.cpuAvailable, true);
  assert.equal(run.hostAccounting.transport, "socket");
  assert.equal(run.hostAccounting.measurementSubprocesses, 0);
  assert.equal(run.teardown.clientsExited, true);
  assert.equal(run.teardown.hostExited, true);
  assert.equal(run.teardown.fixtureRemoved, true);
  assert.equal(run.teardown.coordinatorReleased.coordinatorPids.length, 1);
  assert.ok(run.teardown.coordinatorReleased.cleanupMs <= 30_000);
  assert.deepEqual(run.teardown.coordinatorReleased.namespaceArtifacts, []);
  const log = jsonLines(path.join(root, "runs", run.runId, "group.debug.jsonl"));
  const initial = log.filter((entry) => entry.operation === "rail-snapshot" && entry.timestamp <= run.startup.endedAt);
  assert.equal(new Set(initial.map((entry) => entry.pid)).size, run.clientCount);
  assert.equal(new Set(initial.map((entry) => entry.stateGeneration)).size, 1);
  const interval = log.filter((entry) => entry.timestamp >= run.measurement.startedAt && entry.timestamp <= run.measurement.endedAt);
  assert.ok(new Set(interval.filter((entry) => entry.operation === "rail-render").map((entry) => entry.pid)).size <= 1,
    "hidden rails must not redraw");
  proof.runsVerified += 1;
  return interval;
}

for (const clients of [1, 8]) {
  const quiet = candidate.groups[`quiet/clients-${clients}`];
  const original = baseline.groups[`quiet/clients-${clients}`];
  assert.equal(quiet.runs.length, 3);
  assert.equal(original.runs.length, 3);
  const ratio = quiet.totalCpuSecondsMedian / original.totalCpuSecondsMedian;
  assert.ok(ratio <= 0.25, `${clients} clients CPU ratio ${ratio} exceeds 0.25`);
  proof.cpuRatios[clients] = ratio;
  for (const item of quiet.runs) {
    const run = result(candidateRoot, item.runId);
    assert.ok(run.measurement.wallSeconds >= 60);
    assert.equal(run.measurement.totals.gitLaunches, 0);
    assert.equal(run.measurement.totals.providerBuilds, 0);
    assert.equal(run.measurement.totals.snapshotPublishes, 0);
    const originalRun = result(baselineRoot, original.runs[0].runId);
    assert.deepEqual(run.platform, originalRun.platform, "matched runtime and hardware required");
    assert.equal(run.resourceAccounting.method, originalRun.resourceAccounting.method);
  }
}
assert.equal(Object.values(candidate.groups).flatMap((group) => group.runs).length, 30);
for (const group of Object.values(candidate.groups)) {
  assert.equal(group.runs.length, 3);
  for (const item of group.runs) {
    const run = result(candidateRoot, item.runId);
    const log = verifyRun(candidateRoot, run);
    const totals = run.measurement.totals;
    if (run.workload === "edit-burst") {
      assert.equal(totals.providerBuilds, 2);
      assert.equal(totals.providerSuccesses, 2);
      assert.equal(totals.gitLaunches, 34);
      assert.equal(totals.snapshotPublishes, 2 * run.clientCount);
      assert.equal(totals.renderCount, 2);
      for (const [name, window] of Object.entries(run.measurement.providerWindows)) {
        assert.equal(window.providerBuilds, 1);
        const entries = log.filter((entry) => entry.timestamp >= window.startedAt && entry.timestamp < window.endedAt);
        const deliveries = entries.filter((entry) => entry.operation === "rail-snapshot");
        assert.equal(new Set(deliveries.map((entry) => entry.pid)).size, run.clientCount);
        assert.equal(new Set(deliveries.map((entry) => entry.stateGeneration)).size, 1);
        const start = entries.find((entry) => entry.operation === "repository-provider" && entry.phase === "start");
        const finish = entries.find((entry) => entry.operation === "repository-provider" && entry.phase === "finish");
        const latencyMs = Date.parse(start.timestamp) - Date.parse(window.startedAt);
        const deliveredMs = Math.max(...deliveries.map((entry) => Date.parse(entry.timestamp))) - Date.parse(window.startedAt);
        if (name === "singleEdit") {
          assert.ok(latencyMs <= 500, `eligible edit start took ${latencyMs}ms`);
          assert.ok(deliveredMs <= 2_000, `eligible edit delivery took ${deliveredMs}ms`);
        }
        proof.edits.push({ runId: run.runId, window: name, latencyMs, deliveredMs, providerMs: finish.durationMs });
      }
    } else if (run.workload === "ignored") {
      assert.equal(totals.providerBuilds, 0);
      assert.equal(totals.gitLaunches, 2);
      assert.equal(run.lifecycle.watcher.classifierMetrics.classifierLaunches, 2);
    } else if (run.workload === "sibling-index") {
      assert.equal(totals.providerBuilds, 0);
      assert.equal(totals.gitLaunches, 0);
    } else if (run.workload === "recovery") {
      assert.equal(totals.providerBuilds, 1);
      assert.equal(totals.gitLaunches, 17);
    }
  }
}
const longGroup = reconciliation.groups["reconciliation/clients-8"];
assert.equal(longGroup.runs.length, 1);
const long = result(reconciliationRoot, longGroup.runs[0].runId);
const longLog = verifyRun(reconciliationRoot, long);
assert.ok(long.measurement.wallSeconds >= 360);
assert.equal(long.measurement.totals.providerBuilds, 1);
assert.equal(long.measurement.totals.gitLaunches, 22); // 17 provider + 3 dependency probes + 2 root-resolution probes.
assert.equal(long.measurement.totals.snapshotPublishes, 8);
const reconcileStart = longLog.filter((entry) => entry.operation === "repository-provider" && entry.phase === "start");
assert.equal(reconcileStart.length, 1);
assert.ok(reconcileStart[0].kinds.includes("reconcile"));
const packagedRun = result(packagedRoot, packaged.packaged.runId);
verifyRun(packagedRoot, packagedRun);
assert.equal(digest(path.join(packagedRoot, packaged.packaged.archive.path)), packaged.packaged.archive.sha256);
assert.match(packaged.packaged.verifier.stdout, /Verified .* archive runtime dependencies/);
process.stdout.write(`${JSON.stringify({ passed: true, ...proof }, null, 2)}\n`);
