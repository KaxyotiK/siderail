# Git refresh implementation evidence

Implementation authorized 2026-09-16 using Sol subagents. Starting revision: `6603d33c61b6646b4a54806b028961c8fd1379e2`. Phases A and B are implemented and accepted. All item proofs and AC-1a/1b–AC-11 pass; final commands and results are recorded below. The implementation was validated before committing; the user subsequently authorized a PR. The candidate is not installed.

## Environment

- macOS host, Node `v22.23.2` at `/opt/homebrew/opt/node@22/bin/node`; Node `v24.19.0` at `/opt/homebrew/opt/node@24/bin/node`. Verified by `--version`.
- `docker info --format '{{.OSType}} {{.ServerVersion}}'` returned `linux 29.8.0`; `docker run --rm --network none node:24-bookworm sh -c 'node --version && git --version && uname -sr'` returned Node 24.19.0, Git 2.39.5, Linux 7.0.12-linuxkit. Final runtime results are recorded below.
- Current branch `git-polling-cpu`; initial worktree contains diagnostic report and reviewed plan only, with no tracked source changes.
- Active Herdr configuration, installation, focus and rails are outside implementation scope. All Herdr witnesses must use owned isolated sessions.

## A1 — baseline and contracts (initial assignment)

Bounded Sol assignments own the performance harness, isolated Herdr probe, and provider/watch contract inventory respectively. Completed proofs are linked below.

## Initial regression baseline

- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm ci --ignore-scripts`: installed locked dependencies (91 packages), no lifecycle scripts. Initial check before install had failed solely because `eslint` was absent.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run check`: exit 0, 372 tests, 371 passed, 0 failed (one skipped); 52.192 s. Coverage: 96.96% lines, 88.03% branches, 96.63% functions. This is the unmodified application baseline, not final candidate validation.
- Read-only Darwin `proc_pid_rusage(RUSAGE_INFO_V1)` prototype verified waited-child CPU against Python `RUSAGE_CHILDREN`: 5,171,115 Mach ticks × timebase 125/3 ns = 0.215463125 s; Python reported 0.215462 s. Raw Mach ticks must not be mislabeled as nanoseconds. The performance witness will record both live helper and waited-child CPU at quiescent boundaries.

- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run live:release:smoke`: exit 0 on unmodified runtime, Herdr 0.8.2 / Node 24.19.0. Both watch-only and poll-only isolated sessions passed, including uninstall/restart persistence and cleanup.

## Execution sequencing refinement

A1 validated the fixed-revision archive harness at 1/8 clients: exact startup 19 Git + 3 isolated host subprocesses per client, with self and waited-child CPU available. The six 60-second intervals then run while A2 implements the resolved provider/scheduler contract. This overlaps independent work only: candidate edits cannot change archived baseline sources. Complete A1 measurements are still required before A2 signoff and A6 comparison; no acceptance threshold changes.

## Isolated harness correction during Phase A integration

The first two-second candidate smoke failed its 30-second startup wait. Its launcher inherited `HERDR_SOCKET_PATH`, so the new socket adapter made read-only snapshots of the live server and found no fixture pane; it correctly suspended and ran zero Git commands. No live pane, focus, configuration, installation, or Git state was changed. The harness now removes every inherited `HERDR_*`, `CMUX_*`, `GIT_*`, and `REFRESH_*` variable before adding owned fixture values. Baseline code used the explicit fake CLI and did not use the inherited socket; its six archived measurements remain scoped to fixture Git and fake-host requests. The failed smoke is not performance evidence.

## Completed component proofs

- **A1:** [Provider/watch contracts](CONTRACTS.md), [Herdr runtime decision](HOST-CONTRACT.md), [six-run archived baseline](PERFORMANCE.md). Baseline startup: exactly 19 Git + 3 fake-host launches/client. Healthy quiet medians: 1 client 102 Git, 18 host, 1.966 total CPU-seconds; 8 clients 799 Git, 141 host, 15.817 total CPU-seconds. Full counts/spread/raw artifact paths are in the supporting note.
- **A2:** [Engine evidence](ENGINE-EVIDENCE.md). Sol component proof: 27 scheduler/engine/client/process tests pass; config + terminal tests 46 pass. Scoped concurrent index environments, coalescing, retries, failure retention and close are tested. Production rail imports the seam; no independent ordinary startup provider read remains.
- **A5 in progress:** `node --test --test-concurrency=1 test/rail-state-client.test.mjs test/terminal-ui.test.mjs test/integration.test.mjs test/herdr-context.test.mjs`: 70 passed, 1 failed, 1 skipped initially. Failure was the tracing fixture stripping its own trace variable now that explicit provider environments are honored. Corrected that fixture to pass the trace variable explicitly; the exact failed test then passed. Integrated check rerun pending. Snapshot generation passes.
- **Short smoke (not acceptance timing):** corrected `--candidate-stage A --clients 1,8 --quiet-ms 2000 --workloads quiet --repeats 1` passed both runs with zero quiet Git/host launches and all temporary roots removed. Full 60-second measurements remain required.
- **Isolated UI:** `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run live:release:smoke` passed with Herdr 0.8.2 and Node 24.19.0, both watch-only and poll-only, including read-only checks, previews, context refresh, uninstall, and server cleanup. Log: `test-results/git-refresh/initial/live-a-node24.log`.

## Phase A integrated checks

- **A4:** exact `node scripts/probe-herdr-refresh-contract.mjs --isolated --verify-adapter --trials 10 --deadline-ms 2000 --measure-subscribers 1,8 --out test-results/git-refresh/context-a` passed. Adapter 10/10, unchanged suppression and reconnect equality pass, clean teardown; fallback branch selected. See [host contract](HOST-CONTRACT.md).
- **A5:** full `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run check` passed after stale source-regex assertions were removed in favor of the new behavior tests and executable fixture helpers moved out of Node's automatic test discovery. Coverage: 96.81% lines, 86.85% branches, 95.35% functions. Log: `test-results/git-refresh/initial/phase-a-check-2.log`.
- **Node 22 live:** `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run live:release:smoke` passed Herdr 0.8.2/Node 22.23.2, both watch-only and poll-only, including cleanup. Log: `test-results/git-refresh/initial/live-a-node22.log`.
- **Linux gap under investigation:** Docker `node:24-bookworm`, Node 24.19.0/Git 2.39.5: the real mutation witness missed an assume-unchanged index transition after preceding index replacements. This leaves A3/A6 compatibility acceptance open until fixed and rerun. Log: `test-results/git-refresh/initial/linux-a.log`. The container copied the worktree read-only into an owned `/tmp/project`, with no network or live host socket.

The completed Phase A macOS check counted **428 tests: 427 passed, 0 failed, 1 skipped**, duration 97.740 s. The standalone demo snapshot matches the saved pre-change snapshot byte for byte.

### Linux correction and workload results

The Linux gap above was fixed with a supplemental nonrecursive Git metadata
directory watch, which observes repeated atomic index/ref inode replacement.
Watcher retry now invalidates before announcing healthy status, covering edits
made during the outage. The same real mutation tests passed on Linux: **16
passed, 0 failed**, 24.435 s, including assume-unchanged, repeated atomic shared
ref replacement, root recreation and a subsequent native edit. Exact proof:

```bash
docker run --rm --network none -v "$PWD:/source:ro" node:24-bookworm sh -c 'mkdir -p /tmp/project && cd /source && tar --exclude=.git --exclude=node_modules --exclude=test-results -cf - . | tar -xf - -C /tmp/project && cd /tmp/project && node --test --test-concurrency=1 test/git-invalidation.test.mjs test/repository-engine.integration.test.mjs'
```

Log: `test-results/git-refresh/initial/linux-a-fixed.log`. The earlier failure
log is retained; the fix does not rely on relaxing the mutation oracle.

The six pinned Phase A 60-second quiet runs passed with zero Git launches.
Median total CPU was 0.762399 s for one rail and 6.458530 s for eight rails,
including fake-host child CPU; transitional host traffic remained 18/144
launches respectively. The full 30-run artifact is
`test-results/git-refresh/phase-a`. One eligible tracked edit caused one build
per rail (eight builds for eight rails); a subsequent burst caused another
build per rail. Ignored output and sibling-index workloads caused zero provider
builds. Poll-only recovery caused one build per rail near ten seconds. Exact
intervals, source hashes, classifier attribution and spread are recorded in
[performance evidence](PERFORMANCE.md). These are isolated fixture results,
not estimates of the user's live CPU usage.

Phase B protocol/identity modules have passed 19 tests on each of Node 22 and
24. Shared-runtime activation remains gated on the coordinator ownership,
transport and integration proofs. Final Phase B checks must include all new
runtime modules; passing Phase A does not complete the plan.

### Phase A milestone accepted

A3's final macOS mutation suite passed **29/29**, 36.631 s:
`node --test --test-concurrency=1 test/git-watch.test.mjs test/git-invalidation.test.mjs test/repository-engine.test.mjs test/repository-engine.integration.test.mjs`.
Log: `test-results/git-refresh/initial/macos-a-fixed.log`.
[Watch evidence](WATCH-EVIDENCE.md) records the Linux correction and recovery
ordering proof. [Performance evidence](PERFORMANCE.md) records all 30 clean
Phase A runs against the pinned source. Together with the full macOS check,
Node 22/24 isolated live checks, A2 clock tests, A4 context witness, and matching
snapshot above, this accepts A1–A6. The final macOS/Linux mutation runs cover the
watcher correction made after the earlier whole-suite check. Phase B's final
whole-suite checks must run on the complete integrated source.

Phase A deliberately still makes eight independent builds for an eight-client
edit and uses transitional per-rail host queries. Those known costs are the
required Phase B work; they are not waived by the quiet Git improvement.


## B1/B2 — shared runtime integration

The coordinator owns the engine registry, native watcher sets, refresh scheduling,
and one host context source. Rails retain independent UI state and subscribe over
bounded typed IPC. Namespace identity includes user, host socket, code, Git
executable and effective environment; engine identity separates worktrees,
indexes and provider semantics. Startup identity discovery remains per joining
client, but full provider construction is shared. Maps and undefined descriptor
properties survive transport. Standalone/cmux retain the in-process seam.

`npm run check` now enumerates `test/*.test.mjs` explicitly. The former recursive
Node test discovery also executed archived test copies inside ignored
`test-results/git-refresh/phase-a-pinned-source`, tripling suites and mixing old
and new implementations. All actual test entrypoints are top-level `test/`;
helpers remain imported normally. Coverage still accounts for every `src/`
module with the unchanged 95% lines / 86% branches / 95% functions thresholds.

Integration uncovered and fixed three lifecycle defects before final acceptance:

- A socket could close just before its owned daemon's exit became observable.
  The reconnect loop now retries idempotent launch election at bounded intervals
  throughout the connection window. A real owned daemon is killed in a fixture,
  and the client proves reconnection and a newer state without manual restart.
  Test cleanup checks PID plus process-start identity before acting.
- Unchanged host refresh replies could republish equivalent context, and a moved
  rail's selector could retain its obsolete pane ID. Semantic comparison now
  suppresses duplicates and preserves the learned stable terminal identity.
- Switching from shared transport to the explicit in-process fallback could
  reuse generation 1. The facade now maps transport epochs to monotonically
  increasing client generations. Unsafe relative cwd-dependent environment paths
  are rejected for sharing and use the documented typed fallback; relative
  `GIT_INDEX_FILE` remains supported and resolved against provider root.

The Sol agents completed substantial component implementation and focused proofs.
All three subsequently hit the account usage limit; the calling agent retained
and integrated their edits, finished lifecycle fixes, and owns final acceptance.
No alternative-model subagents were substituted.

### Final shared Herdr contract

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH node scripts/probe-herdr-refresh-contract.mjs \
  --isolated --verify-adapter --candidate-stage B --trials 10 \
  --deadline-ms 2000 --measure-subscribers 1,8 \
  --out test-results/git-refresh/context-b-accepted
```

Passed all ten automatically observed context trials, unchanged-context suppression, reconnect equality,
one source for one/eight actual IPC clients, and owned session/socket/root
teardown. Herdr 0.8.2 still fails the pure-event branch (cwd notifications and
unsequenced snapshot/subscription gap), so production uses one coordinator-level
1 Hz `session.snapshot` reconciliation. This is a socket request, not a Herdr
subprocess or Git refresh. Raw report: `context-b-accepted/report.json`; raw log:
`initial/context-b-accepted.log`. Initial subscription took 108.235 ms; the nine
subsequent changes converged automatically in 872.410–1131.118 ms. The final
probe waits for the production timer and never requests manual refresh during
these Phase B change trials. An earlier `context-b-final` probe explicitly
requested refreshes: it proved semantic correctness but not automatic latency;
that evidence gap was corrected before acceptance. The earlier `context-b` report failed unchanged
suppression and is retained as failed evidence, not cited as acceptance.

### Watch matrix assertion correction

The real mutation matrix deliberately removes the production two-second minimum
start cadence. A multi-step Git mutation can emit a genuinely newer invalidation
while the first provider read is in flight, requiring one follow-up. The matrix
therefore permits one or two builds and verifies strictly newer captured input
for the second read, plus complete equality to a fresh provider oracle. It reads
the first publication for each state generation: later status-only updates carry
current dirty input and cannot identify the completed read's coverage. Exact
one-build burst behavior remains independently required by deterministic
scheduler tests and the real production-cadence performance witness.


### Final regression, runtime, and artifact checks

All following commands exited zero against the integrated runtime. No coverage
threshold or source exclusion was relaxed.

| Environment / command | Result | Raw log under `test-results/git-refresh/initial/` |
| --- | --- | --- |
| macOS Node 24.19.0 `npm run check` | 499 tests, 498 pass, 1 existing skip; 107.889 s; 96.95% lines / 87.92% branches / 95.25% functions | `phase-b-check-5.log` |
| macOS Node 22.23.2 `npm run check` | 499 tests, 498 pass, 1 existing skip; 110.111 s; 96.95% / 87.96% / 95.25% | `phase-b-node22-final.log` |
| Linux Node 24.19.0 `npm run check` | 499 tests, all pass; 65.953 s; 96.93% / 87.92% / 95.25% | `linux-b-accepted.log` |
| macOS Node 24 `npm run live:release:smoke` | isolated watch-only and poll-only sessions, uninstall/restart persistence, coordinator cleanup pass | `live-b-node24-final.log` |
| macOS Node 22 `npm run live:release:smoke` | same isolated host/mode/cleanup gates pass | `live-b-node22-final.log` |
| `npm run artifact:verify` | 5 manifest runtime files and 47 recursive archive runtime dependencies verified | `artifact-b-final.log` |
| `npm run snapshot` + `cmp` against saved pre-change output | byte-identical demo output | `snapshot.txt`, `snapshot-b-final.txt` |
| `npm run lint` after adding the read-only performance verifier | pass | `final-lint.log` |

The complete suites include all B1/B2 item proof files, native watcher/provider
oracle mutations, exact scheduler counts, private owner election, IPC boundary
and backpressure failures, real daemon crash/reconnect, configuration and
worktree identity separation, preview/model compatibility, hidden render
suppression, no-content recovery and local age rendering.

Reproduction (use the actual installed Node path for each supported version):

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run check
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run check
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run live:release:smoke
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run live:release:smoke
npm run artifact:verify
npm run snapshot

docker run --rm --user node -v "$PWD:/source:ro" node:24-bookworm sh -c \
  'mkdir -p /tmp/project && cd /source && \
   tar --exclude=.git --exclude=node_modules --exclude=test-results -cf - . | \
   tar -xf - -C /tmp/project && cd /tmp/project && \
   npm ci --ignore-scripts && npm run check'
```

The Linux container is disposable and reads the checkout through a read-only
mount; dependencies and tests live under `/tmp/project`. Run as the ordinary
`node` user: a prior root run invalidated an existing chmod-based denial test,
because root bypasses that permission restriction. No production behavior was
changed to accommodate root. Network is used only to install locked dev tools;
no live Herdr sockets or user configuration are mounted.


### Implemented call paths

Line references below describe the final candidate, while the diagnostic
report's original references describe its explicitly pinned base commit.

| Responsibility | Candidate entrypoint |
| --- | --- |
| Ordinary Herdr bootstrap into shared facade | `scripts/git-rail.mjs:199` |
| Repository subscription seam; standalone/cmux engine fallback | `scripts/git-rail.mjs:239` |
| Shared facade, delivery localization and explicit compatibility fallback | `src/shared-rail-runtime.mjs:277` |
| Coordinator engine registry / shared host ownership | `src/git-state-coordinator.mjs:130` |
| Single native watcher set / root identity recovery | `src/git-invalidation.mjs:177` |
| Ignore caching and own/shared Git metadata classification | `src/git-invalidation.mjs:15`, `:47` |
| Request coalescing, captured input, non-overlap and recovery timers | `src/refresh-scheduler.mjs:21`, `:126`, `:189` |
| Full provider read, watcher updates, successful publication | `src/repository-engine.mjs:150` |
| Host semantic snapshots, suppressed equivalent delivery | `src/herdr-context-watch.mjs:23` |
| Owner election and reconnecting client | `src/git-state-client.mjs:85`, `:275` |
| Namespace and canonical worktree/index identity | `src/git-state-identity.mjs:255`, `:422` |
| UI visibility, no-content subscription lifetime, local age timer | `src/rail-state-client.mjs:2` |

The full Git provider is intentionally retained. Sharing removes the per-tab
multiplier; filtering/coalescing removes irrelevant or duplicate reads. A real
relevant change still builds the full model, and larger repositories can take
longer than the small-fixture latency. Partial history/ref caching is deferred.
The implementation retains one Node UI process per tab and transports snapshots
to each subscriber, so this work does not claim proportional RSS reduction.


## B3 — final performance and completion

[Final performance results](PERFORMANCE.md) preserve all six quiet samples,
all workload medians, before/after edit amplification, runtime fingerprints,
commands, attribution and limitations. The checked-in
`verify-refresh-performance.mjs` passed 32 actual-rail runs; its durable output
is [PERFORMANCE-ACCEPTANCE.json](PERFORMANCE-ACCEPTANCE.json).

- One/eight clients each perform zero Git launches over all three >=60-second
  healthy quiet windows. Application CPU medians are 0.069602 / 0.104186 s,
  respectively 3.54% / 0.66% of the matched fixture baseline, below the <=25%
  target. The coordinator, owned context fixture and available child CPU are
  included; this is not a live Herdr CPU improvement claim.
- Every startup has one provider build. A same-worktree edit takes one build /
  17 Git processes across eight rails, compared with eight builds / 136 in
  Phase A. All eight receive the same generation. Eligible delivery is
  262–300 ms; ignored and sibling-index activity produce no full builds.
- One eight-client 361.225-second healthy window has exactly one reconciliation,
  20 Git processes (17 provider + 3 dependency probes), and eight publications.
  Degraded recovery also has one shared provider read.
- Every fixture releases its processes and namespace. Packaged runtime imports,
  actual unpacked launch, shutdown and socket cleanup pass. The final verifier
  checks all 44 relevant production runtime file hashes against the worktree.

```sh
node scripts/verify-refresh-performance.mjs \
  test-results/git-refresh/baseline test-results/git-refresh/phase-b-accepted \
  test-results/git-refresh/reconciliation-final test-results/git-refresh/packaged-final
```

### Acceptance index

| Criteria | Passed evidence |
| --- | --- |
| AC-1a / AC-1b | Six zero-Git quiet runs; shared startup/late-join tests; one long reconciliation |
| AC-2 | Exact injected-clock scheduling/non-overlap/mid-read proofs; six shared edit/burst runs |
| AC-3 | Real macOS/Linux mutation matrix versus complete provider oracle; eligible timing and shared generations |
| AC-4 | Ignored classification/cache and tracked-positive controls; sibling-index negative runs; unchanged host suppression |
| AC-5 | Ten automatic shared-host trials within 2 s; single source at 1/8 clients; hidden redraw / cached restore tests |
| AC-6 | Injected fallback/reconcile maximums, root replacement/outage retry, failed-read retention and actual degraded run |
| AC-7 | Simultaneous owner election, actual daemon death/reconnect, context epochs, no-content resume and bounded cleanup |
| AC-8 | Read-only index assertions; key/environment isolation; full IPC Map/descriptor codec and protocol/backpressure bounds |
| AC-9 | Node 22/24 macOS checks/live modes, Linux full check, identical snapshot, model/preview/age/config compatibility |
| AC-10 | Matched six-run CPU comparison with all owned components; exact per-workload counts and source fingerprints |
| AC-11 | One shared 17-command query set per eligible eight-client edit, versus eight sets in Phase A |

All ordered items A1–A6 and B1–B3 are complete. The remaining limits are explicit
product/environment limits rather than unmet plan gates: actual Herdr server CPU
and large-repository performance were not measured; full provider work remains
on relevant edits; unwatchable inputs need reconciliation; an incomplete Herdr
event contract requires the shared 1 Hz topology source. No live installation or
configuration was changed, no live rails were reopened or closed during
implementation, and no commit, push, publication or CI workflow was created.


## PR preparation

The user subsequently requested “create pr”, authorizing a commit, branch push
and pull request. This does not authorize rollout. The recorded isolated host
interaction sequence is preserved in
[HERDR-CONTEXT-ACCEPTANCE.json](HERDR-CONTEXT-ACCEPTANCE.json); it includes all
ten automatic transitions, elapsed times, semantic results and owned teardown.

PR preparation also compared demo snapshots at widths 36, 52 and 100 (height 46)
against a disposable archive of the base commit under Node 24. All three were
byte-identical. The fixture archive was removed; hashes are retained locally in
`test-results/git-refresh/initial/pr-snapshots.json`.


## PR review follow-up — accepted

The converged review requires one pending dirty batch distinct from an active
captured batch, bounded watcher rejection-handler bookkeeping, and a 4,096-entry
ignore-classification LRU. AD-1 and AD-2 are accepted and covered by comments and
tests: default capacity preserves the witness working set; a 200,000-event
mid-read burst captures a strictly newer input generation and resolves against
the follow-up result. No acceptance gate is changed.

Raw orchestration files and the original aggregate transcript, diagnostic
report, context recording and earlier verifier output are archived locally under
ignored `test-results/git-refresh/private-review-input/`. The exact former
`work/git-refresh/convergence-state/` path is ignored against accidental re-addition. The published decision summary
replaces verbatim transcripts; public evidence paths are normalized and are not
represented as byte-identical raw artifacts. Earlier commits remain unchanged.
Historical performance results above describe the original runtime; fresh
candidate measurements for the reviewed runtime are recorded below.


### Review follow-up regression proofs

| Proof | Result | Raw log under `test-results/git-refresh/initial/` |
| --- | --- | --- |
| Node 24 focused scheduler/engine/classifier tests | 30 passed, 0 failed; 542 ms | `review-focused.log` |
| macOS Node 24 full check | 505 tests, 504 passed, 1 existing skip; 137.202 s; coverage 96.97% lines / 88.05% branches / 95.25% functions | `review-node24-check.log` |
| macOS Node 22 full check | 505 tests, 504 passed, 1 existing skip; 133.197 s; coverage 96.95% / 87.94% / 95.25% | `review-node22-check.log` |
| Linux Node 24 full check (ordinary `node` user) | 505 passed, 0 failed; 69.603 s; coverage 96.95% / 87.93% / 95.25% | `review-linux-check.log` |
| Node 22/24 isolated Herdr watch-only and poll-only modes | both pass, including owned coordinator cleanup | `review-live-node22.log`, `review-live-node24.log` |
| Artifact verification and standard demo snapshot | 5 manifest entries / 47 runtime dependencies; byte-identical baseline snapshot | `review-artifact.log`, `review-snapshot.txt` |
| Automatic host-context probe | 10/10 within 2 seconds; 104.062–1070.947 ms including bootstrap; unchanged/reconnect/source-sharing/cleanup all pass | `review-host-context.log` |

AD-1 is implemented beside `DEFAULT_IGNORE_CACHE_LIMIT = 4_096` in
`src/git-invalidation.mjs`. The constructor's smaller capacity is injected only
in `test/git-invalidation.test.mjs`, never in a production or witness launcher.
The LRU tests cover cached true/false promotion, eviction, batched reclassification,
capacity across a larger batch, dependency clearing and close.

AD-2 is pinned by the named large-mid-read-burst test in
`test/refresh-scheduler.test.mjs`: the active read's captured input stays unchanged;
the follow-up captures exactly 200,000 newer invalidations, strictly greater
than the active generation; and the mid-read request remains unresolved after
the earlier read finishes, then resolves to the follow-up's result. The companion
pre-read 200,000-event test asserts one deferred, timer and status notification.
The watcher-path engine test independently checks one rejection handler per batch
across 400,000 callbacks and verifies retained state after follow-up failure.

Commands use the same forms as the original regression section. The fresh host
probe adds `--out test-results/git-refresh/review-host-context`; its path-normalized
public recording replaces `HERDR-CONTEXT-ACCEPTANCE.json`, with raw recording
retained in that ignored output directory. The Linux source copy also excludes
the local `work/git-refresh/convergence-state` directory.

A publication audit found that the packaging witness copies ignored files from
disk as well as tracked source. Raw transcripts were therefore moved into the
excluded local `test-results/git-refresh/private-review-input/convergence-state/`
archive, and the package witness was rerun into `review-packaged-public`.
An explicit archive-content check passed: no raw convergence-state members and
no personal home prefix in docs/work files. The first `review-packaged` run is
retained as runtime-only intermediate evidence, not final publication evidence.
The compare/long snapshots and final package have different whole-tree hashes
because of this documentation-only cleanup; all 44 production runtime hashes are
identical and remain checked against the delivered candidate by the verifier.


### Rejected warm-up sample and stricter measurement boundary

The first review compare is not accepted. In `review-candidate` run
`ignored-c8-r2`, the old 600 ms file-log-silence check ended startup while the
initial provider was still reading (startup: one provider start, zero finishes,
zero client snapshots). Its 3,139 ms initial read completed inside the workload
window, which then counted 18 Git launches. The classifier itself recorded two
launches and zero invalidations, so this was startup leakage, not cache eviction.
The unchanged acceptance verifier rejects the missing startup publications.
Raw failed artifacts and `initial/review-rejected-verifier.log` are preserved.

The witness now requires all Phase B clients to have their initial snapshot and
all started providers to finish before the settle interval can complete. End
boundaries also wait for provider completion. This strengthens measurement
isolation without changing production code, expected counts, CPU accounting,
verifier rules, baseline artifacts or threshold values. It addresses an observed
invalid sample rather than discarding a slow measurement. The entire candidate
matrix, long reconciliation and packaged witness are rerun into new empty
`review-accepted`, `review-reconciliation-accepted` and
`review-package-accepted` directories. The final measurement record below binds
the unchanged production runtime to those new artifacts.


The stricter startup boundary was also checked with an isolated disposable Git
shim that sleeps 1.5 seconds before `git status`, then execs `/usr/bin/git` with
the original arguments. The ordinary one-client Phase B witness (2 s quiet
window) observed a 1,799 ms startup provider, one completed startup/publication,
and zero quiet Git/provider/publication activity. Owned cleanup passed and the
shim directory was removed. Raw proof: `review-slow-startup/` and
`initial/review-slow-startup.log`. This is a boundary regression witness, not a
CPU comparison; acceptance measurements run without the shim. `npm run lint`
passes after the witness-only change (`initial/review-final-lint.log`). The
already-passed runtime tests still match all three unchanged production fixes.


### Accepted review evidence

The unchanged `scripts/verify-refresh-performance.mjs` exited 0 with
`passed: true` and `runsVerified: 32` for `review-accepted`,
`review-reconciliation-accepted`, and `review-package-accepted`, compared with
the original archived baseline. Its exact generated output replaces
[PERFORMANCE-ACCEPTANCE.json](PERFORMANCE-ACCEPTANCE.json); no hashes or gates
were edited. [PERFORMANCE.md](PERFORMANCE.md#accepted-pr-review-rerun--2026-09-16)
records the samples, counts, fingerprints, cleanup and reproducible commands.
All 44 runtime hashes match current source. Median quiet CPU is 3.563% / 0.436%
of baseline at one/eight clients; every quiet window launches zero Git commands.
All ignored windows retain exactly two classifier commands, satisfying AD-1.
AD-2's generation and promise-settlement regression passes in all three full
platform/runtime checks above. All three agreed findings and both addenda are
resolved; no review item remains deferred.

Publication cleanup is a forward change: engineering artifacts remain, raw
orchestration files are preserved locally outside the published tree, and home
paths are normalized. Earlier commits still retain their historical contents;
this work does not rewrite history. Live user rails, focus, configuration and
installation were unchanged.
