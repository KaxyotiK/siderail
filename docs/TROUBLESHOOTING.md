# Troubleshooting

## No Git repository

Focus a Herdr pane whose current directory is inside the intended worktree, then
press `r`. GitRail is deliberately scoped to one focused worktree.

## GitRail did not open automatically

Automatic opening runs for Git-backed workspaces when Herdr starts or emits
`workspace.created`. Confirm the plugin is enabled and that
`herdr.autoOpen` is not `false` in the user or repository configuration. A
newly linked plugin does not receive Herdr's one-shot startup hook until the next
server start; use **Open GitRail** for the current workspace in the meantime.

## Base ref is wrong or missing

Set `baseRef` in configuration or `GIT_RAIL_BASE`. Without an override, GitRail
tries the remote HEAD, `origin/main`, `origin/master`, `main`, and `master`.
Unborn repositories have no Against-base or commit range until the first commit.
An explicit base must resolve to a commit. Missing refs and blob/tree object
expressions are reported instead of silently falling back to another branch.

## Configuration error

GitRail displays the file and validation error. Validate JSON syntax, require
`version: 1`, and use `auto`, `terminal`, or `external` for launch modes.

## Editor or viewer does not open

Editor integration is optional; without an editor configuration or `$EDITOR`,
the preview omits the `e` action. Otherwise, confirm the executable is on
`PATH`. Terminal clients temporarily own the
preview pane; external clients open outside Herdr. Set `mode` explicitly when
automatic detection is unsuitable. Viewer actions appear only when the selected
filename matches enabled rules and use their configured `key` bindings.
Patterns beginning with `.` match filename suffixes; other patterns match an
exact basename.
The `*` rule matches every filename. No viewer auto-opens unless its rule sets
`autoOpen: true`; the installed Markdown rules enable it for Glow by default.
If Glow is missing, GitRail does not attempt to spawn it repeatedly: the preview
stays usable in Diff or Raw and reports how to disable auto-open.

## Binary or oversized preview

Raw is a textual UTF-8 view, but configured external Open/viewer actions receive
a bounded byte-preserving copy of the exact selected revision and can handle
binary formats. The safety limit is intentional. Increase `limits.maxFileBytes` or
`limits.maxDiffBytes` only for a trusted repository, up to 64 MiB.
The terminal preview also rejects content above 100,000 lines before splitting
or parsing it to prevent small, highly fragmented files from amplifying memory.
Use a configured external Open/viewer action for those files.

## State appears stale

Press `r`. GitRail watches the worktree and `.git` directory with debounce and
also uses the configured recovery poll. Refresh keeps the previous usable state
when an operation fails.

## Files are all shown as changed

The Files tab compares the current worktree with the merge base of the selected
base ref and `HEAD`. A branch that adds or edits every repository file therefore
has no neutral rows. Grey rows appear only for paths identical to that merge
base. Fetch the remote and press `r` if the base ref itself is stale.
