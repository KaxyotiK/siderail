# Changelog

SideRail follows Semantic Versioning. Until 1.0, minor releases may include
intentional configuration changes documented here.

## Unreleased

### Features

- In Herdr, a rail can show another Git worktree of the same repository that Herdr has open. Press `w` or click the branch line to choose one; the header marks a chosen worktree as pinned.
- `siderail target <worktree>`, `--follow`, and `--list [--json]` let an agent or script make the same choice for a tab's rail.

### Fixes

- Switching a rail to another repository no longer fails with "One repository subscription is allowed per connection" when the previous repository was still loading.
- A Git command that times out on a busy machine no longer makes SideRail treat a repository as plain files.

## 0.1.1 - 2026-09-23

Republishes 0.1.0 with no functional changes. 0.1.0 was withdrawn from npm
shortly after release; install 0.1.1 instead.

- The license copyright holder is now KaxyotiK.
- The source repository is now https://github.com/KaxyotiK/siderail.

## 0.1.0 - 2026-09-23

Initial release.

### Features

- A compact, read-only Files and Git sidebar for each Herdr tab and for cmux's
  right-sidebar Dock, with exact Against-base, Commit, Staged, Unstaged,
  Untracked, and clean-file semantics. Untracked is a separate section with
  Git's `?` marker.
- Descriptor-aware Diff and Raw previews of the exact selected revision, with
  bounded in-preview search. In Herdr, Markdown files open in the operating
  system's default application; in cmux, selections open as native file tabs.
- Tree and Folders layouts, keyboard navigation of every commit and file row,
  and search across changes, commit metadata, and files. Only the visible
  viewport is materialized, so very large repositories stay responsive.
- One unfocused sidebar opens automatically in each Git-backed Herdr tab, and
  `siderail.toggle-siderail` opens or closes it. Opening never reconstructs a
  user's pane layout; unsafe layouts are skipped.
- Event-driven refresh shared across Herdr tabs through one on-demand Git-state
  coordinator, with a recovery poll where native watching is unavailable.
- Colors follow the terminal's ANSI palette and Herdr's theme tokens. See
  [Colors and glyphs](docs/THEMING.md).

### Install and update

- Published as the `siderail` npm package. `siderail setup` links it as Herdr
  plugin `siderail` and adds a SideRail control to cmux's
  `~/.config/cmux/dock.json`; `siderail status` and `siderail uninstall` report
  and remove only this install's registrations.
- `npm install -g siderail@latest` updates in place: open sidebars detect the
  replaced install and restart on the new version.

### Security

- Repository contents never control SideRail configuration or select an
  executable. See the [security policy](SECURITY.md).
- SideRail never stages, commits, or otherwise changes repository content, and
  closes a pane only after verifying that it owns it.
- Git commands, preview bytes, search memory, directory scans, and background
  work are bounded; terminal control sequences are sanitized.

### Requirements

- Node.js 22 or newer and Git 2.35 or newer on macOS or Linux, with Herdr 0.8.x,
  cmux with right-sidebar Dock support, or both. Release validation covers
  Node.js 22 and 24.

### Migrating from a pre-release checkout

- The pre-release project was named GitRail. Unlink its plugin
  (`herdr plugin unlink local.git-rail`), remove its `git-rail` Dock control,
  move `~/.config/git-rail/` to `~/.config/siderail/`, rename `GIT_RAIL_*`
  variables to `SIDERAIL_*` and `branch.<name>.gitrail-base` Git config keys to
  `siderail-base`, then install the package.
