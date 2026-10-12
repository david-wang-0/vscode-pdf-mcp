// @ts-check
/** extension/marks.js: requests, ownership and the undo stack, against the fake edit service. */
"use strict";

const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EditService } = require("../extension/editservice");
const { MarkController, UndoStack, inverseOps, descendants } = require("../extension/marks");
const { samplePdf } = require("./helpers/pdf");

const FAKE = path.join(__dirname, "helpers", "fake-edit-service.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vpdf-marks-"));
const service = new EditService({ command: process.execPath, args: [FAKE] });
after(() => {
  service.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
/** @type {string} */
let pdf;
/** @type {string[]} */
let written;
/** @type {MarkController} */
let c;
beforeEach(() => {
  pdf = path.join(tmp, `doc${++n}.pdf`);
  fs.writeFileSync(pdf, samplePdf(3));
  written = [];
  c = new MarkController({ request: (op, f) => service.request(op, f), author: () => "david", onWritten: (p) => written.push(p) });
});

const list = () => service.request("list", { path: pdf });
/** @param {number} [page] */
const sel = (page = 1) => ({ parts: [{ page, rects: [[72, 690, 300, 704]], text: "Reachability" }], style: "highlight", color: "yellow" });

test("marks: mark sends path, page, rects, text, style, colour, note and author", async () => {
  const r = await c.mark(pdf, { ...sel(), note: "why?" });
  const [a] = await list();
  assert.deepEqual([a.xref, a.page, a.type, a.author, a.note, a.text, a.color], [r.xref, 1, "Highlight", "david", "why?", "Reachability", [1, 0.9, 0.3]]);
  assert.deepEqual(a.quads, [[72, 704, 300, 704, 72, 690, 300, 690]]);
  assert.deepEqual(written, [pdf]);
});

test("marks: a selection over two pages is one undo step", async () => {
  await c.mark(pdf, { parts: [{ page: 1, rects: [[72, 100, 200, 112]] }, { page: 2, rects: [[72, 700, 200, 712]] }], style: "underline" });
  assert.equal((await list()).length, 2);
  assert.equal(c.stack(pdf).size, 1);
  assert.deepEqual(await c.undo(pdf), { label: "underline" });
  assert.deepEqual(await list(), []);
});

test("marks: bad requests from the webview are refused before the service", async () => {
  assert.throws(() => c.mark(pdf, { parts: [] }), /nothing selected/);
  assert.throws(() => c.mark(pdf, { parts: [{ page: 1, rects: [[1, 2, 3]] }] }), /a rect must be 4 numbers/);
  assert.throws(() => c.mark(pdf, { ...sel(), style: "bold" }), /style must be one of/);
  assert.throws(() => c.note(pdf, { page: 0, point: [1, 2], note: "x" }), /page must be a positive integer/);
  assert.throws(() => c.update(pdf, { xref: 5 }), /nothing to change/);
  assert.equal(written.length, 0);
});

test("marks: undo of mark, note and reply deletes them, newest first", async () => {
  const m = await c.mark(pdf, sel());
  const nt = await c.note(pdf, { page: 2, point: [40, 700], note: "margin", color: "green" });
  const rp = await c.reply(pdf, { xref: m.xref, note: "answer" });
  assert.deepEqual((await list()).map((/** @type {any} */ a) => a.xref), [m.xref, nt.xref, rp.xref]);
  assert.deepEqual(await c.undo(pdf), { label: "reply" });
  assert.deepEqual((await list()).map((/** @type {any} */ a) => a.xref), [m.xref, nt.xref]);
  assert.deepEqual(await c.undo(pdf), { label: "note" });
  assert.deepEqual(await c.undo(pdf), { label: "highlight" });
  assert.deepEqual(await list(), []);
  assert.equal(await c.undo(pdf), null, "nothing left to undo");
});

test("marks: undo of an edit restores the previous note and the exact previous colour", async () => {
  const m = await c.mark(pdf, { ...sel(), color: "#123456", note: "first" });
  await c.update(pdf, { xref: m.xref, note: "second" });
  await c.update(pdf, { xref: m.xref, color: "red" });
  let [a] = await list();
  assert.deepEqual([a.note, a.color], ["second", [0.9, 0.3, 0.3]]);
  assert.deepEqual(await c.undo(pdf), { label: "colour change" });
  const snap = await service.request("snapshot", { path: pdf, xref: m.xref });
  assert.deepEqual(snap.color.map((/** @type {number} */ v) => Math.round(v * 255)), [0x12, 0x34, 0x56]);
  assert.deepEqual(await c.undo(pdf), { label: "edit" });
  [a] = await list();
  assert.equal(a.note, "first");
});

test("marks: a style change gets a new xref, and older entries follow it", async () => {
  const m = await c.mark(pdf, sel());
  const u = await c.update(pdf, { xref: m.xref, style: "squiggly" });
  assert.notEqual(u.xref, m.xref);
  let [a] = await list();
  assert.equal(a.type, "Squiggly");
  // the create entry below now names the new xref
  assert.deepEqual(/** @type {any} */ (c.stack(pdf).entries[0]).xrefs, [u.xref]);
  assert.deepEqual(await c.undo(pdf), { label: "style change" });
  [a] = await list();
  assert.equal(a.type, "Highlight");
  assert.deepEqual(await c.undo(pdf), { label: "highlight" });
  assert.deepEqual(await list(), []);
});

test("marks: delete -> undo restores the thread, and later undos use the restored xrefs", async () => {
  const m = await c.mark(pdf, { ...sel(), note: "one" });
  const r = await c.reply(pdf, { xref: m.xref, note: "my reply" });
  await c.update(pdf, { xref: m.xref, note: "two" });
  const d = await c.remove(pdf, { xref: m.xref });
  assert.deepEqual(d.snapshots.map((/** @type {any} */ s) => s.xref), [m.xref, r.xref]);
  assert.deepEqual(await list(), []);

  assert.deepEqual(await c.undo(pdf), { label: "delete" });
  const back = await list();
  assert.equal(back.length, 2);
  const [mark, reply] = back;
  assert.notEqual(mark.xref, m.xref);
  assert.equal(reply.irt, mark.xref, "the reply is in the restored thread");
  assert.equal(mark.note, "two");

  assert.deepEqual(await c.undo(pdf), { label: "edit" }); // on the restored xref
  assert.equal((await list())[0].note, "one");
  assert.deepEqual(await c.undo(pdf), { label: "reply" });
  assert.deepEqual(await c.undo(pdf), { label: "highlight" });
  assert.deepEqual(await list(), []);
});

test("marks: only own marks are edited or deleted", async () => {
  const theirs = await service.request("mark", { path: pdf, page: 1, rects: [[72, 690, 300, 704]], author: "llm" });
  await assert.rejects(c.update(pdf, { xref: theirs.xref, note: "mine now" }), { message: "not your annotation" });
  await assert.rejects(c.update(pdf, { xref: theirs.xref, style: "underline" }), { message: "not your annotation" });
  await assert.rejects(c.remove(pdf, { xref: theirs.xref }), { message: "not your annotation" });
  // but anyone's annotation can be replied to
  const r = await c.reply(pdf, { xref: theirs.xref, note: "I disagree" });
  const mine = (await list()).find((/** @type {any} */ a) => a.xref === r.xref);
  assert.deepEqual([mine.author, mine.irt], ["david", theirs.xref]);
  assert.equal(c.stack(pdf).size, 1);
});

test("marks: undoing a mark that someone else replied to is refused", async () => {
  const m = await c.mark(pdf, sel());
  await service.request("reply", { path: pdf, xref: m.xref, note: "llm says", author: "llm" });
  await assert.rejects(c.undo(pdf), { message: "cannot undo the highlight: llm replied to it" });
  assert.equal((await list()).length, 2, "nothing deleted");
  assert.equal(c.stack(pdf).size, 0, "the entry is dropped");
});

test("marks: an inverse the service refuses surfaces its error and drops the entry", async () => {
  c.stack(pdf).push({ kind: "delete", label: "delete", snapshots: [{ xref: 7, page: 1, subtype: "Square", rect: [1, 1, 9, 9] }] });
  await assert.rejects(c.undo(pdf), { message: "cannot undo the delete: cannot restore a Square annotation" });
  const m = await c.mark(pdf, sel());
  await service.request("delete", { path: pdf, xref: m.xref }); // gone behind our back
  await assert.rejects(c.undo(pdf), { message: `cannot undo the highlight: no annotation with xref ${m.xref}` });
  assert.equal(c.stack(pdf).size, 0);
});

test("marks: writes to one document run one at a time, in order", async () => {
  const all = await Promise.all([1, 2, 3, 1, 2].map((p) => c.mark(pdf, sel(p))));
  const xrefs = all.map((r) => r.xref);
  assert.deepEqual([...xrefs].sort((a, b) => a - b), xrefs, "in the order asked");
  assert.deepEqual(c.stack(pdf).entries.map((/** @type {any} */ e) => e.xrefs[0]), xrefs);
});

test("undo stack: inverse ops for each kind of entry", () => {
  assert.deepEqual(inverseOps({ kind: "create", label: "x", xrefs: [4, 5] }, "david"),
    [{ op: "delete", fields: { xref: 5, only_author: "david" } }, { op: "delete", fields: { xref: 4, only_author: "david" } }]);
  assert.deepEqual(inverseOps({ kind: "update", label: "x", xref: 9, prev: { note: "a", color: "1,0.9,0.3", style: "underline" } }, "david"),
    [{ op: "update", fields: { xref: 9, note: "a", color: "1,0.9,0.3", style: "underline", only_author: "david" } }]);
  const snaps = [{ xref: 3, irt: 0 }];
  assert.deepEqual(inverseOps({ kind: "delete", label: "x", snapshots: snaps }, "david"), [{ op: "restore", fields: { snapshots: snaps } }]);
});

test("undo stack: remap follows xrefs through create, update and snapshot IRTs", () => {
  const s = new UndoStack();
  s.push({ kind: "create", label: "a", xrefs: [10, 11] });
  s.push({ kind: "update", label: "b", xref: 10, prev: {} });
  s.push({ kind: "delete", label: "c", snapshots: [{ xref: 20, irt: 10 }, { xref: 21, irt: 20 }] });
  s.remap({ 10: 30, 20: 99 });
  assert.deepEqual(/** @type {any} */ (s.entries[0]).xrefs, [30, 11]);
  assert.equal(/** @type {any} */ (s.entries[1]).xref, 30);
  assert.deepEqual(/** @type {any} */ (s.entries[2]).snapshots, [{ xref: 20, irt: 30 }, { xref: 21, irt: 99 }]);
});

test("undo stack: bounded", () => {
  const s = new UndoStack(2);
  for (const x of [1, 2, 3]) s.push({ kind: "create", label: "", xrefs: [x] });
  assert.deepEqual(s.entries.map((/** @type {any} */ e) => e.xrefs[0]), [2, 3]);
});

test("undo stack: descendants walks the reply tree", () => {
  const l = [{ xref: 1, irt: 0 }, { xref: 2, irt: 1 }, { xref: 3, irt: 2 }, { xref: 4, irt: 0 }, { xref: 5, irt: 1 }];
  assert.deepEqual(descendants(l, 1).map((a) => a.xref), [2, 5, 3]);
});
