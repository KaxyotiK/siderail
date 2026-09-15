#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../src/process.mjs";
import { closeVerifiedPluginPane } from "../src/herdr-plugin-pane.mjs";
import { assertSupportedNode } from "../src/node-version.mjs";
import { sanitizeTerminalText } from "../src/terminal-ui.mjs";

assertSupportedNode();

const OWNED_LABELS = new Map([
  ["HERDR GITRAIL", { script: "scripts/git-rail.mjs", demo: false }],
  ["HERDER GITRAIL", { script: "scripts/git-rail.mjs", demo: false }],
  ["Grove Git Rail", { script: "scripts/git-rail.mjs", demo: false }],
  ["GitRail Demo", { script: "scripts/git-rail.mjs", demo: true }],
  ["GitRail Preview", { script: "scripts/file-preview.mjs", demo: false }],
]);

function parseJson(text) {
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}

function resultItems(text, key) {
  const items = parseJson(text)?.result?.[key];
  return Array.isArray(items) ? items : [];
}

function resultPane(text) {
  return parseJson(text)?.result?.pane || null;
}

function processMatches(processInfo, identity, pluginRoot) {
  const argv = Array.isArray(processInfo?.argv) ? processInfo.argv.map(String) : [];
  const cwd = processInfo?.cwd ? path.resolve(String(processInfo.cwd)) : "";
  const scriptArgument = argv.find((argument) => argument === identity.script || argument.endsWith(`/${identity.script}`));
  if (!scriptArgument || !cwd) return false;
  const scriptPath = path.isAbsolute(scriptArgument)
    ? path.resolve(scriptArgument)
    : path.resolve(cwd, scriptArgument);
  if (scriptPath !== path.resolve(pluginRoot, identity.script)) return false;
  return identity.demo ? argv.includes("--demo") : !argv.includes("--demo");
}

async function verifiedOwnedPane({ run, herdr, pane, pluginRoot }) {
  const identity = OWNED_LABELS.get(pane.label);
  if (!identity || !pane.pane_id || !pane.terminal_id) return false;
  const inspected = await run(herdr, ["pane", "get", pane.pane_id], {
    timeoutMs: 3_000,
    maxOutputBytes: 256 * 1_024,
  });
  const current = resultPane(inspected.stdout);
  if (!current || current.pane_id !== pane.pane_id || current.terminal_id !== pane.terminal_id
    || current.workspace_id !== pane.workspace_id || current.label !== pane.label) return false;
  const processResult = await run(herdr, ["pane", "process-info", "--pane", pane.pane_id], {
    timeoutMs: 3_000,
    maxOutputBytes: 256 * 1_024,
  });
  const processes = parseJson(processResult.stdout)?.result?.process_info?.foreground_processes || [];
  return processes.some((processInfo) => processMatches(processInfo, identity, pluginRoot));
}

export async function uninstallGitRail({
  environment = process.env,
  run = runCommand,
  pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
} = {}) {
  const herdr = environment.HERDR_BIN_PATH || "herdr";
  const pluginId = environment.HERDR_PLUGIN_ID || "local.git-rail";
  const listed = await run(herdr, ["pane", "list"], {
    timeoutMs: 8_000,
    maxOutputBytes: 16 * 1_024 * 1_024,
  });
  const candidates = resultItems(listed.stdout, "panes").filter((pane) => OWNED_LABELS.has(pane.label));
  const verified = [];
  const ambiguous = [];
  for (const pane of candidates) {
    try {
      if (await verifiedOwnedPane({ run, herdr, pane, pluginRoot })) verified.push(pane);
      else ambiguous.push(pane);
    } catch {
      ambiguous.push(pane);
    }
  }
  if (ambiguous.length) {
    throw new Error(`refusing to unlink while GitRail-labelled panes cannot be proven owned: ${ambiguous.map((pane) => sanitizeTerminalText(pane.pane_id)).join(", ")}`);
  }
  for (const pane of verified) {
    await closeVerifiedPluginPane({ run, herdr, paneId: pane.pane_id });
  }
  await run(herdr, ["plugin", "unlink", pluginId], {
    timeoutMs: 8_000,
    maxOutputBytes: 256 * 1_024,
  });
  return { closedPaneIds: verified.map((pane) => pane.pane_id), pluginId };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  uninstallGitRail().then((result) => {
    process.stdout.write(`Unlinked ${result.pluginId}; closed ${result.closedPaneIds.length} verified GitRail pane(s).\n`);
  }).catch((error) => {
    console.error(sanitizeTerminalText(error.message));
    process.exitCode = 1;
  });
}
