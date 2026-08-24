import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCommand } from "../src/process.mjs";

test("process stdout remains text by default and can preserve exact bytes", async () => {
  const text = await runCommand(process.execPath, ["-e", "process.stdout.write('hello')"]);
  assert.equal(text.stdout, "hello");
  const bytes = await runCommand(process.execPath, ["-e", "process.stdout.write(Buffer.from([0x66, 0x80, 0x6f]))"], { stdoutEncoding: null });
  assert.deepEqual(bytes.stdout, Buffer.from([0x66, 0x80, 0x6f]));
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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-process-tree-"));
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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-process-abort-"));
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
