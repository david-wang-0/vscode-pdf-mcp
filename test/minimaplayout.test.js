// @ts-check
/** media/minimaplayout.mjs: the minimap's box over the visible pages, and back. */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../media/minimaplayout.mjs");

// Three pages: portrait, landscape, portrait, 10 px apart in the main view (scale 1.5 of
// 612 x 792 pt) and 8 px apart in the minimap (thumbnails 100 px wide).
const pages = [
  { top: 10, height: 1188, thumbTop: 8, thumbHeight: 129 },
  { top: 1208, height: 918, thumbTop: 145, thumbHeight: 77 },
  { top: 2136, height: 1188, thumbTop: 230, thumbHeight: 129 },
];

/** @param {number} a @param {number} b @param {string} [what] */
const near = (a, b, what = "") => assert.ok(Math.abs(a - b) < 1e-9, `${what} ${a} vs ${b}`);

test("minimap: a page's top maps to its thumbnail's top, the span to the next page onto the span to the next thumbnail", async () => {
  const { mapScrollToMinimap } = await load();
  for (const p of pages) near(mapScrollToMinimap(pages, p.top, 0).top, p.thumbTop, "top");
  // half-way from the landscape page's top to the next page's top
  near(mapScrollToMinimap(pages, (1208 + 2136) / 2, 0).top, (145 + 230) / 2);
  // the last page's own height maps onto its thumbnail's height
  near(mapScrollToMinimap(pages, 2136 + 594, 0).top, 230 + 64.5);
  // a view across the landscape page: top in segment 1, bottom in segment 2
  const box = mapScrollToMinimap(pages, 1208, 1000);
  near(box.top, 145);
  near(box.top + box.height, 230 + ((1208 + 1000 - 2136) / 1188) * 129);
});

test("minimap: the box is clamped above the first page and below the last", async () => {
  const { mapScrollToMinimap } = await load();
  assert.deepEqual(mapScrollToMinimap(pages, 0, 5), { top: 8, height: 0 });
  const end = mapScrollToMinimap(pages, 3000, 800);
  near(end.top + end.height, 230 + 129);
  assert.deepEqual(mapScrollToMinimap(pages, 5000, 800), { top: 359, height: 0 });
});

test("minimap: a minimap point maps back to the pages, clamped at both ends", async () => {
  const { mapMinimapToScroll } = await load();
  for (const p of pages) near(mapMinimapToScroll(pages, p.thumbTop), p.top);
  near(mapMinimapToScroll(pages, (145 + 230) / 2), (1208 + 2136) / 2);
  assert.equal(mapMinimapToScroll(pages, -50), 10);
  assert.equal(mapMinimapToScroll(pages, 2), 10);
  assert.equal(mapMinimapToScroll(pages, 359), 2136 + 1188);
  assert.equal(mapMinimapToScroll(pages, 10000), 2136 + 1188);
});

test("minimap: there and back again lands within a pixel", async () => {
  const { mapScrollToMinimap, mapMinimapToScroll } = await load();
  for (let y = 10; y <= 2136 + 1188; y += 37) {
    const back = mapMinimapToScroll(pages, mapScrollToMinimap(pages, y, 0).top);
    assert.ok(Math.abs(back - y) <= 1, `${y} -> ${back}`);
  }
});

test("minimap: a single page, and no pages", async () => {
  const { mapScrollToMinimap, mapMinimapToScroll } = await load();
  const one = [{ top: 1, height: 1000, thumbTop: 6, thumbHeight: 100 }];
  assert.deepEqual(mapScrollToMinimap(one, 501, 500), { top: 56, height: 50 });
  near(mapMinimapToScroll(one, 31), 251);
  const low = mapScrollToMinimap(one, 901, 500);
  near(low.top, 96);
  near(low.height, 10);
  assert.deepEqual(mapScrollToMinimap([], 100, 500), { top: 0, height: 0 });
  assert.equal(mapMinimapToScroll([], 100), 0);
});

test("minimap: a zero-height page or thumbnail gives finite positions, in order", async () => {
  const { mapScrollToMinimap, mapMinimapToScroll } = await load();
  // page 2 has no height and starts where page 3 does; page 3's thumbnail has none
  const odd = [
    { top: 0, height: 100, thumbTop: 0, thumbHeight: 10 },
    { top: 100, height: 0, thumbTop: 10, thumbHeight: 10 },
    { top: 100, height: 100, thumbTop: 20, thumbHeight: 0 },
  ];
  let last = -Infinity;
  for (let y = -10; y <= 220; y += 5) {
    const box = mapScrollToMinimap(odd, y, 30);
    assert.ok(Number.isFinite(box.top) && Number.isFinite(box.height) && box.height >= 0, `${y}: ${JSON.stringify(box)}`);
    assert.ok(box.top >= last, `${y}: ${box.top} after ${last}`);
    last = box.top;
  }
  last = -Infinity;
  for (let y = -5; y <= 30; y += 1) {
    const back = mapMinimapToScroll(odd, y);
    assert.ok(Number.isFinite(back) && back >= last, `${y}: ${back} after ${last}`);
    last = back;
  }
});
