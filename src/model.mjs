import path from "node:path";

export function descriptorKey(descriptor) {
  return JSON.stringify(descriptor || { kind: "clean" });
}

export function selectionKey(repoRoot, file) {
  return `${repoRoot}\0${file.path}\0${descriptorKey(file.descriptor)}`;
}

export function buildPathIndex({ tracked = [], againstBase = [], staged = [], unstaged = [] }) {
  const byPath = new Map();
  const ensure = (filePath) => {
    if (!byPath.has(filePath)) {
      byPath.set(filePath, {
        path: filePath,
        basename: path.basename(filePath),
        states: [],
        clean: true,
        descriptor: { kind: "clean" },
      });
    }
    return byPath.get(filePath);
  };
  for (const filePath of tracked) ensure(filePath);
  for (const [scope, files] of [["against", againstBase], ["staged", staged], ["unstaged", unstaged]]) {
    for (const file of files) {
      const entry = ensure(file.path);
      entry.clean = false;
      entry.states.push({ scope, ...file });
      entry.binary ||= Boolean(file.binary);
      entry.conflict ||= file.status === "conflicted";
      entry.oldPath ||= file.oldPath;
      entry.submodule ||= Boolean(file.submodule);
      entry.symlink ||= Boolean(file.symlink);
      entry.executable ||= Boolean(file.executable);
      entry.executableChange ||= Boolean(file.executableChange);
      entry.oldMode ||= file.oldMode;
      entry.newMode ||= file.newMode;
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function displayState(file) {
  if (file.clean) return { status: "clean", additions: 0, deletions: 0 };
  const priority = ["conflicted", "deleted", "renamed", "copied", "added", "type-changed", "modified"];
  const state = [...file.states].sort((a, b) => priority.indexOf(a.status) - priority.indexOf(b.status))[0];
  return {
    status: state?.status || "modified",
    additions: Math.max(0, ...file.states.map((item) => item.additions || 0)),
    deletions: Math.max(0, ...file.states.map((item) => item.deletions || 0)),
    binary: file.binary,
    oldPath: file.oldPath,
  };
}
