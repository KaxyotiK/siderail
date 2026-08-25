import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  retainExternalPreviewCopy,
  runTemporaryCopyCleaner,
} from "../src/temporary-copy-retention.mjs";

async function waitUntilRemoved(directory, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await fs.access(directory); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`retained preview directory was not removed: ${directory}`);
}

async function retentionRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-retention-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("one shared worker retains then removes many owner-only preview directories", async (t) => {
  const root = await retentionRoot(t);
  const directories = await Promise.all(Array.from({ length: 12 }, async () => {
    const directory = await fs.mkdtemp(path.join(root, "herdr-gitrail-preview-"));
    await fs.writeFile(path.join(directory, "revision.md"), "historical\n", { mode: 0o400 });
    return directory;
  }));
  const hostileBasename = path.join(directories[0], ".herdr-gitrail-retain-until");
  await fs.writeFile(hostileBasename, "repository file bytes\n", { mode: 0o400 });
  const results = directories.map((directory) => retainExternalPreviewCopy(directory, {
    delayMs: 250,
    temporaryRoot: root,
  }));
  assert.equal(results.filter((result) => result.workerStarted).length, 1);
  assert.equal(await fs.readFile(hostileBasename, "utf8"), "repository file bytes\n");
  await Promise.all(directories.map((directory) => fs.access(path.join(directory, "revision.md"))));
  await Promise.all(directories.map((directory) => waitUntilRemoved(directory)));
});

test("shared cleanup refuses arbitrary temporary directories", async (t) => {
  const root = await retentionRoot(t);
  const directory = await fs.mkdtemp(path.join(root, "not-gitrail-"));
  assert.throws(() => retainExternalPreviewCopy(directory, { delayMs: 0, temporaryRoot: root }), /Refusing to retain/);
  const lookalikeFile = path.join(root, "herdr-gitrail-preview-file");
  await fs.writeFile(lookalikeFile, "not a directory\n");
  assert.throws(() => retainExternalPreviewCopy(lookalikeFile, { delayMs: 0, temporaryRoot: root }), /not owned by this user/);
  const valid = await fs.mkdtemp(path.join(root, "herdr-gitrail-preview-"));
  assert.throws(() => retainExternalPreviewCopy(valid, { delayMs: -1, temporaryRoot: root }), /non-negative integer/);

  const blockedRoot = await retentionRoot(t);
  const blockedPreview = await fs.mkdtemp(path.join(blockedRoot, "herdr-gitrail-preview-"));
  await fs.writeFile(path.join(blockedRoot, "herdr-gitrail-retention"), "not a state directory\n");
  assert.throws(
    () => retainExternalPreviewCopy(blockedPreview, { delayMs: 0, temporaryRoot: blockedRoot }),
    /not an owner-controlled directory/,
  );
});

test("cleanup-worker spawn errors are contained and reported", async (t) => {
  const root = await retentionRoot(t);
  const directory = await fs.mkdtemp(path.join(root, "herdr-gitrail-preview-"));
  const stateDirectory = path.join(root, "herdr-gitrail-retention");
  const requestsDirectory = path.join(stateDirectory, "requests");
  await fs.mkdir(requestsDirectory, { recursive: true, mode: 0o777 });
  await fs.chmod(stateDirectory, 0o777);
  await fs.chmod(requestsDirectory, 0o777);
  const cleaner = new EventEmitter();
  cleaner.pid = 2_147_483_647;
  cleaner.unref = () => {};
  let reported;
  retainExternalPreviewCopy(directory, {
    temporaryRoot: root,
    spawnProcess: () => cleaner,
    onError: (error) => { reported = error; },
  });
  const failure = new Error("process table full");
  cleaner.emit("error", failure);
  assert.equal(reported, failure);
  assert.equal((await fs.stat(stateDirectory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(requestsDirectory)).mode & 0o777, 0o700);
});

test("the shared worker directly expires markers and releases its ownership lock", async (t) => {
  const root = await retentionRoot(t);
  const directory = await fs.mkdtemp(path.join(root, "herdr-gitrail-preview-"));
  const cleaner = new EventEmitter();
  cleaner.pid = process.pid;
  cleaner.unref = () => {};
  retainExternalPreviewCopy(directory, {
    delayMs: 20,
    temporaryRoot: root,
    spawnProcess: () => cleaner,
  });
  const requestsDirectory = path.join(root, "herdr-gitrail-retention", "requests");
  await fs.writeFile(path.join(requestsDirectory, "ignored.txt"), "ignored\n");
  await fs.writeFile(path.join(requestsDirectory, "malformed.json"), "not json\n");
  await fs.writeFile(path.join(requestsDirectory, "outside.json"), JSON.stringify({ directory: root, deadline: Date.now() }));
  const invalidDeadlineDirectory = await fs.mkdtemp(path.join(root, "herdr-gitrail-preview-"));
  await fs.writeFile(path.join(requestsDirectory, "invalid-deadline.json"), JSON.stringify({
    directory: invalidDeadlineDirectory,
    deadline: "later",
  }));
  const lockDirectory = path.join(root, "herdr-gitrail-retention", "worker.lock");
  await runTemporaryCopyCleaner(root, lockDirectory, { scanIntervalMs: 5 });
  await assert.rejects(fs.access(directory), (error) => error.code === "ENOENT");
  await assert.rejects(fs.access(lockDirectory), (error) => error.code === "ENOENT");
  await assert.rejects(
    runTemporaryCopyCleaner(root, path.join(root, "herdr-gitrail-retention", "wrong-worker")),
    /Invalid GitRail retention-worker directory/,
  );
});
