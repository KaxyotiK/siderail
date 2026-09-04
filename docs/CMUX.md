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

On its first configured launch, GitRail registers the Dock surface with cmux's
supported `surface resume` lifecycle. cmux displays its standard **Allow Resume
Command?** dialog; choose **Auto-Restore** once. A saved Dock snapshot takes
precedence over `dock.json` on later app launches, and this approved binding is
what restarts GitRail inside that restored surface instead of leaving its login
shell open. The binding is scoped to the exact Dock surface and window, uses the
absolute launcher from the installed checkout, and remains subject to cmux's
signed resume-command approval policy.

Current cmux discovery does not expose a configured control id on every Dock
surface. A running GitRail control therefore records its process-backed active
instance and stable control/surface identity in the owner-only GitRail cache
before performing cmux context discovery. The direct launcher matches that
record against live Dock discovery across main-workspace changes. It briefly
waits for a configured control that is still starting; unrelated configured
controls neither match nor block a GitRail launch.

## Dock control ownership records

Ownership is the pair of Dock surface and control id. The workspace a Dock
follows is recorded as observation only and is never used to identify a control,
because it changes whenever the user selects another workspace. A control
registers once at startup rather than on every refresh, so one Dock control
keeps exactly one record for its lifetime.

Version 3 records are named from the surface and control and live in a
`surfaces` subdirectory of the control cache, so a lookup reads the records for
the Dock surfaces it can already see rather than every record ever written.
Version 2 records were named from the workspace. When no version 3 record
matches, the reader falls back to the version 2 scan, keeps its existing
selection rules, copies the selected record forward, and only removes legacy
duplicates naming that same surface after the new record reads back. A failed
migration returns the version 2 record unchanged, because losing a live control
is worse than leaving a duplicate. Records for surfaces the caller cannot see
are never touched, and a recorded process being dead is never a reason to remove
a record: the relaunch path depends on finding exactly that.

A recorded process id alone cannot prove the recorded process is still running,
because the id can be reassigned after a control exits. Version 3 records pair
the id with the operating system's start time for it, and a control counts as
active only when both match. Version 2 records predate the marker and stay
process-id only for one compatibility cycle, so an upgrade cannot report a live
control as dead.

The cmux event stream ending is not treated as a failure when it exits cleanly,
but any termination GitRail did not request is reported, logged, and falls back
to the bounded refresh poll, so losing selection-following degrades visibly in
the debug log instead of silently.

## Dock ownership

A GitRail Dock control is owned by the cmux **window** that contains its Dock
surface. That window, not whichever window happens to be focused, scopes every
later lookup: the selected workspace, the main-area source surface, and the
project directory.

cmux reports `caller: null` for a Dock surface, so `identify` cannot name the
owning window on its own. GitRail therefore discovers the owner from its own
`CMUX_SURFACE_ID`: the owner is the window whose `list-panels` output contains
that surface. `GIT_RAIL_WINDOW_ID` and the global-Dock convention of
`CMUX_WORKSPACE_ID` naming a window are consulted only afterwards, and only
when they match a live window, because both are lost across Dock restore and
relaunch. The resolved window id is cached for the life of the process and
rediscovered after any failed context resolution.

Because cmux stores no environment beside a resume binding and `send` types into
a shell that no longer holds the Dock's startup environment, both the relaunch
command and the restart command restate the host variables they need. The owner
window id is deliberately excluded from the resume command: window ids do not
survive an app restart, and a stale one would outrank live discovery.

A directory that exists is not necessarily checked out — a global Dock control's
`cwd: "."` resolves to the home directory. GitRail prefers the first candidate
that is inside a repository, so the Dock does not settle on a valid but
unversioned folder and report changes as unavailable.

## Host isolation

GitRail runs under exactly one host per process, chosen by `GIT_RAIL_HOST`. The
Herdr identity variables and `HERDR_PLUGIN_CONTEXT_JSON` are read only under the
Herdr host, and the `CMUX_*` identity variables only under cmux. A Dock terminal
started from a Herdr-managed shell inherits `HERDR_*` variables describing an
unrelated pane; reading them would seed a cmux Dock ownership record with a
Herdr workspace id, so they are ignored rather than merged.

## Cwd and identity rules

cmux injects `CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID`,
`CMUX_DOCK_CONTROL_ID`, and `CMUX_DOCK_CONTROL_TITLE` into a configured Dock
terminal. GitRail retains all four values as host identity, but it does not
assume the Dock surface is the source surface.

GitRail asks cmux for the selected main workspace and focused main-area surface,
excluding every Dock surface from source selection. A valid launch or requested
working directory on that main-area surface pins the selected project even when
cmux's workspace `current_directory` was most recently updated by a window Dock
terminal. Resume and live workspace directories remain bounded recovery paths
when the main surface has no valid project folder. A scoped cmux event stream refreshes the provider as soon as
workspace, pane, or surface selection changes, while the ordinary bounded poll
remains a recovery path. `cwd: "."` supplies the project-directory fallback only
when cmux exposes no selected source path. This also handles cmux versions where a Dock terminal's
`CMUX_WORKSPACE_ID` names a Dock/window owner rather than the selected main
workspace.

Every cmux mutation is explicitly scoped to the resolved main workspace or to
the returned surface id. GitRail never relies on whichever other cmux window
or workspace happens to be visually focused later.

## Native previews and close behavior

Enter or a single file click opens the selection with `cmux open` as a native file tab
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

Every selection opens a new native cmux tab. Opening file B never closes or
reuses the tab previously opened for file A; both remain available until the
user closes them with cmux's normal tab controls.

GitRail records every open preview under the main workspace and stable GitRail
Dock control identity so each read-only materialization remains available for
the lifetime of its native tab. On a later open, entries for tabs that the user
already closed are pruned and their materializations are removed. Discovery
failures leave existing tabs and files untouched and are retried on the next
preview open, including after the Dock terminal restarts. The first open after
upgrading also migrates surface-keyed and replacement-era ownership records
into this additive registry without closing their tabs.

Pressing `q` in the GitRail Dock control exits the TUI. cmux then follows its
normal Dock terminal contract and drops into the control's login shell, which
keeps the section available for inspection or rerunning. A later
`npm run cmux:launch` recognizes that the recorded process has exited and
relaunches GitRail in the same verified Dock terminal rather than mistaking the
shell for an active instance or creating another control. Close the Dock tab
with cmux when the surface itself should be removed.

GitRail opens a cmux native preview on the first file click. A second click in
the terminal double-click interval selects the same row without opening a
duplicate preview. Enter remains the fully deterministic keyboard open action.

## Remove or upgrade

Remove the `git-rail` control from the applicable `dock.json`, validate the
JSON, and reload the Dock config. That affects only the Dock control; it does
not unlink or alter the Herdr plugin. To upgrade, update this checkout, run
`npm ci --ignore-scripts` and `npm run check`, then reload or relaunch the Dock
control.

The automated suite uses fake cmux command execution. A final release should
also be exercised in a live cmux build: trust/reload the project config, change
the selected main terminal's cwd, open two files and confirm both native tabs
remain, close a preview with cmux, open another file to exercise pruning, and
confirm another window's Dock and main surfaces remain untouched.
