# Superset Git rail source review

This note records the behavior reproduced by the terminal-native Git rail
mockup. The reference is Superset's legacy right sidebar—the implementation shown
in the supplied screenshot—not its newer V2 sidebar.

## Information architecture

Superset uses two navigation levels:

1. The outer right sidebar switches between **Changes** and **Files**.
2. Inside Changes, a second tab row switches between **Diffs** and **Review**.

Diffs is then a vertically scrolling stack of four collapsible, reorderable
sections in this default order:

1. Against `<base branch>`
2. Commits
3. Staged
4. Unstaged (tracked unstaged files plus untracked files)

The commit composer and Git toolbar remain fixed above those sections. Diffs and
Review display counts in their tab labels. Review also carries the aggregate CI
check state when a pull request exists.

Primary source locations:

- `RightSidebar/index.tsx` — outer Changes / Files navigation, expand/collapse,
  file-opening behavior.
- `ChangesView/ChangesView.tsx` — Diffs / Review tabs, polling, filesystem-event
  invalidation, selection, lazy commit details, and section composition.
- `ChangesView/hooks/useOrderedSections/useOrderedSections.tsx` — section order,
  counts, stage/unstage/discard actions.
- `renderer/stores/changes/store.ts` — persisted active tab, tree/grouped mode,
  expanded sections, order, and per-workspace selection.

## Git data pipeline

The renderer polls the status query every 2.5 seconds while the Changes view is
active. Repositories with 200 or more reported paths slow to a ten-second poll.
Filesystem events also invalidate the status query after a short 75 ms debounce;
branch queries are invalidated only on watcher overflow, and the selected file's
content/diff queries are invalidated only when that file is affected.

The server validates that the requested path is a registered worktree, rejects
missing/non-Git worktrees with typed causes, coalesces identical in-flight status
requests, and maintains a short status cache. Git work is moved to a worker with
an explicit timeout.

The worker builds one `GitChangesStatus` value from:

- `git status` for staged, unstaged, and untracked classification;
- `git rev-list --left-right --count origin/<base>...HEAD` for base divergence;
- `git log origin/<base>..HEAD --max-count=500` for commit summaries;
- `git diff --name-status origin/<base>...HEAD` for the Against-base file set;
- `git diff --numstat ...` for per-file additions, deletions, and binary flags;
- `git rev-list --left-right --count @{upstream}...HEAD` for push/pull counts.

Untracked-file additions are counted from disk with binary sniffing and a 1 MiB
budget. The real commit count is retained even when the rendered commit summaries
are capped.

Commit rows initially contain summary data only. Expanding a commit triggers a
separate, coalesced `getCommitFiles` query using `git diff-tree`; only expanded
commits pay that cost.

The terminal adaptation keeps that lazy behavior: the Commits section expands to
summary rows, and each summary independently expands to its changed-file tree or
folder groups. Nested files remain clickable and preview that commit's patch.

## Tree production

Tree mode splits each repository-relative path on `/`, creates intermediate
folder nodes, converts the nested maps to arrays, then sorts folders before files
and alphabetically within each kind. Folders default open. Folder actions operate
on the recursively collected descendant files.

Grouped mode instead groups files by their immediate parent path, sorts groups by
full path, and sorts file basenames inside each group. The UI switches to a
virtualized implementation at 200 files. Virtualized trees flatten only the
currently expanded nodes and overscan eight rows; commit lists overscan ten.

File rows show a status-specific icon, filename, `+N/-N` numstat, nested guide
lines, selection state, and hover actions. Click opens the in-app diff/file pane;
double-click or modified click opens the external editor. Context menus expose
copy path, reveal, editor, stage/unstage, and guarded discard/delete operations.

Superset's tree indent is 10 px per level, while filename text is a truncating
flex child and numstat is non-shrinking. The terminal adaptation therefore uses
one guide cell per depth on narrow rails (two on wider rails), trusts the real
terminal column count, and truncates the basename before allowing stats to wrap.
At 88 terminal columns or less it promotes Superset's existing grouped mode automatically:
one compact parent-path row establishes location, shallow Herdr-style connectors
bind the files below it, and numstat remains right-pinned. This avoids spending a
row and an indentation level on every directory segment. Wider panes retain the
full tree, and the user can pin either layout with `g`.

## Adaptation for Herdr

The terminal rail preserves Superset's hierarchy and section model, but reduces
the context header to the one repository and branch the rail represents:

```text
 repository-name
  ⑂ feature/sidebar
```

There is deliberately no multi-worktree or workspace hierarchy here. The focused
Herdr pane supplies one Git worktree; the rail derives its repository and current
branch directly from Git. The mockup is intentionally read-only and omits
Superset's composer to preserve vertical space in Herdr's smaller rail. Remaining
mutation affordances test density and hierarchy but do not run stage, discard,
push, pull, or PR mutations.

The rail uses terminal-native interaction rather than HTML: alternate-screen
rendering, ANSI color, raw keyboard input, SGR mouse hit regions, responsive
width, and a snapshot mode for deterministic review. Tabs, collapsible section
headers, commit summaries, review comments, and file rows are mouse targets; the
same operations remain available from the keyboard.

The compact Herdr adaptation exposes Superset's Diffs content directly as the
Changes view and omits the Diffs/Review subtab row. This keeps the primary header
identical between Changes and Files and recovers a row in the narrow rail.

File rows use the familiar desktop distinction between selection and opening: a
single click selects and updates rail context, while a double click opens a
focused, read-only Herdr overlay. Files-tab rows show file content; changed-file
rows show the Git diff. Only the plugin-owned preview overlay is replaced when a
new preview opens.

That overlay is intentionally a preview rather than an embedded editor. It has
clickable Diff, Raw, and Markdown modes. Markdown delegates the whole viewing
session to Glow's rendered TUI—there is no plugin-owned Markdown parser or
formatter—and returns to the preview shell when Glow exits. Editing remains an
explicit `e` action. Terminal clients temporarily take over the same Herdr pane;
external clients and the OS-default opener launch outside Herdr. This preserves
fast browsing while still providing an escape hatch for real editing.

Superset's outer Files view is separate from its changed-file tree. It uses an
async directory loader and fetches children only when a folder opens, caches
entries by absolute path, and invalidates only affected parent directories after
filesystem events. Rename events retarget expanded descendants before restoring
their open state. Its file search is likewise a separate flat result view rather
than a filtered tree: a trimmed non-empty query starts the search, previous data
remains visible while results load, and each result displays its filename plus a
tail-truncated parent path.

The mockup mirrors that interaction locally: click the search row or press
`/`, type a case-insensitive path fragment, and select a clickable flat result.
The mockup searches the current tracked and untracked Git snapshot. A production
pass should replace that bounded snapshot with Superset's lazy directory loader
and cancellable asynchronous search backend.

For the terminal adaptation, Changes also receives a search row even though the legacy
Superset reference does not expose the same control there. It is an in-place
filter, not a separate result model: Against-base, Staged, and Unstaged retain
their independent section ownership and tree/grouped rendering. Matching sections
are temporarily shown open without changing persisted expansion state. The same
path may correctly remain in multiple sections because each opens a different
diff surface. Commit files are not searched because Superset loads those lazily
only after their commit expands.
