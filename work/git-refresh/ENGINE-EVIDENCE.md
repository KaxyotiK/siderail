# A2 repository engine, scheduler, and client evidence

**Scope:** A2 only: the in-process repository engine/client seam, refresh scheduling, configuration, and explicit Git process context. Watch classification, host-context transport, terminal integration, cross-process sharing, and final performance acceptance are proved by their owning items.

**Runtime:** Node `26.7.0` and Apple Git `2.50.1` on macOS for the commands below. Supported Node 22/24 execution and the final full-matrix proof are recorded by the integration owner.

## Implemented behavior

The engine now owns exactly one provider invocation at a time. `src/refresh-scheduler.mjs` coalesces a 125 ms dirty burst, enforces a two-second minimum between dirty starts, permits a manual request to run immediately after an active read, and carries a dirty event received during a read into one follow-up. A recovery request already covered by a due reconciliation does not produce an extra read. Healthy engines schedule a default 300-second reconciliation with bounded ±10% jitter; degraded watchers and provider failures schedule the existing default ten-second fallback with the same jitter bound. A successful provider run clears failure recovery, while a failed run retains bounded retry and does not erase the last valid engine snapshot.

`src/repository-engine.mjs` owns the latest snapshot and generation, watcher lifecycle, dynamic refresh configuration, subscriber delivery, cancellation, and opt-in evidence events. The watcher is constructed after the first successful provider read. Its settled seam is:

```js
await watchFactory({
  context,
  snapshot,
  onInvalidation(event),
  onHealth(health),
})
// -> { close(), updateSnapshot(snapshot), reconcile(snapshot) }
```

Later successes call `updateSnapshot`. A recovery read first calls `reconcile` against the last snapshot. An invalidation emitted synchronously by that reconciliation is marked as covered by the provider read that immediately follows. Watcher-reported degraded health is retained rather than overwritten by successful factory creation.

The in-process public seam is:

```js
const engine = createRepositoryEngine({
  context,
  readState,
  watchFactory,
  schedulerOptions,
});

engine.ready;
engine.subscribe(listener);          // returns unsubscribe()
engine.latest();
engine.refresh(reason);              // urgent/manual request
engine.invalidate(reason);           // coalesced dirty request
engine.setWatchHealth(health);
await engine.close();

const client = createRepositoryClient({ openSubscription });
const handle = client.subscribe(context, listener);
handle.contextToken;                 // immutable and unique for client lifetime
handle.ready;
handle.latest();
handle.refresh(reason);
await handle.close();
await client.close();
```

Deliveries contain `engineKey`, `stateGeneration`, `inputGeneration`, `status`, the latest `snapshot` when one exists, optional safe error metadata, `refreshedAt`, and `reconciliationDueAt`. The client stamps a unique `contextToken`; closing a handle drops late deliveries and prevents an in-flight result from reaching a later context.

`src/process.mjs` adds `withGitProcessContext({ environment, executable, signal }, callback)`. It uses `AsyncLocalStorage` so concurrent providers receive their own complete Git environment, executable, and abort signal. `getRepositoryState` wraps its full provider call in that context. Every `runGit` still forces `GIT_OPTIONAL_LOCKS=0`. This closes the prior gap where `options.env` controlled config loading but Git children inherited the ambient process environment. A real-provider test runs two concurrent engines with different `GIT_INDEX_FILE` values and confirms that each snapshot sees only its own index.

Configuration adds `refresh.reconcileIntervalMs`, default `300000`, accepted range 30,000–3,600,000, and `GIT_RAIL_RECONCILE_INTERVAL_MS`. The existing `pollIntervalMs` becomes the degraded fallback interval. A successful snapshot can change either interval without resetting timers for unchanged values.

## Evidence instrumentation

When `GIT_RAIL_DEBUG_LOG` is enabled, the engine writes:

- `refresh-trigger` for scheduler and watcher causes, identified by a twelve-hex SHA-256 engine ID;
- exactly one `repository-provider` start and finish for each provider build, with request kinds, sanitized reasons on start, input generation, outcome, and duration;
- `repository-watcher` numeric watcher and classifier counters on close when the watcher exposes them.

The evidence records contain no cwd, environment, engine key, or snapshot. The instrumentation test verifies that a repository path never appears in the log and that a build produces exactly one start and one finish.

## Reproducible proof

Run from the worktree root:

```sh
node --test --test-concurrency=1 \
  test/refresh-scheduler.test.mjs \
  test/repository-engine.test.mjs \
  test/repository-client.test.mjs \
  test/process.test.mjs
```

Observed result on 2026-09-16:

```text
tests 27
pass 27
fail 0
duration_ms 1798.665458
```

This command covers dirty burst and mid-read coalescing, manual/recovery priority, jitter maxima, runtime interval changes, failure retry, cancellation and close, watcher health/reconciliation ordering, last-valid-state retention, client token/stale-delivery behavior, one start/finish evidence pair, and concurrent environment/index isolation over the real provider.

A focused built-in coverage run over the three new modules reported `98.54%` lines and `96.47%` functions overall; `repository-engine.mjs` reported `100%` lines and functions. This is supplementary branch evidence rather than the repository-wide coverage gate.

The watcher-to-engine oracle was then run separately:

```sh
node --test --test-concurrency=1 test/repository-engine.integration.test.mjs
```

Observed result:

```text
tests 3
pass 3
fail 0
duration_ms 15328.573167
```

It proves that ignored noise and a sibling index do not rebuild the primary worktree; tracked/index/ref/config mutations match a fresh provider snapshot; quiet reads preserve index bytes; and reconciliation repairs failed or replaced watch roots.

Static validation:

```sh
node scripts/lint.mjs && \
npx eslint \
  src/refresh-scheduler.mjs src/repository-engine.mjs \
  src/repository-client.mjs src/process.mjs src/git-provider.mjs src/config.mjs \
  test/refresh-scheduler.test.mjs test/repository-engine.test.mjs \
  test/repository-client.test.mjs test/process.test.mjs test/config.test.mjs && \
git diff --check
```

Observed result: exit status `0` with no output.

## Acceptance coverage and limits

- **AC-1a / AC-6 scheduling seam:** default healthy reconciliation is 300 seconds with a tested 330-second maximum; degraded fallback is ten seconds with a tested eleven-second maximum. The checked-in performance witness owns the timed 60/330-second process-count proof.
- **AC-2:** fake-clock tests prove burst coalescing, one mid-read follow-up, manual priority, recovery collision coverage, and no overlapping provider execution.
- **AC-3 / AC-4 / AC-6:** the real watcher integration proves the engine/watcher mutation oracle, ignored-noise filtering, sibling-index isolation, index preservation, and root recovery. Classification detail belongs to A3.
- **AC-7:** engine and client unit tests prove close/abort and stale in-process delivery rejection. Coordinator election, IPC reconnect, sharing, and the 30-second process grace period remain Phase B work.
- **AC-8:** process and real-provider tests prove explicit concurrent environment/index isolation and continued optional-lock prevention for Phase A. Cross-process namespace, codec, and message bounds remain Phase B work.

This A2 implementation deliberately does not claim shared work across tabs. Phase A creates one engine per rail; the client seam is the boundary that Phase B must preserve while moving engine ownership behind the shared coordinator. It also does not claim a CPU improvement: that requires the isolated before/after performance witness after all integration work is stable.

## Source references

- Scheduler request, coalescing, recovery, and shutdown: `src/refresh-scheduler.mjs:1-286`
- Engine watcher seam and refresh coverage: `src/repository-engine.mjs:94-211`
- Engine public API and cleanup: `src/repository-engine.mjs:213-290`
- Client token and stale-delivery handling: `src/repository-client.mjs:20-116`
- Scoped Git process context: `src/process.mjs:163-195`
- Provider context entry: `src/git-provider.mjs:478-485`
- Reconciliation configuration: `src/config.mjs:18`, `src/config.mjs:123-135`, `src/config.mjs:200-213`
