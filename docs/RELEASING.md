# Releasing

1. Update `CHANGELOG.md` and remove the `Unreleased` marker for the target date.
2. Set matching versions in `package.json` and `herdr-plugin.toml`.
3. Run `npm run check` on macOS and Linux and verify the live Herdr interaction
   matrix, including terminal and external clients.
4. Capture realistic 36- and 52-column screenshots.
5. Tag the commit as `vX.Y.Z` and publish release notes from the changelog.
6. Verify a clean install, upgrade, demo launch, live launch, and uninstall from
   the tag.

The public configuration schema path is versioned at `schema/v1/`; breaking schema
changes require a new URL and migration notes.
