import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  compactTerminalPath,
  commitExpansionState,
  commitComparisonSource,
  createLatestSerialQueue,
  createTerminalInputDecoder,
  fitAnsiTerminalColumns,
  padAnsiTerminalColumns,
  previewInitialMode,
  previewTabName,
  revealScrollOffset,
  sanitizeTerminalText,
  sliceAnsiTerminalColumns,
  startupFailureState,
  stripSgrMouseEvents,
  terminalColumns,
  truncateTerminalColumns,
  validPollInterval,
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

test("terminal layout helpers measure, truncate, pad, and compact by display columns", () => {
  assert.equal(terminalColumns("A界e\u0301👩‍💻"), 6);
  assert.equal(terminalColumns("🇺🇸1️⃣"), 4);
  assert.equal(terminalColumns("\u001b[31m界界\u001b[0m"), 4);
  assert.equal(truncateTerminalColumns("界界界", 5), "界界…");
  assert.equal(terminalColumns(fitAnsiTerminalColumns("\u001b[31m界界界\u001b[0m", 5)), 5);
  assert.match(fitAnsiTerminalColumns("\u001b[31m界界界\u001b[0m", 5), /\u001b\[0m$/);
  assert.equal(terminalColumns(padAnsiTerminalColumns("界", 5)), 5);
  const compact = compactTerminalPath("非常に長い/深い/報告書.md", 12);
  assert.ok(terminalColumns(compact) <= 12);
  assert.match(compact, /^…\//);
  assert.equal(compactTerminalPath("long/path", 1), "…");
  assert.equal(sliceAnsiTerminalColumns("\u001b[31m0123456789\u001b[0m", 4, 3), "\u001b[31m456\u001b[0m");
  assert.equal(terminalColumns(sliceAnsiTerminalColumns("A界BC", 1, 3)), 3);
});

test("terminal input decoder preserves ordered coalesced keyboard, CSI, and mouse events", async () => {
  const events = [];
  const decoder = createTerminalInputDecoder((event) => events.push(event), 5);
  decoder.push("/return\r\u001b[B\u001b[<0;12;4Mj");
  assert.deepEqual(events, ["/", "r", "e", "t", "u", "r", "n", "\r", "\u001b[B", "\u001b[<0;12;4M", "j"]);
  decoder.push("\u001b");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(events.at(-1), "\u001b");
});

test("summary-only commit matches can expand to meaningful file content", () => {
  assert.deepEqual(commitExpansionState("release", [], false, false), {
    open: false,
    showAllFiles: false,
    loading: false,
  });
  assert.deepEqual(commitExpansionState("release", [], true, false), {
    open: true,
    showAllFiles: true,
    loading: true,
  });
  assert.deepEqual(commitExpansionState("release", [], true, true), {
    open: true,
    showAllFiles: true,
    loading: false,
  });
});

test("poll timers reject corrupted intervals independently of configuration", () => {
  assert.equal(validPollInterval(5000), 5000);
  assert.equal(validPollInterval(NaN), 10_000);
  assert.equal(validPollInterval(0, 7000), 7000);
});

test("SGR mouse reports can be removed without leaking bytes into search text", () => {
  assert.equal(stripSgrMouseEvents("read\u001b[<0;12;4M\u001b[<0;12;4mme"), "readme");
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

test("startup recovery installs invalidation only after a repository appears", async () => {
  const rail = await fs.readFile("scripts/git-rail.mjs", "utf8");
  assert.match(rail, /state\.repoRoot && state\.repoRoot !== invalidationRepoRoot\) startInvalidation\(\)/);
  assert.match(rail, /if \(invalidationRepoRoot === state\.repoRoot\) return;/);
  assert.match(rail, /validPollInterval\(state\.config\?\.refresh\?\.pollIntervalMs\)/);
});

test("preview requests serialize and skip superseded queued selections", async () => {
  let releaseFirst;
  const barrier = new Promise((resolve) => { releaseFirst = resolve; });
  const started = [];
  let active = 0;
  let maximumActive = 0;
  const enqueue = createLatestSerialQueue(async (value) => {
    started.push(value);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (value === "first") await barrier;
    active -= 1;
  });
  const first = enqueue("first");
  await new Promise((resolve) => setImmediate(resolve));
  const skipped = enqueue("skipped");
  const latest = enqueue("latest");
  releaseFirst();
  await Promise.all([first, skipped, latest]);
  assert.deepEqual(started, ["first", "latest"]);
  assert.equal(maximumActive, 1);
});

test("keyboard selection reveal uses rendered row position", () => {
  assert.equal(revealScrollOffset(20, 0, 8, 30), 13);
  assert.equal(revealScrollOffset(4, 13, 8, 30), 4);
  assert.equal(revealScrollOffset(15, 13, 8, 30), 13);
  assert.equal(revealScrollOffset(-1, 40, 8, 30), 22);
});
