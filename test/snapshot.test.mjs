import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { terminalColumns } from "../src/terminal-ui.mjs";
import { runGit } from "../src/process.mjs";
import { hermeticEnvironment } from "./helpers/environment.mjs";

const exec = promisify(execFile);

async function writeUserConfig(environment, value) {
  const directory = path.join(environment.XDG_CONFIG_HOME, "git-rail");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "config.json"), JSON.stringify(value));
}

function execHermetic(t, command, args, options = {}, overrides = {}) {
  const { env: _discardedEnvironment, ...spawnOptions } = options;
  const { environment } = hermeticEnvironment(t, overrides);
  return exec(command, args, { ...spawnOptions, env: environment });
}

function spawnHermetic(t, command, args, options = {}, overrides = {}) {
  const { env: _discardedEnvironment, ...spawnOptions } = options;
  const { environment } = hermeticEnvironment(t, overrides);
  return spawn(command, args, { ...spawnOptions, env: environment });
}

async function waitFor(check, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(check(), message);
}

function plainTerminal(text) {
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

function latestPlainFrame(text) {
  return plainTerminal(text.split("\u001b[?2026h\u001b[H").at(-1));
}

for (const width of [25, 36, 52, 100]) {
  test(`demo snapshot is coherent at ${width} columns`, async (t) => {
    const { stdout } = await execHermetic(t, process.execPath, ["scripts/git-rail.mjs", "--demo", "--snapshot", "--width", String(width), "--height", "32"], { maxBuffer: 2 * 1024 * 1024 });
    const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
    assert.doesNotMatch(plain, /HERDR GITRAIL/);
    assert.match(plain, /feature\/sidebar/);
    assert.match(plain, /CHANGES\s+FILES/);
    assert.doesNotMatch(plain, /CHANGES \d/);
    assert.match(plain, /Staged/);
    assert.match(plain, /Unstaged/);
    if (width === 25) {
      assert.match(plain, /Untracked/);
      assert.match(plain, /› src 1/);
      assert.match(plain, /› assets 1/);
      assert.doesNotMatch(plain, /status\.mjs|binary\.dat/);
    }
    assert.doesNotMatch(plain, /Read-only demo preview|const panel = "files"/);
    assert.ok(plain.split("\n").every((line) => [...line].length <= width));
  });
}

test("demo snapshot ignores ambient user configuration and GitRail overrides", async (t) => {
  const { environment } = hermeticEnvironment(t, {
    GIT_RAIL_PANEL_WIDTH: "99",
    GIT_RAIL_POLL_INTERVAL_MS: "invalid",
  });
  await writeUserConfig(environment, { version: 1, unexpected: "ambient" });
  const { stdout } = await exec(process.execPath, [
    "scripts/git-rail.mjs", "--demo", "--snapshot", "--width", "52", "--height", "32",
  ], { env: environment });
  const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.doesNotMatch(plain, /config\.json|unknown|invalid polling/i);
  assert.match(plain, /gitrail-fixture/);
});

for (const width of [25, 100]) {
  test(`Files view starts with folders collapsed at ${width} columns`, async (t) => {
    const { stdout } = await execHermetic(t, process.execPath, ["scripts/git-rail.mjs", "--demo", "--snapshot", "--files", "--width", String(width), "--height", "40"], { maxBuffer: 2 * 1024 * 1024 });
    const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
    assert.ok(plain.indexOf("docs") < plain.indexOf("README.md"));
    assert.ok(plain.indexOf("src") < plain.indexOf("README.md"));
    assert.match(plain, /□ README\.md/);
    assert.match(plain, /› docs/);
    assert.match(plain, /› src/);
    assert.doesNotMatch(plain, /preview\.md|usage\.md|rail\.mjs|status\.mjs/);
  });
}

test("production Files repaint materializes only the 20k-path viewport", async (t) => {
  for (const width of [36, 52, 100]) {
    const { stderr } = await execHermetic(t, process.execPath, [
      "scripts/git-rail.mjs",
      "--demo",
      "--snapshot",
      "--files",
      "--width", String(width),
      "--height", "40",
      "--viewport-fixture-count", "20000",
      "--snapshot-frames", "3",
      "--viewport-metrics",
    ], { maxBuffer: 4 * 1024 * 1024 });
    const metrics = JSON.parse(stderr.trim().split("\n").at(-1));
    assert.equal(metrics.regenerations, 1);
    assert.ok(metrics.materializedRows <= 120, `${width}-column repaint materialized ${metrics.materializedRows} rows`);
  }
});

test("Files search expands matching paths from collapsed folders for keyboard access", async (t) => {
  const child = spawnHermetic(t, process.execPath, [
    "scripts/git-rail.mjs",
    "--demo",
    "--files",
    "--width", "52",
    "--height", "40",
    "--viewport-fixture-count", "20000",
  ], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }, { NODE_ENV: "test" });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  await waitFor(() => stdout.includes("folder-000"), "collapsed Files folders did not render");
  assert.equal(stdout.includes("file-00000.txt"), false);
  child.stdin.write("/file-19999.txt\r");
  await waitFor(() => stdout.includes("file-19999.txt"), "matching Files path did not expand for search");
  child.stdin.write("j");
  await waitFor(() => stdout.includes(`${"\u001b"}[48;2;45;41;34m`), "matching Files row was not keyboard selected");
  child.stdin.write("q");
  await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
});

test("keyboard navigation expands an initially collapsed Files folder", async (t) => {
  const child = spawnHermetic(t, process.execPath, [
    "scripts/git-rail.mjs", "--demo", "--files", "--width", "52", "--height", "40",
  ], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  await waitFor(() => stdout.includes("› assets"), "collapsed Files folder did not render");
  assert.equal(stdout.includes("binary.dat"), false);
  child.stdin.write("j");
  await waitFor(() => stdout.includes(`${"\u001b"}[48;2;45;41;34m`), "collapsed Files folder was not selected");
  child.stdin.write("\r");
  await waitFor(() => stdout.includes("binary.dat"), "selected Files folder did not expand");
  child.stdin.write("q");
  await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
});

test("Changes search includes commit history summaries", async (t) => {
  const { stdout } = await execHermetic(t, process.execPath, ["scripts/git-rail.mjs", "--demo", "--snapshot", "--search", "descriptor-aware", "--width", "52", "--height", "32"], { maxBuffer: 2 * 1024 * 1024 });
  const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(plain, /1 result/);
  assert.match(plain, /Commits  1/);
  assert.match(plain, /add descriptor-aware rail/);
  assert.doesNotMatch(plain, /No changes or commits match/);
});

test("commit-history search filters expanded commit children", async (t) => {
  const { stdout } = await execHermetic(t, process.execPath, ["scripts/git-rail.mjs", "--demo", "--snapshot", "--search", "preview.md", "--width", "52", "--height", "32"], { maxBuffer: 2 * 1024 * 1024 });
  const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(plain, /2 results/);
  assert.match(plain, /Against main  1/);
  assert.match(plain, /Commits  1/);
  assert.match(plain, /preview\.md/);
  assert.doesNotMatch(plain, /rail\.mjs|status\.mjs/);
});

test("loaded commit search rows replace preview glyphs with real status and stats", async (t) => {
  const child = spawnHermetic(t, process.execPath, [
    "scripts/git-rail.mjs", "--demo", "--search", "preview.md", "--width", "52", "--height", "32",
  ], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  await waitFor(() => latestPlainFrame(stdout).includes("⊡ preview.md"), "commit preview row did not render");
  child.stdin.write("jjj\r");
  await waitFor(() => (latestPlainFrame(stdout).match(/⊞ preview\.md\s+\+3/g) || []).length === 2, "loaded commit row retained placeholder status");
  child.stdin.write("q");
  await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
});

test("Tree and Folders layouts render identical file status and stats", async (t) => {
  const narrow = await execHermetic(t, process.execPath, [
    "scripts/git-rail.mjs", "--demo", "--snapshot", "--search", "status.mjs", "--width", "52", "--height", "28",
  ]);
  const narrowPlain = plainTerminal(narrow.stdout);
  assert.match(narrowPlain, /≣ Folders/);
  assert.equal((narrowPlain.match(/⊡ status\.mjs\s+\+2 −1/g) || []).length, 2);

  const child = spawnHermetic(t, process.execPath, [
    "scripts/git-rail.mjs", "--demo", "--search", "status.mjs", "--width", "100", "--height", "28",
  ], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  await waitFor(() => latestPlainFrame(stdout).includes("≡ Tree"), "wide Tree layout did not render");
  assert.equal((latestPlainFrame(stdout).match(/⊡ status\.mjs\s+\+2 −1/g) || []).length, 2);
  child.stdin.write("g");
  await waitFor(() => latestPlainFrame(stdout).includes("≣ Folders"), "g did not switch the layout label");
  assert.equal((latestPlainFrame(stdout).match(/⊡ status\.mjs\s+\+2 −1/g) || []).length, 2);
  child.stdin.write("q");
  await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
});

test("rendered status matrix includes Git glyphs, numeric stats, and binary labels", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-render-matrix-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "modified.txt"), "before\n");
  await fs.writeFile(path.join(root, "delete.txt"), "delete me\n");
  await fs.writeFile(path.join(root, "rename-old.txt"), "rename me\n");
  await fs.writeFile(path.join(root, "copy-source.txt"), "copy me exactly\n");
  await fs.symlink("copy-source.txt", path.join(root, "type-target.txt"));
  await fs.writeFile(path.join(root, "binary.dat"), Buffer.from([0, 1, 2]));
  await runGit(root, ["add", "--all"]);
  await runGit(root, ["commit", "-m", "base"], { env: identity });
  await fs.writeFile(path.join(root, "modified.txt"), "after\nextra\n");
  await fs.rm(path.join(root, "delete.txt"));
  await runGit(root, ["mv", "rename-old.txt", "rename-new.txt"]);
  await fs.copyFile(path.join(root, "copy-source.txt"), path.join(root, "copy-target.txt"));
  await fs.rm(path.join(root, "type-target.txt"));
  await fs.writeFile(path.join(root, "type-target.txt"), "regular now\n");
  await fs.writeFile(path.join(root, "binary.dat"), Buffer.from([0, 9, 2]));
  await fs.writeFile(path.join(root, "added.txt"), "added\n");
  await fs.symlink("missing-target", path.join(root, "added-link"));
  await runGit(root, ["add", "added.txt", "added-link", "copy-target.txt"]);

  const script = path.resolve("scripts/git-rail.mjs");
  const { stdout } = await execHermetic(t, process.execPath, [script, "--snapshot", "--width", "100", "--height", "60"], { cwd: root });
  const plain = plainTerminal(stdout);
  assert.match(plain, /⊞ added\.txt\s+\+1/);
  assert.match(plain, /⊞ added-link\s+\+1/);
  assert.match(plain, /⧉ copy-target\.txt/);
  assert.match(plain, /↪ rename-new\.txt/);
  assert.match(plain, /◆ binary\.dat\s+binary/);
  assert.match(plain, /⊟ delete\.txt\s+−1/);
  assert.match(plain, /⊡ modified\.txt\s+\+2 −1/);
  assert.match(plain, /◇ type-target\.txt\s+\+1 −1/);

  const filesSnapshot = await execHermetic(t, process.execPath, [script, "--snapshot", "--files", "--width", "100", "--height", "60"], { cwd: root });
  const filesPlain = plainTerminal(filesSnapshot.stdout);
  assert.match(filesPlain, /⊞ added\.txt\s+\+1/);
  assert.match(filesPlain, /⊞ added-link\s+\+1/);
  assert.match(filesPlain, /⧉ copy-target\.txt/);
  assert.match(filesPlain, /↪ rename-new\.txt/);
  assert.match(filesPlain, /◆ binary\.dat\s+binary/);
  assert.match(filesPlain, /⊡ modified\.txt\s+\+2 −1/);
  assert.match(filesPlain, /◇ type-target\.txt\s+\+1 −1/);
  assert.doesNotMatch(filesPlain, /delete\.txt|rename-old\.txt/);
});

test("conflicted files render their dedicated on-screen glyph", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-render-conflict-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "conflict.txt"), "base\n");
  await runGit(root, ["add", "conflict.txt"]);
  await runGit(root, ["commit", "-m", "base"], { env: identity });
  await runGit(root, ["switch", "-c", "other"]);
  await fs.writeFile(path.join(root, "conflict.txt"), "other\n");
  await runGit(root, ["commit", "-am", "other"], { env: identity });
  await runGit(root, ["switch", "main"]);
  await fs.writeFile(path.join(root, "conflict.txt"), "main\n");
  await runGit(root, ["commit", "-am", "main"], { env: identity });
  await assert.rejects(runGit(root, ["merge", "other"], { env: identity }));
  const { stdout } = await execHermetic(t, process.execPath, [path.resolve("scripts/git-rail.mjs"), "--snapshot", "--width", "100", "--height", "36"], { cwd: root });
  assert.match(plainTerminal(stdout), /! conflict\.txt/);
});

test("large repositories fully render Changes and Files without continuation controls", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-large-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "--initial-branch=main"]);
  await Promise.all(Array.from({ length: 250 }, (_, index) => fs.writeFile(path.join(root, `file-${String(index).padStart(3, "0")}.txt`), `${index}\n`)));
  const script = path.resolve("scripts/git-rail.mjs");
  const { stdout } = await execHermetic(t, process.execPath, [script, "--snapshot", "--width", "52", "--height", "270"], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(plain, /Untracked  250/);
  assert.match(plain, /file-000\.txt/);
  assert.match(plain, /file-249\.txt/);
  assert.doesNotMatch(plain, /Show \d+ more/);

  const filesSnapshot = await execHermetic(t, process.execPath, [script, "--snapshot", "--files", "--width", "52", "--height", "270"], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  const filesPlain = filesSnapshot.stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(filesPlain, /file-000\.txt/);
  assert.match(filesPlain, /file-249\.txt/);
  assert.doesNotMatch(filesPlain, /Show \d+ more/);
});

test("Files render includes current untracked paths and excludes every deleted path", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-files-render-current-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "present.txt"), "present\n");
  await fs.writeFile(path.join(root, "committed-delete.txt"), "committed\n");
  await fs.writeFile(path.join(root, "staged-delete.txt"), "staged\n");
  await fs.writeFile(path.join(root, "unstaged-delete.txt"), "unstaged\n");
  await runGit(root, ["add", "--all"]);
  await runGit(root, ["commit", "-m", "base"], { env: identity });
  await runGit(root, ["switch", "-c", "feature/files"]);
  await fs.rm(path.join(root, "committed-delete.txt"));
  await runGit(root, ["commit", "-am", "commit deletion"], { env: identity });
  await fs.rm(path.join(root, "staged-delete.txt"));
  await runGit(root, ["add", "--all"]);
  await fs.rm(path.join(root, "unstaged-delete.txt"));
  await fs.writeFile(path.join(root, "never-committed.txt"), "staged then removed\n");
  await runGit(root, ["add", "never-committed.txt"]);
  await fs.rm(path.join(root, "never-committed.txt"));
  await fs.writeFile(path.join(root, "untracked.txt"), "untracked\n");

  const script = path.resolve("scripts/git-rail.mjs");
  const { stdout } = await execHermetic(t, process.execPath, [script, "--snapshot", "--files", "--width", "52", "--height", "28"], { cwd: root });
  const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(plain, /□ present\.txt/);
  assert.match(plain, /\? untracked\.txt/);
  assert.doesNotMatch(plain, /committed-delete\.txt|never-committed\.txt|staged-delete\.txt|unstaged-delete\.txt/);
});

test("sidebar rows stay within terminal width for wide filenames", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-wide-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, `${"界".repeat(20)}.txt`), "wide\n");
  const script = path.resolve("scripts/git-rail.mjs");
  const { stdout } = await execHermetic(t, process.execPath, [script, "--snapshot", "--width", "25", "--height", "28"], { cwd: root });
  assert.ok(stdout.trimEnd().split("\n").every((line) => terminalColumns(line) <= 25));
});

test("clean Changes view states that the worktree is clean", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-clean-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "README.md"), "clean\n");
  await runGit(root, ["add", "README.md"]);
  await runGit(root, ["commit", "-m", "clean"], { env: identity });
  const script = path.resolve("scripts/git-rail.mjs");
  const { stdout } = await execHermetic(t, process.execPath, [script, "--snapshot", "--width", "52", "--height", "28"], { cwd: root });
  const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(plain, /No changes against main · working tree clean/);
});

test("non-repository Files stays browsable with one neutral file icon", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-filesystem-snapshot-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "README.md"), "# Directory\n");
  await fs.writeFile(path.join(root, "settings.toml"), "enabled = true\n");
  await fs.writeFile(path.join(root, "src", "index.mjs"), "export {};\n");
  const script = path.resolve("scripts/git-rail.mjs");
  const files = await execHermetic(t, process.execPath, [script, "--snapshot", "--files", "--width", "52", "--height", "28"], { cwd: root }, { HERDR_BIN_PATH: path.join(root, "missing-herdr") });
  const filesPlain = files.stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(filesPlain, /› src 1/);
  assert.doesNotMatch(filesPlain, /⊠ index\.mjs/);
  assert.match(filesPlain, /⊠ README\.md/);
  assert.match(filesPlain, /⊠ settings\.toml/);
  assert.doesNotMatch(filesPlain, /Enter a Git worktree/);

  const changes = await execHermetic(t, process.execPath, [script, "--snapshot", "--width", "52", "--height", "28"], { cwd: root }, { HERDR_BIN_PATH: path.join(root, "missing-herdr") });
  const changesPlain = changes.stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(changesPlain, /Changes unavailable outside Git/);
  assert.match(changesPlain, /Press Tab to browse files/);
  assert.doesNotMatch(changesPlain, /focused Herdr pane/);
});

test("keyboard can expand a commit-summary search result", async (t) => {
  const child = spawnHermetic(t, process.execPath, ["scripts/git-rail.mjs", "--demo", "--search", "descriptor-aware"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  await waitFor(() => stdout.includes("descriptor-aware rail"), "rail did not finish its initial render");
  child.stdin.write("j\r");
  await waitFor(() => stdout.includes("rail.mjs"), "commit files did not render");
  child.stdin.write("q");
  await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(plain, /rail\.mjs/);
});

test("help overlay explains keys and icons, scrolls, and returns to a highlighted selection", async (t) => {
  const child = spawnHermetic(t, process.execPath, ["scripts/git-rail.mjs", "--demo", "--width", "36", "--height", "18"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  await waitFor(() => stdout.includes("? help"), "rail did not finish its initial render");
  child.stdin.write("?");
  await waitFor(() => stdout.includes("HELP & LEGEND"), "help did not open");
  for (let index = 0; index < 6; index += 1) {
    child.stdin.write("J");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  await waitFor(() => stdout.includes("Filesystem-only file"), "legend did not reach its final entries");
  child.stdin.write("q");
  await waitFor(() => stdout.lastIndexOf("Search changes") > stdout.lastIndexOf("HELP & LEGEND"), "help did not close");
  child.stdin.write("j");
  await waitFor(() => stdout.includes(`${"\u001b"}[48;2;45;41;34m${"\u001b"}[38;2;214;176;91m▏`), "selection did not render");
  child.stdin.write("q");
  await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(plain, /HELP & LEGEND/);
  assert.match(plain, /⊡ Modified/);
  assert.match(plain, /⊠ Filesystem-only file/);
  assert.match(plain, /Unstaged: tracked change not staged/);
  assert.match(plain, /Untracked: not added to Git/);
  assert.match(stdout, /\u001b\[38;2;214;176;91m▐/);
  assert.match(stdout, /\u001b\[48;2;45;41;34m\u001b\[38;2;214;176;91m▏\u001b\[0m\u001b\[48;2;45;41;34m/);
});

test("Escape clears a keyboard selection before a second press closes the rail", async (t) => {
  const child = spawnHermetic(t, process.execPath, ["scripts/git-rail.mjs", "--demo", "--width", "52", "--height", "24"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  await waitFor(() => stdout.includes("? help"), "rail did not finish its initial render");
  stdout = "";
  child.stdin.write("j");
  await waitFor(() => stdout.includes(`${"\u001b"}[48;2;45;41;34m${"\u001b"}[38;2;214;176;91m▏`), "selection did not render");
  assert.match(stdout, /\u001b\[48;2;45;41;34m\u001b\[38;2;214;176;91m▏/);
  stdout = "";
  child.stdin.write("\u001b");
  await waitFor(() => stdout.includes("Search changes"), "Escape did not repaint the cleared selection");
  assert.equal(child.exitCode, null);
  assert.doesNotMatch(stdout, /\u001b\[48;2;45;41;34m\u001b\[38;2;214;176;91m▏/);
  child.stdin.write("\u001b");
  await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
});

test("fatal rail errors restore terminal modes before exiting nonzero", async (t) => {
  const child = spawnHermetic(t, process.execPath, ["scripts/git-rail.mjs", "--demo", "--width", "36", "--height", "18"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  }, { NODE_ENV: "test", GIT_RAIL_TEST_FATAL: "1" });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  assert.equal(exitCode, 1);
  assert.match(stdout, /\u001b\[\?1000l\u001b\[\?1006l\u001b\[\?25h\u001b\[\?1049l/);
  assert.match(stderr, /GitRail fatal error: Error: injected fatal error/);
});

test("selection survives edit, stage, and commit refreshes while Files drops a later deletion", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-live-transitions-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "live.txt"), "base\n");
  await runGit(root, ["add", "live.txt"]);
  await runGit(root, ["commit", "-m", "base"], { env: identity });
  await runGit(root, ["switch", "-c", "feature/live"]);
  await fs.writeFile(path.join(root, "live.txt"), "edited\nextra\n");

  const child = spawnHermetic(t, process.execPath, [path.resolve("scripts/git-rail.mjs"), "--width", "100", "--height", "32"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  }, { GIT_RAIL_POLL_INTERVAL_MS: "1000" });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  await waitFor(() => /⊡ live\.txt\s+\+2 −1/.test(latestPlainFrame(stdout)), "live edit did not render");
  child.stdin.write("j");
  await waitFor(() => latestPlainFrame(stdout).includes("Unstaged · live.txt"), "unstaged row was not selected");

  await runGit(root, ["add", "live.txt"]);
  await waitFor(() => latestPlainFrame(stdout).includes("Staged · live.txt") && latestPlainFrame(stdout).includes("▏"), "selection did not survive staging", 8_000);

  await runGit(root, ["commit", "-m", "live update"], { env: identity });
  await waitFor(() => /Commits\s+1/.test(latestPlainFrame(stdout)) && /Against main\s+1/.test(latestPlainFrame(stdout)), "commit transition did not refresh", 8_000);
  child.stdin.write("\t");
  await waitFor(() => /⊡ live\.txt\s+\+2 −1/.test(latestPlainFrame(stdout)) && latestPlainFrame(stdout).includes("Against main · live.txt"), "Files tab did not show the selected committed file descriptor");
  await fs.rm(path.join(root, "live.txt"));
  await waitFor(() => !/[□?⊠⊡⊞⊟↪⧉!◇◆]\s+live\.txt/.test(latestPlainFrame(stdout)), "Files tab retained a deleted path", 8_000);
  child.stdin.write("q");
  await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
});

test("terminal editor return and manual reload both re-read preview content", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-preview-reload-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const editor = path.join(root, "test-editor");
  await fs.writeFile(editor, "#!/bin/sh\nprintf 'after editor\\n' > \"$1\"\n");
  await fs.chmod(editor, 0o700);
  await fs.writeFile(path.join(root, "note.txt"), "before editor\n");
  const { environment } = hermeticEnvironment(t);
  await writeUserConfig(environment, { version: 1, editor: { client: editor, args: [], mode: "terminal" } });
  const child = spawn(process.execPath, [path.resolve("scripts/file-preview.mjs"), "--width", "52", "--height", "20"], {
    cwd: root,
    env: {
      ...environment,
      GIT_RAIL_PREVIEW_PATH: "note.txt",
      GIT_RAIL_PREVIEW_REPO: root,
      GIT_RAIL_PREVIEW_DESCRIPTOR: Buffer.from(JSON.stringify({ kind: "filesystem" })).toString("base64url"),
      GIT_RAIL_PREVIEW_METADATA: Buffer.from(JSON.stringify({ status: "clean" })).toString("base64url"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stdin.write("2");
  await waitFor(() => latestPlainFrame(stdout).includes("before editor"), "raw preview did not render initial content");
  child.stdin.write("e");
  await waitFor(() => latestPlainFrame(stdout).includes("after editor") && latestPlainFrame(stdout).includes("preview reloaded"), "editor return did not reload preview content");
  await fs.writeFile(path.join(root, "note.txt"), "after manual reload\n");
  child.stdin.write("r");
  await waitFor(() => latestPlainFrame(stdout).includes("after manual reload"), "r did not reload preview content");
  child.stdin.write("q");
  await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
});

test("preview processes coalesced search input, advances matches, and exposes horizontal navigation", async (t) => {
  const { environment } = hermeticEnvironment(t);
  await writeUserConfig(environment, {
    version: 1,
    viewers: {
      "*": [
        { label: "Open", client: "system", mode: "external", key: "8" },
        { label: "VS Code", client: "code", mode: "external", key: "9" },
      ],
    },
  });
  const descriptor = Buffer.from(JSON.stringify({ kind: "clean" })).toString("base64url");
  const metadata = Buffer.from(JSON.stringify({ status: "clean" })).toString("base64url");
  const child = spawn(process.execPath, ["scripts/file-preview.mjs", "--width", "24", "--height", "20"], {
    cwd: process.cwd(),
    env: {
      ...environment,
      GIT_RAIL_PREVIEW_PATH: "src/config.mjs",
      GIT_RAIL_PREVIEW_REPO: process.cwd(),
      GIT_RAIL_PREVIEW_DESCRIPTOR: descriptor,
      GIT_RAIL_PREVIEW_METADATA: metadata,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  await waitFor(() => stdout.includes("Read-only preview"), "preview did not render");
  child.stdin.write("/return\r");
  await waitFor(() => /Match 1 of \d+/.test(stdout), "initial search results did not render");
  child.stdin.write("n");
  await waitFor(() => /Match 2 of \d+/.test(stdout), "search did not advance to the next match");
  child.stdin.write("/\u0015executableAvailable\r");
  await waitFor(() => stdout.includes("executableAvaila"), "replacement search result did not render");
  child.stdin.write("w");
  await waitFor(() => stdout.includes("w wrap:off"), "word wrap did not disable");
  child.stdin.write("\u001b[C");
  await waitFor(() => /↔ col (?:[2-9]|[1-9]\d+)/.test(stdout), "horizontal navigation did not advance");
  child.stdin.write("q");
  await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(plain, /Match 1 of \d+/);
  assert.match(plain, /Match 2 of \d+/);
  assert.match(plain, /executableAvaila/);
  assert.match(plain, /↔ col (?:[2-9]|[1-9]\d+)/);
  assert.match(plain, /w wrap:off/);
  assert.match(plain, /8 Open/);
  assert.match(plain, /9 VS Code/);
});

test("embedded Markdown rendering stays inside the pageable preview viewport", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-rendered-markdown-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const renderer = path.join(root, "test-renderer");
  await fs.writeFile(renderer, `#!/bin/sh
case "$*" in *'{width}'*) exit 9 ;; esac
test -f "$3" || exit 10
printf '\\033[1mRendered heading\\033[0m\\n'
i=1
while [ "$i" -le 40 ]; do
  printf 'rendered row %s\\n' "$i"
  i=$((i + 1))
done
`);
  await fs.chmod(renderer, 0o700);
  await fs.writeFile(path.join(root, "README.md"), "# Source heading\n\nA source paragraph that should remain available in Raw.\n");
  const { environment } = hermeticEnvironment(t);
  await writeUserConfig(environment, {
    version: 1,
    viewers: {
      ".md": { label: "Rendered", client: renderer, args: ["--width", "{width}"], mode: "embedded", key: "3", autoOpen: true },
    },
  });
  const descriptor = Buffer.from(JSON.stringify({ kind: "filesystem" })).toString("base64url");
  const metadata = Buffer.from(JSON.stringify({ status: "clean" })).toString("base64url");
  const child = spawn(process.execPath, [path.resolve("scripts/file-preview.mjs"), "--width", "28", "--height", "18"], {
    cwd: root,
    env: {
      ...environment,
      GIT_RAIL_PREVIEW_PATH: "README.md",
      GIT_RAIL_PREVIEW_REPO: root,
      GIT_RAIL_PREVIEW_DESCRIPTOR: descriptor,
      GIT_RAIL_PREVIEW_METADATA: metadata,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 5_000;
  while (!stdout.includes("Rendered heading") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.match(stdout, /3 Rendered/);
  assert.match(stdout, /Rendered heading/);
  assert.match(stdout, /\u001b\[38;2;214;176;91m▐/);
  stdout = "";
  child.stdin.write("\u001b[6~");
  await new Promise((resolve) => setTimeout(resolve, 100));
  child.stdin.write("q");
  await waitFor(() => stdout.includes("Source heading"), "q did not return from rendered Markdown to Raw");
  child.stdin.write("q");
  const exitCode = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  assert.equal(exitCode, 0, stderr);
  const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(plain, /rendered row (?:[7-9]|1\d)/);
  assert.doesNotMatch(plain, /Rendered heading/);
});

test("a hostile repository config cannot auto-launch a preview executable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-hostile-repo-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "spawned-marker");
  const hostile = path.join(root, "hostile-viewer");
  await fs.writeFile(hostile, `#!/bin/sh\nprintf pwned > ${JSON.stringify(marker)}\n`);
  await fs.chmod(hostile, 0o700);
  await fs.writeFile(path.join(root, "note.txt"), "repository content\n");
  await fs.writeFile(path.join(root, ".git-rail.json"), JSON.stringify({
    version: 1,
    viewers: { ".txt": { client: hostile, mode: "embedded", key: "3", autoOpen: true } },
  }));
  const { environment } = hermeticEnvironment(t, {
    GIT_RAIL_PREVIEW_PATH: "note.txt",
    GIT_RAIL_PREVIEW_REPO: root,
    GIT_RAIL_PREVIEW_DESCRIPTOR: Buffer.from(JSON.stringify({ kind: "filesystem" })).toString("base64url"),
    GIT_RAIL_PREVIEW_METADATA: Buffer.from(JSON.stringify({ status: "clean" })).toString("base64url"),
  });
  const child = spawn(process.execPath, [path.resolve("scripts/file-preview.mjs"), "--width", "32", "--height", "18"], {
    cwd: root,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const deadline = Date.now() + 5_000;
  while (!stdout.includes("repository content") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  child.stdin.write("q");
  await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
  assert.doesNotMatch(stdout, /3 hostile-viewer|pwned/);
});

test("embedded Glow renders the selected Markdown bytes through stdin", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-glow-stdin-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const renderer = path.join(root, "glow");
  await fs.writeFile(renderer, `#!/bin/sh
test "$#" -eq 2 || exit 9
test "$1" = "--width" || exit 10
case "$(cat)" in *'Source heading'*) ;; *) exit 11 ;; esac
printf '\\033[1mRendered from stdin\\033[0m\\n'
`);
  await fs.chmod(renderer, 0o700);
  await fs.writeFile(path.join(root, "README.md"), "# Source heading\n\nMarkdown body.\n");
  const { environment } = hermeticEnvironment(t);
  await writeUserConfig(environment, {
    version: 1,
    viewers: {
      ".md": { label: "Rendered", client: renderer, args: ["--width", "{width}"], mode: "embedded", key: "3", autoOpen: true },
    },
  });
  const descriptor = Buffer.from(JSON.stringify({ kind: "filesystem" })).toString("base64url");
  const metadata = Buffer.from(JSON.stringify({ status: "clean" })).toString("base64url");
  const child = spawn(process.execPath, [path.resolve("scripts/file-preview.mjs"), "--width", "32", "--height", "18"], {
    cwd: root,
    env: {
      ...environment,
      GIT_RAIL_PREVIEW_PATH: "README.md",
      GIT_RAIL_PREVIEW_REPO: root,
      GIT_RAIL_PREVIEW_DESCRIPTOR: descriptor,
      GIT_RAIL_PREVIEW_METADATA: metadata,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 5_000;
  while (!stdout.includes("Rendered from stdin") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  const renderedOutput = stdout;
  stdout = "";
  child.stdin.write("q");
  await waitFor(() => stdout.includes("Source heading"), "q did not return from embedded Glow to Raw");
  child.stdin.write("q");
  const exitCode = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  assert.equal(exitCode, 0, stderr);
  assert.match(renderedOutput, /3 Rendered/);
  assert.match(renderedOutput, /Rendered from stdin/);
  assert.doesNotMatch(renderedOutput, /Renderer returned no content/);
});

test("a configured Markdown action auto-opens embedded Glow and action 3 renders it again", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-default-glow-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const renderer = path.join(root, "glow");
  const calls = path.join(root, "glow-calls");
  await fs.writeFile(renderer, `#!/bin/sh
test "$#" -eq 2 || exit 9
test "$1" = "--width" || exit 10
case "$(cat)" in *'Source heading'*) ;; *) exit 11 ;; esac
printf x >> '${calls}'
printf 'Glow rendered from stdin\n'
`);
  await fs.chmod(renderer, 0o700);
  await fs.writeFile(path.join(root, "README.md"), "# Source heading\n");
  const { environment } = hermeticEnvironment(t, { PATH: `${root}${path.delimiter}${process.env.PATH || ""}` });
  await writeUserConfig(environment, {
    version: 1,
    viewers: {
      ".md": { label: "Rendered", client: "glow", args: ["--width", "{width}"], mode: "embedded", key: "3", autoOpen: true },
    },
  });
  const descriptor = Buffer.from(JSON.stringify({ kind: "filesystem" })).toString("base64url");
  const metadata = Buffer.from(JSON.stringify({ status: "clean" })).toString("base64url");
  const child = spawn(process.execPath, [path.resolve("scripts/file-preview.mjs"), "--width", "32", "--height", "18"], {
    cwd: root,
    env: {
      ...environment,
      GIT_RAIL_PREVIEW_PATH: "README.md",
      GIT_RAIL_PREVIEW_REPO: root,
      GIT_RAIL_PREVIEW_DESCRIPTOR: descriptor,
      GIT_RAIL_PREVIEW_METADATA: metadata,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const readyDeadline = Date.now() + 5_000;
  while (!stdout.includes("Glow rendered from stdin") && Date.now() < readyDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
  child.stdin.write("3");
  const launchDeadline = Date.now() + 5_000;
  while (Date.now() < launchDeadline) {
    try { if ((await fs.readFile(calls, "utf8")).length >= 2) break; } catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const renderedOutput = stdout;
  stdout = "";
  child.stdin.write("q");
  await waitFor(() => stdout.includes("Source heading"), "q did not return from built-in Glow to Raw");
  child.stdin.write("q");
  const exitCode = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  assert.equal(exitCode, 0, stderr);
  assert.match(renderedOutput, /3 Rendered/);
  assert.equal((await fs.readFile(calls, "utf8")).length, 2);
  assert.match(renderedOutput, /Glow rendered from stdin/);
});

test("preview reports repaint latency for a large allowed line count", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-many-lines-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "many.txt"), "x\n".repeat(75_000));
  await runGit(root, ["add", "many.txt"]);
  await runGit(root, ["commit", "-m", "many lines"], { env: identity });
  const descriptor = Buffer.from(JSON.stringify({ kind: "clean" })).toString("base64url");
  const metadata = Buffer.from(JSON.stringify({ status: "clean" })).toString("base64url");
  const child = spawnHermetic(t, process.execPath, [path.resolve("scripts/file-preview.mjs"), "--width", "24", "--height", "20"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  }, {
      GIT_RAIL_PREVIEW_PATH: "many.txt",
      GIT_RAIL_PREVIEW_REPO: root,
      GIT_RAIL_PREVIEW_DESCRIPTOR: descriptor,
      GIT_RAIL_PREVIEW_METADATA: metadata,
  });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 5_000;
  while (!stdout.includes("worktree") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const repaintStarted = Date.now();
  const repaint = new Promise((resolve) => child.stdout.once("data", resolve));
  child.stdin.write("j");
  await Promise.race([
    repaint,
    new Promise((_, reject) => setTimeout(() => reject(new Error("preview repaint did not complete")), 10_000)),
  ]);
  t.diagnostic(`75,000-line preview repaint: ${Date.now() - repaintStarted}ms`);
  child.stdin.write("q");
  const exitCode = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /worktree/);
  assert.doesNotMatch(stderr, /RangeError|Maximum call stack/);
});

test("preview avoids wrapped-row amplification for a pathological single line", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-long-line-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "long.txt"), "x".repeat(150_000));
  const descriptor = Buffer.from(JSON.stringify({ kind: "filesystem" })).toString("base64url");
  const metadata = Buffer.from(JSON.stringify({ status: "clean" })).toString("base64url");
  const child = spawnHermetic(t, process.execPath, [path.resolve("scripts/file-preview.mjs"), "--width", "24", "--height", "20"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  }, {
      GIT_RAIL_PREVIEW_PATH: "long.txt",
      GIT_RAIL_PREVIEW_REPO: root,
      GIT_RAIL_PREVIEW_DESCRIPTOR: descriptor,
      GIT_RAIL_PREVIEW_METADATA: metadata,
  });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 5_000;
  while (!stdout.includes("Word wrap disabled") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  child.stdin.write("q");
  const exitCode = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /Word wrap disabled/);
  assert.match(stdout, /w wrap:off/);
  assert.doesNotMatch(stderr, /heap out of memory|RangeError/i);
});

test("preview rejects pathological line counts before rendered-memory amplification", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-line-limit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "million.txt"), "x\n".repeat(1_000_000));
  await runGit(root, ["add", "million.txt"]);
  await runGit(root, ["commit", "-m", "pathological line count"], { env: identity });
  const descriptor = Buffer.from(JSON.stringify({ kind: "clean" })).toString("base64url");
  const metadata = Buffer.from(JSON.stringify({ status: "clean" })).toString("base64url");
  const child = spawnHermetic(t, process.execPath, [path.resolve("scripts/file-preview.mjs"), "--width", "52", "--height", "20"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  }, {
      GIT_RAIL_PREVIEW_PATH: "million.txt",
      GIT_RAIL_PREVIEW_REPO: root,
      GIT_RAIL_PREVIEW_DESCRIPTOR: descriptor,
      GIT_RAIL_PREVIEW_METADATA: metadata,
  });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 5_000;
  while (!stdout.includes("terminal line safety limit") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  child.stdin.write("q");
  const exitCode = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /terminal line safety limit/);
  assert.match(stdout, /more than 100,000 lines/);
  assert.doesNotMatch(stderr, /RangeError|heap out of memory/i);
});
