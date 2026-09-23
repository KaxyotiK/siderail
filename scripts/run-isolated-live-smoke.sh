#!/bin/bash
set -euo pipefail

candidate_root=$(cd "$(dirname "$0")/.." && pwd -P)
herdr_bin=${HERDR_BIN_PATH:-$(command -v herdr)}
node_bin=$(command -v node)
git_bin=$(command -v git)
node_major=$($node_bin -p 'process.versions.node.split(".")[0]')
case "$node_major" in
  22|24) ;;
  *) echo "isolated live smoke requires Node 22 or 24 (running $($node_bin --version))" >&2; exit 1 ;;
esac
release_root=$(mktemp -d "/tmp/grl.XXXXXX")
release_bin="$release_root/b"
server_pid=""

cleanup() {
  set +e
  if [[ -n ${HERDR_SESSION:-} ]]; then
    "$herdr_bin" plugin unlink siderail >/dev/null 2>&1
    "$herdr_bin" session stop "$HERDR_SESSION" --json >/dev/null 2>&1
  fi
  if [[ -n $server_pid ]]; then wait "$server_pid" >/dev/null 2>&1; fi
  rm -rf -- "$release_root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

unset HERDR_ENV HERDR_WORKSPACE_ID HERDR_TAB_ID HERDR_PANE_ID
unset HERDR_SOCKET_PATH HERDR_CLIENT_SOCKET_PATH
mkdir -p "$release_bin"
ln -s "$git_bin" "$release_bin/git"
ln -s "$node_bin" "$release_bin/node"
ln -s "$herdr_bin" "$release_bin/herdr"
ln -s /bin/bash "$release_bin/bash"
ln -s "$(command -v dirname)" "$release_bin/dirname"
export HERDR_BIN_PATH=$herdr_bin
export SIDERAIL_NODE_PATH=$node_bin
export SIDERAIL_LIVE_GIT_SHIM="$release_bin/git"
export SIDERAIL_POLL_INTERVAL_MS=1000

start_server() {
  env PATH="$release_bin" "$herdr_bin" server &
  server_pid=$!
  for _ in $(seq 1 100); do
    if "$herdr_bin" status server >/dev/null 2>&1; then return; fi
    sleep 0.1
  done
  return 1
}

stop_server() {
  "$herdr_bin" session stop "$HERDR_SESSION" --json
  wait "$server_pid"
  server_pid=""
}

verify_coordinator_cleanup() {
  "$node_bin" --input-type=module - "$SIDERAIL_PERFORMANCE_LOG" "$XDG_RUNTIME_DIR" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [log, root] = process.argv.slice(2);
const entries = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const owners = entries.filter((entry) => entry.event === 'component' && entry.role === 'coordinator' && entry.phase === 'started');
if (!owners.length) throw new Error('isolated live smoke did not exercise the shared coordinator');
const deadline = Date.now() + 5000;
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }
function runtimeFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? runtimeFiles(file) : [file];
  });
}
while (owners.some((owner) => alive(owner.pid)) || runtimeFiles(path.join(root, 'siderail')).length) {
  if (Date.now() >= deadline) throw new Error('candidate coordinator process or owned socket/lease survived uninstall');
  await new Promise((resolve) => setTimeout(resolve, 50));
}
console.log(`Verified cleanup of ${new Set(owners.map((owner) => owner.pid)).size} candidate coordinator(s)`);
NODE
}

for watch_mode in watch-only poll-only; do
  if [[ $watch_mode = watch-only ]]; then mode_key=w; else mode_key=p; fi
  mode_root="$release_root/$mode_key"
  export XDG_CONFIG_HOME="$mode_root/c"
  export XDG_CACHE_HOME="$mode_root/k"
  export XDG_STATE_HOME="$mode_root/s"
  export XDG_RUNTIME_DIR="$mode_root/r"
  export SIDERAIL_PERFORMANCE_LOG="$mode_root/components.jsonl"
  export HERDR_SESSION="gr${mode_key}${$}"
  export SIDERAIL_WATCH_MODE=$watch_mode
  mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
  mkdir -m 700 "$XDG_RUNTIME_DIR"

  start_server
  "$herdr_bin" plugin link "$candidate_root"
  (cd "$candidate_root" && env PATH="$release_bin" "$node_bin" scripts/live-herdr-smoke.mjs)
  (cd "$candidate_root" && env PATH="$release_bin" /bin/bash scripts/node-launcher.sh scripts/uninstall-herdr-plugin.mjs)
  test "$("$herdr_bin" plugin list)" = "No plugins installed."
  verify_coordinator_cleanup
  stop_server

  start_server
  test "$("$herdr_bin" plugin list)" = "No plugins installed."
  unlink_proof=$("$herdr_bin" workspace create --cwd "$candidate_root" --label "SideRail unlink proof" --no-focus)
  unlink_tab=$("$node_bin" -e 'const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).result.tab.tab_id)' <<<"$unlink_proof")
  sleep 1
  panes=$("$herdr_bin" pane list)
  "$node_bin" -e 'const fs=require("node:fs");const [tab]=process.argv.slice(1);const panes=JSON.parse(fs.readFileSync(0,"utf8")).result.panes;if(panes.some((pane)=>pane.tab_id===tab&&["SIDERAIL","HERDR GITRAIL"].includes(pane.label)))process.exit(1)' "$unlink_tab" <<<"$panes"
  stop_server
done

printf 'isolated live smoke passed with %s and %s\n' \
  "$($herdr_bin --version)" "$($node_bin --version)"
