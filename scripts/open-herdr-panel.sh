#!/usr/bin/env bash
set -euo pipefail

plugin_root="${HERDR_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
exec "$plugin_root/scripts/node-launcher.sh" "$plugin_root/scripts/open-herdr-panel.mjs" "${1:-}" "${2:-replace}"
