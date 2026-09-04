# Production hardening checklist

Working checklist from the adversarial review of `main` @ `6c7d9ac` (2026-08-23).
The highest-risk findings were reproduced or measured on macOS 15 / Node 22;
their evidence is in the appendix. The remaining items have explicit acceptance
witnesses in their implementation outlines. Unlike `PRODUCTION-READINESS.md`,
this document records what is **not** yet true.

Legend: `[ ]` open · `[x]` done · **(Dn)** blocked on a decision below.

## Decisions

| # | Decision | Status | Recommendation |
| --- | --- | --- | --- |
| D1 | Does GitRail support repository-level configuration? | accepted | No. Remove `.git-rail.json` discovery and merging entirely. Configuration comes only from built-in defaults, user configuration, and explicit environment overrides. |
| D2 | May GitRail add development-only verification dependencies while retaining zero runtime dependencies? | accepted | Yes. Pin development tooling in `package-lock.json`; runtime entrypoints must not import it. The exact linter and rules are an engineering choice. |
| D3 | Add an Untracked section, or correct the docs? | accepted | Add a distinct, expanded-by-default Untracked section immediately after Unstaged. Use `?` as its section and row glyph, matching Git's status notation. |
| D4 | Does GitRail ship JSON Schema/editor integration for configuration? | accepted | No. Remove `$schema` from the example and runtime contract, delete the standalone schema and schema-specific tests/docs, and keep `validateConfig` as the single configuration authority. |
| D5 | May GitRail reconstruct a user's pane layout to force an outer-right rail? | accepted | No. Automatic and explicit opening may create only a directly safe outer-right split; otherwise they leave the tab unchanged and report the skip. Existing full-height rails may be swapped to the right edge without reconstructing split topology. |
| D6 | Tag `v0.1.0` now, or after Phase 1? | accepted | Tag only after all three phases, automated release gates, the real-Herdr walkthrough, and release documentation are complete. Phase 1 is necessary but not sufficient for the first release tag. |
| D7 | What consistency does one Git refresh promise? | accepted | Eventual consistency. A refresh may briefly combine adjacent repository states while Git is changing; filesystem invalidation and the recovery poll converge on the next state. Do not add extra Git work or claim atomicity. |
| D8 | Does GitRail use GitHub Actions? | accepted | No. Remove every workflow and hosted-evidence contract. Validation is local, candidate-bound, fail-closed, and retained as hashed file evidence. |

## Outcome and constraints

The target is a production-ready private `v0.1.0` candidate for Herdr users on
macOS and Linux, with Node 22 or 24 and Herdr 0.8.x. A user
must be able to install GitRail, inspect Git and filesystem state, open exact
Raw/Diff/Rendered previews, and remove the plugin without GitRail mutating Git,
closing panes it cannot prove it owns, or reconstructing user pane layouts.

The release candidate must remain responsive at the documented repository and
preview limits, restore the terminal on failure, ignore repository-controlled
configuration, and expose honest errors,
consistency, security-support, and platform claims. Runtime dependencies remain
zero; development-only verification dependencies are allowed. User config,
explicit environment overrides, eventual Git consistency, and a read-only Git
contract are retained. Repository config, JSON Schema/editor integration,
layout rebuild, invented security contact/SLA, and automatic user-file
migration are non-goals.

This checklist and its implementation contracts are the delivery source of
truth. Runtime `validateConfig` is the configuration source of truth, and
`PRODUCTION-READINESS.md` may claim only guarantees traced to the evidence gates
defined here. Pushing, publishing, and tagging remain separately authorized
operations.

## Phase 1 — blockers

- [x] **B1** Remove repository-level `.git-rail.json` discovery and merging from every runtime path **(D1 accepted)**
- [x] **B1a** Remove repository-configuration precedence, examples, opt-outs, schema guidance, and tests; document user configuration and environment overrides only
- [x] **B1b** Rewrite the `SECURITY.md` trust boundary to state that repository contents never control GitRail configuration
- [x] **B1c** Regression test: hostile `.git-rail.json` + file preview must not spawn the executable
- [x] **B2** Shared test helper that spawns with a scrubbed environment (`HOME`/`XDG_*` → temp; delete all `HERDR_*` and `GIT_RAIL_*`)
- [x] **B2a** Move `snapshot.test.mjs`, `terminal-ui.test.mjs`, `config.test.mjs`, `integration.test.mjs` onto it
- [x] **B2b** Local release gate running the suite with `HERDR_PANE_ID` and `HERDR_BIN_PATH` poisoned, so the leak cannot return **(D8 accepted)**
- [x] **B3** Virtualize the Files viewport — flatten rows once per state change, slice the window per frame (`scripts/git-rail.mjs:440`)
- [x] **B3a** Structural 20k-path test proving each frame styles/materializes only the viewport; keep timing as a reported benchmark, not a wall-clock gate
- [x] **B4** Verify pane ownership (`pane get` + label + `process-info` argv) before closing the stale preview pane; use `plugin pane close` (`scripts/git-rail.mjs:623`)
- [x] **B4a** Tests for `openPreview` — currently 0% covered (lines 564–633)
- [x] **H1** Render `state.error` distinctly from "not a Git repository" (`scripts/git-rail.mjs:444`)
- [x] **H2** Remove explicit and automatic pane-layout rebuilding; open only through a directly safe outer-right split **(D5 accepted)**
- [x] **H2a** Delete layout staging, transaction journals, startup recovery, and signal-time recovery machinery
- [x] **H2b** Regression-test that automatic and manual opening skip unsafe layouts without moving, swapping, or opening panes
- [x] **H3** `exit` / `uncaughtException` / `unhandledRejection` handlers in `scripts/git-rail.mjs` that restore the terminal and remove the fixture
- [x] **H3a** Keep all post-M2 preview state-path computation and state-store I/O inside the guarded preview lifecycle

## Phase 2 — correctness and fit

- [x] **H4** Recursive `fs.watch` on Linux; resolve the real gitdir via `git rev-parse --git-dir` (worktree-safe); never `path.join("", ".git")` (`scripts/git-rail.mjs:702`)
- [x] **H4a** Document the poll fallback and its interval in `README.md`
- [x] **M1** Add an expanded Untracked section after Unstaged with the `?` glyph and legend entry **(D3 accepted)**
- [x] **M2** Unify preview ownership on `src/herdr-pane-state.mjs`, keyed by workspace + source tab + entrypoint; delete the ad-hoc `<workspace>.preview` scheme
- [x] **M3** Remove the unneeded JSON Schema/editor-integration feature: delete `$schema` support and the standalone schema artifact **(D4 accepted)**
- [x] **M3a** Replace schema-specific coverage with a test that validates `git-rail.config.example.json` through `validateConfig` alone
- [x] **M4** Reject glob-shaped viewer patterns such as `*.md` with an explicit error; document the `client: "none"` removal idiom
- [x] **M5** Route every manifest Node entrypoint through one launcher that resolves and validates an absolute Node executable before any GitRail script starts
- [x] **M6** Document the accepted eventual-consistency model for multi-command Git refreshes **(D7 accepted)**
- [x] **M7** Cap the auto-open sweep at four concurrent tabs and 35 seconds globally, with process-group cancellation and explicit partial-result reporting
- [x] **M8** Cache normalized preview content, candidates, and display-column positions; incrementally filter matches as a search query grows without repeating position work on cache hits

## Phase 3 — process

- [x] **L1** Add `.gitignore`
- [x] **L2** Rewrite the `CHANGELOG.md` 0.1.0 entry as consumable release notes
- [x] **L2a** Define the candidate-SHA local checks and isolated real-Herdr walkthrough in `docs/RELEASING.md`
- [x] **L2b** Run all eight candidate-SHA evidence cells and complete every pre-tag gate **(D6 and D8 accepted)** — candidate `3aaaf05aa0f8adeb284adf4b30bb3171fe587b75`, evidence commit `ea182ee1070469f1c88c7bfadd469c97299c25ec`
- [ ] **L2c** After L2b passes, create annotated `v0.1.0` only under a separate explicit tagging authorization
- [x] **L3** Prune stale local branches (10 local, all merged)
- [x] **L4** Add pinned lint rules for prohibited `void` expressions, unused locals, and unused production exports; use explicit handled async boundaries; remove four unused parser helpers and make two active helpers private **(D2 accepted)**
- [x] **L5** Local release checks: Node 22 + 24; enforced 95% line / 86% branch / 95% function coverage floors; poisoned environment; snapshot; archive; dependency audit **(D8 accepted)**
- [x] **L6** Capture the 36 / 52 / 100-column screenshots, bind their exact bytes to a capture-source commit, and compare candidate output with the visual-source commit
- [x] **L7** Remove nonexistent private-contact and response-time promises from `SECURITY.md`; add a reporting channel only before external distribution
- [x] **P1** Rewrite `PRODUCTION-READINESS.md` as a checklist where each line cites the test or local release step that proves it

## Implementation contracts

These outlines are the implementation contract for the accepted decisions
above. They do not mark an item complete. No product decision remains open;
implementation choices may vary only where an outline explicitly permits it
and the stated acceptance evidence still passes.

### Phase 1

**B1/B1a — remove repository-level configuration** *(D1 accepted)*

- Stop constructing or reading `<repository>/.git-rail.json` in `loadConfig`;
  merge only built-in defaults, `~/.config/git-rail/config.json`, and explicit
  environment overrides.
- Remove the repository-root parameter from config loading where it is no
  longer needed, and update the provider, preview, auto-open, and resize callers
  so none can reintroduce repository discovery indirectly.
- Keep Git-repository detection for deciding whether a rail should auto-open,
  but read `herdr.autoOpen` only from user configuration. Per-repository
  `baseRef`, width, limits, refresh, editor, and viewer overrides cease to exist.
- Remove repository configuration from precedence lists, installation steps,
  examples, troubleshooting, opt-out instructions, and readiness claims. Keep
  the ordinary JSON example explicitly scoped to the user configuration file;
  M3 removes the schema feature.
- Delete tests whose expected behavior is repository merging and replace them
  with user-config/environment precedence tests.

**B1b — document the enforced trust boundary**

- State that repository contents never control GitRail configuration or select
  an executable.
- State the only configuration inputs: built-in defaults, the user config file,
  and explicit process environment overrides.
- Retain the no-shell, realpath, output-bound, terminal-sanitization, and logging
  guarantees as defense in depth.

**B1c — hostile repository regression**

- Create a temporary repository and isolated home containing a committed
  `.git-rail.json` whose auto-open viewer would write a marker file.
- Start `file-preview.mjs`, wait through initial Raw/Diff loading, and assert
  that the marker was never created, no repository value appears in resolved
  configuration, and user/default viewer behavior remains active.
- Exercise `getRepositoryState`, auto-open configuration, preview configuration,
  and resize configuration so the test proves every runtime path ignores the
  file rather than only protecting viewer launch.
- Use an absolute test executable and no shell so the test exercises the config
  boundary rather than quoting behavior.

**B2/B2a — one hermetic child-process helper**

- Add `test/helpers/environment.mjs` with a helper that copies only the parent
  variables required by Node, Git, locale, and executable discovery; points
  `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, and `XDG_STATE_HOME` at a
  per-test temporary root; and deletes every `HERDR_*` and `GIT_RAIL_*` key.
- Accept explicit overrides after scrubbing so a test must opt in to each Herdr
  or GitRail variable it exercises.
- Return the environment plus a registered cleanup function, and use it for
  every spawned rail, preview, shell wrapper, and Git fixture in
  `snapshot.test.mjs`, `terminal-ui.test.mjs`, `config.test.mjs`, and
  `integration.test.mjs`.
- Remove local one-off `HOME` and missing-`HERDR_BIN_PATH` workarounds after the
  shared helper covers them.

**B2b — poisoned-environment local gate** *(D8 accepted)*

- Add a release command that sets `HERDR_PANE_ID` and `HERDR_BIN_PATH` to
  valid-looking hostile values before running the full suite.
- Make the fake Herdr executable fail loudly if any test not explicitly about
  Herdr calls it; the check passes only when all unrelated child environments are
  scrubbed.
- Keep the ordinary clean-environment run as a separate gate so the helper is
  tested in both directions.

**B3 — virtualized Files viewport**

- Extract a pure Files-view model that flattens folder/file metadata when the
  repository state, query, view mode, folder expansion, or width changes.
- Keep selectable identities and row metadata in the flattened model, but style
  and allocate strings only for the visible slice plus fixed headers and the
  viewport marker.
- Navigate by selectable indices in the flattened model so off-screen files
  remain keyboard reachable without materializing their rendered rows.
- Invalidate the cached model explicitly on refresh, search edits, resize,
  Tree/Folders changes, and collapse/expand actions; preserve selection and
  reveal behavior across regeneration.

**B3a — 20k-path bounded-work test and benchmark**

- Build a deterministic 20,000-path in-memory view model outside Git and expose
  instrumentation that counts rows styled/materialized by one frame.
- At 36, 52, and 100 columns, assert that per-frame styled/materialized work is
  bounded by viewport height plus fixed chrome and overscan, independent of the
  total path count. This structural assertion is the performance gate.
- Assert that model regeneration occurs only on the invalidations named in B3
  and that the first, middle, and final paths remain keyboard reachable.
- Retain a warmed repeated-frame benchmark in local release output to reveal
  regressions, but do not fail on machine-dependent wall-clock timing.

**B4 — verify stale preview ownership before closing**

- Extract preview-pane lifecycle work from `git-rail.mjs` into a testable module
  that accepts the Herdr runner and pane-state store as dependencies.
- For a cached stale id, call `pane get`, require the recorded `terminal_id`,
  `GitRail Preview` label, and expected workspace, then call `pane process-info`.
  Resolve its script argument against the reported process cwd and require the
  exact `scripts/file-preview.mjs` path under the active plugin checkout; a
  same-named script in another checkout is not ownership proof.
- Close only a verified pane, using `plugin pane close`. If the pane is missing,
  discard the stale state; if it exists but ownership is not proven, leave it
  untouched and continue opening the new preview.
- Never treat possession of a cached pane id by itself as proof of ownership.

**B4a — preview lifecycle coverage**

- Cover successful open, state write, sanitized tab rename, and verified stale
  close with a mocked Herdr runner.
- Cover a reused user-pane id, wrong label, wrong workspace, unrelated argv,
  inspection timeout, missing pane, malformed open response, open failure, and
  rename failure.
- Assert that every unsafe or ambiguous case omits `plugin pane close` and that
  a failed cleanup cannot hide a successfully opened preview.

**H1 — distinguish provider failure from non-repository state**

- Render the existing “Changes unavailable outside Git” body only for the
  expected `No Git repository` state.
- For other startup failures, render a visibly distinct unavailable/error body
  containing the sanitized `state.error`, the directory, and a retry hint.
- Add snapshots for missing Git, timed-out Git, invalid cwd, and an ordinary
  non-repository directory at narrow and standard widths.

**H2/H2a/H2b — no pane-layout reconstruction** *(D5 accepted)*

- Delete `rebuildWithOuterRail`, layout export/reconstruction, staging-tab
  creation, transaction journals, startup recovery, and signal-time recovery.
- Automatic and explicit opening may split only beside a full-height outer pane.
  If that predicate fails, report the skipped tab and leave every pane untouched.
- Automatic ensure adopts an existing rail without rearranging it. Explicit
  opening may swap an existing full-height rail with the full-height rightmost
  pane, which preserves split topology; it never stages or rebuilds content.
- Test safe outer-right creation, automatic adoption without rearrangement, and
  automatic/manual skip on an unsafe vertical layout. Assert skipped cases issue
  no plugin open, pane move, or pane swap command.

**H3/H3a — crash-safe rail cleanup**

- After B4/M2 removes `paneStateFile()`, keep every `paneStatePath` computation,
  state-store read/write/remove, and other synchronous preview setup operation
  inside `openPreview`'s guarded lifecycle. Convert any failure into a rendered
  preview error instead of an unhandled rejection.
- Add an idempotent cleanup guard. Its synchronous path must disable mouse
  tracking, restore the cursor and alternate screen, clear timers/watchers, and
  remove a demo fixture with a synchronous bounded removal.
- Use the synchronous cleanup as the `exit` safety net. On
  `uncaughtException` and `unhandledRejection`, clean once, write a sanitized
  diagnostic, and terminate with status 1; handled SIGINT/SIGTERM continues to
  use the normal asynchronous quit path.
- Against the post-M2 state store, test an unwritable cache/state directory and
  injected uncaught errors by asserting both nonzero exit and the terminal
  restoration sequence.

### Phase 2

**H4 — worktree-safe invalidation watchers**

- Resolve the absolute per-worktree gitdir with
  `git rev-parse --absolute-git-dir`; also resolve the absolute common gitdir so
  shared refs are observed in linked worktrees.
- Attempt recursive worktree watching on every platform that supports it rather
  than gating it to Darwin. If recursive watching is unsupported or any watcher
  cannot be installed, retain the recovery poll and report the fallback in the
  debug log.
- Watch the resolved gitdir/common-dir locations for HEAD, index, refs, and
  worktree metadata changes. Never construct a Git watcher when `repoRoot` is
  empty, and deduplicate identical watch targets.
- Keep the coalesced minimum refresh cadence and jittered recovery poll; restart
  all watchers when cwd, repository root, gitdir, or common dir changes.

**H4a — document watcher fallback**

- Document that filesystem events are an optimization and the recovery poll is
  authoritative when recursive watching is unavailable.
- State the 10-second default, accepted 1–300 second range, ±10% jitter, and
  `GIT_RAIL_POLL_INTERVAL_MS`/`refresh.pollIntervalMs` overrides.

**M1 — distinct Untracked section** *(D3 accepted)*

- Partition `descriptor.kind === "untracked"` entries out of Unstaged without
  changing their provider descriptors or preview semantics.
- Render an expanded-by-default Untracked section immediately after Unstaged.
  Use `?` for both its section legend and file-row state marker; retain existing
  addition/binary statistics to the right of that marker.
- Include Untracked in navigation, selection preservation, expansion state,
  search counts, empty-section behavior, demo output, and narrow-width layouts.
- Update README terminology and snapshots so staged additions, unstaged
  modifications, and untracked files are visibly distinguishable.

**M2 — source-tab-scoped preview ownership**

- Treat the Herdr content tab from which the rail was opened as the source tab.
  The ownership key is `(workspaceId, sourceTabId, "file-preview")`; neither the
  preview tab id nor the currently focused tab may replace `sourceTabId`.
- Pass the source-tab identity into the rail at open time and retain it for all
  previews opened during that rail process. A repository may therefore have one
  owned preview per source tab, and opening a new preview replaces only that
  source tab's previously verified preview.
- Use `paneStatePath` and the atomic state helpers in
  `src/herdr-pane-state.mjs`; remove `paneStateFile()` and every
  `<workspace>.preview` read/write path from `git-rail.mjs`.
- Cover two source tabs in one workspace, two workspaces, focus changing to a
  preview tab, rail restart, stale state, and tab/workspace cleanup. Assert that
  one source tab can never close or overwrite another source tab's preview.

**M4 — reject patterns that cannot match as documented**

- Define the accepted grammar as exactly `*`, a dot-prefixed suffix, or an exact
  basename without path separators or glob metacharacters.
- Reject values such as `*.md`, `docs/*.md`, `file?.txt`, and bracket/brace glob
  forms with an error that explains the three accepted forms.
- Add validation and resolution tests for uppercase suffixes, exact basenames,
  the global wildcard, rejected glob shapes, and path separators.
- Document `{ "client": "none" }` on the same viewer key as the supported way
  for user configuration to disable an inherited built-in action.

**M5 — deterministic Node launch and version guard**

- Add one generic `scripts/node-launcher.sh`. Every Node script named by a
  startup hook, event hook, pane, or action-helper path in `herdr-plugin.toml`
  must reach Node through it; no manifest command or GitRail shell helper may
  invoke bare `node`. On the supported platforms, manifest shell commands use
  absolute `/bin/bash` so a poisoned `PATH` cannot select a different shell.
- If `GIT_RAIL_NODE_PATH` names an absolute executable, use it. Otherwise
  resolve `command -v node` once, canonicalize it to an absolute executable
  path, and fail with one actionable message if resolution fails. Node callers
  that launch another GitRail shell helper pass `process.execPath` through
  `GIT_RAIL_NODE_PATH`; `open-herdr-panel.sh` delegates to the same launcher.
- Before executing the requested script, have the launcher query the resolved
  executable's major version and reject versions below 22. Keep the in-process
  guard at the start of each directly invokable Node entrypoint as defense in
  depth, before terminal or Herdr mutation.
- Add manifest-level smoke tests covering every declared command with a valid
  absolute Node path containing spaces, a missing Node, a poisoned `PATH` with
  an unintended/unsupported Node, and an unsupported major version. Assert the
  failure occurs before any GitRail script or Herdr layout command runs; retain
  unit coverage of path and version parsing.

**M6 — document eventual Git consistency** *(D7 accepted)*

- State in the README's Git-semantics and refresh sections that one frame is
  assembled from multiple bounded Git commands and is not an atomic repository
  snapshot.
- Explain that a repository changing during refresh may briefly produce mixed
  counts or adjacent states, and that filesystem invalidation plus the recovery
  poll converges on the next refresh.
- Preserve the last usable state when a command fails and keep manual `r`
  refresh available; do not add serialization, consistency tokens, retries, or
  extra Git commands under this item.
- Remove or qualify any readiness language that implies one refresh observes a
  single immutable HEAD/index/worktree instant.

**M7 — bounded auto-open sweep**

- Use a worker pool of at most four tab jobs and one monotonic 35-second
  deadline beginning before workspace/tab/pane discovery and covering the
  complete auto-open invocation, not 35 seconds per tab or after discovery.
- Stop dequeuing tabs at the deadline. Send termination to every active child
  process group, allow a five-second recovery grace, and then force-kill any
  survivor. Configure this grace only for auto-open children instead of changing
  every command timeout. The 35-second deadline stops work; total shutdown may
  therefore take at most 40 seconds. H2 ensures cancellation cannot interrupt a
  pane-layout reconstruction because GitRail performs no such reconstruction.
- Preserve rails that completed successfully; do not roll them back because a
  later tab failed. Return a structured summary of opened, skipped, failed, and
  deadline-cancelled tab ids and emit one actionable aggregate error/debug
  record rather than losing partial results.
- Test the four-worker ceiling, a deadline before any work, a deadline with
  queued and active jobs, cancellation of process groups, mixed success, and a
  hung child. Use injected clocks/process runners rather than real sleeps.

**M8 — incremental preview search**

- Normalize searchable content once whenever preview content or mode changes;
  never lowercase, split, ANSI-strip, or wrap the complete preview again merely
  because the search query changed.
- Maintain the current normalized match candidates. Appending query text
  filters those candidates; backspace restores the preceding prefix's cached
  candidates; clearing search drops the prefix cache. Limit a search query to
  256 Unicode scalar values with a visible status at the limit. Cap retained
  prefix-candidate storage at 8 MiB; evict oldest prefix sets when the cap would
  be exceeded and recompute an evicted prefix from normalized content if the
  user backspaces to it. Release the cache when content/mode changes.
- Cache each prefix's display-column position alongside its matching row, so a
  cache hit returns the retained match objects without another `indexOf`,
  grapheme segmentation, styling, or wrapping pass. Preserve current Unicode-
  safe input, next-match, no-match, horizontal navigation, and selection behavior.
- Add operation-count tests proving normalization is content-scoped and each
  appended character examines no more than the previous candidate set. Cover
  append, paste, backspace, clear, no matches, all lines matching, Unicode, mode
  change, cache eviction/recomputation, and the 100,000-line safety limit. Assert
  retained candidate storage never exceeds 8 MiB on the all-lines-matching
  fixture. Keep a fixed-fixture latency benchmark as reported evidence, not a
  machine-dependent threshold.

**M3/M3a — remove JSON Schema/editor integration** *(D4 accepted)*

- Delete `schema/v1/git-rail.schema.json` and remove the empty `schema/`
  directories after confirming no other artifacts use them.
- Remove `$schema` from `git-rail.config.example.json`, from `validateConfig`'s
  accepted top-level keys, and from documentation describing configuration.
- Delete schema-shape, schema-url, `$id`, and schema/runtime-parity assertions;
  do not add a JSON Schema validator dependency.
- Keep the example as ordinary JSON and add one test requiring
  `validateConfig(example)` to return no errors, making runtime validation the
  single source of truth.
- Add a focused validation assertion that `$schema` is now an unknown key so
  the removed feature cannot silently return through copied configuration.
- Treat this as a pre-release breaking cleanup: add a release-note callout that
  existing development configs must remove `$schema`. Do not add a runtime
  compatibility exception or silently edit user files. Use isolated config in
  tests, and remove the key manually from the developer config before the final
  live-Herdr verification.

### Phase 3

**L1 — repository ignore policy**

- Add a minimal `.gitignore` for `node_modules/`, coverage output, test reports,
  debug logs, `.DS_Store`, and editor-local files.
- Do not ignore `.git-rail.json`, fixtures, screenshots, or other release inputs
  that may intentionally belong to a repository. The hostile-config regression
  creates `.git-rail.json` inside its temporary Git fixture and proves GitRail
  ignores it even when Git tracks it.

**L2/L2a/L2b/L2c — release notes, release contract, gates, and first tag** *(D6 accepted)*

- Rewrite the 0.1.0 changelog entry under Highlights, Security, Fixed,
  Configuration, and Installation/Upgrade. Describe user-visible behavior and
  breaking pre-release configuration cleanup rather than mirroring commit
  history; explicitly call out removal of repository config and `$schema`.
- Before freezing a candidate, rewrite `docs/RELEASING.md` so every validation
  command occurs before tagging. It must give exact candidate-SHA checkout/link,
  version capture, unlink, expected-result, failure-cleanup, and evidence-record
  commands rather than referring to undefined checks or a walkthrough.
- Every public clean-install path must run `npm ci --ignore-scripts` and
  `npm run check` before `herdr plugin link .`; uninstall must run the candidate's
  ownership-verifying `npm run uninstall:herdr`, close verified persisted panes,
  restart Herdr, and prove both restored and newly created Git tabs stay rail-free.
- Define local Node 22 and Node 24 cells that run `npm ci --ignore-scripts`,
  `npm run check`, demo/snapshot verification, and artifact verification. Build
  a `git archive` from the candidate SHA, inspect its member list before
  extraction, and assert every manifest-referenced runtime file plus the
  uninstall entrypoint is present, removed schema/root-repository-config
  artifacts are absent, and no untracked local file or `node_modules/` content
  enters the install artifact.
- Define isolated live-Herdr cells on macOS and Linux using Herdr 0.8.x and Node
  22 or 24. Each clean-install walkthrough must
  observe: one unfocused auto-open rail in a Git tab; no rail in a non-Git or
  preview tab; manual open/toggle; Staged, Unstaged, and Untracked separation;
  Raw, Diff, and action-3 Ink TUI and Mermaid rendering; per-source-tab preview replacement;
  safe auto-open skip; manual refresh/recovery-poll convergence; and successful
  unlink with no remaining startup/event action. The wrapper must create its own
  temporary Herdr config, cache, state, and named sessions so cleanup cannot
  unlink the developer's installed plugin.
- Because 0.1.0 has no earlier public release, public upgrade and migration
  validation are not applicable. Never edit user configuration automatically.
- Prepare code, docs, and screenshot assets before the final candidate commit.
  Screenshots record the exact visual-source and capture-source SHAs. After the candidate
  commit, run all eight local cells against that SHA and record environment
  versions, commands, pass/fail results, and SHA-256 hashes in a versioned
  evidence manifest outside the worktree. Every command block runs in fail-closed
  shell strict mode. Verification re-hashes logs and rejects missing, failed,
  stale, mismatched, or malformed cells. Seal the complete manifest and logs into
  an evidence-only direct-child commit only after every cell passes. The annotated
  tag embeds the bundle manifest SHA-256, evidence commit, and portable file URLs;
  no machine-local path may appear in the tag.
- If code, manifest, dependencies, release inputs, or packaged artifacts change,
  invalidate all affected cells and rerun them. Verify a clean worktree,
  version/config agreement, artifact contents, and release-note links; only then
  create annotated `v0.1.0`. Do not move an existing tag.

**L3 — prune merged local branches safely**

- Re-list branches merged into `main`, exclude `main` and every checked-out
  worktree branch, and confirm each candidate has no unique commit.
- Delete only those verified local refs with Git's non-force branch deletion;
  do not delete remote branches as part of this item.

**L4 — explicit async boundaries and parser cleanup** *(D2 accepted)*

- Add pinned development-only lint tooling; keep `dependencies` empty and
  prohibit runtime entrypoints from importing development packages.
- Ban `void` expressions so they cannot disguise ignored async work. At
  interactive boundaries, route async actions through `reportAsync`, which
  installs the visible error handler; elsewhere await, return, or attach an
  explicit rejection handler. Do not claim whole-program promise type analysis
  from untyped JavaScript linting.
- Enforce unused production exports across `src/` and `scripts/`, not merely
  unused local variables.
- Delete the production-unused `parseNameStatusZ`, `parseLsFilesZ`,
  `parseRawDiffZ`, and `mergeMetadata` helpers and their tests. Keep
  `parseNumstatZ` and `mergeStats` as private helpers used by
  `parseRawNumstatZ` rather than exporting them.
- Run ESLint and Knip from `npm run lint` and therefore from every local
  `npm run check`.

**L5 — local verification and coverage gates** *(D8 accepted)*

- Keep GitHub Actions absent. Run the full candidate check locally under Node 22
  and Node 24 and retain hashed logs for both runs.
- Enforce floors of 95% lines, 86% branches, and 95% functions, rounded down
  from the candidate's measured 95.75% / 86.49% / 95.51% coverage. Coverage is
  part of the default `npm run check`, not a separate hosted-only command.
- Retain separate local evidence for the poisoned environment, deterministic
  snapshot/artifact check, exact archive, and dependency audit. The dependency
  gate enforces zero runtime dependencies, performs `npm ci --ignore-scripts`,
  and fails on high/critical npm advisories.
- Record only hashed file evidence. No workflow, job, hosted runner, or external
  check result is part of the release contract.

**L6 — required screenshots**

- Capture the same realistic demo state at 36, 52, and 100 terminal columns in
  a real Herdr pane, without cropping away the pane boundary or footer.
- Store consistently named PNGs under `docs/screenshots/`; record the visual-
  source SHA, capture-source SHA, and Herdr version in its README; and link the
  current images from the main README. Add all assets before freezing the candidate.
- Parse and validate PNG dimensions, require exact PNG-byte equality with the
  capture-source commit, and byte-compare deterministic 36/52/100-column output
  from the candidate with the visual-source commit. This detects both asset drift
  and UI-output drift without a runtime image-rendering dependency.

**L7 — honest security reporting policy**

- Remove claims that vulnerabilities can presently be reported privately and
  remove promised acknowledgement/fix timelines that the project cannot staff.
- State the supported-version policy and the repository-content/configuration
  trust boundary without inventing a contact channel.
- Add a real private reporting channel and document a response policy only as a
  prerequisite to future external distribution. It is not a prerequisite for
  this private pre-release hardening run.
- Add a documentation assertion that `SECURITY.md` contains no placeholder
  address, nonexistent channel, or unsupported response-time promise.

**P1 — evidence-backed readiness checklist**

- Replace prose guarantees with a table containing requirement id, user-visible
  guarantee, proving test or local release step, supported platform, and current
  status.
- Require every “ready” row to name an executable test or manual release
  step; move unsupported aspirations back into this hardening checklist.
- Cross-reference the security boundary, local install checks, screenshots, coverage
  gate, and pre-tag release gate instead of restating them without proof. The
  checklist names the command that will verify a tag but does not claim a tag
  exists until the separately authorized tag operation succeeds.
- Include explicit rows for exact-descriptor Raw/Diff/Rendered behavior, the
  before/after read-only Git invariant, and ownership-safe uninstall.

## Execution order and completion gates

No checklist item is complete merely because files changed or a command exited
zero. Its outline and named negative/failure cases are part of its acceptance
criteria. Keep the worktree testable after each numbered group.

1. Establish the B2 hermetic test helper and poisoned-environment witness, then
   add L1 so generated evidence cannot pollute later commits.
2. Implement B1, B1a, B1b, and B1c as one trust-boundary change. Remove M3's
   schema feature in the same configuration pass so examples, validation, and
   documentation never describe an intermediate configuration contract.
3. Implement B4/M2 together because ownership verification and the new preview
   state key share one lifecycle. Then implement H1 and H3 independently.
4. Implement H2 by deleting layout reconstruction and its transaction/recovery
   surface, then prove automatic and explicit unsafe-layout skips before applying
   M7 cancellation to the auto-open supervisor.
5. Implement B3/B3a and M8 as separate bounded-work changes, preserving a green
   full suite between them. Then implement H4/H4a, M1, M4, M5, and M6.
6. Add L4 tooling after production cleanup is stable, then enable the L5 local
   checks and coverage floors. Clean and poisoned local runs must pass before
   release documentation can claim those guarantees.
7. Perform L3 only after re-listing exact deletion candidates. Complete L2,
   L2a, L7, and P1 from verified behavior, capture L6, then freeze the release
   candidate with all release inputs present.
8. Run all eight L2b local and isolated real-Herdr evidence cells on that exact
   commit. Mark the pre-tag gate complete only if all eight cells remain current
   and the candidate worktree is clean. Seal and push the portable evidence-only
   direct-child commit under the separately required ordinary commit/push
   authorization. A following status-only commit may update this checklist and
   `PRODUCTION-READINESS.md` with the immutable candidate and evidence SHAs; it
   does not redefine the release candidate. Under a separate explicit tag
   authorization, L2c may then tag the validated candidate without moving an
   existing tag.

Phase 1 exits only when all B/H items in that phase pass their unit,
integration, and negative witnesses. Phase 2 exits only when its
observable behavior is documented and the full Node 22/24 suite passes. Phase
3 exits only when local evidence, the isolated real-Herdr walkthrough,
screenshots, readiness traceability, and release artifacts refer to the candidate,
visual-source SHA, or capture-source SHA as specified above, and the portable
evidence bundle exists on `origin/main`. No step in this document authorizes
pushing, publishing, or tagging without a separate explicit request.

## Appendix — evidence

### B1 — repository config executes arbitrary code

A committed `.git-rail.json` naming any executable runs it when any file in that
repository is previewed. No prompt, no confirmation.

```json
{ "version": 1, "viewers": { "*": {
    "client": "sh", "args": ["-c", "id > /tmp/GITRAIL_PWNED.txt"],
    "mode": "embedded", "key": "9", "autoOpen": true } } }
```

```
$ cat /tmp/GITRAIL_PWNED.txt
uid=501(user) gid=20(staff) groups=20(staff),12(everyone),...
```

Path: `src/config.mjs` merges project config unconditionally →
`scripts/file-preview.mjs:558` honours `autoOpen` → `:368` → `runCommand`.
GitRail auto-opens in every Git tab, so the only user action required after a
clone is opening one file.

### B2 — `npm run check` fails in its own runtime environment

Two independent hermeticity leaks:

- **`HERDR_*` leaks in.** Running `npm test` from inside a Herdr pane produces
  2 failures: the snapshot tests spawn `git-rail.mjs` with `cwd` set to a temp
  fixture but inherit `HERDR_PANE_ID`/`HERDR_BIN_PATH`, so `liveProviderCwd()`
  asks the live `herdr` binary for the focused pane and renders the developer's
  actual repository. With those variables removed: `140 pass / 0 fail`.
  `test/snapshot.test.mjs` already works around this in one test by pointing
  `HERDR_BIN_PATH` at a missing file; the workaround was never generalised.
- **Real `$HOME` leaks in.** `loadConfig` reads
  `~/.config/git-rail/config.json`; only `snapshot.test.mjs` overrides `HOME`.
  With an ordinary user config present, `test/config.test.mjs` goes to
  **4 failures / 15 pass**.

Verification gate 1 in `PRODUCTION-READINESS.md` therefore does not hold.

### B3 — Files tab re-renders the whole repository every frame

`scripts/git-rail.mjs:440` passes `paginate = false`, so `renderFilesList`
materialises a styled row for every path on every frame. Measured over 20
`renderFrame()` calls against real repositories:

| repository files | Files tab | Changes tab |
| --- | --- | --- |
| 2,000 | 24 ms/frame | 0.4 ms |
| 5,000 | 67 ms/frame | 0.5 ms |
| 20,000 | **302 ms/frame** | 1.3 ms |

The 16 ms `scheduleDraw` coalescer does not help; each draw is blocking
main-thread work. Introduced by `0dfd87c "feat: render complete files tree"`,
which removed pagination from the Files list only.

### B4 — unverified destructive pane close

`scripts/git-rail.mjs:623` reads a pane id from
`~/.cache/herdr-gitrail/panes/<workspace>.preview` and closes it with no
ownership check, while `scripts/open-herdr-panel.mjs` verifies rails via
`pane process-info` before `plugin pane close`. A stale cache entry plus a
reused pane id closes a user pane. The whole function is untested.

### H1 — startup failures are misreported

With `git` removed from `PATH` inside a real repository:

```
 GitRail unavailable
  ⑂ —
────────────────────────────────────────────
 CHANGES                       FILES
Changes unavailable outside Git
/private/tmp/.../nogit
Press Tab to browse files.
```

`state.error` ("git is not installed") is never rendered — `:444` does not read
it, and `statusMessage` only picks up `configErrors`. The user is told they are
not in a repository.

### H2 — layout surgery can strand user panes

In a tab with a top/bottom split, `rightmostPaneId` selects the bottom pane,
whose `rect.height` is half the area, so `canSplitAtOuterRight` is false and
`rebuildWithOuterRail` runs: it moves both content panes into a
`GitRail Layout Staging` tab, opens the rail, then moves them back — four
`herdr pane move` round-trips on live panes, unprompted, at tab creation.
`scripts/auto-open-herdr-tabs.mjs:99` kills the process group after 35 s and
`open-herdr-panel.mjs` installs no SIGTERM handler, so a slow Herdr leaves the
panes in the staging tab. Nothing reclaims one; `collectTabTargets` only skips
them.

Resolution: the rebuild, staging, journal, recovery, layout-export, and pane-move
paths were deleted. Unsafe automatic and manual opens now return a tested skip.

### H3 — no crash safety in the rail

`scripts/git-rail.mjs` registers only SIGTERM and SIGINT — no `exit`,
`uncaughtException`, or `unhandledRejection` (`file-preview.mjs` has `exit`).
`paneStateFile()`'s `mkdirSync` sits outside the `try` at `:598` and is reached
through `void requestPreview(file)` (`:262`, `:268`), so an `EACCES` on
`~/.cache` rejects unhandled and kills the process with the alternate screen,
hidden cursor, and mouse tracking still enabled, leaking the demo fixture.

### H4 — watching is ineffective on Linux and in worktrees

`fs.watch(root, { recursive: darwin only })` means Linux sees only top-level
changes. The `.git` watcher at `:702` uses `path.join(state.repoRoot, ".git")`,
which evaluates to `".git"` relative to the rail's own cwd when `repoRoot` is
empty. In a linked worktree `.git` is a file, so index and HEAD changes are
never observed. Everything degrades silently to the 10 s poll.

### M1 — untracked files are indistinguishable from staged additions

`npm run snapshot` (the demo fixture the README says covers "unstaged,
untracked text, and untracked binary states"):

```
 ⌄ Unstaged  3
 ⌄ assets 1
  └─ ◆ binary.dat                             binary   ← untracked binary
 ⌄ notes 1
  └─ ⊞ production ready.md                        +3   ← untracked text
 ⌄ src 1
  └─ ⊡ status.mjs                              +2 −1   ← actually unstaged
```

Three Git scopes in one section; untracked files carry the same green `⊞` as a
staged addition. `PRODUCTION-READINESS.md` claims Changes separates untracked
state.

### M3 — unused schema/editor-integration artifact is broken

```
https://raw.githubusercontent.com/KaxyotiK/git-railgun/main/schema/v1/git-rail.schema.json
→ 404
```

Both the schema `$id` and the `$schema` in `git-rail.config.example.json` point
there, so editors flag the file shipped as the starting point.
`docs/INSTALLATION.md` also opens with a `git clone` of the same private URL.
The example config is never validated against the schema or `validateConfig` by
any test. D4 resolves this by removing the unneeded schema feature rather than
publishing or maintaining another configuration authority.

### L4 — dead exports and floating promises

Four exported parsers have no non-defining caller in `src/` or `scripts/`, yet
are covered by tests, inflating the coverage figure:

```
parseNameStatusZ, parseLsFilesZ, parseRawDiffZ, mergeMetadata
```

`parseNumstatZ` and `mergeStats` are active internal helpers but need not be
exported. Multiple `void asyncFn()` call sites exist; most catch internally, but
`requestPreview` does not (see H3). L4 requires semantic analysis rather than a
hard-coded occurrence count.

Resolution: the unused exports were removed, async UI boundaries now use
explicit visible-error handlers, and lint bans `void`, unused locals, and unused
production exports. Readiness deliberately does not claim typed whole-program
promise analysis for this JavaScript project.

### L5 — coverage today

88.08% line / 78.80% branch / 86.52% function, unenforced. The uncovered
regions are the risky ones: `openPreview` 0%, `refreshState` 0%, watcher
lifecycle 0%, `src/debug-log.mjs` 46.67%.
