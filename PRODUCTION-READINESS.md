# Production readiness

Herdr GitRail's production-readiness work is merged into `main`. This document
records the current guarantees and the checks required before a tagged release;
it is not a future implementation plan.

## Current product behavior

- The plugin is a read-only Files and Git inspector scoped to the focused Herdr
  tab directory.
- Changes separates Against-base, commit, staged, unstaged, and untracked state.
  Each row carries an exact descriptor so the preview cannot silently switch Git
  scope.
- A clean Changes view explicitly states that the worktree is clean. Commit
  summary rows participate in the same keyboard focus and Enter activation as
  file rows.
- Changes search covers file paths plus the hashes, messages, authors, ages, and
  changed paths of the latest 200 first-parent commits. The full range count is
  retained, truncation is disclosed, and path-index failure degrades search
  without taking down repository state.
- Files contains tracked and untracked worktree paths. It compares the current
  worktree with `merge-base(base, HEAD)`, reuses that branch-diff metadata for
  changed rows, and renders unchanged paths with a neutral icon and no stats.
- Outside Git, Files remains available through a bounded directory scan with
  neutral type-specific glyphs; Changes clearly remains unavailable. Directory
  symlinks are not followed and `.git` internals are excluded.
- Folders sort before repository-root files in Tree and Folders layouts. Narrow
  rails retain filenames and compact ages before secondary metadata.
- A selected file opens in a dedicated Herdr preview tab labeled with its
  sanitized basename, capped at 32 terminal columns. Opening another file
  replaces the plugin-owned preview tab rather than covering the rail or creating
  unbounded tabs.
- Diff is a structured file view with old/new line gutters and distinct additions
  and deletions. Raw reads the selected revision. A third viewer action appears
  only when the selected filename matches an enabled viewer rule. Matching
  actions are additive and explicitly key-bound, each pattern accepts one or
  more actions, and `*` provides global actions. Installed defaults bind
  Markdown to `3`, auto-open it in Glow, and bind OS-default Open to `o` for
  every file. Viewer executables are checked before launch; a missing Glow
  installation leaves Diff and Raw usable and produces an actionable hint.
- Preview search, keyboard navigation, and scrolling repaint in place without
  clearing the terminal. Long Diff and Raw rows support horizontal arrow-key
  navigation while retaining their line-number gutter.

## Git correctness

GitRail uses machine-readable, NUL-delimited Git output for paths and status. It
retains rename/copy source paths, revision-specific modes, object IDs, binary
state, and independent descriptors for overlapping staged and unstaged changes.

| Scope | Diff meaning |
| --- | --- |
| Files, changed | merge base of configured base and `HEAD` to worktree |
| Against base | configured base merge base to `HEAD` |
| Commit | selected commit against its first parent; root commits use the empty tree |
| Staged | `HEAD` to index |
| Unstaged | index to worktree |
| Untracked | complete addition from `/dev/null` |
| Clean | no diff; Raw opens worktree content |

The demo creates a temporary real repository and runs the production provider;
it does not use fabricated hashes, paths, counts, or patches.

## Configuration and safety

Both user and repository configuration files must declare `version: 1`. The
runtime and published schema reject unknown top-level and nested keys, invalid
object shapes, unsupported launch modes, and out-of-range limits. Editor rules
accept `client`, `args`, and `mode`; viewer rules additionally accept `label`,
`key`, and `autoOpen` and resolve by exact filename, suffix, or wildcard.
Dot-prefixed patterns are suffix rules; all other non-wildcard patterns are
exact basenames.
Invalid files are reported and excluded from the merge. No editor executable is
required; editor integration activates only through configuration or `$EDITOR`.

Git processes run without a shell, with bounded output and timeouts. File reads
are size-limited, binary-aware, and constrained to the real repository path.
Dangling symlinks are rejected before editor or viewer launch. Exact-revision
external actions use bounded byte-preserving materialization while Raw remains
text-only. Terminal rendering rejects content above 100,000 lines before
splitting or diff parsing to bound rendered-memory amplification.
Untracked summary statistics additionally have aggregate file, byte, and
elapsed-time budgets; rows beyond the budget are marked unavailable without
blocking exact on-demand previews.
Debug logs omit source text, diffs, environment values, and command arguments.
Repository configuration remains trusted local configuration because it can
choose editor and viewer executables.

## Refresh and lifecycle

Herdr startup plus `workspace.created` and `tab.created` hooks ensure one
unfocused GitRail pane for each Git-backed tab. Automatic opening is enabled by
default and can be disabled globally or per repository with `herdr.autoOpen`;
non-Git tabs and GitRail's own file-preview tabs are ignored.
New rails apply `herdr.sidebarWidth` once at creation without taking focus;
subsequent manual resizing remains owned by Herdr.
Reconciliation adopts current panes, replaces legacy-branded panes, removes
duplicates, repairs middle-of-layout rails, recovers orphaned locks, and cleans
per-tab state when tabs or workspaces close.
Each running rail resolves the focused content directory from its own tab on
refresh, so repository and branch headers follow directory changes without
sharing state across tabs.
The `toggle-git-rail` plugin action opens or closes only a process-verified,
plugin-owned rail in the current tab; its shortcut is configured in Herdr.

Filesystem events and a recovery poll feed a debounced refresh. Refresh retains
the last usable state and preserves selection, expansion, layout, search, and
scroll where possible. Git inspection disables optional lock writes so the
reader does not trigger its own watcher. Rail and preview ownership is tracked by
Herdr pane identity rather than display titles.

Temporary demo repositories and editor copies are owner-only. Normal exit and
handled signals remove them; stale operating-system temporary data can be
discarded safely.

## Verification gates

Before tagging a release:

1. Run `npm ci --ignore-scripts` and `npm run check` from a clean checkout.
2. Confirm the GitHub Actions matrix passes on Ubuntu and macOS with Node.js 22.
   Third-party actions are pinned to immutable commit SHAs.
3. Exercise the demo and a live repository at narrow and standard sidebar widths.
4. Verify Changes and Files search, commit expansion, root-file ordering, refresh,
   and compact time formatting.
5. Open staged, unstaged, untracked, commit, Against-base, changed Files, and
   unchanged Files rows; verify Diff and Raw resolve the documented revisions.
6. Verify a second preview replaces the existing dedicated preview tab and that
   rapid scrolling does not flicker or reset position.
7. Test configured terminal, external, system, and disabled editor modes plus
   malformed and unsupported configuration.
8. Review `SECURITY.md`, update `CHANGELOG.md`, set matching manifest/package
   versions, and complete the tagged-install checks in `docs/RELEASING.md`.

## Support boundary

The supported targets are Node.js 22 or newer, Git 2.35 or newer, Herdr 0.8.0 or
newer, and current macOS or Linux. The latest tagged release receives security
fixes. GitRail does not stage, discard, commit, push, pull, or otherwise mutate
repository content.
