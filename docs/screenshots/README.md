# Sidebar captures

GitRail's terminal snapshots are generated from the real fixture provider and
verified at 36, 52, and 100 columns by `test/snapshot.test.mjs`.

Generate the standard 52-column capture with:

```bash
npm run snapshot
```

The fixture intentionally uses a feature branch and includes Against-base,
commit, staged, unstaged, untracked text, and binary states. Do not hand-edit
captured totals or diff statistics: regenerate them from the fixture so the
documentation cannot drift from the provider.

For live review, capture both Changes and Files. Files should contain the same
branch diff as Against-base plus neutral grey rows for paths unchanged from the
merge base. Opening a row should create or replace the dedicated preview tab.
Its label should be the selected basename, sanitized and capped at 32 terminal
columns.
