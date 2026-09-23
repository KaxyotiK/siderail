#!/bin/bash
set -euo pipefail

script_directory="$(cd -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

if [[ -z "${SIDERAIL_NODE_PATH:-}" ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -x "$candidate" ]]; then
      export SIDERAIL_NODE_PATH="$candidate"
      break
    fi
  done
fi

if [[ -z "${SIDERAIL_NODE_PATH:-}" && -x "${SHELL:-}" ]]; then
  discovered="$($SHELL -lic 'command -v node 2>/dev/null' 2>/dev/null | /usr/bin/tail -n 1 || true)"
  if [[ "$discovered" == /* && -x "$discovered" ]]; then
    export SIDERAIL_NODE_PATH="$discovered"
  fi
fi

if [[ "${SIDERAIL_STAY_OPEN:-0}" == "1" ]]; then
  launch_status=0
  /bin/bash "$script_directory/node-launcher.sh" "$@" || launch_status=$?
  if [[ "$launch_status" -ne 0 ]]; then
    printf 'SideRail exited with status %s.\n' "$launch_status" >&2
  fi
  login_shell="${SHELL:-/bin/bash}"
  if [[ "$login_shell" != /* || ! -x "$login_shell" ]]; then
    login_shell=/bin/bash
  fi
  exec "$login_shell" -l
fi

exec /bin/bash "$script_directory/node-launcher.sh" "$@"
