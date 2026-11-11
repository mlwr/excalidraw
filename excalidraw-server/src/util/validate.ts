/** helpers for request input that ends up in SQL */

// Postgres rejects NUL in text; no control character belongs in a name
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const HAS_CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

/** user text on one line: control characters become spaces */
export const singleLine = (value: string) => value.replace(CONTROL_CHARS, " ");

export const hasControlChars = (value: string) => HAS_CONTROL_CHAR.test(value);

/** non-negative integer that a Postgres bigint stores exactly */
export const isCounter = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** a counter sent as a decimal string (bigint columns arrive as strings) */
export const isCounterString = (value: unknown): value is string =>
  typeof value === "string" && /^\d{1,15}$/.test(value);

/** first value of a query parameter that may be repeated (?q=a&q=b) */
export const queryParam = (value: unknown): string | undefined => {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first : undefined;
};

/** search text from a query parameter: one line, trimmed, bounded */
export const searchText = (value: unknown, maxLength = 100) =>
  singleLine(queryParam(value) || "")
    .trim()
    .slice(0, maxLength);

/** ILIKE pattern that finds `text` literally anywhere */
export const containsPattern = (text: string) =>
  `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
