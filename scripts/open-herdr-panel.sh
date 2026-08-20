#!/usr/bin/env bash
set -euo pipefail

herdr="${HERDR_BIN_PATH:-herdr}"
entrypoint="${1:-}"
plugin_id="${HERDR_PLUGIN_ID:-local.git-rail}"

if [[ -z "$entrypoint" ]]; then
  echo "missing entrypoint" >&2
  exit 1
fi

json_value() {
  local payload="${1:-}"
  local expression="${2:-}"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$payload" | jq -r ".$expression // empty"
  else
    printf '%s' "$payload" | python3 -c 'import json,sys; keys=sys.argv[1].split("."); value=json.load(sys.stdin); [None for key in keys if not (value := value.get(key, {}) if isinstance(value, dict) else {})]; print(value if isinstance(value, str) else "")' "$expression" 2>/dev/null || true
  fi
}

workspace_id="${HERDR_WORKSPACE_ID:-}"
target_pane_id="${HERDR_PANE_ID:-${HERDR_TARGET_PANE_ID:-}}"
context_json="${HERDR_PLUGIN_CONTEXT_JSON:-}"
if [[ -z "$workspace_id" && -n "$context_json" ]]; then
  workspace_id="$(json_value "$context_json" 'workspace_id' | head -n1 | tr -d '\r\n')"
fi
if [[ -z "$target_pane_id" && -n "$context_json" ]]; then
  target_pane_id="$(json_value "$context_json" 'focused_pane_id' | head -n1 | tr -d '\r\n')"
fi
if [[ -z "$workspace_id" ]]; then
  workspace_json="$($herdr workspace list)"
  if command -v jq >/dev/null 2>&1; then
    workspace_id="$(printf '%s' "$workspace_json" | jq -r '.result.workspaces[] | select(.focused == true) | .workspace_id' | head -n1)"
  else
    workspace_id="$(printf '%s' "$workspace_json" | python3 -c 'import json,sys; data=json.load(sys.stdin); print(next((item.get("workspace_id", "") for item in data.get("result", {}).get("workspaces", []) if item.get("focused")), ""))')"
  fi
fi
if [[ -z "$workspace_id" ]]; then
  echo "unable to resolve Herdr workspace" >&2
  exit 1
fi

state_dir="${XDG_CACHE_HOME:-$HOME/.cache}/herdr-gitrail/panes"
mkdir -p "$state_dir"
chmod 700 "$state_dir"
state_key="$(printf '%s-%s' "$workspace_id" "$entrypoint" | tr -cs 'A-Za-z0-9._-' '_')"
state_file="$state_dir/$state_key"
if [[ -f "$state_file" ]]; then
  previous_pane_id="$(head -n1 "$state_file" | tr -d '\r\n')"
  if [[ -n "$previous_pane_id" && "$previous_pane_id" != "$target_pane_id" ]]; then
    "$herdr" pane close "$previous_pane_id" >/dev/null 2>&1 || true
  fi
fi

open_args=(
  "$herdr" plugin pane open
  --plugin "$plugin_id"
  --entrypoint "$entrypoint"
  --no-focus
)
if [[ -n "$target_pane_id" ]]; then
  open_args+=(--target-pane "$target_pane_id" --placement split --direction right)
else
  open_args+=(--workspace "$workspace_id" --placement overlay)
fi

result="$("${open_args[@]}")"
printf '%s\n' "$result"
if command -v jq >/dev/null 2>&1; then
  opened_pane_id="$(printf '%s' "$result" | jq -r '.result.plugin_pane.pane.pane_id // .result.pane.pane_id // .result.pane_id // empty')"
else
  opened_pane_id="$(printf '%s' "$result" | python3 -c 'import json,sys; result=json.load(sys.stdin).get("result", {}); plugin=result.get("plugin_pane", {}); pane=plugin.get("pane", {}) if isinstance(plugin, dict) else result.get("pane", {}); print(pane.get("pane_id", "") if isinstance(pane, dict) else result.get("pane_id", ""))' 2>/dev/null || true)"
fi
if [[ -n "$opened_pane_id" ]]; then
  printf '%s\n' "$opened_pane_id" > "$state_file"
  chmod 600 "$state_file"
fi
