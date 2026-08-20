# Herdr GitRail production-readiness plan

## Implementation status — 2026-08-20

Implemented on the `production-ready` branch. The runtime now has separate
process, configuration, parser, model, Git provider, fixture, and preview
provider layers. The deterministic demo is assembled as an owner-only temporary
Git repository and read through the production provider; it contains no
fabricated patches, paths, counts, hashes, or file contents.

Automated verification currently covers 16 cases, including every diff
descriptor, partial staging, binary and untracked files, malformed and merged
configuration, NUL-safe unusual filenames, rename/copy/delete status,
executable and symlink modes, conflicts, submodules, unborn and detached
repositories, bounded reads, three TUI widths, and explicit continuation for a
250-file repository. `npm run check` passes locally on macOS; CI is configured
to run the same check on macOS and Linux.

Herdr end-to-end verification confirmed the rebranded GitRail Demo pane, exact
Staged preview output, preview singleton replacement by stored pane ID, keyboard
selection/open, Vim and Nano terminal handoff and restoration, temporary demo
editor copies, and Glow handoff and restoration. Neovim, Helix, and Cursor were
not installed on the verification host; their explicit terminal/external modes
use the same validated launcher paths.

## Product boundary

Herdr GitRail is a compact Herdr sidebar for one Git worktree and its current branch.
It is not a multi-repository navigator, workspace manager, full editor, or Git
mutation client. The initial production scope remains read-only:

- show repository and branch identity;
- browse Against-base, Commits, Staged, and Unstaged changes;
- browse and search repository files;
- preview an exact file diff, raw file, or rendered Markdown;
- open a file with a configured terminal editor or external application.

The existing prototype demonstrates the intended information architecture and
interaction density. It is not yet reliable enough to display arbitrary Git
repositories without potentially showing incomplete or misleading state.

## Release blockers

### 1. Preserve the meaning of every diff row

The rail currently sends a path and a generic `diff` surface to the preview. It
does not identify the section from which the file was opened. Consequently,
Against-base, Staged, and Unstaged files all become `git diff HEAD -- <path>` in
the live preview.

Introduce a structured diff descriptor and carry it from the row model through
the Herdr pane boundary:

```ts
type DiffDescriptor =
  | { kind: "head" }
  | { kind: "against"; baseRef: string }
  | { kind: "commit"; commitHash: string }
  | { kind: "staged" }
  | { kind: "unstaged" }
  | { kind: "untracked" }
  | { kind: "clean" };
```

The preview must execute the command appropriate to that descriptor:

| Descriptor | Required behavior |
| --- | --- |
| HEAD | `git diff HEAD -- <path>` for the aggregate Files view |
| Against | `git diff <base>...HEAD -- <path>` |
| Commit | `git show --format= <commit> -- <path>` |
| Staged | `git diff --cached -- <path>` |
| Unstaged | `git diff -- <path>` |
| Untracked | render the complete file as an addition from `/dev/null` |
| Clean | raw preview by default; Diff reports that no change exists |

If one path appears in multiple sections, each row must retain its independent
descriptor. Opening it from Staged and Unstaged may correctly produce different
patches.

### 2. Stop rewriting file status in the Files view

`fileEntries()` currently initializes every tracked path as clean and
`status: "modified"`, then merges only Staged and Unstaged changes. It ignores
Against-base status. This caused an added Markdown file to open as a modified
JavaScript placeholder patch.

Build one canonical path index that preserves all applicable Git states rather
than reducing a file to one ambiguous `status` value. The Files view can choose
one display glyph, but the underlying model must retain Against, Staged,
Unstaged, Untracked, rename, copy, deletion, binary, and clean metadata.

### 3. Eliminate fabricated preview content

The demo currently contains a generic JavaScript patch used for every modified
file, regardless of its extension or contents. A `.md`, `.json`, `.toml`, or test
file can therefore display an unrelated JavaScript diff under the correct path.
This fallback must be removed.

Demo mode should use the same provider interface as live mode. Choose one of:

1. a small fixture Git repository with real commits and working-tree changes;
2. checked-in per-file before/after fixtures with generated patches; or
3. a temporary Git repository assembled from deterministic fixtures at launch.

The third option gives the strongest end-to-end demo because the production Git
commands can run unchanged. No preview should invent content that is not tied to
the selected fixture file.

### 4. Make the demo internally consistent

The demo repository, branch, base, paths, hashes, statuses, numstat totals, and
commit contents are all embedded manually in `getDemoState()`. They have already
drifted: `git-rail.mjs` is described as `+486` while the source is now more than
1,100 lines.

Derive demo state by running the normal Git provider against the fixture
repository. Remove:

- the `/demo/git-rail` pseudo-root;
- hard-coded hashes, authors, ages, counts, and paths;
- the `prototypes/herdr-git-rail/` source-path mapper;
- the generic Markdown and JavaScript source generators;
- the unconditional demo file mode `100644`.

### 5. Replace fragile Git output parsing

The current porcelain-v1 parser indexes fixed character positions and assumes
simple text paths. Numstat rename handling uses a string replacement. This is not
safe for quoted paths, spaces, tabs, Unicode, rename brace notation, or unusual
filenames.

Use NUL-delimited machine formats wherever Git provides them:

- `git status --porcelain=v2 -z`;
- `git diff --name-status -z`;
- `git diff --numstat -z`;
- `git ls-files -z`.

Parse renames and copies as first-class old/new path pairs. Never reconstruct a
path by splitting human-oriented Git output.

### 6. Remove silent rendering caps

The prototype silently limits:

- normal section trees and groups to 18 rendered rows;
- commit files to 40 rendered rows;
- visible commit summaries to 7 despite loading up to 40;
- Files and search results to 200 rows.

These caps can hide changes without telling the user. Replace them with viewport
virtualization or explicit pagination. Until virtualization exists, show a
clickable `Show N more` row and retain the true total. No section count may claim
more items than the user can reach.

### 7. Make refresh non-disruptive

Live state refreshes every 2.5 seconds and resets `scrollOffset` to zero. This can
move the interface while a user is reading or clicking.

Refresh must preserve:

- active tab and search query;
- selected path and selected section;
- scroll anchor;
- expanded sections, commits, and directories;
- chosen Tree/Folders layout.

Prefer filesystem-driven invalidation with a debounced refresh. Keep a slower
poll as recovery for missed events, and make its interval configurable. Coalesce
concurrent refreshes and discard stale results.

## Runtime architecture

### Separate providers from rendering

Split the current scripts into explicit layers:

```text
Herdr context
    ↓
Repository resolver
    ↓
Git state provider ── fixture provider
    ↓                    ↓
Canonical rail model / diff descriptors
    ↓
TUI renderer and interaction state
    ↓
Preview provider → raw / diff / configured viewer / editor
```

The renderer should never assemble Git commands or infer diff meaning from a
status glyph. Live and demo providers must produce the same canonical model.

### Avoid blocking the UI

All Git, Herdr, editor-launch, and viewer-launch operations currently use
`spawnSync`. A slow Git operation can freeze keyboard and mouse handling.

- use asynchronous child processes for background Git and Herdr work;
- retain explicit timeouts and terminate timed-out children;
- cancel superseded searches and refreshes;
- expose loading and error states without clearing previous usable data;
- keep synchronous terminal handoff only where an interactive terminal editor or
  viewer intentionally owns the pane.

### Use stable pane ownership

Preview and singleton rail cleanup currently identify panes by exact display
labels such as `GitRail Preview`. Renaming a title can leave duplicate or stale
panes.

Use Herdr plugin/entrypoint metadata when available. If Herdr does not expose it,
attach a stable plugin-owned metadata key rather than coupling lifecycle behavior
to user-facing labels.

### Define refresh and selection identity

Paths alone are insufficient because one file can have multiple diff meanings.
Selection identity should include repository, path, and diff descriptor. Commit
file details should remain lazy and cached by full commit hash.

## Git correctness matrix

Production tests and implementation must cover:

- unborn repositories with no commits;
- detached HEAD;
- no remote and no upstream;
- remote default branches not named `origin/main`;
- configurable comparison refs through `GIT_RAIL_BASE`;
- staged-only, unstaged-only, and partially staged files;
- untracked text and binary files;
- added, modified, deleted, renamed, and copied files;
- executable-bit and symlink changes;
- submodules;
- merge conflicts and all unmerged status combinations;
- filenames containing spaces, tabs, quotes, Unicode, and leading dashes;
- repositories with thousands of files and hundreds of changes;
- large and binary files without reading unbounded content into memory.

Base resolution may retain the documented fallback order—explicit override,
remote HEAD, then common main/master refs—but the exact resolved ref must be
stored and passed to previews. The display label must not strip only `origin/`
while leaving other remote names inconsistent.

## Preview behavior

### Diff

- Display the exact selected descriptor, not a combined or inferred patch.
- Preserve Git color while safely truncating or horizontally scrolling long
  lines; never strip ANSI state midway through a line.
- Handle empty diffs as a valid state, distinct from Git command failure.
- Show rename source/destination and binary-mode changes.
- Support incremental loading or bounded buffering for very large patches.
- Search within the displayed diff, including next/previous match navigation.

### Raw

- Read the worktree file for present files.
- For deleted files, read the correct blob from the descriptor's base or commit.
- For renamed files, resolve the appropriate old/new side.
- Detect binary data before conversion to UTF-8.
- Clearly identify which revision is being shown.

### Markdown

- Continue delegating rendering to a configurable viewer such as Glow rather
  than maintaining a custom Markdown renderer.
- Do not auto-launch a viewer unless the configuration explicitly requests it;
  defaults should be documented and easy to disable.
- Keep Diff and Raw available for Markdown files even when the viewer is missing.

### Editor and external open

- Preserve the corrected terminal handoff: pause the preview's stdin reader,
  leave its alternate screen, run the terminal client, then restore the preview.
- Check both spawn errors and non-zero exit status.
- Confirm behavior for Vim, Neovim, Helix, Nano, and one configurable custom TUI.
- Confirm external behavior for `system`, VS Code, and Cursor without claiming
  they can embed in Herdr.
- In demo mode, label temporary copies explicitly and never imply that saving
  them changes the fixture or repository.

## Configuration

Keep the existing precedence but formalize and validate it:

1. environment overrides;
2. repository `.git-rail.json`;
3. user `~/.config/git-rail/config.json`;
4. `$EDITOR`;
5. documented fallback editor.

Add a versioned schema and report malformed configuration instead of silently
ignoring it. Decide whether repository and user configuration merge by key or
replace one another, then test and document that behavior.

Recommended configuration surface:

```json
{
  "$schema": "https://example.invalid/git-rail.schema.json",
  "baseRef": "origin/main",
  "editor": {
    "client": "nvim",
    "args": [],
    "mode": "terminal"
  },
  "viewers": {
    ".md": {
      "client": "glow",
      "args": ["--tui", "--style", "dark"],
      "mode": "terminal",
      "autoOpen": false
    }
  },
  "refresh": {
    "pollIntervalMs": 10000
  }
}
```

The schema URL above is illustrative; publish a real versioned location before
release.

The hard-coded terminal-client allowlist is acceptable only as an `auto` mode
heuristic. Explicit `terminal` or `external` configuration must always override
it. Vim and Glow may remain documented defaults because both are already
configurable.

## Safety and privacy

- Continue passing command arguments without a shell and include `--` before
  paths in every Git command.
- Resolve `realpath` for the repository and selected file. The current lexical
  prefix check does not prevent a repository symlink from resolving outside the
  worktree.
- Treat repository configuration as trusted local configuration because it can
  select executables. Document that trust boundary.
- Create demo/editor temporary files with owner-only permissions and remove them
  on normal exit and handled signals.
- Do not log source contents, diffs, environment secrets, or configured command
  arguments by default.
- Bound file reads, Git output, and rendered buffers to prevent accidental memory
  exhaustion.
- Keep all mutation operations out of the first production release. If staging,
  discard, deletion, push, or pull is added later, it requires a separate safety
  design and confirmation model.

## Error handling and observability

Every external operation should distinguish:

- executable missing;
- non-zero exit;
- timeout;
- invalid repository or ref;
- file absent because it was deleted or renamed;
- binary or oversized content;
- unavailable Herdr workspace/pane;
- malformed configuration.

Add an opt-in debug log containing timestamps, operation names, duration, exit
status, and sanitized errors. The TUI should retain a concise user-facing error
and a retry action without replacing the whole rail when stale data remains safe
to show.

Remove or implement currently unused state, including upstream tracking counts,
review counts, commit authors, binary flags, and old rename paths. Dead fields
make the prototype appear more complete than its behavior.

## Interaction and visual acceptance

- Repository and branch remain two clear header rows.
- Changes and Files use the same header, search, toolbar, and layout preference.
- Against-base and Commits start collapsed; Staged and Unstaged start expanded.
- Repository-root files render directly without a synthetic `Root` directory.
- Folder and section carets align and are independently clickable.
- `Folders` and `Refresh` retain separate hit regions.
- Refresh never toggles layout or replaces the stable footer instructions.
- A single click selects; a double-click opens the correct preview.
- Mouse and keyboard operations expose the same reachable functionality.
- Search fields show an actual input caret, result count, clear behavior, and a
  useful empty state.
- Narrow widths preserve filenames and numstat before decorative indentation.
- Color is supplemental; status remains understandable from glyph or text.
- Diff preview adds search, next/previous match, and a visible current-match
  count.

## Test plan

### Unit tests

- NUL-delimited Git status, name-status, and numstat parsers;
- canonical file-state merging;
- diff descriptor construction for every section;
- tree and grouped path construction, collapse state, and path compaction;
- configuration normalization, precedence, and viewer matching;
- ANSI-aware width, truncation, and hit-region calculations.

### Git integration tests

Create temporary repositories that exercise the Git correctness matrix. For
every displayed row, independently execute the expected Git command and compare
the patch returned by the preview provider.

### TUI snapshot tests

Cover Changes and Files at narrow, standard, and wide widths, including:

- empty, clean, and large repositories;
- every file status;
- expanded commits and folders;
- active searches and no-result states;
- long repository, branch, directory, and filename values;
- footer stability after refresh and layout changes.

### Herdr end-to-end tests

- open, close, and reopen the rail from any focused pane;
- ensure only one rail and one file preview exist per workspace;
- click both toolbar controls at their left and right edges;
- expand sections, commits, and directories with the mouse;
- double-click each diff scope and verify its command/output;
- launch and exit a terminal editor;
- launch and exit Glow;
- launch an external and OS-default client;
- move or relink the plugin without leaving stale registrations.

## Repository and release work

Before the first production tag, add:

- a license;
- supported Node and Herdr versions;
- a package manifest with test, lint, snapshot, and development scripts;
- automated formatting and linting;
- CI for macOS and Linux;
- security and contribution guidance;
- a changelog and semantic versioning policy;
- installation, upgrade, configuration, and troubleshooting documentation;
- screenshots or recordings at realistic sidebar widths;
- a fixture-generation command that proves demo data is reproducible.

## Definition of production ready

Herdr GitRail is ready for a first production release when:

1. every row opens a diff independently verified for its exact Git scope;
2. no runtime path can display fabricated content under a real-looking filename;
3. all files and commits are reachable without silent caps;
4. refresh preserves the user's reading and navigation position;
5. unusual paths, renames, binaries, conflicts, and untracked files are handled;
6. editor, viewer, and external-open behavior is verified in Herdr;
7. configuration is validated, documented, and covered by tests;
8. the fixture demo is generated from real Git state and cannot drift manually;
9. the full automated test suite passes on macOS and Linux;
10. the repository contains the packaging, licensing, security, and release
    documentation required for distribution.

## Recommended implementation order

1. Define the canonical file model and diff descriptors.
2. Replace Git parsers with NUL-delimited parsing and integration tests.
3. Implement exact live preview commands for every descriptor.
4. Replace demo literals with a generated fixture repository.
5. Remove silent caps and make refresh preserve UI state.
6. Harden file safety, configuration validation, and process errors.
7. Add diff search and complete keyboard/mouse coverage.
8. Add CI, packaging, documentation, and release automation.
