# Git Rail prototype

A compact, read-only Git sidebar for the repository in the focused Herdr pane.
It is scoped to one worktree and its current branch: no workspace collection or
multi-repository navigation is built into the rail.

## Launch

From this directory:

```bash
herdr plugin link .
herdr plugin action invoke local.git-rail.open-git-rail
```

Open the deterministic Superset-inspired mockup when the focused directory is
not a Git repository or you want a full set of sample states:

```bash
herdr plugin action invoke local.git-rail.open-git-rail-mockup
```

The live rail derives the repository name, current branch, comparison base,
commits, staged changes, unstaged changes, and tracked files from Git. Override
the comparison base with `GIT_RAIL_BASE`; otherwise it resolves `origin/HEAD`,
then common main/master refs.

## Interaction

- `Tab` switches Changes / Files.
- `/` focuses search in either view.
- `g` toggles the shared tree / folder-grouped layout.
- Arrow keys or `j`/`k` scroll; `r` refreshes; Escape or `q` closes.
- Section headers, commits, directories, files, tabs, and toolbar controls are
  clickable in terminals with SGR mouse support, including Herdr.
- A single file click selects it. A double-click opens a focused, read-only Herdr
  preview. Commit files preview that commit's patch.

Against-base and Commits start collapsed; Staged and Unstaged start expanded.
At normal sidebar widths, both tabs automatically use compact folder groups.
Wider panes use the complete tree. Long parent paths collapse through the middle
so filenames and right-aligned `+N/−N` stats retain space.

The preview offers clickable Diff, Raw, and Markdown modes (`1`, `2`, `3`, or
`Tab`). Markdown delegates rendering to Glow; the plugin does not maintain its
own Markdown renderer. Press `e` to open the selected file with a configured
editor or OS application.

## Open-client configuration

The explicit `e` action resolves its client in this order:

1. `GIT_RAIL_CLIENT`, with optional `GIT_RAIL_CLIENT_MODE` and JSON-array
   arguments in `GIT_RAIL_CLIENT_ARGS`
2. `<repo>/.git-rail.json`
3. `~/.config/git-rail/config.json`
4. `$EDITOR`
5. `vim`

Both JSON locations use the shape in `git-rail.config.example.json`. `client` is
an executable name or absolute path, `args` is passed directly without a shell,
and `mode` is `auto`, `terminal`, or `external`. Auto runs known terminal editors
inside Herdr and treats GUI clients such as VS Code or Cursor as external.

Special clients:

- `system` uses macOS `open` or Linux `xdg-open`.
- `none` disables editing while retaining previews.
- `builtin` keeps a matching file in the Diff/Raw preview shell.

Optional `viewers` rules match a filename, suffix, or `*`. A matching viewer
opens after a file is double-clicked unless `autoOpen` is `false`. Markdown uses
Glow by default and may be overridden with the same mechanism.

For the OS-default application:

```json
{ "client": "system", "args": [], "mode": "external" }
```

For a GUI client that opens outside Herdr:

```json
{ "client": "code", "args": ["--reuse-window"], "mode": "external" }
```

Generate a deterministic terminal snapshot without opening Herdr:

```bash
node scripts/git-rail.mjs --demo --snapshot --width 52 --height 46
```

See `SUPERSET-GIT-RAIL-NOTES.md` for the source review and the behavior carried
over from Superset.
