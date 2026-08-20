# Troubleshooting

## No Git repository

Focus a Herdr pane whose current directory is inside the intended worktree, then
press `r`. GitRail is deliberately scoped to one focused worktree.

## Base ref is wrong or missing

Set `baseRef` in configuration or `GIT_RAIL_BASE`. Without an override, GitRail
tries the remote HEAD, `origin/main`, `origin/master`, `main`, and `master`.
Unborn repositories have no Against-base or commit range until the first commit.

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
The `*` rule matches every filename. No viewer auto-opens unless its rule sets
`autoOpen: true`; the installed Markdown rules enable it for Glow by default.
If Glow is missing, GitRail does not attempt to spawn it repeatedly: the preview
stays usable in Diff or Raw and reports how to disable auto-open.

## Binary or oversized preview

The safety limit is intentional. Increase `limits.maxFileBytes` or
`limits.maxDiffBytes` only for a trusted repository, up to 64 MiB.

## State appears stale

Press `r`. GitRail watches the worktree and `.git` directory with debounce and
also uses the configured recovery poll. Refresh keeps the previous usable state
when an operation fails.

## Files are all shown as changed

The Files tab compares the current worktree with the merge base of the selected
base ref and `HEAD`. A branch that adds or edits every repository file therefore
has no neutral rows. Grey rows appear only for paths identical to that merge
base. Fetch the remote and press `r` if the base ref itself is stale.
