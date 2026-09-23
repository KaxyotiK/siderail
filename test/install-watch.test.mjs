import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  INSTALL_ROOT,
  RESTART_EXIT_CODE,
  launchEntrypoints,
  launchInstallContext,
  watchInstallReplacement,
} from "../src/install-watch.mjs";

function manualTimer() {
  const timer = { cleared: false, unrefCalled: false, unref() { this.unrefCalled = true; } };
  return {
    timer,
    setTimer: (callback, intervalMs) => Object.assign(timer, { callback, intervalMs }),
    clearTimer: (value) => { value.cleared = true; },
  };
}

function write(root, relative, contents = "x") {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), contents);
}

function completeInstall(root, { cmux = true } = {}) {
  write(root, "package.json", "{\"name\":\"siderail\"}");
  write(root, "src/model.mjs");
  write(root, "src/install-watch.mjs");
  write(root, "scripts/siderail.mjs");
  if (cmux) write(root, "scripts/cmux-siderail.mjs");
}

function installParent(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "siderail-install-watch-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, "siderail");
  completeInstall(root);
  return { parent, root };
}

test("a swapped install is reported only after its tree settles across two ticks", (t) => {
  const { parent, root } = installParent(t);
  const { timer, setTimer, clearTimer } = manualTimer();
  let replaced = 0;
  const watcher = watchInstallReplacement({ root, onReplaced: () => { replaced += 1; }, setTimer, clearTimer });
  assert.equal(timer.intervalMs, 2_000);
  assert.equal(timer.unrefCalled, true);

  assert.equal(watcher.check(), false, "an unchanged install is not a swap");
  fs.renameSync(root, path.join(parent, ".siderail-old"));
  assert.equal(watcher.check(), false, "a missing root is an upgrade in progress");
  fs.mkdirSync(root);
  write(root, "scripts/siderail.mjs");
  assert.equal(watcher.check(), false, "an entrypoint without package.json or src is not ready");
  write(root, "package.json", "{\"name\":");
  write(root, "src/model.mjs");
  assert.equal(watcher.check(), false, "a partially written package.json is not ready");
  assert.equal(watcher.check(), false);
  write(root, "package.json", "{\"name\":\"siderail\"}");
  assert.equal(watcher.check(), false, "the first complete observation only records a signature");
  write(root, "src/install-watch.mjs");
  assert.equal(watcher.check(), false, "a tree that is still gaining files has not settled");
  assert.equal(watcher.check(), true, "two identical observations settle");
  assert.equal(replaced, 1);
  assert.equal(timer.cleared, true);
  watcher.close();
  assert.equal(RESTART_EXIT_CODE, 75);
});

test("the cmux launch waits for its own bootstrap, not only the rail it imports", (t) => {
  const { parent, root } = installParent(t);
  const { setTimer, clearTimer } = manualTimer();
  let replaced = false;
  const watcher = watchInstallReplacement({
    root,
    entrypoints: ["scripts/cmux-siderail.mjs", "scripts/siderail.mjs"],
    onReplaced: () => { replaced = true; },
    setTimer,
    clearTimer,
  });
  fs.renameSync(root, path.join(parent, ".siderail-old"));
  completeInstall(root, { cmux: false });
  for (let tick = 0; tick < 4; tick += 1) assert.equal(watcher.check(), false);
  assert.equal(replaced, false);
  write(root, "scripts/cmux-siderail.mjs");
  assert.equal(watcher.check(), false);
  assert.equal(watcher.check(), true);
  assert.equal(replaced, true);
});

test("an empty source tree or a directory in place of an entrypoint is not ready", (t) => {
  const { parent, root } = installParent(t);
  const { setTimer, clearTimer } = manualTimer();
  const watcher = watchInstallReplacement({ root, onReplaced: () => assert.fail("restarted"), setTimer, clearTimer });
  fs.renameSync(root, path.join(parent, ".siderail-old"));
  write(root, "package.json", "{}");
  write(root, "scripts/siderail.mjs");
  fs.mkdirSync(path.join(root, "src"));
  for (let tick = 0; tick < 3; tick += 1) assert.equal(watcher.check(), false);
  fs.rmSync(path.join(root, "scripts", "siderail.mjs"));
  fs.mkdirSync(path.join(root, "scripts", "siderail.mjs"));
  write(root, "src/model.mjs");
  for (let tick = 0; tick < 3; tick += 1) assert.equal(watcher.check(), false);
  watcher.close();
});

test("files changing inside a stable checkout never trigger a restart", (t) => {
  const { root } = installParent(t);
  const { setTimer, clearTimer } = manualTimer();
  const watcher = watchInstallReplacement({ root, onReplaced: () => assert.fail("restarted"), setTimer, clearTimer });
  write(root, "scripts/siderail.mjs", "v2");
  assert.equal(watcher.check(), false);
  assert.equal(watcher.check(), false);
  watcher.close();
});

test("a rail whose launcher died is reported orphaned instead of lingering", (t) => {
  const { root } = installParent(t);
  const { timer, setTimer, clearTimer } = manualTimer();
  let parent = 4242;
  let orphaned = 0;
  const watcher = watchInstallReplacement({
    root,
    parentPid: 4242,
    readParentPid: () => parent,
    onReplaced: () => assert.fail("restarted"),
    onOrphaned: () => { orphaned += 1; },
    setTimer,
    clearTimer,
  });
  assert.equal(watcher.check(), false);
  parent = 1;
  assert.equal(watcher.check(), "orphaned");
  assert.equal(orphaned, 1);
  assert.equal(timer.cleared, true);
});

test("an explicit launch identity is the baseline, so an early swap is still detected", (t) => {
  const { root } = installParent(t);
  const { setTimer, clearTimer } = manualTimer();
  let replaced = false;
  const watcher = watchInstallReplacement({
    root,
    original: "0:0",
    onReplaced: () => { replaced = true; },
    setTimer,
    clearTimer,
  });
  assert.equal(watcher.check(), false);
  assert.equal(watcher.check(), true);
  assert.equal(replaced, true);
});

test("launch entrypoints include the launched script inside the install and always the rail", () => {
  assert.deepEqual(
    launchEntrypoints("/pkg", ["node", "scripts/cmux-siderail.mjs"], "/pkg"),
    ["scripts/cmux-siderail.mjs", "scripts/siderail.mjs"],
  );
  assert.deepEqual(launchEntrypoints("/pkg", ["node", "/pkg/scripts/siderail.mjs"], "/elsewhere"), ["scripts/siderail.mjs"]);
  assert.deepEqual(launchEntrypoints("/pkg", ["node", "/other/tool.mjs"], "/"), ["scripts/siderail.mjs"]);
  assert.deepEqual(launchEntrypoints("/pkg", ["node"], "/"), ["scripts/siderail.mjs"]);
  assert.deepEqual(launchEntrypoints("/pkg", ["node", "/pkg/README.md"], "/"), ["scripts/siderail.mjs"]);
});

test("the launch context is captured from this package when the module loads", () => {
  assert.equal(INSTALL_ROOT, path.resolve(import.meta.dirname, ".."));
  const stat = fs.statSync(INSTALL_ROOT);
  const context = launchInstallContext();
  assert.equal(context.installIdentity, `${stat.dev}:${stat.ino}`);
  assert.equal(context.parentPid, process.ppid);
  assert.ok(context.entrypoints.includes("scripts/siderail.mjs"));
  context.entrypoints.push("mutated");
  assert.equal(launchInstallContext().entrypoints.includes("mutated"), false);
});

test("the default timer is real and unreferenced", (t) => {
  const { root } = installParent(t);
  const watcher = watchInstallReplacement({ root, onReplaced: () => {} });
  watcher.close();
  watcher.close();
});
