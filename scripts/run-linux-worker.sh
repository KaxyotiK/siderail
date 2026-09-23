#!/bin/bash
# Runs a Linux release worker in a local Docker container, so the Linux cells
# need neither a Linux machine nor hosted CI. The container clones the candidate
# from this repository's Git directory (mounted read-only) and writes only to
# the handoff directory.
#
# Usage: scripts/run-linux-worker.sh <candidate-sha> <handoff-dir> [node-major] [check]
#   check: live (default) writes the live-linux handoff that docs/RELEASING.md
#          records; npm-install runs scripts/verify-npm-install.sh and writes
#          its log to the handoff directory.
set -euo pipefail

candidate=${1:?candidate SHA required}
handoff=${2:?handoff directory required}
node_major=${3:-24}
check=${4:-live}
case "$handoff" in /*) ;; *) echo "handoff directory must be absolute" >&2; exit 64 ;; esac
case "$node_major" in 22|24) ;; *) echo "node major must be 22 or 24" >&2; exit 64 ;; esac
case "$check" in live|npm-install) ;; *) echo "check must be live or npm-install" >&2; exit 64 ;; esac
test ! -e "$handoff" || { echo "handoff directory already exists: $handoff" >&2; exit 64; }

repository_root=$(cd "$(dirname "$0")/.." && pwd -P)
git_directory=$(cd "$repository_root" && cd "$(git rev-parse --git-common-dir)" && pwd -P)
candidate=$(git -C "$repository_root" rev-parse --verify "$candidate^{commit}")
image="siderail-linux-worker:herdr-0.8.2-node$node_major"

docker build --quiet --tag "$image" --build-arg "NODE_MAJOR=$node_major" \
  "$repository_root/scripts/linux-worker" >/dev/null
mkdir -m 700 "$handoff"

docker run --rm --init --interactive \
  --volume "$git_directory:/source.git:ro" \
  --volume "$handoff:/handoff" \
  --env "CANDIDATE_SHA=$candidate" \
  --env "CHECK=$check" \
  "$image" bash -s <<'WORKER'
set -euo pipefail
git clone --quiet /source.git candidate
cd candidate
git checkout --quiet --detach "$CANDIDATE_SHA"
platform="Linux $(. /etc/os-release && printf '%s' "$PRETTY_NAME")"
if [[ $CHECK = live ]]; then
  log=/handoff/live.log
  {
    test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"
    test -z "$(git status --porcelain)"
    npm ci --ignore-scripts
    HERDR_BIN_PATH=$(command -v herdr) npm run live:release:smoke
    test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"
    test -z "$(git status --porcelain)"
  } 2>&1 | tee "$log"
  printf '%s\n' live-linux > /handoff/cell.txt
else
  log=/handoff/npm-install.log
  HERDR_BIN_PATH=$(command -v herdr) /bin/bash scripts/verify-npm-install.sh "$CANDIDATE_SHA" 2>&1 | tee "$log"
fi
printf '%s\n' "$CANDIDATE_SHA" > /handoff/candidate-sha.txt
printf '%s\n' "$platform" > /handoff/platform.txt
node --version > /handoff/node.txt
herdr --version > /handoff/herdr.txt
chmod 600 /handoff/*
WORKER
# Never report success for a worker that did not produce its evidence.
required=(candidate-sha.txt platform.txt node.txt herdr.txt)
if [[ $check = live ]]; then required+=(live.log cell.txt); else required+=(npm-install.log); fi
for file in "${required[@]}"; do
  test -s "$handoff/$file" || { echo "Linux worker did not write $file" >&2; exit 1; }
done
test "$(<"$handoff/candidate-sha.txt")" = "$candidate" || { echo "Linux worker ran the wrong commit" >&2; exit 1; }
echo "Linux $check worker passed; handoff in $handoff"
