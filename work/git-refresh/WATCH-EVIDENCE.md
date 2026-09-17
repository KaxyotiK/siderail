# Watcher and invalidation evidence

This note records the A3 watcher/classifier proof added with `src/git-invalidation.mjs`, `test/git-invalidation.test.mjs`, and `test/repository-engine.integration.test.mjs`. It is scoped to disposable repositories and injected watcher fixtures. No live Herdr rail, installation, or user configuration was touched.

## Implemented boundary

`createRepositoryWatcher` owns the native watchers for an engine. It watches the worktree plus the canonical per-worktree and common Git directories. Recursive worktree coverage is supplemented by non-recursive Git-metadata directory watches. This is required on Linux because an inotify watch attached to a file inode can go stale after Git atomically replaces that file; watching the containing metadata directory continues to report later replacements. Overlapping worktree metadata callbacks are suppressed when a dedicated metadata-directory watch covers them. It discovers Git/GitRail config, ignore, attribute, selected-index, and config-origin dependencies and watches their existing parents so creation and atomic replacement are observable. Reconciliation compares realpath/device/inode identities and reinstalls roots whose identity changed.

`createGitInvalidationClassifier` separates:

- tracked paths, tracked parents, nested-repository/submodule paths, ignore/config inputs, own index/HEAD/operation metadata, shared refs/config, and ambiguous inputs, which invalidate conservatively;
- healthy common-object traffic and known private sibling-worktree index/HEAD/operation paths, which do not rebuild the current worktree by themselves;
- unknown worktree paths, which use one NUL-delimited `git check-ignore --stdin -z` query per coalescing window and then cache the exact result until the tracked/index/ignore/config generation changes.

Missing filenames, invalid filename decoding, classifier failures, provider-error snapshots, unknown metadata, and changes during an in-flight classification all choose a conservative invalidation. There is no blanket lock-file exclusion.

## Real repository proof

The integration witness creates a real primary repository and linked sibling worktree under a temporary directory, starts the production repository engine with the production full provider and native watcher, and shortens only scheduler delays. After each positive mutation it waits for the event-driven generation, performs a separate fresh `getRepositoryState`, and deep-compares the complete state including Maps. It then waits beyond the burst window and asserts exactly one provider build.

Observed positive cases:

- tracked edit and tracked path matching an ignore pattern;
- atomic tracked-file replacement;
- unusual newline-containing untracked path, ordinary untracked create, and untracked delete;
- staging/index replacement, commit HEAD/index/ref burst, tracked rename, executable-mode change, and assume-unchanged transition;
- detached checkout, shared ref update, packed refs, and repository Git config;
- worktree-specific Git config and worktree `.gitignore` change;
- external XDG ignore-file creation and atomic replacement;
- global include-origin creation, discovery, and atomic replacement;
- unborn repository through first commit;
- real conflicting merge, rebase, and cherry-pick states plus aborts, a completed revert, bisect state/reset, and a sibling commit that updates a shared ref.

Observed negative cases:

- twelve rapid writes to an ignored output path caused one classifier Git query and zero provider builds;
- twelve later writes to that cached ignored path caused zero additional classifier processes and zero provider builds;
- a real linked sibling edit plus `git add` caused object/private-index activity but zero primary provider builds.

Every positive row matched the fresh full-provider oracle and coalesced to one provider build in the completed run.

The quiet read witness hashes the real index and records nanosecond mtime before and after two full provider reads. Both bytes and mtime remained identical, exercising the forced `GIT_OPTIONAL_LOCKS=0` path.

## Failure and liveness proof

An injected asynchronous watcher error closes the failed watcher, reports degraded health, and retries. The witness mutates the repository while the watcher is unavailable, then verifies that successful reinstallation emits a `watch-recovered` invalidation before reporting healthy. The engine therefore performs a full provider read and publishes the missed edit instead of waiting for the normal reconciliation interval. It then renames a watched root away, creates a different directory at the same requested path, invokes reconciliation, and observes an identity change, closure of the old watcher, and installation on the replacement. Double close is idempotent.

This deterministic failure test is paired with a native end-to-end replacement witness. That witness intentionally drops a real tracked-file event, invokes a reconciliation, and proves full-provider equality. It then renames the entire repository root away, initializes and commits a different repository at the same path, invokes reconciliation, observes identity change and watcher reinstallation, and verifies that a subsequent tracked edit from the replacement root reaches the engine and matches the oracle.

A missing loose tree object causes a real provider failure. The engine retains the exact previous snapshot, enters error status, and recovers through the configured one-second fallback after the object is restored. Index bytes and nanosecond mtime remain identical across quiet full reads.

One native event uses the production 125 ms burst delay and 2,000 ms minimum cadence after an eligible two-second quiet point. Its provider start is asserted within 500 ms of the write and publication within 2,000 ms. Busy-boundary timing remains covered by the scheduler's injected-clock tests.

## Proof command and result

```sh
node --test --test-concurrency=1 \
  test/git-watch.test.mjs \
  test/git-invalidation.test.mjs \
  test/repository-engine.test.mjs \
  test/repository-engine.integration.test.mjs
```

The latest macOS run on 2026-09-16 produced **29 passed, 0 failed** in 36.631 seconds. Eight real integration tests covered negative filtering, the mutation/oracle matrix, Git operation protocols, read-only index behavior and deterministic retry, unborn startup, missing-object recovery, silent-event/root replacement recovery, and production latency. Raw output is in `test-results/git-refresh/initial/macos-a-fixed.log`.

The Linux watcher-specific command was:

```sh
docker run --rm --network none -v "$PWD:/source:ro" node:24-bookworm sh -c \
  'mkdir -p /tmp/project && cd /source && \
   tar --exclude=.git --exclude=node_modules --exclude=test-results -cf - . | \
   tar -xf - -C /tmp/project && cd /tmp/project && \
   node --test --test-concurrency=1 \
     test/git-invalidation.test.mjs \
     test/repository-engine.integration.test.mjs'
```

Node 24 on Debian bookworm with Git 2.39.5 produced **16 passed, 0 failed** in 24.435 seconds. This run included the assume-unchanged index transition and two successive atomic updates of the same shared ref, the cases that specifically exercise the metadata-directory supplement. Raw output is in `test-results/git-refresh/initial/linux-a-fixed.log`.

## Remaining limits

The integration matrix constructs real conflict stages for merge, rebase, and cherry-pick, and exercises revert and bisect workflows. It does not enumerate every possible Git-version-specific operation marker. Unknown own-gitdir metadata remains a conservative invalidation, while final cross-platform and long-running loss/recovery evidence remains required by B3.

External configuration discovery depends on Git's `--show-origin` output and the known default XDG/user locations. A missing or unwatchable origin is protected by full reconciliation; this witness does not claim native delivery from a path that the operating system refuses to watch. Linux and macOS are covered; other operating systems still rely on the same conservative failure/reconciliation path without direct runtime evidence here.


The final integrated checks repeat this matrix on macOS Node 22/24 and Linux
Node 24. See [final evidence](EVIDENCE.md). The matrix's zero-throttle test mode
permits one necessary follow-up for a real mid-read invalidation and checks its
captured generation; the production-cadence single-edit and burst witnesses
still require exactly one shared build per window.
