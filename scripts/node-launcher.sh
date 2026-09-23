#!/bin/bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "SideRail launcher: missing script path" >&2
  exit 64
fi

node_path="${SIDERAIL_NODE_PATH:-}"
if [[ -n "$node_path" ]]; then
  if [[ "$node_path" != /* || ! -x "$node_path" ]]; then
    echo "SideRail requires SIDERAIL_NODE_PATH to name an absolute executable" >&2
    exit 69
  fi
else
  node_path="$(command -v node 2>/dev/null || true)"
  if [[ -z "$node_path" ]]; then
    echo "SideRail requires Node.js 22 or newer; install Node or set SIDERAIL_NODE_PATH" >&2
    exit 69
  fi
  if [[ "$node_path" != /* ]]; then
    node_path="$(cd "$(dirname "$node_path")" && pwd -P)/$(basename "$node_path")"
  fi
fi

major="$("$node_path" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)"
if [[ ! "$major" =~ ^[0-9]+$ || "$major" -lt 22 ]]; then
  echo "SideRail requires Node.js 22 or newer (resolved: $node_path)" >&2
  exit 69
fi

export SIDERAIL_NODE_PATH="$node_path"

case "${1##*/}" in
  siderail.mjs|cmux-siderail.mjs) ;;
  *) exec "$node_path" "$@" ;;
esac

# A rail exits with status 75 after a package manager swaps its install
# directory; rerun the same path from the original directory so the pane
# restarts on the new code instead of running stale code.
launch_directory="$PWD"
while true; do
  status=0
  "$node_path" "$@" || status=$?
  if [[ "$status" -ne 75 ]]; then
    exit "$status"
  fi
  cd "$launch_directory" || exit "$status"
done
