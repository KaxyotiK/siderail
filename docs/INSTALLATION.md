# Installation and upgrades

## Install from a checkout

```bash
git clone https://github.com/KaxyotiK/git-rail.git
cd git-rail
npm run check
herdr plugin link .
herdr plugin action invoke local.git-rail.open-git-rail
```

To bind the current-tab toggle, add this to `~/.config/herdr/config.toml`, then
run `herdr config check` and restart or reload Herdr's configuration:

```toml
[[keys.command]]
key = "prefix+alt+g"
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

Install [Glow](https://github.com/charmbracelet/glow) to use the installed
Markdown default. GitRail automatically launches Glow for `.md`, `.mdx`, and
`.markdown` previews. Diff and Raw do not require Glow, and the viewer rule can
be disabled or replaced in configuration. When Glow is not on `PATH`, GitRail
skips automatic launch and keeps the preview open with an installation hint.

Herdr reads the linked checkout directly. To upgrade, close GitRail, update the
checkout, run `npm run check`, relink with `herdr plugin link .`, and reopen it.
Use a tagged release in production rather than an arbitrary moving branch.

## Uninstall

Use Herdr's plugin unlink/remove command for `local.git-rail`, then remove the
checkout. Optional pane ownership state lives in
`~/.cache/herdr-gitrail/panes/` and contains only Herdr pane identifiers.

## Configuration

Copy `git-rail.config.example.json` to `.git-rail.json` in a trusted repository
or to `~/.config/git-rail/config.json`. Values merge by key; repository values
override user values, and environment overrides win last. Every configuration
file must declare `"version": 1`; unknown keys and mistyped nested structures
are rejected instead of being silently ignored.
