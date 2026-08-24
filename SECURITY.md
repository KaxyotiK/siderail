# Security policy

## Supported versions

Security fixes are provided for the latest tagged release of Herdr GitRail.

## Reporting a vulnerability

This private pre-release repository does not currently advertise a security
reporting channel or response-time commitment. Do not put exploit details,
repository contents, or secrets in a public issue. A private reporting channel
and response policy must be published before GitRail is distributed externally.

## Trust boundary

Repository contents never control GitRail configuration or select an executable.
Configuration comes only from built-in defaults, the user's
`~/.config/git-rail/config.json`, and explicit process environment overrides.
GitRail is read-only with respect to Git, passes executable arguments without a
shell, resolves selected paths through `realpath`, bounds file and Git output,
sanitizes terminal text, and does not log source, diffs, secrets, or command
arguments by default.
