import type { Category } from "./adapters.js";

/** Category colors shared by the HTML report and the SVG image, so both read the same way. */
export const categoryColors: Record<Category, string> = {
  instructions: "#31575b",
  skills: "#88472d",
  agents: "#645976",
  rules: "#766023",
  commands: "#813b43",
  memory: "#476d44",
  settings: "#52676a",
  tools: "#4b607d",
  other: "#5f665b",
};
