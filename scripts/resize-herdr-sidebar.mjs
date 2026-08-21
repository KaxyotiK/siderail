#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { resizeSidebarPane } from "../src/herdr-layout.mjs";
import { runGit } from "../src/process.mjs";

async function repositoryRoot(cwd) {
  if (!cwd) return "";
  try {
    const root = (await runGit(cwd, ["rev-parse", "--show-toplevel"], {
      timeoutMs: 2_000,
      maxOutputBytes: 64 * 1024,
    })).stdout.trim();
    return root ? await fs.realpath(root) : "";
  } catch {
    return "";
  }
}

export async function resizeConfiguredSidebar({ paneId, workspaceCwd, environment = process.env }) {
  if (!paneId) return null;
  const repoRoot = await repositoryRoot(workspaceCwd);
  const { config } = loadConfig(repoRoot, environment);
  return resizeSidebarPane({
    herdr: environment.HERDR_BIN_PATH || "herdr",
    paneId,
    configuredWidth: config.herdr.sidebarWidth,
  });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  resizeConfiguredSidebar({ paneId: process.argv[2], workspaceCwd: process.argv[3] }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
