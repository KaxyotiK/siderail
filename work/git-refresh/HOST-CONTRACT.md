# Herdr host-context contract

This contract records the A1 runtime decision for Herdr 0.8.2/protocol 20 on
macOS arm64. It is based on the checked-in isolated witness
`scripts/probe-herdr-refresh-contract.mjs` and its raw artifact at
`test-results/git-refresh/herdr-contract/report.json`. The Phase A adapter
witness is recorded separately at
`test-results/git-refresh/context-a/report.json`; the shared IPC witness is
`test-results/git-refresh/context-b/report.json`. The probe creates its own
named server, XDG roots, workspaces, tabs, panes, and cwd fixtures. It neither
links the plugin nor reads or mutates the live Herdr session. Teardown must stop
the named session, remove both socket and temporary root, and observe server
exit 0 before the probe passes.

## Decision

Use the **shared topology reconciliation fallback**.

Herdr lifecycle subscriptions are useful prompt invalidation signals, but Herdr
0.8.2 does not emit `pane_updated` when an existing shell changes its foreground
cwd. Six of ten topology/focus/move trials converged from events in 169–315 ms.
All ten authoritative `session.snapshot` checks were correct, but four
event-only trials retained a stale cwd:

| Trial | Event-only result | Authoritative snapshot |
| --- | --- | --- |
| Selected shell changes cwd | No relevant event in 2 s; old cwd retained | Correct new cwd |
| Create and focus a split | Passed in 255 ms | Match |
| Focus the original pane after its cwd changed | Focus event arrived; old cwd retained | Correct new cwd |
| Focus the split pane | Passed in 169 ms | Match |
| Focused split shell changes cwd | No relevant event in 2 s; old cwd retained | Correct new cwd |
| Create and focus a tab | Passed in 257 ms | Match |
| Create and focus a pane in that tab | Passed in 315 ms | Match |
| Return to a tab whose selected pane changed cwd | Focus event arrived; old cwd retained | Correct new cwd |
| Move a pane between tabs | Passed in 253 ms | Match |
| Move a pane to a new workspace | Passed in 314 ms | Match |

The probe also forced a snapshot/subscription gap. It took a snapshot, closed
the subscription, changed the selected shell cwd, and opened a new subscription.
The new subscription did not replay a cwd-bearing event. Its cache remained at
`cwd-5` while an independent snapshot reported `cwd-6`. Replacing the cache from
a fresh reconnect snapshot then matched a second independent snapshot exactly.
The protocol exposes no event sequence or atomic snapshot/subscription cursor,
so subscription alone cannot be treated as lossless.

The implementation rules are therefore fixed as follows:

- Phase A uses one direct `session.snapshot` initially and per nominal ten-second
  fallback interval per rail. That is one host request per interval instead of
  the previous three. It does not open an event subscription because this Herdr
  version's replay is undocumented and provides no cwd signal. Unchanged
  semantic context does not initiate Git work.
- Phase B owns one topology cache in the coordinator and reconciles it at most
  once per second. One unchanged `session.snapshot` is one host request
  coordinator-wide and causes zero Git queries or client redraws. A later event
  stream can reduce snapshot latency only after it supplies a complete ordering
  contract; it is not required for this branch.
- Every connection/reconnection obtains a new snapshot. A reconnect must never
  continue from its pre-disconnect cache.
- A later Herdr version may remove the fallback only after the same ten trials
  pass 10/10 and an ordering/cursor contract closes the reconnect gap.

## Documented transport and adapter boundary

Herdr documents newline-delimited JSON over a Unix domain socket (named pipe on
Windows). Managed panes receive `HERDR_SOCKET_PATH`; the isolated witness uses
the named session's socket under its private XDG config root. Requests contain
`id`, `method`, and `params`. A long-lived `events.subscribe` connection first
returns `subscription_started`, then event envelopes.

The Phase A adapter uses only `session.snapshot`. The table below records the
event vocabulary the probe evaluated; those subscriptions are deliberately not
opened by the production context source in this branch.

| Operation | Method / subscription | Use |
| --- | --- | --- |
| Bootstrap/reconcile | `session.snapshot` | Complete workspaces, tabs, panes, layouts, and focused IDs in one host request |
| Probe subscription | `events.subscribe` | Contract measurement only in Herdr 0.8.2 |
| Workspace | `workspace.created`, `.updated`, `.closed`, `.focused` | Replace/remove workspace records and active workspace |
| Tab | `tab.created`, `.closed`, `.focused`, `.moved` | Replace/remove tab records and active tab |
| Pane | `pane.created`, `.updated`, `.closed`, `.focused`, `.moved`, `.exited` | Replace/remove pane records and selected pane; cwd still needs reconciliation |
| Layout | `layout.updated` | Replace the complete layout for the event's tab |

Subscription request names use dot notation, while Herdr 0.8.2 emitted the
corresponding envelope names in snake case (`pane_focused`, `layout_updated`).
The adapter normalizes the first underscore to a dot before dispatch. Unknown
events and unknown fields remain ignorable for forward compatibility.

The observed server replayed 46 historical topology envelopes to every new
subscriber in this fixture, even though the 0.8.2 socket documentation does not
promise replay. Replayed events included stale `pane_created` cwd values after
later shell cwd changes. The production source therefore does not treat this
replay as an authoritative bootstrap or open the subscription. The checked-in
socket client remains the probe transport and future adapter building block: it
bounds an individual response line at 16 MiB, rejects malformed JSON/structured
errors, and cancels timed-out reads without letting them consume a later event.

Context identity is the tuple
`{workspaceId, tabId, selectedPaneId, foreground_cwd || cwd}`. A change to that
tuple changes the rail's repository subscription generation. An identical tuple
does not schedule a provider refresh. Pane-move replies/events can assign a new
public pane ID across workspaces; the cache removes `previous_pane_id` before
adding the returned pane and replaces any included source/target layouts.

## Subscriber cost and exact request counts

The Node 22 witness measured real subscriber processes after their historical
bootstrap stream became quiet. CPU is `process.cpuUsage` for the subscriber
workers only; RSS is the sum of their resident sets. It excludes the Herdr
server and therefore is not an application-wide performance result.

| Subscribers | Bootstrap events | Bootstrap CPU | Quiet window | Quiet events | Quiet CPU | Aggregate RSS |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 46 | 6.854 ms | 3.000 s | 0 | 1.392 ms | 38.912 MB |
| 8 | 368 | 42.863 ms | 3.000 s | 0 | 4.434 ms | 312.476 MB |

Each worker made exactly one `events.subscribe` request. The contract trial made
33 direct host requests: 15 `session.snapshot`, two `events.subscribe`, one
`ping`, one `workspace.create`, six shell-input requests, two `pane.split`, two
`pane.focus_direction`, one `tab.create`, one `tab.focus`, and two `pane.move`.
The snapshots are deliberate per-trial independent or reconnect oracles, not a
proposed production query rate.

Both supported local Node runtimes were present and completed the full probe:
Node 22.23.2 in `herdr-contract` and Node 24.19.0 in
`herdr-contract-node24`. The table above uses the Node 22 artifact. Node 24 also
resolved 6/10 event-only, 10/10 authoritative, selected the same fallback, and
cleaned every owned resource. No Linux runtime was available on this macOS host;
Linux remains a later A6/B3 completion gate rather than an inferred pass.

## Phase A adapter witness

The exact A4 witness ran the production snapshot selector and context source
against a second owned Herdr session. All ten trials passed, with exactly one
`session.snapshot` request by the adapter for each trial:

| Trial | Result | Context behavior |
| ---: | :---: | --- |
| 1 | Pass | Initial selected content |
| 2 | Pass | Foreground cwd reconciliation |
| 3 | Pass | New focused content pane |
| 4 | Pass | Selected-pane focus |
| 5 | Pass | Hidden tab reported `visible: false` |
| 6 | Pass | Refocused tab reported `visible: true` |
| 7 | Pass | Content pane moved away |
| 8 | Pass | Content pane moved back |
| 9 | Pass | Rail moved to a new workspace and reported `hasContent: false` |
| 10 | Pass | Content resumed beside the moved rail |

The rail's public pane ID changed during trial 9. The adapter followed the rail
by its stable terminal ID and published the new pane/workspace/tab identity.
One additional unchanged snapshot produced no publication. Closing and
recreating the source obtained a fresh snapshot whose selected context matched
an independent oracle. The source reported mode `phase-a-snapshot-fallback`, a
10,000 ms fallback interval, ten publications, semantic suppression, and
successful reconnect recovery.

The full witness made 58 direct host requests, including setup, mutations,
independent oracles, the original event-contract trials, subscriber
measurements, and teardown. It made 27 `session.snapshot` requests in total.
Those are proof-harness counts and must not be interpreted as a production
rate. The adapter's production rate remains one initial snapshot plus at most
one snapshot per rail per nominal ten-second interval, compared with the old
three CLI requests per interval.

The adapter witness ran subscriber measurement after creating more fixture
history than the A1 run. Herdr replayed 97 historical envelopes to one
subscriber and 776 to eight subscribers. Startup CPU was 8.305 ms and 64.686
ms respectively. During the following quiet three seconds there were zero
events; worker CPU was 0.704 ms and 4.746 ms, with aggregate RSS 39.420 MB and
312.492 MB. These figures measure only probe subscriber processes. The growth
from 46 to 97 replayed events per subscriber shows that replay cost depends on
session history, further supporting the snapshot-only Phase A source.

## Phase B coordinator namespace and context IPC contract

One coordinator owns one `createHerdrContextSource` instance for a compatible
namespace. Under the fallback selected above, that source reconciles once per
nominal second coordinator-wide. Clients do not start their own one-second
sources.

The private namespace hashes the protocol/platform/user identity, canonical
Herdr socket path, canonical checkout and all packaged runtime source bytes,
Git executable identity, effective Git-impact environment, and immutable
GitRail environment overrides. Mutable config-file contents are deliberately
excluded: an existing coordinator reloads that file, while different config
locations and explicit environment overrides still choose distinct namespaces.
The runtime path helper validates an owned, non-symlink mode-0700 directory,
uses short hashed components that fit the macOS Unix-socket limit, and the
coordinator sets its socket mode to 0600. The full namespace remains mandatory
in the handshake. Election records include a nonce, pid, and OS process-start
identity; stale cleanup never signals a pid or unlinks an unverified live
owner.

IPC uses a four-byte unsigned big-endian payload length followed by UTF-8 JSON.
Control frames are capped at 1 MiB and repository deliveries at 64 MiB.
Oversized frames are rejected at their declared length before body allocation.
Blocked writes have a five-second deadline; pending controls are bounded to 128
messages and 1 MiB, while only the newest delivery per subscription is retained.
An oversized repository snapshot produces the typed
`GIT_STATE_SNAPSHOT_TOO_LARGE` error for that subscription, which selects the
explicit in-process fallback. Ordinary connection failures remain visible and
do not silently change execution modes.

The strict host-context exchange is:

```text
client -> hello { protocolVersion, namespaceId, clientId }
server -> hello_ack { protocolVersion, namespaceId, coordinatorId }

client -> host_subscribe { requestId, subscriptionId, selector }
server -> response { requestId, ok, value? }
server -> host_delivery { subscriptionId, context }

client -> host_refresh { requestId, subscriptionId, reason }
client -> host_unsubscribe { requestId, subscriptionId }
client -> ping { nonce? }
server -> response | host_delivery | error | pong
```

The selector is `{railPaneId, railTerminalId?, sourcePaneId?, fallbackCwd?}`.
The context preserves the in-process adapter shape exactly:
`{cwd, sourcePaneId, tabId, workspaceId, railPaneId, railTerminalId,
hasContent, visible}`. The stable terminal ID lets the source follow a rail
whose public pane/workspace/tab identity changes. Unknown fields, overlong IDs
or reasons, executable paths, commands, argv, and environment payloads are
rejected before dispatch.

A new subscriber receives the current authoritative snapshot or participates
in the one in-flight initial refresh. Reconnecting clients handshake and
resubscribe; they do not resume an unsequenced pre-disconnect context. Semantic
comparison suppresses duplicate and unchanged host deliveries, including the
context returned by an explicit `host_refresh`. The last host subscriber closes
the shared source. Repository state uses the same framing and lifecycle, but a
schema-specific snapshot codec preserves `commitPathIndex` as a `Map` and
optional descriptor property presence without a generic tagged-value reviver.

## Phase B shared-source witness

The exact stage-B witness routes the same ten adapter mutations through the
real coordinator and client IPC. All ten contexts were correct, an unchanged
refresh produced no additional publication, and reconnect selected the same
context as an independent snapshot. It then launched separate Node client
processes against one coordinator for 1 and 8 clients. Each group ran for
1.250 seconds after ready:

| Client processes | Source factories | Herdr snapshots | Periodic rate | Worker CPU | Aggregate RSS |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 2 (initial + 1 periodic) | 0.800/s over the bounded window | _see current artifact_ | _see current artifact_ |
| 8 | 1 | 2 (initial + 1 periodic) | 0.800/s over the bounded window | _see current artifact_ | _see current artifact_ |

The equality of source factories and snapshot counts is the relevant scaling
result: increasing clients from one to eight did not increase Herdr query
frequency. Worker CPU and RSS scale with the deliberately separate client
processes and are recorded as raw observations, not attributed to the shared
source. The artifact also retains each worker result and the complete request
ledger. The named Herdr session, coordinator sockets, and temporary XDG roots
were all removed and the Herdr server exited zero.

## Reproduction

```sh
/opt/homebrew/opt/node@22/bin/node --test test/herdr-socket-client.test.mjs
/opt/homebrew/opt/node@22/bin/node scripts/probe-herdr-refresh-contract.mjs \
  --isolated \
  --trials 10 \
  --deadline-ms 2000 \
  --measure-subscribers 1,8 \
  --out test-results/git-refresh/herdr-contract

/opt/homebrew/opt/node@22/bin/node scripts/probe-herdr-refresh-contract.mjs \
  --isolated \
  --verify-adapter \
  --trials 10 \
  --deadline-ms 2000 \
  --measure-subscribers 1,8 \
  --out test-results/git-refresh/context-a

/opt/homebrew/opt/node@22/bin/node scripts/probe-herdr-refresh-contract.mjs \
  --isolated \
  --verify-adapter \
  --candidate-stage B \
  --trials 10 \
  --deadline-ms 2000 \
  --measure-subscribers 1,8 \
  --out test-results/git-refresh/context-b
```

The socket test reports eight passing assertions. The adapter/context/socket
targeted suite reports 21 passing assertions on both Node 22 and Node 24. The
probe exits zero when
all ten mutations are correct by an independent snapshot, reconnect recovery
matches an independent snapshot, the conservative branch is selected for any
event-only failure, the optional adapter passes all ten semantic trials and its
suppression/reconnect checks, and owned teardown succeeds. It does not turn a
6/10 event result into a false event-source pass.


## Original automatic Phase B acceptance

The final proof is `test-results/git-refresh/context-b-accepted/report.json`
(Node 24.19.0, Herdr 0.8.2 protocol 20). Earlier adapter trials forced refreshes,
which established semantics but could not prove the normal timer's latency.
The corrected checked-in probe passively observes the production shared source
for Phase B and records elapsed time; all ten final trials pass the 2 s limit.

| Trial | Automatic observation (ms) |
| --- | ---: |
| initial selected content | 108.235 |
| foreground cwd reconciliation | 919.686 |
| new focused content pane | 1019.694 |
| selected pane focus | 1072.970 |
| hidden tab context | 1021.304 |
| visible tab context | 872.410 |
| content pane moved away | 1131.118 |
| content pane moved back | 1029.354 |
| rail move reaches no-content state | 969.450 |
| content resumes beside moved rail | 1119.619 |

Unchanged-context suppression and reconnect equality pass. Separate one/eight
real IPC-client measurements each create one source, with client-count-independent
snapshot requests. Owned server exit, socket removal and temporary-root removal
all pass. Reproduce with the Phase B command above, changing the output directory
to a new empty path (the accepted run used `context-b-accepted`). Linux is
independently validated by the full runtime command in [EVIDENCE.md](EVIDENCE.md);
the host probe's own `linuxRuntimeAvailable` field is not that runtime check.


## PR-review candidate automatic acceptance

The fresh probe uses `test-results/git-refresh/review-host-context/report.json`
and the unchanged Phase B command with that new output directory. The public
path-normalized recording is [HERDR-CONTEXT-ACCEPTANCE.json](HERDR-CONTEXT-ACCEPTANCE.json);
the raw recording remains local. All ten automatic trials, unchanged-context
suppression, reconnect equality, one/eight-client source sharing and owned
teardown pass against the reviewed runtime.

| Trial | Automatic observation (ms) |
| --- | ---: |
| initial selected content | 104.062 |
| foreground cwd reconciliation | 915.879 |
| new focused content pane | 915.604 |
| selected pane focus | 1057.844 |
| hidden tab context | 1070.947 |
| visible tab context | 1020.299 |
| content pane moved away | 972.299 |
| content pane moved back | 1019.856 |
| rail move reaches no-content state | 971.772 |
| content resumes beside moved rail | 1020.918 |
