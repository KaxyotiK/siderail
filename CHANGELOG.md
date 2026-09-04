# Changelog

Herdr GitRail follows Semantic Versioning. Until 1.0, minor releases may include
intentional configuration changes documented here.

## 0.1.0 - Unreleased

### Highlights

- Adds a compact, read-only Files and Git sidebar scoped independently to each
  Herdr tab, with exact Against-base, Commit, Staged, Unstaged, Untracked, and
  clean-file preview semantics.
- Adds descriptor-aware Diff and Raw views plus bounded in-preview search.
  In Herdr, Markdown files open exact revision bytes directly in the operating
  system's default application, bypassing the generic file preview entirely.
- Separates Untracked from Unstaged with Git's `?` marker and makes all file
  rows keyboard reachable while materializing only the visible viewport.
- Auto-opens one unfocused rail per Git-backed tab. Automatic and manual opening
  skip layouts that cannot accept a safe outer-right split without reconstruction.
- Resolves the rail and preview palette from the terminal's ANSI indexed colors
  instead of pinned 24-bit values, so a light terminal theme is readable, then
  adopts Herdr's `accent`, `red`, `green`, and `selection_bg` tokens when the
  user has set them. See [Colors and glyphs](docs/THEMING.md).
- Measures East Asian Ambiguous characters according to the terminal's own
  setting. `GIT_RAIL_AMBIGUOUS_WIDTH=wide` keeps tree guides, rules, and
  accented filenames aligned on terminals that render them double width.
- Draws the branch mark as `↱` and the copied mark as `◫`. The previous `⑂` and
  `⧉` are absent from Menlo, so they rendered as empty boxes in Terminal.app.

### Security

- Repository contents never control GitRail configuration or select editor or
  viewer executables. Branch-specific comparison refs may come from uncommitted
  local or worktree Git config; all executable settings remain limited to
  built-in defaults, the user configuration file, and explicit process
  environment overrides.
- Verifies workspace, label, and process identity before closing a cached rail
  or preview pane. GitRail never stages or reconstructs a user's pane layout.
- Bounds Git commands, preview bytes, output, search memory, directory scans,
  and auto-open work; sanitizes terminal control sequences and avoids shells for
  repository-derived arguments.

### Fixed

- Derives repository labels from the shared Git directory so linked worktrees
  show the repository name separately from the checked-out branch.
- Prefers the local default branch over its remote-tracking ref so commits
  already on local `main` never reappear as Against-base files or branch commits
  merely because `origin/main` is stale.
- Starts folders collapsed in both Tree and Folders layouts while automatically
  expanding matching search paths so nested files remain keyboard-accessible.
- Distinguishes provider failures from an ordinary non-Git directory and keeps
  the last usable state after transient refresh failures.
- Resolves per-worktree and shared Git directories for filesystem invalidation,
  retaining a jittered recovery poll when recursive watching is unavailable.
- Keeps automatic filesystem and recovery-poll refreshes visually silent while
  retaining toolbar progress and confirmation for user-requested refreshes.
- Restores terminal modes and removes temporary demo data after fatal errors.
- Preserves source-tab-scoped preview replacement and prevents stale pane ids
  from authorizing destructive closes.
- Uses one global 35-second, four-worker auto-open sweep with process-group
  cancellation and partial-result diagnostics.
- Caches Markdown-preview search positions with prefix candidates, eliminating
  the repeated full-result grapheme pass on every rendered search frame.
- Binds documentation PNG bytes to their capture commit and keeps screenshot
  regeneration explicit through a maintainer-only Pillow renderer.

### Configuration

- Adds `branch.<checked-out-branch>.gitrail-base` in local or worktree Git config
  for uncommitted per-branch comparison bases, below explicit environment/user
  bases and above automatic local/remote default-branch resolution.
- Removes pre-release repository-level `.git-rail.json` configuration. Move any
  desired settings to `~/.config/git-rail/config.json`.
- Removes the unused JSON Schema/editor-integration artifact. Existing
  development configuration must remove `$schema`; runtime validation is the
  sole configuration authority.
- Viewer keys accept exactly `*`, a dot-prefixed suffix, or an exact basename.
  Glob-shaped and path-containing keys are rejected explicitly. Use
  `{ "client": "none" }` on a viewer key to disable an inherited action.

### Installation and upgrade

- Validates Node.js 22/24, Git 2.35+, and Herdr 0.8.x on macOS and Linux through
  reproducible local release checks. The project does not use GitHub Actions.
- Keeps owner-only exact-revision copies available to detached external viewers
  for 15 minutes before automatic cleanup.
- Routes all manifest entrypoints through a launcher that resolves an absolute
  Node executable and rejects unsupported versions before layout or terminal
  mutation.
- This is the first release, so no public upgrade or migration path exists.
  Pre-release checkouts should be unlinked and installed again from the release
  candidate.
