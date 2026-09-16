# Refresh performance witness

This note records the isolated baseline and staged measurements for the refresh redesign. Original acceptance sections describe the initial PR runtime; the final section records the fresh PR-review candidate. Historical numerical results are retained unchanged. The machine-readable evidence is under `test-results/git-refresh/baseline/` (ignored by Git because it contains raw run output). The checked-in witness is `scripts/refresh-performance.mjs`.

## Instrumentation contract

The witness extracts the exact baseline revision with `git archive`; it never runs the baseline from the edited worktree. Each run creates a separate disposable Git repository with two fixed-date commits, a dirty tracked file, an untracked file, and a linked sibling worktree. One or eight actual `scripts/git-rail.mjs` processes read that same primary worktree. HOME and every XDG directory are isolated from the user and shared within a run, which preserves identical provider-environment identity for clients that should share in Phase B. The witness removes the repository and source extraction after the run and verifies that rail processes exited.

All clients in a run receive the same instrumentation paths. This is required for the later shared-state candidate: a per-client `GIT_TRACE2_EVENT` value is a Git-affecting environment difference and could prevent otherwise-compatible clients from sharing state. Counts are consequently exact for the run as a group, rather than attributed to individual rails.

- Git launches are exact `start` records from Git Trace2. Trace2 is enabled only in the rails, so fixture-setup Git commands are excluded.
- Host requests are exact start records from an owned fake Herdr executable. It implements only the three read-only pane queries used by the baseline and returns a fixed per-client tab whose content cwd is the disposable repository.
- On macOS, boundary samples use `proc_pid_rusage(RUSAGE_INFO_V1)` plus `mach_timebase_info`. They record each rail's own CPU and cumulative CPU for exited children. The child figure therefore includes every completed Git and fake-Herdr subprocess without fast-process sampling loss. Linux uses `/proc/<pid>/stat` self and child ticks. Unsupported hosts mark CPU unavailable.
- Startup ends after the Git and Herdr logs have stopped changing for the configured settle interval. The measured window starts at that quiescent boundary, lasts at least the requested duration, and extends only until final in-flight logged activity has settled. Startup and steady-state CPU are separate.
- The fake Herdr helper records its own `process.cpuUsage`, but that value is already included in waited-child CPU. It is useful for boundary checks and must not be added again.
- The later shared coordinator and host source must append component lifecycle records to the shared `GIT_RAIL_PERFORMANCE_LOG`: `{"event":"component","phase":"started|ready|stopped","role":"...","pid":123,"owner":"optional"}`. The harness samples each active unique PID once. A Phase B CPU comparison is incomplete if those processes are not registered.

The application total excludes the benchmark harness, system-wide kernel process-creation cost, the real Herdr server, and any candidate component that fails to register. The owned fake Herdr is deliberately included in child CPU. Its Node startup cost is not a measurement of the real Herdr CLI, so the baseline describes this reproducible witness rather than live-host CPU. Final comparisons use the same fixture topology and CPU availability set. The baseline reaches the owned host fixture through its CLI protocol; Phase B reaches the equivalent fixture through the production socket protocol. Both fixture costs are counted. The removed Node CLI startup cost is part of this modeled comparison, not a measurement of Rust Herdr CLI savings.

## Reproduction

```sh
node scripts/refresh-performance.mjs \
  --mode baseline \
  --baseline-revision 6603d33c61b6646b4a54806b028961c8fd1379e2 \
  --clients 1,8 \
  --quiet-ms 60000 \
  --repeats 3 \
  --out test-results/git-refresh/baseline
```

The output directory must be empty. `manifest.json` records the request, source commit/tree/archive hash, platform, and instrumentation contract. Each `runs/<id>/result.json` contains startup and measurement boundaries, per-rail CPU, exact commands, counts, workload events, and teardown assertions. `summary.json` reports every run plus median and min/max spread; it does not discard noisy runs.

Candidate and comparison modes use the same entry point. The checked-in workload drivers cover `quiet`, `edit-burst`, `ignored`, `sibling-index`, `recovery`, and `reconciliation`. Candidate runs record trigger/provider/snapshot/render and registered-component evidence in addition to the launch and CPU counters. In Phase B, the witness supplies an owned Unix-socket Herdr snapshot fixture with one content pane and one real rail process per client; it includes that host fixture and the candidate coordinator in CPU totals. `packaged-smoke` creates, unpacks, and verifies a disposable candidate archive, executes a real rail from the unpacked copy, and verifies coordinator and socket cleanup.

## Baseline result

The required run completed on 2026-09-16 on macOS 25.6.0, Apple M3 Max (16 logical CPUs), Node v26.7.0, and Apple Git 2.50.1. The baseline source was commit `6603d33c61b6646b4a54806b028961c8fd1379e2`, tree `2f77bd640039136b5ae955531738d4f56dc2a5d5`, with archive SHA-256 `5a68cb78f607970fe023d951651707013eee33719e5afb63fc02e4baa2c2076f`.

| Clients | Run | Window (s) | Git launches | Herdr launches | Rail CPU (s) | Child CPU (s) | Total measured CPU (s) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 60.620 | 102 | 18 | 0.175067 | 1.816931 | 1.991998 |
| 1 | 2 | 60.620 | 85 | 15 | 0.144951 | 1.511786 | 1.656737 |
| 1 | 3 | 60.628 | 102 | 18 | 0.172229 | 1.794158 | 1.966387 |
| 8 | 1 | 60.771 | 816 | 144 | 1.429687 | 14.806459 | 16.236145 |
| 8 | 2 | 61.511 | 799 | 141 | 1.389388 | 14.427168 | 15.816556 |
| 8 | 3 | 61.309 | 799 | 141 | 1.387738 | 14.416445 | 15.804184 |

Every startup recorded exactly 19 Git launches and three Herdr queries per rail: 19/3 in each one-client run and 152/24 in each eight-client run. Median startup CPU was 0.090772 seconds rail plus 0.306199 seconds children for one client, and 0.908698 seconds rail plus 3.687821 seconds children for eight clients. Startup is separate from the table.

The quiet medians were:

| Clients | Window (s) | Git launches (range) | Herdr launches (range) | Rail CPU (s, range) | Child CPU (s, range) | Total CPU (s, range) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 60.620 | 102 (85–102) | 18 (15–18) | 0.172229 (0.144951–0.175067) | 1.794158 (1.511786–1.816931) | 1.966387 (1.656737–1.991998) |
| 8 | 61.309 | 799 (799–816) | 141 (141–144) | 1.389388 (1.387738–1.429687) | 14.427168 (14.416445–14.806459) | 15.816556 (15.804184–16.236145) |

The command relationship is exact: each completed baseline refresh accounts for 17 Git launches and three Herdr queries. The quiet samples therefore contain five or six refreshes for one client and 47 or 48 independent refreshes across eight clients. The 8-client median had 7.83 times the Git launches and 8.04 times the total measured CPU of the 1-client median; the small deviation from eight is the independent ±10% timer jitter.

At the medians, rail self CPU alone was about 0.28% of one core for one client and 2.27% for eight. Including exited children, the totals were about 3.2% and 25.8% of one core. This is an isolated small fixture with an owned Node-based Herdr stand-in, not a claim about sustained live Herdr load. In the median samples, fake-Herdr CPU was 0.676525 seconds for one client and 4.967887 seconds for eight; the remaining waited-child CPU, attributable to Git in this baseline topology, was 1.117633 and 9.462142 seconds respectively.

All six result files assert that their rails exited and fixture repository was removed. `summary.json` asserts that the shared temporary source/fixture root was removed. No live Herdr session, installation, or user configuration was accessed.

Node 22.23.2 and Node 24.19.0 are installed locally under Homebrew. The required baseline command used the shell's Node 26.7.0. A one-second isolated startup/teardown witness run under each supported version completed with exactly 19 startup Git launches, three startup Herdr launches, rail exit, fixture removal, and temporary-root removal:

```sh
/opt/homebrew/opt/node@22/bin/node scripts/refresh-performance.mjs \
  --mode baseline --baseline-revision 6603d33c61b6646b4a54806b028961c8fd1379e2 \
  --clients 1 --quiet-ms 1000 --repeats 1 --out "$EMPTY_NODE22_OUTPUT"

/opt/homebrew/opt/node@24/bin/node scripts/refresh-performance.mjs \
  --mode baseline --baseline-revision 6603d33c61b6646b4a54806b028961c8fd1379e2 \
  --clients 1 --quiet-ms 1000 --repeats 1 --out "$EMPTY_NODE24_OUTPUT"
```

Those short witnesses prove harness startup compatibility only. Supported-runtime release checks remain an A6 requirement.

## Phase A milestone result

The Phase A witness used a frozen candidate source snapshot, SHA-256 `55cda6465de0a8b67d8d8a15c6901df809bc8b46f82ab067871c7b1bfd2558e8`, and harness SHA-256 `04912110ed4106b78b4010c7e2fd1281c5ff8eb0bda8ccfbce2b0fdd9a137928`. The long quiet group and the bounded active groups were run separately so active workloads did not spend unnecessary 60-second idle windows. Their manifests prove the same source and harness hashes; `test-results/git-refresh/phase-a/` combines all 30 raw runs and records both exact commands.

The required 60-second quiet samples were:

| Clients | Run | Window (s) | Git launches | Herdr launches | Rail CPU (s) | Child CPU (s) | Total measured CPU (s) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 60.611 | 0 | 12 | 0.026507 | 0.503318 | 0.529825 |
| 1 | 2 | 60.612 | 0 | 18 | 0.030786 | 0.742453 | 0.773239 |
| 1 | 3 | 60.608 | 0 | 18 | 0.028876 | 0.733523 | 0.762399 |
| 8 | 1 | 60.629 | 0 | 144 | 0.202991 | 6.255539 | 6.458530 |
| 8 | 2 | 60.620 | 0 | 144 | 0.178874 | 5.511516 | 5.690390 |
| 8 | 3 | 60.627 | 0 | 144 | 0.217978 | 6.350093 | 6.568071 |

All six healthy quiet windows launched zero Git processes and performed zero provider builds or snapshot publications. Each rail rendered once from its local age timer without a provider read. The host-query fallback stayed at or below the baseline rate: the one-client range was 12–18 and the eight-client value was 144. The 1-client quiet CPU median was 0.762399 seconds, 38.8% of its matched baseline median; the 8-client median was 6.458530 seconds, 40.8% of baseline. Phase A intentionally retains one context source and one repository engine per rail, so these ratios are milestone measurements and do not claim the final shared-system CPU gate. The Node fake-Herdr process accounted for 0.699972 of the 1-client median and 5.945311 seconds of the 8-client median; the fixture helper dominates the candidate child CPU and is not an estimate of the real Rust Herdr server.

Phase A startup recorded one provider build per rail, 22 Git launches and three fake-Herdr launches per rail. The three additional startup Git launches relative to baseline discover watcher/config dependencies. Startup is outside every tabled window.

The bounded workload medians were:

| Workload | Clients | Window (s) | Provider builds | Git launches | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| eligible edit plus burst | 1 | 6.620 | 2 | 34 | one build for the eligible edit and one coalesced burst build |
| eligible edit plus burst | 8 | 6.641 | 16 | 272 | eight independent Phase A engines built once per window |
| ignored directory/file noise | 1 | 6.610 | 0 | 2 | one classifier for directory creation, one for the first file event; later same-path writes were cached |
| ignored directory/file noise | 8 | 6.624 | 0 | 16 | the same two bounded classifiers per independent engine |
| sibling index | 1 | 6.613 | 0 | 0 | private sibling activity was filtered |
| sibling index | 8 | 6.625 | 0 | 0 | private sibling activity was filtered in every engine |
| poll-only recovery | 1 | 12.614 | 1 | 17 | one degraded fallback full read |
| poll-only recovery | 8 | 12.631 | 8 | 136 | one degraded fallback full read per Phase A engine |

For the edit witness, the first tracked write occurred 2.1 seconds after the post-startup measurement boundary. Its provider starts were separated from the later eight-write burst: the eight-client raw logs contain exactly eight starts for the first window and eight for the burst. Each successful build produced one `rail-snapshot` and one visible `rail-render` record. The ignored test intentionally creates an ignored directory and then writes the same known file twelve times; writes two through twelve add no classifier process. Phase B must use the identical two-path fixture so its before/after launch count remains matched.

All 30 Phase A result files assert clean rail exit and fixture removal; the two source-run summaries assert temporary-root removal. The merged artifact retains all raw Trace2, host, and debug logs. No live Herdr target was inherited: the launcher strips all inherited `HERDR_`, `CMUX_`, `GIT_`, and `REFRESH_` variables before adding controlled fixture values.

## Limits for later decisions

The baseline alone is not evidence that a candidate is faster. Candidate comparisons below use pinned patch identities against the same fixture shape and report all three samples. The final CPU ratio may include a component only when baseline and candidate measure it consistently. Exact launch-count acceptance remains independent of CPU availability.

The isolated host intentionally returns a stable cwd. It measures the baseline's repeated context subprocess cost, but it does not measure Herdr server CPU, event delivery, focus/move correctness, or reconnect behavior; the separate A1 Herdr contract witness owns those proofs. The quiet run also does not substitute for edit, ignored-noise, sibling-index, recovery, or long reconciliation evidence.


## Original Phase B quiet and reconciliation measurements

The original accepted candidate measurements use snapshot SHA-256
`b9cb5f1c1ef860504daff1bbe3a6d6f9b335c648d8c5c905eee5fdce6e795893`
and witness SHA-256
`9e85d957b23588ff6b6f6aab60e4c7e38ba602681d54374b00e4b72265a59b54`.
The manifests additionally record every one of the 44 production runtime file
hashes. The read-only verifier compares them to the delivered worktree, so later
evidence/test-document edits do not obscure which runtime was measured.

These are actual rail processes against disposable Git worktrees and a private
socket-host fixture. One coordinator and the owned host fixture are both sampled
and counted once, including exited child CPU. `hostAccounting` distinguishes
socket requests from subprocesses; the legacy raw field `herdrLaunches` holds
host request counts in Phase B and must not be described as process creation.
Those original Phase B runs used Node 26.7.0 / Apple Git 2.50.1 / macOS 25.6.0 on the
same M3 Max as the archived baseline. Functional compatibility is independently
proven on Node 22/24 and Linux. Other isolated acceptance checks ran concurrently
with some intervals; only owned application process CPU is included, and the
three samples/spread are retained.

| Clients | Run | Window (s) | Git processes | Host socket requests | Self CPU (s), including coordinator/host | Exited child CPU (s) | Total CPU (s) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 60.610 | 0 | 60 | 0.059264 | 0.000000 | 0.059264 |
| 1 | 2 | 60.918 | 0 | 61 | 0.069602 | 0.000000 | 0.069602 |
| 1 | 3 | 60.915 | 0 | 61 | 0.083613 | 0.000000 | 0.083613 |
| 8 | 1 | 61.122 | 0 | 61 | 0.104773 | 0.000000 | 0.104773 |
| 8 | 2 | 60.817 | 0 | 61 | 0.098877 | 0.000000 | 0.098877 |
| 8 | 3 | 60.812 | 0 | 61 | 0.104186 | 0.000000 | 0.104186 |

The one-client CPU median is **0.069602 s**, range 0.059264–0.083613 s:
**3.54%** of the matched 1.966387 s baseline median. The eight-client median is
**0.104186 s**, range 0.098877–0.104773 s: **0.66%** of the matched 15.816556 s
baseline median. Both pass the planned <=25% gate. These are CPU-seconds over
approximately one minute, not percentages of total machine CPU. All six quiet
windows have zero Git launches, zero provider builds, and zero repository
publications. There is one visible age-timer redraw; hidden rails do not redraw.

These ratios apply only to this small isolated fixture. They include replacing
repeated Node fake-host CLI startups with socket requests; the actual Herdr CLI
is Rust. Real Herdr server CPU, large repositories, active user workloads and
live multi-workspace savings were not benchmarked. The original live 18% sample
remains an observation with unknown duration, not the baseline for these ratios.

The separate eight-rail **361.225-second** window performed exactly one healthy
reconciliation: **one provider build, 20 Git processes** (17 provider commands +
3 watcher/config dependency probes), eight snapshot publications and seven
renders in the single visible rail (six local age ticks plus the publication).
The one shared context source made 360 socket requests and no host subprocesses.
Measured total application CPU was 0.785996 s. Closing the rails released the
single coordinator and its namespace artifacts within 1.029 s; fixture and
source roots were removed. Raw evidence: `reconciliation-final/`.


## Original active-workload and packaging acceptance

All three repetitions at each client count passed the following production
runtime checks. The table reports medians; process/build counts were identical
across all three runs in every row.

| Workload | Clients | Window (s) | Provider builds | Git processes | Snapshot publications | Visible renders |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| edit-burst | 1 | 6.816 | 2 | 34 | 2 | 2 |
| edit-burst | 8 | 6.717 | 2 | 34 | 16 | 2 |
| ignored | 1 | 6.814 | 0 | 2 | 0 | 0 |
| ignored | 8 | 6.716 | 0 | 2 | 0 | 0 |
| sibling-index | 1 | 6.813 | 0 | 0 | 0 | 0 |
| sibling-index | 8 | 6.715 | 0 | 0 | 0 | 0 |
| recovery | 1 | 12.815 | 1 | 17 | 1 | 1 |
| recovery | 8 | 12.714 | 1 | 17 | 8 | 1 |

The eligible edit and eight-write burst each cause **one build / 17 Git
processes**, delivered to every subscriber with the same generation. The
identical Phase A eight-client edit needed eight builds / 136 Git processes;
the final eight-client edit needs one / 17. The combined edit-plus-burst total
is 34, compared with Phase A's 272. Eligible starts occur 138–140 ms after the
write, provider work takes 124–161 ms, and all deliveries arrive in 262–300 ms.
Burst starts occur 238–242 ms after the first burst write and all deliveries
arrive in 348–371 ms. The throttle and genuine mid-read follow-up cases are
separately covered by deterministic scheduler tests.

Ignored noise launches two classifier commands total (one new directory and
one new file); subsequent same-path writes use the cache. It starts no provider
build. Sibling-index activity starts neither classifier nor provider. Poll-only
recovery makes one shared full read, including at eight clients. The healthy
watcher count is four in this fixture, owned by one engine; poll-only installs
zero. These counts are fixture-specific dependency roots, not a universal
watcher count for all repositories.

Every run initializes exactly one provider and one coordinator. Startup is 26
Git launches for one rail and 54 for eight: four identity probes per joining
client plus the one 22-command provider/watch bootstrap. Joining clients still
need identity resolution, but do not repeat the full state build. Quiet windows
make approximately one host socket request per second independent of client
count, with **zero Herdr CLI subprocesses**. For a single rail this is more host
requests than the baseline ten-second CLI path, traded for prompt cwd freshness
and avoiding subprocess startup. A complete, ordered future Herdr event stream
could remove this remaining topology polling.

All 30 workload runs released their coordinator and namespace files in
**1.021–1.031 seconds** after client exit; all
rails, owned host fixtures, repositories and extracted sources were removed.
The packaged witness verified five manifest runtime files and 47 recursive
runtime imports, then ran a real rail from the unpacked candidate archive. It
built once, launched zero quiet Git processes, and released its coordinator in
1.026 s. Archive SHA-256:
`2d98403f411cb2d2937e938051c015b92f7be0c6b0bff871a5c9d8705d52d421`.

The checked-in read-only verifier passed **32 runs** (30 workload runs, the
long reconciliation run, and the packaged run), including current runtime hash
identity, matched hardware/runtime/CPU accounting, both <=25% median CPU gates,
exact command/build counts, shared generations, eligible edit timing, hidden
redraw suppression, and complete cleanup. Its output is
[PERFORMANCE-ACCEPTANCE.json](PERFORMANCE-ACCEPTANCE.json).

```sh
node scripts/refresh-performance.mjs --mode compare --candidate-stage B \
  --baseline test-results/git-refresh/baseline --clients 1,8 --quiet-ms 60000 \
  --workloads quiet,edit-burst,ignored,sibling-index,recovery --repeats 3 \
  --out test-results/git-refresh/phase-b-accepted
node scripts/refresh-performance.mjs --mode candidate --candidate-stage B \
  --clients 8 --quiet-ms 360000 --workloads reconciliation --repeats 1 \
  --out test-results/git-refresh/reconciliation-final
node scripts/refresh-performance.mjs --mode packaged-smoke --candidate-stage B \
  --clients 1 --quiet-ms 2000 --repeats 1 \
  --out test-results/git-refresh/packaged-final
node scripts/verify-refresh-performance.mjs \
  test-results/git-refresh/baseline test-results/git-refresh/phase-b-accepted \
  test-results/git-refresh/reconciliation-final test-results/git-refresh/packaged-final
```

Use new empty output directories when reproducing. Earlier `phase-b`,
`phase-b-final`, and `reconciliation` artifacts exercised intermediate source
snapshots. They remain available as development evidence but are not the final
candidate's acceptance measurements. Raw final artifacts live under ignored
`test-results/git-refresh/`; the tables, commands, source identity and verifier
output above are the durable repository record.


## First PR-review run (not accepted): warm-up boundary failure

These initial review measurements use the same archived baseline and original
witness. The full run is **not accepted**: an ignored-workload window began
before the initial provider completed. Its raw evidence is retained, and the
stricter complete rerun is recorded below. The acceptance verifier is unchanged. The default ignore-cache limit is 4,096; the
witness never injects the small limits used in classifier unit tests. The
runtime now coalesces large dirty bursts into one pending batch separate from
any captured read and attaches one watcher rejection handler per batch.

Compare and reconciliation source snapshot SHA-256:
`2bab0021527de0cf1c4a63902690d4aaf190e0c4d0d317bb9f8dcda0d0fd1b6a`.
Final public-package source snapshot SHA-256:
`1c26b75eea8e93ba598560f4308e50410b1ccda043d037eae07b3edda0407b26`.
The whole-tree difference is publication-document cleanup; all 44 production
runtime file hashes are identical. Witness SHA-256 remains
`9e85d957b23588ff6b6f6aab60e4c7e38ba602681d54374b00e4b72265a59b54`.
No recorded hashes or acceptance thresholds were manually substituted.

| Clients | Run | Window (s) | Git processes | Host socket requests | Total application CPU (s) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 60.613 | 0 | 60 | 0.064018 |
| 1 | 2 | 60.812 | 0 | 61 | 0.065195 |
| 1 | 3 | 60.814 | 0 | 61 | 0.076300 |
| 8 | 1 | 61.113 | 0 | 61 | 0.077008 |
| 8 | 2 | 61.141 | 0 | 61 | 0.065100 |
| 8 | 3 | 61.221 | 0 | 61 | 0.070293 |

The CPU accounting includes rails, coordinator, owned host fixture and waited
children, as in the original comparison. These remain isolated fixture results,
not a live Herdr CPU measurement or an additional improvement claim relative
to the original candidate; ordinary sample variation is expected.

The fresh eight-client reconciliation window lasts **360.713 seconds** and
performs exactly **one provider build / 20 Git commands**, publishes to all eight
rails, and makes 360 host socket requests with zero host subprocesses. Total
application CPU is 0.697290 s. Its owned coordinator and namespace clean up in
1.031 s. The exact healthy maximum is still covered by injected-clock tests.


## Accepted PR-review rerun — 2026-09-16

The unchanged verifier passes **32/32 runs** against the same archived baseline
`6603d33c61b6646b4a54806b028961c8fd1379e2`. All three fresh witnesses use the
stricter startup/end boundaries described in [EVIDENCE.md](EVIDENCE.md).
Platform and CPU accounting match the archived baseline: macOS 25.6 on M3 Max
(16 CPUs), Node 26.7.0, Apple Git 2.50.1, application self plus waited-child CPU.

| Clients | Run | Window (s) | Git processes | Host socket requests | Total application CPU (s) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 61.040 | 0 | 61 | 0.070070 |
| 1 | 2 | 61.215 | 0 | 61 | 0.074129 |
| 1 | 3 | 60.816 | 0 | 61 | 0.059416 |
| 8 | 1 | 61.222 | 0 | 61 | 0.074022 |
| 8 | 2 | 60.911 | 0 | 61 | 0.066921 |
| 8 | 3 | 61.127 | 0 | 61 | 0.068924 |

At 1 client(s), median CPU is **0.070070 s** (range 0.059416–0.074129) versus baseline **1.966387 s**: **3.563%** of baseline, below the unchanged 25% gate.

At 8 client(s), median CPU is **0.068924 s** (range 0.066921–0.074022) versus baseline **15.816556 s**: **0.436%** of baseline, below the unchanged 25% gate.

These isolated fixture results establish the candidate's comparison with the
archived polling implementation. They do not establish sustained live Herdr CPU
or an additional CPU reduction over the original shared-state candidate. All
quiet windows have zero provider builds, Git launches and state publications;
one deliberate visibility redraw occurs. Host socket sampling remains shared
at approximately 1 Hz, with zero Herdr CLI subprocesses.

Each row below represents all six repetitions (three each at one/eight clients).
Counts exclude startup and are exact Trace2/provider records.

| Workload | Provider builds | Git launches | State publications (1 / 8 clients) |
| --- | ---: | ---: | ---: |
| Single edit plus burst | 2 | 34 | 2 / 16 |
| Ignored output | 0 | 2 classifier commands | 0 / 0 |
| Sibling index | 0 | 0 | 0 / 0 |
| Poll-only recovery | 1 | 17 | 1 / 8 |

AD-1's default 4,096-entry cache preserves exactly two classifier launches in
every ignored workload. Single-edit refresh starts take 137–141 ms; eligible
single-edit deliveries take 275–541 ms, below the existing 2,000 ms gate.
Burst starts take 237–267 ms and deliveries 357–642 ms. All original
verifier checks pass; no timing gate was changed.

The eight-client reconciliation window lasts **360.633 s**, with one provider
build, 20 Git launches, eight publications, 359 host socket requests and
**0.886216 s** application CPU. Owned coordinator cleanup takes 1.120 s. The
30-run matrix cleans up coordinators in 1.010–1.075 s with no namespace residue.

The packaged witness verifies five manifest files and 47 runtime dependencies,
initializes one provider, and launches zero Git commands in its quiet window.
Its coordinator cleans up in 1.073 s. The archive contains no raw convergence
transcripts or personal home paths in docs/work. Package SHA-256:
`b416294acfe48eb00aa0c947b49da53214f1f0984b9c5177d2edbe57b33a8f0a`.

All three source snapshots have SHA-256
`3504a697611c82f899cc8d7d9b107e90e3b6ac5754c7698c41c3ed9909ae0334`.
Witness SHA-256:
`51b745c324a6c283aa43c1ea40477dae0001d7bdc24b728e404a56aa1c38e611`.

All 44 runtime file hashes match the delivered worktree and are checked by the
verifier. These source snapshots precede the final evidence-text updates; the
recorded snapshot hashes are preserved exactly. Raw artifacts remain local in
ignored `test-results/git-refresh/` and the generated verifier output is
[PERFORMANCE-ACCEPTANCE.json](PERFORMANCE-ACCEPTANCE.json).

```sh
node scripts/refresh-performance.mjs --mode compare --candidate-stage B \
  --baseline test-results/git-refresh/baseline --clients 1,8 --quiet-ms 60000 \
  --workloads quiet,edit-burst,ignored,sibling-index,recovery --repeats 3 \
  --out test-results/git-refresh/review-accepted
node scripts/refresh-performance.mjs --mode candidate --candidate-stage B \
  --clients 8 --quiet-ms 360000 --workloads reconciliation --repeats 1 \
  --out test-results/git-refresh/review-reconciliation-accepted
node scripts/refresh-performance.mjs --mode packaged-smoke --candidate-stage B \
  --clients 1 --quiet-ms 2000 --repeats 1 \
  --out test-results/git-refresh/review-package-accepted
node scripts/verify-refresh-performance.mjs \
  test-results/git-refresh/baseline test-results/git-refresh/review-accepted \
  test-results/git-refresh/review-reconciliation-accepted \
  test-results/git-refresh/review-package-accepted
```

Use new empty output directories for another reproduction. The initial
`review-candidate`, `review-reconciliation`, `review-packaged`, and
`review-packaged-public` artifacts are intermediate evidence, superseded by
this accepted set. The rejected warm-up sample remains documented above.
