import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const LOCK_RETRY_MS = 50;
const LOCK_OWNER_GRACE_MS = 500;
const LOCK_STALE_MS = 30_000;

function safeToken(value) {
  return String(value || "").replace(/[^A-Za-z0-9._-]+/g, "_");
}

export function paneStateDirectory(environment = process.env) {
  const cacheRoot = environment.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(cacheRoot, "herdr-gitrail", "panes");
}

export function paneStatePath({ workspaceId, tabId, entrypoint, environment = process.env }) {
  const scope = tabId || workspaceId;
  return path.join(
    paneStateDirectory(environment),
    `${safeToken(workspaceId)}-${safeToken(scope)}-${safeToken(entrypoint)}`,
  );
}

export function legacyPaneStatePath({ workspaceId, entrypoint, environment = process.env }) {
  return path.join(
    paneStateDirectory(environment),
    `${safeToken(workspaceId)}-${safeToken(entrypoint)}`,
  );
}

export async function ensurePaneStateDirectory(environment = process.env) {
  const directory = paneStateDirectory(environment);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  return directory;
}

export async function readPaneState(statePath) {
  try {
    const [paneId = "", cwd = ""] = (await fs.readFile(statePath, "utf8")).split(/\r?\n/);
    return paneId ? { paneId, cwd } : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writePaneState(statePath, paneId, cwd = "") {
  const temporary = `${statePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${paneId}\n${cwd}\n`, { mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, statePath);
}

async function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function lockOwner(lockPath) {
  try {
    return JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

async function staleLock(lockPath, now, { staleMs, ownerGraceMs }) {
  let stat;
  try {
    stat = await fs.stat(lockPath);
  } catch (error) {
    return error.code === "ENOENT";
  }
  const owner = await lockOwner(lockPath);
  const createdAt = Number.isFinite(owner?.createdAt) ? owner.createdAt : stat.mtimeMs;
  const age = Math.max(0, now() - createdAt);
  if (!owner) return age >= ownerGraceMs;
  if (await ownerAlive(owner.pid)) return false;
  return age >= Math.min(staleMs, ownerGraceMs);
}

async function claimStaleLock(lockPath, now, options) {
  const reclaimPath = path.join(lockPath, ".reclaim");
  const nonce = randomUUID();
  try {
    await fs.mkdir(reclaimPath, { mode: 0o700 });
    await fs.writeFile(
      path.join(reclaimPath, "owner.json"),
      `${JSON.stringify({ pid: process.pid, createdAt: now(), nonce })}\n`,
      { mode: 0o600 },
    );
  } catch (error) {
    if (error.code === "ENOENT") return false;
    if (error.code !== "EEXIST") throw error;
    if (await staleLock(reclaimPath, now, options)) {
      await fs.rm(reclaimPath, { recursive: true, force: true });
    }
    return false;
  }
  if (await staleLock(lockPath, now, options)) {
    await fs.rm(lockPath, { recursive: true, force: true });
    return true;
  }
  const owner = await lockOwner(reclaimPath);
  if (owner?.nonce === nonce) await fs.rm(reclaimPath, { recursive: true, force: true });
  return false;
}

export async function acquirePaneStateLock(statePath, {
  timeoutMs = 12_000,
  staleMs = LOCK_STALE_MS,
  ownerGraceMs = LOCK_OWNER_GRACE_MS,
  now = Date.now,
} = {}) {
  const lockPath = `${statePath}.lock`;
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    const nonce = randomUUID();
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      await fs.writeFile(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, createdAt: now(), nonce })}\n`,
        { mode: 0o600 },
      );
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const owner = await lockOwner(lockPath);
        if (owner?.nonce === nonce) await fs.rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await staleLock(lockPath, now, { staleMs, ownerGraceMs })) {
        await claimStaleLock(lockPath, now, { staleMs, ownerGraceMs });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  throw new Error("GitRail pane creation is already in progress for this tab");
}

export async function removeLegacyPaneState(options) {
  await fs.rm(legacyPaneStatePath(options), { force: true });
}

export async function cleanupTabPaneState({ workspaceId, tabId, environment = process.env }) {
  const directory = await ensurePaneStateDirectory(environment);
  const prefix = `${safeToken(workspaceId)}-${safeToken(tabId)}-`;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.name.startsWith(prefix))
    .map((entry) => fs.rm(path.join(directory, entry.name), { recursive: entry.isDirectory(), force: true })));
}

export async function cleanupWorkspacePaneState({ workspaceId, environment = process.env }) {
  const directory = await ensurePaneStateDirectory(environment);
  const prefix = `${safeToken(workspaceId)}-`;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.name.startsWith(prefix))
    .map((entry) => fs.rm(path.join(directory, entry.name), { recursive: entry.isDirectory(), force: true })));
}

export async function pruneMissingPaneState(livePaneIds, environment = process.env) {
  const directory = await ensurePaneStateDirectory(environment);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const statePath = path.join(directory, entry.name);
    const state = await readPaneState(statePath);
    if (state && !livePaneIds.has(state.paneId)) await fs.rm(statePath, { force: true });
  }
}
