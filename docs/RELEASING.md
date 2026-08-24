# Releasing

Validate one immutable candidate commit before tagging. Any change to code,
manifest, dependencies, documentation, screenshots, or packaged files creates a
new candidate and invalidates every cell below.

## Freeze and initialize evidence

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
evidence_root="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-gitrail/releases/0.1.0"
evidence_file="$evidence_root/evidence.json"
mkdir -p "$evidence_root"
npm run release:evidence -- init --file "$evidence_file" --sha "$candidate_sha"
npm run release:evidence -- record --file "$evidence_file" --sha "$candidate_sha" \
  --cell local --command "npm ci; check; coverage; snapshot; artifact" \
  --evidence "local logs: $evidence_root"
```

Every later record uses the same form and full SHA. `record` refuses unknown
cells or a different SHA; `verify` refuses a missing or failed cell.

## Automated matrix and dependency audit

Push `candidate_sha`, wait for the CI workflow on that exact commit, and record
the workflow/run URL for these cells:

- `ci-macos-15-node-22`, `ci-macos-15-node-24`
- `ci-ubuntu-24.04-node-22`, `ci-ubuntu-24.04-node-24`
- `poisoned-environment`, `demo-snapshot`, `archive`

Each OS/Node cell runs `npm ci --ignore-scripts`, `npm run check`, coverage,
snapshots, and artifact verification. The archive job examines `tar -tf` before
extraction, rejects `node_modules/`, `schema/`, and root `.git-rail.json`, then
installs and checks only the extracted candidate.

GitHub's dependency-review API is unavailable for this private repository
without GitHub Advanced Security. The executable replacement records the exact
lockfile diff, proves the head checkout, performs a clean install, retains zero
runtime dependencies, and fails on high/critical npm advisories. Dispatch it
against the reviewed development base and exact candidate:

```bash
gh workflow run dependency-audit.yml --ref "$candidate_sha" \
  -f base_ref=6c7d9ac -f head_ref="$candidate_sha"
dependency_run=$(gh run list --workflow dependency-audit.yml --commit "$candidate_sha" \
  --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$dependency_run" --exit-status
dependency_url=$(gh run view "$dependency_run" --json url --jq .url)
npm run release:evidence -- record --file "$evidence_file" --sha "$candidate_sha" \
  --cell dependency-review --command "dependency audit 6c7d9ac..$candidate_sha" \
  --evidence "$dependency_url"
```

Use `release:evidence record` for every CI cell, naming its exact run URL. A
workflow for another commit is not evidence.

## Independent archive witness

```bash
archive_file=$(mktemp)
archive_root=$(mktemp -d)
git archive --format=tar --output "$archive_file" "$candidate_sha"
tar -tf "$archive_file" | node scripts/verify-archive-members.mjs
tar -xf "$archive_file" -C "$archive_root"
(
  cd "$archive_root"
  npm ci --ignore-scripts
  npm run artifact:verify
  npm run check
)
npm run release:evidence -- record --file "$evidence_file" --sha "$candidate_sha" \
  --cell archive --command "git archive $candidate_sha; verify members; npm ci; artifact; check" \
  --evidence "$evidence_root/archive.log"
rm -f -- "$archive_file"
rm -rf -- "$archive_root"
```

## Clean install and live Herdr walkthrough

Run on both macOS 15 and Ubuntu 24.04 with a recorded Node 22 or 24 version and
Herdr 0.8.x version. Use an isolated Herdr session and configuration root. Link
a detached candidate checkout so the plugin cannot drift:

```bash
candidate_checkout=$(mktemp -d)
git worktree add --detach "$candidate_checkout" "$candidate_sha"
(
  cd "$candidate_checkout"
  npm ci --ignore-scripts
  npm run check
  herdr plugin link .
  npm run live:herdr:smoke
)
```

The walkthrough must observe:

1. Exactly one unfocused rail auto-opens in a Git tab, and none in a non-Git or
   preview tab.
2. Open and Toggle do not close an unrelated pane.
3. Staged, Unstaged, and Untracked are separate; Untracked uses `?`.
4. Markdown actions `1 Diff`, `2 Raw`, and `3 Rendered` all describe the same
   exact revision; action 3 renders with embedded Glow.
5. Preview replacement is scoped to its workspace and source tab.
6. Auto-open skips an unsafe layout; explicit Open can rebuild and recover it.
7. Manual refresh, filesystem invalidation, and recovery polling converge while
   preserving the last usable state after a failed refresh.
8. Git status, HEAD, refs, index bytes/mtime, and worktree bytes are unchanged
   by inspection.
9. The 36/52/100-column states match the checked-in screenshots.

Uninstall from the candidate checkout. This command first closes only panes
whose current terminal instance, workspace, label, cwd, and argv prove they
belong to that checkout, then unlinks the plugin:

```bash
(
  cd "$candidate_checkout"
  npm run uninstall:herdr
)
herdr plugin list
```

Restart the isolated Herdr session. Confirm no restored GitRail-labelled pane
remains and a newly created Git tab receives no rail. Record `live-macos-15` or
`live-ubuntu-24.04`, plus the matching `uninstall-*` cell, including platform,
Node, and Herdr versions. Then remove the detached worktree.

## Development migration and pane-state continuity

There is no public upgrade cell for 0.1.0. The development-only witness starts
from `6c7d9ac`:

1. In isolated user config, set `baseRef` to a valid `user-base`; in the old
   checkout's `.git-rail.json`, set it to a distinct valid `repo-base`.
2. Link `6c7d9ac` and prove it resolves `repo-base`.
3. Remove `$schema` from the same user file without otherwise rewriting it,
   then link the candidate over `local.git-rail`.
4. Prove the candidate displays `Against user-base`, never `repo-base`, and
   leaves the user-config hash unchanged.
5. Prove the existing per-tab pane-state record continues to track the newly
   opened candidate rail. This is continuity, not a migration feature.
6. Run the ownership-safe uninstall/restart proof and record the
   `development-migration` cell.

GitRail never edits user configuration.

## Verify evidence and tag

Record `screenshots` with their visual-source SHA, then verify all 15 required
cells and generate the complete annotated-tag message:

```bash
npm run release:evidence -- verify --file "$evidence_file" --sha "$candidate_sha"
npm run release:evidence -- tag-message --file "$evidence_file" --sha "$candidate_sha" \
  > "$evidence_root/tag-message.txt"
test "$(git rev-parse HEAD)" = "$candidate_sha"
test -z "$(git status --porcelain)"
test -z "$(git tag -l v0.1.0)"
git tag -a v0.1.0 "$candidate_sha" -F "$evidence_root/tag-message.txt"
git show --no-patch v0.1.0
```

The tag contains the candidate SHA, SHA-256 of the complete evidence manifest,
and each durable evidence reference. Do not move an existing tag. Pushing the
tag or publishing a release remains a separate operation.
