# Sidebar captures

GitRail's terminal snapshots are generated from the real fixture provider and
verified at 36, 52, and 100 columns by `test/snapshot.test.mjs`.

Generate the standard 52-column capture with:

```bash
npm run snapshot
```

The live Herdr dogfood pass for `production-ready` used an 84-column split and
showed the following structure:

```text
 gitrail-fixture
  ⑂ feature/sidebar
 ────────────────────────────────────────────────────
  CHANGES                   FILES
  ⌕ Search changed files…
  ≣ Folders   ↻ Refresh
 ────────────────────────────────────────────────────
 ▏› Against main  2
  › Commits  1
  ⌄ Staged  1
   └─ ⊡ status.mjs                 +2 −1 Staged
  ⌄ Unstaged  3
   └─ ◆ binary.dat              binary Untracked
   └─ ⊞ production ready.md        +4 Untracked
   └─ ⊡ status.mjs               +2 −1 Unstaged
```
