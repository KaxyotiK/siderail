import path from "node:path";

function descriptorKey(descriptor) {
  return JSON.stringify(descriptor || { kind: "clean" });
}

export function selectionKey(repoRoot, file) {
  return `${repoRoot}\0${file.path}\0${descriptorKey(file.descriptor)}`;
}

export function selectionPathKey(repoRoot, file) {
  return `${repoRoot}\0${file.path}`;
}

export function reconcileSelectionIdentity(selectedIdentity, selectedPathIdentity, items) {
  if (!selectedIdentity || items.some((item) => item.identity === selectedIdentity)) return selectedIdentity;
  return items.find((item) => item.pathIdentity === selectedPathIdentity)?.identity || selectedIdentity;
}

export function buildPathIndex({ tracked = [], againstBase = [], staged = [], unstaged = [], untracked = [] }) {
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
  for (const trackedFile of tracked) {
    const filePath = typeof trackedFile === "string" ? trackedFile : trackedFile.path;
    const entry = ensure(filePath);
    if (typeof trackedFile === "object") {
      entry.submodule ||= Boolean(trackedFile.submodule);
      entry.symlink ||= Boolean(trackedFile.symlink);
      entry.executable ||= Boolean(trackedFile.executable);
      entry.mode ||= trackedFile.mode;
    }
  }
  for (const [scope, files] of [["against", againstBase], ["staged", staged], ["unstaged", unstaged], ["untracked", untracked]]) {
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

export function filesAgainstBase(files, workspaceChanges, workspaceDescriptor) {
  const byPath = new Map(workspaceChanges.map((file) => [file.path, file]));
  return files.flatMap((file) => {
    const untracked = file.states.find((state) => state.descriptor?.kind === "untracked");
    if (untracked) return [{ ...file, ...untracked }];
    if (file.states.some((state) => state.descriptor?.kind === "unstaged" && state.status === "deleted")) return [];
    const workspaceChange = byPath.get(file.path);
    if (workspaceChange) return workspaceChange.status === "deleted" ? [] : [{ ...file, ...workspaceChange }];
    if (!workspaceDescriptor && file.states.length) {
      const state = file.states.find((item) => item.descriptor?.kind === "staged") || file.states[0];
      return file.states.some((item) => item.status === "deleted") ? [] : [{ ...file, ...state }];
    }
    return [{ ...file, status: "clean", additions: 0, deletions: 0, descriptor: workspaceDescriptor || { kind: "clean" } }];
  });
}
