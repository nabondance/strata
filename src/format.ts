/** A signed number for a delta, such as "+12", "0", or "-3". */
export const signed = (value: number): string => (value > 0 ? `+${value}` : String(value));
