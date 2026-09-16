# Git-railgun CPU and Git subprocess investigation

Date: 2026-09-16. All measurement times below are UTC (EDT = UTC − 4 hours).
Repository: `KaxyotiK/git-railgun`; branch: `git-polling-cpu`;
base and inspected HEAD: `6603d33c61b6646b4a54806b028961c8fd1379e2`.

**Historical diagnostic record:** measurements, code references, and scope statements
below describe the original diagnostic assignment at that revision. The subsequent
user-authorized implementation and isolated before/after evidence are recorded in
[the implementation plan](../work/git-refresh/IMPLEMENTATION_PLAN.md),
[validation evidence](../work/git-refresh/EVIDENCE.md), and
[performance results](../work/git-refresh/PERFORMANCE.md).

Public-copy note: personal paths use `<CHECKOUT>`, `<CANONICAL_CHECKOUT>` and
`<HOME>` placeholders. Substitute local paths when reproducing commands. Numerical
measurements and original measured hashes are unchanged; the unmodified report
is retained locally. This public copy is not byte-identical to that raw report.

## Finding

The process count is principally the intended **one persistent rail per tab**, not a growing collection of duplicate helpers. Each helper independently rebuilds the entire repository model on its roughly ten-second recovery timer, even with healthy filesystem watchers and while its tab is inactive. A normal refresh launches **17 Git processes**, plus three Herdr CLI processes for content-pane discovery. Forty-one helpers therefore predict approximately **69.7 Git launches/second from polling alone** when every helper takes that normal path. This is a code-based estimate, not a measured complete launch rate.

Live measurements found **41 helpers**, about **25% of one CPU core of aggregate helper CPU over a roughly one-minute interval**, and **524 newly observed Git children in 10.010 seconds** using a faster sampler. That last number is a lower bound, not a complete exec trace. It includes 307 in the first six seconds. Thus the reported “40 helpers / 18% CPU / 66 Git processes in six seconds” is plausible, but its exact sampling conditions and duration are unknown; this investigation does not establish that 18% was sustained.

Independent rails repeat substantial work on identical checkouts: nine followed the main Merisma checkout, four its component-status worktree, and several other checkouts had two or three. Broad watchers also cause unnecessary refreshes for ignored-file writes and sibling-worktree index changes; both were reproduced in disposable fixtures. A quiet fixture did **not** show Git reads feeding back into its watchers.

**Smallest measured mitigation:** retain filesystem refreshes and use a longer recovery interval. An isolated 70-second comparison of 10 seconds versus 60 seconds reduced Git launches from 138 to 36 and helper CPU from 0.323 to 0.139 CPU-seconds. This is fixture evidence, not a live-workload performance promise. For a product change, distinguish healthy-watch recovery from watcher-failure polling, and preserve fast detection of content-pane/cwd changes. Details and tradeoffs follow.

## Scope and subsequent user-authorized closure

The investigation initially used read-only process and Herdr topology inspection. The Herdr skill was read, `HERDR_ENV=1` verified, and installed CLI help used for syntax. No additional repository `AGENTS.md` or `CLAUDE.md` was found. The canonical checkout and diagnostic worktree were both clean at the stated base before report creation. All 41 sampled helpers identified the canonical checkout as `HERDR_PLUGIN_ROOT`; current on-disk `scripts/git-rail.mjs` matched this worktree byte-for-byte (SHA-256 `b75b690ccc6ce4a9a187b3cb292651fe4db8c4962d5109416b0195efa53b630c`). Helpers had different start times, some about nine days old: matching disk files does **not** establish the exact source already loaded in each process. Live command fingerprints corroborate the main call paths described here.

During the investigation the user explicitly requested: “lets close gitrail throughout herdr at the moment.” This superseded the earlier instruction to preserve live rails. Using `herdr pane close <verified-id>`, the investigation closed **41 live rail panes and 11 rail-labelled panes containing only foreground shells**. All 52 close commands succeeded. The two rail-only tabs disappeared as a consequence. No non-target pane disappeared; concurrent session activity added one pane. Verification found **zero rail helpers and zero GitRail-labelled panes**. Herdr changed focus during closure; `herdr tab focus w3P:t18` restored the pre-close focused pane `w3P:p2K`, verified by snapshot.

During final verification, two subsequently created tabs (`wBB:t1`, `wBB:t2`) had auto-opened new rails. Those two live rail panes were also closed successfully, with the then-current focus preserved and zero labelled rails verified again. Total closed during this assignment: **43 live rail panes plus 11 shell-only remnants**. The live performance measurements above still describe the original 41-helper population.

No installation, configuration, refresh setting, or source implementation was changed. Herdr was not restarted. No processes were directly killed. **Auto-open remains enabled**, so subsequently created eligible tabs can acquire rails again. Isolated experiment processes were outside Herdr and exited through their `q` input. No commit, push, publication, or branding change was performed. Temporary samplers, preloads, traces, and repositories were removed after their results and reproduction procedures were recorded here.

## Live measurements and their limits

Host: Darwin 25.6.0, arm64; Node v26.7.0. `/usr/bin/git` dispatched to the Xcode Git executable seen in process listings. All sampled rail helpers were direct children of Herdr server PID 3624, with individual controlling TTYs. They were predominantly sleeping between bursts, not continuously runnable loops.

| Measurement | Interval / method | Observed result |
| --- | --- | --- |
| Helper CPU and count | 10:02:45.125–approximately 10:03:45; 59 `ps` snapshots, nominal 1 s cadence, 59.599 s between first/last snapshot start timestamps | 41 helpers throughout; same PID set at both endpoints; summed `TIME` increase 15.08 CPU-s; approximately 25.3% of one core |
| Instantaneous `ps %cpu` sums in that interval | Same 59 snapshots | Mean 19.89%, maximum 90.9%; these are OS instantaneous/decayed estimates, not the interval CPU calculation |
| Git seen by slow sampler | Same interval, 1 s snapshots | 72 distinct Git PIDs; 70 direct rail children (39 `ls-files`, 31 `status`); heavy undercount of short commands |
| Git seen by faster sampler | 10:04:51.057–10:05:01.067; libproc discovery, nominal 20 ms, 421 scans | 525 newly observed Git PIDs, **524 direct rail children**, one unrelated Git command; 307 rail children in first 6 s |
| Faster sampler overhead | Same 10.010 s | 0.167 CPU-s; mean scan work 0.417 ms, max 7.554 ms; actual average cadence approximately 23.8 ms |
| Background tabs | Topology plus parent-attributed fast sample | Every one of the 41 helper PIDs produced observed Git children (6–17 each); 40 of 41 rails were outside the focused tab in the resolved snapshot |
| Other Herdr CPU | Same slow interval, persistent endpoints | Server +5.85 CPU-s and persistent client +0.71 CPU-s; these include all Herdr activity and cannot be attributed solely to rails |

CPU here means `100 × sum(delta process CPU seconds) / elapsed wall seconds`; 100% means one full CPU core. The 25.3% includes Node helper user/system time, **not** their exited Git/Herdr CLI children or Herdr's own CPU. `ps TIME` has centisecond resolution and sequential process-table reads introduce timing uncertainty; report approximately 25%, not excessive decimal precision.

This was a **nominally idle rail observation**, not a controlled globally idle machine: the investigation did not type into rails or induce worktree edits during the live samples, but users/other agents remained active and topology/focus changed during inspection. Read-only CLI inspections overlapped the slow interval, including a canonical-checkout `git status --short` without an explicit optional-lock override; that command could itself refresh index metadata. The slow interval therefore is not a pristine idle baseline. No live refresh-trigger log was enabled, and no exact poll-versus-watch breakdown can be recovered. The later closure prevented a repeat live quiet sample without reopening the user's rails; none were reopened. The isolated comparison below supplies the controlled idle evidence.

The fast sampler observes process existence, not every fork/exec: commands that start and finish between scans, or are first seen before exec, can be missed. Twenty rail Git processes exited before argv retrieval; their PID/parent/name were already observed. PIDs first present in the initial scan were excluded from new counts. Do not divide the slow count by elapsed time and call that a complete creation rate. No `auto-open-herdr-tabs.mjs` process was observed in the fast interval, which likewise does not prove no very short invocation occurred.

`fs_usage -w -f exec -t 1` failed with **“'fs_usage' must be run as root...”**. No privilege escalation or tracing attachment to live helpers was attempted. User-level libproc plus `sysctl(KERN_PROCARGS2)` provided the faster lower-bound sample. Live child CPU totals, stack profiles, and exact watcher event causes remain unavailable.

### Git command frequencies directly observed in the fast interval

Each row counts distinct new direct-child Git PIDs over 10.010 seconds. Variable branch names and hashes are grouped. These are observations, **not** counts inferred from the provider.

| Command family | Observed PIDs |
| --- | ---: |
| `rev-parse --show-toplevel` | 25 |
| `rev-parse --git-common-dir` | 20 |
| `symbolic-ref --short HEAD` | 20 |
| `config -z --show-scope --get-all branch.*.gitrail-base` | 23 |
| `symbolic-ref --quiet --short refs/remotes/origin/HEAD` | 23 |
| `rev-parse --verify --quiet main^{commit}` | 21 |
| `status --porcelain=v2 -z --untracked-files=all` | 39 |
| `ls-files -v -z --stage` | 39 |
| `merge-base main HEAD` | 31 |
| `diff --cached …` | 30 |
| Working-tree `diff …` | 36 |
| Merge-base-to-worktree `diff …` | 36 |
| Merge-base-to-HEAD `diff …` | 36 |
| Commit-summary `log …` | 32 |
| Raw commit-path `log …` | 28 |
| `rev-list --first-parent --count main..HEAD` | 34 |
| `rev-list --left-right --count @{upstream}...HEAD` | 31 |
| Git name/parent observed, argv unavailable | 20 |
| **Total** | **524** |

### Topology, duplication, and orphan checks

The fresh pre-close snapshot had 21 workspaces, 44 tabs, and 101 panes. All 41 helpers mapped to existing rail panes through `herdr pane process-info` and allowlisted inherited pane/tab IDs, and there was **one live helper per distinct tab**. There were no identified OS-orphan helpers or two live helpers in the same tab. Labels alone would have overcounted: 11 additional rail-labelled panes held shells. One earlier snapshot also included a pane that disappeared before inspection; the final pre-close inventory was re-read before acting.

Two live rails, `w3P:p2W` and `w3P:p2Y`, had no content pane left in their tabs. They were attached to live Herdr panes, not OS orphans, but no longer served a content tab. Both continued to create Git children. Their last resolved repository was not captured: inherited source-pane IDs were gone, and the resolver's fallback is its previous cwd. These are lifecycle leftovers; they should not be silently grouped with the other rails' repositories.

For the other 39 rails, applying the current content-pane selection rules to the snapshot produced **19 distinct cwd targets**: 20 extra copies beyond one per target. These are exact cwd matches, not an assumption that every linked worktree has the same index. All identified targets were internal paths; no SD-backed repository was accessed. The selection is a snapshot reconstruction, not inspection of each Node process's private `currentProviderCwd` variable. The process cwd shown by Herdr is usually the plugin checkout and must not be confused with the repository passed to Git.

The following map joins process ancestry, tab identity, selected content cwd, helper CPU delta from the slow interval, and Git observations from the fast interval. Different intervals must not be combined as an exact per-refresh cost. Paths are relative to `<HOME>/`; `Projects` retains the spelling reported by Herdr.

| PID | Rail pane / tab | Selected content cwd | Helper CPU-s (~60 s) | Git PIDs (10 s) |
| ---: | --- | --- | ---: | ---: |
| 8251 | `w1G:p2D` / `w1G:t1` | `.config/skillshare` | 0.14 | 11 |
| 8286 | `w1G:p2E` / `w1G:tZ` | `.config/skillshare` | 0.15 | 6 |
| 9492 | `w1H:p2S` / `w1H:t1` | `Projects/grove/repos/herdr-gitrail` | 0.18 | 14 |
| 12158 | `w1M:pB` / `w1M:t1` | `Projects/CPQ/repos/quote-engine` | 0.36 | 14 |
| 11827 | `w1M:pA` / `w1M:t2` | `Projects/CPQ/repos/quote-engine` | 0.43 | 15 |
| 13906 | `w3P:p10` / `w3P:t0` | `Projects/CPQ/repos/Merisma` | 0.32 | 14 |
| 15080 | `w3P:p23` / `w3P:t11` | `Projects/CPQ/repos/Merisma` | 0.38 | 12 |
| 87100 | `w3P:p2B` / `w3P:t13` | `Projects/CPQ/repos/Merisma` | 0.41 | 10 |
| 5056 | `w3P:p2E` / `w3P:t14` | `Projects/CPQ/repos/Merisma` | 0.37 | 10 |
| 61489 | `w3P:p2W` / `w3P:t1A` | `Unknown: no content pane` | 0.38 | 13 |
| 69085 | `w3P:p2Y` / `w3P:t1B` | `Unknown: no content pane` | 0.36 | 13 |
| 90688 | `w3P:p32` / `w3P:t1C` | `Projects/CPQ/repos/Merisma` | 0.36 | 15 |
| 64336 | `w3P:p1H` / `w3P:tS` | `Projects/CPQ/repos/Merisma` | 0.37 | 15 |
| 39837 | `w3P:p1K` / `w3P:tT` | `Projects/CPQ/repos/Merisma` | 0.33 | 10 |
| 6366 | `w3P:p1N` / `w3P:tV` | `Projects/CPQ/repos/Merisma` | 0.37 | 13 |
| 62649 | `w3P:p1Q` / `w3P:tW` | `Projects/CPQ/repos/Merisma` | 0.37 | 12 |
| 14404 | `w42:p18` / `w42:tB` | `Projects/CPQ/market-research` | 0.67 | 15 |
| 25081 | `w42:p1E` / `w42:tJ` | `Projects/CPQ/market-research` | 0.75 | 14 |
| 9472 | `w43:p9` / `w43:t1` | `Projects/grove/repos/cmux-sidebar` | 0.14 | 13 |
| 18993 | `w5C:p5` / `w5C:t1` | `Projects/grove/worktrees/herdr-gitrail/branding-options` | 0.18 | 10 |
| 19205 | `w5C:p6` / `w5C:t2` | `Projects/grove/worktrees/herdr-gitrail/branding-options` | 0.17 | 14 |
| 9676 | `w5F:p3` / `w5F:t1` | `Projects/grove/repos/grove-cli` | 0.14 | 11 |
| 9714 | `w5G:p5` / `w5G:t1` | `Projects/grove/worktrees/grove-cli-cmux/grove-cmux-v1` | 0.16 | 13 |
| 21009 | `w6P:p3` / `w6P:t1` | `Projects/grove/worktrees/grove-cli-cmux/grove-cmux-branding` | 0.16 | 9 |
| 22136 | `w6V:p3` / `w6V:t1` | `Projects/grove/worktrees/grove-cli-cmux/grove-cmux-skill` | 0.20 | 11 |
| 57028 | `wA6:p2` / `wA6:t1` | `Projects/CPQ/worktrees/market-research/stripe-materialization` | 0.73 | 11 |
| 26928 | `wAV:p2` / `wAV:t1` | `Projects/CPQ/worktrees/Merisma/c1-first-bound-case` | 0.47 | 14 |
| 68601 | `wAV:p1E` / `wAV:t9` | `Projects/CPQ/worktrees/Merisma/c1-first-bound-case` | 0.48 | 14 |
| 45148 | `wB4:p2` / `wB4:t1` | `Projects/CPQ/worktrees/Merisma/component-status` | 0.41 | 10 |
| 74828 | `wB4:p4` / `wB4:t2` | `Projects/CPQ/worktrees/Merisma/component-status` | 0.41 | 13 |
| 92187 | `wB4:pA` / `wB4:t3` | `Projects/CPQ/worktrees/Merisma/component-status` | 0.39 | 16 |
| 69411 | `wB4:pV` / `wB4:t4` | `Projects/CPQ/worktrees/Merisma/component-status` | 0.47 | 14 |
| 24381 | `wB6:p2` / `wB6:t1` | `Projects/CPQ/worktrees/market-research/stripe-package-review` | 0.77 | 14 |
| 91509 | `wB7:p2` / `wB7:t1` | `Projects/CPQ/worktrees/Merisma/graph-gen-build` | 0.48 | 15 |
| 88318 | `wB7:p4` / `wB7:t2` | `Projects/CPQ/worktrees/Merisma/graph-gen-build` | 0.50 | 14 |
| 34799 | `wB7:pF` / `wB7:t3` | `Projects/CPQ/worktrees/Merisma/graph-gen-build` | 0.44 | 14 |
| 50270 | `wB8:p2` / `wB8:t1` | `Projects/CPQ/worktrees/Merisma/console-full-ui` | 0.36 | 14 |
| 60159 | `wB9:p2` / `wB9:t1` | `Projects/CPQ/worktrees/Merisma/rules-entry-point` | 0.37 | 13 |
| 74753 | `wB9:p4` / `wB9:t2` | `Projects/CPQ/worktrees/Merisma/rules-entry-point` | 0.39 | 17 |
| 96662 | `wB9:pF` / `wB9:t3` | `Projects/CPQ/worktrees/Merisma/rules-entry-point` | 0.42 | 15 |
| 34663 | `wBA:p2` / `wBA:t1` | `Projects/grove/worktrees/herdr-gitrail/git-polling-cpu` | 0.14 | 9 |

## Responsible call paths

References below are to the inspected base commit, not an unverified assertion about the loaded revision of every older live process.

| Stage | Source reference | Behavior / significance |
| --- | --- | --- |
| Auto-open | [herdr-plugin.toml:8–25](../herdr-plugin.toml#L8-L25); [auto-open-herdr-tabs.mjs:36–67](../scripts/auto-open-herdr-tabs.mjs#L36-L67), [162–219](../scripts/auto-open-herdr-tabs.mjs#L162-L219) | Startup sweeps tabs; workspace/tab creation targets that lifecycle event. Preview/demo tabs are excluded. Close events clean state. This is event/startup work, not a recurring poll daemon. |
| Launch gate / idempotence | [auto-open-herdr-tabs.mjs:70–120](../scripts/auto-open-herdr-tabs.mjs#L70-L120); [open-herdr-panel.mjs:274–368](../scripts/open-herdr-panel.mjs#L274-L368) | One repository probe per target, then `ensure`; bounded concurrency four and 35-second sweep deadline. Per-tab state lock and verified ownership keep/adopt an existing rail and remove extra owned panes. No repository-wide shared provider is established. |
| Startup state | [git-rail.mjs:145–187](../scripts/git-rail.mjs#L145-L187), [1206–1208](../scripts/git-rail.mjs#L1206-L1208) | Resolve content cwd, get repository state once, draw, install invalidation. Startup is expected work; it is separate from later timers. |
| Herdr discovery on every refresh | [herdr-context.mjs:13–63](../src/herdr-context.mjs#L13-L63); [git-rail.mjs:960–963](../scripts/git-rail.mjs#L960-L963) | `pane get`, then `pane list --workspace` and `pane layout --pane`; prefer that tab's focused content pane, then previous source, then first content pane, otherwise prior cwd. No global-tab visibility gate or no-content stop. |
| Full refresh | [git-rail.mjs:948–999](../scripts/git-rail.mjs#L948-L999) | Every trigger calls `getRepositoryState`; successful reads invalidate view-model caches and redraw. No unchanged-state early return and no cross-helper cache. |
| Git watch roots | [git-watch.mjs:25–34](../src/git-watch.mjs#L25-L34) | Two extra Git commands resolve absolute per-worktree gitdir and common gitdir; identical paths are deduplicated, but nested roots are not. |
| Filesystem invalidation | [git-rail.mjs:1001–1045](../scripts/git-rail.mjs#L1001-L1045) | Recursive worktree watch ignores paths starting `.git/` only; no Git-ignore filter. Every event in each recursively watched Git directory triggers the scheduler, including object files, locks, and sibling-worktree metadata in the common directory. Watch errors close that watcher and enable fallback polling. |
| Coalescing | [terminal-ui.mjs:341–364](../src/terminal-ui.mjs#L341-L364); [git-rail.mjs:949–953,988–997](../scripts/git-rail.mjs#L949-L953) | Filesystem bursts get an initial 125 ms delay and at most one filesystem callback per 2 s per helper. Pending calls coalesce. A refresh already running gets one queued follow-up. This bounds overlap/backlog but does not eliminate repeated full refreshes or coordinate different helpers. |
| Recovery timer | [git-watch.mjs:9–15](../src/git-watch.mjs#L9-L15); [git-rail.mjs:1047–1063](../scripts/git-rail.mjs#L1047-L1063); [terminal-ui.mjs:327–333](../src/terminal-ui.mjs#L327-L333) | Default watchers **and** polling. Valid default 10,000 ms, independently jittered ±10% (9–11 s). Each timeout schedules the next before requesting refresh. Polling continues even after a filesystem refresh, and does not pass through the filesystem rate limiter. No tab-visibility test. |
| Configuration | [config.mjs:18](../src/config.mjs#L18), [159–165](../src/config.mjs#L159-L165), [196–200](../src/config.mjs#L196-L200) | User config is reread by each state build; env override `GIT_RAIL_POLL_INTERVAL_MS`. Inspected user config resolved to 10,000 ms and `autoOpen: true`; all 41 helpers lacked polling/watch-mode overrides and debug-log paths. |
| Spawn / read-only guard | [process.mjs:12–38](../src/process.mjs#L12-L38), [159–165](../src/process.mjs#L159-L165) | Each `runGit` spawns a fresh process, no shell and no persistent Git worker. `GIT_OPTIONAL_LOCKS=0` is forced, preventing background reads from optionally refreshing the index. |
| User actions | [git-rail.mjs:937–946](../scripts/git-rail.mjs#L937-L946), [1195](../scripts/git-rail.mjs#L1195); [git-provider.mjs:464–474](../src/git-provider.mjs#L464-L474) | Manual `r` requests a full refresh; first expansion of a commit costs two Git commands, cached by hash in that rail. Neither is needed to explain idle churn. |

The filesystem limiter is not a total refresh limit. A poll arriving just after a filesystem refresh repeats the work; arriving during it sets a queued full refresh. A long refresh does not cause unbounded concurrent providers in one rail, but continuous invalidations can keep it busy. Distinct rails have entirely independent timers and queues. A `watch-only` environment mode disables normal recovery, but watcher errors re-enable it; using it globally would risk stale data after missed events and stale content-pane context. It is not the recommended remedy.

### Refresh-to-Git-process accounting

The normal branch path (valid `main` base, no configured base override, common directory resolution succeeds) is:

| Work | Git processes / refresh | Source |
| --- | ---: | --- |
| Repository root, common-directory name, current branch | 3 | [git-provider.mjs:44–60](../src/git-provider.mjs#L44-L60), [113–125](../src/git-provider.mjs#L113-L125) |
| Branch base config, origin HEAD, first valid base candidate | 3 | [git-provider.mjs:129–190](../src/git-provider.mjs#L129-L190) |
| Status, staged diff, unstaged diff | 3 | [git-provider.mjs:343–349](../src/git-provider.mjs#L343-L349) |
| Tracked files | 1 | [git-provider.mjs:523–525](../src/git-provider.mjs#L523-L525) |
| Merge base, base-to-worktree diff, base-to-HEAD diff | 3 | [git-provider.mjs:254–275](../src/git-provider.mjs#L254-L275), [527–535](../src/git-provider.mjs#L527-L535) |
| Commit summary log, count, raw paths log | 3 | [git-provider.mjs:427–449](../src/git-provider.mjs#L427-L449) |
| Upstream ahead/behind | 1 | [git-provider.mjs:417–423](../src/git-provider.mjs#L417-L423) |
| **Full refresh** | **17** | [git-provider.mjs:478–544](../src/git-provider.mjs#L478-L544) |
| Watch-root discovery at initial setup / repository transition | **+2** | [git-watch.mjs:25–34](../src/git-watch.mjs#L25-L34) |

Thus a normal initial load is 19 Git processes; `N` later full refreshes give `19 + 17N`. The isolated trace matched this exactly. Configured bases, detached/unborn branches, failed base candidates, missing repositories, and Git errors change the count. A non-repository first runs one failed root probe, then a bounded directory scan; a `HEAD` base omits several history/comparison queries. Do not assert 17 for every possible state.

These commands are separate because they supply distinct information: status, index entries/modes, exact diff statistics, history paths, comparison scopes, and upstream counts. Raw diff metadata and numstat already share one tree walk, merge base is reused between comparisons, and history-path discovery is one bounded log rather than one command per commit. The redundant part is requesting all of that again when no relevant input changed, and doing it separately for rails on the same worktree.

Helper CPU also includes parsing NUL-delimited output, rebuilding path indexes, probing changed-file presence, bounded untracked-file content counting, and drawing after each refresh ([git-provider.mjs:278–324](../src/git-provider.mjs#L278-L324), [550–611](../src/git-provider.mjs#L550-L611)). These execute even if the Files tab or history section is collapsed. No live CPU stack sample was taken, so their individual share of the measured CPU is unquantified.

## Isolated experiments

All experiments used the diagnostic worktree's production script, with Herdr/cmux environment stripped, an explicit disposable repository, isolated configuration, and stdout discarded at 52×46. No Herdr connection or pane was created. A temporary Node preload recorded raw watcher events and `process.cpuUsage()` at exit; `GIT_TRACE2_EVENT` counted Git `start` events, and the existing debug logger recorded refresh sources. Logs were **outside watched repositories**. Both compared cases used identical instrumentation. Child processes exited with `q` and code 0; stderr was empty.

### Healthy idle watchers: recovery interval 10 s versus 60 s

Both helpers ran concurrently against the same small, unchanged production fixture (commits, staged/unstaged and untracked files), from 10:07:15.433/434 for approximately 70.03 s. This is a paired configuration comparison, not an installed code patch. Watchers were enabled in both cases and their two watched roots were recorded.

| Metric | Before: 10,000 ms | After: 60,000 ms |
| --- | ---: | ---: |
| Initial state loads | 1 | 1 |
| Poll-triggered refreshes | 7 | 1 |
| Filesystem-triggered refreshes | 0 | 0 |
| Raw watcher events | 0 | 0 |
| Exact Git launches | 138 = 19 + 7×17 | 36 = 19 + 1×17 |
| Helper user CPU | 0.135626 s | 0.078561 s |
| Helper system CPU | 0.187389 s | 0.060806 s |
| Helper total CPU | **0.323015 s** | **0.139367 s** |

Observed reductions in this run: **73.9% of total Git launches**, **56.9% of helper CPU including startup**; refresh-only launches were 119 versus 17. Poll jitter and the 70-second boundary affect the integer counts. The index mtime remained exactly `1789553235428035029` ns before/after, and neither rail produced any watcher events. This argues against self-generated optional index writes as the quiet-loop cause in current code. It does not prove every Git configuration/filesystem has no possible feedback.

This fixture is small, has no live Herdr context queries, and is not representative of large Merisma worktrees. No Git child CPU was measured. The result supports the mechanism and the quiet-case direction, not an extrapolated percentage improvement for the previous live session.

### Watch invalidation: ignored writes and sibling worktree

A separate fixture had tracked `tracked.txt`, a committed `.gitignore` excluding `.noise/`, and a linked sibling worktree. Its rail used a 300,000 ms recovery interval so no poll fired during the 15.09-second experiment (10:09:17–10:09:32). No production watcher logic was changed.

| Controlled action | Observation | Interpretation |
| --- | --- | --- |
| First 3 seconds, no writes | No watcher-triggered refresh | No spontaneous watcher feedback in this window |
| Twelve writes at 250 ms intervals to ignored `.noise/cache`, starting 10:09:20.221 | Twelve worktree events; full refreshes at 10:09:20.348, 22.349, 24.349 | Three unnecessary refreshes, **51 Git launches**, bounded by the existing 2 s coalescer |
| At 10:09:26.278, change and `git add` sibling `tracked.txt` | Common-gitdir object, `index.lock`, and `worktrees/sibling/index` events; refresh at 10:09:26.430 | One unnecessary full refresh of the primary worktree, **17 Git launches**; no primary index, tracked file, or branch ref was changed by this action |
| Change primary `tracked.txt` at 10:09:29.299 | Worktree event and refresh at 10:09:29.436 | Expected refresh, approximately 137 ms from action to trigger |

There were five filesystem-triggered refreshes, **104 rail Git launches = 19 + 5×17**, and no poll trigger. Trace2 contained 105 starts because the fixture driver's sibling `git add` inherited the trace path; that one command was explicitly excluded from rail counts. Raw worktree callbacks also reported `.git/...` events, but the production worktree filter suppresses those; the separate common-gitdir watch still schedules them. Coalescing prevents duplicate callbacks from necessarily becoming duplicate full refreshes, but does not recognize their semantic irrelevance.

This demonstrates that other activity can amplify refreshes across linked worktrees. It does **not** establish that these events caused a specified fraction of the live CPU: no live watcher trace existed. Debug logging into a watched tree could also create feedback because it writes files, but all inspected live helpers had `GIT_RAIL_DEBUG_LOG` unset; the experiment logs were deliberately external.

## Recommended remediation and tradeoffs

1. **Smallest bounded change: make healthy-watch recovery less frequent, e.g. 60 s, while retaining watchers.** The existing `refresh.pollIntervalMs`/`GIT_RAIL_POLL_INTERVAL_MS` can express this and the quiet-case effect was measured above. No such setting was applied to the user's installation. For implementation, retain a short fallback interval when watchers fail; merely changing today's shared configuration also slows poll-only/error recovery. Tradeoff: missed filesystem events and Herdr content-pane/cwd changes may remain stale for 54–66 s instead of 9–11 s. The current code discovers pane context only during a refresh, so slowing the timer without addressing context changes is a visible behavior change.
2. **Make the recovery deadline relative to the last successful full refresh.** A successful filesystem/manual refresh should postpone the recovery poll instead of allowing a timer to repeat it immediately. Route triggers through one per-helper scheduler, preserve the one queued follow-up for a real invalidation received during an in-flight read, and avoid indefinitely postponing recovery on failed refreshes. This is a proposed refinement, not a measured implementation change. It saves overlapping triggers, not quiet-time polls by itself.
3. **Filter irrelevant invalidations.** Respect Git-ignore semantics without excluding tracked files that happen to match ignore patterns; handle unknown filenames conservatively. Watch own index/HEAD/operation state plus relevant shared refs/config, rather than invalidating on every common-directory object/lock/sibling-index event. Preserve linked-worktree, packed-ref, branch switch, config, and watcher-error recovery behavior. The two concrete unnecessary sources above are reproduced; a general filter still needs correctness tests and its own before/after evidence.
4. **Larger improvement: share repository snapshots between rails on the same canonical worktree.** Keep per-tab selection, rendering, preview state, and source-pane context local, but use one watcher/scheduler/provider computation with subscribers for identical worktree/config identities. The 39 resolved rails currently have 19 distinct targets. This is substantial duplicated query demand, not a promise of an exact CPU reduction. Key by worktree/gitdir and relevant configuration, not just common gitdir: sibling indexes and working files differ. Add ownership/cleanup and failure recovery before introducing a broker/cache. History/ref-derived results can additionally be cached by ref/object identities; worktree state needs different invalidation.
5. **Visibility and lifecycle:** once reliable tab visibility/context events are available, deprioritize hidden subscribers and refresh immediately when shown; do not add another three CLI subprocesses per tab just to ask whether it is visible. A rail with no content pane should suspend repository work and wait for context recovery or close through an explicit lifecycle policy. Avoid making absence during a transient layout change destructive. The two rail-only tabs were observed leftovers, but their creation history was not captured.

A longer interval is the smallest experimentally supported change. Shared worktree state is the stronger architectural answer if many per-tab rails remain the intended UI. None of the recommendations require removing useful comparison/history data from a requested refresh, and no production optimization is included in this diagnostic-only change.

## Reproduction

Run live inspection only inside Herdr, following its skill and installed help. The commands below are observational and do not reopen rails. After the user's closure they will naturally find zero helpers unless the user has opened new rails. Store captures outside repositories so diagnostics do not invalidate watchers.

```sh
test "${HERDR_ENV:-}" = 1
herdr --help
herdr api snapshot
herdr workspace list
herdr tab list
herdr pane list
# For each rail-labelled pane returned above:
herdr pane process-info --pane <returned-pane-id>
ps -ww -axo pid=,ppid=,tty=,stat=,%cpu=,time=,args=
```

Do not map provider targets from helper process cwd. Resolve rail → actual tab → focused content pane (excluding rail/preview labels), falling back to the prior source pane and then first content pane, as in `src/herdr-context.mjs`. Inherited IDs were read using `ps eww -p PID -o command=` **inside a parser**, retaining only rail/Herdr identity and refresh settings; the full environment was neither printed nor included in this report. Recheck process-info because panes and processes can change during inspection.

### Slow CPU/count sampler

Save the following as `sample.py` in a disposable directory. The actual valid run used `python3 sample.py idle.json 60 1`. An initial discovery attempt incorrectly classified macOS's truncated `comm` field; it was discarded and rerun using argv, as below. The valid recorded interval is the one in the table. For future controlled measurements, do not run Git inspections or edit any watched files during the interval.

```python
import subprocess,time,json,sys,datetime,os
out=sys.argv[1]; duration=float(sys.argv[2]); interval=float(sys.argv[3]); samples=[]
start=time.monotonic(); wall=datetime.datetime.now(datetime.timezone.utc).isoformat()
while True:
 t=time.monotonic()
 raw=subprocess.check_output(['ps','-ww','-axo','pid=,ppid=,tty=,stat=,%cpu=,time=,comm=,args='],text=True)
 rows=[]
 for line in raw.splitlines():
  p=line.split(None,7)
  if len(p)!=8: continue
  pid,ppid,tty,stat,cpu,cputime,comm,args=p
  israil=os.path.basename(args.split()[0])=='node' and 'scripts/git-rail.mjs' in args
  isgit=os.path.basename(args.split()[0])=='git'
  isherdr=os.path.basename(args.split()[0])=='herdr'
  if israil or isgit or isherdr:
   rows.append(dict(pid=int(pid),ppid=int(ppid),tty=tty,stat=stat,cpu=float(cpu),time=cputime,comm=comm,args=args,kind='rail' if israil else 'git' if isgit else 'herdr'))
 samples.append(dict(t=t-start,rows=rows))
 if time.monotonic()-start>=duration: break
 time.sleep(max(0,interval-(time.monotonic()-t)))
json.dump(dict(start=wall,elapsed=time.monotonic()-start,interval=interval,samples=samples),open(out,'w'))
print(out,wall,round(samples[-1]['t'],3),len(samples))
```

For each helper present at both endpoints, parse `time` as minutes/seconds (including hours if present), subtract the first from the last, sum, and divide by `samples[-1].t - samples[0].t`, multiplying by 100. Also report births/exits and min/max helper counts; do not silently exclude changing populations. `ps %cpu` is a separate observation. All 41 helpers persisted in the valid interval here.

### Faster macOS process discovery

Save as `churn.py`; run `python3 churn.py churn.json 10 .02`. This uses unprivileged Darwin APIs and the `proc_bsdinfo` layout from the installed Xcode SDK's `usr/include/sys/proc_info.h` (lines 59–82). It reads only argv from `KERN_PROCARGS2`, not the environment. It remains a lower-bound existence sampler, even at short intervals.

```python
import ctypes as C,subprocess,time,json,sys,datetime,resource
lib=C.CDLL('/usr/lib/libproc.dylib'); syslib=C.CDLL('/usr/lib/libSystem.B.dylib')
class BSD(C.Structure):
 _fields_=[('a',C.c_uint32*12),('comm',C.c_char*16),('name',C.c_char*32),('b',C.c_uint32*6),('start_sec',C.c_uint64),('start_usec',C.c_uint64)]
def argv(pid):
 mib=(C.c_int*3)(1,49,pid); buf=C.create_string_buffer(262144); size=C.c_size_t(len(buf))
 if syslib.sysctl(mib,3,buf,C.byref(size),None,0):return []
 raw=buf.raw[:size.value]; argc=int.from_bytes(raw[:4],sys.byteorder); i=raw.find(b'\0',4)+1
 while i<len(raw) and raw[i]==0:i+=1
 return [s.decode(errors='replace') for s in raw[i:].split(b'\0')[:argc]]
pids=(C.c_int*65536)(); seen=set(); found=[]; costs=[]; ticks=0; start=time.monotonic(); utc=datetime.datetime.now(datetime.timezone.utc).isoformat(); duration=float(sys.argv[2]); interval=float(sys.argv[3]); selfstart=resource.getrusage(resource.RUSAGE_SELF)
while True:
 t=time.monotonic(); count=lib.proc_listallpids(pids,C.sizeof(pids)); live=set(pids[:count])
 for pid in live-seen:
  buf=C.create_string_buffer(64); lib.proc_name(pid,buf,len(buf))
  if buf.value not in (b'git',b'herdr',b'node'):continue
  b=BSD()
  if lib.proc_pidinfo(pid,3,0,C.byref(b),C.sizeof(b))!=C.sizeof(b):continue
  found.append(dict(t=t-start,pid=pid,ppid=b.a[4],name=buf.value.decode(),argv=argv(pid),preexisting=ticks==0,start_sec=b.start_sec,start_usec=b.start_usec))
 seen=live; ticks+=1; costs.append(time.monotonic()-t)
 if time.monotonic()-start>=duration:break
 time.sleep(max(0,interval-costs[-1]))
selfend=resource.getrusage(resource.RUSAGE_SELF)
x=dict(start=utc,elapsed=time.monotonic()-start,interval=interval,ticks=ticks,scan_mean_ms=1000*sum(costs)/len(costs),scan_max_ms=1000*max(costs),sampler_cpu_seconds=selfend.ru_utime+selfend.ru_stime-selfstart.ru_utime-selfstart.ru_stime,found=found)
json.dump(x,open(sys.argv[1],'w')); print(json.dumps({k:v for k,v in x.items() if k!='found'}))
```

Select `found` entries with `name == "git"`, `preexisting == false`, and `ppid` in the independently identified live rail PID set. Count distinct PID/start-time identities, grouping argv as above; report missing argv. Keep other tools' Git processes separate. This sample had no observed PID-identity collisions.

### Isolated comparison procedure

From this diagnostic worktree, create a disposable directory (outside all watched repositories), save the following preload as `preload.mjs` there, and set `DIAG_ROOT` to that directory. It only instruments the experiment's Node process.

```javascript
import fs from 'node:fs';
const started=performance.now();
const write=(entry)=>fs.appendFileSync(process.env.EXPERIMENT_EVENTS,JSON.stringify({elapsedMs:performance.now()-started,...entry})+'\n');
const originalWatch=fs.watch;
fs.watch=function(target,options,listener){
 write({event:'watch-installed',target:String(target)});
 return originalWatch.call(this,target,options,(event,filename)=>{
  write({event:'watch-event',target:String(target),type:event,filename:String(filename)});
  listener(event,filename);
 });
};
process.on('exit',()=>write({event:'exit',cpu:process.cpuUsage(),resource:process.resourceUsage()}));
```

Save and run the following `experiment.py` in that directory, with the worktree as the current working directory. The script starts two ordinary child processes outside Herdr, keeps watchers enabled, and exits them by their supported `q` input. Exact counts vary with jitter; confirm trace arithmetic rather than expecting the same boundary count. Use a fresh directory for each run so JSONL logs do not accumulate.

```python
import subprocess,os,pathlib,time,json,datetime,shutil
root=pathlib.Path(os.environ['DIAG_ROOT']).resolve(); repo=pathlib.Path.cwd(); node=shutil.which('node')
env={k:v for k,v in os.environ.items() if not k.startswith(('HERDR_','GIT_','CMUX_')) and k not in ['NODE_OPTIONS','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_STATE_HOME']}
env.update(GIT_CONFIG_GLOBAL='/dev/null',GIT_CONFIG_NOSYSTEM='1',XDG_CONFIG_HOME=str(root/'config'))
fixture=subprocess.check_output([node,'--input-type=module','-e',"import {createFixtureRepository} from './src/fixture.mjs';console.log(await createFixtureRepository())"],cwd=repo,env=env,text=True).strip()
(root/'fixture-path.txt').write_text(fixture)
(root/'config').mkdir(exist_ok=True)
idx=pathlib.Path(fixture)/'.git/index'; before=idx.stat().st_mtime_ns
children=[]
for label,interval in [('before-10s',10000),('after-60s',60000)]:
 childenv={**env,'GIT_RAIL_REPO_ROOT':fixture,'GIT_RAIL_POLL_INTERVAL_MS':str(interval),'GIT_RAIL_DEBUG_LOG':str(root/(label+'.debug.jsonl')),'GIT_TRACE2_EVENT':str(root/(label+'.trace.jsonl')),'EXPERIMENT_EVENTS':str(root/(label+'.events.jsonl'))}
 stderr=open(root/(label+'.stderr'),'w');p=subprocess.Popen([node,'--import',str(root/'preload.mjs'),str(repo/'scripts/git-rail.mjs'),'--width','52','--height','46'],cwd=repo,env=childenv,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=stderr)
 children.append((label,p,stderr,time.monotonic(),datetime.datetime.now(datetime.timezone.utc).isoformat()))
start=time.monotonic()
while time.monotonic()-start<70:time.sleep(.1)
results=[]
for label,p,err,t,utc in children:
 p.stdin.write(b'q');p.stdin.flush();code=p.wait(timeout=10);err.close();results.append(dict(label=label,pid=p.pid,start=utc,duration=time.monotonic()-t,exitCode=code))
json.dump(dict(fixture=fixture,indexMtimeBefore=before,indexMtimeAfter=idx.stat().st_mtime_ns,runs=results),open(root/'experiment-results.json','w'))
print(json.dumps(results))
```

For each trace, count JSONL records with `event == "start"`. Count debug records with `operation == "refresh-trigger"` grouped by `source`. Sum `cpu.user + cpu.system` from the preload's exit event and divide by 1,000,000 for helper CPU-seconds. Check watcher-event counts, index mtime, stderr, and exit codes. This excludes Git child CPU. After preserving results, remove the fixture path recorded in `fixture-path.txt` and the disposable diagnostic directory; do not remove any live repository.

To reproduce the separate watcher witness with the same preload, create a fresh local `main` repository, commit `tracked.txt` and `.gitignore` containing `.noise/`, create `.noise/`, and add a linked worktree with `git worktree add -b sibling <disposable-sibling-path>`. Start one instrumented production rail against the primary fixture with a 300,000 ms poll interval. Wait 3 s; write `.noise/cache` twelve times at 250 ms intervals; wait 3 s; change sibling `tracked.txt` and stage it; wait 3 s; change primary `tracked.txt`; wait 3 s and send `q`. Record action timestamps, watch callbacks, debug trigger sources, and trace starts. Keep the driver's Git trace separate or subtract its known `git add` invocation as done here. Clean up both disposable worktrees after the rail exits.

## Completion checks and remaining uncertainty

- Recorded bounded live CPU/process samples, parent-attributed Git command observations, per-tab topology and duplicate-work mappings.
- Traced startup, watch roots/invalidation, failure recovery, jitter, coalescing, full provider fan-out, and explicit user refresh paths.
- Used production code in isolated fixtures to measure the interval recommendation and to distinguish irrelevant external invalidations from an unobserved self-feedback hypothesis.
- Verified the user-authorized closure without changing installation/configuration; did not reopen live rails for further measurement.
- Verified report Python snippets with `ast.parse`, the temporary preload with `node --check`, source-link targets/line bounds, report whitespace, and `git diff --check`. The report is the only worktree change; no temporary instrumentation remains. Source implementation is unchanged. No broad application test suite was rerun for this documentation-only deliverable; the production-script fixture experiments are the behavioral evidence.

Unresolved: the exact method/time window of the original 18% sample; complete live launch counts and child CPU; exact source revisions loaded by old helpers; live poll/watch/manual trigger proportions; last provider cwd of the two rail-only tabs; whether additional externally generated Git metadata events materially increased the particular live interval. The measured counts and normal polling fan-out explain high process churn without requiring any of those hypotheses to be assumed true.
