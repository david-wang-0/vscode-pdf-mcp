// @ts-check
/**
 * A tiny PDF writer for tests: pages of Helvetica text lines, optional internal links.
 * Enough for pdf.js to render, select and search; no dependencies.
 */
"use strict";

/** @param {string} s */
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/**
 * @typedef {{page: number, subtype: string, rect: number[], quads?: number[], color?: number[],
 *   contents?: string, author?: string, irt?: number, date?: string}} AnnotSpec
 *   `irt` is the index of the parent in the same `annots` list.
 */

/**
 * @param {string[][]} pages lines of text per page
 * @param {{links?: {page: number, rect: number[], toPage: number}[], annots?: AnnotSpec[]}} [opts]
 *   1-based pages
 * @returns {Buffer & {annotIds?: number[]}} with `annotIds`: the object number of each annot
 */
function makePdf(pages, { links = [], annots = [] } = {}) {
  /** @type {string[]} */
  const objs = [];
  const n = pages.length;
  // 1 catalog, 2 pages, 3 font, then per page i: page = 4 + 2i, content = 5 + 2i, then annots.
  const pageId = (/** @type {number} */ i) => 4 + 2 * i;
  let next = 4 + 2 * n;
  /** @type {Map<number, number[]>} */
  const annotsByPage = new Map();
  /** @type {[number, string][]} */
  const annotObjs = [];
  for (const l of links) {
    const id = next++;
    annotObjs.push([id, `<< /Type /Annot /Subtype /Link /Rect [${l.rect.join(" ")}] /Border [0 0 0] ` +
      `/Dest [${pageId(l.toPage - 1)} 0 R /XYZ 0 792 null] >>`]);
    annotsByPage.set(l.page, [...(annotsByPage.get(l.page) || []), id]);
  }
  const annotIds = annots.map(() => next++);
  annots.forEach((a, i) => {
    const date = a.date || "D:20261012120000Z";
    const parts = [`/Type /Annot /Subtype /${a.subtype} /Rect [${a.rect.join(" ")}] /P ${pageId(a.page - 1)} 0 R`,
      `/F 4 /M (${date}) /CreationDate (${date})`];
    if (a.quads) parts.push(`/QuadPoints [${a.quads.join(" ")}]`);
    if (a.color) parts.push(`/C [${a.color.join(" ")}]`);
    if (a.contents !== undefined) parts.push(`/Contents (${esc(a.contents)})`);
    if (a.author !== undefined) parts.push(`/T (${esc(a.author)})`);
    if (a.irt !== undefined) parts.push(`/IRT ${annotIds[a.irt]} 0 R`);
    if (a.subtype === "Text") parts.push("/Name /Comment");
    annotObjs.push([annotIds[i], `<< ${parts.join(" ")} >>`]);
    annotsByPage.set(a.page, [...(annotsByPage.get(a.page) || []), annotIds[i]]);
  });
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(" ")}] /Count ${n} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  pages.forEach((lines, i) => {
    const ops = ["BT", "/F1 12 Tf", "14 TL", "72 720 Td"];
    for (const line of lines) ops.push(`(${esc(line)}) Tj T*`);
    ops.push("ET");
    const stream = ops.join("\n");
    const annots = annotsByPage.get(i + 1);
    objs[pageId(i)] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId(i) + 1} 0 R` +
      (annots ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(" ")}]` : "") + " >>";
    objs[pageId(i) + 1] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });
  for (const [id, body] of annotObjs) objs[id] = body;

  let out = "%PDF-1.4\n";
  /** @type {number[]} */
  const offsets = [];
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = Buffer.byteLength(out, "latin1");
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Object.assign(Buffer.from(out, "latin1"), { annotIds });
}

/**
 * `count` pages, each with a heading and a few sentences (one hyphenated across lines).
 * @param {number} count @param {string} [tag] distinguishes rewrites in reload tests
 */
function samplePdf(count, tag = "") {
  const pages = [];
  for (let p = 1; p <= count; p++) {
    pages.push([
      `Page ${p} heading ${tag}`.trim(),
      "",
      "Reachability of timed automata is decidable via regions.",
      "This sentence is hyphen-",
      "ated across two lines.",
      `Unique marker alpha${p}.`,
      ...Array.from({ length: 30 }, (_, k) => `Filler line ${k + 1} on page ${p}.`),
    ]);
  }
  return makePdf(pages, { links: count >= 3 ? [{ page: 1, rect: [72, 640, 300, 660], toPage: 3 }] : [] });
}

/** Lines of `samplePdf` pages, for annotated fixtures. @param {number} p @param {string} [tag] */
function sampleLines(p, tag = "") {
  return [
    `Page ${p} heading ${tag}`.trim(),
    "",
    "Reachability of timed automata is decidable via regions.",
    "This sentence is hyphen-",
    "ated across two lines.",
    `Unique marker alpha${p}.`,
    ...Array.from({ length: 30 }, (_, k) => `Filler line ${k + 1} on page ${p}.`),
  ];
}

/**
 * Two pages with a thread by two authors: A, an `llm` highlight with a note, answered by
 * B, a `david` reply; C, a `david` underline answered by E, an `llm` reply; D, an `llm`
 * margin note. Returns the PDF and the object number (xref) of each.
 */
function threadPdf() {
  const line = (/** @type {number} */ i, /** @type {number} */ x1) => [72, 703 - 14 * i, x1, 703 - 14 * i, 72, 689 - 14 * i, x1, 689 - 14 * i];
  const [A, B, C, D, E] = [0, 1, 2, 3, 4];
  const annots = [
    { page: 1, subtype: "Highlight", rect: [70, 688, 402, 704], quads: line(0, 400), color: [1, 0.9, 0.3], contents: "An llm note", author: "llm" },
    { page: 1, subtype: "Text", rect: [30, 700, 46, 716], color: [0.2, 0.45, 1], contents: "My answer", author: "david", irt: A, date: "D:20261012130000Z" },
    { page: 1, subtype: "Underline", rect: [70, 646, 192, 662], quads: line(3, 190), color: [0.6, 0.9, 0.6], contents: "Mine", author: "david" },
    { page: 1, subtype: "Text", rect: [30, 560, 46, 576], color: [0.2, 0.45, 1], contents: "Margin by llm", author: "llm" },
    { page: 1, subtype: "Text", rect: [30, 630, 46, 646], color: [0.2, 0.45, 1], contents: "llm answers you", author: "llm", irt: C, date: "D:20261012140000Z" },
  ];
  const data = makePdf([sampleLines(1), sampleLines(2)], { annots });
  const ids = /** @type {number[]} */ (data.annotIds);
  return { data, xref: { A: ids[A], B: ids[B], C: ids[C], D: ids[D], E: ids[E] } };
}

module.exports = { makePdf, samplePdf, sampleLines, threadPdf };
