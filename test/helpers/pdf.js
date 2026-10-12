// @ts-check
/**
 * A tiny PDF writer for tests: pages of Helvetica text lines, optional internal links.
 * Enough for pdf.js to render, select and search; no dependencies.
 */
"use strict";

/** @param {string} s */
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/**
 * @param {string[][]} pages lines of text per page
 * @param {{links?: {page: number, rect: number[], toPage: number}[]}} [opts] 1-based pages
 * @returns {Buffer}
 */
function makePdf(pages, { links = [] } = {}) {
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
  return Buffer.from(out, "latin1");
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

module.exports = { makePdf, samplePdf };
