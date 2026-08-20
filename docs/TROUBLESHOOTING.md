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

Confirm the executable is on `PATH`. Terminal clients temporarily own the
preview pane; external clients open outside Herdr. Set `mode` explicitly when
automatic detection is unsuitable. Markdown never auto-opens unless a viewer
rule sets `autoOpen: true`.

## Binary or oversized preview

The safety limit is intentional. Increase `limits.maxFileBytes` or
`limits.maxDiffBytes` only for a trusted repository, up to 64 MiB.

## State appears stale

Press `r`. GitRail watches the worktree and `.git` directory with debounce and
also uses the configured recovery poll. Refresh keeps the previous usable state
when an operation fails.
