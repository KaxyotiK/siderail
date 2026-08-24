#!/bin/bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "GitRail launcher: missing script path" >&2
  exit 64
fi

node_path="${GIT_RAIL_NODE_PATH:-}"
if [[ -n "$node_path" ]]; then
  if [[ "$node_path" != /* || ! -x "$node_path" ]]; then
    echo "GitRail requires GIT_RAIL_NODE_PATH to name an absolute executable" >&2
    exit 69
  fi
else
  node_path="$(command -v node 2>/dev/null || true)"
  if [[ -z "$node_path" ]]; then
    echo "GitRail requires Node.js 22 or newer; install Node or set GIT_RAIL_NODE_PATH" >&2
    exit 69
  fi
  if [[ "$node_path" != /* ]]; then
    node_path="$(cd "$(dirname "$node_path")" && pwd -P)/$(basename "$node_path")"
  fi
fi

major="$("$node_path" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)"
if [[ ! "$major" =~ ^[0-9]+$ || "$major" -lt 22 ]]; then
  echo "GitRail requires Node.js 22 or newer (resolved: $node_path)" >&2
  exit 69
fi

export GIT_RAIL_NODE_PATH="$node_path"
exec "$node_path" "$@"
