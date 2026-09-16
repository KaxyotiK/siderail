# Plan review resolution

**Date:** 2026-09-16
**Result:** `herdr-converge` reached `converged` in two rounds with `ccx --model opus --effort high` (`ccx-gitrail-plan`) and the originating Codex session.
**Plan:** [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
**Full exchange:** [CONVERGENCE.md](CONVERGENCE.md)

The final plan incorporates the agreed structure and the peer's three final compatible additions. The wrapper's transcript is preserved verbatim, including earlier proposals and factual claims later withdrawn; it is not the implementation specification. The plan governs implementation.

## Agreed scope

> Deliver a validated in-process event-driven milestone, then required shared-worktree state behind the same client seam; retain bounded recovery and a full-provider oracle, defer history caching, and gate completion on explicit correctness, lifecycle, compatibility, and measured performance proofs.

Phase A has six items, Phase B three. Phase A proves the cadence/filter/context/UI work independently. Phase B is required to eliminate same-worktree edit amplification and complete the shared-state target. Neither milestone authorizes a rollout. All implementation checkboxes remain unchecked.

## Disposition of review findings

| Finding | Resolution in the plan |
| --- | --- |
| Coordinator complexity versus early measurable progress | Two independently validated phases, with the A2 client seam supporting the B1 transport. Optional-coordinator threshold rejected and withdrawn: quiet-only arithmetic omitted repeated reads during relevant edits and did not fulfill shared-state cardinality. |
| Provider history caching adds an additional invalidation model | Removed from mandatory scope; deferred until active-edit measurements after sharing. Full provider remains the oracle. |
| New reconciliation range and jitter | 30,000–3,600,000 ms, default 300,000, zero invalid, bounds before ±10% jitter. The allegation that existing jitter violated validation was withdrawn. |
| Existing `pollIntervalMs` compatibility | Existing JSON remains valid, but ordinary-mode behavior changes when the field becomes degraded-only. Documentation must state it. The claim of unchanged semantics based on a variable name was withdrawn. |
| Production wiring, coverage, and packaging | Substantive coordinator/adapter/error logic stays in `src/`; script is thin. Production imports and final lint/coverage/archive checks required. The untested assertion that test-only imports necessarily fail knip was withdrawn. |
| Silent watcher-root replacement | Reconciliation probes installed roots' realpath/device/inode, reinstalls on mismatch, and performs a full read; real replacement witness required. Identity equality is not proof of perfect delivery. |
| Exact Git-ignore semantics | Bounded NUL-safe Git-oracle batching for unknown paths, through `runGit` with optional locks disabled, plus generation-keyed classification cache. No subprocess per event, all launches counted. The claim that current provider output contains ignore rules was withdrawn. |
| Git metadata relevance | Explicit own/shared/config/operation dependency table with conservative unknown/error handling. No blanket lock or sibling-directory suppression. |
| Frozen commit ages | Absolute timestamps plus visible-only pure-render age tick; zero Git/IPC and zero hidden age redraws. |
| Long benchmark ambiguity | Three-repeat short comparisons plus one >=360-second, eight-client real reconciliation confirmation after sharing; injected clocks prove exact timing boundaries. |
| Host-event proof | Ten of ten scripted context trials within 2 seconds, latency and subscriber CPU/RSS recorded, forced stream reconnect plus independent snapshot equality. Schema alone does not establish runtime reliability. |
| CPU target | Final warm quiet application CPU median <=25% of the matched baseline at 1/8 clients, all runs/spread reported, insufficient resolution requires longer measurement. Exact query counts remain separate gates; no live-workload improvement is inferred. |
| Throttle boundary versus latency target | Quiescent target explicitly excludes a recent throttle window/in-flight read; busy timing uses the next eligible slot plus measured provider duration. |
| Reproducible baseline | Full fixed base hash extracted with `git archive` into an isolated source directory, separate real Git fixture, source hashes in every artifact. |
| AD-1: Phase A 1 Hz fallback could increase host work | A1 fixes the branch before measurement: reliable events proceed; otherwise retain at most baseline three host requests per rail per nominal ten seconds, detached from Git refresh, and defer fast fallback to shared Phase B. A6 fails on higher host-query traffic. No per-process 1 Hz fallback. |
| AD-2: Cadence versus sharing must not be conflated | AC-1a covers Phase A per-engine cadence; AC-1b covers Phase B client-count independence. The phase acceptance/evidence table states the boundaries. |
| AD-3: Edit amplification needs its own proof | AC-11 compares the same one-edit/eight-client fixture: independent build multiplier in A, exactly one shared provider build/query set in B. |

The peer's final reply retained AD-1–AD-3 under `OPEN` as edits still to incorporate while accepting the common AGREE line. All three edits are incorporated above and in the plan; they are not outstanding scope disagreements. Runtime/protocol uncertainties remain explicit A1 implementation gates, not silently resolved by review.

## Review surfaces and authorization

The peer was launched in right split `wBA:p3` beside the originating `wBA:p1`. No new tab was created. The peer surface and convergence state remain available for inspection. Discussion-only mode was used; during the exchange each participant changed only its assigned reply file. The originating session revised the plan after terminal convergence. No source implementation, live rail/configuration change, commit, push, or publication occurred as part of planning/review.

## Planning validation

Validated five expected outcomes, twelve acceptance criteria (AC-1a/1b and AC-2–11), and nine ordered implementation items. Every item names acceptance coverage, dependencies, affected files, changes, and proof commands/procedures. Criteria all appear in the final evidence map. Local document links, dependency ordering, whitespace, and `git diff --check` passed. These checks validate the plan artifact; they do not claim the future implementation tests or performance targets have passed.
