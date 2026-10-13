// @ts-check
/**
 * The PDF viewer webview: pdf.js PDFViewer with text layer (selection), annotation layer
 * (highlights, notes, links), find bar and a minimal toolbar. It reports page, page count
 * and selection to the extension, and obeys `load` (initial and on-disk reloads) and
 * `goto`.
 *
 * Messages to the extension: ready, loaded {pages, page, reload}, loadError {message,
 * reload}, page {page}, selection {selection: {text, page, parts?} | null} (`parts`: the
 * selection's SyncTeX rects per page, when the PDF has SyncTeX data), gotoDone {reqId,
 * page}, openLink {url}, openExternalViewer, and the messages of annotate.mjs and
 * synctex.mjs.
 * Messages from the extension: load {data, reload}, goto {page, reqId}, synctexShow
 * {page, rects, reqId} (a forward search: goto plus a flash; answered with gotoDone),
 * visibility {visible}, and the messages of annotate.mjs and synctex.mjs.
 */

import { normaliseSelection } from "./textnorm.mjs";
import { setupMarking } from "./annotate.mjs";
import { setupSynctex } from "./synctex.mjs";

// @ts-ignore provided by VS Code (or the development harness)
const vscode = acquireVsCodeApi();
/** @type {Record<string, string>} */
const cfg = JSON.parse(document.body.dataset.config || "{}");

/** @param {any} msg */
const post = (msg) => vscode.postMessage(msg);

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const container = /** @type {HTMLDivElement} */ ($("viewerContainer"));
const pageInput = /** @type {HTMLInputElement} */ ($("pageNumber"));
const numPages = $("numPages");
const zoomValue = $("zoomValue");
const message = $("message");
const findbar = $("findbar");
const findInput = /** @type {HTMLInputElement} */ ($("findInput"));
const findResult = $("findResult");

/** @param {string} text */
function showMessage(text) {
  message.textContent = text;
  message.hidden = !text;
}

window.addEventListener("error", (e) => post({ type: "error", message: String(e.message) }));
window.addEventListener("unhandledrejection", (e) => post({ type: "error", message: String(e.reason?.message || e.reason) }));

// Messages can arrive while pdf.js is still loading; queue them until we are ready.
/** @type {any[]} */
const queued = [];
/** @type {((msg: any) => void) | null} */
let handle = null;
window.addEventListener("message", (e) => {
  if (handle) handle(e.data);
  else queued.push(e.data);
});

const pdfjsLib = await import(cfg.pdfjs);
const { EventBus, PDFLinkService, PDFFindController, PDFViewer } = await import(cfg.pdfViewer);

// The worker must be same-origin, and the webview's resources are not: load the worker
// script as text and start it from a blob URL. One PDFWorker serves every (re)load; a
// worker passed to getDocument outlives the documents destroyed on reload.
const pdfWorker = await (async () => {
  const src = await (await fetch(cfg.worker)).text();
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  return new pdfjsLib.PDFWorker({ port: new Worker(url, { type: "module" }) });
})();

const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus });
const findController = new PDFFindController({ eventBus, linkService });
const pdfViewer = new PDFViewer({
  container,
  eventBus,
  linkService,
  findController,
  textLayerMode: 1,
  annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
  imageResourcesPath: cfg.imageResourcesPath,
});
linkService.setViewer(pdfViewer);

/**
 * @typedef {{page: number, ratio: number, left: number, scale: string}} View
 */

/** @type {any} */
let pdfDocument = null;
let loadGeneration = 0;
/** @type {View | null} */
let restoreView = null;
let isReload = false;
let lastPosted = "";
/** The last position seen while visible: a hidden tab has no layout to measure. @type {View | null} */
let lastView = null;
/** A reloaded document parsed while the tab was hidden, swapped in when it is shown. @type {any} */
let deferred = null;
/** A goto received while hidden, re-applied when shown. @type {number | null} */
let pendingPage = null;
/** A forward search's flash received before the pages could show it. @type {{page: number, rects: number[][], anchor?: any, near?: any} | null} */
let pendingFlash = null;

/** Whether VS Code shows this tab (told by the extension); a hidden tab may still have a layout. */
let panelVisible = true;
const isVisible = () => panelVisible && container.clientWidth > 0 && container.clientHeight > 0;

/** Things that wait for the tab to be shown: a deferred reload, a goto made while hidden. */
function onShown() {
  if (!isVisible()) return;
  if (deferred) {
    showDeferred();
    return;
  }
  if (pendingFlash) {
    const f = pendingFlash;
    pendingFlash = null;
    pendingPage = null;
    synctex.flash(f.page, f.rects, f);
    return;
  }
  if (pendingPage !== null) {
    pdfViewer.currentPageNumber = pendingPage;
    pendingPage = null;
  }
}

/** The visible position: page, offset inside it (fraction of its height), zoom. @returns {View | null} */
function captureView() {
  const page = pdfViewer.currentPageNumber || 1;
  const view = pdfViewer.getPageView(page - 1);
  if (!view || !isVisible()) return null;
  const top = view.div.getBoundingClientRect().top - container.getBoundingClientRect().top;
  const ratio = view.div.clientHeight ? -top / view.div.clientHeight : 0;
  return { page, ratio, left: container.scrollLeft, scale: String(pdfViewer.currentScaleValue || "page-width") };
}

let rememberQueued = false;
function remember() {
  if (rememberQueued) return;
  rememberQueued = true;
  requestAnimationFrame(() => {
    rememberQueued = false;
    if (pdfDocument && !deferred && !restoreView) lastView = captureView() || lastView;
  });
}
container.addEventListener("scroll", remember, { passive: true });

/**
 * Go back to `v`, through pdf.js's own XYZ destination so the current page is set even
 * before the next scroll event.
 * @param {View} v
 */
function applyView(v) {
  pdfViewer.currentScaleValue = v.scale;
  const page = Math.min(Math.max(1, v.page), pdfViewer.pagesCount);
  const view = pdfViewer.getPageView(page - 1);
  if (!view) {
    pdfViewer.currentPageNumber = page;
    return;
  }
  const [x, y] = view.viewport.convertToPdfPoint(0, v.ratio * view.viewport.height);
  pdfViewer.scrollPageIntoView({ pageNumber: page, destArray: [null, { name: "XYZ" }, x, y, null], allowNegativeOffset: true });
  container.scrollLeft = v.left;
}

/**
 * pdf.js 5.4 keeps the page count in a global PagesMapper that the most recently parsed
 * document sets. Keep it equal to the shown document's count, whatever was parsed since.
 */
function syncPageCount() {
  const mapper = pdfjsLib.PagesMapper?.instance;
  if (mapper && pdfDocument) mapper.pagesNumber = pdfDocument.numPages;
}

/** Show `doc`, restoring `view` (or fitting the width) once its pages are laid out. @param {any} doc @param {View | null} view @param {boolean} reload */
function swapIn(doc, view, reload) {
  const old = pdfDocument;
  restoreView = view;
  isReload = reload;
  pdfDocument = doc;
  if (old) {
    // Unloading the old document zeroes pdf.js's global page count; give it back.
    pdfViewer.setDocument(null);
    syncPageCount();
  }
  pdfViewer.setDocument(doc);
  linkService.setDocument(doc, null);
  if (old && old !== doc) void old.loadingTask.destroy();
}

/**
 * Open `data`; on a reload keep the current render until the new file parses, then swap
 * it in at the same place. A file that fails to parse (mid-write) keeps the old render.
 * A reload of a hidden tab is parsed now (so the page count is current) and shown when
 * the tab is shown.
 * @param {Uint8Array} data @param {boolean} reload
 */
async function load(data, reload) {
  const gen = ++loadGeneration;
  let doc;
  try {
    doc = await pdfjsLib.getDocument({
      data,
      worker: pdfWorker,
      cMapUrl: cfg.cMapUrl,
      cMapPacked: true,
      standardFontDataUrl: cfg.standardFontDataUrl,
      wasmUrl: cfg.wasmUrl,
      iccUrl: cfg.iccUrl,
      useWorkerFetch: false,
      isEvalSupported: false,
      enableXfa: false,
    }).promise;
  } catch (e) {
    syncPageCount();
    if (gen !== loadGeneration) return;
    const msg = e instanceof Error ? e.message : String(e);
    if (!reload || !pdfDocument) showMessage(`Cannot open this PDF: ${msg}`);
    post({ type: "loadError", message: msg, reload });
    return;
  }
  if (gen !== loadGeneration) {
    void doc.loadingTask.destroy();
    syncPageCount();
    return;
  }
  showMessage("");
  if (reload && pdfDocument && !isVisible()) {
    if (deferred) void deferred.loadingTask.destroy();
    deferred = doc;
    syncPageCount();
    const page = Math.min(lastView?.page ?? pdfViewer.currentPageNumber ?? 1, doc.numPages);
    post({ type: "loaded", pages: doc.numPages, page, reload: true });
    return;
  }
  if (deferred) void deferred.loadingTask.destroy();
  deferred = null;
  swapIn(doc, reload && pdfDocument ? captureView() || lastView : null, reload);
}

/** Swap in a reload that arrived while the tab was hidden. */
function showDeferred() {
  if (!deferred || !isVisible()) return;
  const doc = deferred;
  deferred = null;
  swapIn(doc, lastView, true);
}

eventBus.on("pagesinit", () => {
  if (restoreView) applyView(restoreView);
  else pdfViewer.currentScaleValue = "page-width";
  restoreView = null;
  numPages.textContent = `/ ${pdfViewer.pagesCount}`;
  pageInput.value = String(pdfViewer.currentPageNumber);
  lastView = captureView() || lastView;
  post({ type: "loaded", pages: pdfViewer.pagesCount, page: pdfViewer.currentPageNumber, reload: isReload });
  if (!findbar.hidden && findInput.value) find("", false);
  if (pendingFlash) requestAnimationFrame(onShown);
});

eventBus.on("pagechanging", (/** @type {{pageNumber: number}} */ { pageNumber }) => {
  pageInput.value = String(pageNumber);
  if (!deferred && !restoreView) {
    post({ type: "page", page: pageNumber });
    remember();
  }
});

eventBus.on("scalechanging", (/** @type {{scale: number}} */ { scale }) => {
  zoomValue.textContent = `${Math.round(scale * 100)}%`;
  remember();
});

// Keep "fit width" fitting when the editor is resized.
new ResizeObserver(() => {
  if (!isVisible()) return;
  if (!deferred) {
    const v = pdfViewer.currentScaleValue;
    if (pdfDocument && (v === "page-width" || v === "page-fit" || v === "auto")) pdfViewer.currentScaleValue = v;
  }
  onShown();
}).observe(container);

// ---- toolbar -------------------------------------------------------------------------

pageInput.addEventListener("change", () => {
  const n = parseInt(pageInput.value, 10);
  if (Number.isInteger(n) && n >= 1 && n <= pdfViewer.pagesCount) pdfViewer.currentPageNumber = n;
  else pageInput.value = String(pdfViewer.currentPageNumber);
});
pageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") pageInput.dispatchEvent(new Event("change"));
});
$("zoomIn").addEventListener("click", () => pdfViewer.increaseScale());
$("zoomOut").addEventListener("click", () => pdfViewer.decreaseScale());
// Ctrl+wheel (and touchpad pinch, which Chromium reports as Ctrl+wheel) zooms around the
// pointer. The PDFViewer component, unlike pdf.js's full viewer app, has no wheel zoom.
container.addEventListener("wheel", (e) => {
  if (!(e.ctrlKey || e.metaKey) || !pdfDocument) return;
  e.preventDefault();
  const pixels = e.deltaY * (e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 400 : 1);
  pdfViewer.updateScale({ scaleFactor: Math.exp(-pixels / 400), origin: [e.clientX, e.clientY] });
}, { passive: false });
$("fitWidth").addEventListener("click", () => {
  pdfViewer.currentScaleValue = "page-width";
});
$("openExternal").addEventListener("click", () => post({ type: "openExternalViewer" }));

// External links go through the extension (vscode.env.openExternal); internal links
// (citations, sections) are handled by pdf.js's link service.
container.addEventListener("click", (e) => {
  // Ctrl+click is SyncTeX's (synctex.mjs) when the PDF has SyncTeX data
  if ((e.ctrlKey || e.metaKey) && synctex.available()) return;
  const a = /** @type {HTMLElement | null} */ (e.target instanceof Element ? e.target.closest("a[href]") : null);
  if (!a) return;
  const href = a.getAttribute("href") || "";
  if (/^(https?|mailto):/i.test(href)) {
    e.preventDefault();
    e.stopPropagation();
    post({ type: "openLink", url: href });
  }
}, true);

// ---- find (Ctrl+F) -------------------------------------------------------------------

/** @param {string} type "" for a new query, "again" for next/previous @param {boolean} previous */
function find(type, previous) {
  eventBus.dispatch("find", {
    source: findbar,
    type,
    query: findInput.value,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious: previous,
    matchDiacritics: false,
  });
}
function openFind() {
  findbar.hidden = false;
  document.body.classList.add("finding");
  const sel = window.getSelection()?.toString().trim();
  if (sel && sel.length < 200 && !sel.includes("\n")) findInput.value = sel;
  findInput.focus();
  findInput.select();
  if (findInput.value) find("", false);
}
function closeFind() {
  findbar.hidden = true;
  document.body.classList.remove("finding");
  eventBus.dispatch("findbarclose", { source: findbar });
  container.focus();
}
findInput.addEventListener("input", () => find("", false));
findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    find("again", e.shiftKey);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeFind();
  }
});
$("findNext").addEventListener("click", () => find("again", false));
$("findPrev").addEventListener("click", () => find("again", true));
$("findClose").addEventListener("click", closeFind);
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    e.stopPropagation();
    openFind();
  } else if (e.key === "Escape" && !findbar.hidden) {
    closeFind();
  }
}, true);
/** @param {{matchesCount: {current: number, total: number}}} e */
function showMatches({ matchesCount }) {
  const { current, total } = matchesCount || { current: 0, total: 0 };
  findResult.textContent = !findInput.value ? "" : total ? `${current} of ${total}` : "not found";
}
eventBus.on("updatefindmatchescount", showMatches);
eventBus.on("updatefindcontrolstate", showMatches);

// ---- selection -----------------------------------------------------------------------

/** @param {Node | null} node */
function pageOf(node) {
  const el = node && (node.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (node) : node.parentElement);
  const page = el?.closest(".page[data-page-number]");
  return page ? parseInt(/** @type {HTMLElement} */ (page).dataset.pageNumber || "", 10) : null;
}

function reportSelection() {
  const sel = window.getSelection();
  /** @type {{text: string, page: number, parts?: {page: number, rects: number[][]}[]} | null} */
  let value = null;
  if (sel && !sel.isCollapsed && sel.rangeCount) {
    const range = sel.getRangeAt(0);
    const page = pageOf(range.startContainer) ?? pageOf(sel.anchorNode) ?? pageOf(sel.focusNode);
    const text = normaliseSelection(sel.toString());
    if (page && text) {
      value = { text, page };
      const parts = synctex.selectionParts();
      if (parts && parts.length) value.parts = parts;
    }
  }
  const key = JSON.stringify(value);
  if (key === lastPosted) return;
  lastPosted = key;
  post({ type: "selection", selection: value });
}
/** @type {ReturnType<typeof setTimeout> | undefined} */
let selTimer;
document.addEventListener("selectionchange", () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(reportSelection, 150);
});

// ---- marking (annotate.mjs) ------------------------------------------------------------

const marking = setupMarking({ pdfViewer, eventBus, container, post, getDocument: () => pdfDocument, vscode });

// ---- SyncTeX (synctex.mjs) ---------------------------------------------------------------

const synctex = setupSynctex({ pdfViewer, eventBus, container, post });
// SyncTeX data arrived (or went): publish the selection again, with (or without) its rects
synctex.onAvailabilityChange(() => {
  lastPosted = "";
  reportSelection();
});

// ---- messages from the extension -----------------------------------------------------

handle = (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (marking.handle(msg)) return;
  if (synctex.handle(msg)) return;
  if (msg.type === "load") {
    void load(msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data), !!msg.reload);
  } else if (msg.type === "visibility") {
    if (!msg.visible && panelVisible && !deferred && !restoreView) lastView = captureView() || lastView;
    panelVisible = !!msg.visible;
    if (panelVisible) requestAnimationFrame(onShown);
  } else if (msg.type === "goto" || msg.type === "synctexShow") {
    const forward = msg.type === "synctexShow";
    showDeferred();
    if (deferred || restoreView) {
      // Not laid out yet (hidden, or pages still initialising): go there when it is.
      const v = { page: msg.page, ratio: 0, left: 0, scale: (restoreView || lastView)?.scale || "page-width" };
      if (restoreView) restoreView = v;
      else lastView = v;
      if (forward) pendingFlash = { page: msg.page, rects: msg.rects, anchor: msg.anchor, near: msg.near };
      post({ type: "gotoDone", reqId: msg.reqId, page: msg.page });
      return;
    }
    if (pdfDocument && msg.page >= 1 && msg.page <= pdfViewer.pagesCount) {
      if (forward && isVisible()) synctex.flash(msg.page, msg.rects, msg);
      else pdfViewer.currentPageNumber = msg.page;
      if (!isVisible()) {
        // scroll again (and flash) once there is a layout
        pendingPage = msg.page;
        if (forward) pendingFlash = { page: msg.page, rects: msg.rects, anchor: msg.anchor, near: msg.near };
      }
      lastView = captureView() || { page: msg.page, ratio: 0, left: 0, scale: lastView?.scale || "page-width" };
    }
    post({ type: "gotoDone", reqId: msg.reqId, page: pdfViewer.currentPageNumber });
  }
};
for (const msg of queued.splice(0)) handle(msg);
post({ type: "ready" });
