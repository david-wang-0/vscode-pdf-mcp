// @ts-check
/**
 * Webview check outside VS Code: serves media/ + pdf.js through scripts/serve-webview.js
 * (the real HTML and CSP, a mocked acquireVsCodeApi) and drives it in headless Chromium.
 *
 *   npm run test:webview
 *
 * Needs playwright-core (a devDependency) and a Chromium: set CHROMIUM to its executable,
 * else Playwright's own download is used. Set VPDF_PYTHON to a Python with pymupdf to also
 * check PyMuPDF-written annotations (underline, Text note) and links.
 */
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { chromium } = require("playwright-core");
const { samplePdf, threadPdf } = require("../helpers/pdf");

const root = path.resolve(__dirname, "../..");
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

/** @param {string} url */
async function open(url) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  /** @type {string[]} */
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
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

  // Open in Okular button
  mark = await count(page);
  await page.click("#openExternal");
  await posted(page, { type: "openExternalViewer" }, mark);

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

test("PyMuPDF-written underline and Text note render; links work", { skip: !process.env.VPDF_PYTHON && "set VPDF_PYTHON to a python with pymupdf" }, async () => {
  const pdf = path.join(tmp, "annotated.pdf");
  execFileSync(/** @type {string} */ (process.env.VPDF_PYTHON), ["-I", path.join(root, "scripts/make-annotated-pdf.py"), pdf]);
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
