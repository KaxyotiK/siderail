import assert from "node:assert/strict";
import test from "node:test";
import { closeVerifiedPluginPane } from "../src/herdr-plugin-pane.mjs";

test("verified orphan plugin panes fall back to generic close only for plugin_pane_not_found", async () => {
  const calls = [];
  const result = await closeVerifiedPluginPane({
    herdr: "herdr-test",
    paneId: "orphan-pane",
    run: async (_command, args) => {
      calls.push(args);
      if (args[0] === "plugin") {
        const error = new Error('{"error":{"code":"plugin_pane_not_found","message":"plugin pane not found"}}');
        error.stderr = error.message;
        throw error;
      }
      return { stdout: "{}" };
    },
  });
  assert.deepEqual(result, { fallback: true });
  assert.deepEqual(calls, [
    ["plugin", "pane", "close", "orphan-pane"],
    ["pane", "close", "orphan-pane"],
  ]);
});

test("other plugin close failures never broaden into generic pane closure", async () => {
  const calls = [];
  await assert.rejects(closeVerifiedPluginPane({
    herdr: "herdr-test",
    paneId: "owned-pane",
    run: async (_command, args) => {
      calls.push(args);
      throw new Error("close timed out");
    },
  }), /close timed out/);
  assert.deepEqual(calls, [["plugin", "pane", "close", "owned-pane"]]);
});
