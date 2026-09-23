#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "..");
const RESOURCE_SOURCE = path.join(HERE, "lib", "refresh-resource-sample.c");
const FAKE_HERDR = path.join(HERE, "lib", "refresh-fake-herdr.mjs");
const DEFAULT_BASELINE_REVISION = "6603d33c61b6646b4a54806b028961c8fd1379e2";
const FIXED_GIT_ENV = {
  GIT_AUTHOR_NAME: "Git Rail performance fixture",
  GIT_AUTHOR_EMAIL: "fixture@siderail.invalid",
  GIT_COMMITTER_NAME: "Git Rail performance fixture",
  GIT_COMMITTER_EMAIL: "fixture@siderail.invalid",
  GIT_AUTHOR_DATE: "2024-01-02T03:04:05Z",
  GIT_COMMITTER_DATE: "2024-01-02T03:04:05Z",
};

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) fail(`unexpected argument: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${name}`);
    values.set(name.slice(2), value);
    index += 1;
  }
  const mode = values.get("mode") || "";
  if (!new Set(["baseline", "candidate", "compare", "packaged-smoke"]).has(mode)) {
    fail("--mode must be baseline, candidate, compare, or packaged-smoke");
  }
  const positiveInteger = (name, fallback) => {
    const text = values.get(name);
    if (text === undefined) return fallback;
    if (!/^\d+$/.test(text) || Number(text) <= 0) fail(`--${name} must be a positive integer`);
    return Number(text);
  };
  const list = (name, fallback) => (values.get(name) || fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const clients = list("clients", "1").map((value) => {
    if (!/^\d+$/.test(value) || Number(value) <= 0 || Number(value) > 64) {
      fail("--clients must be a comma-separated list of integers from 1 to 64");
    }
    return Number(value);
  });
  const workloads = list("workloads", "quiet");
  const supportedWorkloads = new Set(["quiet", "edit-burst", "ignored", "sibling-index", "recovery", "reconciliation"]);
  for (const workload of workloads) if (!supportedWorkloads.has(workload)) {
    fail(`unsupported workload: ${workload}`);
  }
  const output = values.get("out");
  if (!output) fail("--out is required");
  const baselineRevision = values.get("baseline-revision") || (mode === "baseline" ? DEFAULT_BASELINE_REVISION : "");
  if (mode === "baseline" && !/^[0-9a-f]{40}$/i.test(baselineRevision)) {
    fail("--baseline-revision must be a full 40-character object id");
  }
  if (mode === "compare" && !values.get("baseline")) fail("--baseline is required in compare mode");
  return {
    mode,
    baselineRevision,
    baseline: values.get("baseline") ? path.resolve(values.get("baseline")) : "",
    candidateStage: values.get("candidate-stage") || "",
    clients: [...new Set(clients)],
    quietMs: positiveInteger("quiet-ms", 60_000),
    repeats: positiveInteger("repeats", 3),
    workloads: [...new Set(workloads)],
    output: path.resolve(output),
    startupTimeoutMs: positiveInteger("startup-timeout-ms", 30_000),
    settleMs: positiveInteger("settle-ms", 600),
  };
}

function command(command, args, { cwd = REPOSITORY_ROOT, env = {}, maxBytes = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const capture = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) child.kill("SIGKILL");
      else target.push(chunk);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      const result = {
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (exitCode === 0 && bytes <= maxBytes) resolve(result);
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal || exitCode}): ${result.stderr.trim()}`));
    });
  });
}

async function sha256File(target) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function writeJson(target, value) {
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fsp.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function prepareOutput(output) {
  await fsp.mkdir(output, { recursive: true, mode: 0o700 });
  const entries = await fsp.readdir(output);
  if (entries.length) fail(`output directory must be empty: ${output}`);
}

async function prepareBaselineSource(tempRoot, revision) {
  const resolved = (await command("git", ["rev-parse", "--verify", `${revision}^{commit}`])).stdout.trim();
  if (resolved !== revision.toLowerCase()) fail(`baseline revision resolved to unexpected commit: ${resolved}`);
  const sourceTree = (await command("git", ["rev-parse", `${revision}^{tree}`])).stdout.trim();
  const archive = path.join(tempRoot, "baseline.tar");
  await command("git", ["archive", "--format=tar", `--output=${archive}`, revision]);
  const archiveSha256 = await sha256File(archive);
  const sourceRoot = path.join(tempRoot, "baseline-source");
  await fsp.mkdir(sourceRoot, { recursive: true, mode: 0o700 });
  await command("tar", ["-xf", archive, "-C", sourceRoot]);
  return { kind: "archived-baseline", revision, sourceTree, archiveSha256, sourceRoot };
}

async function prepareCandidateSource(tempRoot) {
  const revision = (await command("git", ["rev-parse", "HEAD"])).stdout.trim();
  const sourceTree = (await command("git", ["rev-parse", "HEAD^{tree}"])).stdout.trim();
  const diff = (await command("git", ["diff", "--binary", "HEAD"])).stdout;
  const untracked = (await command("git", ["ls-files", "--others", "--exclude-standard"])).stdout
    .split("\n").filter(Boolean).sort();
  const untrackedHashes = [];
  for (const relative of untracked) {
    const absolute = path.join(REPOSITORY_ROOT, relative);
    const stat = await fsp.stat(absolute).catch(() => null);
    if (stat?.isFile()) untrackedHashes.push([relative, await sha256File(absolute)]);
  }
  const sourceRoot = path.join(tempRoot, "candidate-source");
  await fsp.cp(REPOSITORY_ROOT, sourceRoot, {
    recursive: true,
    filter(candidate) {
      const relative = path.relative(REPOSITORY_ROOT, candidate);
      const first = relative.split(path.sep)[0];
      return !new Set([".git", "node_modules", "test-results"]).has(first);
    },
  });
  const snapshotFiles = [];
  async function inventory(directory) {
    for (const entry of (await fsp.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(sourceRoot, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) await inventory(absolute);
      else if (entry.isSymbolicLink()) snapshotFiles.push([relative, "symlink", await fsp.readlink(absolute)]);
      else if (entry.isFile()) {
        const stat = await fsp.stat(absolute);
        snapshotFiles.push([relative, stat.mode & 0o777, await sha256File(absolute)]);
      }
    }
  }
  await inventory(sourceRoot);
  return {
    kind: "candidate-worktree",
    revision,
    sourceTree,
    patchSha256: sha256(diff),
    untrackedHashes,
    snapshotSha256: sha256(JSON.stringify(snapshotFiles)),
    snapshotFileCount: snapshotFiles.length,
    runtimeHashes: snapshotFiles.filter(([relative]) => relative.startsWith("src/") && relative.endsWith(".mjs")
      || ["scripts/siderail.mjs", "scripts/git-state-coordinator.mjs", "scripts/node-launcher.sh"].includes(relative))
      .map(([relative, _mode, hash]) => [relative, hash]),
    sourceRoot,
  };
}

async function prepareFixture(root) {
  const primary = path.join(root, "repository");
  const sibling = path.join(root, "sibling");
  await fsp.mkdir(primary, { recursive: true, mode: 0o700 });
  await command("git", ["init", "-b", "main"], { cwd: primary });
  await fsp.writeFile(path.join(primary, ".gitignore"), ".noise/\n", "utf8");
  await fsp.writeFile(path.join(primary, "README.md"), "fixture\n", "utf8");
  await fsp.mkdir(path.join(primary, "src"));
  await fsp.writeFile(path.join(primary, "src", "tracked.txt"), "one\n", "utf8");
  await command("git", ["add", "."], { cwd: primary, env: FIXED_GIT_ENV });
  await command("git", ["commit", "-m", "initial"], { cwd: primary, env: FIXED_GIT_ENV });
  await fsp.writeFile(path.join(primary, "src", "tracked.txt"), "one\ntwo\n", "utf8");
  await command("git", ["add", "src/tracked.txt"], { cwd: primary, env: FIXED_GIT_ENV });
  await command("git", ["commit", "-m", "second"], { cwd: primary, env: {
    ...FIXED_GIT_ENV,
    GIT_AUTHOR_DATE: "2024-01-02T03:05:05Z",
    GIT_COMMITTER_DATE: "2024-01-02T03:05:05Z",
  } });
  await command("git", ["branch", "sibling"], { cwd: primary });
  await command("git", ["worktree", "add", sibling, "sibling"], { cwd: primary });
  await fsp.appendFile(path.join(primary, "src", "tracked.txt"), "dirty primary\n", "utf8");
  await fsp.writeFile(path.join(primary, "untracked.txt"), "untracked\n", "utf8");
  const head = (await command("git", ["rev-parse", "HEAD"], { cwd: primary })).stdout.trim();
  return { primary, sibling, head };
}

async function compileResourceSampler(tempRoot) {
  if (process.platform !== "darwin") return { executable: "", method: process.platform === "linux" ? "linux-proc-stat" : "unavailable" };
  const executable = path.join(tempRoot, "refresh-resource-sample");
  try {
    await command("cc", ["-O2", "-Wall", "-Wextra", RESOURCE_SOURCE, "-o", executable]);
    return { executable, method: "darwin-proc-pid-rusage-v1" };
  } catch (error) {
    return { executable: "", method: "unavailable", error: error.message };
  }
}

let linuxClockTicks;
async function sampleLinux(pid) {
  if (!linuxClockTicks) linuxClockTicks = Number((await command("getconf", ["CLK_TCK"])).stdout.trim());
  const statText = await fsp.readFile(`/proc/${pid}/stat`, "utf8");
  const close = statText.lastIndexOf(")");
  const fields = statText.slice(close + 2).trim().split(/\s+/);
  const status = await fsp.readFile(`/proc/${pid}/status`, "utf8");
  const rssKb = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] || 0);
  return {
    pid,
    selfUserSeconds: Number(fields[11]) / linuxClockTicks,
    selfSystemSeconds: Number(fields[12]) / linuxClockTicks,
    childUserSeconds: Number(fields[13]) / linuxClockTicks,
    childSystemSeconds: Number(fields[14]) / linuxClockTicks,
    residentBytes: rssKb * 1024,
    footprintBytes: null,
  };
}

async function sampleResources(pid, sampler) {
  if (sampler.method === "linux-proc-stat") return sampleLinux(pid);
  if (!sampler.executable) return null;
  const raw = JSON.parse((await command(sampler.executable, [String(pid)])).stdout);
  const secondsPerTick = raw.timebaseNumer / raw.timebaseDenom / 1_000_000_000;
  return {
    pid,
    selfUserSeconds: raw.selfUserTicks * secondsPerTick,
    selfSystemSeconds: raw.selfSystemTicks * secondsPerTick,
    childUserSeconds: raw.childUserTicks * secondsPerTick,
    childSystemSeconds: raw.childSystemTicks * secondsPerTick,
    residentBytes: raw.residentBytes,
    footprintBytes: raw.footprintBytes,
  };
}

function subtractResources(after, before = null) {
  if (!after) return null;
  const base = before || {
    selfUserSeconds: 0,
    selfSystemSeconds: 0,
    childUserSeconds: 0,
    childSystemSeconds: 0,
  };
  const selfUserSeconds = Math.max(0, after.selfUserSeconds - base.selfUserSeconds);
  const selfSystemSeconds = Math.max(0, after.selfSystemSeconds - base.selfSystemSeconds);
  const childUserSeconds = Math.max(0, after.childUserSeconds - base.childUserSeconds);
  const childSystemSeconds = Math.max(0, after.childSystemSeconds - base.childSystemSeconds);
  return {
    selfUserSeconds,
    selfSystemSeconds,
    selfCpuSeconds: selfUserSeconds + selfSystemSeconds,
    childUserSeconds,
    childSystemSeconds,
    childCpuSeconds: childUserSeconds + childSystemSeconds,
    totalCpuSeconds: selfUserSeconds + selfSystemSeconds + childUserSeconds + childSystemSeconds,
  };
}

function parseJsonLines(target) {
  if (!fs.existsSync(target)) return [];
  return fs.readFileSync(target, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function traceStarts(target, after = "", through = "") {
  return parseJsonLines(target).filter((entry) => entry.event === "start"
    && (!after || entry.time > after)
    && (!through || entry.time <= through));
}

function eventsInWindow(target, after, through) {
  return parseJsonLines(target).filter((entry) => (!after || entry.timestamp > after)
    && (!through || entry.timestamp <= through));
}

async function filesSignature(files) {
  const values = [];
  for (const target of files) {
    const stat = await fsp.stat(target).catch(() => null);
    values.push(stat ? `${target}:${stat.size}:${stat.mtimeMs}` : `${target}:missing`);
  }
  return values.join("|");
}

async function waitForQuiescence(files, { timeoutMs, settleMs, minimumGitStarts = 0, ready = () => true } = {}) {
  const deadline = Date.now() + timeoutMs;
  let signature = await filesSignature(files);
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const next = await filesSignature(files);
    if (next !== signature) {
      signature = next;
      stableSince = Date.now();
    }
    const gitStarts = files.filter((file) => file.endsWith(".trace.jsonl"))
      .reduce((total, file) => total + traceStarts(file).length, 0);
    // A slow provider can pause between Git commands longer than settleMs.
    // Silence alone must not classify unfinished startup as measured workload.
    if (!ready()) { stableSince = Date.now(); continue; }
    if (gitStarts >= minimumGitStarts && Date.now() - stableSince >= settleMs) return;
  }
  fail(`process group did not become quiescent within ${timeoutMs} ms`);
}

function waitForRailQuiescence(files, rails, options) {
  const exited = Promise.race(rails.map((rail) => rail.closed.then((result) => {
    throw new Error(`client ${rail.clientIndex} exited before measurement (${result.signal || result.exitCode}): ${result.stderr.trim()}`);
  })));
  return Promise.race([waitForQuiescence(files, options), exited]);
}

function startRail({ sourceRoot, fixture, runDirectory, clientIndex, workload, hostSocket = "" }) {
  // These instrumentation variables can reach provider/coordinator code. Keep
  // them identical across clients so the witness does not accidentally make
  // otherwise-compatible provider environments distinct.
  const trace = path.join(runDirectory, "group.trace.jsonl");
  const herdr = path.join(runDirectory, "group.herdr.jsonl");
  const debug = path.join(runDirectory, "group.debug.jsonl");
  const performance = path.join(runDirectory, "group.components.jsonl");
  const environmentRoot = path.join(runDirectory, "group-environment");
  fs.mkdirSync(environmentRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(environmentRoot, "runtime"), { recursive: true, mode: 0o700 });
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:HERDR_|CMUX_|GIT_|REFRESH_)/.test(key))),
    HOME: path.join(environmentRoot, "home"),
    XDG_CONFIG_HOME: path.join(environmentRoot, "config"),
    XDG_CACHE_HOME: path.join(environmentRoot, "cache"),
    XDG_STATE_HOME: path.join(environmentRoot, "state"),
    XDG_RUNTIME_DIR: path.join(environmentRoot, "runtime"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    SIDERAIL_REPO_ROOT: fixture.primary,
    SIDERAIL_SOURCE_PANE_ID: `content-${clientIndex}`,
    SIDERAIL_DEBUG_LOG: debug,
    SIDERAIL_PERFORMANCE_LOG: performance,
    GIT_TRACE2_EVENT: trace,
    HERDR_BIN_PATH: FAKE_HERDR,
    HERDR_PANE_ID: `rail-${clientIndex}`,
    HERDR_TAB_ID: `tab-${clientIndex}`,
    HERDR_WORKSPACE_ID: `workspace-${clientIndex}`,
    HERDR_WORKSPACE_CWD: fixture.primary,
    REFRESH_HERDR_LOG: herdr,
    TERM: "dumb",
  };
  if (hostSocket) env.HERDR_SOCKET_PATH = hostSocket;
  if (workload === "recovery") env.SIDERAIL_WATCH_MODE = "poll-only";
  const child = spawn(process.execPath, [path.join(sourceRoot, "scripts", "siderail.mjs")], {
    cwd: fixture.primary,
    env,
    shell: false,
    stdio: ["pipe", "ignore", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const closed = new Promise((resolve) => child.on("close", (exitCode, signal) => resolve({
    exitCode,
    signal,
    stderr: Buffer.concat(stderr).toString("utf8"),
  })));
  return { clientIndex, child, closed, trace, herdr, debug, performance };
}

async function startSocketHost({ fixture, runDirectory, clientCount }) {
  const socketRoot = await fsp.mkdtemp(path.join("/tmp", "grp-"));
  const socketPath = path.join(socketRoot, "h.sock");
  const topologyPath = path.join(runDirectory, "herdr-topology.json");
  const herdrLog = path.join(runDirectory, "group.herdr.jsonl");
  const performanceLog = path.join(runDirectory, "group.components.jsonl");
  const panes = [];
  const layouts = [];
  for (let index = 1; index <= clientCount; index += 1) {
    const workspaceId = `workspace-${index}`;
    const tabId = `tab-${index}`;
    const contentPaneId = `content-${index}`;
    const railPaneId = `rail-${index}`;
    panes.push(
      { pane_id: contentPaneId, terminal_id: `content-terminal-${index}`, workspace_id: workspaceId, tab_id: tabId, foreground_cwd: fixture.primary, cwd: fixture.primary },
      { pane_id: railPaneId, terminal_id: `rail-terminal-${index}`, workspace_id: workspaceId, tab_id: tabId, label: "SIDERAIL", cwd: fixture.primary },
    );
    layouts.push({ workspace_id: workspaceId, tab_id: tabId, focused_pane_id: contentPaneId, zoomed: false });
  }
  await writeJson(topologyPath, {
    focused_workspace_id: "workspace-1",
    focused_tab_id: "tab-1",
    panes,
    layouts,
  });
  const child = spawn(process.execPath, [FAKE_HERDR, "--socket-server", socketPath, topologyPath], {
    cwd: fixture.primary,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:HERDR_|CMUX_|GIT_|REFRESH_)/.test(key))),
      REFRESH_HERDR_LOG: herdrLog,
      SIDERAIL_PERFORMANCE_LOG: performanceLog,
    },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  let stdout = "";
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const closed = new Promise((resolve) => child.on("close", (exitCode, signal) => resolve({
    exitCode,
    signal,
    stderr: Buffer.concat(stderr).toString("utf8"),
  })));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("fake Herdr socket did not become ready")), 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!stdout.includes("\n")) return;
      clearTimeout(timeout);
      try {
        const ready = JSON.parse(stdout.split("\n")[0]);
        if (!ready.ready || ready.socketPath !== socketPath) throw new Error("unexpected fake Herdr ready record");
        resolve();
      } catch (error) { reject(error); }
    });
    closed.then((result) => {
      clearTimeout(timeout);
      reject(new Error(`fake Herdr exited before ready (${result.signal || result.exitCode}): ${result.stderr}`));
    });
  });
  return { child, closed, socketPath, socketRoot };
}

async function stopSocketHost(host) {
  if (!host) return;
  host.child.stdin.write("q");
  const result = await host.closed;
  if (result.exitCode !== 0) fail(`fake Herdr socket host exited ${result.signal || result.exitCode}: ${result.stderr.trim()}`);
  if (fs.existsSync(host.socketPath)) fail("fake Herdr socket remained after fixture shutdown");
  await fsp.rm(host.socketRoot, { recursive: true, force: true });
}

async function waitForCoordinatorCleanup(performanceFile, runtimeDirectory, timeoutMs = 5_000) {
  const artifacts = async (directory) => {
    const found = [];
    for (const entry of await fsp.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) found.push(...await artifacts(target));
      else found.push(target);
    }
    return found;
  };
  const deadline = Date.now() + timeoutMs;
  let coordinators = [];
  while (Date.now() < deadline) {
    const entries = parseJsonLines(performanceFile);
    const stopped = new Set(entries.filter((entry) => entry.event === "component" && entry.role === "coordinator" && entry.phase === "stopped").map((entry) => entry.pid));
    coordinators = [...new Set(entries.filter((entry) => entry.event === "component" && entry.role === "coordinator" && entry.phase === "started").map((entry) => entry.pid))];
    const alive = coordinators.filter((pid) => {
      try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
    });
    const namespaceArtifacts = await artifacts(runtimeDirectory);
    if (coordinators.length === 1 && coordinators.every((pid) => stopped.has(pid)) && !alive.length && !namespaceArtifacts.length) {
      return { coordinatorPids: coordinators, cleanupMs: timeoutMs - (deadline - Date.now()), namespaceArtifacts: [] };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const namespaceArtifacts = await artifacts(runtimeDirectory);
  fail(`coordinator cleanup was incomplete after ${timeoutMs} ms (coordinators=${coordinators.length}, namespaceArtifacts=${namespaceArtifacts.length})`);
}

async function runWorkload(workload, fixture, quietMs) {
  const events = [];
  const started = Date.now();
  const waitUntil = async (offset) => {
    const remaining = started + offset - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  };
  if (workload === "edit-burst") {
    // The first edit is an eligible AC-11 point, separated from the later
    // burst so provider amplification can be counted independently.
    await waitUntil(2_100);
    await fsp.appendFile(path.join(fixture.primary, "src", "tracked.txt"), "single eligible edit\n", "utf8");
    events.push({ kind: "tracked-write", window: "single", index: 0, timestamp: new Date().toISOString() });
    await waitUntil(4_000);
    for (let index = 0; index < 8; index += 1) {
      await fsp.appendFile(path.join(fixture.primary, "src", "tracked.txt"), `edit ${index}\n`, "utf8");
      events.push({ kind: "tracked-write", window: "burst", index, timestamp: new Date().toISOString() });
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  } else if (workload === "ignored") {
    await fsp.mkdir(path.join(fixture.primary, ".noise"), { recursive: true });
    for (let index = 0; index < 12; index += 1) {
      await waitUntil(Math.min(250 + index * 250, Math.max(250, quietMs - 250)));
      await fsp.writeFile(path.join(fixture.primary, ".noise", "generated.txt"), `${index}\n`, "utf8");
      events.push({ kind: "ignored-write", index, timestamp: new Date().toISOString() });
    }
  } else if (workload === "sibling-index") {
    await waitUntil(Math.min(250, quietMs / 4));
    await fsp.appendFile(path.join(fixture.sibling, "src", "tracked.txt"), "sibling edit\n", "utf8");
    await command("git", ["add", "src/tracked.txt"], { cwd: fixture.sibling });
    events.push({ kind: "sibling-index", timestamp: new Date().toISOString() });
  }
  await waitUntil(quietMs);
  return events;
}

function measurementDuration(workload, requestedQuietMs) {
  if (workload === "quiet" || workload === "reconciliation") return requestedQuietMs;
  if (workload === "recovery") return 12_000;
  return 6_000;
}

function summarizeLogs(client, start, end) {
  const gitStarts = traceStarts(client.trace, start, end);
  const herdrEntries = eventsInWindow(client.herdr, start, end);
  const herdrStarts = herdrEntries.filter((entry) => entry.phase === "start");
  const herdrExits = herdrEntries.filter((entry) => entry.phase === "exit");
  const fakeHerdrCpuSeconds = herdrExits.reduce((total, entry) => total
    + ((entry.cpu?.user || 0) + (entry.cpu?.system || 0)) / 1_000_000, 0);
  const debug = eventsInWindow(client.debug, start, end);
  const componentEvents = eventsInWindow(client.performance, start, end);
  const providerStarts = debug.filter((entry) => entry.operation === "repository-provider" && entry.phase === "start");
  const providerFinishes = debug.filter((entry) => entry.operation === "repository-provider" && entry.phase === "finish");
  const snapshotPublishes = debug.filter((entry) => entry.operation === "rail-snapshot");
  const renders = debug.filter((entry) => entry.operation === "rail-render");
  return {
    gitLaunches: gitStarts.length,
    gitCommands: gitStarts.map((entry) => entry.argv || []),
    herdrLaunches: herdrStarts.length,
    herdrCommands: herdrStarts.map((entry) => entry.args || []),
    fakeHerdrCpuSeconds,
    providerBuilds: providerStarts.length,
    providerStarts,
    providerFinishes,
    providerSuccesses: providerFinishes.filter((entry) => entry.outcome === "ok").length,
    snapshotPublishes: snapshotPublishes.length,
    snapshotPublications: snapshotPublishes.map((entry) => ({ pid: entry.pid, stateGeneration: entry.stateGeneration, timestamp: entry.timestamp })),
    renderCount: renders.length,
    renderEvents: renders.map((entry) => ({ pid: entry.pid, timestamp: entry.timestamp })),
    refreshTriggers: debug.filter((entry) => entry.operation === "refresh-trigger")
      .reduce((counts, entry) => {
        const source = entry.source || entry.kind || "unknown";
        counts[source] = (counts[source] || 0) + 1;
        return counts;
      }, {}),
    componentEvents,
  };
}

function aggregateClientMeasurements(clients) {
  const totals = {
    gitLaunches: 0,
    herdrLaunches: 0,
    fakeHerdrCpuSeconds: 0,
    selfCpuSeconds: 0,
    childCpuSeconds: 0,
    totalCpuSeconds: 0,
    providerBuilds: 0,
    providerSuccesses: 0,
    snapshotPublishes: 0,
    renderCount: 0,
  };
  let cpuAvailable = true;
  for (const client of clients) {
    totals.gitLaunches += client.logs.gitLaunches;
    totals.herdrLaunches += client.logs.herdrLaunches;
    totals.fakeHerdrCpuSeconds += client.logs.fakeHerdrCpuSeconds;
    totals.providerBuilds += client.logs.providerBuilds;
    totals.providerSuccesses += client.logs.providerSuccesses;
    totals.snapshotPublishes += client.logs.snapshotPublishes;
    totals.renderCount += client.logs.renderCount;
    if (!client.cpu) cpuAvailable = false;
    else {
      totals.selfCpuSeconds += client.cpu.selfCpuSeconds;
      totals.childCpuSeconds += client.cpu.childCpuSeconds;
      totals.totalCpuSeconds += client.cpu.totalCpuSeconds;
    }
  }
  return { ...totals, cpuAvailable };
}

function providerWindowCounts(logs, workloadEvents, measurementEndedAt) {
  const starts = logs.providerStarts || [];
  const count = (after, through) => starts.filter((entry) => entry.timestamp >= after && entry.timestamp < through).length;
  const single = workloadEvents.find((entry) => entry.window === "single");
  const burst = workloadEvents.find((entry) => entry.window === "burst");
  if (!single || !burst) return {};
  return {
    singleEdit: { startedAt: single.timestamp, endedAt: burst.timestamp, providerBuilds: count(single.timestamp, burst.timestamp) },
    burst: { startedAt: burst.timestamp, endedAt: measurementEndedAt, providerBuilds: count(burst.timestamp, measurementEndedAt) },
  };
}

function finalWatcherMetrics(debugFile) {
  const entries = parseJsonLines(debugFile).filter((entry) => entry.operation === "repository-watcher" && entry.phase === "finish");
  const metricKeys = ["installed", "closed", "retries", "identityChanges", "configQueries"];
  const classifierKeys = ["events", "classifierLaunches", "ignoredEvents", "invalidations"];
  return {
    engineCount: entries.length,
    metrics: Object.fromEntries(metricKeys.map((key) => [key, entries.reduce((total, entry) => total + Number(entry.metrics?.[key] || 0), 0)])),
    classifierMetrics: Object.fromEntries(classifierKeys.map((key) => [key, entries.reduce((total, entry) => total + Number(entry.classifierMetrics?.[key] || 0), 0)])),
  };
}

function declaredComponents(target, through = "") {
  const active = new Map();
  for (const entry of parseJsonLines(target)) {
    if (through && entry.timestamp > through) continue;
    if (entry.event !== "component" || !Number.isInteger(entry.pid) || entry.pid <= 0 || !entry.role) continue;
    const key = `${entry.role}:${entry.pid}`;
    if (entry.phase === "stopped") active.delete(key);
    else if (["started", "ready"].includes(entry.phase)) active.set(key, {
      role: String(entry.role),
      pid: entry.pid,
      owner: entry.owner ? String(entry.owner) : null,
    });
  }
  const byPid = new Map();
  for (const component of active.values()) {
    const current = byPid.get(component.pid);
    if (current) current.roles.push(component.role);
    else byPid.set(component.pid, { pid: component.pid, roles: [component.role], owner: component.owner });
  }
  return [...byPid.values()];
}

async function sampleComponents(target, through, sampler) {
  const declarations = declaredComponents(target, through);
  return Promise.all(declarations.map(async (component) => ({
    ...component,
    sample: await sampleResources(component.pid, sampler).catch(() => null),
  })));
}

function componentInterval(afterComponents, beforeComponents = []) {
  const beforeByPid = new Map(beforeComponents.map((component) => [component.pid, component.sample]));
  return afterComponents.map((component) => ({
    pid: component.pid,
    roles: component.roles,
    owner: component.owner,
    cpu: subtractResources(component.sample, beforeByPid.get(component.pid) || null),
  }));
}

function applicationTotals(railTotals, components) {
  const totals = { ...railTotals, registeredComponentCount: components.length };
  for (const component of components) {
    if (!component.cpu) {
      totals.cpuAvailable = false;
      continue;
    }
    totals.selfCpuSeconds += component.cpu.selfCpuSeconds;
    totals.childCpuSeconds += component.cpu.childCpuSeconds;
    totals.totalCpuSeconds += component.cpu.totalCpuSeconds;
  }
  return totals;
}

async function stopRails(clients) {
  for (const client of clients) client.child.stdin.write("q");
  const results = await Promise.all(clients.map((client) => client.closed));
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.exitCode !== 0) fail(`client ${index + 1} exited ${result.exitCode}: ${result.stderr.trim()}`);
  }
  for (const client of clients) {
    try {
      process.kill(client.child.pid, 0);
      fail(`client process ${client.child.pid} remained alive after teardown`);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

async function measureRun({ source, sampler, tempRoot, output, clients: clientCount, repeat, workload, options }) {
  const runId = `${workload}-c${clientCount}-r${repeat}`;
  const runDirectory = path.join(output, "runs", runId);
  const fixtureRoot = path.join(tempRoot, "fixtures", runId);
  await fsp.mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await fsp.mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
  const fixture = await prepareFixture(fixtureRoot);
  const rails = [];
  let socketHost;
  let stopped = false;
  try {
    if (options.candidateStage === "B" && options.mode !== "baseline") {
      socketHost = await startSocketHost({ fixture, runDirectory, clientCount });
    }
    for (let index = 1; index <= clientCount; index += 1) {
      rails.push(startRail({
        sourceRoot: source.sourceRoot,
        fixture,
        runDirectory,
        clientIndex: index,
        workload,
        hostSocket: socketHost?.socketPath || "",
      }));
    }
    const activityFiles = [...new Set(rails.flatMap((client) => [client.trace, client.herdr]))];
    const providersFinished = () => {
      const debug = parseJsonLines(rails[0].debug);
      const providers = debug.filter((entry) => entry.operation === "repository-provider");
      return providers.filter((entry) => entry.phase === "start").length
        === providers.filter((entry) => entry.phase === "finish").length;
    };
    await waitForRailQuiescence(activityFiles, rails, {
      timeoutMs: options.startupTimeoutMs,
      settleMs: options.settleMs,
      minimumGitStarts: clientCount,
      ready: () => !socketHost || providersFinished()
        && new Set(parseJsonLines(rails[0].debug).filter((entry) => entry.operation === "rail-snapshot")
          .map((entry) => entry.pid)).size === clientCount,
    });
    const startupEndedAt = new Date().toISOString();
    const startupSamples = await Promise.all(rails.map((client) => sampleResources(client.child.pid, sampler)));
    const startupComponentSamples = await sampleComponents(rails[0].performance, startupEndedAt, sampler);
    const startupGroupLogs = summarizeLogs(rails[0], "", startupEndedAt);
    const startupClients = rails.map((client, index) => ({
      client: client.clientIndex,
      pid: client.child.pid,
      cpu: subtractResources(startupSamples[index]),
      logs: index === 0 ? startupGroupLogs : {
        gitLaunches: 0,
        gitCommands: [],
        herdrLaunches: 0,
        herdrCommands: [],
        fakeHerdrCpuSeconds: 0,
        providerBuilds: 0,
        providerStarts: [],
        providerFinishes: [],
        providerSuccesses: 0,
        snapshotPublishes: 0,
        snapshotPublications: [],
        renderCount: 0,
        renderEvents: [],
        refreshTriggers: {},
        componentEvents: [],
      },
    }));
    const startupComponents = componentInterval(startupComponentSamples);
    const startupRailTotals = aggregateClientMeasurements(startupClients);
    const measurementStartedAt = new Date().toISOString();
    const wallStarted = process.hrtime.bigint();
    const measuredDurationMs = measurementDuration(workload, options.quietMs);
    const workloadEvents = await runWorkload(workload, fixture, measuredDurationMs);
    await waitForRailQuiescence(activityFiles, rails, {
      timeoutMs: options.startupTimeoutMs,
      settleMs: Math.min(options.settleMs, 750),
      minimumGitStarts: clientCount,
      ready: providersFinished,
    });
    const measurementEndedAt = new Date().toISOString();
    const wallSeconds = Number(process.hrtime.bigint() - wallStarted) / 1_000_000_000;
    const finalSamples = await Promise.all(rails.map((client) => sampleResources(client.child.pid, sampler)));
    const finalComponentSamples = await sampleComponents(rails[0].performance, measurementEndedAt, sampler);
    const measurementGroupLogs = summarizeLogs(rails[0], measurementStartedAt, measurementEndedAt);
    const measurementClients = rails.map((client, index) => ({
      client: client.clientIndex,
      pid: client.child.pid,
      cpu: subtractResources(finalSamples[index], startupSamples[index]),
      logs: index === 0 ? measurementGroupLogs : {
        gitLaunches: 0,
        gitCommands: [],
        herdrLaunches: 0,
        herdrCommands: [],
        fakeHerdrCpuSeconds: 0,
        providerBuilds: 0,
        providerStarts: [],
        providerFinishes: [],
        providerSuccesses: 0,
        snapshotPublishes: 0,
        snapshotPublications: [],
        renderCount: 0,
        renderEvents: [],
        refreshTriggers: {},
        componentEvents: [],
      },
    }));
    const measurementComponents = componentInterval(finalComponentSamples, startupComponentSamples);
    const measurementRailTotals = aggregateClientMeasurements(measurementClients);
    const result = {
      schemaVersion: 1,
      runId,
      mode: options.mode,
      candidateStage: options.candidateStage || null,
      source: { ...source, sourceRoot: undefined },
      fixture: { head: fixture.head, shape: "two commits, dirty tracked file, untracked file, linked sibling worktree" },
      platform: {
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        node: process.version,
        git: (await command("git", ["--version"])).stdout.trim(),
        cpuModel: os.cpus()[0]?.model || "unknown",
        logicalCpuCount: os.cpus().length,
      },
      clientCount,
      repeat,
      workload,
      nominalWindowMs: options.quietMs,
      startup: {
        endedAt: startupEndedAt,
        clients: startupClients,
        components: startupComponents,
        railTotals: startupRailTotals,
        totals: applicationTotals(startupRailTotals, startupComponents),
      },
      measurement: {
        startedAt: measurementStartedAt,
        endedAt: measurementEndedAt,
        wallSeconds,
        requestedQuietMs: options.quietMs,
        workloadDurationMs: measuredDurationMs,
        workloadEvents,
        providerWindows: providerWindowCounts(measurementGroupLogs, workloadEvents, measurementEndedAt),
        clients: measurementClients,
        components: measurementComponents,
        railTotals: measurementRailTotals,
        totals: applicationTotals(measurementRailTotals, measurementComponents),
      },
      resourceAccounting: {
        method: sampler.method,
        error: sampler.error || null,
        boundary: "each rail process self CPU plus cumulative CPU of exited children, sampled only after activity logs settled",
        includes: sampler.method === "unavailable" ? [] : ["rail process", "exited Git children",
          ...(socketHost ? ["coordinator", "owned socket-host fixture"] : ["exited fake-Herdr children"])],
        excludes: ["benchmark harness", "kernel-wide process creation cost", "live Herdr server", "unregistered coordinator or host-source processes"],
        fakeHerdr: socketHost
          ? "owned socket server; its self CPU is included once as a registered component; requests do not create subprocesses"
          : "owned deterministic subprocess; its CPU is already included in waited-child CPU",
        gitCpu: "included exactly in aggregate waited-child CPU; not separated from other exited children",
        launchAttribution: "shared instrumentation paths preserve identical provider environments; launch counts are exact for the client group, not attributed to one rail",
      },
      hostAccounting: {
        transport: socketHost ? "socket" : "cli",
        startupRequests: startupRailTotals.herdrLaunches,
        measurementRequests: measurementRailTotals.herdrLaunches,
        startupSubprocesses: socketHost ? 0 : startupRailTotals.herdrLaunches,
        measurementSubprocesses: socketHost ? 0 : measurementRailTotals.herdrLaunches,
      },
      teardown: { clientsExited: false, coordinatorReleased: null, hostExited: socketHost ? false : null, fixtureRemoved: false },
    };
    await stopRails(rails);
    stopped = true;
    result.teardown.clientsExited = true;
    if (socketHost) {
      result.teardown.coordinatorReleased = await waitForCoordinatorCleanup(
        rails[0].performance,
        path.join(runDirectory, "group-environment", "runtime"),
      );
      await stopSocketHost(socketHost);
      result.teardown.hostExited = true;
    }
    result.lifecycle = { watcher: finalWatcherMetrics(rails[0].debug) };
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
    result.teardown.fixtureRemoved = !fs.existsSync(fixtureRoot);
    await writeJson(path.join(runDirectory, "result.json"), result);
    return result;
  } finally {
    if (!stopped) {
      for (const client of rails) client.child.kill("SIGTERM");
      await Promise.allSettled(rails.map((client) => client.closed));
    }
    if (socketHost && socketHost.child.exitCode === null) await stopSocketHost(socketHost).catch(() => {});
    if (fs.existsSync(fixtureRoot)) await fsp.rm(fixtureRoot, { recursive: true, force: true });
  }
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  if (!ordered.length) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function summarizeRuns(runs) {
  const groups = {};
  for (const run of runs) {
    const key = `${run.workload}/clients-${run.clientCount}`;
    const group = groups[key] ||= { workload: run.workload, clientCount: run.clientCount, runs: [] };
    group.runs.push({
      runId: run.runId,
      wallSeconds: run.measurement.wallSeconds,
      gitLaunches: run.measurement.totals.gitLaunches,
      herdrLaunches: run.measurement.totals.herdrLaunches,
      providerBuilds: run.measurement.totals.providerBuilds,
      providerSuccesses: run.measurement.totals.providerSuccesses,
      snapshotPublishes: run.measurement.totals.snapshotPublishes,
      renderCount: run.measurement.totals.renderCount,
      selfCpuSeconds: run.measurement.totals.cpuAvailable ? run.measurement.totals.selfCpuSeconds : null,
      childCpuSeconds: run.measurement.totals.cpuAvailable ? run.measurement.totals.childCpuSeconds : null,
      totalCpuSeconds: run.measurement.totals.cpuAvailable ? run.measurement.totals.totalCpuSeconds : null,
    });
  }
  for (const group of Object.values(groups)) {
    for (const field of [
      "wallSeconds", "gitLaunches", "herdrLaunches", "providerBuilds", "providerSuccesses",
      "snapshotPublishes", "renderCount", "selfCpuSeconds", "childCpuSeconds", "totalCpuSeconds",
    ]) {
      const values = group.runs.map((run) => run[field]).filter((value) => value !== null);
      group[`${field}Median`] = median(values);
      group[`${field}Min`] = values.length ? Math.min(...values) : null;
      group[`${field}Max`] = values.length ? Math.max(...values) : null;
    }
  }
  return groups;
}

async function loadBaselineReference(target) {
  const summaryPath = path.join(target, "summary.json");
  const parsed = JSON.parse(await fsp.readFile(summaryPath, "utf8"));
  if (parsed.schemaVersion !== 1 || parsed.mode !== "baseline") fail(`not a compatible baseline: ${summaryPath}`);
  return {
    summaryPath,
    source: parsed.source,
    groups: parsed.groups,
    summarySha256: await sha256File(summaryPath),
  };
}

async function runPackagedSmoke({ source, sampler, tempRoot, output, options }) {
  const archive = path.join(output, "candidate.tar");
  await command("tar", ["-cf", archive, "-C", source.sourceRoot, "."]);
  const archiveSha256 = await sha256File(archive);
  const unpackedRoot = path.join(tempRoot, "packaged-source");
  await fsp.mkdir(unpackedRoot, { recursive: true, mode: 0o700 });
  await command("tar", ["-xf", archive, "-C", unpackedRoot]);
  const verification = await command(process.execPath, ["scripts/verify-artifact.mjs"], { cwd: unpackedRoot });
  const packagedSource = {
    ...source,
    kind: "packaged-candidate",
    sourceRoot: unpackedRoot,
    archiveSha256,
  };
  const smokeOptions = {
    ...options,
    candidateStage: "B",
    clients: [1],
    quietMs: 1_000,
    repeats: 1,
    workloads: ["quiet"],
  };
  const run = await measureRun({
    source: packagedSource,
    sampler,
    tempRoot,
    output,
    clients: 1,
    repeat: 1,
    workload: "quiet",
    options: smokeOptions,
  });
  return {
    archive: { path: "candidate.tar", sha256: archiveSha256 },
    verifier: { command: `${process.execPath} scripts/verify-artifact.mjs`, stdout: verification.stdout.trim() },
    run,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await prepareOutput(options.output);
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "siderail-refresh-performance-"));
  let source;
  try {
    source = options.mode === "baseline"
      ? await prepareBaselineSource(tempRoot, options.baselineRevision)
      : await prepareCandidateSource(tempRoot);
    const sampler = await compileResourceSampler(tempRoot);
    const baselineReference = options.mode === "compare" ? await loadBaselineReference(options.baseline) : null;
    const instrumentationHashes = {
      harnessSha256: await sha256File(fileURLToPath(import.meta.url)),
      fakeHerdrSha256: await sha256File(FAKE_HERDR),
      resourceSamplerSourceSha256: await sha256File(RESOURCE_SOURCE),
    };
    const manifest = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      mode: options.mode,
      candidateStage: options.candidateStage || null,
      source: { ...source, sourceRoot: undefined },
      baselineReference,
      requested: {
        clients: options.clients,
        quietMs: options.quietMs,
        repeats: options.repeats,
        workloads: options.workloads,
      },
      instrumentation: {
        gitLaunches: "exact Git Trace2 start events written by each rail",
        herdrLaunches: "legacy field name: exact host requests; see per-run hostAccounting to distinguish socket requests from CLI subprocesses",
        cpu: sampler.method,
        futureComponents: "candidate processes append {event:'component',phase:'started'|'ready'|'stopped',role,pid,owner?} JSON lines to the shared SIDERAIL_PERFORMANCE_LOG; active unique PIDs are sampled once, including coordinator and host-source processes",
        pathsSharedAcrossClients: true,
        hashes: instrumentationHashes,
      },
    };
    await writeJson(path.join(options.output, "manifest.json"), manifest);
    if (options.mode === "packaged-smoke") {
      const packaged = await runPackagedSmoke({ source, sampler, tempRoot, output: options.output, options });
      const summary = {
        ...manifest,
        completedAt: new Date().toISOString(),
        packaged: {
          archive: packaged.archive,
          verifier: packaged.verifier,
          runId: packaged.run.runId,
          teardown: packaged.run.teardown,
          startup: packaged.run.startup.totals,
          measurement: packaged.run.measurement.totals,
        },
        cleanup: { temporaryRootRemoved: false },
      };
      await fsp.rm(tempRoot, { recursive: true, force: true });
      summary.cleanup.temporaryRootRemoved = !fs.existsSync(tempRoot);
      await writeJson(path.join(options.output, "summary.json"), summary);
      process.stdout.write(`${JSON.stringify({ output: options.output, packaged: summary.packaged, cleanup: summary.cleanup }, null, 2)}\n`);
      return;
    }
    const runs = [];
    for (const workload of options.workloads) {
      for (const clientCount of options.clients) {
        for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
          process.stderr.write(`refresh-performance: ${workload}, ${clientCount} client(s), repeat ${repeat}/${options.repeats}\n`);
          runs.push(await measureRun({
            source,
            sampler,
            tempRoot,
            output: options.output,
            clients: clientCount,
            repeat,
            workload,
            options,
          }));
        }
      }
    }
    const summary = {
      ...manifest,
      completedAt: new Date().toISOString(),
      groups: summarizeRuns(runs),
      cleanup: { temporaryRootRemoved: false },
    };
    await fsp.rm(tempRoot, { recursive: true, force: true });
    summary.cleanup.temporaryRootRemoved = !fs.existsSync(tempRoot);
    await writeJson(path.join(options.output, "summary.json"), summary);
    process.stdout.write(`${JSON.stringify({
      output: options.output,
      runs: runs.length,
      groups: summary.groups,
      cleanup: summary.cleanup,
    }, null, 2)}\n`);
  } finally {
    if (fs.existsSync(tempRoot)) await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`refresh-performance failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
