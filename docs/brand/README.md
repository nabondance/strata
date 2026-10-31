# Strata brand kit

The visual identity is called **Fault line**. It shows layers of sediment cut by a fault, with the right side slipped down. This stands for what Strata shows: the same configuration, displaced over time.

## Logo

| File                                             | Use                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| [logo.svg](logo.svg)                             | The mark alone: icons, avatars, anywhere under about 100px wide. It stays legible at 16px. |
| [logo-wordmark.svg](logo-wordmark.svg)           | Mark and wordmark in bedrock, for light backgrounds.                                       |
| [logo-wordmark-dark.svg](logo-wordmark-dark.svg) | Mark and wordmark in bone, for dark backgrounds.                                           |

The mark is the layered symbol; the wordmark is the name "STRATA" set beside it.

All three files have a transparent background. The wordmark is stored as outlines (shapes), not as text, so the files need no font installed.

Rules for using the logo:

- Leave clear space around the logo equal to a quarter of the mark's width.
- Do not recolor the layers.
- Do not straighten the fault.
- Do not set the mark on a busy background without its badge.

### Changing the mark

The mark's shapes are defined in `markSvg` in [src/brand.ts](../../src/brand.ts). The HTML report, its favicon, and the SVG image all draw the mark from there.

After changing it, rewrite the logo files with:

```sh
pnpm build && node scripts/brand-assets.mjs
```

### Social preview

[social/social-preview.png](social/social-preview.png) is the 1280 by 640 card that sites show when someone shares a link to the repository.

`scripts/brand-assets.mjs` writes the card's SVG source, `social/social-preview.svg`, next to it. Render the PNG with a browser, for example from the `social/` folder:

```sh
chrome --headless --window-size=1280,640 --screenshot=social-preview.png social-preview.svg
```

GitHub does not read the file from the repository. To change GitHub's preview, upload the PNG in the repository's Settings.

## Color

| Name      | Hex       | Use                           |
| --------- | --------- | ----------------------------- |
| Bedrock   | `#1d2622` | Masthead and badge background |
| Bone      | `#efeadb` | Text on bedrock               |
| Ochre     | `#d9a441` | Accent and labels on bedrock  |
| Clay      | `#b5573a` | Mark layer                    |
| Verdigris | `#5f8f8a` | Mark layer                    |

Charts and other data take their colors from [src/palette.ts](../../src/palette.ts), one color per category:

- Instructions and skills use verdigris and clay hues, adjusted in steps so they contrast with each other.
- The other categories use hues spaced around those two.
- Growth is shown in ochre and reduction in verdigris, never in red and green.

Below the masthead (the dark band at the top of the report), the page background is paper-colored in light mode and tinted with bedrock in dark mode.

## Type

| Role                                                                     | Face                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Display: wordmark, repository headline, panel headings, headline figures | Archivo ExtraBold at 70% width; the repository name keeps its own capitalization |
| Text and tables                                                          | The system sans-serif stack already in the report                                |
| Labels, commit IDs, dates                                                | The system monospace stack                                                       |

Only the display face is embedded in the report. It is inlined as a `data:` URL, so the HTML stays a single file that works offline. If the embedded face cannot load, the report falls back to a condensed face installed on the system.

### Rebuilding the embedded font

`src/brand-font.ts` holds the embedded display font. It is a static instance of the Archivo variable font: a variable font holds a range of widths and weights, and a static instance fixes one of each, here 70% width and weight 800 (ExtraBold). It keeps the font's full character set, and the file's header carries the SIL Open Font License text.

It was built from [`Archivo[wdth,wght].ttf`](https://github.com/google/fonts/tree/main/ofl/archivo) with the fontTools Python package, in three steps:

1. Fix the width and weight to make a static font.
2. Convert it to the compressed WOFF2 format.
3. Print it as base64 text, which goes into `displayFontBase64` in `src/brand-font.ts`.

```sh
fonttools varLib.instancer 'Archivo[wdth,wght].ttf' wdth=70 wght=800 -o instance.ttf
python -c 'from fontTools.ttLib import TTFont; f = TTFont("instance.ttf"); f.flavor = "woff2"; f.save("instance.woff2")'
base64 < instance.woff2
```

## Provider marks

`providers/` holds the marks of the tools Strata recognizes: Claude, OpenAI (Codex), Google Gemini, GitHub Copilot, and Cursor. The README uses them to show which tools are supported.

Each mark comes in two files:

- `<name>.svg` in bedrock (`#1d2622`), for light backgrounds.
- `<name>-dark.svg` in bone (`#efeadb`), for dark backgrounds.

The shapes come from [Simple Icons](https://simpleicons.org), released under CC0 (public domain). The marks remain trademarks of their owners and are used only to name the products. They are not part of Strata's identity: do not recolor them into the Strata palette or combine them with the Strata logo.
