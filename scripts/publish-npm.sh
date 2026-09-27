#!/bin/bash
# Publishes the exact tarball the npm install lifecycle verified for a tagged
# release, after the checks docs/RELEASING.md requires. Run it yourself from a
# checkout of main that contains the release's sealed evidence bundle.
#
# Usage: scripts/publish-npm.sh [--dry-run] [version]
#   version:   defaults to package.json's version
#   --dry-run: runs every check and `npm publish --dry-run`, publishing nothing
set -euo pipefail

dry_run=""
release=""
for argument in "$@"; do
  case "$argument" in
    --dry-run) dry_run="--dry-run" ;;
    -*) echo "unknown option: $argument" >&2; exit 2 ;;
    *) test -z "$release" || { echo "only one version may be given" >&2; exit 2; }; release="$argument" ;;
  esac
done

cd "$(dirname "$0")/.."
release=${release:-$(node -p 'require("./package.json").version')}
tag="v$release"

# The tag must exist locally and be the same object as the pushed tag.
local_tag=$(git rev-parse --verify --quiet "refs/tags/$tag") || { echo "no local tag $tag" >&2; exit 1; }
remote_tag=$(git ls-remote --tags origin "refs/tags/$tag" | cut -f1)
test -n "$remote_tag" || { echo "$tag is not pushed to origin" >&2; exit 1; }
test "$remote_tag" = "$local_tag" || { echo "local $tag differs from origin's" >&2; exit 1; }
candidate_sha=$(git rev-parse "$tag^{commit}")

bundle="release-evidence/$release/$candidate_sha"
test -f "$bundle/evidence.json" || { echo "no sealed evidence at $bundle; check out main after the evidence merge" >&2; exit 1; }
npm run --silent release:evidence -- verify-bundle --bundle "$bundle" --sha "$candidate_sha"

evidence_root="${XDG_STATE_HOME:-$HOME/.local/state}/siderail/releases/$release/$candidate_sha"
tarball="$evidence_root/package/siderail-$release.tgz"
test -f "$tarball" || { echo "no verified tarball at $tarball" >&2; exit 1; }
digest=$(shasum -a 256 "$tarball" | cut -d' ' -f1)
grep -q "siderail-$release.tgz: .* sha256 $digest\$" "$bundle/files/npm-install.log" \
  || { echo "$tarball does not match the digest in the sealed npm-install log" >&2; exit 1; }

# `npm view` succeeds with no output for an unpublished version.
if [ -n "$(npm view "siderail@$release" version 2>/dev/null || true)" ]; then
  echo "siderail@$release is already on npm; a published version cannot be reused" >&2
  exit 1
fi

echo "Publishing siderail $release from $tag ($candidate_sha)"
echo "  tarball: $tarball"
echo "  sha256:  $digest"
npm publish "$tarball" --access public $dry_run
test -z "$dry_run" || exit 0

# The registry can take a few minutes to show a version it has accepted.
for attempt in $(seq 1 18); do
  if [ -n "$(npm view "siderail@$release" version 2>/dev/null || true)" ]; then
    echo "siderail@$release is on npm"
    exit 0
  fi
  sleep 10
done
echo "npm accepted the publish, but siderail@$release is not visible yet; check later with: npm view siderail@$release version" >&2
exit 1
