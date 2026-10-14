// @ts-check
/**
 * extension/synctexstore.js: the per-PDF SyncTeX data follows its synctex file (parsed
 * on watch, re-parsed when a build rewrites it, dropped when it goes), the PDF of a .tex
 * by `% !TEX root` or base name, and the source-line text of the hover tip.
 */
"use strict";

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { SynctexStore, pdfCandidatesForTex, sourceLine, sourceLines, snippet } = require("../extension/synctexstore");

/** @type {(() => void)[]} */
const cleanups = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vpdf-stxstore-")));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A one-page synctex file whose only text line comes from `line` of a.tex. @param {number} line */
function synctexText(line) {
  return ["SyncTeX Version:1", "Input:1:./a.tex", "Output:pdf", "Magnification:1000", "Unit:1", "X Offset:0", "Y Offset:0",
    "Content:", "{1", "[1,1:0,1000000:20000000,900000,0", `(1,${line}:4736286,6000000:10000000,500000,100000`,
    `x1,${line}:6000000,6000000`, `k1,${line}:6300000,6000000:300000`, `x1,${line}:9000000,6000000`, ")", "]", "}1",
    "Postamble:", "Count:5", "Post scriptum:", ""].join("\n");
}

/** Resolve on the next onChange. @param {{next: Promise<any>}} probe */
const changed = (probe) => probe.next;

function store() {
  /** @type {(v: any) => void} */
  let resolveNext = () => {};
  const probe = { next: /** @type {Promise<any>} */ (new Promise((r) => (resolveNext = r))) };
  const s = new SynctexStore({
    debounceMs: 20,
    onChange: (pdf, data) => {
      const r = resolveNext;
      probe.next = new Promise((res) => (resolveNext = res));
      r({ pdf, data });
    },
  });
  cleanups.push(() => s.dispose());
  return { s, probe };
}

test("store: parses on watch, re-parses when the file is rewritten, drops the data when it goes", async () => {
  const d = tmp();
  const pdf = path.join(d, "a.pdf");
  fs.writeFileSync(pdf, "%PDF-1.4\n");
  fs.writeFileSync(path.join(d, "a.synctex.gz"), zlib.gzipSync(synctexText(3)));
  const { s, probe } = store();
  let next = changed(probe);
  s.watch(pdf);
  let ev = await next;
  assert.equal(ev.pdf, pdf);
  assert.equal(s.peek(pdf)?.edit(1, 120, 90)?.line, 3);

  // a rebuild replaces the file (write a temp, rename over it, as TeX engines do)
  next = changed(probe);
  fs.writeFileSync(path.join(d, "a.synctex.gz.tmp"), zlib.gzipSync(synctexText(8)));
  fs.renameSync(path.join(d, "a.synctex.gz.tmp"), path.join(d, "a.synctex.gz"));
  ev = await next;
  assert.equal(ev.data.edit(1, 120, 90).line, 8);
  assert.equal(s.peek(pdf)?.edit(1, 120, 90)?.line, 8);

  // an uncompressed .synctex written later is newer and wins
  next = changed(probe);
  fs.writeFileSync(path.join(d, "a.synctex"), synctexText(11));
  ev = await next;
  assert.equal(s.peek(pdf)?.edit(1, 120, 90)?.line, 11);

  // a build in progress (the engine writes X.synctex(busy)): the old data stays
  fs.writeFileSync(path.join(d, "a.synctex(busy)"), "");
  fs.rmSync(path.join(d, "a.synctex"));
  fs.rmSync(path.join(d, "a.synctex.gz"));
  assert.equal((await s.refresh(pdf))?.edit(1, 120, 90)?.line, 11);
  fs.rmSync(path.join(d, "a.synctex(busy)"));

  // both gone: no data
  next = changed(probe);
  void s.refresh(pdf);
  ev = await next;
  assert.equal(ev.data, null);
  assert.equal(s.peek(pdf), null);
  s.unwatch(pdf);
  assert.equal(s.entries.size, 0);
});

test("store: a broken file keeps the old data; get() loads a PDF nobody watches", async () => {
  const d = tmp();
  const pdf = path.join(d, "a.pdf");
  fs.writeFileSync(path.join(d, "a.synctex.gz"), zlib.gzipSync(synctexText(4)));
  const { s } = store();
  const data = await s.get(pdf);
  assert.equal(data?.edit(1, 120, 90)?.line, 4);
  fs.writeFileSync(path.join(d, "a.synctex.gz"), Buffer.from("not gzip at all"));
  const after = await s.get(pdf);
  assert.equal(after, data, "kept while the file is mid-write");
  fs.rmSync(path.join(d, "a.synctex.gz"));
  assert.equal(await s.get(pdf), null);
  assert.equal(await s.get(path.join(d, "none.pdf")), null);
});

test("pdfCandidatesForTex: % !TEX root first, then the same base name", () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, "chapters"));
  const ch = path.join(d, "chapters", "one.tex");
  fs.writeFileSync(ch, "% !TEX root = ../main.tex\n\\section{One}\n");
  assert.deepEqual(pdfCandidatesForTex(ch), [path.join(d, "main.pdf"), path.join(d, "chapters", "one.pdf")]);
  fs.writeFileSync(ch, "%!TeX root=../thesis\n");
  assert.deepEqual(pdfCandidatesForTex(ch), [path.join(d, "thesis.pdf"), path.join(d, "chapters", "one.pdf")]);
  const plain = path.join(d, "paper.tex");
  fs.writeFileSync(plain, "\\documentclass{article}\n");
  assert.deepEqual(pdfCandidatesForTex(plain), [path.join(d, "paper.pdf")]);
  assert.deepEqual(pdfCandidatesForTex(path.join(d, "missing.tex")), [path.join(d, "missing.pdf")]);
});

test("sourceLine: the line, whitespace collapsed, cut at about 80 characters; empty when unreadable", () => {
  const d = tmp();
  const f = path.join(d, "a.tex");
  fs.writeFileSync(f, "first line\n   indented\twith  tabs  \n" + "x".repeat(200) + "\n");
  assert.equal(sourceLine(f, 1), "first line");
  assert.equal(sourceLine(f, 2), "indented with tabs");
  assert.equal(sourceLine(f, 3), "x".repeat(79) + "…");
  assert.equal(sourceLine(f, 3).length, 80);
  assert.equal(sourceLine(f, 9), "");
  assert.equal(sourceLine(path.join(d, "nope.tex"), 1), "");
  fs.writeFileSync(f, "changed\n");
  assert.equal(sourceLine(f, 1), "changed", "re-read when the file changes");
});

test("snippet: the hover tip's line with the matched word marked, cut around it when the line is long", () => {
  const raw = "  A  \\emph{model}\tof the model checker.";
  const s = snippet(raw, [raw.indexOf("model checker"), raw.indexOf("model checker") + 5]);
  assert.equal(s.text, "A \\emph{model} of the model checker.");
  assert.equal(s.text.slice(...(/** @type {[number, number]} */ (s.em))), "model");
  assert.equal(s.em?.[0], s.text.indexOf("model checker"));
  assert.deepEqual(snippet(raw, null), { text: "A \\emph{model} of the model checker." });
  // a long line: the word far in shows, with "…" on both sides and at most about 80 characters
  const long = `${"a".repeat(100)} target ${"b".repeat(100)}`;
  const l = snippet(long, [101, 107]);
  assert.ok(l.text.startsWith("…") && l.text.endsWith("…") && l.text.length <= 80, l.text);
  assert.equal(l.text.slice(...(/** @type {[number, number]} */ (l.em))), "target");
  // near the start: cut at the end as sourceLine does
  const e = snippet(`word ${"c".repeat(100)}`, [0, 4]);
  assert.deepEqual([e.text.length, e.em], [80, [0, 4]]);
  const d = tmp();
  const f = path.join(d, "a.tex");
  fs.writeFileSync(f, "one\r\ntwo\n");
  assert.deepEqual(sourceLines(f), ["one", "two", ""]);
  assert.deepEqual(sourceLines(path.join(d, "nope.tex")), []);
});

test("store: one watch per tab: the data stays until the last tab unwatches; unknown PDFs are ignored", async () => {
  const d = tmp();
  const pdf = path.join(d, "a.pdf");
  fs.writeFileSync(path.join(d, "a.synctex.gz"), zlib.gzipSync(synctexText(3)));
  /** @type {string[]} */
  const logs = [];
  const s = new SynctexStore({ debounceMs: 20, log: (m) => logs.push(m) });
  cleanups.push(() => s.dispose());
  s.watch(pdf);
  s.watch(pdf);
  await s.refresh(pdf);
  assert.equal(logs.filter((l) => l.startsWith("SyncTeX: parsed")).length, 1, "parsed once for two tabs");
  s.unwatch(pdf);
  assert.equal(s.peek(pdf)?.edit(1, 120, 90)?.line, 3, "still watched by the other tab");
  s.unwatch(pdf);
  assert.equal(s.peek(pdf), null);
  s.unwatch(path.join(d, "never-watched.pdf"));
  assert.equal(s.entries.size, 0);
});

test("store: a PDF whose directory cannot be watched is logged, and loads without a watch", async () => {
  const d = tmp();
  const pdf = path.join(d, "gone", "a.pdf");
  /** @type {string[]} */
  const logs = [];
  const s = new SynctexStore({ log: (m) => logs.push(m) });
  cleanups.push(() => s.dispose());
  s.watch(pdf);
  assert.ok(logs.some((l) => l.startsWith(`cannot watch ${path.dirname(pdf)} for SyncTeX: `)), logs.join("\n"));
  assert.equal(await s.refresh(pdf), null);
  s.dispose();
  assert.equal(s.entries.size, 0);
});

test("store: refreshes asked for while a parse runs wait for it, and the file is parsed once", async () => {
  const d = tmp();
  const pdf = path.join(d, "a.pdf");
  fs.writeFileSync(path.join(d, "a.synctex.gz"), zlib.gzipSync(synctexText(6)));
  /** @type {string[]} */
  const logs = [];
  const s = new SynctexStore({ log: (m) => logs.push(m) });
  cleanups.push(() => s.dispose());
  const [a, b, c] = await Promise.all([s.refresh(pdf), s.refresh(pdf), s.get(pdf)]);
  assert.ok(a && a === b && b === c);
  assert.equal(a.edit(1, 120, 90)?.line, 6);
  assert.equal(logs.filter((l) => l.startsWith("SyncTeX: parsed")).length, 1, logs.join("\n"));
});
