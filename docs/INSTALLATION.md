# Installation and upgrades

SideRail is distributed as the `siderail` npm package. One install serves both
hosts: Herdr links the installed package directory as a plugin, and cmux runs
it from a Dock control.

## Install

```bash
npm install -g siderail
siderail setup
```

`siderail setup` configures every host it finds on the machine:

- **Herdr:** runs `herdr plugin link` on the installed package, registering it
  as plugin `siderail`. It refuses to replace a GitHub-managed `siderail`
  plugin; uninstall that first.
- **cmux:** adds or updates a control with id `siderail` in
  `~/.config/cmux/dock.json`, keeping every other control and key in that file.
  It never overwrites a `siderail` control that does not launch SideRail, and it
  refuses to edit a file that is not valid JSON.

Name a host to configure only that one: `siderail setup herdr` or
`siderail setup cmux`. Setup is idempotent. `siderail status` prints the
installed version, the install path, and whether each host points at it.

### Herdr

Open SideRail in the current tab with
`herdr plugin action invoke siderail.open-siderail`. To bind the current-tab
toggle, add this to `~/.config/herdr/config.toml`, then run
`herdr config check` and restart or reload Herdr's configuration:

```toml
[[keys.command]]
key = "ctrl+g"
type = "plugin_action"
command = "siderail.toggle-siderail"
description = "toggle SideRail sidebar"
```

The key mapping is a Herdr setting; the action itself is declared by the
SideRail plugin. It only closes a pane after verifying that the pane belongs to
SideRail.

The action opens SideRail immediately in the current tab. After setup, SideRail
also opens without taking focus in Git-backed workspaces and tabs created later
and reconciles existing Git tabs the next time the Herdr server starts.
Set `herdr.autoOpen` to `false` in SideRail configuration to opt out; the manual
action remains available. `herdr.sidebarWidth` controls the initial rail width
in terminal columns and defaults to 34.

In Herdr, `.md`, `.mdx`, and `.markdown` files open directly in the operating
system's default application through macOS `open` or Linux `xdg-open`; SideRail
does not create a preview tab first. The viewer rule can be disabled or replaced
in configuration. Glow is optional and can still be configured as an embedded
or terminal viewer.

Herdr rails from a compatible install and host session share an on-demand
Git-state coordinator. Each tab keeps its own UI; the coordinator owns the
repository watchers, Git reads, and host-context reconciliation. No system
service is installed. Standalone, demo/snapshot, and cmux launches use their
own in-process state engine. Runtime namespaces include the canonical install
path, code contents, host socket, user, and effective Git context, so a
development checkout never reuses an installed package's coordinator.

### cmux Dock

The cmux host is independent of the Herdr plugin. The control that
`siderail setup cmux` writes launches `scripts/cmux-siderail.mjs` from the
install through a cmux-specific Node discovery bootstrap and the same guarded
Node launcher:

```json
{
  "id": "siderail",
  "title": "SideRail",
  "command": "/bin/bash '<install>/scripts/cmux-node-launcher.sh' '<install>/scripts/cmux-siderail.mjs'",
  "cwd": "."
}
```

cmux treats `~/.config/cmux/dock.json` as personal configuration and starts it
without a project trust prompt. It seeds new Docks from that file; a Dock
restored from a saved session keeps its saved layout, so use cmux's Dock config
reload to pick up the control in an open Dock. A project's own
`.cmux/dock.json` takes precedence over the global file inside that project.

A running configured control records its process-backed active identity in
SideRail's owner-only cache so the direct launcher can distinguish it from
unrelated Dock controls and from its own post-`q` shell. Both configured and
direct controls enter a login shell after SideRail exits. See
[CMUX.md](CMUX.md) for cwd resolution, additive preview tabs, session-seed,
and removal behavior.

## Update

```bash
npm install -g siderail@latest
```

npm replaces the install directory at the same path, so Herdr's link and the
Dock control stay valid without running setup again. Each open sidebar checks
its install every two seconds; when the path resolves to a new directory with
a complete entrypoint, it restores the terminal and exits with status 75, and
the Node launcher starts it again from the same path on the new code. The pane
and its identity are unchanged. Rails left on an older coordinator release it
when they restart, and that coordinator exits.

Node version managers such as nvm, fnm, and Volta keep a separate global
prefix per Node version. After switching versions, reinstall SideRail under
the new version and run `siderail setup` so both hosts point at the new
install; `siderail status` marks a registration that still points elsewhere as
stale.

Validated releases are published to npm with a matching `vX.Y.Z` Git tag. To
roll back, install the previous version with `npm install -g siderail@<version>`;
open rails restart onto it the same way. Configuration keys added by a newer
release are rejected by an older one, so remove them first. For example,
`refresh.reconcileIntervalMs` is unknown to releases before it was introduced.

## Uninstall

```bash
siderail uninstall
npm uninstall -g siderail
```

`siderail uninstall` removes only the registrations that point at this install
and leaves a development checkout's link or Dock control in place; name a host
(`siderail uninstall cmux`) to remove that host's control regardless of where it
points. For Herdr it closes only panes whose live process and terminal-instance
identity prove that this install owns them, then unlinks `siderail`, so the
Herdr server must be running. Optional pane ownership state lives in
`~/.cache/siderail/panes/` and contains only Herdr pane identifiers. User
configuration in `~/.config/siderail/` is kept.

Closing the last rail releases its shared repository engines and lets the
coordinator exit automatically. Its socket and lease live in an owner-only
runtime directory under a suitable `XDG_RUNTIME_DIR`, or `/tmp/siderail-<uid>`.
Do not delete another running install's runtime directory or kill processes
by a broad name match. A subsequent launch validates a stale owner's identity
before reclaiming that namespace.

## Develop from a checkout

```bash
git clone https://github.com/KaxyotiK/siderail.git
cd siderail
npm ci --ignore-scripts
npm run check
herdr plugin link .
```

Herdr reads a linked checkout directly, and the checkout keeps its directory
across `git pull`, so an open rail keeps running the code it started with. To
pick up changes, close SideRail, update the checkout, run
`npm ci --ignore-scripts` and `npm run check`, and reopen it. From the linked
checkout, `npm run uninstall:herdr` removes the development link.

The checkout's `.cmux/dock.json` offers the Dock control as a project config.
Review and trust it in cmux, or run `npm run cmux:launch` from a cmux terminal
in the checkout for a supported CLI-based launch that does not focus the Dock
and reuses an existing SideRail surface from this checkout.

Keep the complete `src/` directory and `scripts/git-state-coordinator.mjs` with
the other launchers when copying or archiving a checkout. `npm run artifact:verify`
checks the manifest entrypoints, their local runtime imports, and scripts
launched by path, and fails if the npm `files` allowlist omits any of them.

## Configuration

Copy `siderail.config.example.json` to
`~/.config/siderail/config.json`. Environment overrides win over user values.
The configuration file must declare `"version": 1`; unknown keys and mistyped
nested structures are rejected instead of being silently ignored. Repository
contents are never read as SideRail configuration.
