# Adversarial review: entire GitRail program

## Run identity

- Target: the complete tracked GitRail program at `/Users/user/Projects/grove/repos/herdr-gitrail`, including runtime code, plugin manifest, configuration, tests, scripts, and active documentation.
- Target rationale: the user explicitly requested review of “the entire program.”
- Initial fingerprint: clean `main` at `6c05bd2ca6978ad54980860430fdbfcb17434e87`.
- Mode: loop.
- Gate: P1.
- Round limit: 3.
- Rounds consumed: 2.
- Execution authorization: trusted local tests and isolated reproductions are authorized; reviewers remain read-only.
- Mutation authorization: fix verified P0/P1 bugs plus the concrete P2 corrections separately approved on resume, using low-risk changes that preserve existing scope. No feature additions, broad structural refactor, destructive change, golden re-signing, commit, or push.
- Exact user approval: “review-adversarial-global on the entire program - loop up to 3 times, fixes bugs but not increasing scope”.
- Resume approval: “fix remaining issues”, accepting the previously recommended 15-minute owner-only retention policy and authorizing concrete P2 corrections.
- Durable report: `reviews/adversarial-review-entire-program-20260825.md`.

## Reviewer assignments

1. Architecture — entire program; trace core repository/file descriptor, pane ownership, configuration, and lifecycle boundaries for structural violations.
2. Workflow — entire program; trace install/link, auto-open/toggle, preview, refresh/failure recovery, and uninstall/release workflows end to end.
3. Implementation — entire program; inspect correctness, contracts, security, concurrency, performance, cleanup, and regression witnesses.

Shared reviewer contract: `reviewer-core.md`. Each reviewer receives exactly its named profile.

## Findings

### P1 gate findings

1. **F1 — fixed and re-reviewed — Manual Open closes an existing verified rail before discovering that an outer-right replacement is unsafe.**
   - Evidence: `scripts/open-herdr-panel.mjs` closes at the current replacement block before computing `canSplitAtOuterRight`; both architecture and workflow reviewers executed the nested-layout reproduction and observed a close with no open.
   - Intended fix: preflight the replacement layout before any close and retain the existing rail when the split is unsafe; add the missing regression.
2. **F2 — fixed and re-reviewed — Git machine output is decoded lossily, collapsing distinct valid Linux filenames containing non-UTF-8 bytes.**
   - Evidence: implementation reviewer reproduced two tracked byte paths (`80 2e 74 78 74` and `81 2e 74 78 74`) becoming one `�.txt` identity through `runCommand` → `gitText` → `parseLsFilesStageZ` → `Set`.
   - Intended fix: add strict UTF-8 process decoding and require it for Git provider machine/text metadata, failing visibly instead of merging path identities; add strict-decoder and Linux provider witnesses.
3. **F3 — fixed and re-reviewed — An unrelated configured base is substituted for a nonexistent merge base.**
   - Evidence: `workspaceState` uses `.trim() || baseRef` and suppresses `git merge-base` failure. The implementation reviewer reproduced an unrelated ref reported as `workspaceDescriptor.mergeBase` with no error.
   - Intended fix: return an explicit state/configuration error with no merge-base-derived sections when the valid base commit has no common ancestor; add an unrelated-history regression.
4. **F4 — fixed and re-reviewed — Preview creation followed by ownership-state write failure leaves the new pane open and untracked.**
   - Evidence: workflow reviewer injected a post-open `EACCES`; `openOwnedPreview` rejected after opening, issued no compensating close, and preserved state pointing to the old preview.
   - Intended fix: compensate a failed atomic state write by closing the just-opened plugin pane, preserve old state, surface cleanup failure if any, and add the regression witness.
   - Post-fix objection: the first compensation used the ownership-preconditioned fallback without re-proving ownership of the pane ID returned by a malformed open response. An implementation reproduction reached generic `pane close` for a foreign user pane.
   - Corrective intent: re-run the full preview pane instance/workspace/label/terminal/process ownership proof before compensation. If proof fails, report the orphan risk and perform no close.
5. **F5 — fixed and re-reviewed — Ownership-verified panes orphaned by raw plugin unlink cannot be closed after relink.**
   - Evidence: root reproduced with isolated Herdr 0.8.2: after raw unlink/relink, `plugin pane close` returned `plugin_pane_not_found`, `pane get` still found the pane, and generic `pane close` succeeded. This is the reported toggle failure class.
   - Intended fix: centralize an ownership-preconditioned close helper that falls back to generic close only for the exact `plugin_pane_not_found` code; use it in rail, preview, and uninstall cleanup and add regressions.
6. **F6 — fixed and re-reviewed — Detached external viewers can outlive exact-revision temporary copies owned by the preview process.**
   - Evidence: `file-preview.mjs` detaches/unrefs external viewers while preview cleanup recursively removes all materialized historical/staged copies immediately on exit. A delayed consumer can receive `ENOENT`.
   - Approved fix: transfer owner-only GitRail temporary directories used by detached external viewers to a detached Node cleanup process for 15 minutes, then remove them. Normal preview-owned copies retain immediate cleanup.
7. **F7 — fixed and re-reviewed — Safe replacement still closes a working rail before replacement creation succeeds.**
   - Evidence: architecture re-review injected failure from `plugin pane open` after a safe preflight and observed the verified existing rail close first, leaving no rail.
   - Intended fix: open and validate the replacement first; close the verified old rail only after the new pane is owned, and compensate the new pane if old-pane closure fails.
8. **F8 — fixed and re-reviewed — Per-copy detached Node cleaners make retention resource use grow linearly.**
   - Evidence: architecture re-review launched 12 retained copies and measured 12 cleaner processes using 513,360 KiB RSS in aggregate.
   - Intended fix: mark retained owner-only directories on disk and use at most one shared cleanup worker for the retention namespace.
9. **F9 — fixed and re-reviewed — The local release runbook requires both live platform cells but only permits one platform shell.**
   - Evidence: workflow re-review traced the eight-cell verifier against the single-shell runbook. One `uname` branch records only macOS or Linux, and no cross-host evidence handoff exists, so the documented procedure cannot seal all required cells.
   - Intended fix: keep manifest mutation in the coordinator shell, document immutable-candidate worker blocks on both platforms, transfer their log and captured metadata to the coordinator, and record both cells there.
10. **F10 — fixed and re-reviewed — The shared cleaner's in-directory deadline marker can overwrite selected repository bytes.**
   - Evidence: workflow corrective review selected a historical file literally named `.herdr-gitrail-retain-until`; retention replaced its copied contents with the numeric deadline before the detached viewer could read it.
   - Intended fix: move cleanup metadata into an owner-only shared registry outside every payload directory and add the exact hostile-basename witness.
11. **F11 — fixed and re-reviewed — Legacy-label migration closes the old verified rail before replacement open.**
   - Evidence: architecture corrective review injected open failure with a verified `Grove Git Rail` pane and observed legacy close before the failing open. Legacy-only rails were not added to the deferred replacement set.
   - Intended fix: defer verified legacy-only rail closure until the new current-label pane is opened and validated, using the same compensation ordering as current-label replacement.

### P1 proposals independently refuted or downgraded

1. **Release-cell checkout binding — downgraded to P2.** The evidence format authenticates operator-produced logs; it is not a trusted-build attestation and an operator able to change and restore the checkout can also fabricate the log. Several command blocks should add consistent pre/post clean-SHA guards, but the malicious/restored-checkout argument cannot be solved by the claimed local evidence boundary without redesigning the release model.

### P2 advisories

- **Fixed:** documentation aligns Node runtime support (`>=22`) with the implementation while retaining the Node 22/24 release-validation statement.
- **Not changing:** pane identity metadata centralization is a structural refactor, not a demonstrated runtime defect.
- **Not changing:** retrying forgotten stale-preview cleanup requires expanding the persisted ownership model; this is outside the no-scope-increase boundary.
- **Fixed:** asynchronous `fs.watch` errors are handled and degraded to the already-running recovery poll rather than reaching an uncaught error path.
- **Fixed:** local release blocks consistently repeat pre/post candidate-SHA and clean-worktree guards.
- **Fixed:** strict UTF-8 decoding is limited to identity-bearing Git machine output so malformed display-only commit metadata cannot fail the whole refresh.

## Coverage and limitations

- Architecture traced descriptor creation/consumption, pane discovery/ownership/state/replacement, and configuration consumers.
- Workflow traced install/link/upgrade, startup/events, concurrency/locks, open/ensure/toggle, refresh/recovery, preview replacement/viewers, uninstall, and release/seal/tag paths.
- Implementation inspected all `src` modules, runtime and release scripts, manifest/configuration, tests, and active documentation; it ran 187 tests plus isolated Git/Linux reproductions.
- Root independently confirmed the stale-plugin-pane failure against isolated Herdr 0.8.2 and re-read every proposed P1 path.
- No destructive action was run against the user's Herdr session. Linux Herdr UI integration and the full two-platform release matrix were not rerun in round 1.

## Mutation log

### Round 2 — fixing

- Pre-mutation fingerprint: base `6c05bd2ca6978ad54980860430fdbfcb17434e87` plus program diff SHA-256 `ae9a9dba44e8ac0a7d9012fcfe1b6ad5f2d2ebe390b4c21ccd7306c226ef1d0a`.
- Exact outcome-boundary approval: keep external exact-revision Open/viewer behavior, retain its private copy for 15 minutes after handoff, then delete it automatically.
- Separately approved low-risk P2 corrections: Node support wording, watcher error handling, release-block guards, and strict-decoding scope.
- Explicitly excluded as scope-expanding refactors: pane identity centralization and multi-pane stale-preview persistence/retry.

### Round 2 — verification pending

- Post-mutation fingerprint: base `6c05bd2ca6978ad54980860430fdbfcb17434e87` plus program diff SHA-256 `d2ed9c74130ca5616e1736442c3ac60478fe277d19b917b004ce3697e7a763a2` (tracked binary diff plus path/content hashes for untracked program files; the durable report is excluded).
- F6 now transfers only GitRail-namespaced temporary directories handed to detached external clients to a detached Node cleaner. The owner-only copy remains for 15 minutes and normal preview-owned copies retain immediate cleanup.
- Git path-bearing machine output remains fatal-strict UTF-8, while display-only commit metadata uses the ordinary decoder and cannot abort refresh.
- Asynchronous watcher errors are caught, the failed watcher is closed and removed, and ordinary mode continues through the existing recovery poll.
- Every local release evidence block now checks a clean exact candidate checkout both before and after its validation command; README runtime support matches the `>=22` engine while release validation remains Node 22/24.
- Corrective fingerprint after removing an unintended public export caught by Knip: base `6c05bd2ca6978ad54980860430fdbfcb17434e87` plus program diff SHA-256 `e4c159942973151b5e524121c4dc13a0525eea787e2ca6fbeb2f572cdc67ef4e`.
- Local verification: 198 passed, 1 Linux-only skip; coverage 95.91% lines / 86.66% branches / 95.28% functions. Lint, whitespace, manifest artifact verification, and the deterministic snapshot pass.

### Round 2 — adversarial re-review failed

- Implementation review found no P0/P1 regression and independently passed focused macOS/Linux tests plus Bash syntax validation. Its cleaner-spawn-error P2 was corrected with an explicit listener, visible status, and hostile event witness.
- Architecture review confirmed F2–F5 but established F7 and F8 with executable reproductions; the P1 gate therefore remains closed.
- Pre-correction fingerprint: base `6c05bd2ca6978ad54980860430fdbfcb17434e87` plus program diff SHA-256 `676b6c36e9b2a68c76c4ed24f94013e986133bcbb9b3e8d4ab8866fffdbf2de4`.

### Round 2 — corrective verification pending

- Post-correction fingerprint: base `6c05bd2ca6978ad54980860430fdbfcb17434e87` plus program diff SHA-256 `7db4f6ab5a619e08f9a22cc980f83cbb6dfdb00ab25ba7cbb229e9a548778ab6`.
- F7 replacement now opens and validates the new rail before closing the primary old rail. Failed open leaves the old rail untouched; failed old-pane closure compensates the newly owned pane.
- F8 retention now uses owner-only deadline markers and one shared worker lock per temporary namespace. A 12-copy witness starts exactly one worker, keeps all copies available, and removes all after their deadlines.
- F9 live validation now produces immutable-candidate handoff directories independently on macOS and Linux; only the coordinator imports both logs and mutates the single evidence manifest.
- Focused correction result: 33/33 passed; lint, whitespace, artifact verification, and every documented Bash block's syntax pass.
- F10 correction moved every retention request into the owner-only shared registry; payload directories contain only copied repository bytes. The hostile marker-basename witness preserves exact bytes and still expires the directory.
- Final corrective fingerprint: base `6c05bd2ca6978ad54980860430fdbfcb17434e87` plus program diff SHA-256 `09ae6b239a4484057ebe735fb960d8731f091d88c09393ac69ca1ee400b8c06f`.
- Full correction result: 201 passed, 1 Linux-only skip; coverage 95.72% lines / 86.06% branches / 95.47% functions. Lint passes.
- Architecture found F11 in the legacy-only migration branch after that run. Legacy rails now join the same deferred close transaction, and pre-existing UID-owned retention state directories are normalized to mode `0700`.
- Final narrow-correction fingerprint: base `6c05bd2ca6978ad54980860430fdbfcb17434e87` plus program diff SHA-256 `e5ccd473ef5faeece6dc2554bbb6bf78497f2dec56fce2290a8dc79a16b9c3a5`.
- Final focused result before re-review: 28/28 passed; lint and whitespace checks passed.

### Round 2 — verified

- All three original reviewer profiles independently pass the final P1 gate. Architecture confirmed F11's legacy ordering and owner-only registry permissions; workflow confirmed the runtime and two-platform release flows; implementation confirmed no blocking regression.
- Final macOS `npm run check`: 202 passed, 1 Linux-only skip; coverage 95.80% lines / 86.07% branches / 95.47% functions.
- Final Linux Node 24 focused correction run: 28/28 passed. The broader Linux provider/process/retention run passed 73/73, including distinct non-UTF-8 path rejection.
- Artifact verification, deterministic snapshot, release Bash syntax, lint, and diff whitespace checks pass.
- Final program diff fingerprint: base `6c05bd2ca6978ad54980860430fdbfcb17434e87` plus SHA-256 `e5ccd473ef5faeece6dc2554bbb6bf78497f2dec56fce2290a8dc79a16b9c3a5`.

### Round 1 — fixing

- Pre-mutation target fingerprint: clean program at `6c05bd2ca6978ad54980860430fdbfcb17434e87`; only this durable report is untracked.
- Authorized fixes: F1–F5 exactly as stated above.
- F6 remains open and will not be mutated without a retention-policy decision.

### Round 1 — verification pending

- Post-mutation fingerprint: base `6c05bd2ca6978ad54980860430fdbfcb17434e87` plus program diff SHA-256 `b282418e65927b3fcac023ed08174624f54a0fb48107da8862fbf822628ef100`.
- Focused result: 69 passed, 1 Linux-only witness skipped on macOS; lint passed.
- Changed surfaces: strict process decoding; provider merge-base handling; ownership-verified pane close recovery; rail replacement preflight; preview state-write compensation; regression tests.

### Round 1 — corrective mutation

- Pre-correction fingerprint: base `6c05bd2ca6978ad54980860430fdbfcb17434e87` plus program diff SHA-256 `b282418e65927b3fcac023ed08174624f54a0fb48107da8862fbf822628ef100`.
- F1, F2, F3, and F5 were confirmed fixed by post-fix reviewers.
- F4 returned to `fixing` solely for ownership proof before its compensating close; no other scope is authorized.

### Round 1 — corrective verification pending

- Post-correction fingerprint: base `6c05bd2ca6978ad54980860430fdbfcb17434e87` plus program diff SHA-256 `ae9a9dba44e8ac0a7d9012fcfe1b6ad5f2d2ebe390b4c21ccd7306c226ef1d0a`.
- Compensation now reuses the complete stale-preview ownership proof before closing. A foreign workspace/label response causes no close call.
- Focused result: 15/15 passed; lint and diff whitespace checks passed.

### Round 1 — verified

- Architecture post-fix review confirmed F1/F3/F4/F5 and found no new P1 architecture regression.
- Workflow post-fix review confirmed F1/F4/F5 across rail, preview, and uninstall recovery; 38/38 focused tests passed.
- Implementation post-fix review confirmed F2/F3/F5, found the initial F4 compensation objection, and confirmed the corrective ownership proof closes that path.
- The exact hostile F4 reproduction now performs only `plugin pane open` and ownership inspection; neither close command runs for a foreign pane.
- macOS `npm run check`: 194 passed, 1 Linux-only skip; coverage 95.76% lines / 86.63% branches / 95.18% functions.
- Linux Node 24/Git 2.39 container: 34/34 provider/process tests passed, including distinct non-UTF-8 path rejection.
- Isolated macOS live Herdr 0.8.2/Node 22/Ink 0.7.0 smoke passed in watch-only and poll-only modes.
- Final program diff fingerprint: base `6c05bd2ca6978ad54980860430fdbfcb17434e87` plus SHA-256 `ae9a9dba44e8ac0a7d9012fcfe1b6ad5f2d2ebe390b4c21ccd7306c226ef1d0a`.

## Stop state

- Stop reason: P1 gate cleared before the three-round limit.
- Gate status: F1–F11 are fixed and re-reviewed; no evidence-backed P0/P1 finding remains.
- Rounds consumed: 2 complete of 3.
- No commit or push was performed.
