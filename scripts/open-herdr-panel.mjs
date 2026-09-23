#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquirePaneStateLock,
  ensurePaneStateDirectory,
  legacyPaneStatePath,
  paneStatePath,
  readPaneState,
  removeLegacyPaneState,
  writePaneState,
} from "../src/herdr-pane-state.mjs";
import { runCommand } from "../src/process.mjs";
import { closeVerifiedPluginPane } from "../src/herdr-plugin-pane.mjs";
import { sanitizeTerminalText } from "../src/terminal-ui.mjs";
import { assertSupportedNode } from "../src/node-version.mjs";
import { resizeConfiguredSidebar } from "./resize-herdr-sidebar.mjs";

const RAIL_LABEL = "SIDERAIL";
assertSupportedNode();
const LEGACY_RAIL_LABEL = "Grove Git Rail";
const DEMO_LABEL = "SideRail Demo";
const PREVIEW_LABEL = "SideRail Preview";
const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const ENTRYPOINT_IDENTITIES = Object.freeze({
  // Linked-checkout upgrades can leave panes with the older title running.
  "git-tui": { current: [RAIL_LABEL, "HERDR GITRAIL"], legacy: [LEGACY_RAIL_LABEL] },
  "git-mockup": { current: [DEMO_LABEL], legacy: [] },
});

function parseJson(value) {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

function responseItems(payload, key) {
  const parsed = typeof payload === "string" ? parseJson(payload) : payload;
  const items = parsed?.result?.[key];
  return Array.isArray(items) ? items : [];
}

function resultPaneId(payload) {
  const result = parseJson(payload)?.result || {};
  return result.plugin_pane?.pane?.pane_id || result.pane?.pane_id || result.pane_id || "";
}

function focusedWorkspace(payload) {
  return responseItems(payload, "workspaces").find((workspace) => workspace.focused);
}

function paneFromPayload(payload) {
  return parseJson(payload)?.result?.pane || null;
}

function entrypointIdentity(entrypoint) {
  return ENTRYPOINT_IDENTITIES[entrypoint] || { current: [], legacy: [] };
}

function hasLabel(pane, labels) {
  return labels.includes(pane?.label);
}

function sourcePane(tabPanes, requestedPaneId, layout, ownedPaneIds = new Set(), entrypoint = "git-tui") {
  const otherEntrypointLabels = entrypoint === "git-mockup"
    ? new Set([...ENTRYPOINT_IDENTITIES["git-tui"].current, LEGACY_RAIL_LABEL])
    : new Set([DEMO_LABEL]);
  const usable = tabPanes.filter((pane) => (
    pane.label !== PREVIEW_LABEL
    && !otherEntrypointLabels.has(pane.label)
    && !ownedPaneIds.has(pane.pane_id)
  ));
  return usable.find((pane) => pane.pane_id === requestedPaneId)
    || usable.find((pane) => pane.pane_id === layout?.focused_pane_id)
    || usable[0]
    || null;
}

export function rightmostPaneId(layout, panes) {
  const allowed = new Set(panes.map((pane) => pane.pane_id));
  return (layout?.panes || [])
    .filter((pane) => allowed.has(pane.pane_id) && pane.rect)
    .sort((left, right) => (
      (right.rect.x + right.rect.width) - (left.rect.x + left.rect.width)
      || right.rect.x - left.rect.x
      || right.rect.y - left.rect.y
    ))[0]?.pane_id || panes[0]?.pane_id || "";
}

async function commandJson(run, command, args, options = {}) {
  const result = await run(command, args, options);
  return { result, payload: parseJson(result.stdout) };
}

async function globalFocusLocation(run, herdr) {
  const { payload } = await commandJson(run, herdr, ["workspace", "list"], {
    timeoutMs: 5_000,
    maxOutputBytes: 2 * 1_024 * 1_024,
  });
  const workspace = focusedWorkspace(payload);
  return workspace?.workspace_id && workspace?.active_tab_id
    ? { workspaceId: workspace.workspace_id, tabId: workspace.active_tab_id }
    : null;
}

async function restoreGlobalFocus(run, herdr, location) {
  if (!location) return;
  await run(herdr, ["workspace", "focus", location.workspaceId], {
    timeoutMs: 5_000,
    maxOutputBytes: 256 * 1_024,
  });
  await run(herdr, ["tab", "focus", location.tabId], {
    timeoutMs: 5_000,
    maxOutputBytes: 256 * 1_024,
  });
}

async function resolveInvocation(environment, herdr, run) {
  const context = parseJson(environment.HERDR_PLUGIN_CONTEXT_JSON);
  let workspaceId = environment.HERDR_WORKSPACE_ID || context.workspace_id || "";
  let tabId = environment.HERDR_TAB_ID || context.tab_id || "";
  let requestedPaneId = environment.HERDR_PANE_ID || environment.HERDR_TARGET_PANE_ID || context.focused_pane_id || "";
  let workspaceCwd = environment.SIDERAIL_WORKSPACE_CWD
    || context.worktree?.checkout_path
    || context.focused_pane_cwd
    || context.workspace_cwd
    || "";

  if (!workspaceId) {
    const { payload } = await commandJson(run, herdr, ["workspace", "list"]);
    const workspace = focusedWorkspace(payload);
    workspaceId = workspace?.workspace_id || "";
    tabId ||= workspace?.active_tab_id || "";
  }
  if (requestedPaneId && (!tabId || !workspaceId || !workspaceCwd)) {
    try {
      const { payload } = await commandJson(run, herdr, ["pane", "get", requestedPaneId]);
      const pane = paneFromPayload(payload);
      workspaceId ||= pane?.workspace_id || "";
      tabId ||= pane?.tab_id || "";
      workspaceCwd ||= pane?.foreground_cwd || pane?.cwd || "";
    } catch {}
  }
  if (!workspaceId) throw new Error("unable to resolve Herdr workspace");
  return { context, workspaceId, tabId, requestedPaneId, workspaceCwd };
}

async function closeOwnedPane(run, herdr, paneId, { quiet = false } = {}) {
  try {
    await closeVerifiedPluginPane({ run, herdr, paneId });
    return true;
  } catch (error) {
    if (quiet) return false;
    throw error;
  }
}

async function verifiedOwnedRail(run, herdr, pane, state, entrypoint) {
  if (state?.paneId === pane.pane_id && state.terminalId
    && state.terminalId !== pane.terminal_id) return false;
  try {
    const { payload } = await commandJson(run, herdr, ["pane", "process-info", "--pane", pane.pane_id], {
      timeoutMs: 3_000,
      maxOutputBytes: 256 * 1_024,
    });
    const processes = payload?.result?.process_info?.foreground_processes || [];
    return processes.some((processInfo) => {
      const argv = Array.isArray(processInfo.argv) ? processInfo.argv.map(String) : [];
      const cwd = processInfo.cwd ? path.resolve(String(processInfo.cwd)) : "";
      const scriptArgument = argv.find((argument) => argument === "scripts/siderail.mjs"
        || argument.endsWith("/scripts/siderail.mjs"));
      if (!scriptArgument || !cwd) return false;
      const scriptPath = path.isAbsolute(scriptArgument)
        ? path.resolve(scriptArgument)
        : path.resolve(cwd, scriptArgument);
      const isSideRail = scriptPath === path.join(PLUGIN_ROOT, "scripts/siderail.mjs");
      const isDemo = argv.includes("--demo");
      return isSideRail && (entrypoint === "git-mockup" ? isDemo : !isDemo);
    });
  } catch (error) {
    throw new Error(
      `unable to verify ownership of existing SideRail pane ${sanitizeTerminalText(pane.pane_id)}: ${sanitizeTerminalText(error.message)}`,
      { cause: error },
    );
  }
}

async function validateOpenedRail({
  run,
  herdr,
  paneId,
  workspaceId,
  tabId = "",
  entrypoint,
  priorPaneIds,
}) {
  if (priorPaneIds.has(paneId)) throw new Error("Herdr returned an existing pane instead of the opened SideRail pane");
  const { payload } = await commandJson(run, herdr, ["pane", "get", paneId], {
    timeoutMs: 3_000,
    maxOutputBytes: 256 * 1_024,
  });
  const pane = payload?.result?.pane;
  const labels = entrypointIdentity(entrypoint).current;
  if (!pane || pane.pane_id !== paneId || pane.workspace_id !== workspaceId
    || (tabId && pane.tab_id !== tabId) || !hasLabel(pane, labels)) {
    throw new Error("Herdr returned an invalid SideRail pane after opening the plugin");
  }
  return pane;
}

async function workspacePaneIds(run, herdr, workspaceId) {
  const { payload } = await commandJson(run, herdr, ["pane", "list", "--workspace", workspaceId], {
    timeoutMs: 5_000,
    maxOutputBytes: 8 * 1_024 * 1_024,
  });
  return new Set(responseItems(payload, "panes").map((pane) => pane.pane_id));
}

function paneAtOuterRight(layout, paneId) {
  const pane = (layout?.panes || []).find((item) => item.pane_id === paneId);
  const area = layout?.area;
  return Boolean(pane?.rect && area
    && pane.rect.height === area.height
    && pane.rect.y === area.y
    && pane.rect.x + pane.rect.width === area.x + area.width);
}

async function paneLayout(run, herdr, paneId) {
  const { payload } = await commandJson(
    run,
    herdr,
    ["pane", "layout", "--pane", paneId],
    { timeoutMs: 5_000, maxOutputBytes: 2 * 1_024 * 1_024 },
  );
  const layout = payload?.result?.layout;
  if (!layout) throw new Error("Herdr did not return the target tab layout");
  return layout;
}

async function placeExistingRail({
  run,
  herdr,
  rail,
  contentPanes,
  layout,
}) {
  if (paneAtOuterRight(layout, rail.pane_id)) return { paneId: rail.pane_id, placementChanged: false };
  const rightmostId = rightmostPaneId(layout, contentPanes);
  const rightmost = (layout.panes || []).find((pane) => pane.pane_id === rightmostId);
  const railLayout = (layout.panes || []).find((pane) => pane.pane_id === rail.pane_id);
  const area = layout.area;
  const bothFullHeight = area && rightmost?.rect && railLayout?.rect
    && rightmost.rect.y === area.y && rightmost.rect.height === area.height
    && railLayout.rect.y === area.y && railLayout.rect.height === area.height;
  if (bothFullHeight) {
    await run(herdr, [
      "pane", "swap", "--source-pane", rail.pane_id, "--target-pane", rightmostId,
    ], { timeoutMs: 5_000, maxOutputBytes: 512 * 1_024 });
    return { paneId: rail.pane_id, placementChanged: true };
  }
  return { paneId: rail.pane_id, placementChanged: false, skipped: true };
}

export async function openHerdrPanel({
  entrypoint,
  openMode = "replace",
  environment = process.env,
  run = runCommand,
  resize = resizeConfiguredSidebar,
  writeOutput = (value) => process.stdout.write(value),
} = {}) {
  if (!entrypoint) throw new Error("missing entrypoint");
  const herdr = environment.HERDR_BIN_PATH || "herdr";
  const pluginId = environment.HERDR_PLUGIN_ID || "siderail";
  const invocation = await resolveInvocation(environment, herdr, run);
  const { workspaceId } = invocation;
  await ensurePaneStateDirectory(environment);
  const statePath = paneStatePath({ workspaceId, tabId: invocation.tabId, entrypoint, environment });
  const release = await acquirePaneStateLock(statePath);
  let restoreZoomPaneId = "";
  let restoreFocusLocation = null;
  try {
    const { payload: panePayload } = await commandJson(
      run,
      herdr,
      ["pane", "list", "--workspace", workspaceId],
      { timeoutMs: 5_000, maxOutputBytes: 8 * 1_024 * 1_024 },
    );
    const workspacePanes = responseItems(panePayload, "panes");
    if (!invocation.tabId && invocation.requestedPaneId) {
      invocation.tabId = workspacePanes.find((pane) => pane.pane_id === invocation.requestedPaneId)?.tab_id || "";
    }
    if (!invocation.tabId) {
      const { payload } = await commandJson(run, herdr, ["workspace", "list"]);
      invocation.tabId = responseItems(payload, "workspaces")
        .find((workspace) => workspace.workspace_id === workspaceId)?.active_tab_id || "";
    }
    if (!invocation.tabId) throw new Error("unable to resolve Herdr tab");
    const actualStatePath = paneStatePath({ workspaceId, tabId: invocation.tabId, entrypoint, environment });
    if (actualStatePath !== statePath) throw new Error("Herdr tab changed while acquiring its pane lock");

    const identity = entrypointIdentity(entrypoint);
    let tabPanes = workspacePanes.filter((pane) => pane.tab_id === invocation.tabId);
    const state = await readPaneState(statePath) || await readPaneState(legacyPaneStatePath({
      workspaceId,
      entrypoint,
      environment,
    }));
    const currentRails = [];
    const legacyRails = [];
    for (const pane of tabPanes.filter((candidate) => hasLabel(candidate, identity.current))) {
      if (await verifiedOwnedRail(run, herdr, pane, state, entrypoint)) currentRails.push(pane);
    }
    for (const pane of tabPanes.filter((candidate) => hasLabel(candidate, identity.legacy))) {
      if (await verifiedOwnedRail(run, herdr, pane, state, entrypoint)) legacyRails.push(pane);
    }
    if (openMode === "toggle" && currentRails.length + legacyRails.length > 0) {
      for (const pane of [...currentRails, ...legacyRails]) await closeOwnedPane(run, herdr, pane.pane_id);
      await fs.rm(statePath, { force: true });
      await removeLegacyPaneState({ workspaceId, entrypoint, environment });
      return { paneId: "", closed: true };
    }
    const ownedPaneIds = new Set([...currentRails, ...legacyRails].map((pane) => pane.pane_id));
    let keptRail = currentRails.find((pane) => pane.pane_id === state?.paneId) || currentRails[0] || null;
    let replacementRails = [];
    if (!keptRail && legacyRails.length > 0) {
      const primaryLegacy = legacyRails.find((pane) => pane.pane_id === state?.paneId) || legacyRails[0];
      replacementRails = [
        ...legacyRails.filter((pane) => pane.pane_id !== primaryLegacy.pane_id),
        primaryLegacy,
      ];
    }
    const invokedFromRail = Boolean(keptRail && invocation.requestedPaneId === keptRail.pane_id);
    const replaceExisting = Boolean(keptRail && openMode !== "ensure" && !invokedFromRail);
    if (replaceExisting) {
      const zoomProbe = sourcePane(tabPanes, invocation.requestedPaneId, null, ownedPaneIds, entrypoint) || keptRail;
      let beforeReplace = await paneLayout(run, herdr, zoomProbe.pane_id);
      if (beforeReplace.zoomed) {
        restoreFocusLocation = await globalFocusLocation(run, herdr);
        await run(herdr, ["pane", "zoom", "--pane", zoomProbe.pane_id, "--off"], {
          timeoutMs: 5_000,
          maxOutputBytes: 256 * 1_024,
        });
        restoreZoomPaneId = zoomProbe.pane_id;
        beforeReplace = await paneLayout(run, herdr, zoomProbe.pane_id);
      }
      const replacementContentPanes = tabPanes.filter((pane) => (
        pane.label !== PREVIEW_LABEL && !ownedPaneIds.has(pane.pane_id)
      ));
      const replacementTargetId = rightmostPaneId(beforeReplace, replacementContentPanes);
      const replacementTarget = (beforeReplace.panes || []).find((pane) => pane.pane_id === replacementTargetId);
      const replacementSafe = beforeReplace.area && replacementTarget?.rect
        && replacementTarget.rect.y === beforeReplace.area.y
        && replacementTarget.rect.height === beforeReplace.area.height;
      if (!replacementSafe) {
        console.error(`SideRail open skipped tab ${sanitizeTerminalText(invocation.tabId)} because an outer-right split is not safe`);
        return { paneId: keptRail.pane_id, adopted: true, openMode, skipped: true };
      }
      replacementRails = [
        ...[...currentRails, ...legacyRails].filter((pane) => pane.pane_id !== keptRail.pane_id),
        keptRail,
      ];
      keptRail = null;
    }

    if (keptRail) {
      for (const pane of [...currentRails, ...legacyRails]) {
        if (pane.pane_id !== keptRail.pane_id) await closeOwnedPane(run, herdr, pane.pane_id);
      }
      const contentPane = sourcePane(tabPanes, invocation.requestedPaneId, null, ownedPaneIds, entrypoint);
      const adoptedCwd = invocation.workspaceCwd
        || contentPane?.foreground_cwd
        || contentPane?.cwd
        || state?.cwd
        || keptRail.cwd
        || "";
      const contentPanes = tabPanes.filter((pane) => pane.label !== PREVIEW_LABEL && !ownedPaneIds.has(pane.pane_id));
      try {
        let placementChanged = false;
        if (contentPanes.length > 0 && openMode !== "ensure") {
          const layout = await paneLayout(run, herdr, keptRail.pane_id);
          if (!layout.zoomed) {
            const placement = await placeExistingRail({
              run,
              herdr,
              rail: keptRail,
              contentPanes,
              layout,
            });
            placementChanged = placement.placementChanged;
          }
        }
        if (placementChanged) {
          await resize({ paneId: keptRail.pane_id, workspaceCwd: adoptedCwd, environment });
        }
      } catch (error) {
        console.error(`SideRail was adopted, but its sidebar placement could not be repaired: ${sanitizeTerminalText(error.message)}`);
      }
      await writePaneState(statePath, keptRail.pane_id, adoptedCwd, keptRail.terminal_id || "");
      await removeLegacyPaneState({ workspaceId, entrypoint, environment });
      try {
        const { result } = await commandJson(run, herdr, ["pane", "get", keptRail.pane_id]);
        writeOutput(result.stdout);
      } catch {
        writeOutput(`${keptRail.pane_id}\n`);
      }
      return { paneId: keptRail.pane_id, adopted: true };
    }

    const layoutProbe = sourcePane(tabPanes, invocation.requestedPaneId, null, ownedPaneIds, entrypoint);
    if (!layoutProbe && legacyRails.length > 0 && entrypoint === "git-tui") {
      const legacy = legacyRails[0];
      await run(herdr, ["pane", "rename", legacy.pane_id, RAIL_LABEL], { timeoutMs: 5_000, maxOutputBytes: 256 * 1_024 });
      await writePaneState(
        statePath,
        legacy.pane_id,
        invocation.workspaceCwd || legacy.cwd || "",
        legacy.terminal_id || "",
      );
      await removeLegacyPaneState({ workspaceId, entrypoint, environment });
      return { paneId: legacy.pane_id, adopted: true };
    }
    if (!layoutProbe) throw new Error("unable to resolve a non-SideRail pane in the target tab");
    const replacementPaneIds = new Set(replacementRails.map((pane) => pane.pane_id));
    for (const pane of legacyRails) {
      if (!replacementPaneIds.has(pane.pane_id)) await closeOwnedPane(run, herdr, pane.pane_id);
    }

    let layout = await paneLayout(run, herdr, layoutProbe.pane_id);
    if (layout.zoomed) {
      restoreFocusLocation = await globalFocusLocation(run, herdr);
      await run(herdr, ["pane", "zoom", "--pane", layoutProbe.pane_id, "--off"], {
        timeoutMs: 5_000,
        maxOutputBytes: 256 * 1_024,
      });
      restoreZoomPaneId = layoutProbe.pane_id;
      layout = await paneLayout(run, herdr, layoutProbe.pane_id);
    }
    const source = sourcePane(tabPanes, invocation.requestedPaneId, layout, ownedPaneIds, entrypoint) || layoutProbe;
    const contentPanes = tabPanes.filter((pane) => pane.label !== PREVIEW_LABEL && !ownedPaneIds.has(pane.pane_id));
    const placementPaneId = rightmostPaneId(layout, contentPanes) || source.pane_id;
    const placementLayout = (layout.panes || []).find((pane) => pane.pane_id === placementPaneId);
    const canSplitAtOuterRight = layout.area && placementLayout?.rect
      && placementLayout.rect.y === layout.area.y
      && placementLayout.rect.height === layout.area.height;
    invocation.workspaceCwd ||= source.foreground_cwd || source.cwd || "";

    let paneId;
    let openedStdout;
    if (canSplitAtOuterRight) {
      const openArgs = [
        "plugin", "pane", "open",
        "--plugin", pluginId,
        "--entrypoint", entrypoint,
        "--no-focus",
      ];
      if (invocation.workspaceCwd) openArgs.push("--env", `SIDERAIL_REPO_ROOT=${invocation.workspaceCwd}`);
      if (source.pane_id) openArgs.push("--env", `SIDERAIL_SOURCE_PANE_ID=${source.pane_id}`);
      if (invocation.tabId) openArgs.push("--env", `SIDERAIL_SOURCE_TAB_ID=${invocation.tabId}`);
      openArgs.push("--target-pane", placementPaneId, "--placement", "split", "--direction", "right");
      const priorPaneIds = await workspacePaneIds(run, herdr, workspaceId);
      const opened = await run(herdr, openArgs, { timeoutMs: 8_000, maxOutputBytes: 2 * 1_024 * 1_024 });
      paneId = resultPaneId(opened.stdout);
      openedStdout = opened.stdout;
      if (!paneId) throw new Error("Herdr did not return the opened SideRail pane id");
      await validateOpenedRail({
        run,
        herdr,
        paneId,
        workspaceId,
        tabId: invocation.tabId,
        entrypoint,
        priorPaneIds,
      });
      try {
        for (const pane of replacementRails) await closeOwnedPane(run, herdr, pane.pane_id);
      } catch (error) {
        const replacementClosed = await closeOwnedPane(run, herdr, paneId, { quiet: true });
        if (!replacementClosed) {
          throw new Error(`${error.message}; replacement pane ${paneId} also could not be closed`, { cause: error });
        }
        throw error;
      }
    } else {
      console.error(`SideRail open skipped tab ${sanitizeTerminalText(invocation.tabId)} because an outer-right split is not safe`);
      return { paneId: "", adopted: false, openMode, skipped: true };
    }
    writeOutput(openedStdout);
    let terminalId = "";
    try {
      const { payload: openedPanePayload } = await commandJson(run, herdr, ["pane", "get", paneId], {
        timeoutMs: 3_000,
        maxOutputBytes: 256 * 1_024,
      });
      const openedPane = openedPanePayload?.result?.pane;
      if (openedPane?.pane_id === paneId && openedPane.workspace_id === workspaceId) {
        terminalId = openedPane.terminal_id || "";
      }
    } catch (error) {
      console.error(`SideRail opened, but its pane instance identity could not be recorded: ${sanitizeTerminalText(error.message)}`);
    }
    await writePaneState(statePath, paneId, invocation.workspaceCwd, terminalId);
    await removeLegacyPaneState({ workspaceId, entrypoint, environment });
    try {
      await resize({ paneId, workspaceCwd: invocation.workspaceCwd, environment });
    } catch (error) {
      console.error(`SideRail opened, but its configured sidebar width could not be applied: ${sanitizeTerminalText(error.message)}`);
    }
    return { paneId, adopted: false, openMode };
  } finally {
    if (restoreZoomPaneId) {
      try {
        await run(herdr, ["pane", "zoom", "--pane", restoreZoomPaneId, "--on"], {
          timeoutMs: 5_000,
          maxOutputBytes: 256 * 1_024,
        });
      } catch {}
    }
    if (restoreFocusLocation) {
      try {
        await restoreGlobalFocus(run, herdr, restoreFocusLocation);
      } catch {}
    }
    await release();
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    await openHerdrPanel({ entrypoint: process.argv[2], openMode: process.argv[3] });
  } catch (error) {
    console.error(sanitizeTerminalText(error.message));
    process.exitCode = 1;
  }
}
