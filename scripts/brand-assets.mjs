// Writes the logo files in docs/brand from the mark the report itself draws. Run after `pnpm build`.
import { mkdirSync, writeFileSync } from "node:fs";
import { brandColors, markSvg } from "../dist/brand.js";
import { categoryColors } from "../dist/palette.js";

// "STRATA" set in the embedded display face and outlined, so the files need no font. 1000 units per em, baseline at y = 0.
const wordmark =
  "M259 12Q211 12 169.5 2.5Q128 -7 96.5 -31Q65 -55 47 -96.5Q29 -138 29 -202Q29 -206 29 -212Q29 -218 30 -222H182Q181 -217 181 -212Q181 -207 181 -202Q181 -170 189.5 -152Q198 -134 214 -126.5Q230 -119 253 -119Q267 -119 277.5 -121.5Q288 -124 296.5 -130Q305 -136 310.5 -144Q316 -152 319 -163.5Q322 -175 322 -189Q322 -213 310 -228.5Q298 -244 278 -255.5Q258 -267 232.5 -276.5Q207 -286 180 -297Q153 -308 128 -323.5Q103 -339 83 -361.5Q63 -384 51 -416Q39 -448 39 -493Q39 -549 56.5 -588Q74 -627 105 -652Q136 -677 175 -688.5Q214 -700 258 -700Q303 -700 341 -689.5Q379 -679 408 -656.5Q437 -634 453 -597Q469 -560 469 -506V-484H319V-496Q319 -519 313.5 -535Q308 -551 295 -560Q282 -569 260 -569Q241 -569 227 -562.5Q213 -556 206 -543Q199 -530 199 -510Q199 -486 211 -469.5Q223 -453 243.5 -441.5Q264 -430 289 -420.5Q314 -411 341 -400Q368 -389 393 -374Q418 -359 438.5 -337.5Q459 -316 471 -284.5Q483 -253 483 -209Q483 -133 455 -84Q427 -35 377 -11.5Q327 12 259 12Z M698 0V-552H541V-687H1012V-552H856V0Z M1100 0V-687H1365Q1442 -687 1486 -659.5Q1530 -632 1548.5 -585Q1567 -538 1567 -480Q1567 -419 1549.5 -369.5Q1532 -320 1491 -290L1590 0H1423L1347 -243H1258V0ZM1258 -370H1342Q1378 -370 1393 -397Q1408 -424 1408 -468Q1408 -496 1401.5 -516.5Q1395 -537 1380.5 -547.5Q1366 -558 1340 -558H1258Z M1621 0 1790 -687H1999L2169 0H2003L1975 -126H1809L1782 0ZM1833 -255H1952L1917 -430Q1915 -438 1912.5 -452Q1910 -466 1907 -483Q1904 -500 1901.5 -516.5Q1899 -533 1896 -547H1889Q1886 -530 1882.5 -508Q1879 -486 1875 -465.5Q1871 -445 1868 -430Z M2364 0V-552H2207V-687H2678V-552H2522V0Z M2716 0 2885 -687H3094L3264 0H3098L3070 -126H2904L2877 0ZM2928 -255H3047L3012 -430Q3010 -438 3007.5 -452Q3005 -466 3002 -483Q2999 -500 2996.5 -516.5Q2994 -533 2991 -547H2984Q2981 -530 2977.5 -508Q2974 -486 2970 -465.5Q2966 -445 2963 -430Z";
// The mark's shapes, one per line, without the wrapper the report needs.
const mark = markSvg(64)
  .replace(/^<svg[^>]*>|<\/svg>$/g, "")
  .replace(/></g, ">\n  <");

function logo(width, extra = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="64" viewBox="0 0 ${width} 64" role="img" aria-labelledby="strata-logo">
  <title id="strata-logo">Strata</title>
  ${mark}${extra}
</svg>
`;
}
// Cap height is 686 units; this scale sets the wordmark 40 high, centered on the mark.
const withWordmark = (ink) =>
  logo(272, `\n  <path transform="translate(82 52) scale(0.0583)" fill="${ink}" d="${wordmark}"/>`);

const directory = new URL("../docs/brand/", import.meta.url);
writeFileSync(new URL("logo.svg", directory), logo(64));
writeFileSync(new URL("logo-wordmark.svg", directory), withWordmark(brandColors.bedrock));
writeFileSync(new URL("logo-wordmark-dark.svg", directory), withWordmark(brandColors.bone));

// The link-preview card: 1280 by 640, centered so a cropped preview keeps the name, with the layers along the bottom as in the report's masthead.
// Render it to PNG for GitHub's social preview; see docs/brand/README.md.
const steps = [
  ["agents", [16, 16, 22, 30, 30, 38, 52, 52, 60, 74, 70, 70, 82, 96, 96, 108]],
  ["skills", [8, 8, 12, 18, 18, 24, 34, 34, 40, 50, 46, 46, 56, 66, 66, 74]],
  ["instructions", [4, 4, 6, 6, 8, 8, 8, 16, 16, 16, 10, 10, 10, 12, 12, 12]],
];
const layers = steps
  .map(([category, heights]) => {
    const width = 1280 / heights.length;
    const top = heights
      .map((height, index) => `H${index * width}V${640 - height * 1.6}H${(index + 1) * width}`)
      .join("");
    return `<path d="M0,640${top}V640Z" fill="${categoryColors[category]}"/>`;
  })
  .join("\n  ");
const social = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640" role="img" aria-labelledby="strata-social">
  <title id="strata-social">Strata: see how your agent context evolved across Git history</title>
  <rect width="1280" height="640" fill="${brandColors.bedrock}"/>
  ${layers}
  <g transform="translate(306 110) scale(1.75)">
  ${mark}
  </g>
  <path transform="translate(450 204) scale(0.16)" fill="${brandColors.bone}" d="${wordmark}"/>
  <text x="640" y="312" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="30" fill="${brandColors.bone}">See how your agent context evolved across Git history.</text>
  <text x="640" y="360" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="24" fill="${brandColors.ochre}">npx context-strata analyze --open</text>
</svg>
`;
mkdirSync(new URL("social/", directory), { recursive: true });
writeFileSync(new URL("social/social-preview.svg", directory), social);
