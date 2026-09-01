# Colors and glyphs

GitRail does not choose a font. Herdr is a terminal application, and each Herdr
pane is a PTY that Herdr parses into its own cell grid and re-renders through
ratatui into your terminal emulator. The emulator owns the font, and there is no
per-pane font control in Herdr or in GitRail.

Herdr also re-emits pane colors verbatim. Reading a live pane with
`herdr pane read <id> --format ansi` returns both indexed (`38;5;n`) and 24-bit
(`38;2;r;g;b`) sequences exactly as the child wrote them. Herdr's own `[theme]`
colors Herdr's chrome, meaning its sidebar, tab bar, borders, and panel
background. It never recolors what a pane prints, and it exposes no theme
through the plugin API or the plugin context environment.

## What GitRail does

GitRail resolves its palette once at startup, in two layers.

The base layer is the ANSI indexed palette, so every color resolves against
whatever theme your terminal is set to and stays legible in light mode.
Selection uses reverse video rather than a fixed background.

| Token | Default | Used for |
| --- | --- | --- |
| `gold` | `38;5;3` | headers, branch, active tab, selection bar |
| `amber` | `38;5;11` | modified |
| `leaf` | `38;5;2` | added |
| `red` | `38;5;1` | deleted |
| `blue` | `38;5;4` | renamed, type changed |
| `purple` | `38;5;5` | copied, binary |
| `fog` | `38;5;7` | secondary text |
| `faint` | `38;5;8` | tree guides, rules |
| `selected` | `7` (reverse) | selected row background |

The override layer reads the four tokens Herdr documents as user-facing. If you
have set any of them, GitRail adopts them:

| Herdr token | GitRail token |
| --- | --- |
| `[theme.custom] accent`, else `[ui] accent` | `gold` |
| `[theme.custom] red` | `red` |
| `[theme.custom] green` | `leaf` |
| `[theme.custom] selection_bg` | `selected` |

Values accept the spellings Herdr accepts: `#rrggbb`, `#rgb`, `rgb(r, g, b)`,
and named colors. A named color becomes an ANSI index so it keeps following your
terminal theme. Anything else, including `reset`, leaves the default in place.

GitRail looks for the config at `HERDR_CONFIG_PATH`, then
`$XDG_CONFIG_HOME/herdr/config.toml`, then `~/.config/herdr/config.toml`. A
missing or unreadable file leaves the base palette untouched. Under the cmux
Dock host the Herdr theme is ignored, because cmux supplies its own chrome.

GitRail reads only those four keys. It does not vendor Herdr's built-in theme
palettes, so `[theme] name` alone changes nothing here. If you want the rail to
track a built-in theme, set the tokens explicitly under `[theme.custom]`.

## Glyph width

The status marks `⊡ ⊞ ⊟ ⊠ ↪ ◫` are East Asian Neutral and always occupy one
cell. The tree scaffolding `─ └ ├`, the selection bar `▏`, the shapes `□ ◆ ◇`,
the `·` separator, and accented Latin characters such as `é` in a filename are
East Asian Ambiguous. A terminal decides for itself whether those take one cell
or two, and the two answers disagree by a column per character.

GitRail measures them as one cell, matching Ghostty, WezTerm, and modern xterm
defaults. If your terminal is set to render ambiguous characters as double
width, which iTerm2 and Terminal.app both offer and CJK users commonly enable,
tell GitRail so its columns line up:

```bash
GIT_RAIL_AMBIGUOUS_WIDTH=wide
```

Set it in the Herdr pane environment, or leave it unset for the narrow default.
The setting affects measurement only. Unambiguously wide characters such as `界`
and plain ASCII are never affected either way. In tmux, match it to
`utf8-ambiguous-width`.

## Glyph coverage

Every glyph GitRail draws is present in Menlo, which is Terminal.app's default
font. The branch mark is `↱` and the copied mark is `◫` specifically because
Menlo has no `⑂` or `⧉`, and both drew as empty boxes for anyone on the default
font. Check any replacement glyph against Menlo before using it.

## Upstream note

The correct long-term channel is for Herdr to publish its resolved theme to
plugins, in `HERDR_PLUGIN_CONTEXT_JSON` or the socket API, including the value
`auto_switch` resolved to for the current light or dark appearance. That would
let a plugin match Herdr's chrome exactly, including the built-in themes, and
would remove GitRail's need to read Herdr's config file at all. It would also
make `sidebar_bg` usable, which is the one token that would let the rail paint
the same background as Herdr's own sidebar.

Until then, reading the four documented tokens is the most GitRail can do
without depending on Herdr's private palette internals.
