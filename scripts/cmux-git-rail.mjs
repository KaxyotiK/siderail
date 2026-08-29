#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCmuxDockResume } from "../src/cmux-resume.mjs";

process.env.GIT_RAIL_HOST = "cmux";
process.env.GIT_RAIL_PROJECT_CWD ||= process.cwd();
try {
  const result = await ensureCmuxDockResume({
    environment: process.env,
    scriptDirectory: path.dirname(fileURLToPath(import.meta.url)),
  });
  if (result.configured && !result.autoResume) {
    process.stderr.write("GitRail Dock restore is registered but not set to Auto-Restore.\n");
  }
} catch (error) {
  process.stderr.write(`GitRail could not register cmux Dock restore: ${error.message}\n`);
}
await import("./git-rail.mjs");
