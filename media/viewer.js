// @ts-check
/**
 * The PDF viewer webview: pdf.js PDFViewer with text layer (selection), annotation layer
 * (highlights, notes, links), find bar and a minimal toolbar. It reports page, page count
 * and selection to the extension, and obeys `load` (initial and on-disk reloads) and
 * `goto`.
 *
 * Messages to the extension: ready, loaded {pages, page, reload}, loadError {message,
 * reload}, page {page}, selection {selection: {text, page} | null}, gotoDone {reqId, page},
 * openLink {url}, openExternalViewer.
 * Messages from the extension: load {data, reload}, goto {page, reqId}.
 */

import { normaliseSelection } from "./textnorm.mjs";

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
// script as text and start it from a blob URL.
{
  const src = await (await fetch(cfg.worker)).text();
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(url, { type: "module" });
}

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

/** @type {any} */
let pdfDocument = null;
let loadGeneration = 0;
/** @type {{page: number, ratio: number, left: number, scale: string} | null} */
let restoreView = null;
let isReload = false;
let lastPosted = "";

/** The visible position: page, offset inside it (fraction of its height), zoom. */
function captureView() {
  const page = pdfViewer.currentPageNumber || 1;
  const view = pdfViewer.getPageView(page - 1);
  if (!view) return null;
  const top = view.div.getBoundingClientRect().top - container.getBoundingClientRect().top;
  const ratio = view.div.clientHeight ? -top / view.div.clientHeight : 0;
  return { page, ratio, left: container.scrollLeft, scale: String(pdfViewer.currentScaleValue || "page-width") };
}

/** @param {{page: number, ratio: number, left: number, scale: string}} v */
function applyView(v) {
  pdfViewer.currentScaleValue = v.scale;
  const page = Math.min(Math.max(1, v.page), pdfViewer.pagesCount);
  const view = pdfViewer.getPageView(page - 1);
  if (!view) return;
  const top = view.div.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollTop += top + v.ratio * view.div.clientHeight;
  container.scrollLeft = v.left;
  pdfViewer.update(); // recompute the current page now rather than on the next scroll event
}

/**
 * Open `data`; on a reload keep the current render until the new file parses, then swap
 * it in at the same place. A file that fails to parse (mid-write) keeps the old render.
 * @param {Uint8Array} data @param {boolean} reload
 */
async function load(data, reload) {
  const gen = ++loadGeneration;
  let doc;
  try {
    doc = await pdfjsLib.getDocument({
      data,
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
    if (gen !== loadGeneration) return;
    const msg = e instanceof Error ? e.message : String(e);
    if (!reload || !pdfDocument) showMessage(`Cannot open this PDF: ${msg}`);
    post({ type: "loadError", message: msg, reload });
    return;
  }
  if (gen !== loadGeneration) {
    void doc.loadingTask.destroy();
    return;
  }
  showMessage("");
  const old = pdfDocument;
  restoreView = reload && old ? captureView() : null;
  isReload = reload;
  pdfDocument = doc;
  pdfViewer.setDocument(doc);
  linkService.setDocument(doc, null);
  if (old) void old.loadingTask.destroy();
}

eventBus.on("pagesinit", () => {
  if (restoreView) applyView(restoreView);
  else pdfViewer.currentScaleValue = "page-width";
  restoreView = null;
  numPages.textContent = `/ ${pdfViewer.pagesCount}`;
  pageInput.value = String(pdfViewer.currentPageNumber);
  post({ type: "loaded", pages: pdfViewer.pagesCount, page: pdfViewer.currentPageNumber, reload: isReload });
  if (!findbar.hidden && findInput.value) find("", false);
});

eventBus.on("pagechanging", (/** @type {{pageNumber: number}} */ { pageNumber }) => {
  pageInput.value = String(pageNumber);
  post({ type: "page", page: pageNumber });
});

eventBus.on("scalechanging", (/** @type {{scale: number}} */ { scale }) => {
  zoomValue.textContent = `${Math.round(scale * 100)}%`;
});

// Keep "fit width" fitting when the editor is resized.
new ResizeObserver(() => {
  const v = pdfViewer.currentScaleValue;
  if (pdfDocument && (v === "page-width" || v === "page-fit" || v === "auto")) pdfViewer.currentScaleValue = v;
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
$("fitWidth").addEventListener("click", () => {
  pdfViewer.currentScaleValue = "page-width";
});
$("openExternal").addEventListener("click", () => post({ type: "openExternalViewer" }));

// External links go through the extension (vscode.env.openExternal); internal links
// (citations, sections) are handled by pdf.js's link service.
container.addEventListener("click", (e) => {
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
  /** @type {{text: string, page: number} | null} */
  let value = null;
  if (sel && !sel.isCollapsed && sel.rangeCount) {
    const range = sel.getRangeAt(0);
    const page = pageOf(range.startContainer) ?? pageOf(sel.anchorNode) ?? pageOf(sel.focusNode);
    const text = normaliseSelection(sel.toString());
    if (page && text) value = { text, page };
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

// ---- messages from the extension -----------------------------------------------------

handle = (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "load") {
    void load(msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data), !!msg.reload);
  } else if (msg.type === "goto") {
    if (pdfDocument && msg.page >= 1 && msg.page <= pdfViewer.pagesCount) pdfViewer.currentPageNumber = msg.page;
    post({ type: "gotoDone", reqId: msg.reqId, page: pdfViewer.currentPageNumber });
  }
};
for (const msg of queued.splice(0)) handle(msg);
post({ type: "ready" });
