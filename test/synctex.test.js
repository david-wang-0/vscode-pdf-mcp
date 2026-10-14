// @ts-check
/**
 * lib/synctex.js: parsing, reverse and forward search, and the selection-to-source
 * mapping, checked against the `synctex` command line tool on a LaTeX project compiled
 * with `pdflatex -synctex=1` (multi-file \input, a wrapped paragraph, display math, a
 * list, two columns, two pages). Skipped, with the reason, without pdflatex or synctex.
 */
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const { parseSynctex, loadSynctex, synctexFileFor } = require("../lib/synctex");
const { HAVE_PDFLATEX, HAVE_SYNCTEX, HAVE_PDFTOTEXT, buildProject, compile, wordBoxes } = require("./helpers/latex");

const SKIP_TEX = !HAVE_PDFLATEX && "pdflatex is not installed";
const SKIP_WORDS = SKIP_TEX || (!HAVE_PDFTOTEXT && "pdftotext is not installed");
const SKIP_ORACLE = SKIP_TEX || (!HAVE_SYNCTEX && "the synctex command line tool is not installed");

/** @type {string} */
let dir;
/** @type {ReturnType<typeof buildProject>} */
let project;
/** @type {import("../lib/synctex").Synctex} */
let data;

before(async () => {
  if (SKIP_TEX) return;
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vpdf-synctex-")));
  project = buildProject(dir);
  const loaded = await loadSynctex(project.pdf);
  assert.ok(loaded);
  data = loaded.data;
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/** @param {string[]} args */
function cli(args) {
  const r = spawnSync("synctex", args, { cwd: dir, encoding: "utf8" });
  return r.stdout || "";
}

/** `synctex edit`: the results, in order. @param {number} page @param {number} x @param {number} y */
function cliEdit(page, x, y) {
  const out = cli(["edit", "-o", `${page}:${x.toFixed(3)}:${y.toFixed(3)}:${project.pdf}`]);
  /** @type {{file: string, line: number}[]} */
  const res = [];
  let file = "";
  for (const l of out.split("\n")) {
    if (l.startsWith("Input:")) file = path.resolve(l.slice(6));
    else if (l.startsWith("Line:")) res.push({ file, line: Number(l.slice(5)) });
  }
  return res;
}

/** `synctex view`: per result, page and box [l, t, r, b]. @param {string} file @param {number} line */
function cliView(file, line) {
  const out = cli(["view", "-i", `${line}:0:${file}`, "-o", project.pdf]);
  /** @type {{page: number, box: number[]}[]} */
  const res = [];
  /** @type {Record<string, number>} */
  let cur = {};
  for (const l of out.split("\n")) {
    const m = /^(Page|h|v|W|H):(-?[\d.]+)$/.exec(l);
    if (!m) continue;
    if (m[1] === "Page" && "Page" in cur) {
      res.push({ page: cur.Page, box: [cur.h, cur.v - cur.H, cur.h + cur.W, cur.v] });
      cur = {};
    }
    cur[m[1]] = Number(m[2]);
  }
  if ("Page" in cur) res.push({ page: cur.Page, box: [cur.h, cur.v - cur.H, cur.h + cur.W, cur.v] });
  return res;
}

/** @param {number[]} a @param {number[]} b @param {number} [tol] */
const overlaps = (a, b, tol = 0.5) => a[0] < b[2] + tol && b[0] < a[2] + tol && a[1] < b[3] + tol && b[1] < a[3] + tol;

/** Points over the text: across each line box at mid-height, and over each word if pdftotext is there. */
function textPoints() {
  /** @type {[number, number, number][]} */
  const pts = [];
  for (const page of data.pages) {
    for (const box of data.hboxes.get(page) || []) {
      if (!(box.kids || []).some((k) => k.t === "x" || k.t === "k")) continue;
      const [l, t, r, b] = data.rect(box.hV, box.vV - box.HV, box.hV + Math.abs(box.WV), box.vV);
      if (r - l < 2 || b - t < 2) continue;
      for (const f of [0.03, 0.2, 0.37, 0.5, 0.63, 0.8, 0.97]) pts.push([page, l + f * (r - l), t + 0.6 * (b - t)]);
    }
  }
  const words = spawnSync("pdftotext", ["-bbox", project.pdf, "-"], { encoding: "utf8" });
  if (words.status === 0) {
    let page = 0;
    for (const l of words.stdout.split("\n")) {
      if (l.includes("<page ")) page++;
      const m = /xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)"/.exec(l);
      if (m && page) {
        const [x0, y0, x1, y1] = m.slice(1).map(Number);
        pts.push([page, (x0 + x1) / 2, (y0 + y1) / 2], [page, x0 + 0.5, (y0 + y1) / 2], [page, x1 - 0.5, (y0 + y1) / 2]);
      }
    }
  }
  return pts;
}

// ---- parsing ---------------------------------------------------------------------------

test("parse: inputs, pages, units and the records of a pdflatex synctex.gz", { skip: SKIP_TEX }, () => {
  assert.deepEqual(data.pages, [1, 2]);
  assert.ok(data.files.includes(project.main), data.files.join(", "));
  assert.ok(data.files.includes(project.chapter));
  assert.ok(Math.abs(data.unit - 1 / 65781.76) < 1e-12, "Unit:1 means sp");
  assert.equal(data.xOffset, 0);
  assert.equal(data.yOffset, 0);
  assert.ok(data.covers(project.chapter));
  assert.ok(!data.covers(path.join(dir, "nope.tex")));
  // a relative path and the ./ of pdflatex's own paths resolve to the same file
  assert.ok(data.covers(path.join(dir, "chapters", "..", "chapters", "one.tex")));
});

test("parse: gzip or plain, the newer of .synctex.gz and .synctex, relative inputs, '=' for the last v", { skip: SKIP_TEX }, async () => {
  const plain = path.join(dir, "plain");
  fs.mkdirSync(plain, { recursive: true });
  const text = zlib.gunzipSync(fs.readFileSync(project.synctex)).toString("utf8");
  fs.writeFileSync(path.join(plain, "doc.pdf"), "%PDF-1.4\n");
  assert.equal(synctexFileFor(path.join(plain, "doc.pdf")), null);
  assert.equal(await loadSynctex(path.join(plain, "doc.pdf")), null);
  fs.writeFileSync(path.join(plain, "doc.synctex.gz"), zlib.gzipSync(text));
  const old = Date.now() / 1000 - 60;
  fs.utimesSync(path.join(plain, "doc.synctex.gz"), old, old);
  fs.writeFileSync(path.join(plain, "doc.synctex"), text);
  assert.equal(synctexFileFor(path.join(plain, "doc.pdf"))?.file, path.join(plain, "doc.synctex"));
  const loaded = await loadSynctex(path.join(plain, "doc.pdf"));
  assert.deepEqual(loaded?.data.pages, [1, 2]);

  const small = parseSynctex([
    "SyncTeX Version:1", "Input:1:./a.tex", "Output:pdf", "Magnification:2000", "Unit:1", "X Offset:0", "Y Offset:0",
    "Content:", "{1", "[1,1:0,1000000:2000000,800000,0", "(1,3:100000,500000:1000000,100000,20000",
    "x1,3:300000,=", "k1,3:400000,=:100000", "x1,4:700000,=", ")", "]", "}1", "Postamble:", "Count:3", "Post scriptum:", "",
  ].join("\n"), { dir: plain });
  assert.equal(small.fileOf(1), path.join(plain, "a.tex"));
  assert.ok(Math.abs(small.unit - 2 / 65781.76) < 1e-12, "magnification 2000 doubles the unit");
  // v of the "=" records is the hbox's 500000. Between the kern (line 3, after the
  // heading boundary took its line) and the boundary of line 4: SyncTeX reports both,
  // the smaller line first (`results`, as the CLI); the text under the point ends at the
  // boundary, so the primary result is 4, where `synctex edit` would print 3 first.
  const hit = small.edit(1, 650000 * small.unit, 480000 * small.unit);
  assert.deepEqual(hit?.results.map((r) => r.line), [3, 4]);
  assert.deepEqual([hit?.file, hit?.line], [path.join(plain, "a.tex"), 4]);
  assert.equal(small.textAt(1, 650000 * small.unit, 480000 * small.unit)?.line, 4);
  assert.equal(small.textAt(1, 250000 * small.unit, 480000 * small.unit)?.line, 3, "a heading boundary takes the next node's line");
});

// ---- reverse search --------------------------------------------------------------------

test("reverse: same file and line as `synctex edit` on points over the text", { skip: SKIP_ORACLE }, () => {
  const pts = textPoints();
  let same = 0;
  /** @type {string[]} */
  const diffs = [];
  for (const [page, x, y] of pts) {
    const want = cliEdit(page, x, y)[0];
    const got = data.edit(page, x, y)?.results[0];
    if (want && got && want.file === got.file && want.line === got.line) same++;
    else if (!want && !got) same++;
    else diffs.push(`p${page} (${x.toFixed(1)}, ${y.toFixed(1)}): cli ${want ? `${path.basename(want.file)}:${want.line}` : "none"}, ours ${got ? `${path.basename(got.file)}:${got.line}` : "none"}`);
  }
  console.log(`# reverse oracle, text points: ${same}/${pts.length} agree`);
  assert.ok(pts.length > 300, `${pts.length} points`);
  assert.deepEqual(diffs, []);
});

test("reverse: same file and line as `synctex edit` on a grid over whole pages (margins, gaps)", { skip: SKIP_ORACLE }, () => {
  let n = 0;
  /** @type {string[]} */
  const diffs = [];
  for (const page of data.pages) {
    for (let x = 20; x < 595; x += 37) {
      for (let y = 20; y < 842; y += 23) {
        n++;
        const want = cliEdit(page, x, y)[0];
        const got = data.edit(page, x, y)?.results[0];
        if ((!want && !got) || (want && got && want.file === got.file && want.line === got.line)) continue;
        diffs.push(`p${page} (${x}, ${y}): cli ${want ? `${path.basename(want.file)}:${want.line}` : "none"}, ours ${got ? `${path.basename(got.file)}:${got.line}` : "none"}`);
      }
    }
  }
  console.log(`# reverse oracle, page grid: ${n - diffs.length}/${n} agree`);
  assert.deepEqual(diffs, []);
});

test("reverse: every result the CLI prints, in its order", { skip: SKIP_ORACLE }, () => {
  const pts = textPoints().filter((_, i) => i % 3 === 0);
  /** @type {string[]} */
  const diffs = [];
  for (const [page, x, y] of pts) {
    const want = cliEdit(page, x, y).map((r) => `${path.basename(r.file)}:${r.line}`);
    const got = (data.edit(page, x, y)?.results || []).map((r) => `${path.basename(r.file)}:${r.line}`);
    if (JSON.stringify(want) !== JSON.stringify(got)) diffs.push(`p${page} (${x.toFixed(1)}, ${y.toFixed(1)}): cli ${want}, ours ${got}`);
  }
  console.log(`# reverse oracle, all results: ${pts.length - diffs.length}/${pts.length} agree`);
  assert.deepEqual(diffs, []);
});

test("reverse: the underline lies on the printed line under the point", { skip: SKIP_TEX }, () => {
  for (const [page, x, y] of textPoints().filter((_, i) => i % 5 === 0)) {
    const hit = data.edit(page, x, y);
    if (!hit) continue;
    assert.ok(hit.rects.length >= 1);
    for (const [l, t, r, b] of hit.rects) assert.ok(l < r && t < b, JSON.stringify(hit.rects));
    assert.ok(hit.rects.some(([, t, , b]) => t - 1 <= y && y <= b + 1), `rects ${JSON.stringify(hit.rects)} cover y ${y}`);
  }
});

test("reverse: a point on the input file's text maps to that file", { skip: SKIP_TEX }, () => {
  const v = data.view(project.chapter, 2);
  assert.ok(v);
  const [l, t, r, b] = v.rects[0];
  const hit = data.edit(v.page, (l + r) / 2, (t + b) / 2);
  assert.deepEqual([hit?.file, hit?.line], [project.chapter, 2]);
  assert.equal(data.edit(99, 100, 100), null, "no such page");
});

test("reverse, forward: every word of a paragraph over several source lines maps to its own line", { skip: SKIP_WORDS }, async () => {
  // pdfTeX tags the boundary that ends a source line's first word with the line before;
  // the parser takes the following node's line, so hover, click, selection and the flash
  // of a forward search all put that word on its own line.
  const lines = [
    "alpha bravo charlie delta",
    "echo foxtrot golf hotel",
    "india juliett kilo lima",
    "mike november oscar papa",
    "quebec romeo sierra tango",
  ];
  const first = 3; // the source line of lines[0]
  const sub = path.join(dir, "words");
  compile(sub, { "main.tex": ["\\documentclass{article}", "\\begin{document}", ...lines, "\\end{document}", ""].join("\n") });
  const main = path.join(sub, "main.tex");
  const loaded = await loadSynctex(path.join(sub, "main.pdf"));
  assert.ok(loaded);
  const d = loaded.data;
  const words = wordBoxes(path.join(sub, "main.pdf")).filter((w) => /^[a-z]+$/.test(w.word)); // not the page number
  assert.equal(words.length, 20);
  /** @param {number[]} r @param {number[]} w */
  const covers = (r, w) => r[0] <= w[0] + 0.5 && r[2] >= w[2] - 0.5 && r[1] <= (w[1] + w[3]) / 2 && (w[1] + w[3]) / 2 <= r[3];
  const wrapped = new Set(words.map((w) => Math.round(w.box[1]))).size > 1;
  assert.ok(wrapped, "the paragraph wraps");
  for (const { page, word, box } of words) {
    const line = first + lines.findIndex((l) => l.split(" ").includes(word));
    const [x0, y0, x1, y1] = box;
    for (const x of [(x0 + x1) / 2, x0 + 0.5, x1 - 0.5]) {
      const y = y0 + 0.7 * (y1 - y0);
      const hit = d.edit(page, x, y);
      assert.deepEqual([hit?.file, hit?.line], [main, line], `edit on "${word}" at x ${x.toFixed(1)}`);
      assert.equal(d.textAt(page, x, y)?.line, line, `textAt on "${word}"`);
      if (lines[line - first].startsWith(word)) assert.ok(hit?.rects.some((r) => covers(r, box)), `the underline ${JSON.stringify(hit?.rects)} covers "${word}" ${JSON.stringify(box)}`);
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const v = d.view(main, first + i);
    assert.ok(v);
    const own = /** @type {(typeof words)[0]} */ (words.find((w) => w.word === lines[i].split(" ")[0]));
    assert.ok(v.rects.some((r) => covers(r, own.box)), `the flash of line ${first + i} covers "${own.word}"`);
    const next = words.find((w) => i + 1 < lines.length && w.word === lines[i + 1].split(" ")[0]);
    if (next) {
      const [x0, y0, x1, y1] = next.box;
      const inner = [x0 + 1, y0 + 1, x1 - 1, y1 - 1];
      assert.ok(!v.rects.some((r) => overlaps(r, inner, 0)), `the flash of line ${first + i} leaves out "${next.word}"`);
    }
  }
});

// ---- forward search --------------------------------------------------------------------

test("forward: same page as `synctex view`, and boxes that overlap its boxes, for every line", { skip: SKIP_ORACLE }, () => {
  let n = 0;
  /** @type {string[]} */
  const diffs = [];
  for (const file of [project.main, project.chapter]) {
    const count = fs.readFileSync(file, "utf8").split("\n").length;
    for (let line = 1; line <= count; line++) {
      n++;
      const want = cliView(file, line);
      const got = data.view(file, line);
      const tag = `${path.basename(file)}:${line}`;
      if (!want.length) {
        if (got) diffs.push(`${tag}: cli none, ours page ${got.page}`);
        continue;
      }
      if (!got) {
        diffs.push(`${tag}: cli page ${want[0].page}, ours none`);
        continue;
      }
      if (got.page !== want[0].page) {
        diffs.push(`${tag}: cli page ${want[0].page}, ours ${got.page}`);
        continue;
      }
      const theirs = want.filter((w) => w.page === got.page).map((w) => w.box);
      for (const r of got.rects) {
        if (!theirs.some((b) => overlaps(r, b))) diffs.push(`${tag}: our rect ${JSON.stringify(r)} overlaps none of ${JSON.stringify(theirs)}`);
      }
      for (const b of theirs) {
        if (!got.boxes.some((r) => overlaps(r, b))) diffs.push(`${tag}: their box ${JSON.stringify(b)} is not among ours`);
      }
    }
  }
  console.log(`# forward oracle: ${n - diffs.length}/${n} lines agree`);
  assert.deepEqual(diffs, []);
});

test("forward: specific lines land where the text is (wrapped paragraph, \\input, display math, two columns, page 2)", { skip: SKIP_TEX }, () => {
  const wrapped = data.view(project.main, 8);
  assert.equal(wrapped?.page, 1);
  const eq = data.view(project.main, 15);
  assert.equal(eq?.page, 1);
  const chapter = data.view(project.chapter, 3);
  assert.equal(chapter?.page, 1);
  const right = data.view(project.main, 28);
  const left = data.view(project.main, 24);
  assert.ok(right && left && right.rects[0][0] > left.rects[0][2] - 1, "the right column is right of the left one");
  assert.equal(data.view(project.main, 34)?.page, 2);
  assert.equal(data.view(path.join(dir, "missing.tex"), 3), null);
  // a line without records (a blank line) takes the nearest one that has some
  assert.ok(data.view(project.main, 11));
});

// ---- selections ------------------------------------------------------------------------

test("selection: rects map to {file, lines} per file in document order", { skip: SKIP_TEX }, () => {
  const a = /** @type {NonNullable<ReturnType<typeof data.view>>} */ (data.view(project.main, 7));
  const b = /** @type {NonNullable<ReturnType<typeof data.view>>} */ (data.view(project.main, 9));
  const c = /** @type {NonNullable<ReturnType<typeof data.view>>} */ (data.view(project.chapter, 2));
  const d = /** @type {NonNullable<ReturnType<typeof data.view>>} */ (data.view(project.chapter, 3));
  assert.ok(a && b && c && d);
  const shrink = (/** @type {number[]} */ r) => [r[0] + 1, r[1] + 1, r[2] - 1, r[3] - 1];
  const parts = [
    { page: a.page, rects: [...a.rects, ...b.rects].map(shrink) },
    { page: c.page, rects: [...c.rects, ...d.rects].map(shrink) },
  ];
  assert.deepEqual(data.sourceOfSelection(parts), [
    { file: project.main, lines: [7, 9] },
    { file: project.chapter, lines: [2, 3] },
  ]);
  assert.deepEqual(data.sourceOfSelection([]), []);
  assert.deepEqual(data.sourceOfSelection([{ page: 1, rects: [[1, 2, "x", 4]] }, /** @type {any} */ (null)]), []);
});

test("selection: a selection of the first words of a source line does not pull in the line before", { skip: SKIP_TEX }, () => {
  const v = /** @type {NonNullable<ReturnType<typeof data.view>>} */ (data.view(project.main, 8));
  // the stretch of line 8 that starts a printed line, or the first one
  const [l, t, r, b] = v.rects[0];
  const right = Math.min(r, l + 30);
  const src = data.sourceOfSelection([{ page: v.page, rects: [[l + 1, t + 1, right, b - 1]] }]);
  assert.deepEqual(src, [{ file: project.main, lines: [8, 8] }]);
});

// ---- word level (media/wordmatch.mjs) -----------------------------------------------------

test("word level: an inverse search from each word of page 2 lands on that word in the source, also a repeated one and one in a caption", { skip: SKIP_WORDS }, async () => {
  const { pdfTokens, anchorOf, findInSource, texTokens } = await import("../media/wordmatch.mjs");
  const lines = fs.readFileSync(project.main, "utf8").split("\n");
  const words = wordBoxes(project.pdf).filter((w) => w.page === 2);
  // the page's text as the text layer has it: words in reading order, printed lines on lines
  let text = "";
  const at = words.map((w, i) => {
    if (i) text += Math.abs(w.box[1] - words[i - 1].box[1]) > 2 ? "\n" : " ";
    const start = text.length;
    text += w.word;
    return start;
  });
  const toks = pdfTokens(text);
  let checked = 0;
  /** @type {Map<string, {line: number, column: number}>} */
  const got = new Map();
  words.forEach((w, i) => {
    const ti = toks.findIndex((t) => t.start <= at[i] && at[i] < t.end);
    if (ti < 0 || !/^[A-Za-z]+[.,:]?$/.test(w.word)) return;
    const [x0, y0, x1, y1] = w.box;
    const hit = data.edit(2, (x0 + x1) / 2, y0 + 0.7 * (y1 - y0));
    assert.ok(hit && hit.file === project.main, `edit on "${w.word}"`);
    const r = findInSource(lines, hit.line, anchorOf(toks, ti));
    if (w.word === "Figure") return; // LaTeX's own word: may match "figure" nearby, or nothing
    assert.ok(r, `"${w.word}" (SyncTeX line ${hit.line}) found in the source`);
    const there = texTokens(lines[r.line - 1]).find((t) => t.start === r.column);
    assert.equal(there?.norm, toks[ti].norm, `"${w.word}" -> ${r.line}:${r.column}`);
    got.set(`${w.word}#${[...got.keys()].filter((k) => k.startsWith(`${w.word}#`)).length}`, r);
    checked++;
  });
  assert.ok(checked > 50, `checked ${checked} words`);
  const l36 = lines[35];
  assert.deepEqual(got.get("model#2"), { line: 36, column: l36.indexOf("model checker"), end: l36.indexOf("model checker") + 5 });
  assert.equal(got.get("zeppelin#0")?.line, 41, "caption text carries line 42 in SyncTeX");
  assert.equal(got.get("several#0")?.line, 40);
  assert.equal(got.get("efficient#0")?.column, l36.indexOf("efficient"));
});

// ---- hand-written SyncTeX files (no TeX needed) ---------------------------------------

/**
 * A one-page SyncTeX file whose only text line (an hbox with two glyphs and a kern) comes
 * from `line` of a.tex, with preamble lines `pre`, content lines `body` and post scriptum
 * lines `post`.
 * @param {{pre?: string[], body?: string[], post?: string[], line?: number}} [o]
 */
function synctexText({ pre = ["Magnification:1000", "Unit:1", "X Offset:0", "Y Offset:0"], body, post = [], line = 3 } = {}) {
  const content = body || ["{1", "[1,1:0,1000000:20000000,900000,0", `(1,${line}:4736286,6000000:10000000,500000,100000`,
    `x1,${line}:6000000,6000000`, `k1,${line}:6300000,6000000:300000`, `x1,${line}:9000000,6000000`, ")", "]", "}1"];
  return ["SyncTeX Version:1", "Input:1:./a.tex", "Output:pdf", ...pre, "Content:", ...content,
    "Postamble:", "Count:5", "Post scriptum:", ...post, ""].join("\n");
}

test("parse: the post scriptum's Magnification (a factor) and X/Y Offset (with TeX units) scale and move every box", () => {
  const plain = parseSynctex(synctexText(), { dir: "/proj" });
  const hit = plain.edit(1, 120, 90);
  assert.equal(hit?.line, 3);
  const [l, t, r, b] = /** @type {any} */ (hit).rects[0];
  const moved = parseSynctex(synctexText({ post: ["Magnification:2", "X Offset:1in", "Y Offset:12.7mm"] }), { dir: "/proj" });
  assert.ok(Math.abs(moved.xOffset - 72) < 1e-9 && Math.abs(moved.yOffset - 36) < 1e-9, `${moved.xOffset} ${moved.yOffset}`);
  assert.ok(Math.abs(moved.unit - 2 * plain.unit) < 1e-15);
  const got = moved.edit(1, 2 * 120 + 72, 2 * 90 + 36);
  assert.equal(got?.line, 3);
  const want = [2 * l + 72, 2 * t + 36, 2 * r + 72, 2 * b + 36];
  /** @type {any} */ (got).rects[0].forEach((/** @type {number} */ x, /** @type {number} */ k) => assert.ok(Math.abs(x - want[k]) < 0.01, `${got?.rects[0]} vs ${want}`));
  for (const [dim, bp] of /** @type {[string, number][]} */ ([["72.27pt", 72], ["72bp", 72], ["2.54cm", 72], ["6pc", 72 * 72 / 72.27], ["65536sp", 72 / 72.27], ["100", 100 / 65781.76]])) {
    const d = parseSynctex(synctexText({ post: [`X Offset:${dim}`] }), { dir: "/proj" });
    assert.ok(Math.abs(d.xOffset - bp) < 1e-6, `${dim}: ${d.xOffset} != ${bp}`);
  }
});

test("parse: defaults for a missing or zero Unit and Magnification (8192 sp, 1000) and a 1in origin; an unreadable offset keeps the preamble's", () => {
  const d = parseSynctex(synctexText({ pre: ["Unit:0", "Magnification:0"], post: ["X Offset:junk", "Y Offset:"] }), { dir: "/proj" });
  assert.ok(Math.abs(d.unit - 8192 / 65781.76) < 1e-12);
  assert.ok(Math.abs(d.xOffset - 578 * 8192 / 65781.76) < 1e-9 && Math.abs(d.yOffset - d.xOffset) < 1e-9, `${d.xOffset} ${d.yOffset}`);
  const mag = parseSynctex(synctexText({ pre: ["Unit:1", "Magnification:2000", "X Offset:0", "Y Offset:0"] }), { dir: "/proj" });
  assert.ok(Math.abs(mag.unit - 2 / 65781.76) < 1e-15);
});

test("parse: junk is skipped (malformed records, closers without an opener, unknown records, forms, a page never closed), the rest still maps", () => {
  const body = [
    "this line means nothing",
    "x1,9:1,1", // a record before any page
    "{1",
    "]", ")", // closers with nothing open
    "[1,1:0,1000000:20000000,900000,0",
    "(garbage",
    "(1,3:4736286,6000000:10000000,500000,100000",
    "x1,3:6000000,6000000",
    "xbad", "k1,3", "g1,x:1,2", "$1,3", "r:1,1", "v1:1", "hjunk",
    "!12345", "%comment", "?unknown",
    "<1", "x1,77:6000000,6000000", "<2", ">", ">", // a form, skipped (nested too)
    "k1,3:6300000,6000000:300000",
    "x1,3:9000000,=",
    ")",
    "]",
    "}1",
    "{2", "[1,40:0,1000000:20000000,900000,0", // page 2 is never closed
  ];
  const d = parseSynctex(synctexText({ body }), { dir: "/proj" });
  assert.deepEqual(d.pages, [1]);
  assert.equal(d.edit(1, 120, 90)?.line, 3);
  assert.notEqual(d.maxLine.get(1), 77, "nothing from the form");
  assert.equal(d.view("/proj/a.tex", 3)?.page, 1);
  assert.equal(d.view("/proj/a.tex", 77)?.line, 3, "line 77 (only in the form) is unknown: the closest line is shown");
});

test("parse: inputs listed after the content are read too; bad Input lines are skipped", () => {
  const text = synctexText({ post: ["Input:2:/abs/b.tex", "Input:x:/abs/c.tex", "Input:3:", "Input:nocolon"] });
  const d = parseSynctex(text, { dir: "/proj" });
  assert.deepEqual(d.files, ["/proj/a.tex", "/abs/b.tex"]);
  assert.equal(d.fileOf(9), "");
  assert.equal(d.covers("/abs/b.tex"), false, "listed but without records");
  assert.equal(d.covers("/proj/a.tex"), true);
});

test("tagsOf: a source named through a symlink finds its tags", () => {
  const d0 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vpdf-stxlink-")));
  try {
    fs.mkdirSync(path.join(d0, "real"));
    fs.writeFileSync(path.join(d0, "real", "a.tex"), "x\n");
    fs.symlinkSync(path.join(d0, "real"), path.join(d0, "link"));
    const d = parseSynctex(synctexText(), { dir: path.join(d0, "real") });
    assert.deepEqual(d.tagsOf(path.join(d0, "real", "a.tex")), [1]);
    assert.deepEqual(d.tagsOf(path.join(d0, "link", "a.tex")), [1]);
    assert.deepEqual(d.tagsOf(path.join(d0, "link", "b.tex")), []);
    assert.equal(d.covers(path.join(d0, "link", "a.tex")), true);
  } finally {
    fs.rmSync(d0, { recursive: true, force: true });
  }
});

test("reverse: a point outside every hbox underlines a band of the vbox one line high, inside it, also from a margin above or below", () => {
  const body = ["{1", "[1,5:0,1000000:20000000,900000,0", "h1,6:1000000,300000:5000000,200000,0", "]", "}1", "{3", "}3"];
  const d = parseSynctex(synctexText({ body }), { dir: "/proj" });
  const [, boxTop, , boxBottom] = d.rect(0, 1000000 - 900000, 20000000, 1000000);
  for (const y of [8, 2, 100, -50]) {
    const hit = d.edit(1, 200, y);
    assert.equal(hit?.line, 5, `y=${y}`);
    const [[l, t, r, b]] = /** @type {any} */ (hit).rects;
    assert.ok(l < r && t < b, `y=${y}: ${hit?.rects}`);
    assert.ok(t >= boxTop - 1e-6 && b <= boxBottom + 1e-6, `y=${y}: [${t}, ${b}] inside [${boxTop}, ${boxBottom}]`);
    assert.ok(b - t <= 12 + 1e-6);
  }
  assert.equal(d.edit(2, 1, 1), null, "no such page");
  assert.equal(d.edit(3, 1, 1), null, "an empty page");
  assert.equal(d.textAt(2, 1, 1), null);
});
