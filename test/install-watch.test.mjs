import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RESTART_EXIT_CODE, watchInstallReplacement } from "../src/install-watch.mjs";

function manualTimer() {
  const timer = { cleared: false, unrefCalled: false, unref() { this.unrefCalled = true; } };
  return {
    timer,
    setTimer: (callback, intervalMs) => Object.assign(timer, { callback, intervalMs }),
    clearTimer: (value) => { value.cleared = true; },
  };
}

test("an install swap at the same path is reported once, after its entrypoint exists", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "siderail-install-watch-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, "siderail");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "siderail.mjs"), "");
  const { timer, setTimer, clearTimer } = manualTimer();
  let replaced = 0;
  const watcher = watchInstallReplacement({ root, onReplaced: () => { replaced += 1; }, setTimer, clearTimer });
  assert.equal(timer.intervalMs, 2_000);
  assert.equal(timer.unrefCalled, true);

  assert.equal(watcher.check(), false, "an unchanged install is not a swap");
  fs.renameSync(root, path.join(parent, ".siderail-old"));
  assert.equal(watcher.check(), false, "a missing root is an upgrade in progress");
  fs.mkdirSync(root);
  assert.equal(watcher.check(), false, "a new root without its entrypoint is still being extracted");
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "scripts", "siderail.mjs"), "");
  assert.equal(watcher.check(), true);
  assert.equal(replaced, 1);
  assert.equal(timer.cleared, true);
  watcher.close();
  assert.equal(RESTART_EXIT_CODE, 75);
});

test("files changing inside a stable checkout never trigger a restart", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "siderail-install-watch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "scripts", "siderail.mjs"), "v1");
  const { setTimer, clearTimer } = manualTimer();
  const watcher = watchInstallReplacement({ root, onReplaced: () => assert.fail("restarted"), setTimer, clearTimer });
  fs.writeFileSync(path.join(root, "scripts", "siderail.mjs"), "v2");
  assert.equal(watcher.check(), false);
  watcher.close();
});

test("the default timer is real and unreferenced", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "siderail-install-watch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const watcher = watchInstallReplacement({ root, onReplaced: () => {} });
  watcher.close();
  watcher.close();
});
