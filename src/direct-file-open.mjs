import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchExecutable } from "./config.mjs";
import { loadRawBytes, safeWorktreePath } from "./preview-provider.mjs";
import { runCommand } from "./process.mjs";
import { retainExternalPreviewCopy } from "./temporary-copy-retention.mjs";

function needsMaterializedRevision(descriptor, metadata, temporarySource) {
  return temporarySource
    || ["commit", "against", "staged"].includes(descriptor.kind)
    || metadata.status === "deleted";
}

export async function openExternalFile({
  viewer,
  repoRoot,
  filePath,
  descriptor,
  metadata,
  maxFileBytes,
  temporarySource = false,
  environment = process.env,
  platform = process.platform,
  run = runCommand,
  retain = retainExternalPreviewCopy,
}) {
  let temporaryDirectory = "";
  try {
    let sourcePath;
    if (needsMaterializedRevision(descriptor, metadata, temporarySource)) {
      const raw = await loadRawBytes({ repoRoot, filePath, descriptor, metadata, maxFileBytes });
      temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-gitrail-preview-"));
      await fs.chmod(temporaryDirectory, 0o700);
      sourcePath = path.join(temporaryDirectory, path.basename(filePath) || "preview.md");
      await fs.writeFile(sourcePath, raw.bytes, { mode: 0o600 });
      await fs.chmod(sourcePath, 0o400);
    } else {
      sourcePath = await safeWorktreePath(repoRoot, filePath);
    }

    await run(launchExecutable(viewer, platform), [...(viewer.args || []), sourcePath], {
      cwd: repoRoot,
      env: environment,
      timeoutMs: 15_000,
      maxOutputBytes: 256 * 1_024,
    });

    let retentionWarning = "";
    if (temporaryDirectory) {
      try { retain(temporaryDirectory); }
      catch (error) { retentionWarning = `temporary-copy cleanup failed: ${error.message}`; }
      temporaryDirectory = "";
    }
    return { sourcePath, retentionWarning };
  } catch (error) {
    if (temporaryDirectory) {
      try { await fs.rm(temporaryDirectory, { recursive: true, force: true }); } catch {}
    }
    throw error;
  }
}
