# Sidebar captures

These captures show the same deterministic production-provider demo at 36, 52,
and 100 terminal columns. Each one renders the exact bytes
`scripts/git-rail.mjs --demo --snapshot` writes at that width, with its complete
boundary and footer; the content is not cropped or hand-edited.

- Visual source: `14e28b4ed0e2cc3ef6a518359ef56b9c98fdcb78`
- Capture source: `14e28b4ed0e2cc3ef6a518359ef56b9c98fdcb78`
- Herdr: `0.8.2`
- Captured: `2026-09-01`, macOS 26.5.2

| Narrow (36) | Standard (52) | Wide (100) |
| --- | --- | --- |
| [gitrail-36.png](gitrail-36.png) | [gitrail-52.png](gitrail-52.png) | [gitrail-100.png](gitrail-100.png) |

The fixture intentionally uses `feature/sidebar` and includes Against-base,
commit, staged, unstaged, untracked text, and untracked binary states. Folders
start collapsed, so the captures show section rows rather than expanded files.
Never hand-edit totals or diff statistics.

GitRail pins no 24-bit colors of its own; see [Colors and glyphs](../THEMING.md).
The captures therefore resolve its indexed colors through the reference dark
palette in `scripts/render-screenshots.py`, which is what a conventional dark
terminal theme shows. Menlo carries every glyph GitRail draws, so the captures need no font
fallback; see the glyph-coverage note in that document.

## Regenerating

Run this after any change to rail rendering, layout, or the demo fixture, then
update both SHAs above in a follow-up commit that touches nothing else:

```bash
python3 -m pip install --user pillow
python3 scripts/render-screenshots.py
```

`npm run screenshots:verify` requires these PNG bytes to match the capture-source
commit and independently compares current deterministic terminal output with the
visual-source commit. Verification itself needs no Pillow, platform font, or
image generator; only regeneration does.

Generate the text snapshot gate independently with:

```bash
npm run snapshot
```
