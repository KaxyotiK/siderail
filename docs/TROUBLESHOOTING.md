# Troubleshooting

## No Git repository

Change a content pane in that Herdr tab into the intended worktree. GitRail
follows the tab's focused content pane on refresh and on its recovery poll;
press `r` to request an immediate refresh. Tabs are resolved independently.

## GitRail did not open automatically

Automatic opening runs for each Git-backed tab when Herdr starts or emits
`workspace.created` or `tab.created`. Confirm the plugin is enabled and that
`herdr.autoOpen` is not `false` in the user or repository configuration. A
newly linked plugin does not receive Herdr's one-shot startup hook until the next
server start; use **Open GitRail** for an existing tab in the meantime. GitRail
file-preview tabs are intentionally excluded.

GitRail adopts an existing rail instead of opening a duplicate. If an earlier
process was interrupted during pane creation, the next attempt automatically
recovers its orphaned lock.

## GitRail opened at the wrong width

Set `herdr.sidebarWidth` to an integer from 20 to 200. GitRail applies this only
when creating the pane, so later manual resizing is preserved. On narrow layouts
the initial rail is capped at half of the available split; on unusually wide
layouts Herdr's minimum split ratio may keep it wider than the requested value.

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

Press `r`. GitRail watches the worktree and `.git` directory with debounce,
tracks directory changes in the rail's own Herdr tab, and also uses the
configured recovery poll. Refresh keeps the previous usable state when an
operation fails.

## Files are all shown as changed

The Files tab compares the current worktree with the merge base of the selected
base ref and `HEAD`. A branch that adds or edits every repository file therefore
has no neutral rows. Grey rows appear only for paths identical to that merge
base. Fetch the remote and press `r` if the base ref itself is stale.
