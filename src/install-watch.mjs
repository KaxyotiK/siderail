import fs from "node:fs";
import path from "node:path";
import { clearInterval, setInterval } from "node:timers";

// node-launcher.sh reruns its target from the same path when it exits with
// this code, so a replaced install restarts on its new code in place.
export const RESTART_EXIT_CODE = 75;

function identity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

// Package managers upgrade by swapping the install directory (npm renames the
// old one aside and deletes it), which leaves a running rail on stale code and
// a working directory that no longer proves ownership. Report a completed swap
// once: the root path resolves to a different directory whose entrypoint exists.
export function watchInstallReplacement({
  root,
  entrypoint = "scripts/siderail.mjs",
  intervalMs = 2_000,
  onReplaced,
  stat = fs.statSync,
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  const original = identity(stat(root));
  let timer = null;
  const close = () => {
    if (timer) clearTimer(timer);
    timer = null;
  };
  const check = () => {
    let current;
    try {
      current = identity(stat(root));
      if (current === original) return false;
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
