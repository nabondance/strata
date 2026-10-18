import type { Category } from "./adapters.js";
import { brandColors } from "./brand.js";

/**
 * Category colors shared by the HTML report and the SVG image, so both read the same way.
 * Instructions and skills take the brand's verdigris and clay hues; the rest are spaced around
 * them so neighbors in the stack stay apart for color-blind readers, on light and dark grounds.
 */
export const categoryColors: Record<Category, string> = {
  instructions: "#007d8a",
  skills: "#b5573a",
  agents: "#8062b0",
  rules: "#ba8617",
  commands: "#316cb5",
  memory: "#457f38",
  settings: "#cd6c95",
  tools: "#9b5c1f",
  other: "#6f766d",
};

const luminance = (hex: string) => {
  const channel = (start: number) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};
const darkInk = "#10140f";

const inkOn = (color: string) => {
  const onWhite = 1.05 / (luminance(color) + 0.05);
  const onDark = (luminance(color) + 0.05) / (luminance(darkInk) + 0.05);
  return onWhite >= onDark ? "#ffffff" : darkInk;
};

/** The label color to set on each category color: white or near-black, whichever contrasts more. */
export const categoryInk = Object.fromEntries(
  Object.entries(categoryColors).map(([category, color]) => [category, inkOn(color)]),
) as Record<Category, string>;

const mix = (hex: string, toward: string, share: number) =>
  `#${[1, 3, 5]
    .map((start) => {
      const from = Number.parseInt(hex.slice(start, start + 2), 16);
      const to = Number.parseInt(toward.slice(start, start + 2), 16);
      return Math.round(from + (to - from) * share)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;

/**
 * Each category color pressed toward the brand's bedrock. The treemap fills a category's block with it,
 * so it shows as the band holding the category's name and the seams between its files.
 */
export const categoryShade = Object.fromEntries(
  Object.entries(categoryColors).map(([category, color]) => [category, mix(color, brandColors.bedrock, 0.38)]),
) as Record<Category, string>;

/** The label color for each category shade. */
export const categoryShadeInk = Object.fromEntries(
  Object.entries(categoryShade).map(([category, color]) => [category, inkOn(color)]),
) as Record<Category, string>;
