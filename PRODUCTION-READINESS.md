# Production readiness

This checklist maps each release guarantee to executable evidence. “Local pass”
means the implementation is verified in the development worktree; it is not a
claim that the Node/OS matrix, live Herdr walkthrough, or `v0.1.0` tag exists.

| ID | User-visible guarantee | Proof | Platform | Status |
| --- | --- | --- | --- | --- |
| B1 | Repository contents cannot configure GitRail or select executables | `test/config.test.mjs`, hostile-config case in `test/snapshot.test.mjs`, poisoned-environment CI | all | local pass |
| B2 | Tests cannot inherit ambient Herdr/GitRail state | `test/helpers/environment.mjs`, clean and poisoned CI jobs | macOS/Linux, Node 22/24 | local pass; CI required |
| B3 | A 20,000-path Files view styles/materializes only its viewport | production snapshot path in `test/snapshot.test.mjs` at 36/52/100 columns | all | local pass |
| B4 | Stale preview state never authorizes closing an unverified pane | `test/preview-pane-lifecycle.test.mjs` | Herdr 0.8+ | local pass |
| H1 | Git failures are distinct from ordinary non-Git directories | startup/failure snapshots in `test/snapshot.test.mjs` and `test/terminal-ui.test.mjs` | all | local pass |
| H2 | Automatic opening skips unsafe layouts; explicit rebuilds are journaled and recoverable | `test/herdr-panel.test.mjs`; live walkthrough steps 2 and 6 | Herdr 0.8+ | unit pass; live required |
| H3 | Fatal rail errors restore terminal modes and remove demo fixtures | fatal process case in `test/snapshot.test.mjs` | macOS/Linux | local pass |
| H4 | Worktree/shared Git metadata invalidates state, with a recovery-poll fallback | `test/git-watch.test.mjs`, scheduler tests in `test/terminal-ui.test.mjs`, live walkthrough step 7 | macOS/Linux | unit pass; live required |
| M1 | Staged, Unstaged, and Untracked are distinct and keyboard reachable | provider integration tests and 25/36/52/100-column snapshots | all | local pass |
| M2 | Preview replacement is scoped by workspace and source tab | `test/preview-pane-lifecycle.test.mjs`, live walkthrough step 5 | Herdr 0.8+ | unit pass; live required |
| M3 | Runtime validation is the sole config authority; `$schema` is rejected | `test/config.test.mjs`, `npm run artifact:verify` | all | local pass |
| M4 | Viewer keys accept only wildcard, suffix, or exact basename grammar | configuration validation/resolution cases in `test/config.test.mjs` | all | local pass |
| M5 | Every manifest entrypoint resolves an absolute Node 22+ executable first | `test/node-launcher.test.mjs`, `npm run artifact:verify` | macOS/Linux | local pass |
| M6 | Refresh promises eventual, not atomic, consistency and preserves usable state | provider/refresh tests plus README contract | all | local pass |
| M7 | Auto-open uses at most four workers and one 35-second deadline | bounded-sweep cases in `test/auto-open-herdr-tabs.test.mjs` | Herdr 0.8+ | local pass |
| M8 | Preview search normalizes once and retains at most 8 MiB of prefix candidates | `test/preview-search.test.mjs` including 100,000 lines | all | local pass |
| R1 | Raw, Diff, and Rendered use the selected descriptor and exact revision bytes | exact-revision cases in `test/integration.test.mjs` and `test/snapshot.test.mjs`; live walkthrough step 4 | release matrix | unit pass; live required |
| R2 | Inspection never changes HEAD, refs, index, or worktree content | before/after repository invariant cases in `test/integration.test.mjs`; live walkthrough step 8 | release matrix | unit pass; live required |
| R3 | Uninstall closes only currently verified GitRail pane instances and leaves no restored/event rail | `test/uninstall-herdr-plugin.test.mjs`; live uninstall cells | Herdr 0.8.x | unit pass; live required |
| L4 | Discarded promises, unused locals, and unused production exports fail lint | `npm run lint` (ESLint + Knip) | Node 22+ | local pass |
| L5 | Tests pass on macOS 15/Ubuntu 24.04 and Node 22/24 with 88/78/86 coverage floors | CI matrix and `npm run test:coverage` | matrix | candidate CI required |
| L6 | 36/52/100-column realistic states are recorded | `docs/screenshots/README.md`, live walkthrough step 8 | real Herdr | candidate assets required |
| L7 | Security policy has no fictional reporting channel or response promise | `SECURITY.md` review and documentation assertion | n/a | local pass |
| L2 | Candidate install, development migration, pane-state continuity, uninstall, artifact, and live behavior are bound to one SHA | `scripts/release-evidence.mjs`, `docs/RELEASING.md` matrix | release matrix | candidate validation required |

## Release gate

Run `npm ci --ignore-scripts`, `npm run check`, `npm run test:coverage`,
`npm run snapshot`, and `npm run artifact:verify` from the exact candidate SHA.
Then complete every automated and live cell in `docs/RELEASING.md`. The release
is ready to tag only when CI links, environment versions, screenshot source SHA,
and walkthrough results all name that candidate and the worktree remains clean.

The validated 0.1.0 release targets are Node.js 22 and 24, Git 2.35+, Herdr
0.8.x, macOS 15, and Ubuntu 24.04. The launcher accepts newer Node and Herdr
versions, but those combinations are not release-matrix claims.
The latest tagged release receives security fixes. GitRail does not stage,
discard, commit, push, pull, or otherwise mutate repository content.
