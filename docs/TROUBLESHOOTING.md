# Troubleshooting

## No Git repository

Change a content pane in that Herdr tab into the intended worktree. GitRail
follows the tab's focused content pane on refresh and on its recovery poll;
press `r` to request an immediate refresh. Tabs are resolved independently.

For cmux, GitRail resolves the selected main workspace's `current_directory`;
it never uses its own Dock surface as the source. Confirm the intended main
workspace is selected and press `r`. If cmux's socket is unavailable, the
control falls back to the project cwd from `.cmux/dock.json`.

## GitRail is missing from the cmux Dock

Project Dock config seeds only a new Dock. A restored (including intentionally
empty) Dock snapshot wins over `.cmux/dock.json`. Reload the Dock config or run
`npm run cmux:launch` from a cmux terminal in the intended project. Review the
project trust prompt whenever the Dock config fingerprint changes.

If a preview cannot open, verify that `cmux open --help` is available and that
the build supports v2 surface discovery and close.
Direct Dock launch additionally needs `surface.create` with `initial_command`
and `startup_environment`. See [CMUX.md](CMUX.md).

Configured GitRail records active identity before cmux context discovery, and
the direct launcher waits briefly when a configured control is still starting.
Unrelated configured controls do not block direct launch. After `q` leaves the
control at its login shell, `npm run cmux:launch` reuses that terminal and
starts GitRail again.

## GitRail did not open automatically

Automatic opening runs for each Git-backed tab when Herdr starts or emits
`workspace.created` or `tab.created`. Confirm the plugin is enabled and that
`herdr.autoOpen` is not `false` in the user configuration. A
newly linked plugin does not receive Herdr's one-shot startup hook until the next
server start; use **Open GitRail** for an existing tab in the meantime. GitRail
file-preview tabs are intentionally excluded.

GitRail adopts an existing rail instead of opening a duplicate. If an earlier
process was interrupted during pane creation, the next attempt automatically
recovers its orphaned lock.

GitRail opens only when Herdr can create a direct outer-right split beside a
full-height pane. On top/bottom or otherwise nested layouts where that is not
safe, both automatic and manual opening report a skip and leave every pane
untouched. Rearrange the tab manually if you want to make room for the rail.

## GitRail opened at the wrong width

Set `herdr.sidebarWidth` to an integer from 20 to 200. GitRail applies this only
when creating the pane, so later manual resizing is preserved. On narrow layouts
the initial rail is capped at half of the available split; on unusually wide
layouts Herdr's minimum split ratio may keep it wider than the requested value.

## Base ref is wrong or missing

Set `GIT_RAIL_BASE` for a process override or `baseRef` in user configuration.
For one checked-out branch, set or remove an uncommitted repository-local
preference with:

```bash
git config --local 'branch.feature/my-work.gitrail-base' release/1.x
git config --local --unset-all 'branch.feature/my-work.gitrail-base'
```

To isolate it to the current linked worktree instead, first enable Git's
worktree config:

```bash
git config --local extensions.worktreeConfig true
```

Then use `--worktree` in place of `--local` in both branch commands. Precedence
is `GIT_RAIL_BASE`, user `baseRef`, the current branch key, automatic local
default-branch resolution, remote fallback, and finally a committed `HEAD`.
GitRail prefers the local counterpart of the remote HEAD, then local `main` or
`master`, before the corresponding remote refs. This keeps local `main` clean
even when `origin/main` is stale. Detached HEAD ignores branch keys, and unborn
repositories have no Against-base or commit range until the first commit.
Explicit and branch-configured bases must resolve to commits. Missing refs and
blob/tree object expressions are reported instead of silently falling back.

## Configuration error

GitRail displays the file and validation error. Validate JSON syntax and require
`version: 1`. Editor launch modes are `auto`, `terminal`, and `external`.
Viewer launch modes also include `embedded`, which displays the viewer's output
inside GitRail.

## Editor or viewer does not open

Editor integration is optional; without an editor configuration or `$EDITOR`,
the preview omits the `e` action. Otherwise, confirm the executable is on
`PATH`. Terminal clients temporarily own the
preview pane; external clients open outside Herdr. Set `mode` explicitly when
automatic detection is unsuitable. Viewer actions appear only when the selected
filename matches enabled rules and use their configured `key` bindings.
Patterns beginning with `.` match filename suffixes; other patterns match an
exact basename. Glob-shaped keys such as `*.md` are rejected. Set a matching
viewer to `{ "client": "none" }` to disable an inherited built-in action.
The `*` rule matches every filename. No viewer auto-opens unless its rule sets
`autoOpen: true`; in Herdr, the installed Markdown rules invoke the system
application directly and create no preview tab. Confirm that `open` on macOS or
`xdg-open` on Linux is available. Embedded viewers return bounded, sanitized
terminal output to GitRail, which retains control of wrapping, scrolling,
searching, and resizing.

## Binary or oversized preview

Raw is a textual UTF-8 view, but configured external Open/viewer actions receive
a bounded byte-preserving copy of the exact selected revision and can handle
binary formats. The safety limit is intentional. Increase `limits.maxFileBytes` or
`limits.maxDiffBytes` only for a trusted repository, up to 64 MiB.
The terminal preview also rejects content above 100,000 lines before splitting
or parsing it to prevent small, highly fragmented files from amplifying memory.
Word wrap turns itself off when a line exceeds 100,000 terminal columns or the
result would exceed 100,000 visual rows; horizontal navigation remains
available for that content.
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
