# Installation and upgrades

## Install from a checkout

```bash
git clone https://github.com/KaxyotiK/git-rail.git
cd git-rail
npm run check
herdr plugin link .
herdr plugin action invoke local.git-rail.open-git-rail
```

Herdr reads the linked checkout directly. To upgrade, close GitRail, update the
checkout, run `npm run check`, relink with `herdr plugin link .`, and reopen it.
Use a tagged release in production rather than an arbitrary moving branch.

## Uninstall

Use Herdr's plugin unlink/remove command for `local.git-rail`, then remove the
checkout. Optional pane ownership state lives in
`~/.cache/herdr-gitrail/panes/` and contains only Herdr pane identifiers.

## Configuration

Copy `git-rail.config.example.json` to `.git-rail.json` in a trusted repository
or to `~/.config/git-rail/config.json`. Values merge by key; repository values
override user values, and environment overrides win last.
