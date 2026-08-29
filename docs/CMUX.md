# cmux Dock host

GitRail's cmux host runs in cmux's **right sidebar Dock**. It does not use the
left/custom-sidebar interpreter, ExtensionKit, or a fork of cmux. The host is a
thin integration around the same read-only Git provider, models, terminal UI,
and exact-revision preview provider used by the Herdr product.

## Requirements

- Node.js 22 or newer
- Git 2.35 or newer
- a cmux build with right-sidebar Dock controls, native `cmux open`, plus v2
  surface creation, discovery, close, terminal `send`/`send-key`, and `right-sidebar`
  CLI commands
- macOS (cmux's supported host platform)

Run the checks before trusting a project Dock config:

```bash
npm ci --ignore-scripts
npm run check
python3 -m json.tool .cmux/dock.json
```

## Project Dock control

This checkout includes [`.cmux/dock.json`](../.cmux/dock.json):

```json
{
  "controls": [
    {
      "id": "git-rail",
      "title": "GitRail",
      "command": "/bin/bash scripts/cmux-node-launcher.sh scripts/cmux-git-rail.mjs",
      "cwd": "."
    }
  ]
}
```

Open this checkout as a cmux project and select Dock in the right sidebar.
cmux asks for trust before first running a project Dock config. Review the
command above, then accept only if the checkout is the one you intended.
The cmux bootstrap validates `GIT_RAIL_NODE_PATH`, standard Homebrew Node
locations, and finally the user's interactive login-shell Node path before it
delegates to GitRail's shared Node 22 version guard.

`dock.json` seeds a new Dock; it does not overwrite a saved Dock snapshot. If
this workspace already has a restored or intentionally empty Dock, use cmux's
Dock config reload action or the direct launch command below. Closing a seeded
control and saving the session intentionally keeps it closed on restart.

To use the control in another repository, copy the control into that
repository's `.cmux/dock.json` and make its command resolve this GitRail
checkout (or a packaged installation) explicitly. Do not commit a
machine-specific absolute path to a shared project config.

## Direct launch

From a cmux terminal in the intended project:

```bash
npm run cmux:launch
```

The launcher uses cmux's supported `surface.create` call with
`placement: "dock"`, then switches the right sidebar to Dock with
`--no-focus`. It adopts an existing CLI-launched GitRail surface from this
checkout, and recognizes the configured control when invoked from that
control's shell, instead of opening a duplicate. The command is useful when
Dock session restore prevents config seeding or while developing the
integration.

Current cmux discovery does not expose a configured control id on every Dock
surface. A running GitRail control therefore records its process-backed active
instance and stable workspace/control/surface identity in the owner-only
GitRail cache before performing cmux context discovery. The direct launcher
matches that record against live Dock discovery across main-workspace changes.
It briefly waits for a configured control that is still starting; unrelated
configured controls neither match nor block a GitRail launch.

## Cwd and identity rules

cmux injects `CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID`,
`CMUX_DOCK_CONTROL_ID`, and `CMUX_DOCK_CONTROL_TITLE` into a configured Dock
terminal. GitRail retains all four values as host identity, but it does not
assume the Dock surface is the source surface.

On each refresh GitRail asks cmux for the selected main workspace and uses its
`current_directory`. This follows main-area directory changes while excluding
the GitRail Dock surface from source selection. `cwd: "."` supplies the
project-directory fallback if the cmux socket is temporarily unavailable.
This also handles cmux versions where a Dock terminal's
`CMUX_WORKSPACE_ID` names a Dock/window owner rather than the selected main
workspace.

Every cmux mutation is explicitly scoped to the resolved main workspace or to
the returned surface id. GitRail never relies on whichever other cmux window
or workspace happens to be visually focused later.

## Native previews and close behavior

Enter or double-click opens the selection with `cmux open` as a native file tab
beside the main-area source surface, never as another split or Dock control.
GitRail supplies a bounded, read-only materialization of the exact selected
revision for changed, clean, and filesystem rows. Preserving the original
basename and extension lets cmux choose its Markdown, image, PDF, media, or
general file viewer.

The materialization directory and native tab title identify both the selected
scope and displayed bytes—for example, `Staged · Index · read-only` or
`Commit abc12345 · Revision def67890 before deletion · read-only`—so the
viewer never presents a historical/index copy as the live worktree file.
The copy remains owner-readable and non-writable; cmux may still display its
standard viewer controls, but the repository file is never handed to that tab.

GitRail still owns Git interpretation: staged content comes from the index,
Against uses the resolved merge base, commit diffs use the first parent, and
deleted, renamed, copied, symlink, submodule, and binary states retain the same
semantics as Herdr. The cmux host changes presentation only; Herdr continues to
use GitRail's terminal preview TUI and configured viewer/editor actions.

Preview commands explicitly target the resolved main workspace and, when
available, its main-area source surface. The Dock's ambient
`CMUX_SURFACE_ID` is cleared from the child command environment so it cannot be
mistaken for a split or tab target.

Only one GitRail-owned native preview is retained per main workspace and
stable GitRail Dock control identity. A replacement is opened and recorded first; the prior
surface is closed only after discovery verifies its exact id, native panel
type, and main-area scope. A stale or foreign surface is left untouched.
Read-only materializations remain available while their native cmux tab is
open, then are removed after verified replacement or when a later open detects
that the old surface was already closed. Native tabs otherwise use cmux's
normal close behavior. Failed cleanup generations remain recorded and are
retried on the next preview open, including after the Dock terminal restarts.
The first open after upgrading also migrates validated surface-keyed ownership
records from earlier cmux GitRail builds into this stable registry.

Pressing `q` in the GitRail Dock control exits the TUI. cmux then follows its
normal Dock terminal contract and drops into the control's login shell, which
keeps the section available for inspection or rerunning. A later
`npm run cmux:launch` recognizes that the recorded process has exited and
relaunches GitRail in the same verified Dock terminal rather than mistaking the
shell for an active instance or creating another control. Close the Dock tab
with cmux when the surface itself should be removed.

GitRail recognizes terminal mouse double-clicks with a fixed 700 ms interval.
cmux does not currently expose the macOS double-click preference to terminal
applications; Enter is the fully deterministic open action.

## Remove or upgrade

Remove the `git-rail` control from the applicable `dock.json`, validate the
JSON, and reload the Dock config. That affects only the Dock control; it does
not unlink or alter the Herdr plugin. To upgrade, update this checkout, run
`npm ci --ignore-scripts` and `npm run check`, then reload or relaunch the Dock
control.

The automated suite uses fake cmux command execution. A final release should
also be exercised in a live cmux build: trust/reload the project config, change
the selected main terminal's cwd, open and replace native file tabs, close a
preview with cmux, and confirm another window's Dock and main
surfaces remain untouched.
