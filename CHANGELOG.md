# Changelog

Herdr GitRail follows Semantic Versioning. Until 1.0, minor versions may include
intentional configuration changes documented here.

## 0.1.0 - Unreleased

- Rebrand the plugin as Herdr GitRail.
- Add canonical file states and exact diff descriptors.
- Replace fragile Git parsing with NUL-delimited machine formats.
- Generate the demo from a temporary real Git repository.
- Add bounded asynchronous Git execution and state-preserving refresh.
- Add descriptor-aware Diff and Raw previews with in-preview search.
- Render structured file diffs and open previews in a dedicated Herdr tab.
- Search commit metadata and commit file paths from Changes.
- Compare Files with the base-branch merge point and mark unchanged files
  neutrally.
- Preserve stable, flicker-free scrolling and refresh state.
- Add versioned configuration, safety limits, tests, CI, and release guidance.
- Reject unknown or mistyped nested configuration and pin CI actions by commit.
- Make editor integration optional and expose viewer action `3` only when the
  selected filename matches a configured rule; Markdown defaults to Glow.
- Compose matching global and file-specific viewer actions in configured order.
