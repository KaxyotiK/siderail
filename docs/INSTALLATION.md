# Installation and upgrades

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
Use a tagged release in production rather than an arbitrary moving branch.

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

## Configuration

Copy `git-rail.config.example.json` to
`~/.config/git-rail/config.json`. Environment overrides win over user values.
The configuration file must declare `"version": 1`; unknown keys and mistyped
nested structures are rejected instead of being silently ignored. Repository
contents are never read as GitRail configuration.
