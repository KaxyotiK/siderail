/**
 * Host identity seeding.
 *
 * SideRail runs under exactly one host per process. Herdr supplies its identity
 * through HERDR_* variables and HERDR_PLUGIN_CONTEXT_JSON; cmux supplies its own
 * through CMUX_* variables. Those sets are read separately and never merged: a
 * Dock terminal started from a Herdr-managed shell inherits HERDR_* variables
 * that describe an unrelated pane, and letting them through would seed a cmux
 * Dock ownership record with a Herdr workspace id.
 */

function normalized(value) {
  return String(value || "").trim();
}

function herdrPluginContext(environment = process.env) {
  try {
    const parsed = JSON.parse(environment.HERDR_PLUGIN_CONTEXT_JSON || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function resolveHostIdentity({ host, environment = process.env, fallbackCwd = process.cwd() } = {}) {
  const cmuxHosted = host === "cmux";
  const context = cmuxHosted ? {} : herdrPluginContext(environment);
  const cwd = normalized(environment.SIDERAIL_REPO_ROOT)
    || (cmuxHosted ? normalized(environment.SIDERAIL_PROJECT_CWD) : "")
    || normalized(context.focused_pane_cwd)
    || normalized(context.workspace_cwd)
    || (cmuxHosted ? "" : normalized(environment.HERDR_WORKSPACE_CWD))
    || fallbackCwd;
  return {
    cwd,
    sourcePaneId: cmuxHosted
      ? ""
      : normalized(environment.SIDERAIL_SOURCE_PANE_ID) || normalized(context.focused_pane_id),
    sourceTabId: cmuxHosted
      ? ""
      : normalized(environment.SIDERAIL_SOURCE_TAB_ID)
        || normalized(environment.HERDR_TAB_ID)
        || normalized(context.tab_id),
    workspaceId: cmuxHosted
      ? ""
      : normalized(environment.HERDR_WORKSPACE_ID) || normalized(context.workspace_id),
    dockSurfaceId: cmuxHosted ? normalized(environment.CMUX_SURFACE_ID) : "",
    dockControlId: cmuxHosted ? normalized(environment.CMUX_DOCK_CONTROL_ID) || "siderail" : "",
  };
}
