import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readProcessStartIdentity, resolveGitStateRuntime, runGitStateCoordinator } from "../src/git-state-runtime.mjs";

test("runtime namespace follows immutable env overrides while config-file edits stay in one namespace", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configRoot = path.join(root, "config");
  const configDirectory = path.join(configRoot, "git-rail");
  const hostSocketPath = path.join(root, "herdr.sock");
  await fs.mkdir(configDirectory, { recursive: true });
  await fs.writeFile(hostSocketPath, "fixture");
  const environment = {
    ...process.env,
    XDG_CONFIG_HOME: configRoot,
    XDG_RUNTIME_DIR: root,
    HERDR_SOCKET_PATH: hostSocketPath,
  };
  const writeConfig = (pollIntervalMs) => fs.writeFile(path.join(configDirectory, "config.json"), JSON.stringify({
    version: 1,
    refresh: { pollIntervalMs, reconcileIntervalMs: 300_000 },
  }));
  await writeConfig(10_000);
  const first = await resolveGitStateRuntime({ environment });
  await writeConfig(20_000);
  const changedFile = await resolveGitStateRuntime({ environment });
  const changedEnvironment = await resolveGitStateRuntime({
    environment: { ...environment, GIT_RAIL_POLL_INTERVAL_MS: "20000" },
  });
  assert.equal(first.identity.namespaceId, changedFile.identity.namespaceId);
  assert.notEqual(first.schedulerConfig.pollIntervalMs, changedFile.schedulerConfig.pollIntervalMs);
  assert.notEqual(first.identity.namespaceId, changedEnvironment.identity.namespaceId);
  assert.ok(first.runtimeFiles.includes("src/git-state-runtime.mjs"));
  assert.ok(first.runtimeFiles.includes("scripts/git-state-coordinator.mjs"));
  assert.equal(first.runtimeFiles.some((file) => file.startsWith("test/") || file.startsWith("docs/")), false);
});

test("process start identity uses an absolute system command independent of PATH", async () => {
  let command;
  const identity = await readProcessStartIdentity(process.pid, {
    run: async (selected, args, options) => {
      command = { selected, args, options };
      return { stdout: "Mon Jan  2 03:04:05 2023\n" };
    },
  });
  assert.equal(identity, "Mon Jan 2 03:04:05 2023");
  assert.equal(command.selected, "/bin/ps");
  assert.deepEqual(command.options.env, { LC_ALL: "C", LANG: "C" });
});

test("runtime rejects mismatched identity and lost launch leases before binding", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-runtime-guard-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = { socketPath: path.join(root, "state.sock"), leasePath: path.join(root, "owner.json") };
  const resolved = {
    identity: { namespaceId: "expected" },
    paths,
    providerConfig: {},
    schedulerConfig: {},
  };
  await assert.rejects(runGitStateCoordinator({
    expectedNamespaceId: "different",
    expectedSocketPath: paths.socketPath,
    expectedLeasePath: paths.leasePath,
    nonce: "nonce",
    resolveRuntime: async () => resolved,
  }), { code: "GIT_STATE_NAMESPACE_MISMATCH" });
  await assert.rejects(runGitStateCoordinator({
    expectedNamespaceId: "expected",
    expectedSocketPath: paths.socketPath,
    expectedLeasePath: paths.leasePath,
    nonce: "nonce",
    resolveRuntime: async () => resolved,
  }), { code: "GIT_STATE_LEASE_LOST" });
});

test("runtime owns signal, coordinator, socket, owner, and lease cleanup", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-runtime-owner-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = { socketPath: path.join(root, "state.sock"), leasePath: path.join(root, "owner.json") };
  const nonce = "owner-nonce";
  await fs.writeFile(paths.leasePath, JSON.stringify({ nonce, namespaceId: "owned" }), { mode: 0o600 });
  const fakeProcess = new EventEmitter();
  fakeProcess.pid = process.pid;
  let listened;
  let closes = 0;
  let options;
  const coordinator = {
    status: { sessions: 0, engines: 0, hostSubscribers: 0 },
    async listen(value) { listened = value; await fs.writeFile(value, "socket"); },
    async close() { closes += 1; },
  };
  const runtime = await runGitStateCoordinator({
    expectedNamespaceId: "owned",
    expectedSocketPath: paths.socketPath,
    expectedLeasePath: paths.leasePath,
    nonce,
    processObject: fakeProcess,
    resolveRuntime: async () => ({
      identity: { namespaceId: "owned" },
      paths,
      providerConfig: { baseRef: "" },
      schedulerConfig: { pollIntervalMs: 10_000 },
    }),
    coordinatorFactory: (received) => { options = received; return coordinator; },
  });
  assert.equal(listened, paths.socketPath);
  assert.equal(options.namespaceId, "owned");
  assert.equal(fakeProcess.listenerCount("SIGTERM"), 1);
  assert.ok(JSON.parse(await fs.readFile(runtime.ownerPath, "utf8")).processStartIdentity);
  fakeProcess.emit("SIGTERM");
  await runtime.done;
  assert.equal(closes, 1);
  assert.equal(fakeProcess.listenerCount("SIGTERM"), 0);
  await assert.rejects(fs.access(paths.socketPath));
  await assert.rejects(fs.access(paths.leasePath));
  await assert.rejects(fs.access(runtime.ownerPath));
  await runtime.stop();
  assert.equal(closes, 1);
});

test("process identity rejects unsupported and empty results", async () => {
  await assert.rejects(readProcessStartIdentity(1, { platform: "win32" }), {
    code: "GIT_STATE_PROCESS_IDENTITY_UNAVAILABLE",
  });
  await assert.rejects(readProcessStartIdentity(1, {
    run: async () => ({ stdout: "" }),
  }), { code: "GIT_STATE_PROCESS_IDENTITY_UNAVAILABLE" });
  await assert.rejects(readProcessStartIdentity(0), /positive integer/);
});

test("idle shutdown rechecks new clients, and listen failures release owned resources", async (t) => {
  for (const failListen of [false, true]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gr-runtime-idle-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const paths = { socketPath: path.join(root, "state.sock"), leasePath: path.join(root, "owner.json") };
    await fs.writeFile(paths.leasePath, JSON.stringify({ nonce: "test", namespaceId: "owned" }));
    const fakeProcess = new EventEmitter(); fakeProcess.pid = process.pid;
    let options; let tick; let closes = 0;
    const coordinator = { status: { sessions: 0, engines: 0, hostSubscribers: 0 },
      async listen() { if (failListen) throw new Error("fixture bind failure"); },
      async close() { closes += 1; },
    };
    const starting = runGitStateCoordinator({ expectedNamespaceId: "owned", expectedSocketPath: paths.socketPath,
      expectedLeasePath: paths.leasePath, nonce: "test", processObject: fakeProcess,
      resolveRuntime: async () => ({ identity: { namespaceId: "owned" }, paths, providerConfig: {}, schedulerConfig: {} }),
      coordinatorFactory(value) { options = value; return coordinator; },
      setTimer(callback) { tick = callback; return 1; }, clearTimer() {},
    });
    if (failListen) {
      await assert.rejects(starting, /fixture bind failure/);
    } else {
      const running = await starting;
      const host = options.hostSourceFactory(); host.close();
      options.onIdle();
      coordinator.status.sessions = 1; tick(); assert.equal(closes, 0);
      coordinator.status.sessions = 0; options.onIdle(); tick();
      await running.done;
    }
    assert.equal(closes, 1);
    assert.equal(fakeProcess.listenerCount("SIGTERM"), 0);
    await assert.rejects(fs.access(paths.leasePath), { code: "ENOENT" });
  }
});

test("shutdown errors reject completion and a changed lease is never removed", async (t) => {
  for (const failClose of [false, true]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gr-runtime-stop-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const paths = { socketPath: path.join(root, "state.sock"), leasePath: path.join(root, "owner.json") };
    await fs.writeFile(paths.leasePath, JSON.stringify({ nonce: "test", namespaceId: "owned" }));
    const fakeProcess = new EventEmitter(); fakeProcess.pid = process.pid;
    const running = await runGitStateCoordinator({ expectedNamespaceId: "owned", expectedSocketPath: paths.socketPath,
      expectedLeasePath: paths.leasePath, nonce: "test", processObject: fakeProcess,
      resolveRuntime: async () => ({ identity: { namespaceId: "owned" }, paths }),
      coordinatorFactory: () => ({ listen: async () => {}, close: async () => { if (failClose) throw new Error("fixture close failure"); } }),
    });
    await fs.writeFile(paths.leasePath, JSON.stringify({ nonce: "replacement", namespaceId: "owned" }));
    await fs.writeFile(paths.socketPath, "replacement socket");
    if (failClose) await assert.rejects(running.stop(), /fixture close failure/);
    else await running.stop();
    assert.equal(JSON.parse(await fs.readFile(paths.leasePath, "utf8")).nonce, "replacement");
    assert.equal(await fs.readFile(paths.socketPath, "utf8"), "replacement socket");
  }
  await assert.rejects(runGitStateCoordinator(), /requires expected/);
  await assert.rejects(resolveGitStateRuntime({ environment: {} }), { code: "GIT_STATE_HOST_SOCKET_UNAVAILABLE" });
});

test("cwd-dependent executable and config environments explicitly remain in process", async () => {
  for (const override of [{ PATH: "bin:/usr/bin" }, { PATH: ":/usr/bin" }, { HOME: "home" },
    { GIT_DIR: ".git" }, { GIT_WORK_TREE: "." }, { GIT_CONFIG_GLOBAL: "config" },
    { GIT_ALTERNATE_OBJECT_DIRECTORIES: "/objects:relative" }]) {
    await assert.rejects(resolveGitStateRuntime({ environment: {
      PATH: "/usr/bin:/bin", HERDR_SOCKET_PATH: "/fixture/socket", ...override,
    } }), { code: "UNSUPPORTED_ENVIRONMENT" });
  }
});
