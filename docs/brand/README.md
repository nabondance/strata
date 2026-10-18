# Strata brand kit

The identity is called **Fault line**: layers of sediment cut by a fault, with the right side slipped down. It stands for what Strata shows, the same configuration displaced over time.

## Logo

| File | Use |
| --- | --- |
| [logo.svg](logo.svg) | The mark alone: icons, avatars, anywhere under about 100px wide. It stays legible at 16px. |
| [logo-wordmark.svg](logo-wordmark.svg) | Mark and wordmark in bedrock, for light backgrounds. |
| [logo-wordmark-dark.svg](logo-wordmark-dark.svg) | Mark and wordmark in bone, for dark backgrounds. |

All three have a transparent background, and the wordmark is outlined, so the files need no font. Keep clear space of a quarter of the mark's width around the logo. Do not recolor the layers, straighten the fault, or set the mark on a busy background without its badge.

The mark's geometry lives in `markSvg` in [src/brand.ts](../../src/brand.ts); the HTML report, its favicon, and the SVG image draw it from there. After changing it, run `pnpm build && node scripts/brand-assets.mjs` to rewrite these files.

### Social preview

[social/social-preview.png](social/social-preview.png) is the 1280 by 640 link-preview card. `scripts/brand-assets.mjs` writes its SVG source next to it; render the PNG with a browser, for example `chrome --headless --window-size=1280,640 --screenshot=social-preview.png social-preview.svg`. GitHub's social preview is set by uploading the PNG under the repository's Settings.

## Color

| Name | Hex | Use |
| --- | --- | --- |
| Bedrock | `#1d2622` | Masthead and badge background |
| Bone | `#efeadb` | Text on bedrock |
| Ochre | `#d9a441` | Accent and labels on bedrock |
| Clay | `#b5573a` | Mark layer |
| Verdigris | `#5f8f8a` | Mark layer |

Data is colored by category from [src/palette.ts](../../src/palette.ts). Instructions and skills use verdigris and clay hues stepped for contrast; the other categories are spaced around them. Growth is shown in ochre and reduction in verdigris, never red and green. Below the masthead the report uses a paper ground in light mode and a bedrock-tinted one in dark mode.

## Type

| Role | Face |
| --- | --- |
| Display: wordmark, repository headline, panel headings, headline figures | Archivo ExtraBold at 70% width; the repository name keeps its own capitalization |
| Text and tables | The system sans-serif stack already in the report |
| Labels, commit IDs, dates | The system monospace stack |

Only the display face is embedded in the report; it is inlined as a `data:` URL so the HTML stays a single offline file. If it cannot load, the stack falls back to a condensed face the system has.

### Rebuilding the embedded font

`src/brand-font.ts` holds a static instance of the Archivo variable font with its full character set, with the SIL Open Font License text in its header. It was built from [`Archivo[wdth,wght].ttf`](https://github.com/google/fonts/tree/main/ofl/archivo) with fontTools:

```sh
fonttools varLib.instancer 'Archivo[wdth,wght].ttf' wdth=70 wght=800 -o instance.ttf
python -c 'from fontTools.ttLib import TTFont; f = TTFont("instance.ttf"); f.flavor = "woff2"; f.save("instance.woff2")'
base64 < instance.woff2
```

## Provider marks

`providers/` holds the Claude, OpenAI, Google Gemini, GitHub Copilot, and Cursor marks the README uses to say which tools Strata recognizes, in a light (`#1d2622`) and a dark (`#efeadb`) variant. The paths come from [Simple Icons](https://simpleicons.org) (CC0). The marks remain trademarks of their owners and are used only to identify the products; they are not part of Strata's identity and must not be recolored into the Strata palette or combined with the Strata logo.
