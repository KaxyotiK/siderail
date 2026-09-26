# Architecture decisions

Decisions about SideRail's behavior that are not obvious from the code, with the reasons for them. Add a new entry at the end with the next number; do not rewrite a decided entry. To change a decision, add an entry that supersedes it and mark the old one `Superseded by ADR-NNNN`.

## ADR-0001: A rail does not follow an agent's working folder

- Date: 2026-09-25
- Status: Accepted

### Context

A rail shows the repository of the focused pane in its tab, using the folder Herdr reports for that pane: `foreground_cwd`, else `cwd`. The request was for a rail to follow an agent in that pane when the agent changes into another worktree, for example with `cd` into a linked worktree, without the user pinning anything.

What we checked:

- Herdr reports a pane's folder as the folder of its foreground process. In an agent pane that is the agent process, and its folder does not change when the agent runs `cd`, because the agent's commands run in child shells. After an agent changed into a worktree, Herdr still reported the pane's original folder.
- Claude Code tracks its own current folder and records it as `cwd` on each entry of its session transcript, `~/.claude/projects/<project>/<session-id>.jsonl`. Herdr exposes the pane's Claude session id as `agent_session.value`, so SideRail could read the latest `cwd` from the end of that file.
- Claude Code keeps a `cd` only inside the project or a folder added with `/add-dir`; elsewhere it resets after the command. Its `EnterWorktree` tool moves the recorded folder but also moves the session's start folder.
- Codex's session log records only the session's fixed folder, so Codex panes cannot be followed this way.

### Decision

A rail does not try to detect an agent's working folder. It follows the folder Herdr reports for the pane, unless the rail's tab is pinned to a worktree. People pin from the rail: press `w` or click `▾` on the branch line. Agents pin with `siderail target <worktree>` and release with `siderail target --follow`. Both write the same per-tab pin.

### Reasons

- Reading the agent's folder would depend on one agent's undocumented transcript format and on Herdr's `agent_session` field, either of which can change without notice.
- It would work only for Claude, and only in folders where Claude keeps a `cd`, so a rail would behave differently depending on the agent and the folder.
- A pin behaves the same for every agent and for people, and it already exists.

### Consequences

- An agent that works in another worktree pins its tab's rail with `siderail target <worktree>`, and releases it with `siderail target --follow` when done.
- When a rail is pinned and the pane's folder is in a different checkout, the header shows both. The pane's folder there is the one Herdr reports, not an agent's `cd`.
- Revisit this if Herdr or the agents provide a supported, agent-neutral way to report an agent's current folder, for example a pane field an agent sets through `herdr pane report-metadata`.
