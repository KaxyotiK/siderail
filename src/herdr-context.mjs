function parseJson(value) {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

const GITRAIL_LABELS = new Set([
  "HERDR GITRAIL",
  "HERDER GITRAIL",
  "Grove Git Rail",
  "GitRail Demo",
  "GitRail Preview",
]);

export function selectTabContentPane(panes, layout, {
  railPaneId = "",
  sourcePaneId = "",
} = {}) {
  const candidates = panes.filter((pane) => pane.pane_id !== railPaneId && pane.label !== "GitRail Preview");
  const content = candidates.filter((pane) => !GITRAIL_LABELS.has(pane.label));
  return content.find((pane) => pane.pane_id === layout?.focused_pane_id)
    || content.find((pane) => pane.pane_id === sourcePaneId)
    || content[0]
    || null;
}

export function selectHerdrSnapshotContext(snapshot, {
  railPaneId = "",
  railTerminalId = "",
  sourcePaneId = "",
  fallbackCwd = "",
} = {}) {
  const panes = Array.isArray(snapshot?.panes) ? snapshot.panes : [];
  const rail = panes.find((pane) => pane.pane_id === railPaneId)
    || (railTerminalId ? panes.find((pane) => pane.terminal_id === railTerminalId) : null);
  if (!rail?.tab_id) {
    return {
      cwd: fallbackCwd,
      sourcePaneId: "",
      tabId: "",
      workspaceId: "",
      railPaneId,
      railTerminalId,
      hasContent: false,
      visible: false,
    };
  }

  const layouts = Array.isArray(snapshot?.layouts) ? snapshot.layouts : [];
  const layout = layouts.find((candidate) => candidate.tab_id === rail.tab_id);
  const tabPanes = panes.filter((pane) => pane.tab_id === rail.tab_id);
  const source = selectTabContentPane(tabPanes, layout, {
    railPaneId: rail.pane_id,
    sourcePaneId,
  });
  const active = snapshot.focused_workspace_id === rail.workspace_id
    && snapshot.focused_tab_id === rail.tab_id;
  const visible = active && (!layout?.zoomed || layout.focused_pane_id === rail.pane_id);
  return {
    cwd: source?.foreground_cwd || source?.cwd || fallbackCwd,
    sourcePaneId: source?.pane_id || "",
    tabId: rail.tab_id,
    workspaceId: rail.workspace_id || "",
    railPaneId: rail.pane_id,
    railTerminalId: rail.terminal_id || railTerminalId,
    hasContent: Boolean(source),
    visible,
  };
}

export function sameHerdrSnapshotContext(left, right) {
  if (!left || !right) return false;
  return left.cwd === right.cwd
    && left.sourcePaneId === right.sourcePaneId
    && left.tabId === right.tabId
    && left.workspaceId === right.workspaceId
    && left.railPaneId === right.railPaneId
    && left.railTerminalId === right.railTerminalId
    && left.hasContent === right.hasContent
    && left.visible === right.visible;
}

export async function resolveHerdrTabCwd({
  run,
  herdr = "herdr",
  workspaceId = "",
  railPaneId = "",
  sourcePaneId = "",
  fallbackCwd = "",
}) {
  if (!railPaneId) return { cwd: fallbackCwd, sourcePaneId, tabId: "", workspaceId };
  try {
    const railResult = await run(herdr, ["pane", "get", railPaneId], {
      timeoutMs: 3_000,
      maxOutputBytes: 256 * 1_024,
    });
    const rail = parseJson(railResult.stdout)?.result?.pane;
    if (!rail?.tab_id) return { cwd: fallbackCwd, sourcePaneId, tabId: "", workspaceId };
    const resolvedWorkspaceId = rail.workspace_id || workspaceId || "";
    const [paneResult, layoutResult] = await Promise.all([
      run(herdr, ["pane", "list", "--workspace", resolvedWorkspaceId], {
        timeoutMs: 3_000,
        maxOutputBytes: 4 * 1_024 * 1_024,
      }),
      run(herdr, ["pane", "layout", "--pane", railPaneId], {
        timeoutMs: 3_000,
        maxOutputBytes: 2 * 1_024 * 1_024,
      }),
    ]);
    const panes = (parseJson(paneResult.stdout)?.result?.panes || [])
      .filter((pane) => pane.tab_id === rail.tab_id);
    const layout = parseJson(layoutResult.stdout)?.result?.layout;
    const source = selectTabContentPane(panes, layout, { railPaneId, sourcePaneId });
    return {
      cwd: source?.foreground_cwd || source?.cwd || fallbackCwd,
      sourcePaneId: source?.pane_id || sourcePaneId,
      tabId: rail.tab_id,
      workspaceId: resolvedWorkspaceId,
    };
  } catch {
    return { cwd: fallbackCwd, sourcePaneId, tabId: "", workspaceId };
  }
}
