# Round 1 — ccx-gitrail-plan

current-session: the plan is technically sound and unusually honest about what the evidence does and does not support. I am not disputing the architecture. I am disputing the **sequencing and the gating**: the plan commits to a multi-process coordinator with typed IPC before any number exists that says the coordinator is needed, and it defers the shippable part behind it. I also have twelve concrete corrections, several of which are arithmetic or API facts that will bite during implementation.

Counter-proposal below: same design, restructured into a shippable Phase A and an evidence-gated Phase B, with item 7 removed.

---

## The scope argument, with the numbers

Two independent multipliers produce the measured churn. The plan treats them as one problem.

**Multiplier 1 — cadence.** Today every rail runs a full 17-command refresh every ~10 s. Your reconciliation default of 300,000 ms cuts that by 30× on its own. The investigation already measured the direction in isolation at 60 s: 138 → 36 Git launches, 0.323 → 0.139 helper CPU-seconds. Items 2–4 own this.

**Multiplier 2 — duplication.** 39 resolved rails mapped to 19 distinct cwd targets, so ~2.05×. Item 5 (the coordinator) owns this.

Run the arithmetic at the 41-rail population, quiet:

| | Git commands/sec, quiet |
| --- | ---: |
| Today (10 s poll, 41 rails) | ~70 |
| Phase A (300 s reconcile, 41 engines) | ~2.3 |
| Phase B (300 s reconcile, 19 engines) | ~1.1 |

The coordinator buys 1.2 commands/sec against a baseline of 70. It costs: owner election, socket lifetime and permissions, stale-owner recovery, bounded frames, a hostile-frame surface, snapshot codec fidelity for Maps and descriptor identity, provider-context compatibility keying, generation-tagged late replies, per-client backpressure, and a grace-period cleanup contract. That is the largest correctness and security surface in the plan, and by Git-command count it is the smallest win in the plan.

**The coordinator's real justification is not Git dedup — it is the Herdr event stream, and that number does not exist yet.** Item 4 replaces three `herdr` CLI subprocesses per rail per refresh with one persistent subscription. Per-rail, that is a large win. At 41 rails it is 41 persistent `herdr` event clients. The only datum we have is the investigation's persistent Herdr client at +0.71 CPU-s over 59.6 s, about 1.2% of a core — and that client was doing real interactive work, so it is an upper bound, not a subscriber cost. If a pure subscriber costs 0.1% of a core, 41 of them cost 4% and the coordinator is optional. If it costs 1%, 41 of them cost 41%, which is worse than the 25% we started from, and the coordinator becomes mandatory.

That measurement is cheap, it belongs in item 1's probe, and it decides item 5. Right now the plan makes item 5 a premise.

---

## Proposed restructure

**Phase A — one process, no IPC. Shippable candidate.**

- **A1** = your item 1, plus two additions: concrete pass criteria for the Herdr probe (below, C9), and steady-state CPU/RSS of one pure `herdr` event subscriber, recorded as the G1 input.
- **A2** = your item 2, with one change: the engine must expose an explicit **client interface seam** (subscribe / latest snapshot / request refresh / status), specified and tested in this item. In Phase A the seam is an in-process call. In Phase B the coordinator sits behind the same seam. This turns item 5 from a rewrite into a transport swap and turns the codec question into a conformance test against an interface that already has tests.
- **A3** = your item 3, with the classifier contract and path table pinned (C5, C6) and a watcher liveness probe added (C4).
- **A4** = your item 4, unchanged in scope. Per-process Herdr subscription. This is the item that removes 12.3 subprocess launches/sec at the measured population, and it does not need a coordinator.
- **A5** = the in-process half of your item 6: rails consume the engine through the A2 seam, hidden-redraw suppression, no-content suspend/resume, per-tab selection and expansion preserved, plus the commit-age render tick (C7).
- **A6** = the Phase-A half of your item 8: witness, `npm run check`, snapshot, docs, config. **A usable, evidence-backed candidate exists at the end of A6.**

**Gate G1**, stated in `CONTRACTS.md` before A1 runs, decided from A6 data: build Phase B only if measured per-subscriber Herdr subscription cost × expected rail count, plus duplicated reconciliation Git cost, exceeds a threshold written down in advance. Pick the threshold now, not after seeing the number.

**Phase B — coordinator, behind G1.**

- **B1** = your item 5, behind the A2 seam.
- **B2** = the transport half of your item 6, plus provider-context compatibility keying and explicit isolation.
- **B3** = the rest of your item 8: full Node 22/24 and Linux matrix, packaging inclusion, rollback, owned-resource cleanup.

**Your item 7 comes out of this plan.** Once quiet cost is ~1 reconciliation per 300 s, ref/history caching only saves work during active editing bursts, which is exactly when the user wants freshness. It touches `src/git-provider.mjs`, the correctness core, with a bespoke invalidation model, and it is the item most likely to produce a silent wrong answer. If A6 shows burst cost matters, the right follow-up is not a cache: split the provider into worktree/index reads and history/ref reads, and skip the history half when the A3 classifier says no ref, HEAD, or config input changed. That is a filter reusing machinery that already exists, not a new cache with its own lifetime.

Consequence for the acceptance criteria: AC-1's "additional tabs add no recurring Git queries" and "independent of client count" are **Phase B** properties, as are the multi-process halves of AC-7 and AC-8. Phase A satisfies the per-engine reconciliation-count half of AC-1. Say so explicitly rather than letting A6 look like a partial failure.

---

## Corrections

**C1 — The reconcile interval's validated range is unspecified and collides with an existing bound.** `src/config.mjs:194–198` validates `GIT_RAIL_POLL_INTERVAL_MS` to an integer in 1,000–300,000. Your healthy default is 300,000 with ±10% jitter, i.e. up to 330,000 — above the existing ceiling. Give `refresh.reconcileIntervalMs` / `GIT_RAIL_RECONCILE_INTERVAL_MS` its own validated range (I suggest 30,000–3,600,000) and decide explicitly whether 0 disables it. AC-6 depends on that answer.

**C2 — Do not repurpose `pollIntervalMs`; its current meaning already matches the new role.** The code variable is literally `watchRecoveryPoll` (`scripts/git-rail.mjs:1047–1063`), and `resetRefreshTimer(watchFailed)` is the watcher-failure path. Keeping `pollIntervalMs` as the degraded/poll-only interval is not a semantic change requiring migration — it is the name matching the behavior for the first time. A user who set 60,000 today to cut CPU gets a 60 s degraded interval, which is correct. This removes the "changed ordinary-mode meaning" risk row entirely.

**C3 — `npm run check` will fail on the new modules, in two ways, and the plan does not account for either.**
- `npm run lint` runs `knip --include exports`. Eight new `src/` modules whose exports are imported only by tests will be reported as unused exports. Every new module needs a production import path by the end of its own item, or the item's proof does not pass.
- `npm run test:coverage` gates `src/**/*.mjs` at 95% lines, 86% branches, 95% functions. `scripts/` is **not** covered. Your item 5 puts the coordinator entry at `scripts/git-state-coordinator.mjs`; error paths, stale-owner recovery, and socket teardown that live there escape the coverage gate. Keep all coordinator logic in `src/git-state-coordinator.mjs` and make the `scripts/` file a thin launcher with no branching.

**C4 — Silent watcher death has no detection mechanism in the plan.** `fs.watch(root, {recursive:true})` on macOS can stop delivering events after the watched root is replaced or renamed, without emitting `'error'`, so `closeWatcherOnError` never fires and the rail believes it is healthy. "Invalidate conservatively on possible root replacement" does not say how you learn it happened. Concrete: at each reconciliation, `stat` each installed watch root and compare device/inode and realpath against what was watched. Mismatch means reinstall and force a full read. Cost is a handful of `stat` calls per 300 s, no Git, and it converts an undetectable failure into a detected one. Make it an explicit A3 change with its own proof.

**C5 — Pin the classifier contract, or "batch classification" will become a `check-ignore` per burst.** There is an ordering trap: you need the ignore answer *before* deciding to read, and the cheapest correct source of that answer is the *previous* read's output. The contract that closes the loop, with zero subprocesses per event:

> A worktree path is relevant if it is in the tracked-path set from the last `ls-files`, **or** it is not matched by the ignore rules cached from the last read, **or** an ignore/config input itself changed.

The only gap is a newly-tracked file the previous read did not know about — and becoming tracked requires an index write, which is itself a watched path that is always relevant. State that reasoning in `CONTRACTS.md`, otherwise an implementer will reach for `git check-ignore` and reintroduce subprocess-per-burst.

**C6 — Name the git-directory path table explicitly; "sibling index vs common metadata" is the exact bug that was reproduced.** Relevant: own `HEAD`, own `index`, own operation markers under `.git/worktrees/<self>/`, `packed-refs`, `refs/**`, `config`, `info/exclude`. Irrelevant: `objects/**`, `*.lock`, `.git/worktrees/<other>/**`. Include the reason object writes are safe to filter, or someone will second-guess it during review: a sibling commit that could change your base or upstream always writes a ref alongside its objects, and the ref write is classified relevant. Unknown or unparseable names recover.

**C7 — Commit ages will freeze on screen for up to 300 s.** "No periodic Git log solely to advance display text" is right, and storing absolute timestamps and formatting at draw time is the fix. But with reconciliation at 300 s and no redraw when quiet, a visible rail shows "2 minutes ago" for five minutes. A visible rail needs a pure-render tick at the coarsest granularity that can change displayed text — 60 s for minute-resolution ages — with zero Git and zero IPC. Make it an explicit A5 change or it reads as a regression in the first demo.

**C8 — AC-1 and its proof command are arithmetically incompatible.** AC-1 asserts a property over a 330-second quiet window. Item 8's proof passes `--quiet-ms 60000`. A 330 s reconciliation cannot be observed in a 60 s window. At three repeats × two client counts × baseline and candidate, honoring AC-1 literally is 12 × 330 s ≈ 66 minutes of pure quiet wall time. Split it: a short workload run (60 s, 3 repeats, all noise/recovery workloads) plus **one** long reconciliation confirmation (≥360 s, 1 repeat, 1 client). Prove the scheduling property itself with the injected clock in A2, where you already do, and use the long run only to confirm the clock matches wall time.

**C9 — Give the Herdr probe a pass/fail criterion, not a description.** "Prove ordering and resynchronization" is not checkable. Proposed: in an isolated session, change a pane's foreground cwd and assert an event carrying the new cwd arrives within 2 s on at least 9 of 10 trials; record the latency distribution; kill and restore the stream and assert the post-reconnect snapshot matches ground truth; and record the subscriber's steady-state CPU and RSS. That last one is the G1 input. If the ≥9/10 criterion fails, the 1 Hz topology fallback becomes the primary path, the cost model changes, and G1 almost certainly flips to "build the coordinator."

**C10 — AC-10's CPU gate is not a gate.** "Total candidate CPU below the baseline median" is satisfied by a 1% improvement, and we already have a 56.9% isolated reduction from cadence alone with no code change. Name the numbers: quiet-window Git launches per engine over 300 s ≤ 19 startup + 17 reconciliation, and quiet-window helper CPU ≤ 25% of the baseline median at the same fixture and client count. A derived threshold is falsifiable; "below the median" is not.

**C11 — AC-3's 2-second target and the 2 s coalescer are in tension at the boundary.** `createCoalescedScheduler` imposes 125 ms initial delay and at most one callback per 2 s (`src/terminal-ui.mjs:341–364`). A single quiescent edit arriving just after a prior burst callback waits up to 2 s for scheduling, then adds provider duration — which exceeds "appears within 2 seconds" even on the small fixture. Either state the target as "within 2 s of the scheduler becoming eligible" or reduce the sustained cadence for the quiescent case. As written, AC-3 can fail on correct code.

**C12 — Item 1's baseline is measured against code that the candidate will not resemble.** The baseline witness runs the current `scripts/git-rail.mjs`, where refresh, context resolution, and watcher installation are entangled in the script. After A2/A5 that code is gone. Pin the baseline by **revision** (`6603d33`) rather than by file, run it from a detached checkout inside the witness's disposable output, and record the revision in every artifact. Your item 1 gestures at this ("immutable source snapshot... with revision/hash recorded"); make it the mechanism rather than a note, because comparing a candidate against a re-derived baseline is the classic way this evidence goes bad.

---

## What I am not disputing

The 300 s / 10 s split, jitter, and the reason a safety net must remain. Recovery deadline keyed to last *successful* full refresh. The full provider as correctness oracle before any optimization. Provider-context keying including Git executable and environment. `GIT_OPTIONAL_LOCKS=0` and index-byte preservation as an acceptance criterion. Not reintroducing a 10 s per-tab poll as a fallback. No live installation, config, or pane changes. The non-goals list. The honesty discipline about fixture evidence versus live claims — keep that verbatim.

---

## Concise agreed scope I am proposing

Six ordered items delivering a shippable in-process candidate (engine, classifier with liveness probe, event-driven Herdr context, rail integration through a defined seam, integrated proof), one written decision gate G1 fed by a measurement taken in item 1, then three coordinator items behind that gate. Item 7 removed; its motivating case re-derived from Phase A data as a provider read split if it survives. Twelve corrections C1–C12 folded in, of which C1, C3, C5, C6, and C8 change item contents and C4 and C7 add work.

RESOLVED:
- Native `fs.watch` is already the right primitive; no native macOS dependency is needed, and the plan correctly refuses one.
- The 300,000 ms healthy reconciliation with a distinct degraded fallback is the right cadence model, and a safety net must remain because Node's watcher contract does not guarantee delivery.
- The full provider stays as the correctness oracle before any filtering or caching is enabled.
- Provider-context keying must include the Git executable and environment, and incompatible contexts stay isolated rather than silently borrowing a client's environment.
- Evidence discipline: no live-workload CPU claim is derived from fixture results, and the original diagnostic measurements are not rewritten as post-change evidence.
- No commits, pushes, live installation or configuration changes, pane manipulation, or CI workflows follow from this plan.

OPEN:
- Sequencing: the coordinator and typed IPC should sit behind a written gate G1 fed by a measured per-subscriber Herdr cost, not be a premise of the plan. Phase A must be independently shippable.
- The engine's client interface seam must be specified and tested in item 2 so the coordinator becomes a transport swap rather than a rewrite, and the codec becomes a conformance test.
- Item 7 (provider ref/history caching) should be removed from this plan, replaced if needed by a classifier-driven read split derived from Phase A measurements.
- `refresh.pollIntervalMs` should keep its current meaning as the degraded/recovery interval rather than being repurposed and documented as changed; `reconcileIntervalMs` needs its own validated range and an explicit disable semantic (C1, C2).
- `npm run check` compatibility is unaddressed: knip unused-export failures for eight new modules, and coordinator logic placed in coverage-excluded `scripts/` (C3).
- Silent watcher death needs a concrete detection mechanism (root device/inode/realpath revalidation at reconciliation), not "conservative invalidation" (C4).
- The zero-subprocess classifier contract and the explicit git-directory relevance path table must be written into `CONTRACTS.md` (C5, C6).
- Commit-age display needs a pure-render tick on visible rails (C7).
- AC-1's 330 s property and item 8's `--quiet-ms 60000` proof are incompatible; the witness must be split (C8).
- The Herdr probe needs a numeric pass/fail criterion plus the subscriber CPU/RSS measurement that feeds G1 (C9).
- AC-10's CPU gate must be a derived number, not "below the baseline median" (C10).
- AC-3's 2-second target conflicts with the existing 2 s sustained coalescer at the boundary (C11).
- The baseline must be pinned by revision in a detached checkout, as a mechanism rather than a note (C12).
