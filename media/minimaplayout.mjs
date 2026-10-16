// @ts-check
/**
 * Minimap geometry shared by the webview and the unit tests (no DOM): where the box over
 * the visible part of the pages goes in the minimap, and where a point of the minimap
 * scrolls the pages to.
 *
 * Both directions are piecewise linear over the pages: the span from one page's top to
 * the next page's top maps onto the span from its thumbnail's top to the next thumbnail's
 * top (the gap between pages included), the last page's own height onto its thumbnail's
 * height. Outside the first and last page the result is clamped.
 */

/**
 * One page: `top` and `height` of its div in the main view (offsets in the scrolled
 * content), `thumbTop` and `thumbHeight` of its thumbnail in the minimap's content.
 * @typedef {{top: number, height: number, thumbTop: number, thumbHeight: number}} PageSpan
 */

/** Knots [main y, minimap y] of the mapping, in page order. @param {PageSpan[]} pages */
function knots(pages) {
  /** @type {[number, number][]} */
  const k = pages.map((p) => [p.top, p.thumbTop]);
  const last = pages[pages.length - 1];
  k.push([last.top + last.height, last.thumbTop + last.thumbHeight]);
  return k;
}

/**
 * The piecewise-linear function through `k` (sorted by x) at `x`, clamped at both ends.
 * @param {[number, number][]} k @param {number} x
 */
function along(k, x) {
  if (x <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    const [x1, y1] = k[i];
    if (x < x1) {
      const [x0, y0] = k[i - 1];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return k[k.length - 1][1];
}

/**
 * The box over the visible part of the pages, in minimap content coordinates.
 * @param {PageSpan[]} pages @param {number} scrollTop @param {number} clientHeight of the main view
 * @returns {{top: number, height: number}}
 */
export function mapScrollToMinimap(pages, scrollTop, clientHeight) {
  if (!pages.length) return { top: 0, height: 0 };
  const k = knots(pages);
  const top = along(k, scrollTop);
  return { top, height: along(k, scrollTop + clientHeight) - top };
}

/**
 * The main view's content y that minimap content y `y` stands for (the inverse of the
 * mapping above).
 * @param {PageSpan[]} pages @param {number} y
 */
export function mapMinimapToScroll(pages, y) {
  if (!pages.length) return 0;
  return along(knots(pages).map(([a, b]) => /** @type {[number, number]} */ ([b, a])), y);
}
