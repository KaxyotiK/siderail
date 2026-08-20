# Security policy

## Supported versions

Security fixes are provided for the latest tagged release of Herdr GitRail.

## Reporting a vulnerability

Do not open a public issue containing exploit details, repository contents, or
secrets. Send a private report to the repository owner with the affected
version, operating system, reproduction steps, and impact. Expect an initial
acknowledgement within five business days.

## Trust boundary

GitRail is read-only with respect to Git, but repository `.git-rail.json` files
are trusted local configuration and may select editor or viewer executables.
Review repository configuration before opening an untrusted checkout. GitRail
passes arguments without a shell, resolves selected paths through `realpath`,
bounds file and Git output, and does not log source, diffs, secrets, or command
arguments by default.
