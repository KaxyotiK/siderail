import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cmuxPreviewStatePath,
  openCmuxPreview,
  surfaceIsOwnedPreview,
} from "../src/cmux-preview-lifecycle.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitrail-cmux-preview-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, environment: { XDG_CACHE_HOME: root, CMUX_SURFACE_ID: "ambient-dock" } };
}

function previewOptions(environment, run, overrides = {}) {
  return {
    run,
    cmux: "cmux-test",
    cwd: "/repo",
    workspaceId: "main-workspace",
    targetSurfaceId: "main-source",
    ownerSurfaceId: "dock-source",
    previewPath: "README.md",
    repoRoot: "/repo",
    descriptor: { kind: "clean" },
    metadata: { status: "clean" },
    maxFileBytes: 1_024,
    environment,
    loadRawContent: async () => ({ bytes: Buffer.from("# Native\n"), revision: "worktree" }),
    ...overrides,
  };
}

function nativeFileResponse(surfaceId = "new-file", panelType = "markdown") {
  return { stdout: JSON.stringify({ opened: [{ kind: "file", payload: { surface_id: surfaceId, panel_type: panelType } }] }) };
}

test("clean rows open an exact read-only materialization in cmux's native file viewer", async (t) => {
  const { environment } = await fixture(t);
  const statePath = cmuxPreviewStatePath({ workspaceId: "main-workspace", ownerSurfaceId: "dock-source", environment });
  const oldDirectory = path.join(path.dirname(statePath), "old-materialization");
  await fs.mkdir(oldDirectory, { recursive: true });
  await fs.writeFile(path.join(oldDirectory, "README.md"), "old\n");
  await fs.writeFile(statePath, JSON.stringify({
    surfaceId: "old-file",
    workspaceId: "main-workspace",
    ownerSurfaceId: "dock-source",
    panelType: "markdown",
    materializedDirectory: oldDirectory,
  }));

  const calls = [];
  const run = async (_command, args, options) => {
    calls.push({ args, options });
    if (args.includes("open")) return nativeFileResponse();
    if (args.includes("list-panels")) return { stdout: JSON.stringify({ surfaces: [{ id: "old-file", type: "markdown" }] }) };
    return { stdout: "{}" };
  };
  const result = await openCmuxPreview(previewOptions(environment, run));
  assert.deepEqual(result, {
    surfaceId: "new-file",
    cleanupWarning: "",
    renameWarning: "",
    viewer: "file",
    revision: "worktree",
    revisionLabel: "Clean · Worktree · read-only",
  });

  const open = calls.find((call) => call.args.includes("open"));
  assert.deepEqual(open.args.slice(0, 4), ["--json", "--id-format", "both", "open"]);
  assert.equal(open.args.includes("--workspace"), true);
  assert.equal(open.args[open.args.indexOf("--workspace") + 1], "main-workspace");
  assert.equal(open.args[open.args.indexOf("--surface") + 1], "main-source");
  assert.equal(open.args[open.args.indexOf("--focus") + 1], "true");
  assert.equal(open.options.env.CMUX_SURFACE_ID, "");
  const materializedPath = open.args[4];
  assert.equal(path.basename(materializedPath), "README.md");
  assert.match(materializedPath, /Clean_Worktree_read-only-file-/);
  assert.equal(await fs.readFile(materializedPath, "utf8"), "# Native\n");
  assert.equal((await fs.stat(materializedPath)).mode & 0o777, 0o400);
  assert.equal(calls.some((call) => call.args[0] === "close-surface"), false);
  await fs.access(oldDirectory);

  const registry = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(registry.version, 3);
  assert.deepEqual(registry.open.map((entry) => entry.surfaceId), ["old-file", "new-file"]);
  const state = registry.open.at(-1);
  assert.deepEqual({
    surfaceId: state.surfaceId,
    workspaceId: state.workspaceId,
    ownerSurfaceId: state.ownerSurfaceId,
    panelType: state.panelType,
    viewer: state.viewer,
  }, {
    surfaceId: "new-file",
    workspaceId: "main-workspace",
    ownerSurfaceId: "dock-source",
    panelType: "markdown",
    viewer: "file",
  });
  assert.equal(state.materializedDirectory, path.dirname(materializedPath));
});

test("changed rows open their exact selected revision in cmux's native file viewer", async (t) => {
  const { environment } = await fixture(t);
  const calls = [];
  let requested;
  const selectedBytes = Buffer.from("export const selected = true;\n");
  const run = async (_command, args, options) => {
    calls.push({ args, options });
    return nativeFileResponse("changed-file", "filepreview");
  };
  const result = await openCmuxPreview(previewOptions(environment, run, {
    previewPath: "src/a.mjs",
    descriptor: { kind: "staged" },
    metadata: { status: "modified" },
    loadRawContent: async (options) => {
      requested = options;
      return { bytes: selectedBytes, revision: "index" };
    },
  }));
  assert.deepEqual(result, {
    surfaceId: "changed-file",
    cleanupWarning: "",
    renameWarning: "",
    viewer: "file",
    revision: "index",
    revisionLabel: "Staged · Index · read-only",
  });
  assert.equal(requested.descriptor.kind, "staged");
  assert.equal(requested.maxFileBytes, 1_024);
  assert.deepEqual(calls[0].args.slice(0, 4), ["--json", "--id-format", "both", "open"]);
  assert.equal(calls[0].args[calls[0].args.indexOf("--surface") + 1], "main-source");
  assert.deepEqual(await fs.readFile(calls[0].args[4]), selectedBytes);
  assert.match(calls[0].args[4], /Staged_Index_read-only-file-/);
  assert.equal(calls[0].options.env.CMUX_SURFACE_ID, "");
  const rename = calls.find((call) => call.args[0] === "rename-tab");
  assert.deepEqual(rename.args, [
    "rename-tab", "--workspace", "main-workspace", "--surface", "changed-file",
    "--title", "Preview · Staged · Index · read-only",
  ]);

  const statePath = cmuxPreviewStatePath({ workspaceId: "main-workspace", ownerSurfaceId: "dock-source", environment });
  const state = JSON.parse(await fs.readFile(statePath, "utf8")).open.at(-1);
  assert.equal(state.surfaceId, "changed-file");
  assert.equal(state.panelType, "filepreview");
  assert.equal(state.viewer, "file");
  assert.ok(state.materializedDirectory);
});

test("missing main surface falls back within the explicit workspace without inheriting the Dock surface", async (t) => {
  const { environment } = await fixture(t);
  const calls = [];
  await openCmuxPreview(previewOptions(environment, async (_command, args, options) => {
    calls.push({ args, options });
    return nativeFileResponse();
  }, { targetSurfaceId: "" }));
  assert.equal(calls[0].args.includes("--surface"), false);
  assert.equal(calls[0].args[calls[0].args.indexOf("--workspace") + 1], "main-workspace");
  assert.equal(calls[0].options.env.CMUX_SURFACE_ID, "");
});

for (const [name, staleSurface] of [
  ["Dock surface", { id: "stale", type: "browser", dock_scope: "global" }],
  ["foreign type", { id: "stale", type: "terminal" }],
  ["foreign id", { id: "different", type: "browser" }],
]) {
  test(`${name} is never closed from stale cmux native-preview state`, async (t) => {
    const { environment } = await fixture(t);
    const statePath = cmuxPreviewStatePath({ workspaceId: "main-workspace", ownerSurfaceId: "dock-source", environment });
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify({ surfaceId: "stale", workspaceId: "main-workspace", panelType: "browser" }));
    const calls = [];
    const run = async (_command, args) => {
      calls.push(args);
      if (args.includes("open")) return nativeFileResponse("new-file", "filepreview");
      if (args.includes("list-panels")) return { stdout: JSON.stringify([staleSurface]) };
      return { stdout: "{}" };
    };
    await openCmuxPreview(previewOptions(environment, run, {
      descriptor: { kind: "staged" }, metadata: { status: "modified" },
    }));
    assert.equal(calls.some((args) => args[0] === "close-surface"), false);
  });
}

test("a missing stale surface releases its retained native-file materialization", async (t) => {
  const { environment } = await fixture(t);
  const statePath = cmuxPreviewStatePath({ workspaceId: "main-workspace", ownerSurfaceId: "dock-source", environment });
  const oldDirectory = path.join(path.dirname(statePath), "orphaned-file");
  await fs.mkdir(oldDirectory, { recursive: true });
  await fs.writeFile(path.join(oldDirectory, "old.txt"), "old");
  await fs.writeFile(statePath, JSON.stringify({
    surfaceId: "gone", workspaceId: "main-workspace", panelType: "filePreview", materializedDirectory: oldDirectory,
  }));
  await openCmuxPreview(previewOptions(environment, async (_command, args) => (
    args.includes("open") ? nativeFileResponse() : { stdout: JSON.stringify({ surfaces: [] }) }
  )));
  await assert.rejects(fs.access(oldDirectory), (error) => error.code === "ENOENT");
});

test("each open adds a new native tab and stable ownership survives Dock surface rotation", async (t) => {
  const { environment } = await fixture(t);
  const calls = [];
  let openCount = 0;
  const run = async (_command, args) => {
    calls.push(args);
    if (args.includes("open")) return nativeFileResponse(`preview-${++openCount}`, "markdown");
    if (args.includes("list-panels")) return { stdout: JSON.stringify({ surfaces: [{ id: "preview-1", type: "markdown" }] }) };
    return { stdout: "{}" };
  };
  const stable = { ownerControlId: "git-rail" };
  await openCmuxPreview(previewOptions(environment, run, { ...stable, ownerSurfaceId: "dock-old" }));
  const statePath = cmuxPreviewStatePath({ workspaceId: "main-workspace", ownerControlId: "git-rail", environment });
  const oldDirectory = JSON.parse(await fs.readFile(statePath, "utf8")).open[0].materializedDirectory;

  await openCmuxPreview(previewOptions(environment, run, { ...stable, ownerSurfaceId: "dock-new" }));

  assert.equal(calls.some((args) => args[0] === "close-surface"), false);
  await fs.access(oldDirectory);
  const registry = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(registry.version, 3);
  assert.deepEqual(registry.open.map((state) => state.surfaceId), ["preview-1", "preview-2"]);
  assert.equal(registry.open.at(-1).ownerSurfaceId, "dock-new");
});

test("stable control ownership migrates legacy surface-keyed preview state", async (t) => {
  const { environment } = await fixture(t);
  const legacyPath = cmuxPreviewStatePath({
    workspaceId: "main-workspace", ownerSurfaceId: "dock-legacy", environment,
  });
  const stablePath = cmuxPreviewStatePath({
    workspaceId: "main-workspace", ownerControlId: "git-rail", environment,
  });
  const legacyDirectory = path.join(path.dirname(legacyPath), "legacy-materialization");
  await fs.mkdir(legacyDirectory, { recursive: true });
  await fs.writeFile(path.join(legacyDirectory, "old.txt"), "old");
  await fs.writeFile(legacyPath, JSON.stringify({
    surfaceId: "legacy-preview",
    workspaceId: "main-workspace",
    ownerSurfaceId: "dock-legacy",
    panelType: "filepreview",
    materializedDirectory: legacyDirectory,
  }));
  const calls = [];
  await openCmuxPreview(previewOptions(environment, async (_command, args) => {
    calls.push(args);
    if (args.includes("open")) return nativeFileResponse("current-preview", "filepreview");
    if (args.includes("list-panels")) return { stdout: JSON.stringify({ surfaces: [{ id: "legacy-preview", type: "filepreview" }] }) };
    return { stdout: "{}" };
  }, { ownerControlId: "git-rail", ownerSurfaceId: "dock-current" }));
  assert.equal(calls.some((args) => args[0] === "close-surface"), false);
  await fs.access(legacyDirectory);
  await assert.rejects(fs.access(legacyPath), (error) => error.code === "ENOENT");
  const registry = JSON.parse(await fs.readFile(stablePath, "utf8"));
  assert.equal(registry.version, 3);
  assert.deepEqual(registry.open.map((state) => state.surfaceId), ["legacy-preview", "current-preview"]);
});

test("replacement-era ownership migrates without closing its native tabs", async (t) => {
  const { environment } = await fixture(t);
  const statePath = cmuxPreviewStatePath({
    workspaceId: "main-workspace", ownerControlId: "git-rail", environment,
  });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify({
    version: 2,
    active: { surfaceId: "active-preview", workspaceId: "main-workspace", panelType: "filepreview" },
    pending: [{ surfaceId: "pending-preview", workspaceId: "main-workspace", panelType: "markdown" }],
  }));
  const calls = [];
  await openCmuxPreview(previewOptions(environment, async (_command, args) => {
    calls.push(args);
    if (args.includes("open")) return nativeFileResponse("new-preview", "filepreview");
    if (args.includes("list-panels")) return { stdout: JSON.stringify({ surfaces: [
      { id: "active-preview", type: "filepreview" },
      { id: "pending-preview", type: "markdown" },
    ] }) };
    return { stdout: "{}" };
  }, { ownerControlId: "git-rail" }));

  assert.equal(calls.some((args) => args[0] === "close-surface"), false);
  const registry = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(registry.version, 3);
  assert.deepEqual(registry.open.map((state) => state.surfaceId), [
    "active-preview", "pending-preview", "new-preview",
  ]);
});

test("unreadable legacy ownership is reported without blocking a new preview", async (t) => {
  const { environment } = await fixture(t);
  const stablePath = cmuxPreviewStatePath({
    workspaceId: "main-workspace", ownerControlId: "git-rail", environment,
  });
  const unreadableLegacyPath = path.join(path.dirname(stablePath), "main-workspace-unreadable.json");
  await fs.mkdir(unreadableLegacyPath, { recursive: true });
  const result = await openCmuxPreview(previewOptions(environment, async (_command, args) => (
    args.includes("open") ? nativeFileResponse() : { stdout: "{}" }
  ), { ownerControlId: "git-rail" }));
  assert.match(result.cleanupWarning, /legacy preview ownership unavailable/);
  assert.equal(result.surfaceId, "new-file");
});

test("native identity names the actual bytes for clean and deletion fallbacks", async (t) => {
  const cases = [
    {
      name: "clean Files row",
      descriptor: { kind: "workspace", baseRef: "main" },
      metadata: { status: "clean" },
      revision: "worktree",
      expected: "Clean · Worktree · read-only",
    },
    {
      name: "staged deletion",
      descriptor: { kind: "staged" },
      metadata: { status: "deleted", oldPath: "old.txt" },
      revision: "HEAD:old.txt",
      expected: "Staged · HEAD before deletion · read-only",
    },
    {
      name: "commit deletion",
      descriptor: { kind: "commit", commitHash: "cccccccccccc", parentHash: "pppppppppppp" },
      metadata: { status: "deleted", oldPath: "old.txt" },
      revision: "pppppppppppp:old.txt",
      expected: "Commit cccccccc · Revision pppppppppppp before deletion · read-only",
    },
    {
      name: "unstaged worktree",
      descriptor: { kind: "unstaged" },
      metadata: { status: "modified" },
      revision: "worktree",
      expected: "Unstaged · Worktree · read-only",
    },
    {
      name: "untracked worktree",
      descriptor: { kind: "untracked" },
      metadata: { status: "untracked" },
      revision: "worktree",
      expected: "Untracked · Worktree · read-only",
    },
    {
      name: "against-base revision",
      descriptor: { kind: "against", baseRef: "main" },
      metadata: { status: "modified" },
      revision: "HEAD:new.txt",
      expected: "Against main · HEAD · read-only",
    },
    {
      name: "against-base worktree fallback",
      descriptor: { kind: "against", baseRef: "main" },
      metadata: { status: "modified" },
      revision: "worktree",
      expected: "Against main · Worktree · read-only",
    },
    {
      name: "selected commit revision",
      descriptor: { kind: "commit", commitHash: "cccccccccccc", parentHash: "pppppppppppp" },
      metadata: { status: "modified" },
      revision: "cccccccccccc:new.txt",
      expected: "Commit cccccccc · read-only",
    },
    {
      name: "filesystem worktree",
      descriptor: { kind: "filesystem" },
      metadata: { status: "filesystem" },
      revision: "worktree",
      expected: "Filesystem · Worktree · read-only",
    },
  ];
  for (const [index, entry] of cases.entries()) {
    await t.test(entry.name, async (subtest) => {
      const { environment } = await fixture(subtest);
      const calls = [];
      const result = await openCmuxPreview(previewOptions(environment, async (_command, args) => {
        calls.push(args);
        if (args.includes("open")) return nativeFileResponse(`identity-${index}`, "filepreview");
        return { stdout: "{}" };
      }, {
        previewPath: "new.txt",
        descriptor: entry.descriptor,
        metadata: entry.metadata,
        loadRawContent: async () => ({ bytes: Buffer.from("selected\n"), revision: entry.revision }),
      }));
      assert.equal(result.revisionLabel, entry.expected);
      assert.equal(calls.find((args) => args[0] === "rename-tab").at(-1), `Preview · ${entry.expected}`);
    });
  }
});

test("transient discovery failures retain open tabs and later prune only closed tabs", async (t) => {
  const { environment } = await fixture(t);
  const calls = [];
  let openCount = 0;
  let cleanupAvailable = false;
  const run = async (_command, args) => {
    calls.push(args);
    if (args.includes("open")) return nativeFileResponse(`preview-${++openCount}`, "filepreview");
    if (args.includes("list-panels")) {
      if (!cleanupAvailable) throw new Error("surface discovery offline");
      return { stdout: JSON.stringify({ surfaces: [{ id: "preview-2", type: "filepreview" }] }) };
    }
    return { stdout: "{}" };
  };
  const stable = { ownerControlId: "git-rail" };
  await openCmuxPreview(previewOptions(environment, run, stable));
  const statePath = cmuxPreviewStatePath({ workspaceId: "main-workspace", ownerControlId: "git-rail", environment });
  const firstDirectory = JSON.parse(await fs.readFile(statePath, "utf8")).open[0].materializedDirectory;
  const second = await openCmuxPreview(previewOptions(environment, run, stable));
  assert.match(second.cleanupWarning, /surface discovery offline/);
  const afterFailure = JSON.parse(await fs.readFile(statePath, "utf8"));
  const secondDirectory = afterFailure.open.at(-1).materializedDirectory;
  assert.deepEqual(afterFailure.open.map((state) => state.surfaceId), ["preview-1", "preview-2"]);
  await fs.access(firstDirectory);

  cleanupAvailable = true;
  await openCmuxPreview(previewOptions(environment, run, stable));

  assert.equal(calls.some((args) => args[0] === "close-surface"), false);
  await assert.rejects(fs.access(firstDirectory), (error) => error.code === "ENOENT");
  await fs.access(secondDirectory);
  const recovered = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.deepEqual(recovered.open.map((state) => state.surfaceId), ["preview-2", "preview-3"]);
});

test("malformed ownership is ignored while an unreadable ownership path fails before cmux mutation", async (t) => {
  const { environment } = await fixture(t);
  const statePath = cmuxPreviewStatePath({ workspaceId: "main-workspace", ownerSurfaceId: "dock-source", environment });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, "not json");
  const calls = [];
  await openCmuxPreview(previewOptions(environment, async (_command, args) => {
    calls.push(args);
    return nativeFileResponse();
  }));
  assert.equal(calls.filter((args) => args.includes("open")).length, 1);
  assert.equal(calls.filter((args) => args[0] === "rename-tab").length, 1);

  const unreadablePath = cmuxPreviewStatePath({ workspaceId: "other-workspace", ownerSurfaceId: "dock-source", environment });
  await fs.mkdir(unreadablePath, { recursive: true });
  let mutated = false;
  await assert.rejects(openCmuxPreview(previewOptions(environment, async () => {
    mutated = true;
    return nativeFileResponse();
  }, { workspaceId: "other-workspace" })), /EISDIR|illegal operation on a directory/i);
  assert.equal(mutated, false);
});

test("ownership write failure closes the new native surface and removes its materialization", async (t) => {
  const { environment } = await fixture(t);
  const calls = [];
  await assert.rejects(openCmuxPreview(previewOptions(environment, async (_command, args) => {
    calls.push(args);
    return nativeFileResponse();
  }, { writeOwnership: async () => { throw new Error("disk full"); } })), /newly opened preview was closed: disk full/);
  const openedPath = calls.find((args) => args.includes("open"))[4];
  assert.ok(calls.some((args) => args.join(" ") === "close-surface --workspace main-workspace --surface new-file"));
  await assert.rejects(fs.access(path.dirname(openedPath)), (error) => error.code === "ENOENT");
});

test("ownership failure reports failed compensation without hiding either error", async (t) => {
  const { environment } = await fixture(t);
  await assert.rejects(openCmuxPreview(previewOptions(environment, async (_command, args) => {
    if (args[0] === "close-surface") throw new Error("close offline");
    return nativeFileResponse();
  }, { writeOwnership: async () => { throw new Error("disk full"); } })), /disk full; newly opened preview could not be closed: close offline/);
});

test("malformed native open responses fail and remove prepared files", async (t) => {
  const { environment } = await fixture(t);
  let openedPath;
  const calls = [];
  await assert.rejects(openCmuxPreview(previewOptions(environment, async (_command, args) => {
    calls.push(args);
    if (args.includes("open")) {
      openedPath = args[4];
      return { stdout: JSON.stringify({ opened: [{ kind: "file", payload: { surface_id: "missing-type" } }] }) };
    }
    return { stdout: "{}" };
  })), /incomplete native preview identity; partially opened surface was closed/);
  assert.ok(calls.some((args) => args.join(" ") === "close-surface --workspace main-workspace --surface missing-type"));
  await assert.rejects(fs.access(path.dirname(openedPath)), (error) => error.code === "ENOENT");
});

test("partial native open reports failed close compensation", async (t) => {
  const { environment } = await fixture(t);
  await assert.rejects(openCmuxPreview(previewOptions(environment, async (_command, args) => {
    if (args.includes("open")) {
      return { stdout: JSON.stringify({ opened: [{ kind: "file", payload: { surface_id: "missing-type" } }] }) };
    }
    if (args[0] === "close-surface") throw new Error("close offline");
    return { stdout: "{}" };
  })), /partially opened surface could not be closed: close offline/);
});

test("a failed native file-open command removes the prepared materialization", async (t) => {
  const { environment } = await fixture(t);
  let openedPath;
  await assert.rejects(openCmuxPreview(previewOptions(environment, async (_command, args) => {
    openedPath = args[4];
    throw new Error("file viewer offline");
  })), /file viewer offline/);
  await assert.rejects(fs.access(path.dirname(openedPath)), (error) => error.code === "ENOENT");
});

test("direct file-open payloads and fallback filenames remain supported", async (t) => {
  const { environment } = await fixture(t);
  let openedPath;
  const result = await openCmuxPreview(previewOptions(environment, async (_command, args) => {
    if (args.includes("open")) {
      openedPath = args[4];
      return { stdout: JSON.stringify({ surface_id: "direct-file", panel_type: "filepreview" }) };
    }
    return { stdout: "{}" };
  }, {
    ownerSurfaceId: "",
    targetSurfaceId: "",
    previewPath: "",
  }));
  assert.equal(result.surfaceId, "direct-file");
  assert.equal(path.basename(openedPath), "preview.txt");
  const statePath = cmuxPreviewStatePath({ workspaceId: "main-workspace", environment });
  assert.equal(JSON.parse(await fs.readFile(statePath, "utf8")).open[0].panelType, "filepreview");
});

test("stale preview inspection failures are warnings and retain the old materialization", async (t) => {
  const { environment } = await fixture(t);
  const statePath = cmuxPreviewStatePath({ workspaceId: "main-workspace", ownerSurfaceId: "dock-source", environment });
  const oldDirectory = path.join(path.dirname(statePath), "retained-old-file");
  await fs.mkdir(oldDirectory, { recursive: true });
  await fs.writeFile(statePath, JSON.stringify({
    surfaceId: "old-file", workspaceId: "main-workspace", panelType: "markdown", materializedDirectory: oldDirectory,
  }));
  const result = await openCmuxPreview(previewOptions(environment, async (_command, args) => {
    if (args.includes("open")) return nativeFileResponse();
    throw new Error("surface discovery offline");
  }));
  assert.match(result.cleanupWarning, /surface discovery offline/);
  await fs.access(oldDirectory);
});

test("a cleanup-state rewrite failure remains a warning after verified cleanup", async (t) => {
  const { environment } = await fixture(t);
  const statePath = cmuxPreviewStatePath({ workspaceId: "main-workspace", ownerSurfaceId: "dock-source", environment });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify({
    surfaceId: "gone", workspaceId: "main-workspace", panelType: "filepreview",
  }));
  let writes = 0;
  const result = await openCmuxPreview(previewOptions(environment, async (_command, args) => (
    args.includes("open") ? nativeFileResponse() : { stdout: JSON.stringify({ surfaces: [] }) }
  ), {
    writeOwnership: async () => {
      writes += 1;
      if (writes === 2) throw new Error("rewrite offline");
    },
  }));
  assert.equal(writes, 2);
  assert.match(result.cleanupWarning, /preview cleanup state could not be updated: rewrite offline/);
});

test("stale state can never remove a materialization outside GitRail's cache", async (t) => {
  const { root, environment } = await fixture(t);
  const statePath = cmuxPreviewStatePath({ workspaceId: "main-workspace", ownerSurfaceId: "dock-source", environment });
  const outside = path.join(root, "outside-cache");
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify({
    surfaceId: "gone", workspaceId: "main-workspace", panelType: "filepreview", materializedDirectory: outside,
  }));
  await openCmuxPreview(previewOptions(environment, async (_command, args) => (
    args.includes("open") ? nativeFileResponse() : { stdout: JSON.stringify({ result: { surfaces: [] } }) }
  )));
  await fs.access(outside);
});

test("cmux preview requires a resolved main workspace", async (t) => {
  const { environment } = await fixture(t);
  let mutated = false;
  await assert.rejects(openCmuxPreview(previewOptions(environment, async () => {
    mutated = true;
    return nativeFileResponse();
  }, { workspaceId: "" })), /selected main workspace/);
  assert.equal(mutated, false);
});

test("surface ownership requires exact id, native panel type, and main-area scope", () => {
  const state = { surfaceId: "preview", panelType: "filePreview" };
  assert.equal(surfaceIsOwnedPreview({ id: "preview", type: "file_preview" }, state), true);
  assert.equal(surfaceIsOwnedPreview({ id: "preview", type: "file" }, state), true);
  assert.equal(surfaceIsOwnedPreview({ id: "preview", type: "browser" }, state), false);
  assert.equal(surfaceIsOwnedPreview({ surface_id: "preview", panel_type: "filepreview" }, state), true);
  assert.equal(surfaceIsOwnedPreview({ id: "preview", type: "" }, state), false);
  assert.equal(surfaceIsOwnedPreview({ id: "preview", type: "file_preview", dock_scope: "global" }, state), false);
  assert.equal(surfaceIsOwnedPreview({ id: "other", type: "file_preview" }, state), false);
  assert.equal(surfaceIsOwnedPreview(null, state), false);
  assert.equal(surfaceIsOwnedPreview({ id: "preview" }, {}), false);
  assert.equal(surfaceIsOwnedPreview({
    id: "legacy", type: "terminal", initial_command: "/plugin/file-preview.mjs",
  }, { surfaceId: "legacy", previewScriptPath: "/plugin/file-preview.mjs" }), true);
  assert.equal(surfaceIsOwnedPreview({
    id: "legacy", initial_command: "/bin/zsh",
  }, { surfaceId: "legacy", previewScriptPath: "/plugin/file-preview.mjs" }), false);
});
