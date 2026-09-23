# Security policy

## Supported versions

Security fixes target the latest release of the `siderail` npm package and the
`main` branch. Update with `npm install -g siderail@latest`; open sidebars
restart onto the fixed version automatically.

## Reporting a vulnerability

Report suspected vulnerabilities through
[GitHub's private vulnerability reporting](https://github.com/KaxyotiK/siderail/security/advisories/new).
Include the affected commit or version, reproduction steps, and the expected
impact. Keep exploit details and secrets out of public issues.

Reports are reviewed on a best-effort basis, with no guaranteed response or fix
timeline. Use the private report for follow-up discussion and to coordinate
disclosure.

## Trust boundary

Repository contents never control SideRail configuration or select an executable.
Configuration comes from built-in defaults, the user's
`~/.config/siderail/config.json`, and explicit process environment overrides.
The comparison base alone may also come from an uncommitted local or worktree
Git-config key named `branch.<checked-out-branch>.siderail-base`; other Git-config
scopes are ignored. SideRail is otherwise read-only with respect to Git, passes
executable arguments without a shell, resolves selected paths through `realpath`,
bounds file and Git output, sanitizes terminal text, and does not log source,
diffs, secrets, or command arguments by default.
