# Releasing

Release validation is performed against one immutable candidate commit. Do not
tag first and validate afterward. Any change to code, the manifest,
dependencies, documentation, screenshots, or packaged files invalidates the
affected cells.

## Freeze the candidate

From a clean `main` worktree:

```bash
npm ci --ignore-scripts
npm run check
npm run test:coverage
npm run snapshot
npm run artifact:verify
test "$(node -p 'require("./package.json").version')" = "$(sed -n 's/^version = "\([^"]*\)"/\1/p' herdr-plugin.toml)"
test -z "$(git status --porcelain)"
candidate_sha=$(git rev-parse HEAD)
git show --no-patch --format='%H %cI' "$candidate_sha"
```

Create evidence outside the worktree so validation cannot dirty the candidate:

```bash
evidence_root="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-gitrail/releases/0.1.0"
mkdir -p "$evidence_root"
printf '%s\n' "$candidate_sha" > "$evidence_root/candidate-sha"
node --version > "$evidence_root/local-node-version"
git --version > "$evidence_root/local-git-version"
herdr --version > "$evidence_root/local-herdr-version"
```

## Automated matrix

Required GitHub Actions cells are macOS 15 and Ubuntu 24.04, each on Node 22 and
24. Every cell checks out `candidate_sha` and runs:

```bash
npm ci --ignore-scripts
npm run check
npm run test:coverage
npm run snapshot
npm run artifact:verify
```

The separate poisoned-environment job runs the full check with hostile
`HERDR_PANE_ID` and `HERDR_BIN_PATH`. The demo/snapshot and dependency-review
jobs must also pass. Record the workflow URL and each cell result in
`$evidence_root/ci.txt`.

Verify the packaged checkout, independent of untracked files:

```bash
archive_root=$(mktemp -d)
git archive --format=tar "$candidate_sha" | tar -xf - -C "$archive_root"
(
  cd "$archive_root"
  npm ci --ignore-scripts
  npm run artifact:verify
  npm run check
)
test ! -e "$archive_root/schema"
test ! -e "$archive_root/node_modules/.git-rail.json"
rm -rf "$archive_root"
```

Failure cleanup: retain CI logs under the evidence directory, delete only the
temporary archive directory, fix the source, create a new candidate commit, and
rerun every affected cell.

## Clean install and live Herdr walkthrough

Run this cell on macOS 15 and Ubuntu 24.04 with Herdr 0.8.0+ and Node 22+.
Create a detached candidate checkout so the linked plugin cannot drift:

```bash
candidate_checkout=$(mktemp -d)
git worktree add --detach "$candidate_checkout" "$candidate_sha"
(
  cd "$candidate_checkout"
  npm ci --ignore-scripts
  herdr plugin link .
  herdr plugin list
)
```

Record pass/fail for each observation:

1. Startup creates one unfocused GitRail rail in a Git-backed tab, but not in a
   non-Git tab or a GitRail preview tab.
2. Manual Open and Toggle work without closing an unrelated pane.
3. Changes visibly separates Staged, Unstaged, and Untracked; Untracked uses
   `?` and is expanded by default.
4. A Markdown selection opens a preview whose `1 Diff`, `2 Raw`, and
   `3 Rendered` actions work; Rendered uses Glow inside the viewport.
5. Opening a second file replaces only the preview owned by the same source
   tab. A preview from another source tab remains open.
6. Auto-open skips an unsafe layout without moving panes. Explicit Open can
   rebuild and restore that layout through its journal.
7. `r`, filesystem invalidation, and the recovery poll converge after a branch,
   index, or worktree change while preserving the last usable state on failure.
8. The 36-, 52-, and 100-column screenshot states match the checked-in assets.

Unlink and prove cleanup:

```bash
herdr plugin unlink local.git-rail
herdr plugin list
git worktree remove "$candidate_checkout"
```

Restart Herdr and confirm no GitRail startup or event action remains. If the
walkthrough fails, unlink before editing, retain the evidence, and restart with
a new candidate SHA.

## Development migration from `6c7d9ac`

There is no public upgrade cell for the first release. The development migration
starts with that commit linked under `local.git-rail`:

1. Remove `$schema` from `~/.config/git-rail/config.json`.
2. Move desired `.git-rail.json` values into the user configuration, then leave
   or delete the repository file; the candidate ignores it.
3. Link the detached candidate checkout over the same plugin id and verify the
   resolved configuration, launch, source-tab preview replacement, and stale
   pane-state migration.
4. Run the unlink/restart proof above. GitRail never edits user configuration.

## Tag

Only after every automated and live cell names the same candidate SHA, the
screenshots name their visual-source SHA, the worktree is clean, and versions
agree:

```bash
test "$(git rev-parse HEAD)" = "$candidate_sha"
test -z "$(git status --porcelain)"
test -z "$(git tag -l v0.1.0)"
git tag -a v0.1.0 "$candidate_sha" -m "Herdr GitRail 0.1.0

Validated candidate: $candidate_sha
Evidence: $evidence_root"
git show --no-patch v0.1.0
```

Do not move an existing tag. Pushing the candidate, tag, or publishing a release
is a separate operation from this checklist.
