#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCmuxDockResume } from "../src/cmux-resume.mjs";
// Loaded before the resume registration below awaits, so the rail's install
// identity is captured at launch.
import "../src/install-watch.mjs";

process.env.SIDERAIL_HOST = "cmux";
process.env.SIDERAIL_PROJECT_CWD ||= process.cwd();
try {
  const result = await ensureCmuxDockResume({
    environment: process.env,
    scriptDirectory: path.dirname(fileURLToPath(import.meta.url)),
  });
  if (result.configured && !result.autoResume) {
    process.stderr.write("SideRail Dock restore is registered but not set to Auto-Restore.\n");
  }
} catch (error) {
  process.stderr.write(`SideRail could not register cmux Dock restore: ${error.message}\n`);
}
await import("./siderail.mjs");
