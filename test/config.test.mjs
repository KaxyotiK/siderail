import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, validateConfig } from "../src/config.mjs";

test("configuration validates version, launch mode, and refresh bounds", () => {
  assert.deepEqual(validateConfig({ version: 1, editor: { client: "nvim", args: [], mode: "terminal" }, refresh: { pollIntervalMs: 5000 } }), []);
  assert.ok(validateConfig({ version: 2, editor: { client: "" }, refresh: { pollIntervalMs: 2 } }).length >= 3);
});

test("repository config merges by key and environment wins", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, ".git-rail.json"), JSON.stringify({ version: 1, editor: { client: "hx", mode: "terminal" }, refresh: { pollIntervalMs: 7000 } }));
  const { config, errors } = loadConfig(root, { GIT_RAIL_BASE: "upstream/trunk", GIT_RAIL_CLIENT: "nvim" });
  assert.deepEqual(errors, []);
  assert.equal(config.baseRef, "upstream/trunk");
  assert.equal(config.editor.client, "nvim");
  assert.equal(config.editor.mode, "terminal");
  assert.equal(config.refresh.pollIntervalMs, 7000);
});
