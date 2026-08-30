import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cmuxExecutable } from "./cmux-context.mjs";
import { loadRawBytes } from "./preview-provider.mjs";
import { runCommand } from "./process.mjs";

function safeToken(value) {
  return String(value || "").replace(/[^A-Za-z0-9._-]+/g, "_");
}

function parseObject(stdout) {
  const value = JSON.parse(stdout || "{}");
  return value && typeof value === "object" ? value : {};
}

function surfaceRows(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.surfaces || payload?.result?.surfaces || [];
}

function cacheDirectory(environment) {
  const root = environment.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(root, "herdr-gitrail", "cmux-previews");
}

export function cmuxPreviewStatePath({ workspaceId, ownerControlId, ownerSurfaceId, sourceSurfaceId, environment = process.env }) {
  const owner = ownerControlId || ownerSurfaceId || sourceSurfaceId || "dock";
  return path.join(cacheDirectory(environment), `${safeToken(workspaceId)}-${safeToken(owner)}.json`);
}

async function ensureStateDirectory(environment) {
  const directory = cacheDirectory(environment);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  return directory;
}

async function readState(statePath) {
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeState(statePath, state) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, statePath);
}

function nativeEnvironment(environment) {
  // The Dock's CMUX_SURFACE_ID is not a valid main-area split/tab anchor.
  // Explicit targeting wins when available; an empty override makes cmux use
  // the selected pane in the resolved main workspace as a safe fallback.
  return { ...environment, CMUX_SURFACE_ID: "" };
}

function normalizedPanelType(value) {
  return String(value || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function panelTypeMatches(surface, state) {
  const actual = normalizedPanelType(surface.type || surface.panel_type);
  const expected = normalizedPanelType(state.panelType);
  if (!actual || !expected) return false;
  if (actual === expected) return true;
  return expected === "filepreview" && actual === "file";
}

export function surfaceIsOwnedPreview(surface, state) {
  if (!surface || !state?.surfaceId) return false;
  const id = String(surface.id || surface.surface_id || "");
  if (id !== state.surfaceId || surface.dock_scope) return false;
  if (state.previewScriptPath) {
    return normalizedPanelType(surface.type || "terminal") === "terminal"
      && String(surface.initial_command || "").includes(state.previewScriptPath);
  }
  return panelTypeMatches(surface, state);
}

async function listedSurface({ run, cmux, workspaceId, surfaceId, environment }) {
  const result = await run(cmux, ["--json", "--id-format", "both", "list-panels", "--workspace", workspaceId], {
    env: environment,
    timeoutMs: 3_000,
    maxOutputBytes: 2 * 1_024 * 1_024,
  });
  return surfaceRows(parseObject(result.stdout)).find((surface) => (
    String(surface.id || surface.surface_id || "") === surfaceId
  ));
}

async function removeMaterialization(state, environment) {
  if (!state?.materializedDirectory) return;
  const root = path.resolve(cacheDirectory(environment));
  const directory = path.resolve(state.materializedDirectory);
  if (directory === root || !directory.startsWith(`${root}${path.sep}`)) return;
  await fs.rm(directory, { recursive: true, force: true });
}

function previewFilename(previewPath) {
  const filename = path.basename(String(previewPath || ""));
  return filename && filename !== "." && filename !== ".." ? filename : "preview.txt";
}

function rawRevisionToken(revision, previewPath, metadata) {
  const value = String(revision || "unknown");
  for (const candidate of [previewPath, metadata?.oldPath].filter(Boolean)) {
    const suffix = `:${candidate}`;
    if (value.endsWith(suffix)) return value.slice(0, -suffix.length);
  }
  return value.split(":", 1)[0];
}

function displayedRevisionLabel(revision, previewPath, metadata) {
  const token = rawRevisionToken(revision, previewPath, metadata);
  if (token === "worktree") return "Worktree";
  if (token === "index") return "Index";
  if (token === "HEAD") return "HEAD";
  return `Revision ${safeToken(token).slice(0, 12) || "unknown"}`;
}

function revisionIdentity(descriptor, metadata, revision, previewPath) {
  const kind = String(descriptor?.kind || "file");
  const scopeLabels = {
    staged: "Staged",
    unstaged: "Unstaged",
    untracked: "Untracked",
    clean: "Clean",
    filesystem: "Filesystem",
  };
  let scope = scopeLabels[kind] || String(kind || "File");
  if (kind === "commit") scope = `Commit ${String(descriptor.commitHash || "").slice(0, 8)}`;
  if (kind === "workspace" || kind === "against") scope = `Against ${descriptor.baseRef || "base"}`;
  if (metadata?.status === "clean" && revision === "worktree") scope = "Clean";

  const actualToken = rawRevisionToken(revision, previewPath, metadata);
  const expectedToken = kind === "commit" ? String(descriptor.commitHash || "")
    : kind === "staged" ? "index"
      : kind === "against" ? "HEAD"
        : "worktree";
  const actual = displayedRevisionLabel(revision, previewPath, metadata);
  const matchesSelection = kind === "commit"
    ? Boolean(expectedToken) && actualToken.startsWith(expectedToken)
    : actualToken === expectedToken;
  if (kind === "commit" && matchesSelection) return `${scope} · read-only`;
  const deletion = metadata?.status === "deleted" && !matchesSelection ? " before deletion" : "";
  return `${scope} · ${actual}${deletion} · read-only`;
}

function registryStates(stored) {
  if (!stored) return [];
  if (stored.version === 3) return Array.isArray(stored.open) ? stored.open.filter(Boolean) : [];
  if (stored.version === 2) return [stored.active, ...(Array.isArray(stored.pending) ? stored.pending : [])].filter(Boolean);
  return [stored];
}

async function legacyOwnership({ statePath, workspaceId, ownerControlId, environment }) {
  if (!ownerControlId) return { states: [], paths: [], warnings: [] };
  const directory = cacheDirectory(environment);
  const prefix = `${safeToken(workspaceId)}-`;
  const states = [];
  const paths = [];
  const warnings = [];
  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return { states, paths, warnings };
    throw error;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".json")) continue;
    const legacyPath = path.join(directory, entry);
    if (legacyPath === statePath) continue;
    let stored;
    try {
      stored = await readState(legacyPath);
    } catch (error) {
      warnings.push(`legacy preview ownership unavailable: ${error.message}`);
      continue;
    }
    const candidates = registryStates(stored).filter((candidate) => (
      candidate?.workspaceId === workspaceId
      && (!candidate.ownerControlId || candidate.ownerControlId === ownerControlId)
    ));
    if (!candidates.length) continue;
    states.push(...candidates);
    paths.push(legacyPath);
  }
  return { states, paths, warnings };
}

function materializedRelativePath(previewPath) {
  const parts = String(previewPath || "").replaceAll("\\", "/").split("/").filter((part) => part && part !== "." && part !== "..");
  const filename = previewFilename(parts.pop() || previewPath);
  return path.join(...parts.map((part) => safeToken(part).slice(0, 80)), filename);
}

async function materializeNativeFile({ bytes, previewPath, workspaceId, ownerIdentity, revisionLabel, environment }) {
  const root = await ensureStateDirectory(environment);
  const revisionToken = safeToken(revisionLabel).slice(0, 80);
  const prefix = `${safeToken(workspaceId)}-${safeToken(ownerIdentity || "dock")}-${revisionToken}-file-`;
  const directory = await fs.mkdtemp(path.join(root, prefix));
  const filePath = path.join(directory, materializedRelativePath(previewPath));
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(filePath, bytes, { flag: "wx", mode: 0o400 });
    await fs.chmod(filePath, 0o400);
    return { directory, filePath };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function targetArguments({ workspaceId, targetSurfaceId }) {
  const args = ["--workspace", workspaceId];
  if (targetSurfaceId) args.push("--surface", targetSurfaceId);
  return args;
}

function fileOpenPayload(payload) {
  const entry = Array.isArray(payload.opened)
    ? payload.opened.find((candidate) => candidate?.kind === "file")
    : null;
  return entry?.payload || payload;
}

async function openNativeFile({
  run, cmux, cwd, workspaceId, targetSurfaceId, ownerSurfaceId, ownerControlId, previewPath,
  repoRoot, descriptor, metadata, maxFileBytes, tabName, environment, loadRawContent,
}) {
  const raw = await loadRawContent({ repoRoot, filePath: previewPath, descriptor, metadata, maxFileBytes });
  const revisionLabel = revisionIdentity(descriptor, metadata, raw.revision, previewPath);
  const materialized = await materializeNativeFile({
    bytes: raw.bytes,
    previewPath,
    workspaceId,
    ownerIdentity: ownerControlId || ownerSurfaceId,
    revisionLabel,
    environment,
  });
  try {
    const result = await run(cmux, [
      "--json", "--id-format", "both", "open", materialized.filePath,
      ...targetArguments({ workspaceId, targetSurfaceId }), "--focus", "true",
    ], {
      cwd,
      env: nativeEnvironment(environment),
      timeoutMs: 8_000,
      maxOutputBytes: 512 * 1_024,
    });
    const payload = fileOpenPayload(parseObject(result.stdout));
    const surfaceId = String(payload.surface_id || "");
    const panelType = String(payload.panel_type || "");
    if (surfaceId && !panelType) {
      try {
        await run(cmux, ["close-surface", "--workspace", workspaceId, "--surface", surfaceId], {
          cwd,
          env: nativeEnvironment(environment),
          timeoutMs: 3_000,
          maxOutputBytes: 256 * 1_024,
        });
      } catch (closeError) {
        throw new Error(`cmux returned an incomplete native preview identity; partially opened surface could not be closed: ${closeError.message}`);
      }
      throw new Error("cmux returned an incomplete native preview identity; partially opened surface was closed");
    }
    let renameWarning = "";
    if (surfaceId && panelType) {
      try {
        await run(cmux, [
          "rename-tab", "--workspace", workspaceId, "--surface", surfaceId,
          "--title", `${tabName || previewFilename(previewPath)} · ${revisionLabel}`,
        ], {
          cwd,
          env: nativeEnvironment(environment),
          timeoutMs: 3_000,
          maxOutputBytes: 256 * 1_024,
        });
      } catch (error) {
        renameWarning = `native tab identity unavailable: ${error.message}`;
      }
    }
    return {
      surfaceId,
      panelType,
      materializedDirectory: materialized.directory,
      revision: raw.revision,
      revisionLabel,
      renameWarning,
      viewer: "file",
    };
  } catch (error) {
    await fs.rm(materialized.directory, { recursive: true, force: true });
    throw error;
  }
}

export async function openCmuxPreview({
  run = runCommand,
  cmux = cmuxExecutable(),
  cwd,
  workspaceId,
  targetSurfaceId = "",
  ownerSurfaceId = "",
  ownerControlId = "",
  previewPath,
  repoRoot,
  descriptor = { kind: "clean" },
  metadata = {},
  maxFileBytes = 4 * 1_024 * 1_024,
  tabName = "Preview",
  environment = process.env,
  loadRawContent = loadRawBytes,
  writeOwnership = writeState,
}) {
  if (!workspaceId) throw new Error("cmux did not expose the selected main workspace for the preview");
  const statePath = cmuxPreviewStatePath({ workspaceId, ownerControlId, ownerSurfaceId, environment });
  await ensureStateDirectory(environment);
  const stored = await readState(statePath);
  const legacy = await legacyOwnership({ statePath, workspaceId, ownerControlId, environment });
  const trackedStates = [...registryStates(stored), ...legacy.states];
  const opened = await openNativeFile({
    run, cmux, cwd, workspaceId, targetSurfaceId, ownerSurfaceId, ownerControlId, previewPath,
    repoRoot, descriptor, metadata, maxFileBytes, tabName, environment, loadRawContent,
  });
  if (!opened.surfaceId || !opened.panelType) {
    await removeMaterialization(opened, environment);
    throw new Error("cmux did not return a native main-area preview surface id and type");
  }

  const state = {
    surfaceId: opened.surfaceId,
    workspaceId,
    ownerSurfaceId,
    ownerControlId,
    panelType: opened.panelType,
    viewer: opened.viewer,
    ...(opened.materializedDirectory ? { materializedDirectory: opened.materializedDirectory } : {}),
  };
  const previousStates = trackedStates
    .filter((candidate) => candidate?.surfaceId && candidate.surfaceId !== opened.surfaceId)
    .filter((candidate, index, candidates) => candidates.findIndex((other) => other.surfaceId === candidate.surfaceId) === index);
  const ownedRegistry = { version: 3, open: [...previousStates, state] };
  try {
    await writeOwnership(statePath, ownedRegistry);
  } catch (error) {
    try {
      await run(cmux, ["close-surface", "--workspace", workspaceId, "--surface", opened.surfaceId], {
        env: nativeEnvironment(environment),
        timeoutMs: 3_000,
        maxOutputBytes: 256 * 1_024,
      });
      await removeMaterialization(state, environment);
    } catch (closeError) {
      throw new Error(`cmux preview ownership could not be recorded: ${error.message}; newly opened preview could not be closed: ${closeError.message}`);
    }
    throw new Error(`cmux preview ownership could not be recorded; newly opened preview was closed: ${error.message}`);
  }

  const retained = [];
  const cleanupWarnings = [...legacy.warnings];
  for (const legacyPath of legacy.paths) {
    try {
      await fs.unlink(legacyPath);
    } catch (error) {
      if (error.code !== "ENOENT") cleanupWarnings.push(`legacy preview ownership could not be removed: ${error.message}`);
    }
  }
  for (const previousState of previousStates) {
    try {
      const surface = await listedSurface({
        run,
        cmux,
        workspaceId: previousState.workspaceId,
        surfaceId: previousState.surfaceId,
        environment: nativeEnvironment(environment),
      });
      if (surface) retained.push(previousState);
      else await removeMaterialization(previousState, environment);
    } catch (error) {
      retained.push(previousState);
      cleanupWarnings.push(`open preview state could not be refreshed: ${error.message}`);
    }
  }
  if (retained.length !== previousStates.length) {
    try {
      await writeOwnership(statePath, { version: 3, open: [...retained, state] });
    } catch (error) {
      cleanupWarnings.push(`preview cleanup state could not be updated: ${error.message}`);
    }
  }
  return {
    surfaceId: opened.surfaceId,
    cleanupWarning: cleanupWarnings.join("; "),
    renameWarning: opened.renameWarning,
    viewer: opened.viewer,
    revision: opened.revision,
    revisionLabel: opened.revisionLabel,
  };
}
