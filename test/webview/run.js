// @ts-check
/**
 * Webview check outside VS Code: serves media/ + pdf.js through scripts/serve-webview.js
 * (the real HTML and CSP, a mocked acquireVsCodeApi) and drives it in headless Chromium.
 *
 *   npm run test:webview
 *
 * Needs playwright-core (a devDependency) and a Chromium: set CHROMIUM to its executable,
 * else Playwright's own download is used (`node node_modules/playwright-core/cli.js install
 * chromium-headless-shell` fetches the one this playwright-core expects). The check of
 * PyMuPDF-written annotations (underline, Text note) and links needs a Python with pymupdf:
 * VPDF_PYTHON, else that of pdf-reader-writer-mcp's installed edit service
 * (test/helpers/prw.js); without one it is skipped.
 */
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { chromium } = require("playwright-core");
const { makePdf, samplePdf, sampleLines, threadPdf } = require("../helpers/pdf");
const { findPrw } = require("../helpers/prw");

const root = path.resolve(__dirname, "../..");
const python = findPrw().python;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vpdf-webview-"));
/** @type {import("node:child_process").ChildProcess[]} */
const servers = [];
/** @type {import("playwright-core").Browser} */
let browser;

/** @param {string} pdf @returns {Promise<string>} */
function serve(pdf) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "scripts/serve-webview.js"), pdf, "0"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    servers.push(child);
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", (line) => resolve(String(line).trim()));
    child.once("exit", (code) => reject(new Error(`harness exited ${code}`)));
  });
}

/** @param {string} url @param {() => void} [init] runs in the page before its own scripts */
async function open(url, init) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  /** @type {string[]} */
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  if (init) await page.addInitScript(init);
  await page.goto(url);
  await page.waitForFunction(() => /** @type {any} */ (window).__posted.some((/** @type {any} */ m) => m.type === "loaded"));
  await page.waitForSelector(".page[data-page-number='1'] .textLayer span");
  return { page, errors };
}

/**
 * Wait until the viewer has posted a message (after the first `from`) whose fields equal
 * those of `match`; a field given as `"*"` must just be truthy.
 * @param {import("playwright-core").Page} page @param {Record<string, unknown>} match
 * @param {number} [from]
 */
async function posted(page, match, from = 0) {
  const handle = await page.waitForFunction(
    ([want, start]) => /** @type {any} */ (window).__posted.slice(start).find((/** @type {any} */ m) =>
      Object.entries(want).every(([k, v]) => (v === "*" ? !!m[k] : JSON.stringify(m[k]) === JSON.stringify(v)))) || null,
    /** @type {[Record<string, unknown>, number]} */ ([match, from]), { timeout: 10000 });
  return handle.jsonValue();
}

/** @param {import("playwright-core").Page} page */
const count = (page) => page.evaluate(() => /** @type {any} */ (window).__posted.length);

before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM || undefined });
});

after(async () => {
  await browser?.close();
  for (const s of servers) s.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("webview renders, selects, follows goto, reloads in place and finds", async () => {
  const pdf = path.join(tmp, "sample.pdf");
  fs.writeFileSync(pdf, samplePdf(5));
  const { page, errors } = await open(await serve(pdf));

  const loaded = await posted(page, { type: "loaded" });
  assert.deepEqual(loaded, { type: "loaded", pages: 5, page: 1, reload: false });
  assert.equal(await page.locator(".page").count(), 5);
  assert.equal(await page.inputValue("#pageNumber"), "1");
  assert.equal(await page.textContent("#numPages"), "/ 5");

  // goto from the extension
  let mark = await count(page);
  await page.evaluate(() => /** @type {any} */ (window).__send({ type: "goto", page: 2, reqId: 7 }));
  assert.deepEqual(await posted(page, { type: "gotoDone" }, mark), { type: "gotoDone", reqId: 7, page: 2 });
  assert.deepEqual(await posted(page, { type: "page" }, mark), { type: "page", page: 2 });
  await page.waitForSelector(".page[data-page-number='2'] .textLayer span");

  // a real mouse selection across two lines of page 2 (text layer is selectable)
  mark = await count(page);
  const spans = page.locator(".page[data-page-number='2'] .textLayer span");
  const first = spans.filter({ hasText: "This sentence is hyphen-" }).first();
  const second = spans.filter({ hasText: "ated across two lines." }).first();
  const a = await first.boundingBox();
  const b = await second.boundingBox();
  assert.ok(a && b);
  await page.mouse.move(a.x + 1, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  const sel = /** @type {any} */ (await posted(page, { type: "selection", selection: "*" }, mark));
  assert.equal(sel.selection.page, 2);
  assert.match(sel.selection.text, /^This sentence is hyphenated across two lines\.?$/);

  // clearing the selection posts null
  mark = await count(page);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  assert.deepEqual(await posted(page, { type: "selection" }, mark), { type: "selection", selection: null });

  // reload in place: page 3, half-way down, zoomed in; rewrite the file; same view after
  await page.evaluate(() => /** @type {any} */ (window).__send({ type: "goto", page: 3, reqId: 8 }));
  await page.click("#zoomIn");
  await page.waitForTimeout(100);
  const before = await page.evaluate(() => {
    const c = /** @type {HTMLElement} */ (document.getElementById("viewerContainer"));
    const p = /** @type {HTMLElement} */ (document.querySelector(".page[data-page-number='3']"));
    c.scrollTop += p.clientHeight * 0.3;
    return null;
  });
  void before;
  await page.waitForTimeout(200);
  const view = () => page.evaluate(() => {
    const c = /** @type {HTMLElement} */ (document.getElementById("viewerContainer"));
    const p = /** @type {HTMLElement} */ (document.querySelector(".page[data-page-number='3']"));
    return {
      page: Number(/** @type {HTMLInputElement} */ (document.getElementById("pageNumber")).value),
      zoom: document.getElementById("zoomValue")?.textContent,
      ratio: (c.getBoundingClientRect().top - p.getBoundingClientRect().top) / p.clientHeight,
    };
  });
  const v1 = await view();
  assert.equal(v1.page, 3);
  fs.writeFileSync(pdf, samplePdf(5, "v2"));
  mark = await count(page);
  await page.evaluate(() => /** @type {any} */ (window).__reload());
  assert.deepEqual(await posted(page, { type: "loaded" }, mark), { type: "loaded", pages: 5, page: 3, reload: true });
  await page.waitForFunction(() => document.querySelector(".page[data-page-number='3'] .textLayer")?.textContent?.includes("v2"));
  const v2 = await view();
  assert.equal(v2.page, 3);
  assert.equal(v2.zoom, v1.zoom);
  assert.ok(Math.abs(v2.ratio - v1.ratio) < 0.02, `in-page offset kept: ${v1.ratio} vs ${v2.ratio}`);

  // a half-written file keeps the old render and reports the failure
  fs.writeFileSync(pdf, samplePdf(5, "v3").subarray(0, 200));
  mark = await count(page);
  await page.evaluate(() => /** @type {any} */ (window).__reload());
  const err = /** @type {any} */ (await posted(page, { type: "loadError" }, mark));
  assert.equal(err.reload, true);
  assert.equal(await page.locator(".page").count(), 5);
  assert.ok((await page.textContent(".page[data-page-number='3'] .textLayer"))?.includes("v2"));
  assert.ok(await page.locator("#message").isHidden(), "no error banner over a good render");

  // Ctrl+F
  await page.locator("#viewerContainer").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+f");
  assert.ok(await page.locator("#findbar").isVisible());
  await page.fill("#findInput", "alpha4");
  await page.waitForFunction(() => document.getElementById("findResult")?.textContent === "1 of 1");
  await page.waitForFunction(() => /** @type {HTMLInputElement} */ (document.getElementById("pageNumber")).value === "4");
  await page.keyboard.press("Escape");
  assert.ok(await page.locator("#findbar").isHidden());

  // toolbar page input
  await page.fill("#pageNumber", "5");
  await page.press("#pageNumber", "Enter");
  await posted(page, { type: "page", page: 5 });

  assert.deepEqual(errors.filter((e) => !/Warning/.test(e)), []);
  await page.close();
});

test("Ctrl+wheel zooms around the pointer; a plain wheel scrolls", async () => {
  const pdf = path.join(tmp, "zoom.pdf");
  fs.writeFileSync(pdf, samplePdf(3));
  const { page, errors } = await open(await serve(pdf));
  const zoom = async () => parseInt((await page.textContent("#zoomValue")) || "", 10);
  const before = await zoom();

  // the text under the pointer stays under it while zooming in
  const span = page.locator(".page[data-page-number='1'] .textLayer span").first();
  const box = await span.boundingBox();
  assert.ok(box);
  const x = box.x + 5, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -200);
  await page.keyboard.up("Control");
  await page.waitForFunction((b) => parseInt(document.getElementById("zoomValue")?.textContent || "", 10) > b, before);
  assert.ok((await zoom()) > before);
  await page.waitForSelector(".page[data-page-number='1'] .textLayer span");
  const after = await span.boundingBox();
  assert.ok(after && Math.abs(after.x - box.x) < 40 && Math.abs(after.y + after.height / 2 - y) < 40,
    `pointer anchor moved: ${JSON.stringify(box)} -> ${JSON.stringify(after)}`);

  // zoom out again
  const zoomedIn = await zoom();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 300);
  await page.keyboard.up("Control");
  await page.waitForFunction((b) => parseInt(document.getElementById("zoomValue")?.textContent || "", 10) < b, zoomedIn);

  // without Ctrl the wheel scrolls and leaves the zoom alone
  const z = await zoom();
  const top = await page.evaluate(() => document.getElementById("viewerContainer")?.scrollTop ?? -1);
  await page.mouse.wheel(0, 300);
  await page.waitForFunction((t) => (document.getElementById("viewerContainer")?.scrollTop ?? -1) > t, top);
  assert.equal(await zoom(), z);

  assert.deepEqual(errors.filter((e) => !/Warning/.test(e)), []);
  await page.close();
});

test("PyMuPDF-written underline and Text note render; links work", { skip: !python && "set VPDF_PYTHON to a python with pymupdf" }, async () => {
  const pdf = path.join(tmp, "annotated.pdf");
  execFileSync(python, ["-I", path.join(root, "scripts/make-annotated-pdf.py"), pdf]);
  const { page, errors } = await open(await serve(pdf));
  await page.waitForSelector(".page[data-page-number='1'] .annotationLayer section");
  assert.equal(await page.locator(".annotationLayer .underlineAnnotation").count(), 1);
  assert.equal(await page.locator(".annotationLayer .textAnnotation").count(), 1);
  assert.ok(await page.locator(".annotationLayer .textAnnotation img").evaluate((img) =>
    /** @type {HTMLImageElement} */ (img).complete && /** @type {HTMLImageElement} */ (img).naturalWidth > 0),
  "note icon loaded");

  // pdf.js's own popups are replaced by the viewer's popover (click) and tip (hover); the
  // annotation sections let the pointer through, so click where the icon is
  const icon = await page.locator(".annotationLayer .textAnnotation").boundingBox();
  assert.ok(icon);
  await page.mouse.click(icon.x + icon.width / 2, icon.y + icon.height / 2);
  const popup = page.locator(".popover:visible", { hasText: "A margin note written by PyMuPDF." });
  await popup.waitFor({ timeout: 5000 });
  assert.equal(await page.locator(".annotationLayer .popup:visible").count(), 0, "no pdf.js popup as well");

  // clicking off it closes it; hovering the underline shows the underline's note
  await page.mouse.click(600, 700);
  await popup.waitFor({ state: "hidden", timeout: 5000 });
  const ul = await page.locator(".annotationLayer .underlineAnnotation").boundingBox();
  assert.ok(ul);
  await page.mouse.move(ul.x + ul.width / 2, ul.y + ul.height / 2);
  await page.locator(".tip:visible", { hasText: "An underline written by PyMuPDF." }).waitFor({ timeout: 5000 });

  // external link -> extension; internal link -> page 3
  let mark = await count(page);
  await page.locator(".annotationLayer .linkAnnotation a[href^='https://example.org']").first().click();
  assert.deepEqual(await posted(page, { type: "openLink" }, mark), { type: "openLink", url: "https://example.org/" });
  mark = await count(page);
  await page.locator(".annotationLayer .linkAnnotation a[href^='#']").first().click();
  assert.deepEqual(await posted(page, { type: "page" }, mark), { type: "page", page: 3 });

  await page.screenshot({ path: path.join(tmp, "annotated.png") });
  assert.deepEqual(errors, []);
  await page.close();
});

// ---- marking -------------------------------------------------------------------------

/** @param {import("playwright-core").Page} page @param {Record<string, unknown>} [extra] */
async function enableMarking(page, extra = {}) {
  await page.evaluate((m) => /** @type {any} */ (window).__send({ type: "marking", enabled: true, reason: "", author: "david", keys: {}, ...m }), extra);
  await page.waitForSelector("#markTools .tool:not([disabled])");
}

/**
 * Drag-select the whole text-layer span containing `text` on `pageNo`.
 * @param {import("playwright-core").Page} page @param {number} pageNo @param {string} text
 */
async function selectSpan(page, pageNo, text) {
  const span = page.locator(`.page[data-page-number='${pageNo}'] .textLayer span`).filter({ hasText: text }).first();
  await span.scrollIntoViewIfNeeded();
  const b = await span.boundingBox();
  assert.ok(b);
  await page.mouse.move(b.x + 1, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
  return b;
}

/** Answer the last request of `type` as the extension would. @param {import("playwright-core").Page} page @param {string} type @param {any} [result] */
async function answer(page, type, result = { xref: 1 }) {
  await page.evaluate(([t, r]) => {
    const w = /** @type {any} */ (window);
    const m = [...w.__posted].reverse().find((/** @type {any} */ x) => x.type === t);
    w.__send({ type: "editResult", reqId: m.reqId, op: t, ok: true, result: r });
  }, /** @type {[string, any]} */ ([type, result]));
}

/** Scale of page 1 (CSS px per PDF point) and its content-box origin. @param {import("playwright-core").Page} page */
const pageBox = (page) => page.evaluate(() => {
  const div = /** @type {HTMLElement} */ (document.querySelector(".page[data-page-number='1']"));
  const r = div.getBoundingClientRect();
  return { left: r.left + div.clientLeft, top: r.top + div.clientTop, scale: div.clientWidth / 612 };
});

test("mini-bar: a selection shows it; a style posts a mark with PDF-space rects and clears the selection", async () => {
  const pdf = path.join(tmp, "minibar.pdf");
  fs.writeFileSync(pdf, samplePdf(3));
  const { page, errors } = await open(await serve(pdf));
  assert.equal(await page.locator("#markTools .tool[disabled]").count(), 5, "tools off until the extension says marking works");
  await enableMarking(page);

  let mark = await count(page);
  const box = await selectSpan(page, 1, "Reachability of timed automata");
  const sel = /** @type {any} */ (await posted(page, { type: "selection", selection: "*" }, mark));
  assert.deepEqual(sel.selection, { text: "Reachability of timed automata is decidable via regions.", page: 1 }, "selection publishing unchanged");
  await page.locator(".miniBar:visible").waitFor();
  assert.equal(await page.locator(".miniBar .styleButton").count(), 4);
  assert.equal(await page.locator(".miniBar .swatchButton").count(), 9);

  mark = await count(page);
  await page.click(".miniBar .styleButton[data-style='highlight']");
  const m = /** @type {any} */ (await posted(page, { type: "mark" }, mark));
  assert.equal(m.style, "highlight");
  assert.equal(m.color, "yellow", "the default colour");
  assert.equal(m.note, undefined);
  assert.equal(m.parts.length, 1);
  const [part] = m.parts;
  assert.equal(part.page, 1);
  assert.equal(part.text, "Reachability of timed automata is decidable via regions.");
  // The line's baseline is at y = 692 (12 pt Helvetica from x = 72): the rects must cover it, in PDF space.
  const { scale } = await pageBox(page);
  const x0 = Math.min(...part.rects.map((/** @type {number[]} */ r) => r[0]));
  const x1 = Math.max(...part.rects.map((/** @type {number[]} */ r) => r[2]));
  const y0 = Math.min(...part.rects.map((/** @type {number[]} */ r) => r[1]));
  const y1 = Math.max(...part.rects.map((/** @type {number[]} */ r) => r[3]));
  assert.ok(Math.abs(x0 - 72) < 2, `x0 ${x0}`);
  assert.ok(Math.abs(x1 - (72 + box.width / scale)) < 3, `x1 ${x1}`);
  assert.ok(y0 < 692 && y1 > 699 && y1 - y0 < 20, `y ${y0}..${y1}`);
  for (const [a, b, c, d] of part.rects) assert.ok(a < c && b < d, "normalised");

  // the selection is cleared and null is published, as with any click
  assert.deepEqual(await posted(page, { type: "selection", selection: null }, mark), { type: "selection", selection: null });
  await page.locator(".miniBar").waitFor({ state: "hidden" });
  await answer(page, "mark");

  // a swatch marks in that colour with the last style, and is remembered
  await selectSpan(page, 1, "Filler line 6 on page 1");
  mark = await count(page);
  await page.click(".miniBar .styleButton[data-style='underline']");
  assert.equal(/** @type {any} */ (await posted(page, { type: "mark" }, mark)).style, "underline");
  await selectSpan(page, 1, "Filler line 7 on page 1");
  mark = await count(page);
  await page.click(".miniBar .swatchButton[data-color='green']");
  const g = /** @type {any} */ (await posted(page, { type: "mark" }, mark));
  assert.deepEqual([g.style, g.color], ["underline", "green"]);
  assert.deepEqual(await posted(page, { type: "prefs" }, mark), { type: "prefs", style: "underline", color: "green" });

  // mark + note: an inline textbox; Enter marks with the note
  await selectSpan(page, 1, "Filler line 1 on page 1");
  mark = await count(page);
  await page.click(".miniBar .noteButton");
  await page.fill(".miniBar textarea", "a note on it");
  await page.press(".miniBar textarea", "Enter");
  const n = /** @type {any} */ (await posted(page, { type: "mark" }, mark));
  assert.deepEqual([n.style, n.color, n.note, n.parts[0].text], ["underline", "green", "a note on it", "Filler line 1 on page 1."]);

  // Escape closes the bar without marking
  await selectSpan(page, 1, "Filler line 2 on page 1");
  await page.locator(".miniBar:visible").waitFor();
  mark = await count(page);
  await page.keyboard.press("Escape");
  await page.locator(".miniBar").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate((from) => /** @type {any} */ (window).__posted.slice(from).filter((/** @type {any} */ x) => x.type === "mark").length, mark), 0);

  // an error from the extension is shown
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    const m = [...w.__posted].reverse().find((/** @type {any} */ x) => x.type === "mark");
    w.__send({ type: "editResult", reqId: m.reqId, ok: false, error: "PDF is locked by another writer" });
  });
  await page.locator("#status.error", { hasText: "PDF is locked by another writer" }).waitFor();

  assert.deepEqual(errors, []);
  await page.close();
});

test("keys: H/U/S/X mark the selection, N and Escape switch tools, Ctrl+Z undoes; not from text fields", async () => {
  const pdf = path.join(tmp, "keys.pdf");
  fs.writeFileSync(pdf, samplePdf(2));
  const { page, errors } = await open(await serve(pdf));
  await enableMarking(page, { keys: { squiggly: "q" } });

  for (const [key, style] of [["h", "highlight"], ["u", "underline"], ["q", "squiggly"], ["x", "strikeout"]]) {
    await selectSpan(page, 1, "Reachability of timed automata");
    const mark = await count(page);
    await page.keyboard.press(key);
    const m = /** @type {any} */ (await posted(page, { type: "mark" }, mark));
    assert.equal(m.style, style, `key ${key}`);
  }
  // "s" is no longer squiggly (rebound to "q")
  await selectSpan(page, 1, "Reachability of timed automata");
  let mark = await count(page);
  await page.keyboard.press("s");
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate((from) => /** @type {any} */ (window).__posted.slice(from).filter((/** @type {any} */ x) => x.type === "mark").length, mark), 0);
  await page.keyboard.press("Escape");

  mark = await count(page);
  await page.keyboard.press("Control+z");
  await posted(page, { type: "undo" }, mark);
  await answer(page, "undo", null);
  await page.locator("#status", { hasText: "Nothing to undo" }).waitFor();
  mark = await count(page);
  await page.click("#undo");
  await posted(page, { type: "undo" }, mark);
  await answer(page, "undo", { label: "highlight" });
  await page.locator("#status", { hasText: "Undone: highlight" }).waitFor();

  await page.keyboard.press("n");
  assert.equal(await page.getAttribute("#markTools .tool[data-tool='note']", "aria-pressed"), "true");
  await page.keyboard.press("Escape");
  assert.equal(await page.getAttribute("#markTools .tool[data-tool='note']", "aria-pressed"), "false");

  // typing in a text field (the find bar) is typing
  await page.keyboard.press("Control+f");
  mark = await count(page);
  await page.keyboard.type("hun");
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);
  assert.equal(await page.inputValue("#findInput"), "hu", "Ctrl+Z undid typing in the field");
  assert.deepEqual(await page.evaluate((from) => /** @type {any} */ (window).__posted.slice(from)
    .filter((/** @type {any} */ x) => ["mark", "undo"].includes(x.type)), mark), []);
  assert.equal(await page.getAttribute("#markTools .tool[data-tool='note']", "aria-pressed"), "false");

  assert.deepEqual(errors, []);
  await page.close();
});

test("toolbar: a sticky mark tool marks each selection at once; colour picker; margin-note tool", async () => {
  const pdf = path.join(tmp, "toolbar.pdf");
  fs.writeFileSync(pdf, samplePdf(2));
  const { page, errors } = await open(await serve(pdf));
  await enableMarking(page);

  await page.click("#colorButton");
  await page.click("#colorMenu .swatchButton[data-color='pink']");
  assert.ok(await page.locator("#colorMenu").isHidden());
  await page.click("#markTools .tool[data-tool='strikeout']");
  assert.equal(await page.getAttribute("#markTools .tool[data-tool='strikeout']", "aria-pressed"), "true");
  for (const line of ["Filler line 3 on page 1", "Filler line 4 on page 1"]) {
    const mark = await count(page);
    await selectSpan(page, 1, line);
    const m = /** @type {any} */ (await posted(page, { type: "mark" }, mark));
    assert.deepEqual([m.style, m.color, m.parts[0].text], ["strikeout", "pink", `${line}.`]);
    assert.ok(await page.locator(".miniBar").isHidden(), "no mini-bar in a mark mode");
  }
  await page.keyboard.press("Escape");
  assert.equal(await page.getAttribute("#markTools .tool[data-tool='strikeout']", "aria-pressed"), "false");

  // margin note: click a point, type, Enter
  await page.click("#markTools .tool[data-tool='note']");
  await page.locator(".page[data-page-number='1']").scrollIntoViewIfNeeded();
  const pb = await pageBox(page);
  const at = { x: pb.left + 30 * pb.scale, y: pb.top + 100 * pb.scale };
  await page.mouse.click(at.x, at.y);
  await page.locator(".noteEditor:visible textarea").fill("a margin note");
  const mark = await count(page);
  await page.keyboard.press("Enter");
  const n = /** @type {any} */ (await posted(page, { type: "note" }, mark));
  assert.equal(n.page, 1);
  assert.equal(n.note, "a margin note");
  assert.equal(n.color, "pink");
  assert.ok(Math.abs(n.point[0] - 30) < 1 && Math.abs(n.point[1] - (792 - 100)) < 1, `point ${n.point}`);
  assert.equal(await page.getAttribute("#markTools .tool[data-tool='note']", "aria-pressed"), "true", "sticky");

  assert.deepEqual(errors, []);
  await page.close();
});

test("popover: hover shows the note; click shows the thread; reply; own marks edit, restyle, delete; foreign ones do not", async () => {
  const pdf = path.join(tmp, "thread.pdf");
  const { data, xref } = threadPdf();
  fs.writeFileSync(pdf, data);
  const { page, errors } = await open(await serve(pdf));
  await enableMarking(page);
  await page.waitForSelector(".page[data-page-number='1'] .annotationLayer section");
  const pb = await pageBox(page);
  /** PDF point -> client point on page 1. @param {number} x @param {number} y */
  const at = (x, y) => ({ x: pb.left + x * pb.scale, y: pb.top + (792 - y) * pb.scale });

  // hover the llm highlight: its note
  let p = at(200, 696);
  await page.mouse.move(p.x, p.y);
  await page.locator(".tip:visible", { hasText: "An llm note" }).waitFor();
  assert.match(await page.textContent(".tip") || "", /llm · Highlight/);

  // click it: the thread, A with B nested, no edit/delete on A (llm's), but on B (mine)
  await page.mouse.click(p.x, p.y);
  const pop = page.locator(".popover:visible");
  await pop.waitFor();
  const a = pop.locator(`.item[data-id='${xref.A}R']`);
  const b = a.locator(`.replies .item[data-id='${xref.B}R']`);
  assert.equal(await a.locator(":scope > .head .author").textContent(), "llm");
  assert.equal(await a.locator(":scope > .note").textContent(), "An llm note");
  assert.equal(await b.locator(":scope > .note").textContent(), "My answer");
  assert.equal(await a.locator(":scope > .actions .editButton, :scope > .actions .deleteButton, :scope > .restyle").count(), 0, "foreign: no edit");
  assert.equal(await b.locator(":scope > .actions .editButton").count(), 1);
  assert.equal(await b.locator(":scope > .actions .deleteButton").count(), 1);

  // reply to the llm mark from the reply box
  let mark = await count(page);
  await pop.locator(".replyBox textarea").fill("Thanks, agreed.");
  await pop.locator(".replyBox textarea").press("Enter");
  assert.deepEqual(await posted(page, { type: "reply" }, mark), { type: "reply", reqId: /** @type {any} */ (await posted(page, { type: "reply" }, mark)).reqId, xref: xref.A, note: "Thanks, agreed." });
  // reply to my own reply instead
  await b.locator(":scope > .actions .replyButton").click();
  assert.match(await pop.locator(".replyLabel").textContent() || "", /Reply to david/);
  mark = await count(page);
  await pop.locator(".replyBox textarea").fill("and more");
  await pop.locator(".replyBox .sendReply").click();
  assert.equal(/** @type {any} */ (await posted(page, { type: "reply" }, mark)).xref, xref.B);

  // edit and delete my reply
  mark = await count(page);
  await b.locator(":scope > .actions .editButton").click();
  await b.locator("textarea.editNote").fill("My better answer");
  // a write by someone else reloads the file while typing: the text being typed stays
  mark = await count(page);
  await page.evaluate(() => {
    /** @type {any} */ (document.querySelector(".popover textarea.editNote")).dataset.old = "1";
    /** @type {any} */ (window).__reload();
  });
  await posted(page, { type: "loaded", reload: true }, mark);
  await page.waitForFunction(() => {
    const ta = /** @type {HTMLTextAreaElement | null} */ (document.querySelector(".popover textarea.editNote"));
    return ta && !ta.dataset.old && ta.value === "My better answer";
  });
  mark = await count(page);
  await page.locator(".popover textarea.editNote").press("Enter");
  const u = /** @type {any} */ (await posted(page, { type: "update" }, mark));
  assert.deepEqual([u.xref, u.note], [xref.B, "My better answer"]);
  mark = await count(page);
  await pop.locator(`.item[data-id='${xref.B}R'] > .actions .deleteButton`).click();
  assert.equal(/** @type {any} */ (await posted(page, { type: "delete" }, mark)).xref, xref.B);

  // my underline: restyle and recolour
  await page.keyboard.press("Escape");
  await pop.waitFor({ state: "hidden" });
  p = at(100, 654);
  await page.mouse.click(p.x, p.y);
  const c = page.locator(`.popover:visible .item[data-id='${xref.C}R']`);
  await c.waitFor();
  assert.equal(await c.locator(":scope > .restyle .styleButton[aria-pressed='true']").getAttribute("data-style"), "underline");
  assert.equal(await c.locator(":scope > .restyle .swatchButton[aria-pressed='true']").getAttribute("data-color"), "green");
  assert.equal(await c.locator(`.replies .item[data-id='${xref.E}R'] > .head .author`).textContent(), "llm");
  assert.equal(await c.locator(`.replies .item[data-id='${xref.E}R'] .editButton`).count(), 0);
  mark = await count(page);
  await c.locator(":scope > .restyle .styleButton[data-style='squiggly']").click();
  const st = /** @type {any} */ (await posted(page, { type: "update" }, mark));
  assert.deepEqual([st.xref, st.style], [xref.C, "squiggly"]);
  mark = await count(page);
  await c.locator(":scope > .restyle .swatchButton[data-color='red']").click();
  const co = /** @type {any} */ (await posted(page, { type: "update" }, mark));
  assert.deepEqual([co.xref, co.color], [xref.C, "red"]);

  // the llm margin note: reply only
  await page.keyboard.press("Escape");
  p = at(38, 568);
  await page.mouse.click(p.x, p.y);
  const d = page.locator(`.popover:visible .item[data-id='${xref.D}R']`);
  await d.waitFor();
  assert.equal(await d.locator(".editButton, .deleteButton, .restyle").count(), 0);
  assert.equal(await d.locator(".replyButton").count(), 1);

  // marking off: threads still show, no reply box
  await page.evaluate(() => /** @type {any} */ (window).__send({ type: "marking", enabled: false, reason: "pdf-reader-writer-edit not found", author: "david" }));
  await page.locator(".popover:visible .off", { hasText: "Marking is off: pdf-reader-writer-edit not found" }).waitFor();
  assert.equal(await page.locator(".popover .replyBox").count(), 0);
  assert.equal(await page.locator("#markTools .tool[disabled]").count(), 5);
  assert.match(await page.getAttribute("#markTools .tool[data-tool='highlight']", "title") || "", /pdf-reader-writer-edit not found/);

  assert.deepEqual(errors, []);
  await page.close();
});

test("side panel: every annotation by page with nested replies and marked text; click jumps and opens the popover", async () => {
  const pdf = path.join(tmp, "panel.pdf");
  const { data, xref } = threadPdf();
  fs.writeFileSync(pdf, data);
  const { page, errors } = await open(await serve(pdf));
  await enableMarking(page);
  await page.evaluate(() => /** @type {any} */ (window).__send({ type: "goto", page: 2, reqId: 1 }));
  await page.click("#panelToggle");
  const panel = page.locator("#annotPanel:visible");
  await panel.locator(".panelHead", { hasText: "Annotations (5)" }).waitFor();
  const roots = await panel.locator(":scope > .panelItem").evaluateAll((els) => els.map((e) => /** @type {HTMLElement} */ (e).dataset.id));
  assert.deepEqual(roots, [`${xref.A}R`, `${xref.C}R`, `${xref.D}R`]);
  assert.equal(await panel.locator(`.panelItem[data-id='${xref.A}R'] .replies .panelItem[data-id='${xref.B}R'] .note`).textContent(), "My answer");
  assert.equal(await panel.locator(".pageHead").allTextContents().then((t) => t.join("|")), "Page 1");
  // yellow (1, 0.9, 0.3); pdf.js passes colours as 8-bit, so 76.5 may come out as 76
  assert.match(await panel.locator(`.panelItem[data-id='${xref.A}R'] > .head .chip`).evaluate((e) => getComputedStyle(e).backgroundColor),
    /^rgb\(255, 230, 7[67]\)$/);

  // the marked text comes from the service's list
  await page.evaluate((x) => /** @type {any} */ (window).__send({ type: "annotations", list: [{ xref: x, text: "Reachability of timed automata" }] }), xref.A);
  await panel.locator(`.panelItem[data-id='${xref.A}R'] > .quote`, { hasText: "Reachability of timed automata" }).waitFor();

  // click the underline: back on page 1, its popover open
  const mark = await count(page);
  await panel.locator(`.panelItem[data-id='${xref.C}R'] > .head`).click();
  await posted(page, { type: "page", page: 1 }, mark);
  await page.locator(`.popover:visible .item.current[data-id='${xref.C}R']`).waitFor();

  // reload (a write by anyone): the panel follows the file
  fs.writeFileSync(pdf, samplePdf(2));
  await page.evaluate(() => /** @type {any} */ (window).__reload());
  await panel.locator(".panelHead", { hasText: "Annotations (0)" }).waitFor();
  await page.locator(".popover").waitFor({ state: "hidden" });

  assert.deepEqual(errors, []);
  await page.close();
});

// ---- SyncTeX -------------------------------------------------------------------------

/** samplePdf line `k` (0-based) as a SyncTeX rect: Helvetica 12 from x = 72, baseline 720 - 14 k, page height 792. @param {number} k @param {number} [x1] */
const lineRect = (k, x1 = 380) => [72, 792 - (720 - 14 * k) - 9, x1, 792 - (720 - 14 * k) + 3];

/**
 * Answer the latest synctexHover as the extension would.
 * @param {import("playwright-core").Page} page @param {any} hit
 */
async function answerHover(page, hit) {
  await posted(page, { type: "synctexHover" });
  await page.evaluate((h) => {
    const w = /** @type {any} */ (window);
    const m = [...w.__posted].reverse().find((/** @type {any} */ x) => x.type === "synctexHover");
    w.__send({ type: "synctexHit", reqId: m.reqId, hit: h });
  }, hit);
}

test("SyncTeX: Ctrl+hover shows a grey underline and a file:line tip from the extension's answer; releasing Ctrl removes them", async () => {
  const pdf = path.join(tmp, "stx-hover.pdf");
  fs.writeFileSync(pdf, samplePdf(3));
  const { page, errors } = await open(await serve(pdf));
  const span = page.locator(".page[data-page-number='1'] .textLayer span").filter({ hasText: "Reachability of timed automata" }).first();
  const b = await span.boundingBox();
  assert.ok(b);
  const at = { x: b.x + 40, y: b.y + b.height / 2 };

  // without SyncTeX data, Ctrl+hover asks nothing
  let mark = await count(page);
  await page.mouse.move(at.x, at.y);
  await page.keyboard.down("Control");
  await page.mouse.move(at.x + 2, at.y);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate((from) => /** @type {any} */ (window).__posted.slice(from).filter((/** @type {any} */ m) => m.type === "synctexHover").length, mark), 0);
  await page.keyboard.up("Control");

  await page.evaluate(() => /** @type {any} */ (window).__send({ type: "synctex", available: true }));
  mark = await count(page);
  await page.keyboard.down("Control");
  await page.mouse.move(at.x + 4, at.y);
  const req = /** @type {any} */ (await posted(page, { type: "synctexHover" }, mark));
  assert.equal(req.page, 1);
  // with the word under the pointer and its context, for the extension to find in the source
  assert.deepEqual(req.anchor, { before: ["page", "1", "heading"], words: ["reachability"], after: ["of", "timed", "automata", "is", "decidable", "via"] });
  // SyncTeX space: big points from the page's top-left; the line's baseline is 100 bp down
  const { scale } = await pageBox(page);
  assert.ok(Math.abs(req.y - 97) < 6, `y ${req.y}`);
  assert.ok(Math.abs(req.x - (72 + 44 / scale)) < 3, `x ${req.x}`);
  await answerHover(page, { file: "/proj/main.tex", rel: "main.tex", line: 12, column: 0,
    text: "Reachability of timed automata is decidable via regions.", em: [0, 12], rects: [lineRect(2)] });
  const bar = page.locator(".synctexHover .bar");
  await bar.first().waitFor();
  assert.equal(await bar.count(), 1);
  const bb = await bar.first().boundingBox();
  assert.ok(bb && Math.abs(bb.x - b.x) < 3 && bb.y < at.y && bb.y + bb.height > at.y, `bar ${JSON.stringify(bb)} under the text ${JSON.stringify(b)}`);
  assert.match(await bar.first().evaluate((e) => getComputedStyle(e).borderBottomColor), /^rgba?\(96, 96, 96/, "grey");
  const tip = page.locator(".synctexTip:visible");
  await tip.waitFor();
  assert.equal(await tip.locator(".synctexWhere").textContent(), "main.tex:12");
  assert.equal(await tip.locator(".synctexLine").textContent(), "Reachability of timed automata is decidable via regions.");
  assert.equal(await tip.locator(".synctexLine .synctexWord").textContent(), "Reachability", "the matched word stands out");
  assert.equal(await bar.first().evaluate((e) => getComputedStyle(e).pointerEvents), "none", "the underline lets the pointer through");

  // releasing Ctrl removes both; a late answer to an old request shows nothing
  await page.keyboard.up("Control");
  await bar.first().waitFor({ state: "detached" });
  assert.ok(await page.locator(".synctexTip").isHidden());
  await page.evaluate((r) => {
    const w = /** @type {any} */ (window);
    const m = [...w.__posted].reverse().find((/** @type {any} */ x) => x.type === "synctexHover");
    w.__send({ type: "synctexHit", reqId: m.reqId, hit: { file: "/a.tex", rel: "a.tex", line: 1, column: null, text: "", rects: [r] } });
  }, lineRect(2));
  await page.waitForTimeout(100);
  assert.equal(await bar.count(), 0);

  // leaving the page hides too
  mark = await count(page);
  await page.keyboard.down("Control");
  await page.mouse.move(at.x + 6, at.y);
  await posted(page, { type: "synctexHover" }, mark);
  await answerHover(page, { file: "/proj/main.tex", rel: "main.tex", line: 12, column: null, text: "", rects: [lineRect(2)] });
  await bar.first().waitFor();
  await page.mouse.move(2, 2); // the toolbar, outside the viewer
  await bar.first().waitFor({ state: "detached" });
  await page.keyboard.up("Control");

  // the underline does not get in the way of a plain selection
  mark = await count(page);
  await selectSpan(page, 1, "Filler line 6 on page 1");
  const sel = /** @type {any} */ (await posted(page, { type: "selection", selection: "*" }, mark));
  assert.equal(sel.selection.text, "Filler line 6 on page 1.");
  // with SyncTeX data the selection carries its rects in SyncTeX space
  assert.equal(sel.selection.parts.length, 1);
  assert.equal(sel.selection.parts[0].page, 1);
  const [l, t, r, bt] = sel.selection.parts[0].rects[0];
  const base = 792 - (720 - 14 * 11);
  assert.ok(Math.abs(l - 72) < 2 && t < base && bt > base - 3 && r > l, `rect ${sel.selection.parts[0].rects[0]}`);

  assert.deepEqual(errors, []);
  await page.close();
});

test("SyncTeX: Ctrl after the pointer rests also shows it; with Ctrl held the underline follows the pointer, even when moves do not report Ctrl", async () => {
  const pdf = path.join(tmp, "stx-follow.pdf");
  fs.writeFileSync(pdf, samplePdf(3));
  const { page, errors } = await open(await serve(pdf));
  await page.evaluate(() => /** @type {any} */ (window).__send({ type: "synctex", available: true }));
  const spanAt = async (/** @type {string} */ text) => {
    const b = await page.locator(".page[data-page-number='1'] .textLayer span").filter({ hasText: text }).first().boundingBox();
    assert.ok(b);
    return { x: b.x + 40, y: b.y + b.height / 2 };
  };
  const a = await spanAt("Reachability of timed automata");
  const c = await spanAt("Filler line 6 on page 1");
  const tip = page.locator(".synctexTip:visible .synctexWhere");

  // the pointer rests first, then Ctrl goes down: a lookup without moving
  await page.mouse.move(a.x, a.y);
  await page.waitForTimeout(100);
  let mark = await count(page);
  await page.keyboard.down("Control");
  const r1 = /** @type {any} */ (await posted(page, { type: "synctexHover" }, mark));
  assert.ok(Math.abs(r1.y - 97) < 6, `y ${r1.y}`);
  await answerHover(page, { file: "/proj/main.tex", rel: "main.tex", line: 12, column: null, text: "", rects: [lineRect(2)] });
  await page.locator(".synctexTip:visible .synctexWhere", { hasText: "main.tex:12" }).waitFor();

  // moving on with Ctrl held, in moves that report no Ctrl (Wayland): a new lookup there
  mark = await count(page);
  await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y) || document.body;
    target.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: y, ctrlKey: false }));
  }, c);
  const r2 = /** @type {any} */ (await posted(page, { type: "synctexHover" }, mark));
  assert.ok(r2.y > r1.y + 40, `followed down: ${r1.y} -> ${r2.y}`);
  await answerHover(page, { file: "/proj/main.tex", rel: "main.tex", line: 20, column: null, text: "", rects: [lineRect(6)] });
  await page.locator(".synctexTip:visible .synctexWhere", { hasText: "main.tex:20" }).waitFor();

  // a steady move keeps looking up on the way, not only once the pointer stops
  mark = await count(page);
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(c.x + 3 * i, c.y - 4 * i);
    await page.waitForTimeout(25);
  }
  const during = await page.evaluate((from) => /** @type {any} */ (window).__posted.slice(from).filter((/** @type {any} */ m) => m.type === "synctexHover").length, mark);
  assert.ok(during >= 1, `lookups while moving: ${during}`);

  // answers come back after the pointer has moved on: an earlier one still shows, an
  // older one than the shown one does not
  await page.waitForTimeout(100);
  const reqs = [];
  for (const dy of [0, 14]) {
    mark = await count(page);
    await page.mouse.move(a.x, a.y + dy);
    reqs.push(/** @type {any} */ (await posted(page, { type: "synctexHover" }, mark)).reqId);
    await page.waitForTimeout(60);
  }
  const reply = (/** @type {number} */ reqId, /** @type {number} */ line) => page.evaluate(({ reqId, line, r }) =>
    /** @type {any} */ (window).__send({ type: "synctexHit", reqId, hit: { file: "/proj/main.tex", rel: "main.tex", line, column: null, text: "", rects: [r] } }),
  { reqId, line, r: lineRect(2) });
  await reply(reqs[0], 31);
  await page.locator(".synctexTip:visible .synctexWhere", { hasText: "main.tex:31" }).waitFor();
  await reply(reqs[1], 32);
  await page.locator(".synctexTip:visible .synctexWhere", { hasText: "main.tex:32" }).waitFor();
  await reply(reqs[0], 33);
  await page.waitForTimeout(100);
  assert.equal(await tip.textContent(), "main.tex:32");

  // releasing Ctrl ends it
  await page.keyboard.up("Control");
  await page.locator(".synctexTip").waitFor({ state: "hidden" });
  assert.equal(await tip.count(), 0);

  assert.deepEqual(errors, []);
  await page.close();
});

test("SyncTeX: Ctrl+click posts the inverse search, also on a link (which it does not follow); without data it does nothing special", async () => {
  const pdf = path.join(tmp, "stx-click.pdf");
  fs.writeFileSync(pdf, samplePdf(3));
  const { page, errors } = await open(await serve(pdf));
  await enableMarking(page);
  await page.evaluate(() => /** @type {any} */ (window).__send({ type: "synctex", available: true }));
  const span = page.locator(".page[data-page-number='1'] .textLayer span").filter({ hasText: "Filler line 4 on page 1" }).first();
  const b = await span.boundingBox();
  assert.ok(b);
  let mark = await count(page);
  await page.keyboard.down("Control");
  await page.mouse.click(b.x + 10, b.y + b.height / 2);
  await page.keyboard.up("Control");
  const edit = /** @type {any} */ (await posted(page, { type: "synctexEdit" }, mark));
  assert.equal(edit.page, 1);
  // the clicked word and its context from the text layer
  assert.deepEqual(edit.anchor, { before: ["filler", "line", "3", "on", "page", "1"], words: ["filler"], after: ["line", "4", "on", "page", "1", "filler"] });
  assert.ok(Math.abs(edit.y - (792 - (720 - 14 * 9)) + 3) < 6, `y ${edit.y}`);
  await page.waitForTimeout(100);
  assert.ok(await page.locator(".miniBar").isHidden(), "no mini-bar, no selection");
  assert.equal(await page.evaluate(() => window.getSelection()?.toString() || ""), "");

  // the internal link on page 1 (to page 3): Ctrl+click is SyncTeX, not the link
  const link = await page.locator(".annotationLayer .linkAnnotation a").first().boundingBox();
  assert.ok(link);
  mark = await count(page);
  await page.keyboard.down("Control");
  await page.mouse.click(link.x + 5, link.y + link.height / 2);
  await page.keyboard.up("Control");
  await posted(page, { type: "synctexEdit" }, mark);
  await page.waitForTimeout(150);
  assert.equal(await page.inputValue("#pageNumber"), "1", "the link was not followed");
  // a plain click still follows it
  await page.mouse.click(link.x + 5, link.y + link.height / 2);
  await page.waitForFunction(() => /** @type {HTMLInputElement} */ (document.getElementById("pageNumber")).value === "3");

  // without SyncTeX data, Ctrl+click is a click
  await page.evaluate(() => /** @type {any} */ (window).__send({ type: "synctex", available: false }));
  await page.evaluate(() => /** @type {any} */ (window).__send({ type: "goto", page: 1, reqId: 2 }));
  await page.waitForFunction(() => /** @type {HTMLInputElement} */ (document.getElementById("pageNumber")).value === "1");
  const link2 = await page.locator(".annotationLayer .linkAnnotation a").first().boundingBox();
  assert.ok(link2);
  mark = await count(page);
  await page.keyboard.down("Control");
  await page.mouse.click(link2.x + 5, link2.y + link2.height / 2);
  await page.keyboard.up("Control");
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate((from) => /** @type {any} */ (window).__posted.slice(from).filter((/** @type {any} */ m) => m.type === "synctexEdit").length, mark), 0);

  assert.deepEqual(errors, []);
  await page.close();
});

test("SyncTeX: a forward search scrolls to the place, flashes it, then the flash clears", async () => {
  const pdf = path.join(tmp, "stx-flash.pdf");
  fs.writeFileSync(pdf, samplePdf(4));
  const { page, errors } = await open(await serve(pdf));
  await page.evaluate(() => /** @type {any} */ (window).__send({ type: "synctex", available: true }));
  const mark = await count(page);
  await page.evaluate((r) => /** @type {any} */ (window).__send({ type: "synctexShow", page: 3, rects: [r], reqId: 9 }), lineRect(20));
  assert.deepEqual(await posted(page, { type: "gotoDone" }, mark), { type: "gotoDone", reqId: 9, page: 3 });
  const bar = page.locator(".synctexFlash .bar");
  await bar.first().waitFor();
  const bb = await bar.first().boundingBox();
  const vc = await page.locator("#viewerContainer").boundingBox();
  const span = await page.locator(".page[data-page-number='3'] .textLayer span").filter({ hasText: "Filler line 15 on page 3" }).first().boundingBox();
  assert.ok(bb && vc && span);
  assert.ok(bb.y >= vc.y && bb.y + bb.height <= vc.y + vc.height, "the flash is in view");
  assert.ok(Math.abs(bb.y + bb.height / 2 - (span.y + span.height / 2)) < span.height, `flash ${JSON.stringify(bb)} on the line ${JSON.stringify(span)}`);
  assert.equal(await page.inputValue("#pageNumber"), "3");
  await bar.first().waitFor({ state: "detached", timeout: 4000 });
  assert.deepEqual(errors, []);
  await page.close();
});

/**
 * The client box of the `nth` occurrence of `word` in the text layer of `pageNo`.
 * @param {import("playwright-core").Page} page @param {number} pageNo @param {string} text a span's text
 * @param {string} word @param {number} [nth]
 */
const wordBox = (page, pageNo, text, word, nth = 0) => page.evaluate(([pageNo, text, word, nth]) => {
  const span = [...document.querySelectorAll(`.page[data-page-number='${pageNo}'] .textLayer span`)]
    .find((s) => s.textContent === text);
  const node = span?.firstChild;
  if (!node) return null;
  let at = -1;
  for (let i = 0; i <= Number(nth); i++) at = String(node.textContent).indexOf(String(word), at + 1);
  const r = document.createRange();
  r.setStart(node, at);
  r.setEnd(node, at + String(word).length);
  const b = r.getBoundingClientRect();
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}, /** @type {[number, string, string, number]} */ ([pageNo, text, word, nth]));

test("SyncTeX: a forward search with the word at the cursor flashes only that word (a repeated one by its context, a hyphenated one in two parts); no match flashes the line", async () => {
  const pdf = path.join(tmp, "stx-word.pdf");
  const repeated = "The model of the model checker is a model too.";
  fs.writeFileSync(pdf, makePdf([["Page 1 heading", "", repeated, ...sampleLines(1).slice(2)], sampleLines(2)]));
  const { page, errors } = await open(await serve(pdf));
  await page.evaluate(() => /** @type {any} */ (window).__send({ type: "synctex", available: true }));
  const bars = page.locator(".synctexFlash .bar");
  const show = async (/** @type {any} */ msg) => {
    await page.evaluate(() => document.querySelector(".synctexFlash")?.replaceChildren());
    const mark = await count(page);
    await page.evaluate((m) => /** @type {any} */ (window).__send({ type: "synctexShow", reqId: 5, ...m }), msg);
    await posted(page, { type: "gotoDone", reqId: 5 }, mark);
    await bars.first().waitFor();
    return Promise.all((await bars.all()).map((b) => b.boundingBox()));
  };
  /** @param {any} a @param {any} b */
  const near = (a, b, tol = 2) => a && b && Math.abs(a.x - b.x) < tol && Math.abs(a.width - b.width) < tol
    && Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) < b.height / 2;

  // the second "model" of the line: its context ("of the" before, "checker" after) picks it
  let got = await show({ page: 1, rects: [lineRect(2)],
    anchor: { before: ["heading", "the", "model", "of", "the"], words: ["model"], after: ["checker", "is", "a", "model", "too"] } });
  let want = await wordBox(page, 1, repeated, "model", 1);
  assert.equal(got.length, 1);
  assert.ok(near(got[0], want), `flash ${JSON.stringify(got[0])} on the word ${JSON.stringify(want)}`);
  // the third one, and two words the cursor spans
  got = await show({ page: 1, rects: [lineRect(2)], anchor: { before: ["is", "a"], words: ["model"], after: ["too", "reachability"] } });
  assert.ok(near(got[0], await wordBox(page, 1, repeated, "model", 2)), "the third model");
  got = await show({ page: 1, rects: [lineRect(2)], anchor: { before: ["the", "model"], words: ["checker", "is"], after: ["a"] } });
  want = await wordBox(page, 1, repeated, "checker is");
  assert.ok(got.length === 1 && near(got[0], want), `flash ${JSON.stringify(got)} on "checker is" ${JSON.stringify(want)}`);

  // a word TeX hyphenated across two printed lines: both parts
  got = await show({ page: 1, rects: [lineRect(4), lineRect(5)], anchor: { before: ["this", "sentence", "is"], words: ["hyphenated"], after: ["across"] } });
  assert.equal(got.length, 2, JSON.stringify(got));
  assert.ok(near(got[0], await wordBox(page, 1, "This sentence is hyphen-", "hyphen-")), "first part");
  assert.ok(near(got[1], await wordBox(page, 1, "ated across two lines.", "ated")), "second part");

  // a word that is not there, two places alike, or no anchor: the line, as before
  const line = await show({ page: 1, rects: [lineRect(2)] });
  for (const anchor of [{ before: [], words: ["absent"], after: [] }, { before: [], words: ["model"], after: [] }]) {
    got = await show({ page: 1, rects: [lineRect(2)], anchor });
    assert.equal(got.length, 1);
    assert.ok(near(got[0], line[0]) && /** @type {any} */ (got[0]).width > 300, `the line ${JSON.stringify(got[0])}`);
  }

  // a word printed on lines just after the line's boxes (a macro argument): found there
  got = await show({ page: 1, rects: [lineRect(6)], near: [{ page: 1, rects: [lineRect(7), lineRect(8)] }],
    anchor: { before: ["filler", "line", "2", "on"], words: ["page"], after: ["1", "filler"] } });
  assert.ok(near(got[0], await wordBox(page, 1, "Filler line 2 on page 1.", "page")), `in the near lines: ${JSON.stringify(got)}`);

  // on a page whose text layer is not rendered yet: it waits for it
  got = await show({ page: 2, rects: [lineRect(33)], anchor: { before: ["filler", "line", "28", "on"], words: ["page"], after: ["2"] } });
  assert.ok(near(got[0], await wordBox(page, 2, "Filler line 28 on page 2.", "page")), `page 2: ${JSON.stringify(got)}`);
  assert.equal(await page.inputValue("#pageNumber"), "2");

  assert.deepEqual(errors, []);
  await page.close();
});

test("SyncTeX: Ctrl+wheel still zooms, and hides the underline during the gesture", async () => {
  const pdf = path.join(tmp, "stx-zoom.pdf");
  fs.writeFileSync(pdf, samplePdf(3));
  const { page, errors } = await open(await serve(pdf));
  await page.evaluate(() => /** @type {any} */ (window).__send({ type: "synctex", available: true }));
  const zoom = async () => parseInt((await page.textContent("#zoomValue")) || "", 10);
  const span = page.locator(".page[data-page-number='1'] .textLayer span").filter({ hasText: "Reachability" }).first();
  const b = await span.boundingBox();
  assert.ok(b);
  const mark = await count(page);
  await page.mouse.move(b.x + 20, b.y + b.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.move(b.x + 22, b.y + b.height / 2);
  await posted(page, { type: "synctexHover" }, mark);
  await answerHover(page, { file: "/p/a.tex", rel: "a.tex", line: 3, column: null, text: "", rects: [lineRect(2)] });
  await page.locator(".synctexHover .bar").first().waitFor();
  const before = await zoom();
  await page.mouse.wheel(0, -200);
  await page.locator(".synctexHover .bar").first().waitFor({ state: "detached" });
  await page.waitForFunction((z) => parseInt(document.getElementById("zoomValue")?.textContent || "", 10) > z, before);
  await page.keyboard.up("Control");
  assert.ok((await zoom()) > before);
  assert.deepEqual(errors, []);
  await page.close();
});

// ---- minimap -------------------------------------------------------------------------

/** Open the minimap (on by default) and wait for its thumbnails. @param {import("playwright-core").Page} page @param {number} pages */
async function openMinimap(page, pages) {
  if (await page.getAttribute("#minimapToggle", "aria-pressed") !== "true") await page.click("#minimapToggle");
  await page.waitForFunction((n) => document.querySelectorAll("#minimap .thumb").length === n, pages);
}

/** Does thumbnail `n`'s canvas show text (dark opaque pixels)? Runs in the page. @param {number} n */
function thumbInked(n) {
  const c = /** @type {HTMLCanvasElement | null} */ (document.querySelector(`#minimap .thumb[data-page-number='${n}'] canvas`));
  const ctx = c && c.width > 1 ? c.getContext("2d") : null;
  if (!c || !ctx) return false;
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 255 && d[i] < 160) return true;
  return false;
}

/** Thumbnail `n` and the viewport box, in minimap content coordinates. Runs in the page. @param {number} n */
function minimapGeom(n) {
  const m = /** @type {HTMLElement} */ (document.getElementById("minimap"));
  const t = /** @type {HTMLElement} */ (m.querySelector(`.thumb[data-page-number='${n}']`));
  const b = /** @type {HTMLElement} */ (m.querySelector(".viewportBox"));
  return {
    thumbTop: t.offsetTop, thumbBottom: t.offsetTop + t.offsetHeight, boxTop: b.offsetTop, boxHeight: b.offsetHeight,
    boxHidden: b.hidden, scrollTop: m.scrollTop, clientHeight: m.clientHeight, scrollHeight: m.scrollHeight,
  };
}

test("minimap: on by default with one thumbnail per page in the page's aspect ratio; visible thumbnails render; the toggle is remembered", async () => {
  const pdf = path.join(tmp, "minimap.pdf");
  fs.writeFileSync(pdf, samplePdf(5));
  const url = await serve(pdf);
  const { page, errors } = await open(url);
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).__state.minimapOpen), undefined, "nothing saved yet");
  await page.waitForFunction(() => document.querySelectorAll("#minimap .thumb").length === 5);
  assert.equal(await page.getAttribute("#minimapToggle", "aria-pressed"), "true");
  assert.ok(await page.locator("#minimap").isVisible());
  assert.equal(await page.evaluate(() => document.body.classList.contains("minimap-open")), true);
  const ratios = await page.locator(".page").evaluateAll((els) => els.map((e) => e.clientHeight / e.clientWidth));
  const thumbs = await page.locator("#minimap .thumb").evaluateAll((els) => els.map((e) => ({ w: e.clientWidth, h: e.clientHeight, title: /** @type {HTMLElement} */ (e).title })));
  thumbs.forEach((t, i) => {
    assert.equal(t.w, 100);
    assert.ok(Math.abs(t.h - 100 * ratios[i]) <= 1, `thumb ${i + 1}: ${t.h} px for ratio ${ratios[i]}`);
    assert.equal(t.title, `Page ${i + 1}`);
  });
  await page.waitForFunction(thumbInked, 1);
  // page 5 is not drawn by the main view at this zoom: its thumbnail is the minimap's own render
  await page.waitForFunction(thumbInked, 5);

  // the toggle hides it and is remembered; annotate.mjs's preferences and the minimap's
  // share the state, in both directions
  await page.click("#minimapToggle");
  assert.ok(await page.locator("#minimap").isHidden());
  assert.equal(await page.getAttribute("#minimapToggle", "aria-pressed"), "false");
  assert.equal(await page.evaluate(() => document.body.classList.contains("minimap-open")), false);
  await page.click("#panelToggle");
  assert.deepEqual(await page.evaluate(() => {
    const s = /** @type {any} */ (window).__state;
    return [s.minimapOpen, s.panelOpen];
  }), [false, true]);
  await page.click("#minimapToggle");
  assert.deepEqual(await page.evaluate(() => {
    const s = /** @type {any} */ (window).__state;
    return [s.minimapOpen, s.panelOpen];
  }), [true, true]);
  assert.ok(await page.locator("#minimap").isVisible());

  // a saved "closed" starts it closed
  const closed = await open(url, () => {
    /** @type {any} */ (window).__state = { minimapOpen: false };
  });
  assert.ok(await closed.page.locator("#minimap").isHidden());
  assert.equal(await closed.page.getAttribute("#minimapToggle", "aria-pressed"), "false");
  assert.equal(await closed.page.evaluate(() => document.body.classList.contains("minimap-open")), false);
  await openMinimap(closed.page, 5);
  assert.equal(await closed.page.evaluate(() => /** @type {any} */ (window).__state.minimapOpen), true);

  assert.deepEqual(errors, []);
  assert.deepEqual(closed.errors, []);
  await closed.page.close();
  await page.close();
});

test("minimap: the viewport box follows scrolling and zoom; click and drag scroll the pages", async () => {
  const pdf = path.join(tmp, "minimap-box.pdf");
  fs.writeFileSync(pdf, samplePdf(5));
  const { page, errors } = await open(await serve(pdf));
  await openMinimap(page, 5);

  let mark = await count(page);
  await page.evaluate(() => /** @type {any} */ (window).__send({ type: "goto", page: 3, reqId: 3 }));
  await posted(page, { type: "gotoDone", reqId: 3 }, mark);
  await page.waitForFunction((n) => {
    const m = /** @type {HTMLElement} */ (document.getElementById("minimap"));
    const t = /** @type {HTMLElement} */ (m.querySelector(`.thumb[data-page-number='${n}']`));
    const b = /** @type {HTMLElement} */ (m.querySelector(".viewportBox"));
    return !b.hidden && b.offsetTop >= t.offsetTop && b.offsetTop < t.offsetTop + t.offsetHeight;
  }, 3);
  assert.ok(await page.locator("#minimap .thumb.current[data-page-number='3']").count(), "page 3 is marked current");

  // a click scrolls the pages there
  const t5 = await page.locator("#minimap .thumb[data-page-number='5']").boundingBox();
  const t2 = await page.locator("#minimap .thumb[data-page-number='2']").boundingBox();
  assert.ok(t5 && t2);
  mark = await count(page);
  await page.mouse.click(t5.x + t5.width / 2, t5.y + t5.height / 2);
  await posted(page, { type: "page", page: 5 }, mark);

  // a drag follows the pointer
  mark = await count(page);
  await page.mouse.move(t5.x + t5.width / 2, t5.y + t5.height / 2);
  await page.mouse.down();
  await page.mouse.move(t2.x + t2.width / 2, t2.y + t2.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction((start) => {
    const pages = /** @type {any} */ (window).__posted.slice(start).filter((/** @type {any} */ m) => m.type === "page");
    return pages.length && pages[pages.length - 1].page <= 2;
  }, mark);

  // zooming in shows less of the document: a smaller box
  const before = await page.evaluate(minimapGeom, 2);
  await page.click("#zoomIn");
  await page.waitForFunction((h) => {
    const b = /** @type {HTMLElement} */ (document.querySelector("#minimap .viewportBox"));
    return b.offsetHeight < h;
  }, before.boxHeight);

  assert.deepEqual(errors, []);
  await page.close();
});

test("minimap: a reload keeps the thumbnails on screen and re-renders them", async () => {
  const pdf = path.join(tmp, "minimap-reload.pdf");
  fs.writeFileSync(pdf, samplePdf(5));
  const { page, errors } = await open(await serve(pdf));
  await openMinimap(page, 5);
  await page.waitForFunction(thumbInked, 1);
  const image = () => page.evaluate(() => /** @type {HTMLCanvasElement} */ (document.querySelector("#minimap .thumb[data-page-number='1'] canvas")).toDataURL());
  const old = await image();
  await page.evaluate(() => {
    /** @type {HTMLElement} */ (document.querySelector("#minimap .thumb[data-page-number='1']")).dataset.marker = "kept";
  });

  // the same pages with other text (the heading of each page gains "v2")
  fs.writeFileSync(pdf, samplePdf(5, "v2"));
  const mark = await count(page);
  await page.evaluate(() => /** @type {any} */ (window).__reload());
  await posted(page, { type: "loaded", reload: true }, mark);
  assert.equal(await page.locator("#minimap .thumb").count(), 5);
  assert.equal(await page.getAttribute("#minimap .thumb[data-page-number='1']", "data-marker"), "kept", "the same element");
  assert.ok(await page.evaluate(thumbInked, 1), "the old image stays until the new one is ready");
  await page.waitForFunction((o) => /** @type {HTMLCanvasElement} */ (document.querySelector("#minimap .thumb[data-page-number='1'] canvas")).toDataURL() !== o, old);
  assert.ok(await page.evaluate(thumbInked, 1));

  // other page sizes: made anew
  fs.writeFileSync(pdf, samplePdf(3));
  await page.evaluate(() => /** @type {any} */ (window).__reload());
  await page.waitForFunction(() => document.querySelectorAll("#minimap .thumb").length === 3);
  assert.equal(await page.getAttribute("#minimap .thumb[data-page-number='1']", "data-marker"), null);

  assert.deepEqual(errors, []);
  await page.close();
});

test("minimap: annotations show as coloured rects on their page", async () => {
  const pdf = path.join(tmp, "minimap-annots.pdf");
  fs.writeFileSync(pdf, threadPdf().data);
  const { page, errors } = await open(await serve(pdf));
  await openMinimap(page, 2);
  const marks = page.locator("#minimap .thumb[data-page-number='1'] .overlay > *");
  // highlight A, underline C, margin note D; the replies B and E are not drawn
  await page.waitForFunction(() => document.querySelectorAll("#minimap .thumb[data-page-number='1'] .overlay > *").length === 3);
  const got = await marks.evaluateAll((els) => els.map((e) => {
    const s = getComputedStyle(e);
    return { note: e.classList.contains("noteMark"), bg: s.backgroundColor, left: parseFloat(s.left), top: parseFloat(s.top), w: parseFloat(s.width), h: parseFloat(s.height) };
  }));
  for (const m of got) assert.notEqual(m.bg, "rgba(0, 0, 0, 0)");
  const yellow = got.find((m) => /^rgb\(255, 230, 7[67]\)$/.test(m.bg));
  assert.ok(yellow, `the yellow highlight: ${JSON.stringify(got)}`);
  // its quad: x 72..400, y 689..703 on a 612 x 792 page, in a 100 x 129 px thumbnail
  assert.ok(Math.abs(yellow.left - (72 / 612) * 100) < 1 && Math.abs(yellow.top - ((792 - 703) / 792) * 129) < 1, JSON.stringify(yellow));
  assert.ok(Math.abs(yellow.w - (328 / 612) * 100) < 1 && yellow.h >= 2, JSON.stringify(yellow));
  assert.equal(got.filter((m) => m.note).length, 1);
  assert.equal(await page.locator("#minimap .thumb[data-page-number='2'] .overlay > *").count(), 0);

  assert.deepEqual(errors, []);
  await page.close();
});

test("minimap: a long document's minimap scrolls so the box stays in view", async () => {
  const pdf = path.join(tmp, "minimap-long.pdf");
  fs.writeFileSync(pdf, samplePdf(60));
  const { page, errors } = await open(await serve(pdf));
  await openMinimap(page, 60);
  await page.waitForFunction(thumbInked, 1);
  await page.evaluate(() => {
    const c = /** @type {HTMLElement} */ (document.getElementById("viewerContainer"));
    c.scrollTop = c.scrollHeight;
  });
  await page.waitForFunction(() => {
    const m = /** @type {HTMLElement} */ (document.getElementById("minimap"));
    const b = /** @type {HTMLElement} */ (m.querySelector(".viewportBox"));
    return m.scrollTop > 0 && b.offsetTop >= m.scrollTop && b.offsetTop < m.scrollTop + m.clientHeight;
  });
  const g = await page.evaluate(minimapGeom, 60);
  assert.ok(g.boxTop + g.boxHeight <= g.thumbBottom + 1, `the box ends at the last page: ${JSON.stringify(g)}`);

  // lazily: the thumbnails in view render, those never near it do not
  await page.waitForFunction(thumbInked, 60);
  assert.equal(await page.evaluate(thumbInked, 30), false);
  // and the eviction sweep (a second after the minimap stops) leaves the ones in view alone
  await page.waitForTimeout(1300);
  assert.ok(await page.evaluate(thumbInked, 60));

  assert.deepEqual(errors, []);
  await page.close();
});

test("minimap: the pages the main view renders are copied into their thumbnails; without idle time nothing else renders", async () => {
  const pdf = path.join(tmp, "minimap-copy.pdf");
  fs.writeFileSync(pdf, samplePdf(5));
  // no idle callbacks ever: the minimap's own renders cannot start; it starts closed
  const { page, errors } = await open(await serve(pdf), () => {
    const w = /** @type {any} */ (window);
    w.requestIdleCallback = () => 0;
    w.cancelIdleCallback = () => {};
    w.__state = { minimapOpen: false };
  });
  await openMinimap(page, 5);
  // page 1 was drawn before the minimap opened: copied when it opens
  await page.waitForFunction(thumbInked, 1);
  // page 5 is not drawn by the main view at this zoom, so its thumbnail stays blank
  const drawn = (/** @type {number} */ n) => page.evaluate((k) => {
    const div = /** @type {HTMLElement} */ (document.querySelector(`.page[data-page-number='${k}']`));
    return div.hasAttribute("data-loaded") || !!div.querySelector("canvas");
  }, n);
  assert.equal(await drawn(5), false);
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(thumbInked, 5), false);

  // a reload: the main view draws page 1 again, and its thumbnail follows (on pagerendered)
  const image = () => page.evaluate(() => /** @type {HTMLCanvasElement} */ (document.querySelector("#minimap .thumb[data-page-number='1'] canvas")).toDataURL());
  const old = await image();
  fs.writeFileSync(pdf, samplePdf(5, "v2"));
  await page.evaluate(() => /** @type {any} */ (window).__reload());
  await page.waitForFunction((o) => /** @type {HTMLCanvasElement} */ (document.querySelector("#minimap .thumb[data-page-number='1'] canvas")).toDataURL() !== o, old);
  assert.ok(await page.evaluate(thumbInked, 1));
  assert.equal(await drawn(5), false);
  assert.equal(await page.evaluate(thumbInked, 5), false);

  assert.deepEqual(errors, []);
  await page.close();
});

test("minimap: thumbnails far from view are emptied, those near it kept", async () => {
  const pdf = path.join(tmp, "minimap-evict.pdf");
  fs.writeFileSync(pdf, samplePdf(60));
  const { page, errors } = await open(await serve(pdf));
  await openMinimap(page, 60);
  await page.waitForFunction(thumbInked, 1);
  const mark = await count(page);
  await page.evaluate(() => /** @type {any} */ (window).__send({ type: "goto", page: 60, reqId: 60 }));
  await posted(page, { type: "gotoDone", reqId: 60 }, mark);
  await page.waitForFunction(thumbInked, 60);
  // page 1 is 59 pages from anything in view: emptied, its element and height kept
  await page.waitForFunction(() => {
    const c = /** @type {HTMLCanvasElement} */ (document.querySelector("#minimap .thumb[data-page-number='1'] canvas"));
    return c.width === 1 && c.height === 1;
  }, null, { timeout: 5000 });
  assert.equal(await page.locator("#minimap .thumb").count(), 60);
  assert.ok(Math.abs((await page.locator("#minimap .thumb[data-page-number='1']").evaluate((e) => e.clientHeight)) - 129) <= 1);
  for (let n = 55; n <= 60; n++) await page.waitForFunction(thumbInked, n);

  // back at the start, page 1 comes back (copied from the main view)
  await page.evaluate(() => /** @type {any} */ (window).__send({ type: "goto", page: 1, reqId: 61 }));
  await page.waitForFunction(thumbInked, 1);

  assert.deepEqual(errors, []);
  await page.close();
});

test("minimap: a landscape page and a page with /Rotate 90 get landscape thumbnails, and their own renders are upright", async () => {
  const pdf = path.join(tmp, "minimap-rotate.pdf");
  // page 3 landscape by its size, page 4 by /Rotate 90; neither is drawn by the main view
  const boxes = [undefined, undefined, { size: /** @type {[number, number]} */ ([792, 612]) }, { rotate: 90 }];
  fs.writeFileSync(pdf, makePdf([1, 2, 3, 4, 5, 6].map((p) => sampleLines(p)), { boxes }));
  const { page, errors } = await open(await serve(pdf));
  await openMinimap(page, 6);
  for (const n of [3, 4]) {
    // every page's size is known after pagesloaded: the thumbnail is 100 x 77
    await page.waitForFunction((k) => {
      const t = /** @type {HTMLElement} */ (document.querySelector(`#minimap .thumb[data-page-number='${k}']`));
      return Math.abs(t.clientHeight - (100 * 612) / 792) <= 1;
    }, n);
    await page.waitForFunction(thumbInked, n);
    // the image has the thumbnail's shape (an own render of page 4 that left out its
    // /Rotate would be portrait, squeezed into the landscape box)
    await page.waitForFunction((k) => {
      const t = /** @type {HTMLElement} */ (document.querySelector(`#minimap .thumb[data-page-number='${k}']`));
      const c = /** @type {HTMLCanvasElement} */ (t.querySelector("canvas"));
      return Math.abs(c.height / c.width - t.clientHeight / t.clientWidth) < 0.03;
    }, n, { timeout: 5000 });
  }
  assert.equal(await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector(".page[data-page-number='4']")).querySelector("canvas")), null, "page 4 was the minimap's own render");

  assert.deepEqual(errors, []);
  await page.close();
});

test("minimap: a page request that never settles does not stop the thumbnails after a reload", async () => {
  const pdf = path.join(tmp, "minimap-stuck.pdf");
  fs.writeFileSync(pdf, samplePdf(10));
  // The reply to the first request for page 6 never arrives, as when the worker answers
  // after the old document of a reload has gone (its message handler is destroyed and
  // the request's promise is never settled).
  const { page, errors } = await open(await serve(pdf), () => {
    const w = /** @type {any} */ (window);
    w.__holdPage = 5;
    w.__held = 0;
    const Base = w.Worker;
    /** @type {Set<string>} */
    const held = new Set();
    w.Worker = class extends Base {
      /** @param {any} m @param {any} [t] */
      postMessage(m, t) {
        if (m && m.action === "GetPage" && m.data?.pageIndex === w.__holdPage) {
          w.__holdPage = null;
          w.__held++;
          held.add(`${m.sourceName}:${m.callbackId}`);
        }
        return super.postMessage(m, t);
      }
      /** @param {string} type @param {any} fn @param {any} [opts] */
      addEventListener(type, fn, opts) {
        if (type !== "message") return super.addEventListener(type, fn, opts);
        return super.addEventListener(type, (/** @type {MessageEvent} */ e) => {
          const d = e.data;
          if (d && d.callback && held.has(`${d.targetName}:${d.callbackId}`)) return;
          fn.call(this, e);
        }, opts);
      }
    };
  });
  await openMinimap(page, 10);
  // pages 3 to 5 are the minimap's own renders; page 6's waits for its page
  for (const n of [3, 4, 5]) await page.waitForFunction(thumbInked, n);
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).__held), 1);
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(thumbInked, 7), false, "page 7 waits behind page 6");

  const image = (/** @type {number} */ n) => page.evaluate((k) => /** @type {HTMLCanvasElement} */ (document.querySelector(`#minimap .thumb[data-page-number='${k}'] canvas`)).toDataURL(), n);
  const old = await image(4);
  fs.writeFileSync(pdf, samplePdf(10, "v2"));
  const mark = await count(page);
  await page.evaluate(() => /** @type {any} */ (window).__reload());
  await posted(page, { type: "loaded", reload: true }, mark);
  // the new document's page 4 is rendered into its thumbnail (the main view does not draw it)
  await page.waitForFunction((o) => /** @type {HTMLCanvasElement} */ (document.querySelector("#minimap .thumb[data-page-number='4'] canvas")).toDataURL() !== o, old, { timeout: 5000 });
  await page.waitForFunction(thumbInked, 7);

  assert.deepEqual(errors, []);
  await page.close();
});

/** Init script: idle callbacks run only when the test calls `window.__idle()`. */
function manualIdle() {
  const w = /** @type {any} */ (window);
  /** @type {(Function | null)[]} */
  const q = [];
  w.requestIdleCallback = (/** @type {Function} */ fn) => q.push(fn);
  w.cancelIdleCallback = (/** @type {number} */ id) => {
    q[id - 1] = null;
  };
  w.__idlePending = () => q.some(Boolean);
  w.__idle = () => {
    const fns = q.slice();
    q.fill(null);
    for (const f of fns) f?.({ didTimeout: false, timeRemaining: () => 50 });
  };
}

test("minimap: a hidden tab renders no thumbnails; shown again, it does", async () => {
  const pdf = path.join(tmp, "minimap-hidden.pdf");
  fs.writeFileSync(pdf, samplePdf(5));
  const { page, errors } = await open(await serve(pdf), manualIdle);
  await openMinimap(page, 5);
  await page.waitForFunction(thumbInked, 1);
  await page.evaluate(() => /** @type {any} */ (window).__send({ type: "visibility", visible: false }));
  // well past the quiet period, with idle time on offer every frame
  const until = Date.now() + 800;
  while (Date.now() < until) {
    await page.evaluate(() => /** @type {any} */ (window).__idle());
    await page.waitForTimeout(50);
  }
  assert.equal(await page.evaluate(thumbInked, 5), false);

  await page.evaluate(() => /** @type {any} */ (window).__send({ type: "visibility", visible: true }));
  const end = Date.now() + 5000;
  while (!(await page.evaluate(thumbInked, 5))) {
    assert.ok(Date.now() < end, "page 5 rendered once shown");
    await page.evaluate(() => /** @type {any} */ (window).__idle());
    await page.waitForTimeout(50);
  }

  assert.deepEqual(errors, []);
  await page.close();
});

test("minimap: a click puts that point of the page in the middle of the view; the box matches the view, also with the find bar and the side panel open; closed, the pages get its width", async () => {
  const pdf = path.join(tmp, "minimap-seek.pdf");
  fs.writeFileSync(pdf, samplePdf(60));
  const { page, errors } = await open(await serve(pdf));
  await openMinimap(page, 60);

  /** Where the middle of the view is: page and fraction of its height. */
  const middle = () => page.evaluate(() => {
    const c = /** @type {HTMLElement} */ (document.getElementById("viewerContainer"));
    const r = c.getBoundingClientRect();
    const y = r.top + c.clientHeight / 2;
    for (const p of document.querySelectorAll(".page")) {
      const b = p.getBoundingClientRect();
      if (y >= b.top && y < b.bottom) return { page: Number(/** @type {HTMLElement} */ (p).dataset.pageNumber), frac: (y - b.top) / b.height };
    }
    return null;
  });
  /** The box against the view (not at the last page). */
  const boxCheck = () => page.evaluate(() => {
    const c = /** @type {HTMLElement} */ (document.getElementById("viewerContainer"));
    const m = /** @type {HTMLElement} */ (document.getElementById("minimap"));
    const b = /** @type {HTMLElement} */ (m.querySelector(".viewportBox"));
    const cr = c.getBoundingClientRect();
    // measured afresh: from a page's top to the next one's onto the same span of the thumbnails
    const pages = [...document.querySelectorAll(".page")].map((p) => p.getBoundingClientRect().top - cr.top + c.scrollTop);
    const tops = [...m.querySelectorAll(".thumb")].map((t) => /** @type {HTMLElement} */ (t).offsetTop);
    /** @param {number} y content y of the view */
    const at = (y) => {
      const i = pages.findLastIndex((top) => top <= y);
      return tops[i] + ((y - pages[i]) / (pages[i + 1] - pages[i])) * (tops[i + 1] - tops[i]);
    };
    return { top: b.offsetTop, want: at(c.scrollTop), bottom: b.offsetTop + b.offsetHeight, wantBottom: at(c.scrollTop + c.clientHeight) };
  });
  const boxMatches = async (/** @type {string} */ what) => {
    // the box follows in the next frame
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const g = await boxCheck();
    assert.ok(Math.abs(g.top - g.want) <= 2 && Math.abs(g.bottom - g.wantBottom) <= 2, `${what}: ${JSON.stringify(g)}`);
  };

  // far down the document, with the minimap scrolled along: a click a quarter down page 50's thumbnail
  let mark = await count(page);
  await page.evaluate(() => /** @type {any} */ (window).__send({ type: "goto", page: 48, reqId: 1 }));
  await posted(page, { type: "gotoDone", reqId: 1 }, mark);
  await page.waitForFunction(() => /** @type {HTMLElement} */ (document.getElementById("minimap")).scrollTop > 0);
  const t50 = page.locator("#minimap .thumb[data-page-number='50']");
  await t50.scrollIntoViewIfNeeded();
  const b50 = await t50.boundingBox();
  assert.ok(b50);
  await page.mouse.click(b50.x + b50.width / 2, b50.y + b50.height / 4);
  const mid = await middle();
  assert.ok(mid && mid.page === 50 && Math.abs(mid.frac - 0.25) < 0.03, JSON.stringify(mid));
  await boxMatches("after the click");

  // the find bar lowers both panels; the side panel narrows the pages (page-width refits)
  await page.keyboard.press("Control+f");
  await page.waitForSelector("#findbar:not([hidden])");
  await boxMatches("find bar open");
  await page.click("#panelToggle");
  await page.waitForFunction(() => document.body.classList.contains("panel-open"));
  await page.waitForTimeout(200);
  await boxMatches("side panel open");
  await page.click("#panelToggle");

  // closed: the pages take its width (page-width refits to the wider view)
  const width = () => page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector(".page")).getBoundingClientRect().width);
  const before = await width();
  await page.click("#minimapToggle");
  await page.waitForFunction((w) => /** @type {HTMLElement} */ (document.querySelector(".page")).getBoundingClientRect().width > w + 60, before);

  assert.deepEqual(errors, []);
  await page.close();
});

test("minimap: the wheel scrolls the minimap, not the pages", async () => {
  const pdf = path.join(tmp, "minimap-wheel.pdf");
  fs.writeFileSync(pdf, samplePdf(60));
  const { page, errors } = await open(await serve(pdf));
  await openMinimap(page, 60);
  await page.waitForFunction(thumbInked, 1);
  const before = await page.evaluate(() => /** @type {HTMLElement} */ (document.getElementById("viewerContainer")).scrollTop);
  const m = await page.locator("#minimap").boundingBox();
  assert.ok(m);
  await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2);
  await page.mouse.wheel(0, 1500);
  await page.waitForFunction(() => /** @type {HTMLElement} */ (document.getElementById("minimap")).scrollTop > 500);
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => /** @type {HTMLElement} */ (document.getElementById("viewerContainer")).scrollTop), before);
  assert.ok(await page.evaluate(() => /** @type {HTMLElement} */ (document.getElementById("minimap")).scrollTop > 500), "the pages' scroll position did not pull it back");

  assert.deepEqual(errors, []);
  await page.close();
});

test("minimap: closed through reloads, it matches the document shown when it opens again", async () => {
  const pdf = path.join(tmp, "minimap-closed-reloads.pdf");
  fs.writeFileSync(pdf, samplePdf(5));
  const { page, errors } = await open(await serve(pdf));
  await openMinimap(page, 5);
  await page.waitForFunction(thumbInked, 1);
  await page.click("#minimapToggle");

  // a rewrite with the same pages, then one with three, the second landscape
  let mark = await count(page);
  fs.writeFileSync(pdf, samplePdf(5, "v2"));
  await page.evaluate(() => /** @type {any} */ (window).__reload());
  await posted(page, { type: "loaded", reload: true }, mark);
  mark = await count(page);
  const boxes = [undefined, { size: /** @type {[number, number]} */ ([792, 612]) }];
  fs.writeFileSync(pdf, makePdf([1, 2, 3].map((p) => sampleLines(p, "v3")), { boxes }));
  await page.evaluate(() => /** @type {any} */ (window).__reload());
  await posted(page, { type: "loaded", reload: true, pages: 3 }, mark);
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#minimap .thumb").count(), 5, "nothing done while closed");

  await openMinimap(page, 3);
  await page.waitForFunction(() => Math.abs(/** @type {HTMLElement} */ (document.querySelector("#minimap .thumb[data-page-number='2']")).clientHeight - (100 * 612) / 792) <= 1);
  for (const n of [1, 2, 3]) await page.waitForFunction(thumbInked, n);
  assert.equal(await page.locator("#minimap .thumb.current").getAttribute("data-page-number"), "1");

  assert.deepEqual(errors, []);
  await page.close();
});

test("minimap: a drag ends when the pointer capture is lost or a move comes without the button; hovering then does not scroll", async () => {
  const pdf = path.join(tmp, "minimap-drag-end.pdf");
  fs.writeFileSync(pdf, samplePdf(10));
  const { page, errors } = await open(await serve(pdf));
  await openMinimap(page, 10);
  const scrollTop = () => page.evaluate(() => /** @type {HTMLElement} */ (document.getElementById("viewerContainer")).scrollTop);
  /** A pointer event of the mouse (pointer 1) at the middle of thumbnail `n`, dispatched in the page. */
  const fire = (/** @type {string} */ type, /** @type {number} */ n, /** @type {number} */ buttons) => page.evaluate(([t, k, b]) => {
    const m = /** @type {HTMLElement} */ (document.getElementById("minimap"));
    const r = /** @type {HTMLElement} */ (m.querySelector(`.thumb[data-page-number='${k}']`)).getBoundingClientRect();
    m.dispatchEvent(new PointerEvent(/** @type {string} */ (t), {
      pointerId: 1, pointerType: "mouse", isPrimary: true, button: -1, buttons: /** @type {number} */ (b), bubbles: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
  }, /** @type {[string, number, number]} */ ([type, n, buttons]));

  for (const end of ["lostpointercapture", "move without the button"]) {
    // a drag that starts on page 5 scrolls there
    const t5 = await page.locator("#minimap .thumb[data-page-number='5']").boundingBox();
    assert.ok(t5);
    await page.mouse.move(t5.x + t5.width / 2, t5.y + t5.height / 2);
    await page.mouse.down();
    await page.waitForFunction(() => /** @type {HTMLElement} */ (document.getElementById("viewerContainer")).scrollTop > 0);
    // then no pointerup reaches the minimap: its capture is taken away (a later move,
    // even with the button down, is not the drag's), or the next move has no button
    // pressed (that move does nothing either)
    if (end === "lostpointercapture") await fire("lostpointercapture", 5, 0);
    else await fire("pointermove", 3, 0);
    const at = await scrollTop();
    const mark = await count(page);
    await fire("pointermove", 1, end === "lostpointercapture" ? 1 : 0);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.equal(await scrollTop(), at, `${end}: the pages did not scroll`);
    assert.equal(await page.evaluate((s) => /** @type {any} */ (window).__posted.slice(s).filter((/** @type {any} */ m) => m.type === "page" && m.page === 1).length, mark), 0, end);
    // release the real button over the pages, and go back to the top for the next round
    await page.mouse.move(400, 400);
    await page.mouse.up();
    await page.evaluate(() => {
      /** @type {HTMLElement} */ (document.getElementById("viewerContainer")).scrollTop = 0;
    });
    await page.waitForFunction(() => /** @type {HTMLElement} */ (document.getElementById("viewerContainer")).scrollTop === 0);
  }

  assert.deepEqual(errors, []);
  await page.close();
});

test("minimap: an own render waiting for idle time when a reload drops the document does not start on the new one before its pages are set up", async () => {
  const pdf = path.join(tmp, "minimap-swap.pdf");
  fs.writeFileSync(pdf, samplePdf(5));
  const { page, errors } = await open(await serve(pdf), manualIdle);
  /** @type {string[]} */
  const warnings = [];
  page.on("console", (m) => {
    if (m.type() === "warning") warnings.push(m.text());
  });
  await openMinimap(page, 5);
  await page.waitForFunction(thumbInked, 1);
  // past the quiet period the minimap asks for idle time for page 3, and waits
  await page.waitForFunction(() => /** @type {any} */ (window).__idlePending(), null, { timeout: 5000 });

  // Idle time comes right after the old document is dropped (setDocument(null) empties
  // #viewer, and a mutation observer runs before pdf.js sets up the new pages): a
  // render started then would ask the two-page document for page 3.
  await page.evaluate(() => {
    const viewer = /** @type {HTMLElement} */ (document.getElementById("viewer"));
    const mo = new MutationObserver(() => {
      if (viewer.querySelector(".page")) return;
      mo.disconnect();
      /** @type {any} */ (window).__idleInWindow = /** @type {any} */ (window).__idlePending();
      /** @type {any} */ (window).__idle();
    });
    mo.observe(viewer, { childList: true });
  });
  fs.writeFileSync(pdf, samplePdf(2, "v2"));
  const mark = await count(page);
  await page.evaluate(() => /** @type {any} */ (window).__reload());
  await posted(page, { type: "loaded", reload: true, pages: 2 }, mark);
  await page.waitForFunction(() => document.querySelectorAll("#minimap .thumb").length === 2);
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).__idleInWindow), false, "the waiting render was dropped with the document");
  const end = Date.now() + 5000;
  while (!(await page.evaluate(thumbInked, 2))) {
    assert.ok(Date.now() < end, "page 2 rendered");
    await page.evaluate(() => /** @type {any} */ (window).__idle());
    await page.waitForTimeout(50);
  }
  assert.deepEqual(warnings.filter((w) => w.startsWith("minimap:")), []);
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).__posted.filter((/** @type {any} */ m) => m.type === "error").length), 0);

  assert.deepEqual(errors, []);
  await page.close();
});
