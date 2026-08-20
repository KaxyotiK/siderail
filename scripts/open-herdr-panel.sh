#!/usr/bin/env bash
set -euo pipefail

herdr="${HERDR_BIN_PATH:-herdr}"
entrypoint="${1:-}"

if [[ -z "$entrypoint" ]]; then
  echo "missing entrypoint" >&2
  exit 1
fi

plugin_id="${HERDR_PLUGIN_ID:-local.git-rail}"

case "$entrypoint" in
  git-tui) target_label="Git Rail" ;;
  git-mockup) target_label="Git Rail Mockup" ;;
  *) target_label="Git Rail" ;;
esac

resolve_json() {
  local value="${1:-}"
  if [[ -z "$value" ]]; then
    return
  fi
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$value" | jq -r "$2"
  fi
}

workspace_id="${HERDR_WORKSPACE_ID:-}"
target_pane_id="${HERDR_PANE_ID:-${HERDR_TARGET_PANE_ID:-}}"
if [[ -z "$workspace_id" ]] && [[ -n "${HERDR_PLUGIN_CONTEXT_JSON:-}" ]]; then
  workspace_id="$(resolve_json "$HERDR_PLUGIN_CONTEXT_JSON" '.workspace_id // .workspace // empty' | head -n1)"
  workspace_id="${workspace_id//$'\n'/}"
  workspace_id="$(printf '%s' "$workspace_id" | tr -d '\r')"
  if [[ -z "$target_pane_id" ]]; then
    target_pane_id="$(resolve_json "$HERDR_PLUGIN_CONTEXT_JSON" '.focused_pane_id // empty' | head -n1)"
    target_pane_id="${target_pane_id//$'\n'/}"
    target_pane_id="$(printf '%s' "$target_pane_id" | tr -d '\r')"
  fi
fi

if [[ -z "$workspace_id" ]]; then
  if command -v jq >/dev/null 2>&1; then
    workspace_id="$($herdr workspace list 2>/dev/null | jq -r '.result.workspaces[] | select(.focused == true) | .workspace_id' | head -n1)"
  else
    workspace_list="$($herdr workspace list 2>/dev/null || true)"
    # shell fallback keeps behavior deterministic when jq is unavailable
    workspace_id="$(printf '%s' "$workspace_list" | python3 -c 'import json,sys; payload=json.load(sys.stdin); focused=next((ws for ws in payload.get("result", {}).get("workspaces", []) if ws.get("focused")), None); print(focused.get("workspace_id", "") if focused else "")' 2>/dev/null || true)"
  fi
fi

if [[ -z "$workspace_id" ]]; then
  echo "unable to resolve workspace id" >&2
  exit 1
fi

if [[ -n "$workspace_id" ]]; then
  if [[ -z "$target_pane_id" ]] && [[ -n "${HERDR_PLUGIN_CONTEXT_JSON:-}" ]] && command -v jq >/dev/null 2>&1; then
    target_pane_id="$(resolve_json "$HERDR_PLUGIN_CONTEXT_JSON" '.focused_pane_id // empty' | head -n1)"
    target_pane_id="${target_pane_id//$'\n'/}"
    target_pane_id="$(printf '%s' "$target_pane_id" | tr -d '\r')"
  fi

  pane_list="$($herdr pane list --workspace "$workspace_id" 2>/dev/null || true)"
  if command -v jq >/dev/null 2>&1; then
    existing="$(printf '%s' "$pane_list" | jq -r --arg label "$target_label" '.result.panes[] | select(.label == $label) | .pane_id' )"
  else
    existing="$(printf '%s' "$pane_list" | python3 -c 'import json,sys; label=sys.argv[1]; payload=json.load(sys.stdin); panes=payload.get("result", {}).get("panes", []); matches=[p.get("pane_id") for p in panes if p.get("label") == label and p.get("pane_id")]; print("\\n".join(m for m in matches if m))' "$target_label" 2>/dev/null || true)"
  fi

  if [[ -n "$existing" ]]; then
    if [[ -n "$target_pane_id" ]] && [[ $'\n'"$existing"$'\n' == *$'\n'"$target_pane_id"$'\n'* ]]; then
      if command -v jq >/dev/null 2>&1; then
        target_pane_id="$(printf '%s' "$pane_list" | jq -r --arg target "$target_pane_id" --arg label "$target_label" '.result.panes[] | select(.pane_id != $target and .label != $label) | .pane_id' | head -n1)"
      else
        target_pane_id="$(printf '%s' "$pane_list" | python3 -c 'import json,sys; target,label=sys.argv[1:3]; payload=json.load(sys.stdin); panes=payload.get("result", {}).get("panes", []); replacement=next((p.get("pane_id") for p in panes if p.get("pane_id") != target and p.get("label") != label and p.get("pane_id")), ""); print(replacement)' "$target_pane_id" "$target_label" 2>/dev/null || true)"
      fi
    fi
    while IFS= read -r pane_id; do
      [[ -z "$pane_id" ]] && continue
      "$herdr" pane close "$pane_id" >/dev/null 2>&1 || true
    done <<< "$existing"
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
  open_args+=(--placement overlay)
fi

"${open_args[@]}"
