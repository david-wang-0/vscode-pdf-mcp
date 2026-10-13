// @ts-check
/** extension/sourcesync.js: when the marks are copied into the LaTeX source. */
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SourceSync, changedFiles, sourcesAmong, synctexSig } = require("../extension/sourcesync");

const PDF = "/papers/paper.pdf";
const NO_PKG = "/papers/paper.tex does not load the pdfnotes package: add \\usepackage{pdfnotes} to its preamble";
const DEBOUNCE = 20;
/** @param {number} ms */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vpdf-sourcesync-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** @param {any} [over] */
function report(over = {}) {
  return { source: "paper.tex", inserted: [], updated: [], removed: [], fallback: [], skipped: [], ...over };
}

/**
 * A SourceSync with recording hooks; `world` is what the hooks read and can be changed.
 * @param {Partial<import("../extension/sourcesync").Hooks>} [over]
 */
function setup(over = {}) {
  const world = {
    version: 2,
    enabled: true,
    sig: /** @type {string | null} */ ("paper.synctex.gz:1:100"),
    dirty: /** @type {string[]} */ ([]),
    /** @type {(pdf: string) => Promise<any>} */
    respond: async () => report({ inserted: [{ id: "a1", file: "paper.tex", line: 3, macro: "pdfmark" }] }),
  };
  const calls = { requests: /** @type {string[]} */ ([]), synced: /** @type {any[]} */ ([]), noPkg: /** @type {string[]} */ ([]),
    errors: /** @type {string[]} */ ([]), log: /** @type {string[]} */ ([]), running: 0, maxRunning: 0 };
  const sync = new SourceSync({
    request: async (pdf) => {
      calls.requests.push(pdf);
      calls.running++;
      calls.maxRunning = Math.max(calls.maxRunning, calls.running);
      try {
        return await world.respond(pdf);
      } finally {
        calls.running--;
      }
    },
    version: async () => world.version,
    dirtySources: () => world.dirty,
    enabled: () => world.enabled,
    synctexSig: () => world.sig,
    onSynced: (pdf, r) => calls.synced.push({ pdf, r }),
    onNoPdfnotes: (pdf) => calls.noPkg.push(pdf),
    onError: (pdf, m) => calls.errors.push(`${pdf}: ${m}`),
    log: (m) => calls.log.push(m),
    debounceMs: DEBOUNCE,
    ...over,
  });
  return { sync, world, calls };
}

test("source sync: a burst of writes gives one sync, after the last", async () => {
  const { sync, calls } = setup();
  sync.schedule(PDF);
  await delay(DEBOUNCE / 2);
  sync.schedule(PDF);
  sync.schedule(PDF);
  assert.equal(calls.requests.length, 0, "not before the debounce");
  await sync.settled(PDF);
  assert.deepEqual(calls.requests, [PDF]);
  assert.equal(calls.synced.length, 1);
  assert.deepEqual(changedFiles(calls.synced[0].r), ["paper.tex"]);
});

test("source sync: never two syncs of one PDF at a time; one asked for meanwhile runs after", async () => {
  /** @type {() => void} */
  let release = () => {};
  const { sync, world, calls } = setup();
  world.respond = () => new Promise((r) => {
    release = () => r(report());
  });
  sync.schedule(PDF);
  await delay(DEBOUNCE * 2);
  assert.equal(calls.requests.length, 1);
  sync.schedule(PDF);
  sync.schedule(PDF);
  await delay(DEBOUNCE * 3);
  assert.equal(calls.requests.length, 1, "waits for the running sync");
  world.respond = async () => report();
  release();
  await sync.settled(PDF);
  assert.equal(calls.requests.length, 2, "the writes meanwhile give one more sync");
  assert.equal(calls.maxRunning, 1);
  assert.equal(calls.synced.length, 0, "nothing changed: no message");
});

test("source sync: other PDFs sync independently", async () => {
  const { sync, calls } = setup();
  sync.schedule(PDF);
  sync.schedule("/papers/other.pdf");
  await Promise.all([sync.settled(PDF), sync.settled("/papers/other.pdf")]);
  assert.deepEqual(calls.requests.sort(), ["/papers/other.pdf", PDF]);
});

test("source sync: an edit service older than protocol 2 is never asked", async () => {
  const { sync, world, calls } = setup();
  world.version = 1;
  sync.schedule(PDF);
  await sync.settled(PDF);
  sync.schedule(PDF);
  await sync.settled(PDF);
  assert.deepEqual(calls.requests, []);
  assert.equal(calls.log.filter((l) => /protocol 1/.test(l)).length, 1, "said once");
});

test("source sync: no SyncTeX file next to the PDF, no sync", async () => {
  const { sync, world, calls } = setup();
  world.sig = null;
  sync.schedule(PDF);
  await sync.settled(PDF);
  assert.deepEqual(calls.requests, []);
  assert.match(calls.log.join("\n"), /no SyncTeX file/);
});

test("source sync: switched off, nothing is scheduled; switched off while pending, dropped", async () => {
  const { sync, world, calls } = setup();
  world.enabled = false;
  sync.schedule(PDF);
  await sync.settled(PDF);
  assert.deepEqual(calls.requests, []);
  world.enabled = true;
  world.dirty = ["/papers/paper.tex"];
  sync.schedule(PDF);
  await sync.settled(PDF);
  assert.ok(sync.isPending(PDF));
  world.enabled = false;
  world.dirty = [];
  sync.recheck();
  await sync.settled(PDF);
  assert.equal(sync.isPending(PDF), false);
  assert.deepEqual(calls.requests, []);
});

test("source sync: pending while a source is unsaved, run when it is saved, not before", async () => {
  const { sync, world, calls } = setup();
  world.dirty = ["/papers/paper.tex", "/papers/intro.tex"];
  sync.schedule(PDF);
  await sync.settled(PDF);
  assert.deepEqual(calls.requests, []);
  assert.equal(sync.isPending(PDF), true);
  assert.match(calls.log.join("\n"), /pending until these are saved: \/papers\/paper\.tex, \/papers\/intro\.tex/);
  // more marks meanwhile: still pending, still no sync
  sync.schedule(PDF);
  await sync.settled(PDF);
  world.dirty = ["/papers/intro.tex"];
  sync.recheck(); // one saved, the other not yet
  await sync.settled(PDF);
  assert.deepEqual(calls.requests, []);
  assert.equal(sync.isPending(PDF), true);
  world.dirty = [];
  sync.recheck();
  assert.equal(sync.isPending(PDF), false);
  await sync.settled(PDF);
  assert.deepEqual(calls.requests, [PDF], "one sync once all are saved");
  sync.recheck();
  await sync.settled(PDF);
  assert.deepEqual(calls.requests, [PDF], "a later save does not sync again");
});

test("source sync: the checks run in the PDF's write queue, right before the request", async () => {
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /** @type {() => void} */
  let releaseWrite = () => {};
  const { sync, world, calls } = setup({
    serial: (_pdf, fn) => {
      const run = queue.then(fn, fn);
      queue = run.catch(() => {});
      return run;
    },
  });
  // a write is still running when the debounce ends
  queue = new Promise((r) => {
    releaseWrite = () => r(undefined);
  });
  sync.schedule(PDF);
  await delay(DEBOUNCE * 3);
  world.dirty = ["/papers/paper.tex"]; // the user starts typing meanwhile
  releaseWrite();
  await sync.settled(PDF);
  assert.deepEqual(calls.requests, [], "the sync saw the unsaved source");
  assert.equal(sync.isPending(PDF), true);
});

test("source sync: no source loads pdfnotes: told once, not asked again until the SyncTeX file changes", async () => {
  const { sync, world, calls } = setup();
  world.respond = async () => {
    throw new Error(NO_PKG);
  };
  sync.schedule(PDF);
  await sync.settled(PDF);
  assert.deepEqual(calls.requests, [PDF]);
  assert.deepEqual(calls.noPkg, [PDF]);
  assert.deepEqual(calls.errors, [], "not a warning");
  sync.schedule(PDF);
  await sync.settled(PDF);
  assert.deepEqual(calls.requests, [PDF], "remembered");
  // a rebuild (new SyncTeX file): asked again, still no pdfnotes, not told again
  world.sig = "paper.synctex.gz:2:120";
  sync.schedule(PDF);
  await sync.settled(PDF);
  assert.deepEqual(calls.requests, [PDF, PDF]);
  assert.deepEqual(calls.noPkg, [PDF]);
  // the package added and rebuilt: syncs
  world.sig = "paper.synctex.gz:3:140";
  world.respond = async () => report({ inserted: [{ id: "a1", file: "paper.tex", line: 3, macro: "pdfmark" }] });
  sync.schedule(PDF);
  await sync.settled(PDF);
  assert.equal(calls.requests.length, 3);
  assert.equal(calls.synced.length, 1);
});

test("source sync: other errors warn once per PDF, and the next write tries again", async () => {
  const { sync, world, calls } = setup();
  world.respond = async () => {
    throw new Error("synctex not found on PATH (it comes with TeX Live)");
  };
  for (const pdf of [PDF, PDF, "/papers/other.pdf"]) {
    sync.schedule(pdf);
    await sync.settled(pdf);
  }
  assert.equal(calls.requests.length, 3);
  assert.deepEqual(calls.errors, [`${PDF}: synctex not found on PATH (it comes with TeX Live)`,
    "/papers/other.pdf: synctex not found on PATH (it comes with TeX Live)"]);
  assert.equal(calls.log.filter((l) => /failed: synctex not found/.test(l)).length, 3, "each traced");
});

test("source sync: a report without a source or without changes shows nothing", async () => {
  const { sync, world, calls } = setup();
  world.respond = async () => ({ source: null, reason: "no SyncTeX file next to the PDF (build with -synctex=1)" });
  sync.schedule(PDF);
  await sync.settled(PDF);
  world.respond = async () => report({ skipped: [{ xref: 12, page: 1, subtype: "Ink", reason: "Ink annotations have no pdfnotes macro" }] });
  sync.schedule(PDF);
  await sync.settled(PDF);
  assert.equal(calls.requests.length, 2);
  assert.equal(calls.synced.length, 0);
  assert.match(calls.log.join("\n"), /build with -synctex=1/);
  assert.match(calls.log.join("\n"), /skipped xref 12 \(page 1, Ink\)/);
  // removals alone are a change too
  world.respond = async () => report({ removed: [{ id: "a1", file: "sec/intro.tex", line: 9, macro: "pdfmark" }] });
  sync.schedule(PDF);
  await sync.settled(PDF);
  assert.deepEqual(changedFiles(calls.synced[0].r), ["sec/intro.tex"]);
});

test("source sync: dispose stops what is scheduled", async () => {
  const { sync, calls } = setup();
  sync.schedule(PDF);
  sync.dispose();
  await delay(DEBOUNCE * 3);
  assert.deepEqual(calls.requests, []);
});

test("sourcesAmong: the dirty files in the SyncTeX data, else LaTeX files under the PDF's directory", () => {
  const data = { tagsOf: (/** @type {string} */ f) => (["/papers/paper.tex", "/papers/sec/intro.tex"].includes(f) ? [1] : []) };
  const dirty = ["/papers/paper.tex", "/papers/notes.tex", "/papers/sec/intro.tex", "/elsewhere/x.tex"];
  assert.deepEqual(sourcesAmong(PDF, data, dirty), ["/papers/paper.tex", "/papers/sec/intro.tex"]);
  assert.deepEqual(sourcesAmong(PDF, null, [...dirty, "/papers/refs.bib", "/papers/todo.md", "/papersX/a.tex"]),
    ["/papers/paper.tex", "/papers/notes.tex", "/papers/sec/intro.tex", "/papers/refs.bib"]);
});

test("synctexSig: changes when the SyncTeX file is rewritten, null without one", () => {
  const pdf = path.join(tmp, "doc.pdf");
  assert.equal(synctexSig(pdf), null);
  const stx = path.join(tmp, "doc.synctex.gz");
  fs.writeFileSync(stx, "a");
  const a = synctexSig(pdf);
  assert.ok(a);
  fs.writeFileSync(stx, "bb");
  assert.notEqual(synctexSig(pdf), a);
});
