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
const { samplePdf } = require("../helpers/pdf");

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

  // the note's popup opens on click and shows the text
  await page.locator(".annotationLayer .textAnnotation").click();
  const popup = page.locator(".annotationLayer .popup:visible", { hasText: "A margin note written by PyMuPDF." });
  await popup.waitFor({ timeout: 5000 });

  // clicking again unpins it; hovering the underline shows the underline's note
  await page.locator(".annotationLayer .textAnnotation").click();
  await popup.waitFor({ state: "hidden", timeout: 5000 });
  await page.locator(".annotationLayer .underlineAnnotation").hover();
  await page.locator(".annotationLayer .popup:visible", { hasText: "An underline written by PyMuPDF." }).waitFor({ timeout: 5000 });

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
