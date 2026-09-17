# Git refresh design decisions

The design review converged on an event-driven in-process milestone followed by
required shared worktree state. The [implementation plan](IMPLEMENTATION_PLAN.md)
and [incorporated review decisions](REVIEW-RESOLUTION.md) retain the engineering
contract; raw agent prompts, transcripts and launch bookkeeping are kept locally
and are not part of the published candidate tree.

## Architecture

- Keep one rail UI per tab, with one native watcher set and full-provider engine
  per compatible worktree in the shared Herdr coordinator.
- Coalesce relevant changes, filter known ignored and sibling-index activity,
  and retain bounded degraded recovery and healthy reconciliation.
- Use the verified shared host-topology fallback where Herdr events cannot
  guarantee foreground cwd freshness; preserve standalone and cmux operation.
- Validate provider semantics, generations, process ownership, IPC boundaries,
  hidden rendering, cross-platform behavior and measured before/after costs.
- Defer partial history caching; publish fixture measurements with their limits.

## PR review follow-up

The follow-up review accepted three scoped changes:

1. Keep one pending dirty batch plus any active captured batch. Preserve the
   latest input generation, first deadline and one required follow-up, while
   bounding watcher rejection handlers and timer/status work per batch.
2. Bound ignore classification entries with a 4,096-entry LRU. Evicted paths
   become unknown and are reclassified conservatively. The default must retain
   the performance witness's working set; tiny limits are unit-test injections.
3. Retain engineering evidence, remove raw orchestration transcripts from the
   published tree, and normalize personal paths in public evidence copies.
   Original local copies remain available. This is forward cleanup, not a Git
   history rewrite.

AD-1 is accepted: preserve the default witness's two classification launches.
AD-2 is accepted: a large mid-read burst must capture a strictly newer generation
and resolve its requests with the follow-up result, never the earlier result.
Validation gates and historical measurements are unchanged; runtime changes
require freshly generated candidate evidence against the archived baseline.


During follow-up validation, a slow startup read crossed the old witness's
log-silence boundary. The measurement harness now also waits for completed
initial snapshots and provider completion. This is a measurement-isolation
correction; the provider implementation, numerical gates and archived baseline
are unchanged. Rejected and replacement runs are distinguished in EVIDENCE.md.
