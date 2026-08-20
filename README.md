# Herdr GitRail

Herdr GitRail is a compact, read-only Git sidebar for one worktree and its
current branch. Every row retains its exact Git scope, so Against-base, Commit,
Staged, Unstaged, Untracked, and clean-file previews cannot be confused.

## Requirements

- Node.js 22 or newer
- Git 2.35 or newer
- Herdr 0.8.0 or newer
- macOS or Linux

Glow is optional and is used only when a Markdown viewer is explicitly opened.
Vim is the default editor fallback; both are configurable.

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
- `/` searches the active view; `Ctrl-U` clears; Enter finishes.
- `g` toggles Tree and Folders layouts.
- `j`/`k` or arrows select files; Enter opens the selection. `J`/`K` and the
  mouse wheel scroll, while `h`/`l` chooses a section and Space toggles it.
- `r` refreshes without resetting selection, expansion, layout, search, or
  scroll position.
- A click selects. A double-click opens GitRail Preview in a dedicated Herdr tab.
- `q` or Escape closes the rail.

Against-base and Commits begin collapsed; Staged and Unstaged begin expanded.
Large sections expose explicit **Show more** rows, so displayed totals never
refer to unreachable content.

GitRail Preview replaces the previous preview tab, then starts in the selected
descriptor's exact diff, or Raw for a clean file. Use `1`, `2`, and `3` for
Diff, Raw, and Markdown; `/` searches the current content and `n`/`N` moves
through matches. `e` opens the configured editor. Binary and oversized content
produce bounded, actionable errors.

## Git semantics

| Selected row | Preview command |
| --- | --- |
| Files tab | `git diff <merge-base(base, HEAD)> -- <path>` |
| Against base | `git diff <base>...HEAD -- <path>` |
| Commit | `git show --format= <commit> -- <path>` |
| Staged | `git diff --cached -- <path>` |
| Unstaged | `git diff -- <path>` |
| Untracked | complete addition from `/dev/null` |
| Clean | Raw by default; Diff reports no change |

GitRail uses NUL-delimited porcelain-v2, name-status, numstat, and ls-files
formats. Renames and copies retain old/new path pairs, and the Files model keeps
all applicable states rather than selecting one ambiguous status.

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

Supported overrides include `GIT_RAIL_BASE`, `GIT_RAIL_CLIENT`,
`GIT_RAIL_CLIENT_ARGS` (a JSON string array), `GIT_RAIL_CLIENT_MODE`, and
`GIT_RAIL_POLL_INTERVAL_MS`. Set `GIT_RAIL_DEBUG_LOG` to an explicit file path
for sanitized operation names, timestamps, durations, and exit status; source,
diffs, environment values, and command arguments are never logged.

Explicit `terminal` and `external` modes override executable heuristics. `system`
uses macOS `open` or Linux `xdg-open`; `none` disables editing. External apps,
including VS Code and Cursor, open outside Herdr.

## Development

```bash
npm test
npm run lint
npm run snapshot
npm run check
```

The test suite builds disposable repositories and independently verifies each
descriptor. CI runs the full check on macOS and Linux.

See [docs/INSTALLATION.md](docs/INSTALLATION.md),
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md), [SECURITY.md](SECURITY.md),
and [CONTRIBUTING.md](CONTRIBUTING.md) for release and support details.
