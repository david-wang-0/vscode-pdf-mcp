// @ts-check
/** media/marking.mjs and media/keys.mjs: palette, geometry, ownership, threads, shortcuts. */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const marking = () => import("../media/marking.mjs");
const keys = () => import("../media/keys.mjs");

test("palette: the values of pdf-reader-writer-mcp's COLORS, and their hex", async () => {
  const { PALETTE, hex } = await marking();
  // pdf_reader_writer_mcp/pdf.py COLORS, in order (gray is an alias of grey there)
  const COLORS = {
    blue: [0.6, 0.8, 1.0], yellow: [1.0, 0.9, 0.3], green: [0.6, 0.9, 0.6], orange: [1.0, 0.7, 0.4],
    pink: [1.0, 0.7, 0.85], purple: [0.8, 0.7, 1.0], red: [0.9, 0.3, 0.3], cyan: [0.55, 0.95, 0.95],
    grey: [0.75, 0.75, 0.75],
  };
  assert.deepEqual(Object.fromEntries(PALETTE.map((p) => [p.name, p.rgb])), COLORS);
  assert.deepEqual(PALETTE.map((p) => hex(p.rgb)),
    ["#99ccff", "#ffe64d", "#99e699", "#ffb366", "#ffb3d9", "#ccb3ff", "#e64d4d", "#8cf2f2", "#bfbfbf"]);
});

test("palette: a colour read back from a PDF is named when it is a palette colour", async () => {
  const { paletteName, serviceColor } = await marking();
  assert.equal(paletteName([1, 0.9, 0.3]), "yellow");
  assert.equal(paletteName([255 / 255, 230 / 255, 77 / 255]), "yellow", "8-bit rounding (pdf.js) still matches");
  assert.equal(paletteName([0.2, 0.45, 1]), null);
  assert.equal(paletteName(null), null);
  assert.equal(serviceColor("green"), "green");
  assert.equal(serviceColor([0.2, 0.45, 1]), "0.2,0.45,1");
});

/** A pdf.js-like viewport: US letter at `scale`, unrotated (y grows downwards on screen). */
const viewport = (scale = 2, height = 792) => ({
  convertToPdfPoint: (/** @type {number} */ x, /** @type {number} */ y) => [x / scale, height - y / scale],
  convertToViewportPoint: (/** @type {number} */ x, /** @type {number} */ y) => [x * scale, (height - y) * scale],
});

test("geometry: client rects become normalised PDF rects relative to the page origin", async () => {
  const { clientRectsToPdf, clientPointToPdf, pdfRectToClient } = await marking();
  const origin = { left: 10, top: 50 };
  const rects = [
    { left: 154, top: 250, right: 610, bottom: 278 }, // one line
    { left: 160, top: 255, right: 200, bottom: 270 }, // inside it: dropped
    { left: 154, top: 278, right: 154, bottom: 306 }, // empty: dropped
    { left: 154, top: 278, right: 400, bottom: 306 }, // next line
  ];
  const pdf = clientRectsToPdf(rects, origin, viewport());
  assert.deepEqual(pdf, [[72, 678, 300, 692], [72, 664, 195, 678]]);
  for (const [x0, y0, x1, y1] of pdf) assert.ok(x0 < x1 && y0 < y1);
  assert.deepEqual(clientPointToPdf(90, 150, origin, viewport()), [40, 742]);
  assert.deepEqual(pdfRectToClient([72, 678, 300, 692], origin, viewport()), { left: 154, top: 250, right: 610, bottom: 278 });
});

test("geometry: identical rects keep one copy", async () => {
  const { dedupeRects } = await marking();
  const r = { left: 1, top: 1, right: 5, bottom: 5 };
  assert.equal(dedupeRects([r, { ...r }, { ...r }]).length, 1);
});

test("geometry: hit-testing uses quads for markup and the rect otherwise; the smallest wins", async () => {
  const { hitTest, splitQuads, quadRect } = await marking();
  const ann = (/** @type {string} */ id, /** @type {number[]} */ rect, /** @type {number[][]} */ quads) =>
    ({ id, xref: Number(id), page: 1, subtype: quads.length ? "Highlight" : "Text", rect, quads, color: null, note: "", author: "", modified: "", created: "", irt: null });
  const two = splitQuads([72, 704, 300, 704, 72, 690, 300, 690, 72, 690, 200, 690, 72, 676, 200, 676]);
  assert.deepEqual(two.map(quadRect), [[72, 690, 300, 704], [72, 676, 200, 690]]);
  const hl = ann("8", [60, 670, 310, 710], two);
  const icon = ann("9", [280, 685, 296, 701], []);
  assert.equal(hitTest([hl, icon], [100, 695])?.id, "8");
  assert.equal(hitTest([hl, icon], [250, 680]), null, "inside the rect but on no quad");
  assert.equal(hitTest([hl, icon], [290, 695])?.id, "9", "the icon over the highlight");
});

test("ownership: own means /T equals the configured author", async () => {
  const { isOwn, xrefOf } = await marking();
  assert.equal(isOwn({ author: "david", xref: 5 }, "david"), true);
  assert.equal(isOwn({ author: "llm", xref: 5 }, "david"), false);
  assert.equal(isOwn({ author: "david", xref: null }, "david"), false, "inline annotations cannot be addressed");
  assert.equal(isOwn({ author: "", xref: 5 }, ""), false);
  assert.equal(xrefOf("12R"), 12);
  assert.equal(xrefOf("pdfjs_internal_id_3"), null);
});

test("threads: replies nest under their parent, ordered by date; cycles and orphans become roots", async () => {
  const { buildThreads, threadRoot } = await marking();
  const a = (/** @type {string} */ id, /** @type {string | null} */ irt, /** @type {string} */ created) =>
    ({ id, xref: Number(id.replace("R", "")), page: 1, subtype: "Text", rect: [0, 0, 1, 1], quads: [], color: null, note: id, author: "x", modified: created, created, irt });
  const list = [a("1R", null, "D:2026"), a("3R", "1R", "D:2027"), a("2R", "1R", "D:2026"), a("4R", "2R", "D:2028"),
    a("5R", "99R", "D:2026"), a("6R", "7R", "D:2026"), a("7R", "6R", "D:2026")];
  const roots = buildThreads(list);
  const shape = (/** @type {any} */ n) => [n.id, n.replies.map(shape)];
  const ids = roots.map(shape);
  assert.deepEqual(ids[0], ["1R", [["2R", [["4R", []]]], ["3R", []]]]);
  assert.ok(ids.some(([id]) => id === "5R"), "orphan reply is a root");
  assert.equal(roots.map((r) => r.id).filter((id) => id === "6R" || id === "7R").length >= 1, true, "a cycle does not vanish");
  const byId = new Map(list.map((x) => [x.id, x]));
  assert.equal(threadRoot(byId, "4R")?.id, "1R");
});

test("dates: PDF dates parse with their offset", async () => {
  const { parsePdfDate } = await marking();
  assert.equal(parsePdfDate("D:20261012192041+01'00'")?.toISOString(), "2026-10-12T18:20:41.000Z");
  assert.equal(parsePdfDate("D:20261012192041Z")?.toISOString(), "2026-10-12T19:20:41.000Z");
  assert.equal(parsePdfDate("nonsense"), null);
});

test("keys: parse, match and merge user bindings over the defaults", async () => {
  const { parseKey, matches, keymap, DEFAULT_KEYS } = await keys();
  assert.deepEqual(parseKey("ctrl+z"), { key: "z", ctrl: true, shift: false, alt: false, meta: false });
  assert.deepEqual(parseKey("Shift+H"), { key: "h", ctrl: false, shift: true, alt: false, meta: false });
  assert.equal(parseKey("hyper+h"), null);
  const ev = (/** @type {string} */ key, mods = {}) => ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });
  assert.ok(matches(/** @type {any} */ (parseKey("ctrl+z")), ev("z", { ctrlKey: true })));
  assert.ok(matches(/** @type {any} */ (parseKey("ctrl+z")), ev("z", { metaKey: true })), "Cmd+Z too");
  assert.ok(!matches(/** @type {any} */ (parseKey("ctrl+z")), ev("z")));
  assert.ok(!matches(/** @type {any} */ (parseKey("h")), ev("H", { shiftKey: true })), "Shift+H is not H");
  const map = keymap({ highlight: "shift+h", undo: "nonsense+q", bogus: "b" });
  assert.deepEqual(map.highlight, parseKey("shift+h"));
  assert.deepEqual(map.undo, parseKey(DEFAULT_KEYS.undo), "a bad spec falls back to the default");
  assert.equal(map.bogus, undefined);
});

test("keys: shortcuts never fire from a text field; Escape always does", async () => {
  const { actionFor, keymap, isTextField } = await keys();
  const map = keymap({});
  const ev = (/** @type {string} */ key, target = {}, mods = {}) => ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, target, ...mods });
  assert.equal(actionFor(ev("h", { tagName: "DIV" }), map), "highlight");
  assert.equal(actionFor(ev("u"), map), "underline");
  assert.equal(actionFor(ev("s"), map), "squiggly");
  assert.equal(actionFor(ev("x"), map), "strikeout");
  assert.equal(actionFor(ev("n"), map), "note");
  assert.equal(actionFor(ev("z", {}, { ctrlKey: true }), map), "undo");
  assert.equal(actionFor(ev("q"), map), null);
  for (const target of [{ tagName: "TEXTAREA" }, { tagName: "INPUT", type: "text" }, { tagName: "SPAN", isContentEditable: true }]) {
    assert.ok(isTextField(target));
    assert.equal(actionFor(ev("h", target), map), null);
    assert.equal(actionFor(ev("z", target, { ctrlKey: true }), map), null, "Ctrl+Z in a text field is the field's undo");
    assert.equal(actionFor(ev("Escape", target), map), "escape");
  }
  assert.equal(isTextField({ tagName: "INPUT", type: "checkbox" }), false);
});
