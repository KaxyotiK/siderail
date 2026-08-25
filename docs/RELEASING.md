# Releasing

GitRail does not use GitHub Actions. Release validation runs locally against one
immutable candidate commit and records hashed logs. Any change to code,
documentation, screenshots, dependencies, the manifest, or packaged files
creates a new candidate and invalidates all evidence.

Committed evidence is not part of the distributable archive. Its terminal logs
are byte-preserved evidence and are exempt from source-code whitespace checks;
the manifest and bundle verifier authenticate every log instead.

The sole post-validation exception is a follow-up commit that changes only the
completion status and evidence references in `PRODUCTION-HARDENING.md` and
`PRODUCTION-READINESS.md`. That record does not change the candidate or enter
the release archive. Any behavioral documentation edit still creates a new
candidate.

Run every command block below in Bash. Each block enables strict mode so an
intermediate failure cannot be followed by a passing evidence record.

## Freeze the candidate

Start from a clean `main` worktree and continue in the same Bash shell for all
blocks:

```bash
set -euo pipefail
candidate_sha=$(git rev-parse HEAD)
test -z "$(git status --porcelain)"
evidence_root="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-gitrail/releases/0.1.0/$candidate_sha"
evidence_file="$evidence_root/evidence.json"
mkdir -p "$evidence_root"
test ! -e "$evidence_file"
npm run release:evidence -- init --file "$evidence_file" --sha "$candidate_sha"
```

Every later command must use that full SHA. `record-file` hashes an existing log
and records an explicit result. `verify` rejects missing, failed, changed, or
mismatched evidence.

## Node 22 and Node 24

Run this block twice: once from a shell using Node 22 and once using Node 24.
It refuses other major versions and records separate `local-node-22` and
`local-node-24` cells.

```bash
set -euo pipefail
node_major=$(node -p 'process.versions.node.split(".")[0]')
case "$node_major" in 22|24) ;; *) echo "activate Node 22 or 24" >&2; exit 1 ;; esac
cell="local-node-$node_major"
log="$evidence_root/$cell.log"
{
  test "$(git rev-parse HEAD)" = "$candidate_sha"
  npm ci --ignore-scripts
  npm run check
  npm run snapshot
  npm run artifact:verify
  test "$(node -p 'require("./package.json").version')" = "$(sed -n 's/^version = "\([^"]*\)"/\1/p' herdr-plugin.toml)"
  test -z "$(git status --porcelain)"
  node --version
} 2>&1 | tee "$log"
npm run release:evidence -- record-file --file "$evidence_file" --sha "$candidate_sha" \
  --cell "$cell" --command "npm ci; check; snapshot; artifact" \
  --status pass --evidence-file "$log" --node "$(node --version)"
```

`npm run check` includes the coverage floors: 95% lines, 86% branches, and 95%
functions.

## Poisoned parent environment

This proves the test helpers cannot inherit a live Herdr pane or executable.

```bash
set -euo pipefail
poison_root=$(mktemp -d "${TMPDIR:-/tmp}/gitrail-poison.XXXXXX")
trap 'rm -rf -- "$poison_root"' EXIT
printf '%s\n' '#!/bin/sh' 'echo "poisoned Herdr escaped the test helper" >&2' 'exit 97' > "$poison_root/herdr"
chmod 700 "$poison_root/herdr"
poison_log="$evidence_root/poisoned-environment.log"
HERDR_PANE_ID=hostile-pane-id HERDR_BIN_PATH="$poison_root/herdr" npm run check 2>&1 | tee "$poison_log"
npm run release:evidence -- record-file --file "$evidence_file" --sha "$candidate_sha" \
  --cell poisoned-environment --command "npm run check with hostile HERDR_*" \
  --status pass --evidence-file "$poison_log"
```

## Exact archive

Validate only files committed in the candidate:

```bash
set -euo pipefail
archive_root=$(mktemp -d "${TMPDIR:-/tmp}/gitrail-archive.XXXXXX")
trap 'rm -rf -- "$archive_root"' EXIT
git archive --format=tar --output "$archive_root/candidate.tar" "$candidate_sha"
tar -tf "$archive_root/candidate.tar" | node scripts/verify-archive-members.mjs
mkdir "$archive_root/worktree"
tar -xf "$archive_root/candidate.tar" -C "$archive_root/worktree"
archive_log="$evidence_root/archive.log"
(
  cd "$archive_root/worktree"
  npm ci --ignore-scripts
  npm run artifact:verify
  npm run check
) 2>&1 | tee "$archive_log"
npm run release:evidence -- record-file --file "$evidence_file" --sha "$candidate_sha" \
  --cell archive --command "git archive; verify members; npm ci; artifact; check" \
  --status pass --evidence-file "$archive_log"
```

## Dependency audit

The project must retain zero runtime dependencies and no high- or
critical-severity advisory in its exact lockfile:

```bash
set -euo pipefail
dependency_log="$evidence_root/dependency-audit.log"
{
  node -e 'const p=require("./package.json");if(p.dependencies&&Object.keys(p.dependencies).length)throw new Error("runtime dependencies must remain empty")'
  npm ci --ignore-scripts
  npm audit --audit-level=high
} 2>&1 | tee "$dependency_log"
npm run release:evidence -- record-file --file "$evidence_file" --sha "$candidate_sha" \
  --cell dependency-audit --command "zero runtime dependencies; npm ci; npm audit" \
  --status pass --evidence-file "$dependency_log"
```

## Isolated live Herdr smoke

Run the checked-in wrapper once on macOS and once on Linux with Herdr 0.8.x,
Node 22 or 24, and Ink 0.7.x available. The wrapper creates private temporary Herdr configuration, state,
cache, and named sessions. It never links or unlinks the operator's normal Herdr
installation. It exercises watch-only and poll-only refresh separately, action-3
Ink TUI and Mermaid rendering, preview replacement, read-only repository invariants, and
uninstall/restart proof.

```bash
set -euo pipefail
case "$(uname -s)" in
  Darwin) live_cell=live-macos; platform="macOS $(sw_vers -productVersion)" ;;
  Linux) live_cell=live-linux; platform="Linux $(. /etc/os-release && printf '%s' "$PRETTY_NAME")" ;;
  *) echo "live release smoke requires macOS or Linux" >&2; exit 1 ;;
esac
live_log="$evidence_root/$live_cell.log"
HERDR_BIN_PATH=$(command -v herdr) npm run live:release:smoke 2>&1 | tee "$live_log"
npm run release:evidence -- record-file --file "$evidence_file" --sha "$candidate_sha" \
  --cell "$live_cell" --command "isolated watch/poll live smoke and uninstall proof" \
  --status pass --evidence-file "$live_log" --platform "$platform" \
  --node "$(node --version)" --herdr "$(herdr --version)"
```

## Screenshots

The verifier checks PNG dimensions, requires exact PNG-byte equality with the
recorded capture-source commit, and byte-compares deterministic 36/52/100-column
output from the candidate and the recorded visual-source commit.

```bash
set -euo pipefail
visual_source_sha=$(sed -n 's/^- Visual source: `\([0-9a-f]*\)`/\1/p' docs/screenshots/README.md)
capture_source_sha=$(sed -n 's/^- Capture source: `\([0-9a-f]*\)`/\1/p' docs/screenshots/README.md)
screenshots_log="$evidence_root/screenshots.log"
npm run screenshots:verify -- --sha "$candidate_sha" 2>&1 | tee "$screenshots_log"
npm run release:evidence -- record-file --file "$evidence_file" --sha "$candidate_sha" \
  --cell screenshots --command "verify capture bytes and candidate/source output" \
  --status pass --evidence-file "$screenshots_log" --visual-source-sha "$visual_source_sha" \
  --capture-source-sha "$capture_source_sha"
```

## Verify and seal

All eight required cells must pass before evidence can be sealed:

```bash
set -euo pipefail
npm run release:evidence -- verify --file "$evidence_file" --sha "$candidate_sha"
test "$(git rev-parse HEAD)" = "$candidate_sha"
test -z "$(git status --porcelain)"
bundle_path="release-evidence/0.1.0/$candidate_sha"
test ! -e "$bundle_path"
npm run release:evidence -- seal --file "$evidence_file" --sha "$candidate_sha" \
  --output "$bundle_path"
npm run release:evidence -- verify-bundle --bundle "$bundle_path" --sha "$candidate_sha"
git add -- "$bundle_path"
git diff --cached --check
git commit -m "Archive v0.1.0 candidate evidence"
evidence_commit=$(git rev-parse HEAD)
test "$(git rev-parse "$evidence_commit^")" = "$candidate_sha"
npm run release:evidence -- tag-message --bundle "$bundle_path" --sha "$candidate_sha" \
  --evidence-commit "$evidence_commit" \
  --repository-url "https://github.com/KaxyotiK/herdr-gitrail" \
  --bundle-repository-path "$bundle_path" > "$evidence_root/tag-message.txt"
```

The evidence-only direct-child commit contains the manifest and all eight hashed
logs. L2b is complete only after that commit is reviewed and retained in the
repository. A subsequent status-only documentation commit may mark L2b and the
readiness rows complete while naming both immutable SHAs. Creating or pushing
`v0.1.0` requires separate explicit authorization:

```bash
set -euo pipefail
test -z "$(git tag -l v0.1.0)"
git tag -a v0.1.0 "$candidate_sha" -F "$evidence_root/tag-message.txt"
git show --no-patch v0.1.0
```

Do not move an existing tag.
