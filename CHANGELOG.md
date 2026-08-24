# Changelog

Herdr GitRail follows Semantic Versioning. Until 1.0, minor releases may include
intentional configuration changes documented here.

## 0.1.0 - Unreleased

### Highlights

- Adds a compact, read-only Files and Git sidebar scoped independently to each
  Herdr tab, with exact Against-base, Commit, Staged, Unstaged, Untracked, and
  clean-file preview semantics.
- Adds descriptor-aware Diff and Raw views plus bounded in-preview search.
  Markdown files expose action `3 Rendered`, which renders exact revision bytes
  through Glow inside the preview viewport.
- Separates Untracked from Unstaged with Git's `?` marker and makes all file
  rows keyboard reachable while materializing only the visible viewport.
- Auto-opens one unfocused rail per Git-backed tab, skips unsafe automatic
  layout changes, and keeps manual open/toggle actions available.

### Security

- Repository contents never control GitRail configuration or select editor or
  viewer executables. Configuration is limited to built-in defaults, the user
  configuration file, and explicit process environment overrides.
- Verifies workspace, label, and process identity before closing a cached rail
  or preview pane. Explicit layout rebuilds use a durable recovery journal.
- Bounds Git commands, preview bytes, output, search memory, directory scans,
  and auto-open work; sanitizes terminal control sequences and avoids shells for
  repository-derived arguments.

### Fixed

- Distinguishes provider failures from an ordinary non-Git directory and keeps
  the last usable state after transient refresh failures.
- Resolves per-worktree and shared Git directories for filesystem invalidation,
  retaining a jittered recovery poll when recursive watching is unavailable.
- Restores terminal modes and removes temporary demo data after fatal errors.
- Preserves source-tab-scoped preview replacement and prevents stale pane ids
  from authorizing destructive closes.
- Uses one global 35-second, four-worker auto-open sweep with process-group
  cancellation and partial-result diagnostics.

### Configuration

- Removes pre-release repository-level `.git-rail.json` configuration. Move any
  desired settings to `~/.config/git-rail/config.json`.
- Removes the unused JSON Schema/editor-integration artifact. Existing
  development configuration must remove `$schema`; runtime validation is the
  sole configuration authority.
- Viewer keys accept exactly `*`, a dot-prefixed suffix, or an exact basename.
  Glob-shaped and path-containing keys are rejected explicitly. Use
  `{ "client": "none" }` on a viewer key to disable an inherited action.

### Installation and upgrade

- Validates Node.js 22/24, Git 2.35+, and Herdr 0.8.x on macOS 15 and Ubuntu
  24.04. Newer Node and Herdr versions are accepted by the launcher but are not
  part of the 0.1.0 release matrix.
- Routes all manifest entrypoints through a launcher that resolves an absolute
  Node executable and rejects unsupported versions before layout or terminal
  mutation.
- This is the first release, so no public upgrade path exists. Developers
  migrating from commit `6c7d9ac` should follow the development migration in
  `docs/RELEASING.md`.
