import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { terminalColumns } from "../src/terminal-ui.mjs";
import { runGit } from "../src/process.mjs";

const exec = promisify(execFile);

for (const width of [25, 36, 52, 100]) {
  test(`demo snapshot is coherent at ${width} columns`, async () => {
    const { stdout } = await exec(process.execPath, ["scripts/git-rail.mjs", "--demo", "--snapshot", "--width", String(width), "--height", "32"], { maxBuffer: 2 * 1024 * 1024 });
    const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
    assert.doesNotMatch(plain, /HERDR GITRAIL/);
    assert.match(plain, /feature\/sidebar/);
    assert.match(plain, /CHANGES\s+FILES/);
    assert.doesNotMatch(plain, /CHANGES \d/);
    assert.match(plain, /Staged/);
    assert.match(plain, /Unstaged/);
    if (width === 25) {
      assert.match(plain, /status\.mjs/);
      assert.doesNotMatch(plain, /Untracked/);
    }
    assert.doesNotMatch(plain, /Read-only demo preview|const panel = "files"/);
    assert.ok(plain.split("\n").every((line) => [...line].length <= width));
  });
}

for (const width of [25, 100]) {
  test(`Files view puts repository-root files after folders at ${width} columns`, async () => {
    const { stdout } = await exec(process.execPath, ["scripts/git-rail.mjs", "--demo", "--snapshot", "--files", "--width", String(width), "--height", "40"], { maxBuffer: 2 * 1024 * 1024 });
    const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
    assert.ok(plain.indexOf("docs") < plain.indexOf("README.md"));
    assert.ok(plain.indexOf("src") < plain.indexOf("README.md"));
    assert.match(plain, /⊞ preview\.md/);
    assert.match(plain, /□ README\.md/);
  });
}

test("Changes search includes commit history summaries", async () => {
  const { stdout } = await exec(process.execPath, ["scripts/git-rail.mjs", "--demo", "--snapshot", "--search", "descriptor-aware", "--width", "52", "--height", "32"], { maxBuffer: 2 * 1024 * 1024 });
  const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(plain, /1 result/);
  assert.match(plain, /Commits  1/);
  assert.match(plain, /add descriptor-aware rail/);
  assert.doesNotMatch(plain, /No changes or commits match/);
});

test("commit-history search filters expanded commit children", async () => {
  const { stdout } = await exec(process.execPath, ["scripts/git-rail.mjs", "--demo", "--snapshot", "--search", "preview.md", "--width", "52", "--height", "32"], { maxBuffer: 2 * 1024 * 1024 });
  const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(plain, /2 results/);
  assert.match(plain, /Against main  1/);
  assert.match(plain, /Commits  1/);
  assert.match(plain, /preview\.md/);
  assert.doesNotMatch(plain, /rail\.mjs|status\.mjs/);
});

test("large repositories expose an explicit reachable continuation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-large-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "--initial-branch=main"]);
  await Promise.all(Array.from({ length: 250 }, (_, index) => fs.writeFile(path.join(root, `file-${String(index).padStart(3, "0")}.txt`), `${index}\n`)));
  const script = path.resolve("scripts/git-rail.mjs");
  const { stdout } = await exec(process.execPath, [script, "--snapshot", "--width", "52", "--height", "120"], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(plain, /Unstaged  250/);
  assert.match(plain, /Show 100 more\s+\(150 remaining\)/);
});

test("sidebar rows stay within terminal width for wide filenames", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-wide-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, `${"界".repeat(20)}.txt`), "wide\n");
  const script = path.resolve("scripts/git-rail.mjs");
  const { stdout } = await exec(process.execPath, [script, "--snapshot", "--width", "25", "--height", "28"], { cwd: root });
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
  const { stdout } = await exec(process.execPath, [script, "--snapshot", "--width", "52", "--height", "28"], { cwd: root });
  const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(plain, /No changes against main · working tree clean/);
});

test("non-repository Files stays browsable with neutral file-type icons", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-filesystem-snapshot-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "README.md"), "# Directory\n");
  await fs.writeFile(path.join(root, "settings.toml"), "enabled = true\n");
  await fs.writeFile(path.join(root, "src", "index.mjs"), "export {};\n");
  const script = path.resolve("scripts/git-rail.mjs");
  const isolatedEnvironment = { ...process.env, HERDR_BIN_PATH: path.join(root, "missing-herdr") };
  const files = await exec(process.execPath, [script, "--snapshot", "--files", "--width", "52", "--height", "28"], { cwd: root, env: isolatedEnvironment });
  const filesPlain = files.stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(filesPlain, /λ index\.mjs/);
  assert.match(filesPlain, /≡ README\.md/);
  assert.match(filesPlain, /◇ settings\.toml/);
  assert.doesNotMatch(filesPlain, /Enter a Git worktree/);

  const changes = await exec(process.execPath, [script, "--snapshot", "--width", "52", "--height", "28"], { cwd: root, env: isolatedEnvironment });
  const changesPlain = changes.stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(changesPlain, /No Git repository/);
  assert.match(changesPlain, /Changes requires Git · Files remains available/);
});

test("keyboard can expand a commit-summary search result", async (t) => {
  const child = spawn(process.execPath, ["scripts/git-rail.mjs", "--demo", "--search", "descriptor-aware"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  await new Promise((resolve) => setTimeout(resolve, 350));
  child.stdin.write("j\r");
  await new Promise((resolve) => setTimeout(resolve, 500));
  child.stdin.write("q");
  await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(plain, /rail\.mjs/);
});

test("preview processes coalesced search input, advances matches, and exposes horizontal navigation", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-preview-home-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, ".config", "git-rail"), { recursive: true });
  await fs.writeFile(path.join(home, ".config", "git-rail", "config.json"), JSON.stringify({
    version: 1,
    viewers: {
      "*": [
        { label: "Open", client: "system", mode: "external", key: "8" },
        { label: "VS Code", client: "code", mode: "external", key: "9" },
      ],
    },
  }));
  const descriptor = Buffer.from(JSON.stringify({ kind: "clean" })).toString("base64url");
  const metadata = Buffer.from(JSON.stringify({ status: "clean" })).toString("base64url");
  const child = spawn(process.execPath, ["scripts/file-preview.mjs", "--width", "24", "--height", "20"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
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
  await new Promise((resolve) => setTimeout(resolve, 250));
  child.stdin.write("/return\r");
  await new Promise((resolve) => setTimeout(resolve, 100));
  child.stdin.write("n");
  await new Promise((resolve) => setTimeout(resolve, 100));
  child.stdin.write("/\u0015executableAvailable\r");
  await new Promise((resolve) => setTimeout(resolve, 100));
  child.stdin.write("\u001b[C");
  await new Promise((resolve) => setTimeout(resolve, 100));
  child.stdin.write("q");
  await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const plain = stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(plain, /Match 1 of \d+/);
  assert.match(plain, /Match 2 of \d+/);
  assert.match(plain, /executableAvailab/);
  assert.match(plain, /↔ col (?:[2-9]|[1-9]\d+)/);
  assert.match(plain, /8 Open/);
  assert.match(plain, /9 VS Code/);
});

test("preview keeps repaint latency bounded for a large allowed line count", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-many-lines-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  await runGit(root, ["init", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "many.txt"), "x\n".repeat(75_000));
  await runGit(root, ["add", "many.txt"]);
  await runGit(root, ["commit", "-m", "many lines"], { env: identity });
  const descriptor = Buffer.from(JSON.stringify({ kind: "clean" })).toString("base64url");
  const metadata = Buffer.from(JSON.stringify({ status: "clean" })).toString("base64url");
  const child = spawn(process.execPath, [path.resolve("scripts/file-preview.mjs"), "--width", "24", "--height", "20"], {
    cwd: root,
    env: {
      ...process.env,
      GIT_RAIL_PREVIEW_PATH: "many.txt",
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
  while (!stdout.includes("worktree") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const repaintStarted = Date.now();
  const repaint = new Promise((resolve) => child.stdout.once("data", resolve));
  child.stdin.write("j");
  await Promise.race([
    repaint,
    new Promise((_, reject) => setTimeout(() => reject(new Error("preview repaint exceeded 750ms")), 750)),
  ]);
  assert.ok(Date.now() - repaintStarted < 750);
  child.stdin.write("q");
  const exitCode = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /worktree/);
  assert.doesNotMatch(stderr, /RangeError|Maximum call stack/);
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
  const child = spawn(process.execPath, [path.resolve("scripts/file-preview.mjs"), "--width", "52", "--height", "20"], {
    cwd: root,
    env: {
      ...process.env,
      GIT_RAIL_PREVIEW_PATH: "million.txt",
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
