import {
  ensurePaneStateDirectory,
  paneStatePath,
  readPaneState,
  writePaneState,
} from "./herdr-pane-state.mjs";
import { closeVerifiedPluginPane } from "./herdr-plugin-pane.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseJson(value) {
  return JSON.parse(value || "{}");
}

function resultPane(payload) {
  const result = parseJson(payload)?.result || {};
  return result.plugin_pane?.pane || result.pane || (result.pane_id ? result : null);
}

function processArgv(payload) {
  return parseJson(payload)?.result?.process_info?.foreground_processes || [];
}

export function previewPaneStatePath({ workspaceId, sourceTabId, environment = process.env }) {
  return paneStatePath({ workspaceId, tabId: sourceTabId, entrypoint: "file-preview", environment });
}

function processRunsOwnedPreview(processInfo, pluginRoot) {
  const argv = Array.isArray(processInfo?.argv) ? processInfo.argv.map(String) : [];
  const scriptArgument = argv.find((argument) => (
    argument === "scripts/file-preview.mjs" || argument.endsWith("/scripts/file-preview.mjs")
  ));
  if (!scriptArgument) return false;
  const processCwd = processInfo?.cwd ? path.resolve(String(processInfo.cwd)) : "";
  if (!path.isAbsolute(scriptArgument) && !processCwd) return false;
  const scriptPath = path.isAbsolute(scriptArgument)
    ? path.resolve(scriptArgument)
    : path.resolve(processCwd, scriptArgument);
  return scriptPath === path.join(path.resolve(pluginRoot), "scripts/file-preview.mjs");
}

async function verifiedPreviewPane({ run, herdr, paneId, terminalId, workspaceId, cwd, pluginRoot }) {
  if (!paneId || !terminalId) return false;
  const paneResult = await run(herdr, ["pane", "get", paneId], {
    cwd,
    timeoutMs: 3_000,
    maxOutputBytes: 256 * 1_024,
  });
  const pane = resultPane(paneResult.stdout);
  if (!pane || pane.pane_id !== paneId || pane.terminal_id !== terminalId
    || pane.workspace_id !== workspaceId || pane.label !== "GitRail Preview") return false;
  const processResult = await run(herdr, ["pane", "process-info", "--pane", paneId], {
    cwd,
    timeoutMs: 3_000,
    maxOutputBytes: 256 * 1_024,
  });
  return processArgv(processResult.stdout).some((processInfo) => (
    processRunsOwnedPreview(processInfo, pluginRoot)
  ));
}

export async function openOwnedPreview({
  run,
  herdr,
  openArgs,
  cwd,
  workspaceId,
  sourceTabId,
  environment = process.env,
  tabName = "",
  pluginRoot = PLUGIN_ROOT,
  writeState = writePaneState,
}) {
  const statePath = workspaceId && sourceTabId
    ? previewPaneStatePath({ workspaceId, sourceTabId, environment })
    : "";
  if (statePath) await ensurePaneStateDirectory(environment);
  const staleState = statePath ? await readPaneState(statePath) : null;
  const opened = await run(herdr, openArgs, { cwd });
  let pane = resultPane(opened.stdout);
  if (!pane?.pane_id) throw new Error("Herdr did not return a preview pane id");
  let identityWarning = "";
  if (!pane.terminal_id) {
    try {
      const paneResult = await run(herdr, ["pane", "get", pane.pane_id], {
        cwd,
        timeoutMs: 3_000,
        maxOutputBytes: 256 * 1_024,
      });
      const inspected = resultPane(paneResult.stdout);
      if (inspected?.pane_id === pane.pane_id) pane = { ...pane, ...inspected };
    } catch (error) {
      identityWarning = `preview ownership identity unavailable: ${error.message}`;
    }
  }
  if (statePath) {
    try {
      await writeState(statePath, pane.pane_id, cwd, pane.terminal_id || "");
    } catch (stateError) {
      let ownedForCompensation = false;
      try {
        ownedForCompensation = await verifiedPreviewPane({
          run,
          herdr,
          paneId: pane.pane_id,
          terminalId: pane.terminal_id || "",
          workspaceId,
          cwd,
          pluginRoot,
        });
      } catch {}
      if (!ownedForCompensation) {
        throw new Error(
          `preview ownership state could not be recorded and the newly opened pane could not be verified for safe cleanup: ${stateError.message}`,
          { cause: stateError },
        );
      }
      try {
        await closeVerifiedPluginPane({ run, herdr, paneId: pane.pane_id, cwd });
      } catch (closeError) {
        throw new Error(
          `preview ownership state could not be recorded: ${stateError.message}; newly opened pane ${pane.pane_id} also could not be closed: ${closeError.message}`,
          { cause: closeError },
        );
      }
      throw new Error(
        `preview ownership state could not be recorded; newly opened pane was closed: ${stateError.message}`,
        { cause: stateError },
      );
    }
  }

  let cleanupWarning = identityWarning;
  if (staleState?.paneId && staleState.paneId !== pane.pane_id) {
    try {
      if (await verifiedPreviewPane({
        run,
        herdr,
        paneId: staleState.paneId,
        terminalId: staleState.terminalId,
        workspaceId,
        cwd,
        pluginRoot,
      })) {
        await closeVerifiedPluginPane({ run, herdr, paneId: staleState.paneId, cwd });
      }
    } catch (error) {
      cleanupWarning = [cleanupWarning, `previous preview left open: ${error.message}`].filter(Boolean).join("; ");
    }
  }

  let renameWarning = "";
  if (pane.tab_id && tabName) {
    try {
      await run(herdr, ["tab", "rename", pane.tab_id, tabName], {
        cwd,
        timeoutMs: 5_000,
        maxOutputBytes: 256 * 1_024,
      });
    } catch (error) {
      renameWarning = `tab name unavailable: ${error.message}`;
    }
  }
  return { paneId: pane.pane_id, tabId: pane.tab_id || "", cleanupWarning, renameWarning };
}
