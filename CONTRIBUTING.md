# Contributing to SideRail

Use Node.js 22 or newer. For host integration, use Herdr 0.8.x or a supported
cmux build as described in the [cmux guide](docs/CMUX.md). Create a focused
branch, keep the first release read-only, and run:

```bash
npm run check
npm run snapshot
```

Changes to Git parsing or previews must include a disposable-repository test
that independently checks the expected Git command. UI changes must cover a
narrow (36), standard (52), and wide (100) snapshot. Do not add path parsing
based on human-oriented Git output, shell command construction, silent result
caps, or fabricated demo content.

Commit messages should describe the user-visible outcome. Pull requests should
include the relevant correctness case, test evidence, and a screenshot or
recording from the affected host for interaction changes.
