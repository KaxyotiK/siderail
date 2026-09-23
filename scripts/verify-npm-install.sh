#!/bin/bash
# Proves the published install path end to end against one commit: pack it,
# install it globally into a private prefix, run `siderail setup` against a
# private Herdr session and cmux HOME, upgrade in place with a rail open, and
# uninstall without leaving a process behind. The operator's Herdr, cmux, and
# npm configuration are never read or written.
#
# Usage: scripts/verify-npm-install.sh [commit] [tarball-output-directory]
set -euo pipefail

repository_root=$(cd "$(dirname "$0")/.." && pwd -P)
commit=$(git -C "$repository_root" rev-parse --verify "${1:-HEAD}^{commit}")
tarball_output=${2:-}
if [[ -n $tarball_output && $tarball_output != /* ]]; then
  echo "tarball output directory must be absolute" >&2
  exit 64
fi
herdr_bin=${HERDR_BIN_PATH:-$(command -v herdr)}
root=$(cd "$(mktemp -d /tmp/srn.XXXXXX)" && pwd -P)
prefix="$root/prefix"
package_root="$prefix/lib/node_modules/siderail"
siderail="$prefix/bin/siderail"
server_pid=""

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
json() { local code=$1; shift; node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));$code" "$@"; }
panes() { "$herdr_bin" pane list; }
rail_in_tab() {
  panes | json 'const p=j.result.panes.find((p)=>p.tab_id===process.argv[1]&&p.label==="SIDERAIL");process.stdout.write(p?p.pane_id:"")' "$1"
}
pane_exists() { panes | json 'process.exit(j.result.panes.some((p)=>p.pane_id===process.argv[1])?0:1)' "$1"; }
rail_cwd() {
  "$herdr_bin" pane process-info --pane "$1" | json 'const f=j.result.process_info.foreground_processes.find((p)=>p.argv.includes("scripts/siderail.mjs")&&/node$/.test(p.argv[0]));process.stdout.write(f?f.cwd:"")'
}

cleanup() {
  set +e
  if [[ -n $server_pid ]]; then
    "$herdr_bin" session stop "$HERDR_SESSION" --json >/dev/null 2>&1
    wait "$server_pid" >/dev/null 2>&1
  fi
  pkill -f "$package_root/" >/dev/null 2>&1
  rm -rf -- "$root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

unset HERDR_ENV HERDR_WORKSPACE_ID HERDR_TAB_ID HERDR_PANE_ID HERDR_SOCKET_PATH HERDR_CLIENT_SOCKET_PATH
unset HERDR_PLUGIN_ID HERDR_PLUGIN_CONTEXT_JSON
while IFS= read -r variable; do unset "$variable"; done < <(compgen -e | grep '^SIDERAIL_' || true)
export HOME="$root/home"
export XDG_CONFIG_HOME="$root/c" XDG_CACHE_HOME="$root/k" XDG_STATE_HOME="$root/s" XDG_RUNTIME_DIR="$root/r"
export HERDR_SESSION="srn$$"
export npm_config_cache="$root/npm-cache" npm_config_userconfig="$root/npmrc"
export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$root/packages"
mkdir -m 700 "$XDG_RUNTIME_DIR"
: > "$root/npmrc"

step "pack $commit and a patch-bumped upgrade"
mkdir "$root/current" "$root/upgrade"
git -C "$repository_root" archive --format=tar "$commit" | tar -xf - -C "$root/current"
version=$(node -p 'require(process.argv[1]).version' "$root/current/package.json")
upgrade_version=$(node -p 'const [a,b,c]=process.argv[1].split(/[.-]/).map(Number);`${a}.${b}.${c+1}`' "$version")
(cd "$root/current" && npm pack --ignore-scripts --pack-destination "$root/packages" >/dev/null)
git -C "$repository_root" archive --format=tar "$commit" | tar -xf - -C "$root/upgrade"
node -e 'const fs=require("fs");const [file,version]=process.argv.slice(1);const p=JSON.parse(fs.readFileSync(file));p.version=version;fs.writeFileSync(file,JSON.stringify(p,null,2)+"\n")' \
  "$root/upgrade/package.json" "$upgrade_version"
sed -i.bak "s/^version = \"$version\"/version = \"$upgrade_version\"/" "$root/upgrade/herdr-plugin.toml"
rm "$root/upgrade/herdr-plugin.toml.bak"
(cd "$root/upgrade" && npm pack --ignore-scripts --pack-destination "$root/packages" >/dev/null)
tarball="$root/packages/siderail-$version.tgz"
tar -tzf "$tarball" | sed 's#^package/##' | sort > "$root/members.txt"
if grep -qE '^(test|reviews|work|release-evidence|coverage|node_modules)/|^\.' "$root/members.txt"; then
  fail "development files are in the package"
fi
for required in herdr-plugin.toml scripts/cli.mjs scripts/node-launcher.sh scripts/git-state-coordinator.mjs \
  scripts/temporary-copy-cleaner.mjs src/install-watch.mjs; do
  grep -qx "$required" "$root/members.txt" || fail "package is missing $required"
done
printf 'siderail-%s.tgz: %s files, sha256 %s\n' "$version" "$(wc -l < "$root/members.txt" | tr -d ' ')" \
  "$(shasum -a 256 "$tarball" | cut -d' ' -f1)"

step "install $version globally into a private prefix"
npm install -g --prefix "$prefix" "$tarball" >/dev/null
test "$("$siderail" --version)" = "$version" || fail "installed bin reports the wrong version"

step "start a private Herdr server"
"$herdr_bin" server >/dev/null 2>&1 &
server_pid=$!
for _ in $(seq 1 100); do "$herdr_bin" status server >/dev/null 2>&1 && break; sleep 0.1; done
"$herdr_bin" status server >/dev/null || fail "private Herdr server did not start"

step "siderail setup registers both hosts and keeps other Dock controls"
mkdir -p "$HOME/.config/cmux"
printf '{\n  "controls": [\n    { "id": "tests", "title": "Tests", "command": "npm test" }\n  ]\n}\n' > "$HOME/.config/cmux/dock.json"
"$siderail" setup herdr cmux
"$herdr_bin" plugin list --json | json 'const p=j.result.plugins.find((p)=>p.plugin_id==="siderail");process.exit(p&&p.plugin_root===process.argv[1]&&p.source.kind==="local"?0:1)' "$package_root" \
  || fail "Herdr is not linked to the npm install"
json 'const [first,second]=j.controls;process.exit(j.controls.length===2&&first.id==="tests"&&second.command===process.argv[1]?0:1)' \
  "/bin/bash '$package_root/scripts/cmux-node-launcher.sh' '$package_root/scripts/cmux-siderail.mjs'" \
  < "$HOME/.config/cmux/dock.json" || fail "Dock control was not merged as expected"
"$siderail" setup > "$root/second-setup.txt"
grep -q "already linked" "$root/second-setup.txt" && grep -q "already points" "$root/second-setup.txt" \
  || fail "a repeated setup changed a registration"
echo "repeated setup changed nothing"

step "the Dock launchers run the installed rail"
/bin/bash "$package_root/scripts/cmux-node-launcher.sh" "$package_root/scripts/siderail.mjs" \
  --demo --snapshot --width 40 --height 8 | grep -q "siderail-fixture" || fail "installed demo did not render"
echo "installed demo rendered through the cmux launcher"

step "a rail auto-opens in a Git workspace from the npm install"
repository="$root/repository"
mkdir "$repository"
git -C "$repository" init -q --initial-branch=main
git -C "$repository" -c user.name=SideRail -c user.email=siderail@example.invalid commit -q --allow-empty -m baseline
echo untracked > "$repository/untracked.txt"
created=$("$herdr_bin" workspace create --cwd "$repository" --label npm-install --no-focus)
tab=$(json 'process.stdout.write(j.result.tab.tab_id)' <<<"$created")
"$herdr_bin" tab focus "$tab" >/dev/null
rail=""
for _ in $(seq 1 150); do rail=$(rail_in_tab "$tab"); [[ -n $rail ]] && break; sleep 0.2; done
[[ -n $rail ]] || fail "the rail did not auto-open"
for _ in $(seq 1 50); do [[ $(rail_cwd "$rail") == "$package_root" ]] && break; sleep 0.2; done
[[ $(rail_cwd "$rail") == "$package_root" ]] || fail "the rail is not running from the npm install"
echo "rail $rail runs from $package_root"

step "upgrade to $upgrade_version in place while the rail is open"
npm install -g --prefix "$prefix" "$root/packages/siderail-$upgrade_version.tgz" >/dev/null
test "$("$siderail" --version)" = "$upgrade_version" || fail "the upgrade did not replace the install"
pane_exists "$rail" || fail "the open rail's pane closed during the upgrade"
restarted=""
for _ in $(seq 1 75); do
  if [[ $(rail_cwd "$rail") == "$package_root" ]]; then restarted=1; break; fi
  sleep 0.2
done
if [[ -z $restarted ]]; then
  "$herdr_bin" pane process-info --pane "$rail" >&2 || true
  ls -la "$prefix/lib/node_modules" >&2 || true
  fail "rail $rail did not restart onto the upgraded install"
fi
grep -q "plugin siderail $upgrade_version at this install" <<<"$("$siderail" status)" || fail "Herdr does not report the upgrade"
echo "rail $rail restarted in place on $upgrade_version"

step "toggle closes the upgraded rail and opens a new one"
"$herdr_bin" plugin action invoke siderail.toggle-siderail >/dev/null
for _ in $(seq 1 100); do pane_exists "$rail" || break; sleep 0.2; done
pane_exists "$rail" && fail "toggle did not close the upgraded rail"
"$herdr_bin" plugin action invoke siderail.toggle-siderail >/dev/null
reopened=""
for _ in $(seq 1 150); do reopened=$(rail_in_tab "$tab"); [[ -n $reopened ]] && break; sleep 0.2; done
[[ -n $reopened ]] || fail "toggle did not reopen the rail"
echo "rail reopened as $reopened"

step "a rail whose launcher alone is killed exits instead of lingering"
pids=$("$herdr_bin" pane process-info --pane "$reopened" | json '
  const f=j.result.process_info.foreground_processes;
  const launcher=f.find((p)=>p.argv.includes("scripts/node-launcher.sh"));
  const rail=f.find((p)=>/node$/.test(p.argv[0])&&p.argv.includes("scripts/siderail.mjs"));
  if(!launcher||!rail)process.exit(1);
  process.stdout.write(`${launcher.pid} ${rail.pid}`)') || fail "could not identify the rail's launcher and Node processes"
read -r launcher_pid rail_pid <<<"$pids"
kill -TERM "$launcher_pid"
for _ in $(seq 1 50); do kill -0 "$rail_pid" 2>/dev/null || break; sleep 0.2; done
if kill -0 "$rail_pid" 2>/dev/null; then fail "rail $rail_pid kept running after its launcher $launcher_pid was killed"; fi
echo "rail $rail_pid exited after its launcher $launcher_pid was killed"
"$herdr_bin" plugin action invoke siderail.toggle-siderail >/dev/null
reopened=""
for _ in $(seq 1 150); do reopened=$(rail_in_tab "$tab"); [[ -n $reopened ]] && break; sleep 0.2; done
[[ -n $reopened ]] || fail "toggle did not reopen the rail for uninstall"

step "siderail uninstall removes only this install's registrations"
"$siderail" uninstall
test "$("$herdr_bin" plugin list)" = "No plugins installed." || fail "the Herdr plugin is still linked"
json 'process.exit(j.controls.length===1&&j.controls[0].id==="tests"?0:1)' < "$HOME/.config/cmux/dock.json" \
  || fail "uninstall changed another Dock control"
for _ in $(seq 1 50); do pgrep -f "$package_root/" >/dev/null || break; sleep 0.2; done
if pgrep -fl "$package_root/"; then fail "processes from the install survived uninstall"; fi
echo "no process from the install remains"
npm uninstall -g --prefix "$prefix" siderail >/dev/null
test ! -e "$siderail" && test ! -e "$package_root" || fail "npm uninstall left files behind"

if [[ -n $tarball_output ]]; then
  mkdir -p "$tarball_output"
  cp "$tarball" "$tarball_output/"
  echo "kept $tarball_output/siderail-$version.tgz"
fi
printf '\nnpm install lifecycle passed for %s with %s, %s, npm %s\n' \
  "$commit" "$("$herdr_bin" --version)" "$(node --version)" "$(npm --version)"
