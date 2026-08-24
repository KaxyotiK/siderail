#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { assertSupportedNode } from "../src/node-version.mjs";
import { resizeSidebarPane } from "../src/herdr-layout.mjs";

assertSupportedNode();

export async function resizeConfiguredSidebar({ paneId, environment = process.env }) {
  if (!paneId) return null;
  const { config } = loadConfig(environment);
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
