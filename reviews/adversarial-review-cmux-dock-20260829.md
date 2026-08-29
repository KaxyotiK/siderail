# Adversarial review loop: cmux Dock integration

- Review identity: `cmux-dock-production-integration`
- Resolved target: the 20 modified/untracked cmux GitRail implementation, documentation, configuration, and test files present before this report was created
- Scope boundary: existing cmux right-Dock integration only; Herdr behavior and external cmux checkout remain out of mutation scope
- User authorization: fix clear P0-P2 bugs in scope, perform the original capped review loop, then perform one focused follow-up lifecycle/input correction authorized on 2026-08-29; do not increase scope or commit
- Gate: P2 by explicit user instruction
- Round limit: 3 total passes (initial read-only pass plus at most 2 additional rounds)
- Consumed rounds: 3
- Execution authorization: trusted local tests and proportionate live cmux verification; no external cmux source changes
- Reviewer assignments: architecture, UX/UI, implementation
- Initial target fingerprint: `8b38468f7bd849abfd695f0c6a86c0e12da2532a9d16093c4d1cb889bd6ac75f`
- Durable state: `fixed`
- Current round: 3
- Current target fingerprint: `091a0d560c0cdc41f31f31aab814f2a754621127b111e4b5374ba62c40057c77`

## Coverage and limitations

The initial pass inspected all target files, current cmux Dock/CLI source and docs, the supplied screenshots, and the running cmux topology. Full automated verification passed before review. A distinct workflow reviewer was omitted under the three-reviewer default; workflow traces were covered by implementation and UX/UI. Multi-window focus mutation was not performed during the read-only pass.

## Findings

### F1 — focused-window context can cross cmux windows

- Severity: P1
- State: fixed in round 2
- Evidence: `src/cmux-context.mjs` derives the window only from `identify.focused`; current cmux distinguishes caller/focused and a Dock caller can be null.
- Intended fix: capture a stable owner window at launch/first resolution, target subsequent identify/current-workspace calls to that window, and refresh context at preview action time.
- Regression witness: caller/owner window A with global focus in window B must resolve/open in A.

### F2 — configured-control identity is not active-instance identity

- Severity: P1
- State: fixed in focused follow-up
- Evidence: configured controls expose a generated `/tmp/cmux-dock-control-*.sh` initial command, not the GitRail entrypoint substring used by adoption.
- Round-3 result: stable registration distinguishes a running configured GitRail control from unrelated controls, but the record is neither refreshed when the selected workspace changes nor invalidated when `q` leaves the Dock surface at its login shell. The launcher can therefore duplicate the configured control after a workspace switch or adopt a post-`q` shell without relaunching GitRail.
- Required witnesses: configured GitRail registered in workspace A then selected from workspace B must not duplicate; a registered surface left at the post-`q` login shell must relaunch GitRail rather than report it already open.

### F3 — preview lifecycle loses old generations

- Severity: P1
- State: fixed in round 3
- Evidence: state is keyed by ephemeral Dock surface id and overwritten before stale cleanup; live cache inspection confirmed an absent old surface with a retained materialization.
- Intended fix: key by stable workspace/control identity, retain pending stale generations across failures, retry verified cleanup, and keep actual owner surface id only as record metadata.
- Regression witnesses: owner-surface rotation and transient-cleanup retry must close/remove every verified stale generation.

### F4 — native viewer obscures selected revision identity

- Severity: P1
- State: fixed in round 3
- Evidence: cmux displays the cache materialization path and editing affordances; the tab/path has no staged, unstaged, commit, or read-only identity.
- Intended fix: give materialization directories and native tab titles explicit read-only revision labels while preserving the original extension and exact bytes.
- Regression witness: changed/native preview title and materialized path must contain the selected revision label.

### F5 — intervening controls do not cancel pending double-click

- Severity: P2
- State: fixed in focused follow-up
- Evidence: the click tracker is invoked only for targets with a double action.
- Round-3 result: non-file and blank primary clicks reset correctly, but intervening wheel or keyboard input does not reset the pending click sequence.
- Required witness: file A, wheel/key input, file A within 700 ms must not open.

### F6 — direct-launch `q` close behavior contradicts documentation

- Severity: P2
- State: fixed in round 2
- Evidence: live direct-launched Dock surface disappeared after `q`, while docs promise a login shell.
- Intended fix: have direct launch request a stay-open shell contract in the cmux bootstrap and test it; keep configured-control wrapper behavior unchanged.

### F7 — preview action can use stale context

- Severity: P2
- State: fixed in round 2
- Evidence: `openPreview` uses context cached by periodic refresh.
- Intended fix: resolve the stable-window context immediately before a cmux open and retry only through the newly resolved explicit target.

### F8 — click/accessibility and pending-operation feedback

- Severity: P2
- State: fixed in focused follow-up
- Round-3 result: ordinary file opens show `Opening…` before cmux context lookup and refresh results are truthful, but an unloaded commit-search result still awaits commit enrichment before showing pending feedback. The system double-click preference has no supported terminal/cmux API in the target, so the tested 700 ms compatibility interval remains documented.

## Mutation log

- Round 2 fixing intent persisted before code mutation.
- Round 2 mutation batch 1 completed: stable owner-window context, action-time context refresh, stable control-keyed preview registry with retained cleanup retries, revision-labelled native previews, and click-sequence reset coverage. Verification is pending at fingerprint `0b308df313337e123449260b86495b4dad241bb51991ea7a30708c4098a4a313`.
- Focused verification at that fingerprint passed 39/43 tests. Four lifecycle assertions require migration to the new return/state/rename contract; inspection also confirmed the tab-title argument must be positional. Round 2 is back in `fixing` for those corrections and the previously recorded launcher/stay-open fixes.
- Round 2 mutation batch 2 completed: migrated lifecycle assertions, added control-rotation and multi-generation retry witnesses, made direct launch fail closed around unidentified configured wrappers, propagated owner-window/stay-open launch identity, added direct-launch login-shell behavior, and documented the bounded contracts. External cmux source inspection showed `rename-tab --title` remains supported despite the synopsis preferring a positional title, so no command change was needed. Verification is pending at fingerprint `4478b5885d0cd183ca52c424f7e6e108c4787c38e9a3519020e94f78e92274a6`.
- Round 2 verification: focused cmux suite passed 65/65. The first full check had one load-sensitive PTY timeout; that witness passed alone in 448 ms, and the complete rerun passed 240 with one intentional skip at 96.12% line, 86.23% branch, and 95.74% function coverage. JSON validation and `git diff --check` passed.
- Round 2 read-only re-review: architecture, implementation, and UX/UI reviewers inspected the bounded fixes and ran 57 focused tests. F1, future-generation F3 handling, F5 control-click handling, F6, and F7 were refuted as fixed. Surviving verified findings are: existing surface-keyed preview records are not migrated (P1/F3); native labels can describe selection scope instead of actual displayed bytes, especially deletion fallbacks (P1/F4); unrelated configured wrappers block the direct launch recovery path (P1/F2 by architecture, P2 by the other reviewers); blank-space clicks do not reset click state (P2/F5); `Opening…` begins after context discovery and refresh success can be overstated (P2/F8); the reachable legend does not explain Unstaged versus Untracked (P2).
- Round 3 fixing intent: migrate validated legacy cmux preview records into the stable registry; label previews with both selection scope and actual raw revision; use a stable GitRail control registration to adopt configured controls without blocking unrelated wrappers; reset on blank primary clicks; show pending feedback before context lookup and report refresh truthfully; add the concise Git-state legend explanation. These are bug fixes within the original target and do not alter Herdr semantics.
- Round 3 mutation completed at fingerprint `830297331d96f49e19f193682f53584d2f867e9a62fc9c4209de8312f5026896`: added owner-only control registration and live verification for de-duplication, legacy preview-state migration, actual-byte revision labels and deletion witnesses, blank-click reset, pre-discovery opening feedback, truthful refresh results, and the Unstaged/Untracked help text. Syntax, shell parsing, and diff whitespace checks passed; test verification is pending.
- Round 3 focused verification passed 99/100. The only failure was the new help witness requiring full prose at a 36-column viewport even though the renderer correctly ellipsizes it; production behavior was correct and the test assertion needs to match the visible compact text.
- The help copy was compacted to fit the 36-column Dock (`Unstaged: tracked change not staged`; `Untracked: not added to Git`) and its witness updated. Verification is pending at fingerprint `894cdd52774b6279ba32b12aaa9d2649a5d5d05617f8d3837d15202f640d86f0`.
- Focused verification then passed 100/100. The full suite passed all 248 executable tests with one intentional skip, but the coverage gate failed at 85.73% branches versus the required 86% after adding defensive registration/migration branches. Round 3 is back in `fixing` only to add negative-path witnesses for those branches.
- Added incomplete, absent, malformed, and mismatched control-registration witnesses. Verification is pending at fingerprint `94c4610aa5091c8e8394090d9bcaecc9a90154412657677e6e0a947861c0f513`.
- The full suite again passed every executable test (249/249, one intentional skip); branch coverage improved to 85.86% but remains 0.14 points below the gate. Final test-only correction will exercise unreadable legacy ownership and cleanup-state rewrite failure.
- Added the two lifecycle recovery witnesses. Verification is pending at fingerprint `a1e9945c502ee9a14a4196350556b912d184f27718a83b689bb1c3013ed34df9`.
- The full suite passed all 251 executable tests with one intentional skip, but branch coverage reached only 85.87% versus the 86% gate. Round 3 remains in `fixing` for a final test-only witness expansion across the already-implemented revision-label branches; production behavior is unchanged.
- Added revision-identity witnesses for unstaged, untracked, against-base, selected-commit, and filesystem bytes. Verification is pending at fingerprint `efe2c6abdd64bdd6b1f2a064c790ffe0ea76269c85111f4415243e152305ea10`.
- Round 3 verification passed: 257 executable tests passed with one intentional skip; coverage was 96.12% lines, 86.28% branches, and 95.87% functions. Dock JSON validation and `git diff --check` also passed. The mandatory final read-only re-review is pending.
- Round 3 read-only re-review: architecture, implementation, and UX/UI reviewers inspected the bounded final target and ran focused suites (up to 102 tests per profile) without live cmux mutation. Legacy migration, actual-byte revision identity, blank-click reset, ordinary pending feedback, truthful refresh feedback, help wording, native same-pane tab placement, host separation, and Herdr preservation survived review.
- Surviving P1, independently reproduced by the main agent: the stable registration models surface provenance but not active GitRail liveness. A registration retained for a post-`q` login-shell surface produces `{created:false}` with no relaunch action. Registration is also written only at startup; after the main workspace changes, an opaque configured GitRail surface lacks registration under the new workspace and the launcher calls `surface.create`, duplicating it.
- Surviving P2 findings: an opaque configured control can still race direct launch before its first registration; wheel or keyboard input does not reset a pending double click; commit-search placeholder enrichment precedes `Opening…`; and a partial native-open response containing `surface_id` without `panel_type` removes its materialization but cannot compensate the newly opened tab.
- No P0 survived. No additional mutation was made because the three-round cap was reached; the remaining P1/P2 findings are recorded for explicit follow-up rather than silently expanding the loop.

## Stop reason

The original three-round loop stopped at its cap with open findings. The separately authorized focused follow-up fixed every recorded P1/P2 and passed the full automated gate. Live cmux lifecycle validation remains pending because this agent process has no caller cmux identity and the installed CLI rejected topology access; no socket or credential guessing was attempted.

## Focused follow-up authorization

The user explicitly authorized the focused follow-up on 2026-08-29. Intended mutation: replace surface-presence-as-liveness with process-backed active registration, discover registrations by live surface across workspace changes, reuse a verified post-`q` shell for relaunch, register before context discovery, reset click state on wheel/keyboard input, show pending feedback before commit enrichment, and compensate partial native-open responses. Target and product scope remain unchanged; verification is pending.

Focused mutation completed at fingerprint `091a0d560c0cdc41f31f31aab814f2a754621127b111e4b5374ba62c40057c77`: registration v2 records process/instance liveness before context discovery and on workspace refresh; discovery matches a live Dock surface across workspace-keyed records; the launcher waits for startup registration and sends the guarded GitRail command into a verified inactive post-`q` shell; wheel/keyboard interruption, pre-enrichment pending feedback, and partial-native-open compensation are implemented with regression witnesses. Syntax, shell parsing, and diff whitespace checks passed; the completed focused and full verification is recorded below.

Focused verification passed: 103 targeted tests and lint passed, followed by the full `npm run check` gate with 264 executable tests passing and one intentional skip. Coverage was 95.90% lines, 86.06% branches, and 95.64% functions. Dock JSON validation, installed cmux `send`/`send-key` help validation, and `git diff --check` passed. The previously open startup race, post-`q` liveness, cross-workspace adoption, wheel/keyboard sequence, pre-enrichment feedback, and partial-open compensation findings are fixed by fake-cmux regression witnesses. Live topology inspection was attempted read-only with `/Applications/cmux.app/Contents/Resources/bin/cmux`, but cmux returned `Access denied - only processes started inside cmux can connect` because this process has no `CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID`, `CMUX_SOCKET_PATH`, or bundled CLI context.
