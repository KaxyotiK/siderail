import {
  ensurePaneStateDirectory,
  paneStatePath,
  readPaneState,
  writePaneState,
} from "./herdr-pane-state.mjs";

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

async function verifiedPreviewPane({ run, herdr, paneId, terminalId, workspaceId, cwd }) {
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
    Array.isArray(processInfo.argv)
    && processInfo.argv.some((argument) => /(?:^|\/)scripts\/file-preview\.mjs$/.test(String(argument)))
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
  if (statePath) await writePaneState(statePath, pane.pane_id, cwd, pane.terminal_id || "");

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
      })) {
        await run(herdr, ["plugin", "pane", "close", staleState.paneId], {
          cwd,
          timeoutMs: 5_000,
          maxOutputBytes: 256 * 1_024,
        });
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
