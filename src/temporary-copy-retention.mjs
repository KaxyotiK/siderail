import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

const EXTERNAL_COPY_RETENTION_MS = 15 * 60 * 1_000;
const INITIALIZATION_GRACE_MS = 5_000;
const PREVIEW_PREFIX = "herdr-gitrail-preview-";
const STATE_DIRECTORY_NAME = "herdr-gitrail-retention";
const WORKER_LOCK_NAME = "worker.lock";
const REQUESTS_DIRECTORY_NAME = "requests";
const CLEANER_PATH = fileURLToPath(new URL("../scripts/temporary-copy-cleaner.mjs", import.meta.url));

function ownedDirectory(directory, temporaryRoot) {
  const resolved = path.resolve(directory);
  const root = path.resolve(temporaryRoot);
  if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith(PREVIEW_PREFIX)) {
    throw new Error("Refusing to retain a directory outside GitRail's private preview area");
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("Refusing to retain a preview directory not owned by this user");
  }
  return resolved;
}

function ensureOwnedStateDirectory(directory) {
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("GitRail retention state is not an owner-controlled directory");
  }
  fs.chmodSync(directory, 0o700);
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

function workerOwner(lockDirectory) {
  try { return JSON.parse(fs.readFileSync(path.join(lockDirectory, "owner.json"), "utf8")); }
  catch { return null; }
}

function releaseWorkerClaim(lockDirectory, pid) {
  const owner = workerOwner(lockDirectory);
  if (owner?.pid !== pid) return;
  try { fs.rmSync(lockDirectory, { recursive: true, force: true }); } catch {}
}

function claimWorker(lockDirectory) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockDirectory, { mode: 0o700 });
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = workerOwner(lockDirectory);
      if (processAlive(owner?.pid)) return false;
      let ageMs = Infinity;
      try { ageMs = Date.now() - fs.statSync(lockDirectory).mtimeMs; } catch {}
      if (!owner && ageMs < INITIALIZATION_GRACE_MS) return false;
      try { fs.rmSync(lockDirectory, { recursive: true, force: true }); }
      catch { return false; }
    }
  }
  return false;
}

function retentionPaths(temporaryRoot) {
  const root = path.resolve(temporaryRoot);
  const stateDirectory = path.join(root, STATE_DIRECTORY_NAME);
  const requestsDirectory = path.join(stateDirectory, REQUESTS_DIRECTORY_NAME);
  const lockDirectory = path.join(stateDirectory, WORKER_LOCK_NAME);
  return { root, stateDirectory, requestsDirectory, lockDirectory };
}

export function retainExternalPreviewCopy(directory, {
  delayMs = EXTERNAL_COPY_RETENTION_MS,
  temporaryRoot = os.tmpdir(),
  spawnProcess = spawn,
  onError = null,
} = {}) {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new Error("Preview retention delay must be a non-negative integer");
  const target = ownedDirectory(directory, temporaryRoot);
  const paths = retentionPaths(temporaryRoot);
  ensureOwnedStateDirectory(paths.stateDirectory);
  ensureOwnedStateDirectory(paths.requestsDirectory);
  const requestPath = path.join(paths.requestsDirectory, `${randomUUID()}.json`);
  fs.writeFileSync(requestPath, `${JSON.stringify({ directory: target, deadline: Date.now() + delayMs })}\n`, { mode: 0o600 });
  if (!claimWorker(paths.lockDirectory)) return { workerStarted: false, cleaner: null };

  const cleaner = spawnProcess(process.execPath, [CLEANER_PATH, paths.root, paths.lockDirectory], {
    detached: true,
    stdio: "ignore",
    shell: false,
  });
  fs.writeFileSync(path.join(paths.lockDirectory, "owner.json"), `${JSON.stringify({ pid: cleaner.pid })}\n`, { mode: 0o600 });
  cleaner.on("error", (error) => {
    releaseWorkerClaim(paths.lockDirectory, cleaner.pid);
    onError?.(error);
  });
  cleaner.unref();
  return { workerStarted: true, cleaner };
}

function removeRequest(requestPath) {
  try { fs.rmSync(requestPath, { force: true }); } catch {}
}

function sweepRetentionRequests(temporaryRoot, requestsDirectory, now = Date.now) {
  let pending = false;
  let entries = [];
  try { entries = fs.readdirSync(requestsDirectory, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const requestPath = path.join(requestsDirectory, entry.name);
    let request;
    try { request = JSON.parse(fs.readFileSync(requestPath, "utf8")); }
    catch { removeRequest(requestPath); continue; }
    let directory;
    try { directory = ownedDirectory(request.directory, temporaryRoot); }
    catch { removeRequest(requestPath); continue; }
    if (!Number.isSafeInteger(request.deadline)) { removeRequest(requestPath); continue; }
    if (request.deadline > now()) { pending = true; continue; }
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      removeRequest(requestPath);
    } catch { pending = true; }
  }
  return pending;
}

export async function runTemporaryCopyCleaner(temporaryRoot, lockDirectory, {
  scanIntervalMs = 1_000,
} = {}) {
  const paths = retentionPaths(temporaryRoot);
  const lock = path.resolve(lockDirectory);
  if (lock !== paths.lockDirectory) throw new Error("Invalid GitRail retention-worker directory");
  while (true) {
    while (sweepRetentionRequests(paths.root, paths.requestsDirectory)) {
      await new Promise((resolve) => setTimeout(resolve, scanIntervalMs));
    }
    releaseWorkerClaim(lock, process.pid);
    if (!sweepRetentionRequests(paths.root, paths.requestsDirectory)) return;
    if (!claimWorker(lock)) return;
    fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });
  }
}
