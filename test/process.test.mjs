import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCommand, runGit, withGitProcessContext } from "../src/process.mjs";

test("Git status never refreshes the index even when caller options enable optional locks", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-no-locks-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_OPTIONAL_LOCKS: "1" } };
  await runGit(root, ["init"], options);
  const tracked = path.join(root, "tracked.txt");
  await fs.writeFile(tracked, "unchanged content\n");
  await runGit(root, ["add", "tracked.txt"], options);
  // Make cached file metadata stale without changing the contents. Ordinary
  // status rewrites the index to cache this new timestamp.
  const oldTime = new Date("2001-01-01T00:00:00Z");
  await fs.utimes(tracked, oldTime, oldTime);
  const index = path.join(root, ".git", "index");
  const before = await fs.readFile(index);
  const beforeStat = await fs.stat(index);
  const status = await runGit(root, ["status", "--porcelain=v2"], options);
  assert.match(status.stdout, /tracked\.txt/);
  assert.deepEqual(await fs.readFile(index), before);
  assert.equal((await fs.stat(index)).ino, beforeStat.ino);
  await assert.rejects(fs.access(`${index}.lock`), { code: "ENOENT" });

  // Reads must also work while another Git operation owns the index lock.
  await fs.writeFile(`${index}.lock`, "another operation\n");
  assert.equal((await runGit(root, ["status", "--porcelain=v2"], options)).stdout, status.stdout);
  assert.equal(await fs.readFile(`${index}.lock`, "utf8"), "another operation\n");
  assert.deepEqual(await fs.readFile(index), before);
});

test("concurrent Git process contexts keep config and index environments isolated", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-process-context-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await runGit(root, ["init"]);
  const indexA = path.join(root, "index-a");
  const indexB = path.join(root, "index-b");
  const base = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
  };
  const context = (marker, indexPath) => ({
    environment: {
      ...base,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "siderail.marker",
      GIT_CONFIG_VALUE_0: marker,
      GIT_INDEX_FILE: indexPath,
    },
  });
  const inspect = (marker, indexPath, delay) => withGitProcessContext(context(marker, indexPath), async () => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    const [configured, selectedIndex] = await Promise.all([
      runGit(root, ["config", "--get", "siderail.marker"]),
      runGit(root, ["rev-parse", "--git-path", "index"]),
    ]);
    return [configured.stdout.trim(), path.resolve(root, selectedIndex.stdout.trim())];
  });

  assert.deepEqual(await Promise.all([
    inspect("alpha", indexA, 10),
    inspect("beta", indexB, 0),
  ]), [
    ["alpha", indexA],
    ["beta", indexB],
  ]);
});

test("process stdout remains text by default and can preserve exact bytes", async () => {
  const text = await runCommand(process.execPath, ["-e", "process.stdout.write('hello')"]);
  assert.equal(text.stdout, "hello");
  const bytes = await runCommand(process.execPath, ["-e", "process.stdout.write(Buffer.from([0x66, 0x80, 0x6f]))"], { stdoutEncoding: null });
  assert.deepEqual(bytes.stdout, Buffer.from([0x66, 0x80, 0x6f]));
});

test("strict process decoding rejects invalid UTF-8 instead of merging byte identities", async () => {
  await assert.rejects(
    runCommand(process.execPath, ["-e", "process.stdout.write(Buffer.from([0x66, 0x80, 0x6f]))"], { stdoutEncoding: "utf8-strict" }),
    (error) => error.kind === "invalid-output" && /not valid UTF-8/.test(error.message),
  );
});

test("process input can be supplied as exact bytes", async () => {
  const input = Buffer.from([0x66, 0x00, 0x80, 0x6f]);
  const result = await runCommand(
    process.execPath,
    ["-e", "process.stdin.pipe(process.stdout)"],
    { stdinInput: input, stdoutEncoding: null },
  );
  assert.deepEqual(result.stdout, input);
});

test("timeouts settle without waiting for descendants that inherited output pipes", async () => {
  const script = [
    "const { spawn } = require('node:child_process')",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['ignore', 1, 2] })",
    "child.unref()",
  ].join(";");
  const startedAt = Date.now();
  await assert.rejects(
    () => runCommand(process.execPath, ["-e", script], { timeoutMs: 50 }),
    (error) => error.kind === "timeout",
  );
  assert.ok(Date.now() - startedAt < 1_000);
});

test("timeouts terminate descendants in the command process group", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-process-tree-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "survived");
  const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 300)`;
  const parent = [
    "const { spawn } = require('node:child_process')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 1, 2] })`,
    "child.unref()",
    "setTimeout(() => {}, 5000)",
  ].join(";");
  await assert.rejects(
    () => runCommand(process.execPath, ["-e", parent], { timeoutMs: 50 }),
    (error) => error.kind === "timeout",
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  await assert.rejects(() => fs.access(marker), (error) => error.code === "ENOENT");
});

test("abort signals terminate and await the command process group", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "siderail-process-abort-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "survived");
  const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 300)`;
  const parent = [
    "const { spawn } = require('node:child_process')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 1, 2] })`,
    "child.unref()",
    "setTimeout(() => {}, 5000)",
  ].join(";");
  const controller = new globalThis.AbortController();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(
    () => runCommand(process.execPath, ["-e", parent], {
      signal: controller.signal,
      timeoutMs: 5_000,
      killGraceMs: 50,
      waitForTermination: true,
    }),
    (error) => error.kind === "aborted",
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  await assert.rejects(() => fs.access(marker), (error) => error.code === "ENOENT");
});
