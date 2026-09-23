import fs from "node:fs";
import path from "node:path";
import { clearInterval, setInterval } from "node:timers";
import { fileURLToPath } from "node:url";

// node-launcher.sh reruns its target from the same path when it exits with
// this code, so a replaced install restarts on its new code in place.
export const RESTART_EXIT_CODE = 75;

const RAIL_ENTRYPOINT = "scripts/siderail.mjs";
const SIGNATURE_TREES = ["src", "scripts"];

function identity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

export const INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The files a restart must find: the script that was launched (the cmux
// bootstrap imports the rail, so both are needed there) and the rail itself.
export function launchEntrypoints(root = INSTALL_ROOT, argv = process.argv, cwd = process.cwd()) {
  const entrypoints = new Set([RAIL_ENTRYPOINT]);
  if (argv[1]) {
    const relative = path.relative(root, path.resolve(cwd, argv[1]));
    if (relative.endsWith(".mjs") && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      entrypoints.add(relative.split(path.sep).join("/"));
    }
  }
  return [...entrypoints].sort();
}

// Captured when an entrypoint first loads this module, before it awaits
// anything: a swap that lands while the rail is still starting would otherwise
// become the baseline and go unnoticed. The parent is the Node launcher, whose
// death leaves the rail orphaned.
const launchState = (() => {
  let installIdentity;
  try { installIdentity = identity(fs.statSync(INSTALL_ROOT)); } catch {}
  let entrypoints = [RAIL_ENTRYPOINT];
  try { entrypoints = launchEntrypoints(); } catch {}
  return { installIdentity, entrypoints, parentPid: process.ppid };
})();

export function launchInstallContext() {
  return { ...launchState, entrypoints: [...launchState.entrypoints] };
}

// Paths and sizes of the package manifest and every source file, or null while
// any of them is missing or empty. Equal signatures on consecutive ticks mean
// extraction has paused long enough to try; they do not prove completion, which
// is why the launcher also retries a restart that fails early.
function treeSignature(root, fileSystem) {
  const entries = [];
  try {
    JSON.parse(fileSystem.readFileSync(path.join(root, "package.json"), "utf8"));
    entries.push(`package.json:${fileSystem.statSync(path.join(root, "package.json")).size}`);
    for (const tree of SIGNATURE_TREES) {
      const files = [];
      const visit = (relative) => {
        for (const entry of fileSystem.readdirSync(path.join(root, relative), { withFileTypes: true })) {
          const child = `${relative}/${entry.name}`;
          if (entry.isDirectory()) visit(child);
          else if (entry.isFile()) files.push(`${child}:${fileSystem.statSync(path.join(root, child)).size}`);
        }
      };
      visit(tree);
      if (!files.length) return null;
      entries.push(...files);
    }
  } catch {
    return null;
  }
  return entries.sort().join("\n");
}

// Package managers upgrade by swapping the install directory (npm renames the
// old one aside, deletes it, and extracts the new version at the same path),
// which leaves a running rail on stale code and a working directory that no
// longer proves ownership. Report a swap once the new tree holds the launch
// entrypoints and has stopped changing between two ticks.
export function watchInstallReplacement({
  root,
  original,
  entrypoints = [RAIL_ENTRYPOINT],
  parentPid,
  intervalMs = 2_000,
  onReplaced,
  onOrphaned = () => {},
  readParentPid = () => process.ppid,
  fileSystem = fs,
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  const baseline = original ?? identity(fileSystem.statSync(root));
  let timer = null;
  let previousSignature = null;
  const close = () => {
    if (timer) clearTimer(timer);
    timer = null;
  };
  const check = () => {
    if (parentPid !== undefined && readParentPid() !== parentPid) {
      close();
      onOrphaned();
      return "orphaned";
    }
    try {
      if (identity(fileSystem.statSync(root)) === baseline) return false;
      for (const entrypoint of entrypoints) {
        if (!fileSystem.statSync(path.join(root, entrypoint)).isFile()) throw new Error("not a file");
      }
    } catch {
      previousSignature = null;
      return false;
    }
    const signature = treeSignature(root, fileSystem);
    const settled = signature !== null && signature === previousSignature;
    previousSignature = signature;
    if (!settled) return false;
    close();
    onReplaced();
    return true;
  };
  timer = setTimer(check, intervalMs);
  timer?.unref?.();
  return { check, close };
}
