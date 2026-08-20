import assert from "node:assert/strict";
import test from "node:test";
import { runCommand } from "../src/process.mjs";

test("process stdout remains text by default and can preserve exact bytes", async () => {
  const text = await runCommand(process.execPath, ["-e", "process.stdout.write('hello')"]);
  assert.equal(text.stdout, "hello");
  const bytes = await runCommand(process.execPath, ["-e", "process.stdout.write(Buffer.from([0x66, 0x80, 0x6f]))"], { stdoutEncoding: null });
  assert.deepEqual(bytes.stdout, Buffer.from([0x66, 0x80, 0x6f]));
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
