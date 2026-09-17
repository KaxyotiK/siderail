# Installation and upgrades

GitRail is currently an unreleased development checkout. No tagged release is
available yet. The instructions below install the current `main` branch; see
[production readiness](../PRODUCTION-READINESS.md) for the release status.

## Install from a checkout

```bash
git clone https://github.com/KaxyotiK/git-railgun.git
cd git-railgun
npm ci --ignore-scripts
npm run check
herdr plugin link .
herdr plugin action invoke local.git-rail.open-git-rail
```

To bind the current-tab toggle, add this to `~/.config/herdr/config.toml`, then
run `herdr config check` and restart or reload Herdr's configuration:

```toml
[[keys.command]]
key = "ctrl+g"
type = "plugin_action"
command = "local.git-rail.toggle-git-rail"
description = "toggle GitRail sidebar"
```

The key mapping is a Herdr setting; the action itself is declared by the
GitRail plugin. It only closes a pane after verifying that the pane belongs to
GitRail.

The action opens GitRail immediately in the current tab. After linking, GitRail
also opens without taking focus in Git-backed workspaces and tabs created later
and reconciles existing Git tabs the next time the Herdr server starts.
Set `herdr.autoOpen` to `false` in GitRail configuration to opt out; the manual
action remains available. `herdr.sidebarWidth` controls the initial rail width
in terminal columns and defaults to 34.

In Herdr, `.md`, `.mdx`, and `.markdown` files open directly in the operating
system's default application through macOS `open` or Linux `xdg-open`; GitRail
does not create a preview tab first. The viewer rule can be disabled or replaced
in configuration. Glow is optional and can still be configured as an embedded
or terminal viewer.

Herdr reads the linked checkout directly. To upgrade, close GitRail, update the
checkout, run `npm ci --ignore-scripts` and `npm run check`, relink with
`herdr plugin link .`, and reopen it.
Herdr rails from a compatible checkout and host session share an on-demand
Git-state coordinator. Each tab keeps its own UI; the coordinator owns the
repository watchers, Git reads, and host-context reconciliation. No system
service is installed. Standalone, demo/snapshot, and cmux launches use their
own in-process state engine.

Keep the complete `src/` directory and `scripts/git-state-coordinator.mjs` with
the other launchers when copying or archiving a checkout. `npm run artifact:verify`
checks the manifest entrypoints and their local runtime imports. Runtime
namespaces include the canonical checkout, code contents, host socket, user,
and effective Git context, so a candidate checkout does not reuse an installed
checkout's coordinator.
Until the first tagged release is available, upgrades follow the development
branch and may include changes that have not completed release validation.

## Install in the cmux right sidebar Dock

The cmux host is independent of the Herdr plugin. This checkout's
`.cmux/dock.json` launches `scripts/cmux-git-rail.mjs` through a cmux-specific
Node discovery bootstrap and the same guarded Node launcher. Review and trust that project control in cmux, or run
`npm run cmux:launch` from a cmux terminal for a supported CLI-based launch.
The direct launcher does not focus the Dock and reuses an existing
GitRail surface from this checkout. A running configured control records its
process-backed active identity in GitRail's owner-only cache so the launcher
can distinguish it from unrelated configured Dock controls and from its own
post-`q` shell. Both configured and direct controls enter a login shell after
GitRail exits; another direct launch reuses that verified terminal.

See [CMUX.md](CMUX.md) for cwd resolution, additive preview tabs, session-seed,
upgrade, and removal behavior.

## Uninstall

From the linked checkout, run `npm run uninstall:herdr`. It closes only panes
whose live process and terminal-instance identity prove that GitRail owns them,
then unlinks `local.git-rail`. Restart Herdr and remove the checkout only after
`herdr plugin list` reports that GitRail is absent. Optional pane ownership state lives in
`~/.cache/herdr-gitrail/panes/` and contains only Herdr pane identifiers.

Closing the last rail releases its shared repository engines and lets the
coordinator exit automatically. Its socket and lease live in an owner-only
runtime directory under a suitable `XDG_RUNTIME_DIR`, or `/tmp/git-railgun-<uid>`.
Do not delete another running checkout's runtime directory or kill processes
by a broad name match. A subsequent launch validates a stale owner's identity
before reclaiming that namespace.

To roll back a candidate, close its verified rails, allow its coordinator to
exit, and link the previously validated checkout before reopening rails.
The new healthy-reconciliation setting is optional: an older checkout requires
removing `refresh.reconcileIntervalMs` from any configuration you added, because
unknown configuration keys are rejected. Implementation and fixture validation
do not themselves install or relink the candidate.

## Configuration

Copy `git-rail.config.example.json` to
`~/.config/git-rail/config.json`. Environment overrides win over user values.
The configuration file must declare `"version": 1`; unknown keys and mistyped
nested structures are rejected instead of being silently ignored. Repository
contents are never read as GitRail configuration.
