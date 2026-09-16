# Git refresh integration contracts

**Status:** A1 source contract complete; the Herdr runtime branch and baseline measurements are recorded separately in `EVIDENCE.md`.
**Scope:** contracts required by A2/A3 and the later Phase B coordinator.
**Source revision audited:** `6603d33c61b6646b4a54806b028961c8fd1379e2` plus the planning-only files in this worktree.

This document separates behavior observed in the current source from proposed interfaces. “Required” below is an implementation constraint from the accepted plan, not a claim that the code already satisfies it.

## Current provider boundary (observed)

`getRepositoryState(cwd, options)` first resolves the repository with `git rev-parse --show-toplevel`, canonicalizes it with `realpath`, and falls back to a bounded directory scan outside a repository (`src/git-provider.mjs:44-110`, `src/git-provider.mjs:478-513`). A repository read then resolves the display name and branch, selects a base, and runs status, staged/unstaged/base comparisons, `ls-files`, upstream counts, and bounded history queries (`src/git-provider.mjs:514-613`). A typical read therefore depends on much more than the worktree files.

The provider's explicit limits are:

| Input | Current bound | Effect |
| --- | ---: | --- |
| History | 200 first-parent commits | `commits` and `commitPathIndex` |
| Untracked content statistics | 256 files, 16 MiB aggregate, 250 ms | line/binary statistics; paths still come from status |
| Non-repository directory scan | 2,000 files, depth 16, 250 ms | Files-mode state |
| Worktree-presence checks | 2,000 candidates, 250 ms, concurrency 16 | assume-unchanged/sparse/recreated path presence |
| Ordinary Git stdout | 16 MiB per process | inherited `runCommand` limit |
| Raw plus numstat change query | 32 MiB per process | staged, unstaged, workspace, and against-base lists |
| Git command time | 8 seconds by default | a timed-out read fails and retains the prior snapshot in the UI |

These are per-operation bounds. There is no current aggregate bound on an in-memory repository snapshot. Several independently bounded query results can coexist, and parsed objects are larger than their Git output. IPC must therefore reject or isolate an oversized snapshot rather than truncate it.

### Configuration split

`loadConfig` merges defaults, `~/.config/git-rail/config.json` (or the path below `XDG_CONFIG_HOME`), and selected `GIT_RAIL_*` overrides (`src/config.mjs:159-204`). The current provider places the entire resulting configuration in every state even though only these fields affect a full repository build:

- `baseRef` changes base selection.
- `limits.maxFileBytes` changes untracked-file statistics.
- configuration validation errors and invalid base errors affect the displayed state/error.

`refresh.pollIntervalMs` affects scheduling, not provider output. The proposed `refresh.reconcileIntervalMs` will do the same. `limits.maxDiffBytes`, editor/viewer rules, Herdr auto-open, and sidebar width are client-side UI/preview inputs. They must remain local to each rail and must not be borrowed from the coordinator's first client.

Required extraction: context resolution loads configuration once and produces (1) `providerConfig`, (2) `schedulerConfig`, (3) `localUiConfig`, and (4) ordered local validation errors. The engine snapshot contains repository/provider data. A client compatibility adapter combines that snapshot with its own UI config and errors where the current terminal still expects `state.config` and `state.configErrors`. A GitRail config change that alters an engine-key field makes the old context stale and causes context re-resolution; it is not applied silently under the old key.

### Environment propagation gap

The `options.env` argument to `getRepositoryState` is currently used only by `loadConfig` (`src/git-provider.mjs:481`, `src/git-provider.mjs:514`). Internal Git calls do not pass it. `runGit` invokes the literal command `git`, and `runCommand` merges an explicit override into the ambient `process.env` or otherwise passes `process.env` unchanged (`src/process.mjs:32-35`, `src/process.mjs:159-166`). `GIT_OPTIONAL_LOCKS=0` is the sole forced Git override.

Consequences:

- live rails use their entire inherited process environment for Git discovery, configuration, index, refs, objects, locale, and executable lookup;
- a coordinator cannot reproduce a client merely from `cwd` and GitRail config;
- passing one client's raw environment over IPC would expose unrelated variables and could borrow secrets or command hooks;
- letting a shared engine inherit whichever rail won startup would be nondeterministic.

Before repository engines may share, A2 must introduce an explicit scoped Git runner/environment. An `AsyncLocalStorage` process context or an explicitly injected runner is acceptable, provided concurrent engines cannot see one another's context and every provider/watch/classifier Git call uses it. Tests must run two simultaneous contexts with distinct index/config inputs and prove there is no cross-read.

## Repository context and sharing key (required)

Context resolution is read-only and returns an immutable object. Paths are absolute and canonical where they exist.

```js
{
  kind,                  // "repository" | "directory"
  cwd,                   // selected host cwd; canonical directory fallback
  repoRoot,              // canonical worktree root, repository only
  gitDir,                // canonical per-worktree gitdir
  commonGitDir,          // canonical common gitdir
  indexPath,             // selected index path; path identity, not current inode
  rootIdentity,          // { realpath, dev, ino } captured with bigint values as strings
  gitDirIdentity,
  commonGitDirIdentity,
  gitExecutable,         // { realpath, dev, ino, size, mtimeNs }
  providerEnvironmentId, // opaque digest, never raw environment values
  providerConfig,        // { baseRef, maxFileBytes }
  schedulerConfig,       // effective fallback/reconcile intervals and watch mode
  configSources,         // canonical GitRail config paths to observe
  engineKey,             // canonical digest of all result/scheduler inputs below
  shareable,             // false with a stable reason if reproduction is unsafe
  protocolVersion,
  codeVersion,
}
```

`engineKey` includes `kind`; canonical root; canonical gitdir/common-dir; selected index path; provider and scheduler config; Git executable identity; provider-environment digest; protocol/code version; and test-only provider options if such a context is deliberately shareable. It does **not** include current index inode because ordinary staging atomically replaces the index. Root/gitdir inode changes are liveness events on an existing key and require watcher reinstall plus a full read. A distinct selected index path (`GIT_INDEX_FILE`) is a distinct key.

The executable is resolved using the client's effective `PATH`; identity includes canonical path and stat identity. IPC never accepts a command or executable path to run. The coordinator resolves its own executable and accepts sharing only when its identity equals the requested identity.

### Provider environment identity

The compatibility digest is computed from a stable, sorted encoding with explicit unset markers. It includes:

- every inherited variable whose name starts with `GIT_`, including numbered `GIT_CONFIG_KEY_n` and `GIT_CONFIG_VALUE_n` entries;
- `HOME`, `XDG_CONFIG_HOME`, `PATH`, `LANG`, `LANGUAGE`, `LC_ALL`, every `LC_*` variable, and `TZ`;
- the platform and effective uid, because executable/config discovery and path behavior differ;
- an explicit forced value of `GIT_OPTIONAL_LOCKS=0`.

Including all `GIT_*` variables is intentionally conservative. Important known inputs include `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, object/alternate-object paths, namespace/replacement/shallow inputs, discovery ceilings, config paths/count entries, attributes controls, executable path controls, and pathspec controls. Variables used only by GitRail UI are represented by their resolved semantic config rather than copied wholesale.

Only the opaque digest crosses IPC. It is also part of the private coordinator namespace: a daemon inherits the environment of the client that creates that namespace, computes the same digest locally, and accepts only exact matches. A client with a different digest selects a different private namespace or, if that namespace cannot be created safely, receives `incompatible-provider-environment` and uses an isolated in-process engine. Phase B may later add a narrowly typed, non-secret override only with a corresponding key and tests; it must never transmit or log the raw process environment. This sacrifices some sharing between unusual launcher environments to preserve correctness and secrecy.

Config file contents are watched dependencies, not content hashes in the engine key. All clients with the same source paths/environment observe the same files. A changed GitRail provider/scheduler field causes re-resolution and a new engine key. Changed Git configuration causes a conservative read and dependency-origin rediscovery.

## Engine, client, and scheduler API (required for A2)

The production implementation may choose class or function syntax, but these semantics and names form the test contract.

```js
const engine = createRepositoryEngine({
  context,
  readState,       // ({ context, signal }) => Promise<legacyProviderState>
  watchFactory,    // observer created only after context is resolved
  schedulerFactory,
  clock,
  random,
});

const client = createRepositoryClient({ openSubscription });
const handle = client.subscribe(context, listener);

handle.contextToken;                    // generated per subscription, never reused
await handle.ready;                 // first valid snapshot or terminal startup error
handle.latest();                    // latest delivery or null; no I/O
await handle.refresh("manual");     // resolves when the covering read settles
await handle.close();               // idempotent; invalidates this token
await client.close();               // closes all handles owned by this client
```

`context` is immutable and safe to share between subscriptions. `subscribe` generates the token. Switching cwd/worktree creates a new subscription/token and closes the old one; no mutable `setContext` may let a late completion acquire a new meaning. A delivery is:

```js
{
  contextToken,
  stateGeneration,       // monotonic within one engine lifetime
  inputGeneration,       // highest dirty generation covered by this read
  status: "starting" | "healthy" | "degraded" | "stale" | "error" | "closed",
  snapshot,              // present after a successful build
  error,                 // typed/safe summary; prior snapshot remains on refresh failure
  refreshedAt,
  reconciliationDueAt,
}
```

Listeners are notified asynchronously and in generation order. `latest()` returns the exact latest immutable-by-contract delivery. Published snapshots are never mutated by the engine after delivery; deep-cloning/freezing every large snapshot is not required. Listener failure cannot stop the engine or another listener. Every delivery is checked against its subscription token, so a completion from a closed or previous context is discarded.

The watcher adapter returns `{ close(), reconcile(snapshot), updateSnapshot(snapshot) }` (the last two may be one method). It reports `onInvalidation(event)`, `onHealth({ healthy, error })`, and root-identity changes to the engine. `close()` is idempotent and prevents later callbacks from taking effect.

### Scheduler requests

The scheduler receives injected `now`, `setTimeout`, `clearTimeout`, `random`, and a promise-returning `run`. Its public operations are:

```js
scheduler.request({
  kind: "dirty" | "manual" | "reconcile" | "fallback",
  dirtyGeneration, // required only for dirty requests
  reason,
});
scheduler.setWatchHealth({ healthy, error });
scheduler.close();
```

Required behavior:

- At most one provider read is running for an engine.
- Dirty events increment the engine's input generation. Events before a read starts coalesce into that read. A higher dirty generation observed during a read queues exactly one follow-up; repeated events only advance the generation.
- A manual request is a ticket. If it occurs after the running read began, one follow-up covers it; otherwise the scheduled/read result that includes it resolves the ticket. Manual refresh may bypass the dirty-event minimum cadence when idle.
- A due reconciliation/fallback is satisfied by any successful full read that starts after that due request. A timer colliding with such a read does not queue another read.
- Dirty work uses the existing 125 ms burst delay and 2,000 ms minimum start cadence. The plan's quiescent 500 ms target applies only when at least two seconds have elapsed since the prior scheduled start.
- Successful full reads reset the healthy reconciliation deadline. Receiving an event or failing a read does not postpone it. Default healthy delay is 300,000 ms with ±10% jitter, so the maximum is 330,000 ms.
- Watch failure enters explicit degraded state, schedules the shared fallback at the configured 10,000 ms default with ±10% jitter (11,000 ms maximum), and starts bounded watcher retry. Watch recovery returns to healthy scheduling after roots are revalidated.
- Close clears timers, aborts/awaits owned work, rejects unresolved tickets with a typed closed error, and releases watchers. Phase B may retain an idle engine only within the documented maximum 30-second grace period.

`refresh.pollIntervalMs` remains the degraded/poll-only input (1,000-300,000 ms). `refresh.reconcileIntervalMs` is the healthy input (30,000-3,600,000 ms, default 300,000 ms). Both are validated before jitter; zero is invalid. `watch-only` suppresses ordinary fallback while watchers are healthy but cannot suppress explicit error recovery or the full correctness contract. `poll-only` installs no filesystem watcher and uses the degraded interval. Exact compatibility behavior must remain visible in status and tests.

## Git dependency and invalidation contract (required for A3)

### Worktree and index inputs

The provider observes all tracked and untracked worktree paths through status/diff and performs bounded direct reads of untracked files. Relevant worktree events therefore include create, delete, content/metadata change, rename, and atomic replacement. Special cases that remain relevant are tracked paths matching ignore rules, executable/symlink/type changes, sparse and assume-unchanged entries, `.gitmodules`, nested repository/submodule metadata, `.gitattributes`, and every `.gitignore` that can affect a descendant.

The selected index is the per-worktree index under `gitDir` unless `GIT_INDEX_FILE` selects another path. `index`, `index.lock` transitions, sparse-index changes, and index replacement invalidate the owning engine. A sibling worktree's index is not relevant to this engine unless the same event batch also contains a shared dependency change or classification is ambiguous.

### Per-worktree Git metadata

Treat these conservatively as relevant under the engine's own gitdir:

- `HEAD`, own reflog/head state, selected index and split-index/shared-index references;
- worktree-private refs such as `refs/bisect/**` and `refs/worktree/**`;
- `config.worktree` when worktree config is enabled;
- merge, rebase, cherry-pick, revert, bisect, sequencer, and autostash/auto-merge state, including unknown new operation markers;
- the `.git` indirection file and commondir/gitdir linkage for linked worktrees.

The classifier should name known paths for useful metrics, but an unknown own-gitdir path is a conservative invalidation rather than an ignore rule.

### Shared Git metadata

The current base algorithm consults configured `branch.<name>.gitrail-base`, `origin/HEAD`, local `main`/`master`, remote main/master, arbitrary configured refs, and `HEAD`; tracking consults `@{upstream}`; history/diffs resolve the selected refs (`src/git-provider.mjs:138-190`, `src/git-provider.mjs:417-460`). Accordingly, changes to `refs/**`, `packed-refs`, shared `HEAD`-reachable objects, and ref logs used for resolution are potentially relevant to every engine sharing the common dir.

Shared `config`, `info/exclude`, `info/attributes`, alternates/shallow/replace/grafts inputs, and configured include/origin files are dependencies. Object creation and transient lock traffic alone can be suppressed only while a valid snapshot exists and no ref/config/operation/error signal requires recovery. A provider missing-object error, changed alternate/shallow input, or unknown shared metadata event forces conservative recovery. There is no blanket `*.lock`, `objects/**`, or `worktrees/**` exclusion.

### External config, ignore, and attribute inputs

After context resolution and after a relevant config/HEAD change, discover the effective Git config origin set using Git's documented config-origin output under the same scoped runner. It includes repository/worktree, user/XDG, system, command-scope, and recursively included files. Watch existing origins and their parent for atomic replacement; a missing/unwatchable origin is covered by reconciliation and makes filtering conservative. Do not treat environment-provided config values as files.

Ignore dependencies are all applicable worktree `.gitignore` files, `commonGitDir/info/exclude`, and the effective `core.excludesFile`. Attribute dependencies are applicable `.gitattributes`, `commonGitDir/info/attributes`, effective `core.attributesFile`, and system attributes unless disabled. Config origin rediscovery follows branch/HEAD changes because `includeIf` applicability can change.

Unknown worktree paths are classified in one NUL-delimited `git check-ignore --stdin -z` batch per coalescing window through the scoped read-only runner. Cache classification by `{engineKey, ignoreGeneration, path}`. Any index, tracked-set, ignore, or relevant config change advances the ignore generation. A known ignored untracked path causes no provider read; repeated writes cause no additional classifier process in that generation. A tracked path is always relevant regardless of ignore output. Missing filenames, classifier failure, invalid bytes, or ambiguity cause one conservative dirty generation.

### Reconciliation and root identity

Each installed root records `{requestedPath, realpath, dev, ino}` with device/inode serialized as decimal strings. Every full reconciliation re-resolves and stats the worktree, gitdir, common dir, selected index parent, and external watched-file parents. Disappearance or identity change closes affected watchers, reinstalls them without duplication, invalidates classification caches, and forces the full oracle read. Unchanged identities do not prove that no event was lost; reconciliation still performs a provider read.

## Full-provider oracle mutation matrix (required A3 proof)

For every positive row, the event-driven result must deep-equal a fresh isolated `getRepositoryState` result under the same scoped runner after normalizing only the current relative-age field. Once A5 stores absolute commit timestamps, no time normalization should be necessary. The negative rows must produce zero provider builds. Every test also records classifier and Git process counts.

| Mutation | Expected dependency/result |
| --- | --- |
| Tracked edit, chmod/type/symlink change, delete, rename, atomic replace | One coalesced build; full-oracle equality |
| Untracked create/content/delete, including unusual but valid path bytes | One coalesced build unless proven ignored; full-oracle equality |
| Stage, unstage, conflict stages, sparse/assume-unchanged index transition | Owning index invalidates; full-oracle equality |
| Commit/amend/reset | Own HEAD/index plus shared ref/object effects coalesce to one build |
| Branch switch, detached HEAD, unborn transition | Branch/base/history and config origins are recomputed |
| Configured base, upstream, `origin/HEAD`, loose ref, packed-ref change | Affected engine builds and equals oracle |
| Merge/rebase/cherry-pick/revert/bisect/sequencer state change | Conservative positive; no stale operation/index/ref state |
| Local `config`, `config.worktree`, global/system/include file change | Config origins rediscovered; affected result/base/ignore behavior equals oracle |
| Nested `.gitignore`, info/exclude, external excludes change | Ignore generation advances; tracked positives preserved; ignored-noise negatives reclassified |
| `.gitattributes`, info/attributes, external attributes change | Conservative positive because diff/binary behavior may change |
| Submodule or nested repository worktree/Git metadata change | Superproject state refreshes when Git's oracle changes |
| Shared alternates/shallow/replace/grafts input or missing-object recovery | Conservative positive and last valid snapshot retained on error |
| Worktree/gitdir/common-dir rename, removal, or same-path replacement | Identity mismatch reinstalls watchers and forces oracle build |
| Different linked worktree index only | Zero build for unaffected engine when no shared dependency changed |
| Repeated known ignored untracked output | Zero provider builds and, after first classification, zero classifier launches in same generation |
| Shared `objects/**` or known transient lock traffic only | Zero build while snapshot is healthy; injected provider/object error is the positive control |
| Unknown/missing filename or injected lost event | Conservative build immediately or by the bounded reconciliation contract |

Read-only proof captures selected-index content hash, byte size, and nanosecond mtime before and after quiet reads and classifications. Every Git process must see `GIT_OPTIONAL_LOCKS=0`. The oracle is a new provider invocation, not a comparison to hand-authored expected rows.

## Snapshot and IPC codec contract (required before B1)

### Observed state shape

Repository snapshots are acyclic JavaScript data composed of objects, arrays, strings, finite numbers, booleans, null/absent optional properties, descriptors, and one required `Map`: `commitPathIndex` (`src/git-provider.mjs:427-460`). Descriptors are value objects with kinds `clean`, `filesystem`, `workspace`, `against`, `staged`, `unstaged`, `untracked`, and `commit`; preview behavior depends on fields including `baseRef`, `mergeBase`, `commitHash`, `parentHash`, and `comparison`. Files contain nested `states` with their own descriptors and mode/rename/submodule metadata (`src/model.mjs:20-64`).

No consumer currently relies on object-reference aliasing between descriptor objects. Selection identity serializes descriptor values, and preview code branches on descriptor fields (`src/model.mjs:3-12`, `src/preview-provider.mjs:49-94`). The codec must preserve descriptor **values and property presence**; it need not preserve shared object references. In particular, absent `parentHash` and `parentHash: ""` have different meanings.

Current commit records store Git's `%ar` relative-age text as `age` (`src/git-provider.mjs:427-450`, `src/git-parsers.mjs:18-25`). That makes otherwise unchanged provider output depend on wall time and cannot support a zero-IPC local age timer. A5 must change the fifth log field to `%at`, parse it as a finite `authoredAtMs` number (Git seconds multiplied by 1,000), and derive display age in the visible client. This keeps the Git command count unchanged. `authoredAtMs` is an ordinary codec scalar; legacy parser fixtures may retain an explicit compatibility case for the old `age` field, but new repository snapshots use the timestamp.

### Encoding and validation

Use a versioned, typed envelope and a schema-specific repository-state codec. Encode `commitPathIndex` as ordered `[hash, paths]` entries and reconstruct a real `Map` on decode. Do not use a generic JSON reviver that treats arbitrary repository property names as executable/type tags. Validate protocol version, message type, required fields, descriptor kinds, finite/safe numbers, arrays, map keys/values, and generation/token formats before delivery. Reject duplicate map keys, prototype-polluting keys in dictionary positions, unknown control messages, and trailing/multiple payloads. The protocol carries data only and cannot request an arbitrary command.

Codec conformance is `assert.deepStrictEqual(decoded, original)` plus `decoded.commitPathIndex instanceof Map`, property-presence assertions for descriptors, selection-key equality, files-signature equality, and preview-argument equality across every descriptor kind. Test empty, unborn, detached, non-repository, conflict, rename, binary/symlink/submodule, truncated-history, and 200-commit snapshots.

### Bounds and backpressure

- Maximum control/request frame: **1 MiB UTF-8 bytes**.
- Maximum encoded snapshot frame: **64 MiB UTF-8 bytes**.
- Length is checked before allocation/parse; incomplete or oversized frames close only that connection.
- One connection may have one frame actively writing and one replaceable pending snapshot/status delivery. A newer state generation replaces the pending state; control replies remain bounded to 128 entries or 1 MiB total, after which the connection closes.
- A blocked write has a 5-second deadline. Reconnect obtains `latest()` rather than replaying every missed generation.
- At most one decoded snapshot and one encoded/pending snapshot are intentionally retained per engine/connection; metrics expose encoded size and oversize rejection.

The 64 MiB limit is an operational IPC bound, not a claim that the current provider's aggregate state is always smaller. If encoding exceeds it, the coordinator emits typed `snapshot-too-large` metadata without truncation, marks that context non-shareable for the process lifetime (until its key changes), releases the shared subscription, and the rail starts an isolated in-process engine. This is a correctness-preserving performance fallback and must be tested. A later increase requires measured memory/latency evidence and a protocol-version review.

## A2/A3 implementation handoff

A2 can proceed when its tests enforce the immutable context/token, scoped runner, scheduling, and config split above. It should not yet implement the Phase B socket, but its in-process transport must use the same delivery object and codec-compatible state boundary. The engine owns the only startup provider call; the terminal must not race it with an independent read.

A3 can proceed with conservative classification first. Filters are enabled only for rows proved by the mutation matrix. Any unimplemented/unknown dependency remains a dirty event, while known ignored output, sibling index traffic, and healthy object-only traffic are the narrowly proven negative cases. Reconciliation remains the full provider oracle even after all event tests pass.

## B1 concrete protocol and identity API

This section records the implemented protocol/identity boundary that B1's
coordinator and client consume. It does not start the shared runtime before the
A6 gate.

`src/git-state-protocol.mjs` exports:

```js
PROTOCOL_VERSION
MAX_CONTROL_FRAME_BYTES       // 1 MiB
MAX_SNAPSHOT_FRAME_BYTES      // 64 MiB
MAX_QUEUED_CONTROL_MESSAGES   // 128
MAX_QUEUED_CONTROL_BYTES      // 1 MiB
MAX_BLOCKED_WRITE_MS          // 5 seconds
ProtocolError
encodeFrame(message, { maxBytes })
createFrameDecoder({ maxBytes, onMessage, onError }) // { push, end, reset }
encodeSnapshot(snapshot)
decodeSnapshot(encoded)
validateClientMessage(message)
validateServerMessage(message)
```

Frames use a four-byte unsigned big-endian byte length followed by one UTF-8
JSON payload. The decoder allocates only after validating the declared length,
handles partial/multiple frames, enters a failed state after malformed input,
and requires an explicit reset before reuse. Socket owners apply the 1 MiB cap
to client/control frames and 64 MiB only to repository deliveries containing an
encoded snapshot. The exported queue/deadline constants are mandatory limits
for the coordinator transport rather than advisory defaults.

The snapshot envelope has one schema-defined special value:
`snapshot.commitPathIndex` encodes as ordered `[commitHash, paths]` pairs and
decodes to a real `Map`. An explicit property-path list preserves own properties
whose value is `undefined`, including the distinction between an absent
descriptor field and a present empty/undefined value. Maps elsewhere, cyclic
values, non-finite numbers, sparse arrays, duplicate commit keys, forged paths,
and unknown envelope fields are rejected. No repository property can activate
a generic type reviver.

The strict client message types and fields are:

```text
hello { protocolVersion, namespaceId, clientId }
repository_subscribe { requestId, subscriptionId, cwd, namespaceId }
repository_refresh { requestId, subscriptionId, reason }
repository_unsubscribe { requestId, subscriptionId }
host_subscribe { requestId, subscriptionId, selector }
host_refresh { requestId, subscriptionId, reason }
host_unsubscribe { requestId, subscriptionId }
ping { nonce? }
```

The host selector is
`{railPaneId, railTerminalId?, sourcePaneId?, fallbackCwd?}`. The server types
are `hello_ack`, `response`, `repository_delivery`, `host_delivery`, `status`,
`error`, and `pong`. A repository delivery carries the engine delivery fields
and an `encodeSnapshot` envelope. A host delivery carries the exact semantic
context `{cwd, sourcePaneId, tabId, workspaceId, railPaneId, railTerminalId,
hasContent, visible}`. Unknown top-level/nested control fields, overlong IDs or
reasons, and any client command, executable, argv, or environment field are
rejected before dispatch.

`src/git-state-identity.mjs` exports:

```js
collectEffectiveGitEnvironment(environment, options)
digestEffectiveGitEnvironment(environment, options)
resolveGitExecutableIdentity(options)
computeCodeFingerprint(runtimeFiles, { checkoutPath, ...io })
createCoordinatorIdentity(options)
preparePrivateRuntimePaths(options)
validateOwnedRuntimeDirectory(directory, options)
resolveRepositoryIdentity(options)
```

The effective Git digest includes platform, uid, `PATH`, `HOME`,
`XDG_CONFIG_HOME`, locale/TZ inputs, and every effective `GIT_*` variable except
the enumerated GitRail application/UI variables whose resolved semantics live
in host/provider/scheduler/client context. It forces `GIT_OPTIONAL_LOCKS=0`.
Unknown future `GIT_*`, including unknown `GIT_RAIL_*`, remain conservative
digest inputs. Only the digest crosses IPC.

The executable identity resolves the inherited `PATH` and records canonical
path, device, inode, size, and nanosecond mtime. The code fingerprint hashes the
canonical checkout path plus sorted relative path/content for every actual
coordinator/client/runtime source and launcher passed by the caller; docs and
tests are excluded. Thus an active installation and a worktree do not collide
even when their package versions match. The coordinator namespace hashes
protocol/platform/uid, canonical Herdr socket, code fingerprint, opaque
Git-impact environment digest, and the locally resolved Git executable
identity. Both client and coordinator recompute these inputs; the coordinator
compares the handshake namespace with its own result and never accepts a
client-supplied namespace as authority.

`preparePrivateRuntimePaths` returns
`{runtimeDirectory, socketPath, leasePath}`. It creates/validates only owned,
non-symlink mode-0700 directories and does not claim a lease or unlink a path.
It shortens the namespace directory while the full namespace remains mandatory
in the handshake, keeping macOS Unix socket paths within 103 bytes. The socket
owner must set mode 0600 after binding. Owner election separately validates a
lease nonce plus OS process-start identity; these helpers contain no pid signal
or stale-path unlink operation.

`resolveRepositoryIdentity` runs only bounded identity `rev-parse` commands
under the inherited scoped Git environment. Its exact result is:

```js
{
  kind: "git" | "filesystem",
  canonicalCwd,
  worktreeRoot,
  gitDir,
  commonGitDir,
  indexPath,
  identityId,
}
```

For Git contexts, `canonicalCwd` retains the client's selected directory, while
the identity and provider engine use canonical `worktreeRoot`. Two subdirectories
of one worktree therefore share one engine; client-local state overlays the
selected cwd. A relative selected index resolves from `worktreeRoot`, matching
the provider's Git working directory. Linked worktrees have distinct gitdir and
index identities while retaining their shared common gitdir. Provider/scheduler
configuration, executable identity, environment digest, protocol/code version,
and canonical paths participate in `identityId`. Root/gitdir/common-dir device
and inode do not: replacing a root at the same canonical path is a liveness
event on the existing engine key, handled by watcher revalidation. Ordinary
non-repositories use a canonical filesystem identity. Missing executables,
unsafe paths, and
ambiguous Git identities fail explicitly so the caller can select the documented
in-process fallback instead of sharing an uncertain context.
