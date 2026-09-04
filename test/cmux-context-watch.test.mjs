import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { cmuxContextEventTargetsWindow, startCmuxContextWatcher } from "../src/cmux-context-watch.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => { child.killedWith = signal; return true; };
  return child;
}

test("cmux context events are scoped to the Dock owner window", () => {
  assert.equal(cmuxContextEventTargetsWindow({ type: "ack" }, "window-1"), false);
  assert.equal(cmuxContextEventTargetsWindow({ type: "event", name: "workspace.selected", window_id: "window-1" }, "window-1"), true);
  assert.equal(cmuxContextEventTargetsWindow({ type: "event", name: "surface.focused", payload: { window_id: "window-1" } }, "window-1"), true);
  assert.equal(cmuxContextEventTargetsWindow({ type: "event", name: "workspace.selected", window_id: "window-2" }, "window-1"), false);
  assert.equal(cmuxContextEventTargetsWindow({ type: "event", name: "notification.created", window_id: "window-1" }, "window-1"), false);
});

test("cmux context watcher decodes chunked events and closes its child", () => {
  const child = fakeChild();
  const calls = [];
  const changes = [];
  const errors = [];
  const watcher = startCmuxContextWatcher({
    cmux: "/bundle/cmux",
    environment: { TEST_ENV: "yes" },
    windowId: "window-1",
    onChange: (event) => changes.push(event.name),
    onError: (error) => errors.push(error.message),
    spawnProcess: (command, args, options) => { calls.push({ command, args, options }); return child; },
  });
  child.stdout.write('{"type":"ack"}\n{"type":"event","name":"workspace.');
  child.stdout.write('selected","window_id":"window-1"}\n');
  child.stdout.write('{bad json}\n');
  child.stdout.write('{"type":"event","name":"surface.selected","window_id":"window-2"}\n');
  child.stderr.write("stream warning\n");
  child.emit("close", 1, null);

  assert.deepEqual(changes, ["workspace.selected"]);
  assert.equal(errors.length, 3);
  assert.match(errors[1], /stream warning/);
  assert.match(errors[2], /event stream exited/);
  assert.deepEqual(calls[0].args, [
    "events",
    "--name", "workspace.selected",
    "--name", "surface.selected",
    "--name", "surface.focused",
    "--name", "pane.focused",
    "--reconnect",
    "--no-heartbeat",
  ]);
  assert.equal(calls[0].options.env.TEST_ENV, "yes");
  watcher.close();
  assert.equal(child.killedWith, "SIGTERM");
});

test("cmux context watcher tolerates an unavailable stream without an error observer", () => {
  const child = fakeChild();
  const watcher = startCmuxContextWatcher({
    cmux: "/bundle/cmux",
    onChange: () => {},
    spawnProcess: () => child,
  });
  child.emit("error", new Error("socket unavailable"));
  watcher.close();
  assert.equal(child.killedWith, "SIGTERM");
});

test("an unscoped watcher accepts every window while events without a window are never dropped", () => {
  const scoped = { type: "event", name: "pane.focused", window_id: "window-2" };
  assert.equal(cmuxContextEventTargetsWindow(scoped, ""), true);
  assert.equal(cmuxContextEventTargetsWindow({ type: "event", name: "pane.focused" }, "window-1"), true);
  assert.equal(cmuxContextEventTargetsWindow({ type: "event", name: "pane.focused", window_id: "" }, "window-1"), true);
  assert.equal(cmuxContextEventTargetsWindow(null, "window-1"), false);
  assert.equal(cmuxContextEventTargetsWindow({ name: "pane.focused", window_id: "window-1" }, "window-1"), false);
});

test("an event payload window overrides nothing when the frame already names another window", () => {
  assert.equal(cmuxContextEventTargetsWindow({
    type: "event", name: "workspace.selected", window_id: "window-2", payload: { window_id: "window-1" },
  }, "window-1"), false);
});

test("closing a cmux context watcher twice kills its child exactly once", () => {
  const child = fakeChild();
  let kills = 0;
  child.kill = () => { kills += 1; return true; };
  const watcher = startCmuxContextWatcher({ cmux: "cmux-test", onChange: () => {}, spawnProcess: () => child });
  watcher.close();
  watcher.close();
  assert.equal(kills, 1);
  child.emit("close", 1, null);
});

test("a clean cmux event stream exit is not reported as a failure", () => {
  const child = fakeChild();
  const errors = [];
  startCmuxContextWatcher({
    cmux: "cmux-test",
    onChange: () => {},
    onError: (error) => errors.push(error.message),
    spawnProcess: () => child,
  });
  child.emit("close", 0, null);
  assert.deepEqual(errors, []);
});
