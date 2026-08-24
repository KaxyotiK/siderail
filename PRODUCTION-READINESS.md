# Production readiness

This checklist maps each release guarantee to executable evidence. “Local pass”
means the implementation is verified in the development worktree; it does not
claim that all eight candidate evidence cells or the `v0.1.0` tag exist. This
repository does not use GitHub Actions.

| ID | User-visible guarantee | Proof | Platform | Status |
| --- | --- | --- | --- | --- |
| B1 | Repository contents cannot configure GitRail or select executables | `test/config.test.mjs`, hostile-config case in `test/snapshot.test.mjs`, poisoned-environment local gate | all | local pass |
| B2 | Tests cannot inherit ambient Herdr/GitRail state | `test/helpers/environment.mjs`, clean and poisoned local checks | macOS/Linux, Node 22/24 | local pass |
| B3 | A 20,000-path Files view styles/materializes only its viewport | production snapshot path in `test/snapshot.test.mjs` at 36/52/100 columns | all | local pass |
| B4 | Stale preview state never authorizes closing an unverified pane | `test/preview-pane-lifecycle.test.mjs` | Herdr 0.8.x | local pass |
| H1 | Git failures are distinct from ordinary non-Git directories | startup/failure snapshots in `test/snapshot.test.mjs` and `test/terminal-ui.test.mjs` | all | local pass |
| H2 | Automatic and explicit opening never reconstruct user layouts; unsafe outer-right splits are skipped without pane mutation | automatic/manual unsafe-layout cases in `test/herdr-panel.test.mjs`; isolated live smoke | Herdr 0.8.x | local pass; candidate live required |
| H3 | Fatal rail errors restore terminal modes and remove demo fixtures | fatal process case in `test/snapshot.test.mjs` | macOS/Linux | local pass |
| H4 | Worktree/shared Git metadata invalidates state, with a recovery-poll fallback | `test/git-watch.test.mjs`, scheduler tests in `test/terminal-ui.test.mjs`, isolated watch/poll smoke | macOS/Linux | unit pass; live required |
| M1 | Staged, Unstaged, and Untracked are distinct and keyboard reachable | provider integration tests and 25/36/52/100-column snapshots | all | local pass |
| M2 | Preview replacement is scoped by workspace and source tab | `test/preview-pane-lifecycle.test.mjs`, isolated live smoke | Herdr 0.8.x | unit pass; live required |
| M3 | Runtime validation is the sole config authority; `$schema` is rejected | `test/config.test.mjs`, `npm run artifact:verify` | all | local pass |
| M4 | Viewer keys accept only wildcard, suffix, or exact basename grammar | configuration validation/resolution cases in `test/config.test.mjs` | all | local pass |
| M5 | Every manifest entrypoint resolves an absolute Node 22+ executable first | `test/node-launcher.test.mjs`, `npm run artifact:verify` | macOS/Linux | local pass |
| M6 | Refresh promises eventual, not atomic, consistency and preserves usable state | provider/refresh tests plus README contract | all | local pass |
| M7 | Auto-open uses at most four workers and one 35-second deadline | bounded-sweep cases in `test/auto-open-herdr-tabs.test.mjs` | Herdr 0.8.x | local pass |
| M8 | Preview search normalizes once, retains at most 8 MiB of prefix matches, and returns cached display positions without another position pass | `test/preview-search.test.mjs` including cached positions and 100,000 lines | all | local pass |
| R1 | Raw, Diff, and the action-3 Glow TUI use the selected descriptor and exact revision bytes | exact-revision unit cases and isolated live smoke | macOS/Linux | unit pass; live required |
| R2 | Inspection never changes HEAD, refs, index, or worktree content | before/after repository invariant cases and isolated live smoke | macOS/Linux | unit pass; live required |
| R3 | Uninstall closes only currently verified GitRail pane instances and leaves no restored/event rail | `test/uninstall-herdr-plugin.test.mjs`; isolated live smoke | Herdr 0.8.x | unit pass; live required |
| L4 | `void` expressions, unused locals, and unused production exports fail lint; interactive async actions use explicit visible-error boundaries | `npm run lint` (ESLint + Knip), `reportAsync` action paths | Node 22+ | local pass |
| L5 | Node 22/24 checks enforce 95/86/95 coverage floors; exact archive, poisoned environment, and dependency audit are local gates | `npm run check`, `docs/RELEASING.md` | macOS/Linux | gates implemented; candidate runs required |
| L6 | 36/52/100-column PNG bytes match the capture-source commit and candidate output matches the visual-source commit | `npm run screenshots:verify`, `docs/screenshots/README.md` | real Herdr | local pass |
| L7 | Security policy has no fictional reporting channel or response promise | `SECURITY.md` review and documentation assertion | n/a | local pass |
| L2 | Candidate checks, artifact, live behavior, uninstall, and screenshots are bound to one SHA and retained as hashed logs | `scripts/release-evidence.mjs`, `docs/RELEASING.md` eight-cell contract | macOS/Linux | candidate validation required |

## Release gate

Run `npm ci --ignore-scripts`, `npm run check`, `npm run snapshot`, and
`npm run artifact:verify` from the exact candidate SHA under Node 22 and Node 24.
Then complete all eight local cells in `docs/RELEASING.md`. The release is ready
to tag only when the hashed logs, environment versions, visual/capture source SHAs,
and isolated walkthrough results name that candidate and the worktree remains
clean.

The 0.1.0 release targets Node.js 22 and 24, Git 2.35+, Herdr 0.8.x, macOS, and
Linux. The latest tagged release receives security fixes. GitRail does not
stage, discard, commit, push, pull, or otherwise mutate repository content.
