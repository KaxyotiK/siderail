# Sidebar captures

These captures show the same deterministic production-provider demo in actual
Herdr panes at 36, 52, and 100 terminal columns. The pane output was read with
Herdr's ANSI-preserving CLI and rendered with its complete boundary and footer;
the content was not cropped or hand-edited.

- Visual source: `c818a5a327b0f69e09891b652b8afdd765da4b1c`
- Capture source: `33fa9dffc11b2ef3ad2719853207adb8050f24f9`
- Herdr: `0.8.2`
- Captured: `2026-08-23`, macOS 15

| Narrow (36) | Standard (52) | Wide (100) |
| --- | --- | --- |
| [gitrail-36.png](gitrail-36.png) | [gitrail-52.png](gitrail-52.png) | [gitrail-100.png](gitrail-100.png) |

The fixture intentionally uses `feature/sidebar` and includes Against-base,
commit, staged, unstaged, untracked text, and untracked binary states. Regenerate
the captures from a real Herdr pane after visual changes; never hand-edit totals
or diff statistics.

`npm run screenshots:verify` requires these PNG bytes to match the capture-source
commit and independently compares current deterministic terminal output with the
visual-source commit. No Pillow, platform font, or image generator is required by
the project.

Generate the text snapshot gate independently with:

```bash
npm run snapshot
```
