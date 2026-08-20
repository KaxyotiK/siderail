# Contributing to Herdr GitRail

Use Node.js 22 or newer and Herdr 0.8.0 or newer. Create a focused branch, keep
the first release read-only, and run:

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
include the relevant correctness case, test evidence, and a Herdr screenshot or
recording for interaction changes.
