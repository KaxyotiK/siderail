import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  commitComparisonSource,
  previewInitialMode,
  previewTabName,
  sanitizeTerminalText,
  startupFailureState,
} from "../src/terminal-ui.mjs";
import { runGit } from "../src/process.mjs";

const exec = promisify(execFile);

test("terminal text blocks OSC52 and every terminal control family", () => {
  const malicious = [
    "safe",
    "\u001b]52;c;c2VjcmV0\u0007",
    "\u001bPdevice-control\u001b\\",
    "\u001b^privacy\u001b\\",
    "\u001b_apc\u001b\\",
    "\u0098sos\u009c",
    "\u001b[31mred",
    "\u0000\u001f\u007f\u0085",
    "\u202econcealed",
  ].join("");
  const clean = sanitizeTerminalText(malicious);
  assert.doesNotMatch(clean, /(?:secret|device-control|privacy|apc|sos|\u001b|\u202e|[\u0000-\u001f\u007f-\u009f])/);
  assert.match(clean, /^safe/);
});

test("clean Files metadata opens Raw even with a workspace descriptor", () => {
  assert.equal(previewInitialMode({ kind: "workspace", baseRef: "origin/main" }, { status: "clean" }), "raw");
  assert.equal(previewInitialMode({ kind: "workspace", baseRef: "origin/main" }, { status: "modified" }), "diff");
});

test("commit preview context distinguishes first-parent and root comparisons", () => {
  assert.equal(commitComparisonSource({ comparison: "first-parent", parentHash: "parent" }), "first parent");
  assert.equal(commitComparisonSource({ comparison: "first-parent", parentHash: "" }), "empty tree");
});

test("preview tab names use a safe capped basename", () => {
  assert.equal(previewTabName("src/file-preview.mjs"), "file-preview.mjs");
  assert.equal(previewTabName("src/\u001b]52;c;c3RlYWw=\u0007report.md"), "�report.md");
  const wide = previewTabName(`src/${"界".repeat(20)}.md`);
  assert.equal(wide, `${"界".repeat(15)}…`);
  assert.ok([...wide].length <= 32);
});

test("startup provider failures become an actionable render state", () => {
  const state = startupFailureState("/repo\u001b]0;owned\u0007", new Error("git unavailable\u001b]52;c;c3RlYWw=\u0007"));
  assert.equal(state.repoRoot, "");
  assert.match(state.error, /Could not load Git state: git unavailable/);
  assert.equal(state.config.refresh.pollIntervalMs, 5000);
  assert.equal(sanitizeTerminalText(state.error), "Could not load Git state: git unavailable�");
});

test("sidebar snapshots cannot emit OSC52 from repository and filename data", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rail-\u001b]52;c;repo-secret\u0007-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "\u001b]52;c;file-secret\u0007.txt"), "safe\n");
  const script = path.resolve("scripts/git-rail.mjs");
  const { stdout } = await exec(process.execPath, [script, "--snapshot", "--width", "52", "--height", "28"], { cwd: root });
  assert.doesNotMatch(stdout, /\u001b\]|(?:repo|file)-secret/);
  assert.match(stdout, /�\.txt/);
});
