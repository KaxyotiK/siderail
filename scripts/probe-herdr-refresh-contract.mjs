#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGitStateClient } from "../src/git-state-client.mjs";
import { createGitStateCoordinator } from "../src/git-state-coordinator.mjs";
import { createHerdrContextSource } from "../src/herdr-context-watch.mjs";
import {
  HERDR_CONTEXT_SUBSCRIPTIONS,
  normalizeHerdrEventName,
  requestHerdr,
  subscribeHerdr,
} from "../src/herdr-socket.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(repositoryRoot, "scripts/lib/herdr-subscriber-worker.mjs");
const sharedClientWorkerPath = path.join(repositoryRoot, "scripts/lib/git-state-host-client-worker.mjs");
let sharedSourceSequence = 0;

function parseArguments(argv) {
  const options = {
    isolated: false,
    trials: 10,
    deadlineMs: 2_000,
    subscriberCounts: [1, 8],
    out: path.join(repositoryRoot, "test-results/git-refresh/herdr-contract"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--isolated") options.isolated = true;
    else if (argument === "--verify-adapter") options.verifyAdapter = true;
    else if (argument === "--candidate-stage") options.candidateStage = argv[++index];
    else if (argument === "--trials") options.trials = Number.parseInt(argv[++index], 10);
    else if (argument === "--deadline-ms") options.deadlineMs = Number.parseInt(argv[++index], 10);
    else if (argument === "--measure-subscribers") {
      options.subscriberCounts = argv[++index].split(",").map((value) => Number.parseInt(value, 10));
    } else if (argument === "--out") options.out = path.resolve(argv[++index]);
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.isolated) throw new Error("refusing to inspect an inherited/live Herdr session; pass --isolated");
  if (options.trials !== 10) throw new Error("the contract witness requires exactly --trials 10");
  if (!Number.isInteger(options.deadlineMs) || options.deadlineMs < 100) throw new Error("invalid --deadline-ms");
  if (!options.subscriberCounts.length || options.subscriberCounts.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new Error("invalid --measure-subscribers");
  }
  if (options.candidateStage !== undefined && !["A", "B"].includes(options.candidateStage)) {
    throw new Error("--candidate-stage must be A or B");
  }
  if (options.candidateStage === "B" && !options.verifyAdapter) {
    throw new Error("--candidate-stage B requires --verify-adapter");
  }
  return options;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function makeCache(snapshot) {
  return {
    focusedWorkspaceId: snapshot.focused_workspace_id || "",
    focusedTabId: snapshot.focused_tab_id || "",
    focusedPaneId: snapshot.focused_pane_id || "",
    workspaces: new Map(snapshot.workspaces.map((value) => [value.workspace_id, value])),
    tabs: new Map(snapshot.tabs.map((value) => [value.tab_id, value])),
    panes: new Map(snapshot.panes.map((value) => [value.pane_id, value])),
    layouts: new Map(snapshot.layouts.map((value) => [value.tab_id, value])),
  };
}

function applyEvent(cache, message) {
  const data = message.data || {};
  const event = normalizeHerdrEventName(message.event);
  switch (event) {
    case "workspace.created":
    case "workspace.updated":
      if (data.workspace) cache.workspaces.set(data.workspace.workspace_id, data.workspace);
      break;
    case "workspace.closed":
      cache.workspaces.delete(data.workspace_id);
      break;
    case "workspace.focused":
      cache.focusedWorkspaceId = data.workspace_id;
      break;
    case "tab.created":
      if (data.tab) cache.tabs.set(data.tab.tab_id, data.tab);
      break;
    case "tab.closed":
      cache.tabs.delete(data.tab_id);
      cache.layouts.delete(data.tab_id);
      break;
    case "tab.focused":
      cache.focusedWorkspaceId = data.workspace_id;
      cache.focusedTabId = data.tab_id;
      break;
    case "tab.moved":
      for (const tab of data.tabs || []) cache.tabs.set(tab.tab_id, tab);
      break;
    case "pane.created":
    case "pane.updated":
      if (data.pane) cache.panes.set(data.pane.pane_id, data.pane);
      break;
    case "pane.closed":
    case "pane.exited":
      cache.panes.delete(data.pane_id);
      break;
    case "pane.focused": { // layout.updated normally follows, but preserve focus if it is delayed.
      cache.focusedWorkspaceId = data.workspace_id;
      cache.focusedPaneId = data.pane_id;
      const pane = cache.panes.get(data.pane_id);
      if (pane) {
        cache.focusedTabId = pane.tab_id;
        const layout = cache.layouts.get(pane.tab_id);
        if (layout) cache.layouts.set(pane.tab_id, { ...layout, focused_pane_id: data.pane_id });
      }
      break;
    }
    case "pane.moved":
      cache.panes.delete(data.previous_pane_id);
      if (data.pane) cache.panes.set(data.pane.pane_id, data.pane);
      if (data.source_layout) cache.layouts.set(data.source_layout.tab_id, data.source_layout);
      if (data.target_layout) cache.layouts.set(data.target_layout.tab_id, data.target_layout);
      if (data.created_workspace) cache.workspaces.set(data.created_workspace.workspace_id, data.created_workspace);
      if (data.created_tab) cache.tabs.set(data.created_tab.tab_id, data.created_tab);
      if (data.closed_workspace_id) cache.workspaces.delete(data.closed_workspace_id);
      if (data.closed_tab_id) cache.tabs.delete(data.closed_tab_id);
      if (data.focused_pane_id) cache.focusedPaneId = data.focused_pane_id;
      if (data.pane?.focused) cache.focusedPaneId = data.pane.pane_id;
      if (data.pane && (data.focused_pane_id === data.pane.pane_id || data.pane.focused)) {
        cache.focusedWorkspaceId = data.pane.workspace_id;
        cache.focusedTabId = data.pane.tab_id;
      }
      break;
    case "layout.updated":
      if (data.layout) {
        cache.layouts.set(data.layout.tab_id, data.layout);
        if (data.layout.tab_id === cache.focusedTabId) cache.focusedPaneId = data.layout.focused_pane_id;
      }
      break;
  }
}

function tabContext(cache, tabId) {
  const layout = cache.layouts.get(tabId);
  const pane = cache.panes.get(layout?.focused_pane_id);
  return {
    workspaceId: pane?.workspace_id || layout?.workspace_id || "",
    tabId,
    paneId: pane?.pane_id || "",
    cwd: pane?.foreground_cwd || pane?.cwd || "",
  };
}

function globalContext(cache) {
  const pane = cache.panes.get(cache.focusedPaneId);
  return {
    workspaceId: cache.focusedWorkspaceId,
    tabId: cache.focusedTabId,
    paneId: cache.focusedPaneId,
    cwd: pane?.foreground_cwd || pane?.cwd || "",
  };
}

function contextsEqual(left, right) {
  return left.workspaceId === right.workspaceId
    && left.tabId === right.tabId
    && left.paneId === right.paneId
    && left.cwd === right.cwd;
}

function matchesExpected(context, expected) {
  return Object.entries(expected).every(([key, value]) => context?.[key] === value);
}

async function waitFor(label, operation, deadlineMs) {
  const start = performance.now();
  let observed;
  while (performance.now() - start <= deadlineMs) {
    observed = operation();
    if (observed) return { latencyMs: performance.now() - start, value: observed };
    await delay(20);
  }
  const error = new Error(`${label} did not converge within ${deadlineMs} ms`);
  error.observed = observed;
  throw error;
}

async function waitForEventQuiet(events, quietMs = 300, deadlineMs = 3_000) {
  const deadline = performance.now() + deadlineMs;
  let previous = events.length;
  let quietSince = performance.now();
  while (performance.now() < deadline) {
    await delay(25);
    if (events.length !== previous) {
      previous = events.length;
      quietSince = performance.now();
    } else if (performance.now() - quietSince >= quietMs) return;
  }
  throw new Error(`Herdr event stream did not become quiet within ${deadlineMs} ms`);
}

function spawnJsonWorker(socketPath, durationMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, socketPath, String(durationMs)], {
      cwd: repositoryRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error(`subscriber worker failed (${code}): ${stderr || stdout}`));
      try { resolve(JSON.parse(stdout)); }
      catch (error) { reject(new Error(`subscriber worker returned invalid JSON: ${error.message}: ${stdout}`)); }
    });
  });
}

async function measureSubscribers(socketPath, counts) {
  const results = [];
  for (const count of counts) {
    const durationMs = 3_000;
    const workers = await Promise.all(Array.from({ length: count }, () => spawnJsonWorker(socketPath, durationMs)));
    results.push({
      subscribers: count,
      durationMs,
      requests: { "events.subscribe": count },
      bootstrapEvents: workers.reduce((sum, worker) => sum + worker.bootstrapEvents, 0),
      bootstrapEventCounts: Object.fromEntries(workers.reduce((counts, worker) => {
        for (const [event, value] of Object.entries(worker.bootstrapEventCounts)) {
          counts.set(event, (counts.get(event) || 0) + value);
        }
        return counts;
      }, new Map())),
      startupCpuMicros: {
        user: workers.reduce((sum, worker) => sum + worker.startupCpuMicros.user, 0),
        system: workers.reduce((sum, worker) => sum + worker.startupCpuMicros.system, 0),
        total: workers.reduce((sum, worker) => sum + worker.startupCpuMicros.total, 0),
      },
      events: workers.reduce((sum, worker) => sum + worker.events, 0),
      eventCounts: Object.fromEntries(workers.reduce((counts, worker) => {
        for (const [event, value] of Object.entries(worker.eventCounts)) {
          counts.set(event, (counts.get(event) || 0) + value);
        }
        return counts;
      }, new Map())),
      cpuMicros: {
        user: workers.reduce((sum, worker) => sum + worker.cpuMicros.user, 0),
        system: workers.reduce((sum, worker) => sum + worker.cpuMicros.system, 0),
        total: workers.reduce((sum, worker) => sum + worker.cpuMicros.total, 0),
      },
      rssBytes: workers.reduce((sum, worker) => sum + worker.rssBytes, 0),
      maxRssBytes: workers.reduce((sum, worker) => sum + worker.maxRssBytes, 0),
      workers,
    });
  }
  return results;
}

async function createProbeContextSource({ stage, root, readSnapshot, intervalMs }) {
  if (stage !== "B") return createHerdrContextSource({ intervalMs, readSnapshot });
  const sequence = ++sharedSourceSequence;
  const namespaceId = `probe-shared-host-${process.pid}-${sequence}`;
  const coordinatorSocketPath = path.join(root, `gsc-${sequence}.sock`);
  let sourceFactories = 0;
  let directSource;
  const coordinator = createGitStateCoordinator({
    namespaceId,
    hostSourceFactory: () => {
      sourceFactories += 1;
      directSource = createHerdrContextSource({ fallbackIntervalMs: intervalMs, readSnapshot });
      return directSource;
    },
  });
  await coordinator.listen(coordinatorSocketPath);
  const client = createGitStateClient({ namespaceId, socketPath: coordinatorSocketPath });
  let active;
  let closed = false;
  return {
    subscribe(selector, listener) {
      if (active) throw new Error("probe source supports one host subscription per client");
      const handle = client.subscribeHost(selector, (context) => listener(context, { reason: "shared-ipc" }));
      active = handle;
      return {
        ready: handle.ready,
        get context() { return handle.latest(); },
        async unsubscribe() {
          if (active === handle) active = undefined;
          await handle.close();
        },
      };
    },
    requestRefresh(reason = "manual") {
      if (!active) throw new Error("probe source has no active host subscription");
      return active.refresh(reason);
    },
    metrics() {
      return {
        ...(directSource?.metrics() || { snapshotRequests: 0, fallbackIntervalMs: intervalMs }),
        mode: "phase-b-shared-ipc",
        sourceFactories,
        clients: 1,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      const handle = active;
      active = undefined;
      await handle?.close().catch(() => {});
      await client.close().catch(() => {});
      await coordinator.close().catch(() => {});
      fs.rmSync(coordinatorSocketPath, { force: true });
    },
  };
}

function spawnSharedHostClient({ socketPath, namespaceId, selector, durationMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      sharedClientWorkerPath,
      socketPath,
      namespaceId,
      JSON.stringify(selector),
      String(durationMs),
    ], {
      cwd: repositoryRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error(`shared host client failed (${code}): ${stderr || stdout}`));
      try { resolve(JSON.parse(stdout)); }
      catch (error) { reject(new Error(`shared host client returned invalid JSON: ${error.message}: ${stdout}`)); }
    });
  });
}

async function measureSharedHostClients({ root, readSnapshot, selector, counts }) {
  const measurements = [];
  for (const count of counts) {
    const sequence = ++sharedSourceSequence;
    const namespaceId = `probe-shared-measure-${process.pid}-${sequence}`;
    const coordinatorSocketPath = path.join(root, `gsm-${sequence}.sock`);
    const durationMs = 1_250;
    let sourceFactories = 0;
    let source;
    let snapshotRequests = 0;
    const coordinator = createGitStateCoordinator({
      namespaceId,
      hostSourceFactory: () => {
        sourceFactories += 1;
        source = createHerdrContextSource({
          fallbackIntervalMs: 1_000,
          readSnapshot: async () => {
            snapshotRequests += 1;
            return readSnapshot();
          },
        });
        return source;
      },
    });
    await coordinator.listen(coordinatorSocketPath);
    const startedAt = performance.now();
    let workers;
    try {
      workers = await Promise.all(Array.from({ length: count }, () => spawnSharedHostClient({
        socketPath: coordinatorSocketPath,
        namespaceId,
        selector,
        durationMs,
      })));
    } finally {
      await coordinator.close().catch(() => {});
      fs.rmSync(coordinatorSocketPath, { force: true });
    }
    const elapsedMs = performance.now() - startedAt;
    measurements.push({
      clients: count,
      durationMs,
      elapsedMs: Number(elapsedMs.toFixed(3)),
      sourceFactories,
      snapshotRequests,
      initialRequests: snapshotRequests > 0 ? 1 : 0,
      periodicRequests: Math.max(0, snapshotRequests - 1),
      periodicRequestsPerSecond: Number((Math.max(0, snapshotRequests - 1) / (durationMs / 1_000)).toFixed(3)),
      workerCpuMicros: {
        user: workers.reduce((sum, worker) => sum + worker.cpuMicros.user, 0),
        system: workers.reduce((sum, worker) => sum + worker.cpuMicros.system, 0),
        total: workers.reduce((sum, worker) => sum + worker.cpuMicros.total, 0),
      },
      workerRssBytes: workers.reduce((sum, worker) => sum + worker.rssBytes, 0),
      workers,
    });
  }
  return measurements;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const herdr = process.env.HERDR_BIN_PATH || "herdr";
  // Darwin's per-user TMPDIR is long enough to exceed sockaddr_un once Herdr's
  // named-session suffix is appended. /tmp is the same local temporary volume
  // with a short, mkdtemp-owned path.
  const temporaryParent = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const root = fs.mkdtempSync(path.join(temporaryParent, "grhc."));
  const xdg = {
    config: path.join(root, "config"),
    cache: path.join(root, "cache"),
    state: path.join(root, "state"),
  };
  for (const value of Object.values(xdg)) fs.mkdirSync(value, { recursive: true });
  const session = `gh${process.pid}`;
  const socketPath = path.join(xdg.config, "herdr/sessions", session, "herdr.sock");
  const environment = {
    ...process.env,
    XDG_CONFIG_HOME: xdg.config,
    XDG_CACHE_HOME: xdg.cache,
    XDG_STATE_HOME: xdg.state,
    HERDR_SESSION: session,
  };
  for (const key of [
    "HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_CLIENT_SOCKET_PATH",
    "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID",
    "HERDR_PLUGIN_CONTEXT_JSON", "HERDR_PLUGIN_EVENT",
  ]) delete environment[key];

  const fixtureDirectories = Array.from({ length: 8 }, (_, index) => {
    const value = path.join(root, `cwd-${index}`);
    fs.mkdirSync(value);
    return fs.realpathSync(value);
  });
  const server = spawn(herdr, ["server"], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let serverStderr = "";
  server.stderr.on("data", (chunk) => { serverStderr += chunk; });
  const directRequests = {};
  const events = [];
  let subscriber;
  let subscriberLoop;
  let cache;
  let teardown = { sessionStop: false, serverExitCode: null, socketRemoved: false, temporaryRootRemoved: false };
  let report;

  const call = async (method, params = {}) => {
    directRequests[method] = (directRequests[method] || 0) + 1;
    return requestHerdr(socketPath, method, params, { id: `${method}-${directRequests[method]}` });
  };
  const startSubscriber = async () => {
    directRequests["events.subscribe"] = (directRequests["events.subscribe"] || 0) + 1;
    subscriber = await subscribeHerdr(socketPath, HERDR_CONTEXT_SUBSCRIPTIONS, {
      id: `events.subscribe-${directRequests["events.subscribe"]}`,
    });
    const active = subscriber;
    subscriberLoop = (async () => {
      while (subscriber === active) {
        try {
          const message = await active.next({ timeoutMs: 30_000 });
          events.push({ monotonicMs: performance.now(), ...message });
          applyEvent(cache, message);
        } catch (error) {
          if (subscriber === active && error.code !== "HERDR_TIMEOUT") throw error;
        }
      }
    })();
  };
  const stopSubscriber = async () => {
    const active = subscriber;
    subscriber = null;
    active?.close();
    await subscriberLoop;
    subscriberLoop = null;
  };
  const snapshot = async () => (await call("session.snapshot", {})).snapshot;
  const waitForSnapshotContext = async (definition, expected) => {
    const started = performance.now();
    let attempts = 0;
    let context;
    while (performance.now() - started <= options.deadlineMs) {
      const authoritative = makeCache(await snapshot());
      attempts += 1;
      context = definition.scope === "tab"
        ? tabContext(authoritative, expected.tabId)
        : globalContext(authoritative);
      if (contextsEqual(context, expected)) {
        return { context, attempts, latencyMs: performance.now() - started };
      }
      await delay(50);
    }
    return { context, attempts, latencyMs: null };
  };
  const changeCwd = async (paneId, cwd) => {
    await call("pane.send_text", { pane_id: paneId, text: `cd -- ${shellQuote(cwd)}` });
    await call("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
  };

  try {
    await waitFor("isolated Herdr socket", () => fs.existsSync(socketPath), 10_000);
    const ping = await call("ping", {});
    assert.equal(ping.protocol, 20, `unexpected Herdr protocol ${ping.protocol}`);

    const initial = await call("workspace.create", {
      cwd: fixtureDirectories[0], label: "SideRail contract probe", focus: true,
    });
    const workspaceId = initial.workspace.workspace_id;
    const firstTabId = initial.tab.tab_id;
    const rootPaneId = initial.root_pane.pane_id;
    await delay(300);
    cache = makeCache(await snapshot());
    await startSubscriber();
    await waitForEventQuiet(events);

    const trials = [];
    let secondPaneId = "";
    let secondTabId = "";
    let secondTabRootId = "";
    let secondTabPaneId = "";
    let movedWorkspaceId = "";
    let movedTabId = "";
    const definitions = [
      {
        name: "foreground cwd changes on the selected pane",
        scope: "tab",
        action: async () => changeCwd(rootPaneId, fixtureDirectories[1]),
        expected: () => ({ workspaceId, tabId: firstTabId, paneId: rootPaneId, cwd: fixtureDirectories[1] }),
        actual: () => tabContext(cache, firstTabId),
      },
      {
        name: "split creation with focus selects its declared cwd",
        action: async () => {
          const result = await call("pane.split", {
            target_pane_id: rootPaneId, direction: "right", cwd: fixtureDirectories[2], focus: true,
          });
          secondPaneId = result.pane.pane_id;
        },
        expected: () => ({ workspaceId, tabId: firstTabId, paneId: secondPaneId, cwd: fixtureDirectories[2] }),
        actual: () => globalContext(cache),
      },
      {
        name: "pane focus left returns to the original pane",
        action: async () => call("pane.focus_direction", { pane_id: secondPaneId, direction: "left" }),
        expected: () => ({ workspaceId, tabId: firstTabId, paneId: rootPaneId, cwd: fixtureDirectories[1] }),
        actual: () => globalContext(cache),
      },
      {
        name: "pane focus right returns to the split pane",
        action: async () => call("pane.focus_direction", { pane_id: rootPaneId, direction: "right" }),
        expected: () => ({ workspaceId, tabId: firstTabId, paneId: secondPaneId, cwd: fixtureDirectories[2] }),
        actual: () => globalContext(cache),
      },
      {
        name: "foreground cwd changes after focus",
        scope: "tab",
        action: async () => changeCwd(secondPaneId, fixtureDirectories[3]),
        expected: () => ({ workspaceId, tabId: firstTabId, paneId: secondPaneId, cwd: fixtureDirectories[3] }),
        actual: () => tabContext(cache, firstTabId),
      },
      {
        name: "new focused tab selects its root cwd",
        action: async () => {
          const result = await call("tab.create", {
            workspace_id: workspaceId, cwd: fixtureDirectories[4], label: "contract second", focus: true,
          });
          secondTabId = result.tab.tab_id;
          secondTabRootId = result.root_pane.pane_id;
        },
        expected: () => ({ workspaceId, tabId: secondTabId, paneId: secondTabRootId, cwd: fixtureDirectories[4] }),
        actual: () => globalContext(cache),
      },
      {
        name: "focused pane in the second tab selects its cwd",
        action: async () => {
          const result = await call("pane.split", {
            target_pane_id: secondTabRootId, direction: "down", cwd: fixtureDirectories[5], focus: true,
          });
          secondTabPaneId = result.pane.pane_id;
        },
        expected: () => ({ workspaceId, tabId: secondTabId, paneId: secondTabPaneId, cwd: fixtureDirectories[5] }),
        actual: () => globalContext(cache),
      },
      {
        name: "tab focus restores the first tab's selected pane",
        action: async () => call("tab.focus", { tab_id: firstTabId }),
        expected: () => ({ workspaceId, tabId: firstTabId, paneId: secondPaneId, cwd: fixtureDirectories[3] }),
        actual: () => globalContext(cache),
      },
      {
        name: "same-workspace pane move updates membership and selection",
        action: async () => {
          const result = await call("pane.move", {
            pane_id: secondTabPaneId,
            destination: { type: "tab", tab_id: firstTabId, target_pane_id: rootPaneId, split: "down", ratio: 0.5 },
            focus: true,
          });
          secondTabPaneId = result.move_result.pane.pane_id;
        },
        expected: () => ({ workspaceId, tabId: firstTabId, paneId: secondTabPaneId, cwd: fixtureDirectories[5] }),
        actual: () => globalContext(cache),
      },
      {
        name: "cross-workspace pane move follows its reassigned public identity",
        action: async () => {
          const result = await call("pane.move", {
            pane_id: secondTabPaneId,
            destination: { type: "new_workspace", label: "contract moved", tab_label: "moved" },
            focus: true,
          });
          secondTabPaneId = result.move_result.pane.pane_id;
          movedWorkspaceId = result.move_result.pane.workspace_id;
          movedTabId = result.move_result.pane.tab_id;
        },
        expected: () => ({
          workspaceId: movedWorkspaceId,
          tabId: movedTabId,
          paneId: secondTabPaneId,
          cwd: fixtureDirectories[5],
        }),
        actual: () => globalContext(cache),
      },
    ];

    assert.equal(definitions.length, options.trials);
    for (const [index, definition] of definitions.entries()) {
      const eventStart = events.length;
      const actionStarted = performance.now();
      await definition.action();
      const expected = definition.expected();
      let eventResult;
      let eventError = "";
      try {
        eventResult = await waitFor(definition.name, () => {
          const actual = definition.actual();
          return contextsEqual(actual, expected) ? actual : null;
        }, options.deadlineMs);
      } catch (error) {
        eventError = error.message;
      }
      const authoritative = await waitForSnapshotContext(definition, expected);
      const authoritativeContext = authoritative.context;
      const authoritativeMatch = contextsEqual(authoritativeContext, expected);
      trials.push({
        number: index + 1,
        name: definition.name,
        passedByEvents: Boolean(eventResult),
        eventLatencyMs: eventResult ? Number((performance.now() - actionStarted).toFixed(3)) : null,
        waitLatencyMs: eventResult ? Number(eventResult.latencyMs.toFixed(3)) : null,
        expected,
        eventContext: definition.actual(),
        authoritativeContext,
        authoritativeMatch,
        authoritativeAttempts: authoritative.attempts,
        authoritativeLatencyMs: authoritative.latencyMs === null
          ? null
          : Number(authoritative.latencyMs.toFixed(3)),
        error: eventError || null,
        events: events.slice(eventStart).map((event) => event.event),
      });
    }

    // Prove the documented snapshot-then-subscribe sequence has a real gap: disconnect,
    // snapshot, mutate while no subscription exists, then subscribe. No replay token exists.
    await stopSubscriber();
    const staleBootstrap = await snapshot();
    const staleCache = makeCache(staleBootstrap);
    const movedPane = staleCache.panes.get(secondTabPaneId);
    assert.ok(movedPane, "moved pane missing before reconnect trial");
    await changeCwd(secondTabPaneId, fixtureDirectories[6]);
    await delay(300);
    cache = staleCache;
    const eventCountBeforeReconnect = events.length;
    await startSubscriber();
    await waitForEventQuiet(events);
    const liveAfterGap = makeCache(await snapshot());
    const gapContext = tabContext(cache, movedPane.tab_id);
    const liveGapContext = tabContext(liveAfterGap, movedPane.tab_id);
    const replayedRequiredEvent = events.slice(eventCountBeforeReconnect).some((event) => {
      const pane = event.data?.pane;
      return event.event === "pane_updated"
        && pane?.pane_id === secondTabPaneId
        && (pane.foreground_cwd || pane.cwd) === fixtureDirectories[6];
    });
    const gapObserved = !contextsEqual(gapContext, liveGapContext) && !replayedRequiredEvent;

    // Required reconnect recovery: take a new bootstrap snapshot after the new
    // subscription is acknowledged, then compare it with an independent snapshot.
    cache = makeCache(await snapshot());
    const reconnectBootstrapContext = tabContext(cache, movedPane.tab_id);
    const independentContext = tabContext(makeCache(await snapshot()), movedPane.tab_id);
    const reconnectSnapshotEqual = contextsEqual(reconnectBootstrapContext, independentContext);
    await stopSubscriber();

    let adapterVerification = null;
    let sharedVerification = null;
    if (options.verifyAdapter) {
      const adapterWorkspace = await call("workspace.create", {
        cwd: fixtureDirectories[0], label: "SideRail adapter probe", focus: true,
      });
      const adapterWorkspaceId = adapterWorkspace.workspace.workspace_id;
      const adapterTabId = adapterWorkspace.tab.tab_id;
      let adapterContentId = adapterWorkspace.root_pane.pane_id;
      const railResult = await call("pane.split", {
        target_pane_id: adapterContentId,
        direction: "right",
        cwd: repositoryRoot,
        focus: false,
      });
      let adapterRailId = railResult.pane.pane_id;
      const adapterRailTerminalId = railResult.pane.terminal_id;
      await call("pane.rename", { pane_id: adapterRailId, label: "SIDERAIL" });
      await delay(300);

      const candidateStage = options.candidateStage || "A";
      let adapterSource = await createProbeContextSource({
        stage: candidateStage,
        root,
        intervalMs: candidateStage === "B" ? 1_000 : 10_000,
        readSnapshot: snapshot,
      });
      const publications = [];
      const adapterSubscriptionStarted = performance.now();
      let adapterHandle = adapterSource.subscribe({
        railPaneId: adapterRailId,
        railTerminalId: adapterRailTerminalId,
        fallbackCwd: fixtureDirectories[0],
      }, (context, metadata) => publications.push({ context, reason: metadata.reason }));
      const adapterTrials = [];
      const record = (name, expected, beforeRequests, latencyMs = null) => {
        const context = adapterHandle.context;
        const passed = matchesExpected(context, expected)
          && (latencyMs === null || latencyMs <= options.deadlineMs);
        adapterTrials.push({
          number: adapterTrials.length + 1,
          name,
          passed,
          expected,
          context,
          snapshotRequests: adapterSource.metrics().snapshotRequests - beforeRequests,
          latencyMs,
          observation: options.candidateStage === "B" ? "automatic-shared-source" : "explicit-transitional-refresh",
        });
        return passed;
      };
      const refreshUntil = async (name, expected, action = async () => {}) => {
        const beforeRequests = adapterSource.metrics().snapshotRequests;
        await action();
        const started = performance.now();
        while (performance.now() - started <= options.deadlineMs) {
          // Phase B must converge from its normal shared timer, without the
          // probe accelerating discovery with manual refresh requests.
          if (options.candidateStage !== "B") await adapterSource.requestRefresh(`probe:${name}`);
          if (matchesExpected(adapterHandle.context, expected)) break;
          await delay(50);
        }
        record(name, expected, beforeRequests, Number((performance.now() - started).toFixed(3)));
      };

      await adapterHandle.ready;
      record("initial selected content", {
        workspaceId: adapterWorkspaceId,
        tabId: adapterTabId,
        sourcePaneId: adapterContentId,
        cwd: fixtureDirectories[0],
        hasContent: true,
        visible: true,
      }, 0, Number((performance.now() - adapterSubscriptionStarted).toFixed(3)));

      await refreshUntil("foreground cwd reconciliation", {
        sourcePaneId: adapterContentId, cwd: fixtureDirectories[1], hasContent: true, visible: true,
      }, () => changeCwd(adapterContentId, fixtureDirectories[1]));

      let focusedContentId = "";
      await refreshUntil("new focused content pane", {
        cwd: fixtureDirectories[2], hasContent: true, visible: true,
      }, async () => {
        const result = await call("pane.split", {
          target_pane_id: adapterContentId, direction: "down", cwd: fixtureDirectories[2], focus: true,
        });
        focusedContentId = result.pane.pane_id;
      });
      adapterTrials.at(-1).expected.sourcePaneId = focusedContentId;
      adapterTrials.at(-1).passed = adapterTrials.at(-1).passed && matchesExpected(adapterTrials.at(-1).context, adapterTrials.at(-1).expected);

      await refreshUntil("selected pane focus", {
        sourcePaneId: adapterContentId, cwd: fixtureDirectories[1], hasContent: true, visible: true,
      }, () => call("pane.focus_direction", { pane_id: focusedContentId, direction: "up" }));

      let adapterOtherTabId = "";
      let adapterOtherRootId = "";
      await refreshUntil("hidden tab context", {
        sourcePaneId: adapterContentId, cwd: fixtureDirectories[1], hasContent: true, visible: false,
      }, async () => {
        const result = await call("tab.create", {
          workspace_id: adapterWorkspaceId, cwd: fixtureDirectories[4], label: "adapter other", focus: true,
        });
        adapterOtherTabId = result.tab.tab_id;
        adapterOtherRootId = result.root_pane.pane_id;
      });

      await refreshUntil("visible tab context", {
        sourcePaneId: adapterContentId, cwd: fixtureDirectories[1], hasContent: true, visible: true,
      }, () => call("tab.focus", { tab_id: adapterTabId }));

      await refreshUntil("content pane moved away", {
        sourcePaneId: focusedContentId, cwd: fixtureDirectories[2], hasContent: true, visible: true,
      }, () => call("pane.move", {
        pane_id: adapterContentId,
        destination: { type: "tab", tab_id: adapterOtherTabId, target_pane_id: adapterOtherRootId, split: "right" },
        focus: false,
      }));

      await refreshUntil("content pane moved back", {
        sourcePaneId: adapterContentId, cwd: fixtureDirectories[1], hasContent: true, visible: true,
      }, async () => {
        const result = await call("pane.move", {
          pane_id: adapterContentId,
          destination: { type: "tab", tab_id: adapterTabId, target_pane_id: focusedContentId, split: "down" },
          focus: true,
        });
        adapterContentId = result.move_result.pane.pane_id;
      });
      adapterTrials.at(-1).expected.sourcePaneId = adapterContentId;
      adapterTrials.at(-1).passed = adapterTrials.at(-1).passed && matchesExpected(adapterTrials.at(-1).context, adapterTrials.at(-1).expected);

      let movedRailWorkspaceId = "";
      let movedRailTabId = "";
      await refreshUntil("rail move reaches no-content state", {
        hasContent: false, visible: true,
      }, async () => {
        const result = await call("pane.move", {
          pane_id: adapterRailId,
          destination: { type: "new_workspace", label: "adapter moved", tab_label: "rail" },
          focus: true,
        });
        adapterRailId = result.move_result.pane.pane_id;
        movedRailWorkspaceId = result.move_result.pane.workspace_id;
        movedRailTabId = result.move_result.pane.tab_id;
      });
      Object.assign(adapterTrials.at(-1).expected, {
        workspaceId: movedRailWorkspaceId,
        tabId: movedRailTabId,
        railPaneId: adapterRailId,
      });
      adapterTrials.at(-1).passed = adapterTrials.at(-1).passed && matchesExpected(adapterTrials.at(-1).context, adapterTrials.at(-1).expected);

      let returnedContentId = "";
      await refreshUntil("content resumes beside moved rail", {
        workspaceId: movedRailWorkspaceId,
        tabId: movedRailTabId,
        cwd: fixtureDirectories[3],
        hasContent: true,
        visible: true,
      }, async () => {
        const result = await call("pane.split", {
          target_pane_id: adapterRailId, direction: "right", cwd: fixtureDirectories[3], focus: true,
        });
        returnedContentId = result.pane.pane_id;
      });
      adapterTrials.at(-1).expected.sourcePaneId = returnedContentId;
      adapterTrials.at(-1).passed = adapterTrials.at(-1).passed && matchesExpected(adapterTrials.at(-1).context, adapterTrials.at(-1).expected);

      const publicationsBeforeUnchanged = publications.length;
      await adapterSource.requestRefresh("probe:unchanged");
      const unchangedSuppressed = publications.length === publicationsBeforeUnchanged;
      const beforeReconnect = adapterHandle.context;
      await adapterHandle.unsubscribe();
      await adapterSource.close();

      adapterSource = await createProbeContextSource({
        stage: candidateStage,
        root,
        intervalMs: candidateStage === "B" ? 1_000 : 10_000,
        readSnapshot: snapshot,
      });
      adapterHandle = adapterSource.subscribe({
        railPaneId: railResult.pane.pane_id,
        railTerminalId: adapterRailTerminalId,
        fallbackCwd: fixtureDirectories[0],
      }, () => {});
      const afterReconnect = await adapterHandle.ready;
      const adapterReconnectEqual = matchesExpected(afterReconnect, beforeReconnect);
      adapterVerification = {
        mode: adapterSource.metrics().mode,
        intervalMs: adapterSource.metrics().fallbackIntervalMs,
        trials: adapterTrials,
        allTrialsPassed: adapterTrials.length === 10 && adapterTrials.every((trial) => trial.passed),
        unchangedSuppressed,
        reconnectEqual: adapterReconnectEqual,
        reconnectContext: afterReconnect,
        publications: publications.length,
        candidateStage,
        hostRateDecision: candidateStage === "B"
          ? "one shared session.snapshot source per coordinator at a nominal one-second interval, independent of client count"
          : "one session.snapshot per rail per nominal ten-second interval; below the previous three-request baseline",
      };
      await adapterHandle.unsubscribe();
      await adapterSource.close();

      if (candidateStage === "B") {
        const measurements = await measureSharedHostClients({
          root,
          readSnapshot: snapshot,
          selector: {
            railPaneId: adapterRailId,
            railTerminalId: adapterRailTerminalId,
            fallbackCwd: fixtureDirectories[0],
          },
          counts: options.subscriberCounts,
        });
        sharedVerification = {
          transport: "length-prefixed Git state coordinator IPC",
          intervalMs: 1_000,
          measurements,
          oneSourcePerMeasurement: measurements.every((measurement) => measurement.sourceFactories === 1),
          clientCountIndependent: measurements.length > 0
            && measurements.every((measurement) => measurement.snapshotRequests === measurements[0].snapshotRequests),
          nominalOneHertz: measurements.every((measurement) => (
            measurement.periodicRequests >= 1
            && measurement.periodicRequestsPerSecond <= 1.1
          )),
        };
      }
    }

    const subscriberMeasurements = await measureSubscribers(socketPath, options.subscriberCounts);
    const pureEventPass = trials.every((trial) => trial.passedByEvents && trial.authoritativeMatch);
    const losslessHandshake = !gapObserved;
    const selectedBranch = pureEventPass && losslessHandshake
      ? "event-subscription"
      : "shared-topology-reconciliation-fallback";
    const branchReason = [
      ...(!pureEventPass ? ["one or more required semantic context trials did not converge from events alone"] : []),
      ...(!losslessHandshake ? ["session.snapshot followed by events.subscribe has an observable unsequenced gap"] : []),
    ];

    const nodeAvailability = Object.fromEntries([22, 24].map((major) => {
      const executable = `/opt/homebrew/opt/node@${major}/bin/node`;
      const result = spawnSync(executable, ["--version"], { encoding: "utf8" });
      return [String(major), { executable, available: result.status === 0, version: result.stdout.trim() || null }];
    }));

    report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      command: process.argv,
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        herdr: { version: ping.version, protocol: ping.protocol },
        nodeAvailability,
        linuxRuntimeAvailable: process.platform === "linux",
      },
      isolation: {
        inheritedHerdrEnvironmentRejected: true,
        namedSession: session,
        separateXdgRoots: true,
        livePluginLinked: false,
        liveConfigChanged: false,
      },
      transport: {
        kind: "documented newline-delimited JSON over a Unix domain socket",
        subscriptions: HERDR_CONTEXT_SUBSCRIPTIONS,
        bootstrap: "events.subscribe acknowledgement, then session.snapshot; resnapshot on reconnect",
        sequencing: "Herdr 0.8.2 exposes no event sequence or atomic snapshot/subscription cursor",
      },
      trials,
      eventCounts: Object.fromEntries(events.reduce((counts, event) => {
        counts.set(event.event, (counts.get(event.event) || 0) + 1);
        return counts;
      }, new Map())),
      ordering: {
        snapshotThenSubscribeGapObserved: gapObserved,
        replayedRequiredEvent,
        staleContext: gapContext,
        liveContext: liveGapContext,
        reconnectSnapshotEqual,
        reconnectBootstrapContext,
        independentContext,
      },
      requests: {
        direct: directRequests,
        directTotal: Object.values(directRequests).reduce((sum, value) => sum + value, 0),
        measurementSubscriptions: options.subscriberCounts.reduce((sum, value) => sum + value, 0),
      },
      subscriberMeasurements,
      decision: {
        pureEventPass,
        losslessHandshake,
        selectedBranch,
        reasons: branchReason,
        phaseA: selectedBranch === "event-subscription"
          ? "use the verified event source"
          : "retain at most the baseline three host requests per rail per nominal ten-second window and decouple unchanged context from Git refresh",
        phaseB: selectedBranch === "event-subscription"
          ? "one coordinator event source, with resnapshot on reconnect"
          : "one coordinator event source plus semantic topology reconciliation at most once per second; unchanged topology causes zero Git work",
      },
      adapterVerificationRequested: Boolean(options.verifyAdapter),
      adapterVerification,
      sharedVerification,
      teardown,
    };
  } catch (error) {
    report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      command: process.argv,
      fatal: { message: error.message, stack: error.stack },
      requests: { direct: directRequests },
      events,
      teardown,
      serverStderr,
    };
  } finally {
    try { await stopSubscriber(); } catch {}
    const stop = spawnSync(herdr, ["session", "stop", session, "--json"], {
      cwd: repositoryRoot, env: environment, encoding: "utf8", timeout: 10_000,
    });
    teardown.sessionStop = stop.status === 0;
    teardown.serverExitCode = await new Promise((resolve) => {
      if (server.exitCode !== null) return resolve(server.exitCode);
      const timer = setTimeout(() => resolve(null), 5_000);
      server.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    teardown.socketRemoved = !fs.existsSync(socketPath);
    fs.rmSync(root, { recursive: true, force: true });
    teardown.temporaryRootRemoved = !fs.existsSync(root);
    report.teardown = teardown;
    report.serverStderr = serverStderr || null;
    fs.mkdirSync(options.out, { recursive: true });
    fs.writeFileSync(path.join(options.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(options.out, "events.ndjson"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  }

  if (report.fatal) {
    process.stderr.write(`${report.fatal.message}\n`);
    process.exitCode = 1;
    return;
  }
  assert.equal(teardown.sessionStop, true, "isolated Herdr session did not stop cleanly");
  assert.equal(teardown.socketRemoved, true, "isolated Herdr socket remained after teardown");
  assert.equal(teardown.temporaryRootRemoved, true, "temporary fixture root remained after teardown");
  assert.equal(report.trials.every((trial) => trial.authoritativeMatch), true, "an authoritative context mutation failed");
  assert.equal(report.ordering.reconnectSnapshotEqual, true, "reconnect snapshot did not match an independent snapshot");
  if (options.verifyAdapter) {
    assert.equal(report.adapterVerification?.allTrialsPassed, true, "adapter context trial failed");
    assert.equal(report.adapterVerification?.unchangedSuppressed, true, "unchanged adapter context was republished");
    assert.equal(report.adapterVerification?.reconnectEqual, true, "adapter reconnect context mismatch");
  }
  if (options.candidateStage === "B") {
    assert.equal(report.sharedVerification?.oneSourcePerMeasurement, true, "shared context source was duplicated");
    assert.equal(report.sharedVerification?.clientCountIndependent, true, "shared snapshot rate changed with client count");
    assert.equal(report.sharedVerification?.nominalOneHertz, true, "shared topology reconciliation exceeded nominal 1 Hz");
  }
  process.stdout.write(`${JSON.stringify({
    artifact: path.join(options.out, "report.json"),
    trialsByEvents: `${report.trials.filter((trial) => trial.passedByEvents).length}/${report.trials.length}`,
    reconnectSnapshotEqual: report.ordering.reconnectSnapshotEqual,
    selectedBranch: report.decision.selectedBranch,
    adapterTrials: report.adapterVerification
      ? `${report.adapterVerification.trials.filter((trial) => trial.passed).length}/${report.adapterVerification.trials.length}`
      : null,
    sharedClients: report.sharedVerification?.measurements.map((measurement) => ({
      clients: measurement.clients,
      sourceFactories: measurement.sourceFactories,
      snapshotRequests: measurement.snapshotRequests,
      periodicRequestsPerSecond: measurement.periodicRequestsPerSecond,
    })) || null,
    directHostRequests: report.requests.directTotal,
    teardown,
  }, null, 2)}\n`);
}

await main();
