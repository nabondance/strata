import type { Category } from "./adapters.js";

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

/** The label color to set on each category color: white or near-black, whichever contrasts more. */
export const categoryInk = Object.fromEntries(
  Object.entries(categoryColors).map(([category, color]) => {
    const onWhite = 1.05 / (luminance(color) + 0.05);
    const onDark = (luminance(color) + 0.05) / (luminance(darkInk) + 0.05);
    return [category, onWhite >= onDark ? "#ffffff" : darkInk];
  }),
) as Record<Category, string>;
