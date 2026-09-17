# Event-driven, shared Git state for per-tab rails

**Status:** complete — Phases A and B implemented and accepted; candidate ready for PR; not installed
**Scope:** git-railgun refresh architecture in this repository; Herdr integration, shared provider/watch state, and compatibility with existing standalone/cmux modes
**Last updated:** 2026-09-16
**Starting revision:** `6603d33c61b6646b4a54806b028961c8fd1379e2`, branch `git-polling-cpu`
**Evidence:** [CPU investigation](../../docs/CPU-POLLING-INVESTIGATION.md)
**Review:** [design decision summary](CONVERGENCE.md), [incorporated review decisions](REVIEW-RESOLUTION.md)
**Template:** adapted from `~/.config/skillshare/templates/IMPLEMENTATION_PLAN_TEMPLATE.md`

Implementation was authorized by the user on 2026-09-16: “implment the plan using sol sub agents”. The calling agent coordinates bounded Sol assignments and owns integration and acceptance. Independent modules may be constructed concurrently against resolved interfaces, but dependent integration, item signoff, and phase activation remain gated by the listed proofs. This is not an unattended-agent run. Item checkboxes remain evidence-gated; implementation does not authorize live rollout, commits, or publication.

## Goal

Keep one rail UI per tab while making Git work proportional to relevant changes and distinct worktrees, rather than the number of open tabs. Native filesystem notifications should drive ordinary updates; an infrequent shared reconciliation and failure fallback should protect correctness. Herdr context changes should not force repeated full Git queries.

### Expected outcomes

- **O1:** Quiet, healthy repositories do not run the current ten-second full-refresh loop; additional tabs on an already-subscribed worktree add no recurring Git queries.
- **O2:** Relevant file, index, ref, configuration, and host-context changes reach the right rails promptly and preserve the provider's current information and read-only behavior.
- **O3:** Ignored files, sibling-worktree index activity, and unchanged host events do not initiate irrelevant Git refreshes or hidden-terminal redraws.
- **O4:** Watcher/connection failures, concurrent startup, rapid tab moves, and last-subscriber exit recover predictably without stale cross-worktree state or abandoned background workers.
- **O5:** Reproducible isolated measurements demonstrate reduced subprocess work and report CPU honestly; standalone, snapshot/demo, and cmux behavior remain usable.

### Non-goals

- Change branding, pricing/package metadata, auto-open defaults, or rail layout.
- Install a global service, change Herdr itself, remove per-tab rails, or introduce a required native macOS dependency before proving Node's existing watcher is insufficient.
- Replace Git parsing semantics, omit existing history/diff features, or make Git writes. Provider history/ref caching and partial recomputation are deferred until post-sharing active-edit evidence justifies a separate change.
- Change the user's active installation/configuration, restart Herdr, reopen closed live rails, or run benchmarks against live workspaces.
- Commit, push, publish, merge, or create GitHub Actions workflows as a consequence of this plan.

## Acceptance criteria

These targets are proposed engineering requirements, not claims of measured improvements. Timed correctness tests use a local small fixture, after watcher/context initialization. Large repositories must retain the last valid state with visible refresh/error status; their provider execution time is reported separately from scheduling latency.

- [x] **AC-1a (O1; Phase A):** WHEN an initialized in-process engine has healthy watchers and no relevant changes, THEN a 60-second quiet window produces zero recovery-triggered Git launches and at most one full reconciliation occurs in the first 330 seconds after initialization. This is a per-engine criterion; Phase A still has one engine per rail.
- [x] **AC-1b (O1; Phase B):** WHEN one or eight real rail clients subscribe to the same already-resolved worktree with identical provider context, THEN state is initially built once, late joins receive it without another full build, and the AC-1a cadence is per worktree rather than per client. Adding a same-context tab produces no additional recurring Git queries.
- [x] **AC-2 (O1, O2):** WHEN a burst of relevant notifications arrives before a provider read starts, THEN one provider read satisfies the burst for all subscribers. WHEN a real invalidation arrives during a read, THEN at most one follow-up is queued and it is not lost. Manual, recovery, and watch requests never overlap providers for the same key, and an already-satisfied recovery tick does not cause a redundant follow-up.
- [x] **AC-3 (O2):** WHEN the fixture undergoes tracked edits/deletes/atomic replacement, untracked create/delete, staging, commits, checkout, detached/unborn transitions, merge/rebase operation changes, shared-ref/packed-ref changes, ignore/config changes, or worktree removal/recreation, THEN affected subscribers show state equivalent to a fresh full provider read. A single relevant edit with no read in flight and at least 2 seconds since the last scheduled start begins its refresh within 500 ms of event receipt and appears within 2 seconds in the small fixture. Otherwise, a pending refresh starts at the next eligible throttle slot (125 ms burst delay / 2 s minimum start cadence, with documented event-loop tolerance), or after the in-flight read completes if later; provider duration is measured separately. This prevents the recent-burst boundary from being mistaken for the quiescent case.
- [x] **AC-4 (O3):** WHEN ignored untracked output is repeatedly written, a different worktree's index changes without relevant shared-ref changes, or unchanged host metadata arrives, THEN no repository provider build occurs for the unaffected worktree. Tracked files matching ignore rules still invalidate. Unknown/ambiguous paths or uncertain classification must conservatively recover rather than be silently discarded. An unknown ignore classification may use one NUL-safe batched Git query per coalescing window; subsequent writes to that known ignored path use the cache with zero additional classifier processes until ignore/index/config inputs invalidate it. Classification launches are counted separately from provider builds.
- [x] **AC-5 (O2, O3; full completion in Phase B):** WHEN Herdr focus, tab/workspace membership, selected content pane, or its cwd changes, THEN the correct subscription and view update within 2 seconds on the event-capable fixture, without a per-rail three-command context poll. Equivalent unchanged context creates no Git work. Hidden subscribers do not redraw from repository notifications; becoming visible renders the newest snapshot without a redundant Git read if current. Non-Git directories retain the existing Files behavior. Phase A proves the event-capable branch if the probe passes; if the probe fails, its explicitly transitional context path is capped at baseline host-query traffic and the 2-second guarantee is deferred to the required shared Phase B source. Phase A cannot claim full AC-5.
- [x] **AC-6 (O4):** WHEN watchers fail or a simulated notification is lost, THEN degraded operation is explicit, one shared fallback serves that worktree, and full state becomes current within the fallback interval plus provider duration (default fallback jitter bounded by 11 seconds). A silent missed event with otherwise healthy watchers is recovered within the default reconciliation maximum of 330 seconds plus provider duration. Each reconciliation compares watched-root realpath/device/inode to installed identities, reinstalls replaced/moved roots, and performs a full read; unchanged identity is not treated as proof that no event was lost. Watchers are retried with bounded backoff and healthy operation resumes. Failed refreshes retain the last valid state and do not postpone recovery indefinitely.
- [x] **AC-7 (O4; Phase B ownership/IPC, Phase A no-content/in-flight safety):** WHEN eight clients start simultaneously, a coordinator exits, IPC reconnects, a client switches worktrees during an in-flight read, or the last subscriber disappears, THEN only one coordinator owns a given instance, stale-generation results never populate another worktree, reconnect restores the latest state, and owned watchers/timers/children/socket state are released within a documented grace period of at most 30 seconds. No-content tabs unsubscribe from repository work without destructive tab closure; they can resume if content returns.
- [x] **AC-8 (O2, O4; Phase A read-only/seam, Phase B sharing/IPC):** WHEN clients differ in effective provider configuration, Git executable/environment, worktree/index identity, or code/protocol version, THEN incompatible results are not shared. IPC preserves Maps and descriptor identities required by model/preview code, bounds messages/backpressure, and cannot execute arbitrary client-supplied commands. Git reads continue to force `GIT_OPTIONAL_LOCKS=0`; index bytes/mtime are unchanged by quiet reads.
- [x] **AC-9 (O2, O5):** WHEN the supported test matrix runs in standalone, demo/snapshot, Herdr, and cmux modes, THEN existing selection, preview/commit expansion, context transitions, errors, config compatibility, and cleanup behavior remain correct. Existing valid config and watch-only/poll-only test modes have documented semantics. Visible commit-age text advances through a render-only timer at 60-second granularity (or the coarsest required by the existing display), with zero Git/IPC; hidden rails have no such redraws. Supported Node 22 and 24 checks and a real isolated macOS watcher witness pass; existing Linux support has a recorded runtime check or remains an explicit unresolved completion blocker.
- [x] **AC-10 (O5):** WHEN the checked-in performance witness runs baseline and candidate against identical fixtures for 1 and 8 clients, THEN it separates startup, healthy quiet, relevant edits, ignored noise, sibling-index activity, and recovery. It records exact owned Git/Herdr launches, trigger/provider/snapshot/render counts, watcher counts, wall duration, helper/coordinator CPU and explicitly available child CPU, environment versions, and cleanup. Final Phase B command counts satisfy AC-1a/1b/2/4/11. After warm-up, the final candidate median application CPU (rails, context source, coordinator, and child CPU where consistently measured) over the 60-second quiet window is at most 25% of the matched baseline median, at both 1 and 8 clients. Report all three runs and spread; extend the window if resolution/noise prevents a defensible comparison. Startup is separate. Phase A records CPU and host-query counts, but does not claim the final shared-system CPU gate. These are proposed targets, not extrapolated results; no numeric live-workload improvement is asserted from fixture measurements.

- [x] **AC-11 (O1, O2; Phase B):** WHEN eight initialized clients observe one relevant tracked-file edit in the same worktree at an eligible idle point, THEN there is exactly one shared provider build and one provider Git-query set, delivered to all eight with the same resulting generation. The witness measures the same edit in Phase A (eight independent builds expected) and Phase B (one required); this makes edit amplification explicit rather than inferring it from quiet-time counts.

## Starting point and verified evidence

```text
scripts/git-rail.mjs              startup, host context, full refresh, watcher/timer, UI
scripts/auto-open-herdr-tabs.mjs   startup/lifecycle ensure per eligible tab
src/git-provider.mjs              full Git state; separate commit expansion reads
src/git-watch.mjs                 per-worktree/common roots, watcher/fallback policy
src/herdr-context.mjs             per-refresh pane get/list/layout; prior-cwd fallback
src/cmux-context-watch.mjs        existing cmux event subscription
src/terminal-ui.mjs               125 ms / 2 s coalescer and poll jitter
src/config.mjs                   one 10 s poll setting; strict config validation
src/model.mjs                    path/index/descriptor semantics
src/process.mjs                  spawn wrapper and optional-lock prevention
src/files-view-model.mjs         per-rail rendering caches
test/                            existing provider, context, watcher, UI, preview tests
scripts/run-isolated-live-smoke.sh existing isolated Herdr witness, Node 22/24 only
work/git-refresh/                 this plan, convergence record, later proof index
```

Verified from code and the diagnostic report:

- Every ordinary refresh calls the full provider; a typical path is 17 Git commands, plus two watch-root probes at initialization. Each rail has independent watchers/timers and three Herdr context subprocesses per refresh (`scripts/git-rail.mjs:948–1063`, `src/herdr-context.mjs:25–63`).
- Watchers are already native via `fs.watch`; on macOS Node uses FSEvents for directory watching. No native rewrite is needed merely to receive changes. Node's API has platform caveats and does not expose the full native loss/replay contract; retain conservative recovery. Sources: [Node fs.watch](https://nodejs.org/api/fs.html#availability), [Apple event recovery guidance](https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/UsingtheFSEventsFramework/UsingtheFSEventsFramework.html).
- The live investigation saw 41 helpers, 39 of which resolved to 19 distinct cwd targets; the roughly one-minute CPU sample was not a globally quiet baseline. It reproduced ignored-file and sibling-index invalidations in disposable fixtures. The user subsequently closed live rails; no new live baseline is authorized by this plan.
- Read-only inspection on 2026-09-16 found **Herdr 0.8.2**. `herdr api schema --json` exposes `session.snapshot`, `events.subscribe`, and subscriptions including `pane.updated`, `pane.focused`, `pane.moved`, `pane.exited`, `pane.closed`, `tab.focused`, `workspace.focused`, and `layout.updated`. `PaneInfo` has `cwd`, `foreground_cwd`, and `revision`. This proves schema availability, not runtime cwd emission or a lossless snapshot/subscription handshake.
- `src/cmux-context-watch.mjs` already uses a reconnecting `cmux events` child. Herdr integration must not replace that with per-tab polling or regress cmux's ownership/focus behavior.
- `package.json` provides `npm run check` (lint plus coverage), `npm run snapshot`, and `npm run live:release:smoke`. The existing live harness restricts Node to 22/24 and mutates plugin links only inside its isolated session; do not run its non-isolated component directly.

### Assumptions and resolution gates (resolved)

| Original premise | Impact if false | Resolved by |
| --- | --- | --- |
| Herdr events actually announce selected foreground cwd changes and identify ordering/reconnect gaps | Pure event context tracking could leave a rail on the wrong worktree | A1 isolated contract probe, before A4; specify shared topology reconciliation fallback if unsupported |
| Existing snapshot objects can be encoded and reconstructed without semantic loss at the largest supported fixture sizes | IPC could truncate state or break Map/descriptor/preview behavior | A1 inventory, B1 codec proof before B2 client integration |
| A narrow Git watcher classifier can cover all currently supported Git operation/ref/config layouts | Filtering could silently miss real state changes | A1 event matrix and A3 oracle tests before enabling filters |
| Supported Node 22/24, compatible Herdr isolated session, and Linux execution environment are available for final checks | Existing current Node 26 alone cannot fulfill the supported-runtime gate | Record availability in A1; resolve before A6/B3, never silently skip the final requirement |

## Proposed design and contracts

### Ownership

One on-demand **coordinator per compatible host-session / user / code-version namespace** owns the host context stream and a registry of worktree engines. Each engine owns one watcher set, one scheduler, one latest snapshot, and the current full-provider read path. Rails remain independent UI clients. Engines are keyed by canonical worktree and per-worktree gitdir, plus effective provider context; shared common-gitdir events are routed to affected engines without conflating sibling indexes. A coordinator may serve multiple engines; do not launch one extra host-context poller for each worktree.

Standalone/snapshot/demo keep an in-process engine and never need a background coordinator. Phase A establishes the same client interface in process, then Phase B shares Herdr rails; cmux may retain its current host adapter but uses the same correctness-oriented engine/scheduler. Cross-host sharing is not required. No launchd registration or installation mutation is introduced.

Coordinator startup must atomically elect one owner. Versioned private runtime paths must not collide with another checkout's active installation. The socket and ownership records must have user-only access, restrictive permissions, bounded frames, a typed protocol, and lease/liveness validation before stale cleanup. No arbitrary command execution or environment dumping over IPC. Snapshot codecs must explicitly reconstruct required Maps; late replies carry subscription identity and generation. Per-client backpressure retains the newest state rather than an unbounded queue. The last subscriber releases an engine; the last client releases the coordinator after a bounded grace period.

The provider-context key must include every supported input that changes Git results (base resolution, limits, Git executable and supported Git/config/index environment). Define and test that inventory before sharing. Contexts that cannot be safely reproduced in the coordinator remain isolated with an explicit reason; never borrow the first client's environment silently. UI/viewer preferences and selection stay in the rail.

### Client seam and phased delivery

A2 defines and tests `subscribe(context, listener)`, latest snapshot/status access, `requestRefresh(reason)`, context generation updates, and `unsubscribe/close`. Phase A invokes this contract in process. Phase B preserves its semantics across IPC, with codec conformance against the same fixtures. Actual signatures and message bounds are recorded in `CONTRACTS.md` before B1. No terminal code reaches around the seam to call an independent initial provider read.

Phase A is independently validated but does not complete the shared-worktree objective. Phase B is required, not subject to a quiet-CPU-only threshold. Measure context-subscriber cost and edit amplification at A1/A6 to inform design, not to silently remove the target. No milestone authorizes rollout.

### Event-driven updates and recovery

- Ordinary relevant filesystem events mark the engine dirty. Preserve 125 ms burst coalescing and bounded 2 s sustained cadence initially; manual refresh remains responsive. Maintain dirty generations so events arriving during a read receive one necessary follow-up.
- A successful full refresh resets the reconciliation deadline; merely receiving events or failing a refresh does not. Recovery triggers already covered by a fresh successful read do not set another dirty generation.
- Proposed defaults: **300,000 ms healthy reconciliation**, **10,000 ms degraded/poll-only fallback**, both ±10% jitter. The healthy maximum is 330 seconds. Reconciliation is one full read per active engine; Phase A has per-rail engines and Phase B makes them shared per worktree. This deliberately retains a rare safety net because Node watchers cannot guarantee perfect event delivery; it is not the old ten-second normal polling model.
- Keep existing `refresh.pollIntervalMs` / `GIT_RAIL_POLL_INTERVAL_MS` as the degraded/poll-only interval; add `refresh.reconcileIntervalMs` / `GIT_RAIL_RECONCILE_INTERVAL_MS` for healthy safety scans. Document the former's changed ordinary-mode meaning, validate both, and support the existing watch-only/poll-only witnesses. The new reconciliation input accepts integers 30,000–3,600,000 ms; default 300,000; 0 is invalid. Existing fallback input stays 1,000–300,000 ms. These bounds apply before jitter; timer values can exceed an input upper bound by 10%. An old explicit `pollIntervalMs=1000` no longer implies healthy one-second refreshes: document that behavior change, even though its JSON remains valid. Config-file watches trigger relevant refreshes even though that file is outside the worktree.
- On every reconciliation, compare each installed root's current realpath/device/inode with its installed identity. Reinstall on replacement/disappearance and force a full read. Identity probes alone cannot detect every silently lost event, so the full reconciliation remains. A real root rename/replacement witness must prove recovery.
- Watcher failure starts engine-owned fallback and bounded watcher-retry backoff (shared in Phase B). Unknown event filenames, possible root replacement, or reconnect gaps invalidate conservatively. Watch external user/global Git config and excludes where supported, or account for them explicitly in reconciliation.
- Classify tracked/untracked worktree paths and own Git metadata versus shared refs/config. The last tracked-path set, index events, and changes to ignore/config inputs are always relevant. Cache ignore classification by a generation invalidated by those inputs. Unknown paths may use at most one NUL-safe batched `git check-ignore --stdin -z` per coalescing window through the normal `runGit` read-only wrapper, never a subprocess per event. Count these launches. Repeated writes to a known ignored path incur neither full provider reads nor new classification commands. Existing status/ls-files output does not contain the ignore rule set; do not assume it can provide an exact matcher for free. Do not discard tracked ignored paths, sparse/assume-unchanged changes, nested repository transitions, submodule state, operation markers, or uncertain paths. Common objects/sibling index traffic alone must not force all engines to refresh; missing-object/error recovery remains bounded.

The initial metadata table is a dependency inventory to verify in A1/A3, not a blanket suffix filter:

| Input | Default treatment and exceptions |
| --- | --- |
| Own HEAD/index/per-worktree refs and operation markers | Relevant; include worktree-specific Git operation directories and `config.worktree` where supported |
| Shared refs, packed-refs, config, info/exclude and configured external inputs | Relevant to engines whose base/upstream/config depends on them; unknown dependency invalidates conservatively |
| Other worktree index | Irrelevant only when no relevant shared ref/config/operation dependency changed; test the reproduced sibling-index case |
| Object traffic and known transient locks | Suppress only for a healthy valid snapshot with no dependency requiring recovery; no blanket `*.lock` or sibling-directory suppression |
| Missing-object/provider error, unknown name, replacement ambiguity | Conservative invalidation/recovery, even if an otherwise healthy engine could ignore the path |

### Host context and rendering

Use a Herdr subscription plus an initial snapshot in Phase A; one shared source owns both in Phase B. Prove ordering and resynchronization behavior in isolation. Process pane/tab/workspace focus, lifecycle, layout, and cwd-affecting updates; compare semantic context before changing subscriptions. Never react to rail output as a repository invalidation.

A1 tests ten of ten scripted foreground-cwd/focus/move trials resolving the correct semantic context within 2 seconds, plus forced reconnect followed by equality to an independent host snapshot. Record latency, one/eight subscriber CPU/RSS, and host-query counts. Any silently lost required update disqualifies subscription alone as the normal source.

If runtime event coverage is incomplete, Phase B uses **one coordinator-level topology reconciliation**, at most once per second, with no Git query when semantic context is unchanged. This fallback is distinct from Git reconciliation and must be visible in metrics. Prefer direct documented socket requests to subprocesses; do not invent an undocumented wire protocol. Resolve the branch in A1 rather than making event coverage a hidden assumption. **Phase A fallback rule, fixed before the probe:** retain the existing context-query cadence (no more than the baseline three host requests per rail per nominal ten-second window) and decouple unchanged context from Git refresh; defer the 2-second fallback guarantee to Phase B. Do not introduce a per-process 1 Hz topology source. A6 records the aggregate host-query rate against the baseline; an increase fails the Phase A milestone. User-triggered work is separately attributed.

Visible rails render changed snapshots; absolute commit timestamps support a pure local age-render timer at 60-second granularity, with no Git or IPC; hidden rails retain the newest generation without redraw. On visibility restore, render cached current state immediately; if recovery is overdue or connection state is uncertain, request one shared refresh. No-content tabs unsubscribe and retain a recoverable UI state rather than querying a stale cwd or closing the tab. Non-Git directories use a bounded directory engine keyed by canonical directory. File previews and per-tab commit expansion remain scoped to their selected descriptor; no results can cross a context generation.

### Provider optimization boundary

Keep the current full provider behind the engine and use it as the semantic oracle. Provider history caching/partial recomputation is **deferred**, not a mandatory item. After shared-state correctness and performance are proven, use active-edit measurements to decide whether separating worktree/index reads from ref/history reads is worth another change. Absolute commit timestamps and render-time ages are the only required history-related compatibility adjustment here; they do not introduce a history cache.

## Implementation plan

Steps are ordered intermediate outcomes; execution is now authorized within the non-goals and rollout boundary above. Every new test/harness named below must be checked into the repository by its owning item; temporary-only proof scripts do not qualify. Record each proof and result in `work/git-refresh/EVIDENCE.md` during implementation, along with the tested revision or patch identity. Use existing package scripts where applicable; do not create CI workflows.

### Phase A — independently validated in-process event-driven engine

**Phase acceptance:** A6's exact commands pass the A-scoped criteria: AC-1a/2/3/4/6, in-process portions of AC-7/8, applicable AC-5 branch, and mode/config/display portions of AC-9. CPU, host-source scaling, and eight-client edit amplification are recorded as milestone evidence, not mislabelled as AC-1b/11 completion. The fallback branch must not increase baseline host-query traffic. Phase B remains required for final completion.

1. [x] **A1 — Reproducible baseline and resolved integration contracts.**
   - **Covers:** AC-3, AC-5, AC-8, AC-9, AC-10, AC-11 baseline.
   - **Depends on:** Separate authorization to implement; diagnostic report available.
   - **Changes:** Add isolated baseline/performance fixtures and a real Herdr cwd/focus/move/reconnect probe. Resolve Git-event dependencies, input key inventory, and snapshot serialization limits into `work/git-refresh/CONTRACTS.md`. Extract `git archive 6603d33c61b6646b4a54806b028961c8fd1379e2` into the witness's disposable baseline source directory; the benchmark Git repository is separate. Record the revision and source hashes in every artifact, never infer baseline from edited HEAD. Resolve runtime availability. Select the host event/fallback branch using the predetermined rule above.
   - **Files:** New `scripts/refresh-performance.mjs`, `scripts/probe-herdr-refresh-contract.mjs`, fixture helpers under `test/`, `work/git-refresh/CONTRACTS.md`, `work/git-refresh/EVIDENCE.md`.
   - **Proof:** `node scripts/refresh-performance.mjs --mode baseline --baseline-revision 6603d33c61b6646b4a54806b028961c8fd1379e2 --clients 1,8 --quiet-ms 60000 --repeats 3 --out test-results/git-refresh/baseline`; `node scripts/probe-herdr-refresh-contract.mjs --isolated --trials 10 --deadline-ms 2000 --measure-subscribers 1,8 --out test-results/git-refresh/herdr-contract`. The probe must record all ten context trials, reconnect snapshot equality, latency, CPU/RSS, exact host requests, and the selected branch; a failed pure-event branch requires the documented fallback, not a false pass. Harnesses reject live inherited sockets/session targets, own every fixture/session, and assert teardown. Contracts must inventory supported ignore/config/ref and IPC inputs before dependent steps start.

2. [x] **A2 — A tested client seam and single in-process refresh owner.**
   - **Covers:** AC-1a, AC-2, AC-6, AC-8 in-process, AC-9 config.
   - **Depends on:** A1 provider contract and validated fixed-revision baseline harness. The pinned-archive interval capture may run alongside A2 source implementation because candidate edits cannot alter that baseline; complete baseline results are required before A2 signoff and A6 comparison.
   - **Changes:** Extract provider execution/scheduling behind the client seam. Distinguish real dirty generations from manual/recovery requests, preserve one necessary in-flight follow-up, and reset reconciliation only after success. Add healthy/degraded/retry state and explicit interval validation/documentation. Keep full-provider semantics. Replace source-regex scheduling tests with behavior tests using an injected clock and controllable provider promises; wire production imports, not just test-only modules.
   - **Files:** New `src/repository-engine.mjs`, `src/repository-client.mjs`, `src/refresh-scheduler.mjs`, their tests; update `scripts/git-rail.mjs`, `src/terminal-ui.mjs`, `src/config.mjs`, existing config/UI tests.
   - **Proof:** `node --test test/refresh-scheduler.test.mjs test/repository-engine.test.mjs test/repository-client.test.mjs test/config.test.mjs test/terminal-ui.test.mjs`. Assert exact execution counts for burst, poll/watch collision, recent-throttle boundary, mid-read edit, failure/retry, watcher loss, 330-second healthy maximum, and close. Prove the seam returns equivalent provider state and cannot deliver a prior context generation.

3. [x] **A3 — Relevant watcher invalidation and root liveness recovery.**
   - **Covers:** AC-3, AC-4, AC-6, AC-8 read-only.
   - **Depends on:** A1 event/ignore/config contract and A2 engine.
   - **Changes:** Own watchers in the engine; distinguish gitdir/common dependencies, avoid redundant overlapping watches, and implement the explicit metadata table. Batch/cache unknown ignore classifications through `runGit`. Include external-config/ignore inputs and operation-state exceptions. Revalidate root identities on reconciliation and reinstall replaced roots without multiplying watchers. Ambiguity/failure keeps a conservative full-read recovery path.
   - **Files:** `src/git-watch.mjs`; new `src/git-invalidation.mjs`, `test/git-invalidation.test.mjs`, `test/repository-engine.integration.test.mjs`; extend `test/git-watch.test.mjs`.
   - **Proof:** `node --test --test-concurrency=1 test/git-watch.test.mjs test/git-invalidation.test.mjs test/repository-engine.integration.test.mjs`. Real disposable linked worktrees prove zero unaffected reads for ignored-output and sibling-index cases, tracked-ignore positive cases, classification-launch bounds/cache invalidation, and the AC-3 full-provider oracle matrix. A real root rename/replacement test plus injected time proves restored events and deadline recovery. Record index hash/mtime before/after quiet reads; inject missing filenames, lost events, and asynchronous watcher errors.

4. [x] **A4 — Independent host-context observation with a bounded transitional fallback.**
   - **Covers:** AC-4 unchanged context; AC-5 Phase A branch; AC-6 reconnect; AC-7 generation safety; AC-9 host compatibility.
   - **Depends on:** A1 verified Herdr transport/order/coverage branch and A2 seam.
   - **Changes:** Implement the per-process event-capable context source, snapshot resynchronization, semantic context comparison, and explicit no-content state. If the probe fails, retain no more than the baseline context-query cadence, detach it from Git refresh, and defer fast fallback freshness to B2; never introduce 1 Hz per-process queries. Preserve cmux events and ownership. Keep substantive adapter logic in coverage-accounted `src/`.
   - **Files:** New `src/herdr-context-watch.mjs`, `test/herdr-context-watch.test.mjs`; update `src/herdr-context.mjs` and relevant host tests; change cmux adapter only where necessary.
   - **Proof:** `node --test test/herdr-context.test.mjs test/herdr-context-watch.test.mjs test/cmux-context-watch.test.mjs`; `node scripts/probe-herdr-refresh-contract.mjs --isolated --verify-adapter --trials 10 --deadline-ms 2000 --measure-subscribers 1,8 --out test-results/git-refresh/context-a`. Assert event-branch latency or correctly reported transitional fallback, no baseline host-query-rate increase in fallback, correct selected cwd/moves/reconnect/no-content handling, and zero Git for unchanged semantic context.

5. [x] **A5 — Rails consume the in-process seam and preserve UI freshness.**
   - **Covers:** AC-1a, AC-3, AC-5 applicable branch, AC-7/8 in-process, AC-9.
   - **Depends on:** A2–A4.
   - **Changes:** Move terminal refresh/startup/context integration to the seam and remove duplicate timers/watchers. Keep standalone/demo/snapshot/cmux usable, per-tab selections/expansions and descriptor-scoped preview reads independent. Add hidden/unchanged redraw suppression, cached latest generation on visibility restore, no-content suspend/resume, and stale/reconnect status. Store absolute commit times and advance visible age text with a render-only timer; no history cache.
   - **Files:** `scripts/git-rail.mjs`, `src/terminal-ui.mjs`, provider/parser timestamp fields where required, `src/files-view-model.mjs`, new `test/rail-state-client.test.mjs`, existing model/preview/host tests.
   - **Proof:** `node --test --test-concurrency=1 test/rail-state-client.test.mjs test/terminal-ui.test.mjs test/integration.test.mjs test/herdr-context.test.mjs`; `npm run snapshot`. Assert hidden render count zero, visible ages advance without Git/IPC, independent selection, no stale-generation previews after cwd switches, and no-content suspend/resume. Compare baseline snapshot semantics; document intended time/status differences.

6. [x] **A6 — The in-process milestone has integrated evidence.**
   - **Covers:** All Phase A-scoped criteria; AC-10 measurements and AC-11 amplification baseline (not shared completion).
   - **Depends on:** A1–A5; supported Node 22/24 availability resolved for host gate.
   - **Changes:** Run the short baseline/Phase-A comparison, including eight independent rails receiving a relevant edit. Record all application CPU, event-subscriber cost, exact Git/classification/host query counts, and fallback branch. Update config example/troubleshooting for the healthy/degraded split and no-content/age behavior. The milestone must be usable and correct, but the evidence explicitly records that eight independent engines still amplify edits.
   - **Files:** Witness/helpers, `git-rail.config.example.json`, relevant docs, `work/git-refresh/EVIDENCE.md`.
   - **Proof:** `node scripts/refresh-performance.mjs --mode compare --candidate-stage A --baseline test-results/git-refresh/baseline --clients 1,8 --quiet-ms 60000 --workloads quiet,edit-burst,ignored,sibling-index,recovery --repeats 3 --out test-results/git-refresh/phase-a`; `npm run check`; `npm run live:release:smoke` with Node 22 and 24, using only its isolated sessions. Assert Phase A integrated acceptance above, record CPU/rates/spread and eight-vs-one edit build counts, and verify teardown. No 330-second wall repetition is required here because A2's clock tests prove cadence. No application rollout follows.

### Phase B — required shared worktree state

**Phase acceptance:** B3's short compare and long reconciliation witness, existing regression/packaging checks, and isolated host/runtime witnesses satisfy **all** AC-1a/1b through AC-11, including shared edit amplification and the final CPU target. Phase A completion alone is never plan completion.

7. [x] **B1 — A compatible coordinator owns one engine per worktree.**
   - **Covers:** AC-1b, AC-2, AC-6, AC-7, AC-8, AC-11.
   - **Depends on:** A1–A6 contracts, seam, and milestone evidence.
   - **Changes:** Add on-demand owner election, registry, typed local IPC/codec, subscription generations, backpressure, bounded reconnect, private versioned runtime paths, stale-owner validation, and bounded cleanup. The coordinator owns the single host-context source. Reproduce each supported effective provider context or explicitly isolate it. Put all substantive coordinator/error/cleanup logic in `src/`; the script is a thin launcher. Do not start an independent provider before clients connect.
   - **Files:** New `scripts/git-state-coordinator.mjs` (thin), `src/git-state-coordinator.mjs`, `src/git-state-client.mjs`, `src/git-state-protocol.mjs`, corresponding tests.
   - **Proof:** `node --test --test-concurrency=1 test/git-state-protocol.test.mjs test/git-state-coordinator.test.mjs test/repository-client.test.mjs`. Spawn eight real clients simultaneously and assert one owner/engine/initial read, zero new full read on late join, one shared read on a tracked edit, exact codec/Map fidelity, safe context separation, message/backpressure bounds, owned-coordinator crash recovery, and grace-period cleanup. Malformed IPC/stale-owner tests must never act on unrelated processes.

8. [x] **B2 — Herdr rails share the transport and one context source.**
   - **Covers:** AC-1b, AC-3, AC-4, AC-5 full, AC-7, AC-8, AC-9, AC-11.
   - **Depends on:** B1 and A5 client UI integration.
   - **Changes:** Swap the Herdr client seam to IPC, remove per-process host subscriptions/fallback loops, and use one shared semantic topology source. If A1 required fallback, implement it here at at most 1 Hz coordinator-wide and meet the full 2-second context target. Preserve standalone in-process and cmux modes; generation-safe client movement, hidden redraw suppression, latest snapshot restore, and scoped preview reads continue unchanged.
   - **Files:** `scripts/git-rail.mjs`, client/coordinator/context adapter modules, `test/rail-state-client.test.mjs`, host/preview tests, isolated context witness.
   - **Proof:** `node --test --test-concurrency=1 test/rail-state-client.test.mjs test/git-state-coordinator.test.mjs test/herdr-context-watch.test.mjs test/integration.test.mjs`; `node scripts/probe-herdr-refresh-contract.mjs --isolated --verify-adapter --candidate-stage B --trials 10 --deadline-ms 2000 --measure-subscribers 1,8 --out test-results/git-refresh/context-b`. Assert ten of ten context trials including fallback, one shared host source independent of client count, unchanged-context zero Git, one provider build for the same eight-client edit, no stale cross-context state, and clean no-content/exit recovery.

9. [x] **B3 — Final shared-state performance, compatibility, and packaging are proven.**
   - **Covers:** AC-1a, AC-1b, AC-2 through AC-11.
   - **Depends on:** A1–A6 and B1–B2; required macOS/Linux/runtime environments resolved.
   - **Changes:** Complete short repeated workload comparisons and one long wall reconciliation witness, with exact attribution of classifier, context, provider, UI and coordinator costs. Extend isolated shutdown/uninstall handling to candidate-owned coordinator state. Document operating/recovery/config/rollback behavior and archive inclusion. Keep historical investigation measurements unchanged.
   - **Files:** Witness/helpers, relevant isolated/uninstall/packaging verification scripts, `docs/TROUBLESHOOTING.md`, `docs/INSTALLATION.md`, `docs/CMUX.md`, `work/git-refresh/EVIDENCE.md`.
   - **Proof (short):** `node scripts/refresh-performance.mjs --mode compare --candidate-stage B --baseline test-results/git-refresh/baseline --clients 1,8 --quiet-ms 60000 --workloads quiet,edit-burst,ignored,sibling-index,recovery --repeats 3 --out test-results/git-refresh/phase-b`.
   - **Proof (long):** `node scripts/refresh-performance.mjs --mode candidate --candidate-stage B --clients 8 --quiet-ms 360000 --workloads reconciliation --repeats 1 --out test-results/git-refresh/reconciliation`. Confirm exactly one healthy reconciliation after initialization in this unchanged default-interval fixture; clock tests separately prove the 330-second maximum.
   - **Proof (regression/deployment artifact):** `npm run check`; `npm run artifact:verify`; `npm run live:release:smoke` under Node 22 and 24 in the harness's isolated sessions. Run the real watcher/provider witness on macOS and the supported Linux runtime, recording versions/fallback. Invoke the repository's existing archive verification through a checked-in isolated packaging witness added here if no direct package command exists; the proof must create a disposable candidate archive, inspect required launcher/import inclusion, and execute the fixture from the unpacked artifact. Record that exact command in `EVIDENCE.md`; `node scripts/refresh-performance.mjs --mode packaged-smoke --candidate-stage B --out test-results/git-refresh/packaged` is the required checked-in entry for this operation.
   - **Completion evidence:** All acceptance counts, CPU <=25% of baseline median at 1/8 clients after warm-up with all three measurements/spread, one-vs-eight edit amplification eliminated, typed snapshot equivalence, supported runtimes/OS, packaging and cleanup pass. Missing environments or failed targets leave this item unchecked; do not quietly relax thresholds or deploy.

## Testing and evidence coverage

| Criterion | Final proof surface | Decisive evidence |
| --- | --- | --- |
| AC-1a | A2 injected-clock and A6 short witness; B3 long witness | Per-engine zero quiet 60-second Git; at most one reconciliation in first 330 seconds |
| AC-1b | B1/B2 real clients and B3 1/8-client witness | One initialization, zero late-join full read, no client-count multiplier on reconciliation |
| AC-2 | A2 scheduler tests plus A6/B3 bursts | Exact start counts and non-overlap; only genuine in-flight changes queue a follow-up |
| AC-3 | A3 real mutation matrix/full-provider oracle; A5/B2 UI | Correct complete state and event/schedule/publish timing at explicit eligible/busy boundaries |
| AC-4 | A3/A6/B3 ignored/sibling/host witnesses | Zero unaffected provider builds; bounded counted classifier launches; tracked/uncertain positive controls |
| AC-5 | A1/A4 branch decision and B2 final shared host tests | Ten of ten correct 2-second trials at final stage; Phase A fallback has no higher host-query rate |
| AC-6 | A2 injected clocks, A3 root replacement, B3 recovery | Reconciliation/fallback deadlines; root reinstallation; last-valid state and bounded retries |
| AC-7 | A5 no-content/generations; B1/B2 multi-process lifecycle | One owner, no stale cross-worktree state, reconnection and cleanup within grace period |
| AC-8 | A2 seam and A3 read-only; B1 codec/key/IPC variants | Exact snapshot/Map equivalence, environment isolation, message bounds, unchanged index |
| AC-9 | A5 age/mode tests; A6/B3 runtime/artifact/host gates | Display freshness without Git; Node 22/24, macOS/Linux, snapshot and preview compatibility |
| AC-10 | A6 milestone evidence; B3 short three-repeat comparison | Exact counts plus final application CPU <=25% of matched baseline median at 1/8 clients; no hidden broker cost |
| AC-11 | A6 and B3 identical eight-client tracked edit | Phase A independent-build multiplier recorded; Phase B exactly one shared build/query set |

## Risks and decisions (resolved for this candidate)

| Item | Impact | Status | Resolution point |
| --- | --- | --- | --- |
| Herdr schema availability is not runtime event completeness; resolved by the shared socket fallback | Missed cwd changes or snapshot/event races | Resolved | A1 isolated probe; choose event reconciliation/shared fallback explicitly |
| IPC adds lifetime and environment complexity | Duplicate owners, stale sockets, cross-context results | Resolved | B1 multi-process/codec/key tests |
| Overly broad ignore/metadata filtering | Quietly stale Git state | Resolved | Complete positive/negative mutation matrix plus full reconciliation |
| `pollIntervalMs` ordinary-mode meaning changes | User expectations and tests may change | Resolved | Document migration/override behavior; validate old config; no user config rewrite |
| Existing release tooling/archive inclusion may omit new runtime files | Installed code could differ from tested worktree | Resolved | Inspect existing packaging/verification rules and include coordinator modules using current release processes; no publication |
| Fixture CPU savings are measured; live workload savings remain unmeasured | Do not extrapolate fixture ratios to live Herdr | No | B3 verifier passes both CPU gates; retain report's live uncertainty |

## Rollout boundary and rollback preparation

This plan ends at a validated candidate and evidence, with rollout left to a separate user request. Do not use an implementation fallback to silently reintroduce one ten-second full poll per tab: use shared degraded recovery, and expose errors clearly. Maintain a documented compatibility/rollback path to the original in-process provider with explicit behavior and tests. Candidate runtime namespaces must be separate from the active installation. Removing or rolling back a candidate must release only coordinator/socket resources owned by that candidate; no blanket process kills or global config changes.

## Completion evidence

All item proofs and acceptance criteria passed. See [EVIDENCE.md](EVIDENCE.md),
[PERFORMANCE.md](PERFORMANCE.md), and the checked-in
[performance verifier output](PERFORMANCE-ACCEPTANCE.json). Final runtime source
hashes match all measured production files; docs and acceptance scripts were
finished afterwards. The final host proof uses **automatic**, unforced updates
(`context-b-accepted`), not the earlier manual-refresh probe. Raw output paths
use fresh suffixed directories to preserve intermediate evidence.

## Completion criteria

- [x] Every item proof has passed against the integrated candidate, with commands/results recorded in `EVIDENCE.md`.
- [x] Every O1–O5 outcome has satisfied AC coverage; all AC-1a/1b–AC-11 results are recorded.
- [x] Phase A and required Phase B integrated acceptance both pass; Phase A alone is not treated as completion.
- [x] Baseline/candidate process and CPU comparisons meet the stated gates without shifting uncounted work into a broker.
- [x] Supported runtime, real macOS watcher, Linux, and isolated Herdr compatibility checks are complete.
- [x] No blocking assumption, failed item, unresolved dependency, or undocumented contract change remains.
- [x] Operating/configuration/rollback documentation and owned-resource cleanup are verified.
- [x] No live installation change, commit/push/publication, or CI workflow was performed without separate authorization.


## Completed PR-review follow-up

The bounded dirty-batch and ignore-cache fixes, AD-1/AD-2 regressions, and amended
publication cleanup are complete. Fresh Node 22/24 macOS and Node 24 Linux checks,
isolated host/runtime probes, and the unchanged 32-run performance verifier pass.
See [review evidence](EVIDENCE.md#pr-review-follow-up--accepted) and
[accepted measurements](PERFORMANCE.md#accepted-pr-review-rerun--2026-09-16).
The observed warm-up boundary defect was corrected in the witness and the entire
candidate set rerun against the same archived baseline; no gate was relaxed.
