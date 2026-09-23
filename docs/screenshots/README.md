# Sidebar captures

These captures show the same deterministic production-provider demo at 36, 52,
and 100 terminal columns. Each one renders the exact bytes
`scripts/siderail.mjs --demo --snapshot` writes at that width, with its complete
boundary and footer; the content is not cropped or hand-edited.

- Visual source: `fa1c3462fafabd7fcaf64a830f2e09e04d99b0c3`
- Capture source: `fa1c3462fafabd7fcaf64a830f2e09e04d99b0c3`
- Herdr: `0.8.2`
- Captured: `2026-09-23`, macOS 26.6.2

| Narrow (36) | Standard (52) | Wide (100) |
| --- | --- | --- |
| [siderail-36.png](siderail-36.png) | [siderail-52.png](siderail-52.png) | [siderail-100.png](siderail-100.png) |

The fixture intentionally uses `feature/sidebar` and includes Against-base,
commit, staged, unstaged, untracked text, and untracked binary states. Folders
start collapsed, so the captures show section rows rather than expanded files.
Never hand-edit totals or diff statistics.

SideRail pins no 24-bit colors of its own; see [Colors and glyphs](../THEMING.md).
The captures therefore resolve its indexed colors through the reference dark
palette in `scripts/render-screenshots.py`, which is what a conventional dark
terminal theme shows. Menlo carries every glyph SideRail draws, so the captures need no font
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
