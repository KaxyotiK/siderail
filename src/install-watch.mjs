import fs from "node:fs";
import path from "node:path";
import { clearInterval, setInterval } from "node:timers";
import { fileURLToPath } from "node:url";

// node-launcher.sh reruns its target from the same path when it exits with
// this code, so a replaced install restarts on its new code in place.
export const RESTART_EXIT_CODE = 75;

function identity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function readInstallIdentity(root, stat) {
  return identity(stat(root));
}

export const INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Captured when an entrypoint first loads this module, before it awaits
// anything: a swap that lands while the rail is still starting would otherwise
// become the baseline and go unnoticed.
const launchIdentity = (() => {
  try { return readInstallIdentity(INSTALL_ROOT, fs.statSync); } catch { return undefined; }
})();

export function launchInstallIdentity() {
  return launchIdentity;
}

// Package managers upgrade by swapping the install directory (npm renames the
// old one aside and deletes it), which leaves a running rail on stale code and
// a working directory that no longer proves ownership. Report a completed swap
// once: the root path resolves to a different directory whose entrypoint exists.
export function watchInstallReplacement({
  root,
  original,
  entrypoint = "scripts/siderail.mjs",
  intervalMs = 2_000,
  onReplaced,
  stat = fs.statSync,
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  const baseline = original ?? readInstallIdentity(root, stat);
  let timer = null;
  const close = () => {
    if (timer) clearTimer(timer);
    timer = null;
  };
  const check = () => {
    let current;
    try {
      current = identity(stat(root));
      if (current === baseline) return false;
      stat(path.join(root, entrypoint));
    } catch {
      return false;
    }
    close();
    onReplaced();
    return true;
  };
  timer = setTimer(check, intervalMs);
  timer?.unref?.();
  return { check, close };
}
