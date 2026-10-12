// @ts-check
/**
 * Normalise text selected in the pdf.js text layer: lines are joined with spaces,
 * whitespace runs collapse to one space, and a line-end hyphen is removed only where that
 * is trivially safe (a soft hyphen, or a hyphen between two lower-case letters that ends a
 * line). Shared by the webview and the unit tests.
 */

/**
 * @param {string} raw `Selection.toString()` of the text layer
 * @returns {string}
 */
export function normaliseSelection(raw) {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/\u00AD[ \t]*\n\s*/g, "")
    .replace(/(\p{Ll})-[ \t]*\n\s*(?=\p{Ll})/gu, "$1")
    .replace(/\u00AD/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
