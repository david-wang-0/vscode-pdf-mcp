// @ts-check
/**
 * Marking helpers shared by the webview and the unit tests (no DOM, no pdf.js): the colour
 * palette, geometry between the page on screen and PDF user space, annotation ownership
 * and reply threads.
 */

/** Text-markup styles, as the edit service names them. */
export const STYLES = /** @type {const} */ (["highlight", "underline", "squiggly", "strikeout"]);

/** PDF /Subtype of each style, and back. */
export const STYLE_SUBTYPE = { highlight: "Highlight", underline: "Underline", squiggly: "Squiggly", strikeout: "StrikeOut" };
/** @type {Record<string, string>} */
export const SUBTYPE_STYLE = { Highlight: "highlight", Underline: "underline", Squiggly: "squiggly", StrikeOut: "strikeout" };

/**
 * The palette, in 0-1 RGB, exactly pdf-reader-writer-mcp's `COLORS` (pdf.py). The webview
 * sends the *name*, so the colour written into the PDF is the service's own value; `hex`
 * is only for showing the swatch.
 * @type {{name: string, rgb: [number, number, number]}[]}
 */
export const PALETTE = [
  { name: "blue", rgb: [0.6, 0.8, 1.0] },
  { name: "yellow", rgb: [1.0, 0.9, 0.3] },
  { name: "green", rgb: [0.6, 0.9, 0.6] },
  { name: "orange", rgb: [1.0, 0.7, 0.4] },
  { name: "pink", rgb: [1.0, 0.7, 0.85] },
  { name: "purple", rgb: [0.8, 0.7, 1.0] },
  { name: "red", rgb: [0.9, 0.3, 0.3] },
  { name: "cyan", rgb: [0.55, 0.95, 0.95] },
  { name: "grey", rgb: [0.75, 0.75, 0.75] },
];

/** `#rrggbb` of a 0-1 RGB triple (each component rounded half up). @param {ArrayLike<number>} rgb */
export function hex(rgb) {
  return "#" + Array.from(rgb).slice(0, 3)
    .map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0")).join("");
}

/** The palette entry `name`, or undefined. @param {string} name */
export const paletteColor = (name) => PALETTE.find((p) => p.name === name);

/**
 * The palette name of a 0-1 RGB colour, if it is one (within half a step of 255 per
 * component, as PDF writers round), else null.
 * @param {ArrayLike<number> | null | undefined} rgb
 */
export function paletteName(rgb) {
  if (!rgb || rgb.length < 3) return null;
  const hit = PALETTE.find((p) => p.rgb.every((c, i) => Math.abs(c - rgb[i]) <= 0.6 / 255 + 0.005));
  return hit ? hit.name : null;
}

/** A colour for the service: a palette name as is, a 0-1 triple as `"r,g,b"`. @param {string | ArrayLike<number>} c */
export function serviceColor(c) {
  if (typeof c === "string") return c;
  return Array.from(c).slice(0, 3).map((v) => String(+v.toFixed(4))).join(",");
}

/** @param {number} v */
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * @typedef {{convertToPdfPoint(x: number, y: number): number[],
 *            convertToViewportPoint(x: number, y: number): number[]}} Viewport
 * @typedef {{left: number, top: number, right: number, bottom: number}} ClientRect
 */

/** `[x0, y0, x1, y1]` with x0 <= x1 and y0 <= y1. @param {number[]} r */
export function normRect([ax, ay, bx, by]) {
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

/**
 * Client (CSS pixel) point to PDF user space. `origin` is the client position of the page
 * viewport's top-left corner (the page's content box).
 * @param {number} x @param {number} y @param {{left: number, top: number}} origin @param {Viewport} viewport
 * @returns {[number, number]}
 */
export function clientPointToPdf(x, y, origin, viewport) {
  const [px, py] = viewport.convertToPdfPoint(x - origin.left, y - origin.top);
  return [r2(px), r2(py)];
}

/**
 * Client rects (one per line or span of a selection) to normalised PDF rects, dropping
 * empty ones and ones inside another.
 * @param {ClientRect[]} rects @param {{left: number, top: number}} origin @param {Viewport} viewport
 * @returns {number[][]}
 */
export function clientRectsToPdf(rects, origin, viewport) {
  const kept = dedupeRects(rects);
  return kept.map((r) => {
    const a = viewport.convertToPdfPoint(r.left - origin.left, r.top - origin.top);
    const b = viewport.convertToPdfPoint(r.right - origin.left, r.bottom - origin.top);
    return normRect([a[0], a[1], b[0], b[1]]).map(r2);
  });
}

/**
 * PDF rect to a client rect (for hit-testing and placing popovers).
 * @param {number[]} rect @param {{left: number, top: number}} origin @param {Viewport} viewport
 * @returns {ClientRect}
 */
export function pdfRectToClient(rect, origin, viewport) {
  const a = viewport.convertToViewportPoint(rect[0], rect[1]);
  const b = viewport.convertToViewportPoint(rect[2], rect[3]);
  const [x0, y0, x1, y1] = normRect([a[0], a[1], b[0], b[1]]);
  return { left: x0 + origin.left, top: y0 + origin.top, right: x1 + origin.left, bottom: y1 + origin.top };
}

/**
 * Drop empty rects and rects contained in another (a range's client rects repeat an
 * element's box and its text's box).
 * @param {ClientRect[]} rects
 */
export function dedupeRects(rects) {
  const ok = rects.filter((r) => r.right - r.left > 0.5 && r.bottom - r.top > 0.5);
  const inside = (/** @type {ClientRect} */ a, /** @type {ClientRect} */ b) =>
    a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
  return ok.filter((r, i) => !ok.some((o, j) => j !== i && inside(r, o) && !(inside(o, r) && j > i)));
}

/** Bounding rect of a quad given as 8 numbers. @param {ArrayLike<number>} q */
export function quadRect(q) {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Split a flat quad-points array (8 numbers per quad) into quads. @param {ArrayLike<number> | null | undefined} flat */
export function splitQuads(flat) {
  /** @type {number[][]} */
  const out = [];
  if (!flat) return out;
  for (let i = 0; i + 8 <= flat.length; i += 8) out.push(Array.from(flat).slice(i, i + 8));
  return out;
}

/**
 * @typedef {{id: string, xref: number | null, page: number, subtype: string, rect: number[],
 *   quads: number[][], color: number[] | null, note: string, author: string,
 *   modified: string, created: string, irt: string | null, text?: string}} Ann
 */

/** Does `pt` (PDF space) fall on `a`? Markup: one of its quads; others: the rect. @param {Ann} a @param {[number, number]} pt @param {number} [slack] */
export function hits(a, [x, y], slack = 1) {
  const boxes = a.quads.length ? a.quads.map(quadRect) : [a.rect];
  return boxes.some(([x0, y0, x1, y1]) => x >= x0 - slack && x <= x1 + slack && y >= y0 - slack && y <= y1 + slack);
}

/** Area of what `hits` tests, so the smallest of several overlapping marks wins. @param {Ann} a */
export function hitArea(a) {
  const boxes = a.quads.length ? a.quads.map(quadRect) : [a.rect];
  return boxes.reduce((s, [x0, y0, x1, y1]) => s + (x1 - x0) * (y1 - y0), 0);
}

/** The topmost annotation under `pt` on its page (smallest first). @param {Ann[]} anns @param {[number, number]} pt */
export function hitTest(anns, pt) {
  const hit = anns.filter((a) => hits(a, pt));
  hit.sort((a, b) => hitArea(a) - hitArea(b));
  return hit[0] || null;
}

/** Own means /T equals the configured author (and the mark has an xref to address it by). @param {{author: string, xref?: number | null}} a @param {string} author */
export function isOwn(a, author) {
  return !!author && a.author === author && a.xref != null;
}

/** The pdf.js id `"<num>R"` as an xref number, else null (inline annotations have none). @param {string} id */
export function xrefOf(id) {
  const m = /^(\d+)R$/.exec(id || "");
  return m ? Number(m[1]) : null;
}

/**
 * Reply threads: roots (no in-reply-to, or one pointing at an unknown annotation) with
 * `replies` nested, each level ordered by date then id.
 * @template {Ann} T
 * @param {T[]} anns
 * @returns {(T & {replies: any[]})[]}
 */
export function buildThreads(anns) {
  /** @type {Map<string, T & {replies: any[]}>} */
  const byId = new Map(anns.map((a) => [a.id, { ...a, replies: [] }]));
  /** @type {(T & {replies: any[]})[]} */
  const roots = [];
  for (const node of byId.values()) {
    const parent = node.irt && node.irt !== node.id ? byId.get(node.irt) : undefined;
    if (parent && !isAncestor(byId, node, parent)) parent.replies.push(node);
    else roots.push(node);
  }
  const byDate = (/** @type {any} */ a, /** @type {any} */ b) =>
    String(a.created || a.modified).localeCompare(String(b.created || b.modified)) || idOrder(a.id, b.id);
  // Roots in reading order (page, then top to bottom, then left to right); replies by date.
  const byPlace = (/** @type {any} */ a, /** @type {any} */ b) =>
    (a.page - b.page) || (top(b) - top(a)) || (left(a) - left(b)) || byDate(a, b);
  const sort = (/** @type {any[]} */ list) => {
    list.sort(byDate);
    for (const n of list) sort(n.replies);
  };
  for (const r of roots) sort(r.replies);
  roots.sort(byPlace);
  return roots;
}

/** Top edge (PDF y, larger is higher) of an annotation: its quads, else its rect. @param {Ann} a */
function top(a) {
  return a.quads.length ? Math.max(...a.quads.map((q) => quadRect(q)[3])) : Math.max(a.rect[1], a.rect[3]);
}
/** @param {Ann} a */
function left(a) {
  return a.quads.length ? Math.min(...a.quads.map((q) => quadRect(q)[0])) : Math.min(a.rect[0], a.rect[2]);
}
/** "12R" before "100R"; other ids by text. @param {string} a @param {string} b */
function idOrder(a, b) {
  const x = parseInt(a, 10);
  const y = parseInt(b, 10);
  return Number.isNaN(x) || Number.isNaN(y) || x === y ? a.localeCompare(b) : x - y;
}

/** Would making `parent` the parent of `node` close a cycle? @param {Map<string, any>} byId @param {any} node @param {any} parent */
function isAncestor(byId, node, parent) {
  const seen = new Set();
  for (let p = parent; p; p = p.irt ? byId.get(p.irt) : null) {
    if (p === node) return true;
    if (seen.has(p)) return true;
    seen.add(p);
  }
  return false;
}

/** The root of the thread that contains `id`. @param {Map<string, Ann>} byId @param {string} id */
export function threadRoot(byId, id) {
  let cur = byId.get(id);
  const seen = new Set();
  while (cur && cur.irt && byId.has(cur.irt) && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.irt);
  }
  return cur || null;
}

/** A PDF date (`D:YYYYMMDDHHmmSS+HH'mm'`) as a Date, or null. @param {string | null | undefined} s */
export function parsePdfDate(s) {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?/.exec(s || "");
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", se = "00", tz, th = "00", tm = "00"] = m;
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  const off = tz === "+" || tz === "-" ? (tz === "+" ? 1 : -1) * (+th * 60 + +tm) : 0;
  return new Date(utc - off * 60000);
}

/** Short local date for the thread view. @param {string | null | undefined} s */
export function formatPdfDate(s) {
  const d = parsePdfDate(s);
  if (!d || Number.isNaN(d.getTime())) return "";
  const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A readable type name. @param {string} subtype */
export function typeLabel(subtype) {
  return ({ Text: "Note", StrikeOut: "Strikeout", FreeText: "Text box", FileAttachment: "Attachment" })[subtype] || subtype;
}
