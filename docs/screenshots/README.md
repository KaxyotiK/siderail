# Sidebar captures

These captures show the same deterministic production-provider demo at 36, 52,
and 100 terminal columns. Each one renders the exact bytes
`scripts/git-rail.mjs --demo --snapshot` writes at that width, with its complete
boundary and footer; the content is not cropped or hand-edited.

- Visual source: `c818a5a327b0f69e09891b652b8afdd765da4b1c`
- Capture source: `33fa9dffc11b2ef3ad2719853207adb8050f24f9`
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
terminal theme shows. They also apply the same font fallback a terminal does:
Menlo carries every glyph except `⑂` and `⧉`, which come from Apple Symbols.

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
