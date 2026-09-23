import assert from "node:assert/strict";
import test from "node:test";
import { resolveHostIdentity } from "../src/host-identity.mjs";

const herdrEnvironment = {
  HERDR_WORKSPACE_ID: "herdr-workspace",
  HERDR_WORKSPACE_CWD: "/herdr/workspace",
  HERDR_TAB_ID: "herdr-tab",
  HERDR_PANE_ID: "herdr-pane",
  HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
    workspace_id: "context-workspace",
    workspace_cwd: "/context/workspace",
    focused_pane_cwd: "/context/pane",
    focused_pane_id: "context-pane",
    tab_id: "context-tab",
  }),
};

test("a cmux Dock never inherits Herdr workspace, pane, or tab identity", () => {
  const identity = resolveHostIdentity({
    host: "cmux",
    environment: {
      ...herdrEnvironment,
      SIDERAIL_SOURCE_PANE_ID: "herdr-source-pane",
      SIDERAIL_SOURCE_TAB_ID: "herdr-source-tab",
      SIDERAIL_PROJECT_CWD: "/worktrees/branding-options",
      CMUX_SURFACE_ID: "dock-surface",
      CMUX_DOCK_CONTROL_ID: "siderail",
    },
    fallbackCwd: "/fallback",
  });
  assert.deepEqual(identity, {
    cwd: "/worktrees/branding-options",
    sourcePaneId: "",
    sourceTabId: "",
    workspaceId: "",
    dockSurfaceId: "dock-surface",
    dockControlId: "siderail",
  });
});

test("a cmux Dock without a project cwd falls back to its own directory, never a Herdr one", () => {
  const identity = resolveHostIdentity({
    host: "cmux",
    environment: { ...herdrEnvironment, CMUX_SURFACE_ID: "dock-surface" },
    fallbackCwd: "/Users/operator",
  });
  assert.equal(identity.cwd, "/Users/operator");
  assert.equal(identity.workspaceId, "");
  assert.equal(identity.dockControlId, "siderail");
});

test("a Herdr pane never inherits cmux Dock identity", () => {
  const identity = resolveHostIdentity({
    host: "herdr",
    environment: {
      ...herdrEnvironment,
      CMUX_SURFACE_ID: "dock-surface",
      CMUX_WORKSPACE_ID: "cmux-window",
      CMUX_DOCK_CONTROL_ID: "siderail",
      SIDERAIL_PROJECT_CWD: "/cmux/project",
    },
    fallbackCwd: "/fallback",
  });
  assert.equal(identity.dockSurfaceId, "");
  assert.equal(identity.dockControlId, "");
  assert.equal(identity.workspaceId, "herdr-workspace");
  assert.equal(identity.sourceTabId, "herdr-tab");
  assert.equal(identity.cwd, "/context/pane");
  assert.notEqual(identity.cwd, "/cmux/project");
});

test("Herdr identity prefers explicit overrides, then plugin context, then ambient variables", () => {
  assert.equal(resolveHostIdentity({
    host: "herdr",
    environment: { ...herdrEnvironment, SIDERAIL_REPO_ROOT: "/explicit/root" },
  }).cwd, "/explicit/root");
  assert.equal(resolveHostIdentity({
    host: "herdr",
    environment: { HERDR_WORKSPACE_CWD: "/herdr/workspace" },
    fallbackCwd: "/fallback",
  }).cwd, "/herdr/workspace");
  assert.equal(resolveHostIdentity({
    host: "herdr",
    environment: {},
    fallbackCwd: "/fallback",
  }).cwd, "/fallback");
  assert.equal(resolveHostIdentity({
    host: "herdr",
    environment: { ...herdrEnvironment, SIDERAIL_SOURCE_PANE_ID: "override-pane" },
  }).sourcePaneId, "override-pane");
});

test("an explicit repo root still overrides a cmux Dock project directory", () => {
  assert.equal(resolveHostIdentity({
    host: "cmux",
    environment: { SIDERAIL_REPO_ROOT: "/explicit/root", SIDERAIL_PROJECT_CWD: "/dock/project" },
  }).cwd, "/explicit/root");
});

test("a malformed or non-object Herdr plugin context degrades to no context", () => {
  for (const payload of ["not json", "[]", "null", "\"text\"", ""]) {
    const identity = resolveHostIdentity({
      host: "herdr",
      environment: { HERDR_PLUGIN_CONTEXT_JSON: payload, HERDR_WORKSPACE_ID: "herdr-workspace" },
      fallbackCwd: "/fallback",
    });
    assert.equal(identity.cwd, "/fallback");
    assert.equal(identity.workspaceId, "herdr-workspace");
  }
});

test("blank and whitespace-only host variables are treated as absent", () => {
  const identity = resolveHostIdentity({
    host: "cmux",
    environment: {
      SIDERAIL_PROJECT_CWD: "   ",
      CMUX_SURFACE_ID: "  ",
      CMUX_DOCK_CONTROL_ID: "   ",
    },
    fallbackCwd: "/fallback",
  });
  assert.equal(identity.cwd, "/fallback");
  assert.equal(identity.dockSurfaceId, "");
  assert.equal(identity.dockControlId, "siderail");
});

test("an unknown host is treated as Herdr rather than granting Dock identity", () => {
  const identity = resolveHostIdentity({
    host: "",
    environment: { ...herdrEnvironment, CMUX_SURFACE_ID: "dock-surface" },
  });
  assert.equal(identity.dockSurfaceId, "");
  assert.equal(identity.workspaceId, "herdr-workspace");
});
