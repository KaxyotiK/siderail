# Releasing

Validate one immutable candidate commit before tagging. Any change to code,
manifest, dependencies, documentation, screenshots, or packaged files creates a
new candidate and invalidates every cell below.

## Freeze and initialize evidence

From a clean `main` worktree:

```bash
candidate_sha=$(git rev-parse HEAD)
evidence_root="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-gitrail/releases/0.1.0"
evidence_file="$evidence_root/evidence.json"
mkdir -p "$evidence_root"
test ! -e "$evidence_file" # archive an older candidate manifest; never overwrite it
npm run release:evidence -- init --file "$evidence_file" --sha "$candidate_sha"
local_log="$evidence_root/local.log"
set -o pipefail
{
  npm ci --ignore-scripts
  npm run check
  npm run test:coverage
  npm run snapshot
  npm run artifact:verify
  test "$(node -p 'require("./package.json").version')" = "$(sed -n 's/^version = "\([^"]*\)"/\1/p' herdr-plugin.toml)"
  test -z "$(git status --porcelain)"
  node --version
} 2>&1 | tee "$local_log"
npm run release:evidence -- record-file --file "$evidence_file" --sha "$candidate_sha" \
  --cell local --command "npm ci; check; coverage; snapshot; artifact" \
  --status pass --evidence-file "$local_log" --node "$(node --version)"
```

Every later record uses the same full SHA. `record-ci` queries GitHub and refuses
a run from another SHA. `record-file` hashes an existing log and requires an
explicit pass/fail result. `verify` refuses missing, failed, changed, mismatched,
or unsupported evidence.

## Automated matrix and dependency audit

Push `candidate_sha`, wait for the CI workflow on that exact commit, and record
the workflow/run URL for these cells:

- `ci-macos-15-node-22`, `ci-macos-15-node-24`
- `ci-ubuntu-24.04-node-22`, `ci-ubuntu-24.04-node-24`
- `poisoned-environment`, `demo-snapshot`

Each OS/Node cell runs `npm ci --ignore-scripts`, `npm run check`, coverage,
snapshots, and artifact verification. The archive job examines `tar -tf` before
extraction, rejects `node_modules/`, `schema/`, and root `.git-rail.json`, then
installs and checks only the extracted candidate.

```bash
ci_run=$(gh run list --workflow ci.yml --commit "$candidate_sha" --limit 1 \
  --json databaseId --jq '.[0].databaseId')
for cell in ci-macos-15-node-22 ci-macos-15-node-24 \
  ci-ubuntu-24.04-node-22 ci-ubuntu-24.04-node-24 \
  poisoned-environment demo-snapshot development-migration; do
  npm run release:evidence -- record-ci --file "$evidence_file" --sha "$candidate_sha" \
    --cell "$cell" --command "CI workflow $ci_run: $cell" --run "$ci_run"
done
while IFS='|' read -r cell platform node_version herdr_version; do
  npm run release:evidence -- record-ci --file "$evidence_file" --sha "$candidate_sha" \
    --cell "$cell" --command "CI workflow $ci_run: $cell" --run "$ci_run" \
    --platform "$platform" --node "$node_version" --herdr "$herdr_version"
done <<'CELLS'
live-macos-15|macOS 15|v22.0.0|herdr 0.8.2
uninstall-macos-15|macOS 15|v22.0.0|herdr 0.8.2
live-ubuntu-24.04|Ubuntu 24.04|v22.0.0|herdr 0.8.2
uninstall-ubuntu-24.04|Ubuntu 24.04|v22.0.0|herdr 0.8.2
CELLS
```

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
npm run release:evidence -- record-ci --file "$evidence_file" --sha "$candidate_sha" \
  --cell dependency-review --command "dependency audit 6c7d9ac..$candidate_sha" --run "$dependency_run"
```

The last command is `record-ci` (not `record-file`); it queries the run and
accepts it only when its conclusion is successful and its head SHA is the
candidate. A workflow for another commit is not evidence.

## Independent archive witness

```bash
archive_file=$(mktemp)
archive_root=$(mktemp -d)
archive_log="$evidence_root/archive.log"
{
  git archive --format=tar --output "$archive_file" "$candidate_sha"
  tar -tf "$archive_file" | node scripts/verify-archive-members.mjs
  tar -xf "$archive_file" -C "$archive_root"
  (
    cd "$archive_root"
    npm ci --ignore-scripts
    npm run artifact:verify
    npm run check
  )
} 2>&1 | tee "$archive_log"
npm run release:evidence -- record-file --file "$evidence_file" --sha "$candidate_sha" \
  --cell archive --command "git archive $candidate_sha; verify members; npm ci; artifact; check" \
  --status pass --evidence-file "$archive_log"
rm -f -- "$archive_file"
rm -rf -- "$archive_root"
```

## Clean install and live Herdr walkthrough

Run on both macOS 15 and Ubuntu 24.04 with a recorded Node 22 or 24 version and
Herdr 0.8.x version. Use an isolated Herdr session and configuration root. Link
a detached candidate checkout so the plugin cannot drift:

```bash
release_runtime=$(mktemp -d)
export HERDR_SESSION="gitrail-release-$(date +%s)-$$"
export XDG_CONFIG_HOME="$release_runtime/config"
export XDG_CACHE_HOME="$release_runtime/cache"
export XDG_STATE_HOME="$release_runtime/state"
export HERDR_BIN_PATH="$(command -v herdr)"
mkdir -p "$release_runtime/bin"
ln -s "$(command -v git)" "$release_runtime/bin/git"
export GIT_RAIL_LIVE_GIT_SHIM="$release_runtime/bin/git"
export PATH="$release_runtime/bin:$PATH"
server_pid=""
candidate_parent=""
candidate_checkout=""
start_server() {
  env GIT_RAIL_NODE_PATH="$(command -v node)" "$HERDR_BIN_PATH" server \
    >> "$release_runtime/herdr-server.log" 2>&1 &
  server_pid=$!
  for _ in $(seq 1 100); do
    if "$HERDR_BIN_PATH" status server >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  return 1
}
cleanup_live() {
  set +e
  if test -n "$candidate_checkout" && test -d "$candidate_checkout"; then
    (cd "$candidate_checkout" && npm run uninstall:herdr) >/dev/null 2>&1
  fi
  "$HERDR_BIN_PATH" session stop "$HERDR_SESSION" --json >/dev/null 2>&1
  if test -n "$server_pid"; then wait "$server_pid" >/dev/null 2>&1; fi
  if test -n "$candidate_checkout" && git worktree list --porcelain | grep -F "worktree $candidate_checkout" >/dev/null; then
    git worktree remove --force "$candidate_checkout"
  fi
  if test -n "$candidate_parent"; then
    node -e 'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })' "$candidate_parent"
  fi
  node -e 'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })' "$release_runtime"
}
trap cleanup_live EXIT
start_server
case "$(uname -s)" in
  Darwin) platform_version="macOS $(sw_vers -productVersion)"; live_cell=live-macos-15 ;;
  Linux) platform_version="Ubuntu $(lsb_release -rs)"; live_cell=live-ubuntu-24.04 ;;
  *) echo "unsupported release platform" >&2; exit 1 ;;
esac
node_version=$(node --version)
herdr_version=$(herdr --version)
live_log="$evidence_root/$live_cell.log"
candidate_parent=$(mktemp -d)
candidate_checkout="$candidate_parent/candidate"
git worktree add --detach "$candidate_checkout" "$candidate_sha"
{
  cd "$candidate_checkout"
  printf 'candidate=%s\nplatform=%s\nnode=%s\nherdr=%s\n' \
    "$candidate_sha" "$platform_version" "$node_version" "$herdr_version"
  npm ci --ignore-scripts
  npm run check
  herdr plugin link .
  npm run live:herdr:smoke
} 2>&1 | tee "$live_log"
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

Append a `PASS` or `FAIL` line for each numbered observation, including the
Herdr commands or screenshots that establish it, to `live_log`. Do not record
the cell as passing if any observation failed.

Uninstall from the candidate checkout. This command first closes only panes
whose current terminal instance, workspace, label, cwd, and argv prove they
belong to that checkout, then unlinks the plugin:

```bash
{
  cd "$candidate_checkout"
  npm run uninstall:herdr
  herdr plugin list
} 2>&1 | tee -a "$live_log"
"$HERDR_BIN_PATH" session stop "$HERDR_SESSION" --json
wait "$server_pid"
server_pid=""
start_server
test "$("$HERDR_BIN_PATH" plugin list)" = "No plugins installed."
unlink_proof=$("$HERDR_BIN_PATH" workspace create --cwd "$candidate_checkout" --label "GitRail unlink proof" --no-focus)
unlink_proof_tab=$(printf '%s' "$unlink_proof" | jq -r '.result.tab.tab_id')
sleep 1
if "$HERDR_BIN_PATH" pane list | jq -e --arg tab "$unlink_proof_tab" \
  '.result.panes[] | select(.tab_id == $tab and .label == "HERDER GITRAIL")' >/dev/null; then
  echo "GitRail startup/event action remained after uninstall" >&2
  exit 1
fi
```

Restart the isolated Herdr session. Confirm no restored GitRail-labelled pane
remains and a newly created Git tab receives no rail. The local log is diagnostic;
the release cells are recorded from the successful candidate-bound macOS and
Ubuntu CI jobs by the automated-matrix commands above. Clean up only after the
local witness has finished:

```bash
printf 'PASS uninstall restart: no restored or new GitRail pane\n' >> "$live_log"
"$HERDR_BIN_PATH" session stop "$HERDR_SESSION" --json
wait "$server_pid"
server_pid=""
git worktree remove "$candidate_checkout"
candidate_checkout=""
node -e 'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })' "$candidate_parent"
candidate_parent=""
trap - EXIT
node -e 'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })' "$release_runtime"
```

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

GitRail never edits user configuration. The `live-herdr-ubuntu` CI job performs
these exact steps, captures the old/candidate SHAs, configuration hashes, pane
and terminal ids, and restart result, and is therefore recorded as the verified
`development-migration` GitHub Actions cell in the automated-matrix loop. A
local rerun is diagnostic evidence, not a substitute for that candidate-bound
successful job.

## Verify evidence; tag only after separate authorization

Record `screenshots` with their visual-source SHA, then verify all 15 required
cells and generate the complete annotated-tag message:

```bash
screenshots_log="$evidence_root/screenshots.log"
visual_source_sha=$(sed -n 's/^- Visual source: `\([0-9a-f]*\)`/\1/p' docs/screenshots/README.md)
{
  cat docs/screenshots/README.md
  shasum -a 256 docs/screenshots/*.png
} > "$screenshots_log"
npm run release:evidence -- record-file --file "$evidence_file" --sha "$candidate_sha" \
  --cell screenshots --command "verify screenshot README and PNG hashes" --status pass \
  --evidence-file "$screenshots_log" --visual-source-sha "$visual_source_sha"
npm run release:evidence -- verify --file "$evidence_file" --sha "$candidate_sha"
npm run release:evidence -- tag-message --file "$evidence_file" --sha "$candidate_sha" \
  > "$evidence_root/tag-message.txt"
test "$(git rev-parse HEAD)" = "$candidate_sha"
test -z "$(git status --porcelain)"
```

L2b is complete after the commands above pass. Only after a separate explicit
authorization to create `v0.1.0`, run L2c:

```bash
test -z "$(git tag -l v0.1.0)"
git tag -a v0.1.0 "$candidate_sha" -F "$evidence_root/tag-message.txt"
git show --no-patch v0.1.0
```

The tag contains the candidate SHA, SHA-256 of the complete evidence manifest,
and each durable evidence reference. Do not move an existing tag. Pushing the
tag or publishing a release remains a separate operation.
