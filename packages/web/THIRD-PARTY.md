# Third-party assets in @herdr-mobile/web

Copied from Herdr (herdr-app v0.1.13; program table v0.1.14, github.com/herdrdev/herdr-app, Apache-2.0, `licenses/herdr-app-LICENSE.txt`):

| What                                              | Where here                               | From                                                        | License                                                                                |
| ------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Alert sounds `request.mp3`, `done.mp3`            | `public/sounds/`                         | `assets/sounds/`                                            | Apache-2.0                                                                             |
| Program table                                     | `src/lib/programs.json`                  | `defaults/programs.json`                                    | Apache-2.0                                                                             |
| Herdr logo (ram tile), PWA icons rendered from it | `public/app/`                            | `assets/icons/herdr-ui-icon-clean.svg`                      | Apache-2.0 (ram adapted from herdrdev/herdr)                                           |
| Program icons                                     | `public/icons/programs/`                 | the icons herdr-app installs in `~/.config/herdr-app/icons` | Simple Icons CC0-1.0, Lucide ISC, LobeHub MIT; see `public/icons/programs/LICENSES.md` |
| UI glyphs (chevrons, spinner, ...)                | `src/assets/ui/`                         | herdr-app's `workspace-chrome` / `pane` mods                | Lucide, ISC (`licenses/Lucide-LICENSE.txt`)                                            |
| Geist                                             | `src/assets/fonts/Geist.woff2`           | `assets/fonts/Geist.ttf` (converted to WOFF2)               | SIL OFL 1.1 (`src/assets/fonts/OFL-Geist.txt`)                                         |
| JetBrains Mono (+ italic)                         | `src/assets/fonts/JetBrainsMono-*.woff2` | `assets/fonts/` (converted to WOFF2)                        | SIL OFL 1.1 (`src/assets/fonts/OFL-JetBrainsMono.txt`)                                 |

Libraries bundled into the Conversation tab's chunk (from npm, licenses kept in their packages): `marked` (MIT, tokenizer only) and `highlight.js` core with 20 languages (BSD-3-Clause). The UI icons added for it (copy, file, bot, ...) are Lucide shapes (ISC).

Theme colors and status marks follow herdr-app's `src/settings.rs` and its shipped mods (Apache-2.0).
Brand icons are their owners' trademarks; the licenses above grant no trademark rights.
