# Herdr GitRail

Herdr GitRail is a compact, read-only Git sidebar for one worktree and its
current branch. Every row retains its exact Git scope, so Against-base, Commit,
Staged, Unstaged, Untracked, and clean-file previews cannot be confused.

## Requirements

- Node.js 22 or newer
- Git 2.35 or newer
- Herdr 0.8.0 or newer
- macOS or Linux

No editor is required. GitRail uses `$EDITOR` when it is set, or an explicit
editor configuration when provided. The installed defaults auto-open `.md`,
`.mdx`, and `.markdown` files in Glow, so install `glow` for that integration or
override the Markdown rules. If Glow is unavailable, GitRail skips auto-open,
shows an installation hint, and leaves Diff and Raw fully usable.

## Install and launch

```bash
herdr plugin link .
herdr plugin action invoke local.git-rail.open-git-rail
```

Open the deterministic demo, which assembles a temporary real Git repository
and runs the production provider against it:

```bash
herdr plugin action invoke local.git-rail.open-git-rail-mockup
```

The demo contains committed, Against-base, partially staged, unstaged,
untracked text, and untracked binary states. It has no hard-coded hashes,
counts, patches, or pseudo-paths. Temporary repositories and editor copies are
owner-only and removed when the process exits normally or receives a handled
signal.

## Interaction

- `Tab` switches Changes and Files.
- `/` searches the active view; Changes search includes commit metadata and the
  paths changed by each loaded commit. GitRail loads the latest 200 first-parent
  commits and still shows the complete range count. `Ctrl-U` clears; Enter
  finishes.
- `g` toggles Tree and Folders layouts.
- `j`/`k` or arrows focus commit and file rows. Enter expands a focused commit
  or opens a focused file. `J`/`K` and the mouse wheel scroll, while `h`/`l`
  chooses a section and Space toggles it.
- `r` refreshes without resetting selection, expansion, layout, search, or
  scroll position.
- A click selects. A double-click opens a dedicated Herdr preview tab.
- Folder expanders and **Show more** rows are currently mouse controls; commit
  expansion and file opening remain fully keyboard-accessible.
- `q` or Escape closes the rail.

Against-base and Commits begin collapsed; Staged and Unstaged begin expanded.
Large sections expose explicit **Show more** rows, so displayed totals never
refer to unreachable content.

Files contains every tracked and untracked worktree path. Files changed since
the merge base use the same status and statistics as Against-base; unchanged
files use a neutral grey icon and have no diff statistics.

The preview tab uses the selected basename as its label, sanitized and capped at
32 terminal columns. It replaces the previous plugin-owned preview tab, then
starts in the selected descriptor's exact diff, or Raw for a clean file. Use
`1` and `2` to select Diff and Raw. Configured filename and extension matches
add actions with explicit key bindings. Installed defaults provide `o Open` for
every file and `3 View Markdown` through Glow for `.md`, `.mdx`, and `.markdown`
files; Markdown launches Glow automatically. `/` searches the current content
and `n`/`N` moves through matches. `e` opens the configured editor; historical,
Against-base, staged, and deleted selections use an owner-only temporary copy of
the exact Raw revision. Binary and oversized content produce bounded,
actionable errors. A `?` statistic means the aggregate untracked-inspection
budget was reached; opening that file still computes its bounded preview.

## Git semantics

| Selected row | Preview command |
| --- | --- |
| Files tab, changed | `git diff <merge-base(base, HEAD)> -- <path>` |
| Files tab, unchanged | Raw by default; Diff reports no change |
| Against base | `git diff <base>...HEAD -- <path>` |
| Commit | first-parent diff (`<parent>..<commit>`); root commits use the empty tree |
| Staged | `git diff --cached -- <path>` |
| Unstaged | `git diff -- <path>` |
| Untracked | complete addition from `/dev/null` |
| Clean | Raw by default; Diff reports no change |

GitRail uses NUL-delimited porcelain-v2, name-status, numstat, raw-diff, and
ls-files formats. Renames and copies retain old/new path pairs, while symlinks,
submodules, and type changes retain revision-specific mode metadata. The Files
model keeps all applicable states rather than selecting one ambiguous status.

## Configuration

Configuration merges by key in this order, with later entries taking
precedence:

1. built-in defaults;
2. `~/.config/git-rail/config.json`;
3. `<repository>/.git-rail.json`;
4. `$EDITOR` when no editor is configured;
5. `GIT_RAIL_*` environment overrides.

Use [git-rail.config.example.json](git-rail.config.example.json) as a starting
point. Configuration version 1 is validated; malformed JSON and invalid values
are shown in the rail instead of being ignored. Repository configuration is
trusted local configuration because it may choose executables.

`version` identifies the configuration format, not the GitRail release. It lets
GitRail reject a future incompatible format instead of interpreting changed
fields as commands. Backward-compatible additions remain on version 1. Viewer
`order` is still accepted for legacy automatic bindings, while new configuration
should use explicit `key` values.

GitRail opens automatically, without taking focus, in every Git-backed Herdr
tab when Herdr starts or a workspace or tab is created. Disable that globally in
`~/.config/git-rail/config.json`, or for one repository in `.git-rail.json`:

```json
{
  "version": 1,
  "herdr": { "autoOpen": false }
}
```

Non-Git tabs and GitRail's own file-preview tabs are ignored. Manual **Open
GitRail** actions remain available when automatic opening is disabled.
Once open, each rail follows the focused content pane in its own tab. Changing
that pane's directory updates the repository name and branch on refresh or the
recovery poll, including transitions into and out of Git worktrees.

New rails open at the configured terminal-column width. The installed default
matches the 34-column development rail; narrower layouts cap the rail at half
the available split, and Herdr's minimum split ratio still applies on unusually
wide layouts. Manual resizing after launch remains under Herdr's control:

```json
{
  "version": 1,
  "herdr": { "autoOpen": true, "sidebarWidth": 34 }
}
```

Editor integration is optional. Configure a terminal editor such as Neovim:

```json
{
  "version": 1,
  "editor": { "client": "nvim", "args": [], "mode": "terminal" }
}
```

Or configure an external application such as VS Code:

```json
{
  "version": 1,
  "editor": { "client": "code", "args": ["--reuse-window"], "mode": "external" }
}
```

Without `editor`, `GIT_RAIL_CLIENT`, or `$EDITOR`, editing is disabled and the
preview omits the `e` action.

Viewer actions are conditional per selected filename. Rules match an exact
basename, a dot-prefixed filename suffix such as `.pdf`, or `*`. Exact names do
not act as implicit suffixes: `Makefile` will not match `NotMakefile`. Every matching rule is shown,
so `*` can provide a global action alongside a file-specific action. Each
pattern accepts one rule or an array of rules, so multiple global or
file-specific actions can coexist. Each rule can configure its action `label`, executable `client`, `args`, launch
`mode`, single-letter-or-digit `key`, and optional `autoOpen`. File-specific
rules win if two matching actions claim the same key. Preview navigation keys
are reserved and rejected by validation. Version-1 rules without `key` retain
legacy automatic numeric assignment. If no enabled rule matches, the preview omits
viewer actions. The built-in Markdown defaults use Glow:

```json
{
  "version": 1,
  "viewers": {
    ".md": {
      "label": "View Markdown",
      "client": "glow",
      "args": ["--tui", "--style", "dark"],
      "mode": "terminal",
      "key": "3",
      "autoOpen": true
    }
  }
}
```

For example, two global actions can share the wildcard pattern:

```json
{
  "version": 1,
  "viewers": {
    "*": [
      { "label": "Open", "client": "system", "mode": "external", "key": "o" },
      { "label": "Open in Code", "client": "code", "mode": "external", "key": "9" }
    ]
  }
}
```

Supported overrides include `GIT_RAIL_BASE`, `GIT_RAIL_CLIENT`,
`GIT_RAIL_CLIENT_ARGS` (a JSON string array), `GIT_RAIL_CLIENT_MODE`, and
`GIT_RAIL_POLL_INTERVAL_MS`. Set `GIT_RAIL_DEBUG_LOG` to an explicit file path
for sanitized operation names, timestamps, durations, and exit status; source,
diffs, environment values, and command arguments are never logged.

Explicit `terminal` and `external` modes override executable heuristics. `system`
uses macOS `open` or Linux `xdg-open`; `none` disables editing. External apps,
including VS Code and Cursor, open outside Herdr.

Viewer and editor actions materialize the exact selected commit, Against-base,
or staged revision with a bounded byte-preserving copy. This allows OS-default
Open and external applications to handle images, PDFs, and other binary files;
the terminal Raw view remains deliberately text-only and UTF-8 validated.

## Development

```bash
npm test
npm run lint
npm run snapshot
npm run check
```

The test suite builds disposable repositories and independently verifies each
descriptor. CI runs the full check on macOS and Linux.

## Documentation

- [Installation and upgrades](docs/INSTALLATION.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Production readiness](PRODUCTION-READINESS.md)
- [Releasing](docs/RELEASING.md)
- [Screenshot verification](docs/screenshots/README.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
