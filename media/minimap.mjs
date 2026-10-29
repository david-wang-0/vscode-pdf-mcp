// @ts-check
/**
 * The minimap: a column of page thumbnails to the right of the pages, with a box over the
 * part of the document on screen. A click in it scrolls the pages so that the point is in
 * the middle of the view; a drag keeps doing so. The toolbar's *Minimap* button shows and
 * hides it; it is on by default and remembered (`minimapOpen` in the webview state, next
 * to annotate.mjs's preferences).
 *
 * Thumbnails are copied from the main view: each page it renders is drawn, scaled down,
 * into that page's thumbnail. Pages the main view has not shown are rendered here, lazily
 * (only those in or near the minimap's visible part), one at a time, and only when the
 * viewer is idle: when pdf.js's rendering queue has nothing of its own to draw (the
 * minimap is registered as its thumbnail viewer), never within QUIET_MS of a scroll or
 * zoom, and at the browser's idle time. The marks are drawn over the thumbnails from
 * annotate.mjs's model, as coloured rects. A reload whose pages have the same sizes
 * (every mark rewrites the file) keeps the thumbnails on screen: the pages the main view
 * draws again refresh theirs, the others are re-rendered lazily.
 *
 * In a long document, thumbnails far from the minimap's visible part (EVICT_DISTANCE
 * pages from the nearest one in or near it) are emptied a second after the minimap stops
 * moving, and come back through the same two paths when they are near view again.
 *
 * The geometry the box needs (where each page and thumbnail is) is measured once and
 * kept until the layout changes, so a scroll frame reads only scroll positions.
 *
 * No messages to or from the extension. Events it listens to: pagesdestroy, pagesinit,
 * pagesloaded, pagerendered, pagechanging, scalechanging, rotationchanging, and
 * annotationsrebuilt {anns} (annotate.mjs).
 */

import { mapScrollToMinimap, mapMinimapToScroll } from "./minimaplayout.mjs";
import { hex, normRect, quadRect } from "./marking.mjs";

/** @typedef {import("./marking.mjs").Ann} Ann */
/** @typedef {import("./minimaplayout.mjs").PageSpan} PageSpan */
/**
 * A page's thumbnail. `w` and `h` are the page's size as shown (rotated), in PDF points;
 * `rendered`: the canvas has an image; `stale`: of an earlier version of the file.
 * @typedef {{el: HTMLDivElement, canvas: HTMLCanvasElement, overlay: HTMLDivElement,
 *   rendered: boolean, stale: boolean, task: any, w: number, h: number}} Thumb
 */

/** Thumbnail width (CSS px). */
const THUMB_W = 100;
/** Thumbnails this far outside the minimap's visible part are rendered too (CSS px). */
const AHEAD_PX = 200;
/** Longest wait for an idle moment before the next own render starts anyway (ms). */
const IDLE_TIMEOUT_MS = 200;
/** No own render starts until this long after the last scroll or zoom of the pages (ms). */
const QUIET_MS = 250;
/** Thumbnails start after this if the main view renders no page first (ms). */
const START_FALLBACK_MS = 300;
/** After a wheel or pointer action in the minimap, it does not follow the pages for this long (ms). */
const USER_SCROLL_MS = 500;
/**
 * A thumbnail more than this many pages from the nearest one in or near the minimap's
 * visible part is emptied (its canvas back to 1x1), unless it is the current page. A
 * rendered thumbnail holds about 52 KB at a device pixel ratio of 1 and 210 KB at 2, so a
 * book keeps about the visible part and 40 pages each side (4 to 17 MB) rather than every
 * page it has shown; a paper of up to 40 pages never loses one.
 */
const EVICT_DISTANCE = 40;
/** The eviction sweep runs this long after the set of pages near view last changed (ms). */
const EVICT_DELAY_MS = 1000;
/** pdf.js's RenderingStates.FINISHED (not exported by the viewer component's API we use). */
const FINISHED = 3;
/** Colour of a mark without one. */
const NO_COLOR = "#808080";

/**
 * Run `fn` when the browser is idle (at the latest after IDLE_TIMEOUT_MS).
 * @param {() => void} fn @returns {() => void} cancels it
 */
function whenIdle(fn) {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(fn, { timeout: IDLE_TIMEOUT_MS });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(fn, 50);
  return () => clearTimeout(id);
}

/** Thumbnail height (CSS px) of a page of size `s`. @param {{w: number, h: number}} s */
const thumbHeight = (s) => Math.max(1, Math.round((THUMB_W * s.h) / s.w));

/**
 * @param {{pdfViewer: any, eventBus: any, container: HTMLElement, getDocument: () => any,
 *          vscode: any, isVisible: () => boolean, pdfjsLib: any}} ctx
 */
export function setupMinimap({ pdfViewer, eventBus, container, getDocument, vscode, isVisible, pdfjsLib }) {
  /** @param {string} id */
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const minimap = $("minimap");
  const toggle = $("minimapToggle");
  const saved = (vscode.getState && vscode.getState()) || {};

  let open = !!(saved.minimapOpen ?? true);
  /** @type {Thumb[]} */
  let thumbs = [];
  /** Pages whose thumbnail is in or near the minimap's visible part. @type {Set<number>} */
  const wanted = new Set();
  /** The marks to draw (annotate.mjs's model). @type {Ann[]} */
  let anns = [];
  /** Bumped on a document change, a rotation or a close: renders begun before are dropped. */
  let generation = 0;
  /** Settles `dropped`. */
  let drop = () => {};
  /**
   * Settles when the generation changes. A page request to the document a reload replaced
   * may never settle (pdf.js drops the worker's late reply), so an own render waits for
   * it only until then.
   * @type {Promise<void>}
   */
  let dropped = new Promise((resolve) => (drop = resolve));
  /** A document came while the minimap was closed: the thumbnails are checked when it opens. */
  let needsSync = true;
  /** The main view has had its turn since the document came. */
  let started = false;
  /** An own render is under way. */
  let busy = false;
  /** Cancels the idle callback that starts the next own render. @type {(() => void) | null} */
  let cancelIdle = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let startTimer;
  /** When the pages were last scrolled or zoomed (performance.now()). */
  let pagesMovedAt = -Infinity;
  /** Re-tries the queue once the pages have been quiet for QUIET_MS. @type {ReturnType<typeof setTimeout> | undefined} */
  let quietTimer;
  /** When the user last scrolled or pressed in the minimap (performance.now()). */
  let userAt = -Infinity;
  /** The pointer dragging in the minimap. @type {number | null} */
  let dragging = null;
  /** Where each page and its thumbnail are, until the layout changes. @type {PageSpan[] | null} */
  let geometry = null;
  /** The thumbnail marked current. @type {HTMLElement | null} */
  let currentEl = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let evictTimer;

  const box = document.createElement("div");
  box.className = "viewportBox";
  box.hidden = true;
  minimap.append(box);

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const n = Number(/** @type {HTMLElement} */ (e.target).dataset.pageNumber);
      if (e.isIntersecting) wanted.add(n);
      else wanted.delete(n);
    }
    pump();
    scheduleEvict();
  }, { root: minimap, rootMargin: `${AHEAD_PX}px 0px` });

  // pdf.js's rendering queue asks its thumbnail viewer for work only when the pages have
  // nothing left to draw; without the hook, the quiet period and idle time alone decide.
  const queue = typeof pdfViewer.renderingQueue?.setThumbnailViewer === "function" ? pdfViewer.renderingQueue : null;
  if (queue) {
    queue.setThumbnailViewer({ forceRendering });
    queue.isThumbnailViewEnabled = true;
  }

  // ---- the thumbnails ------------------------------------------------------------------
  /**
   * Page `i`'s size as shown, in PDF points, and whether pdf.js has the page yet (until
   * pagesloaded, pages after the first have the first page's size).
   * @param {number} i 0-based
   */
  function pageSize(i) {
    const vp = pdfViewer.getPageView(i)?.viewport;
    if (!vp) return { w: 612, h: 792, known: false };
    return { w: vp.width / vp.scale, h: vp.height / vp.scale, known: !!pdfViewer.getPageView(i).pdfPage };
  }

  /** @param {{w: number, h: number}[]} sizes */
  function build(sizes) {
    stopRenders();
    io.disconnect();
    wanted.clear();
    currentEl = null;
    thumbs = sizes.map((s, i) => {
      const el = document.createElement("div");
      el.className = "thumb";
      el.dataset.pageNumber = String(i + 1);
      el.title = `Page ${i + 1}`;
      el.style.height = `${thumbHeight(s)}px`;
      const canvas = document.createElement("canvas");
      // nothing to hold until it is rendered
      canvas.width = 1;
      canvas.height = 1;
      const overlay = document.createElement("div");
      overlay.className = "overlay";
      el.append(canvas, overlay);
      return { el, canvas, overlay, rendered: false, stale: false, task: null, w: s.w, h: s.h };
    });
    minimap.replaceChildren(...thumbs.map((t) => t.el), box);
    for (const t of thumbs) io.observe(t.el);
  }

  /**
   * Match the thumbnails to the shown document: kept when it has as many pages, of the
   * sizes they had (pages pdf.js does not have yet are taken as unchanged, and corrected
   * on pagesloaded), else made anew. Pages the main view shows now are copied at once.
   */
  function sync() {
    needsSync = false;
    const sizes = Array.from({ length: pdfViewer.pagesCount }, (_, i) => pageSize(i));
    const same = thumbs.length === sizes.length && sizes.every((s, i) => !s.known || thumbHeight(s) === thumbHeight(thumbs[i]));
    if (same) {
      sizes.forEach((s, i) => {
        if (s.known) Object.assign(thumbs[i], { w: s.w, h: s.h });
      });
    } else {
      build(sizes);
    }
    thumbs.forEach((t, i) => {
      const view = pdfViewer.getPageView(i);
      if ((!t.rendered || t.stale) && view?.renderingState === FINISHED) copyFrom(view, i + 1);
    });
    afterLayout();
  }

  /** pagesloaded: every page's size is known now; resize the thumbnails that were wrong. */
  function resizeThumbs() {
    if (!open || needsSync) return;
    thumbs.forEach((t, i) => {
      const s = pageSize(i);
      if (thumbHeight(s) === thumbHeight(t)) return;
      Object.assign(t, { w: s.w, h: s.h });
      t.el.style.height = `${thumbHeight(t)}px`;
      if (t.rendered) t.stale = true;
    });
    afterLayout();
  }

  function afterLayout() {
    geometry = null;
    drawOverlays();
    markCurrent(pdfViewer.currentPageNumber);
    scheduleBox(true);
    pump();
  }

  /** @param {number} n */
  function markCurrent(n) {
    const el = thumbs[n - 1]?.el || null;
    if (el === currentEl) return;
    currentEl?.classList.remove("current");
    el?.classList.add("current");
    currentEl = el;
  }

  // ---- copies of the main view's pages ---------------------------------------------------
  /**
   * Draw page `n`'s canvas from the main view, scaled down, into its thumbnail. pdf.js's
   * `thumbnailCanvas` is that canvas when it is complete and shows the page as a thumbnail
   * should (else null); older versions only have `canvas`. The main view renders with
   * ENABLE_FORMS, which bakes the appearances of all but form fields into the canvas, so a
   * copied thumbnail shows the marks under the overlay too, where an own render (without
   * annotations) does not; that difference is accepted.
   * @param {any} view a PDFPageView @param {number} n
   */
  function copyFrom(view, n) {
    const t = thumbs[n - 1];
    if (!open || needsSync || !t || !view) return;
    const src = /** @type {HTMLCanvasElement | null} */ ("thumbnailCanvas" in view ? view.thumbnailCanvas : view.canvas);
    if (!src || !src.width || !src.height) return;
    // a canvas of another shape (a rotation under way): left to an own render
    if (Math.abs(src.height / src.width - t.h / t.w) > 0.02 * (t.h / t.w)) return;
    t.task?.cancel();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    t.canvas.width = Math.round(THUMB_W * dpr);
    t.canvas.height = Math.round(thumbHeight(t) * dpr);
    const ctx = t.canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, t.canvas.width, t.canvas.height);
    t.rendered = true;
    t.stale = false;
  }

  // ---- own renders, one at a time, when the viewer is idle ---------------------------------
  function stopRenders() {
    generation++;
    drop();
    dropped = new Promise((resolve) => (drop = resolve));
    cancelIdle?.();
    cancelIdle = null;
    for (const t of thumbs) t.task?.cancel();
  }

  /** The wanted page that needs a render, nearest to the current page first. */
  function nextPage() {
    const cur = pdfViewer.currentPageNumber || 1;
    let best = 0;
    for (const n of wanted) {
      const t = thumbs[n - 1];
      if (!t || t.task || (t.rendered && !t.stale)) continue;
      const d = Math.abs(n - cur) - Math.abs(best - cur);
      if (!best || d < 0 || (d === 0 && n < best)) best = n;
    }
    return best;
  }

  const canRender = () => started && open && !needsSync && isVisible();
  /** How long until the pages have been still for QUIET_MS (ms; <= 0: they have). */
  const quietIn = () => pagesMovedAt + QUIET_MS - performance.now();

  /** Ask again once the pages are quiet. @param {number} wait */
  function retryWhenQuiet(wait) {
    if (quietTimer !== undefined) return;
    quietTimer = setTimeout(() => {
      quietTimer = undefined;
      pump();
    }, Math.max(0, wait) + 10);
  }

  /**
   * There may be a thumbnail to render: through pdf.js's queue (the pages go first; it
   * calls `forceRendering` when they have nothing to draw), else directly.
   */
  function pump() {
    if (busy || cancelIdle || !canRender() || !nextPage()) return;
    const wait = quietIn();
    if (wait > 0) return retryWhenQuiet(wait);
    if (queue && pdfViewer.pagesCount) queue.renderHighestPriority();
    else forceRendering();
  }

  /**
   * The rendering queue's call (and pump's without the queue): start an own render at the
   * next idle time if there is one to do and the pages are quiet. True while one is
   * scheduled or running; the queue then waits for `renderHighestPriority`, which comes
   * when it ends.
   */
  function forceRendering() {
    if (busy || cancelIdle) return true;
    if (!canRender() || !nextPage()) return false;
    const wait = quietIn();
    if (wait > 0) {
      retryWhenQuiet(wait);
      return false;
    }
    cancelIdle = whenIdle(() => {
      cancelIdle = null;
      void renderNext();
    });
    return true;
  }

  async function renderNext() {
    const n = !busy && canRender() && quietIn() <= 0 ? nextPage() : 0;
    if (n) {
      busy = true;
      try {
        await render(n);
      } finally {
        busy = false;
      }
    }
    pump();
  }

  /**
   * Render page `n` into an off-screen canvas, then copy it into the thumbnail, so a stale
   * one keeps its old image until the new one is ready. Given up (to be asked again) if
   * the pages move or a copy arrives before the render starts.
   * @param {number} n
   */
  async function render(n) {
    const gen = generation;
    const t = thumbs[n - 1];
    const doc = getDocument();
    if (!t || !doc) return;
    try {
      const page = await Promise.race([doc.getPage(n), dropped]);
      if (!page || gen !== generation || !canRender() || quietIn() > 0 || (t.rendered && !t.stale)) return;
      // an explicit rotation replaces the page's own /Rotate rather than adding to it
      const rotation = ((page.rotate || 0) + pdfViewer.pagesRotation) % 360;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale: (THUMB_W * dpr) / page.getViewport({ scale: 1, rotation }).width, rotation });
      const off = document.createElement("canvas");
      off.width = Math.max(1, Math.round(viewport.width));
      off.height = Math.max(1, Math.round(viewport.height));
      const canvasContext = off.getContext("2d");
      t.task = page.render({ canvasContext, viewport, annotationMode: pdfjsLib.AnnotationMode.DISABLE });
      await t.task.promise;
      if (gen !== generation) return;
      t.canvas.width = off.width;
      t.canvas.height = off.height;
      t.canvas.getContext("2d")?.drawImage(off, 0, 0);
      t.rendered = true;
      t.stale = false;
    } catch (e) {
      // cancelled (a scroll, a copy, a close), or the old document of a reload going away
      if (gen !== generation || e instanceof pdfjsLib.RenderingCancelledException) return;
      // not retried: the page itself shows the same failure in the main view
      t.rendered = true;
      t.stale = false;
      console.warn(`minimap: page ${n}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      t.task = null;
    }
  }

  /** The pages scroll or zoom: hold own renders, and stop one under way. */
  function pagesMoved() {
    pagesMovedAt = performance.now();
    if (busy) for (const t of thumbs) t.task?.cancel();
  }

  // ---- eviction of thumbnails far from view ------------------------------------------------
  function scheduleEvict() {
    clearTimeout(evictTimer);
    evictTimer = setTimeout(evict, EVICT_DELAY_MS);
  }

  /**
   * Empty the thumbnails more than EVICT_DISTANCE pages from the nearest wanted page (not
   * a wanted one, not the current page). The elements keep their size and marks; nothing
   * is measured. With nothing wanted (closed, hidden) nothing is evicted.
   */
  function evict() {
    if (!wanted.size) return;
    const near = [...wanted];
    const cur = pdfViewer.currentPageNumber;
    thumbs.forEach((t, i) => {
      const n = i + 1;
      if ((!t.rendered && !t.task) || wanted.has(n) || n === cur) return;
      if (near.every((w) => Math.abs(w - n) > EVICT_DISTANCE)) {
        t.task?.cancel();
        t.canvas.width = 1;
        t.canvas.height = 1;
        t.rendered = false;
        t.stale = false;
      }
    });
  }

  // ---- marks -------------------------------------------------------------------------------
  function drawOverlays() {
    /** @type {Map<number, Ann[]>} */
    const byPage = new Map();
    for (const a of anns) {
      if (!a.irt) byPage.set(a.page, [...(byPage.get(a.page) || []), a]);
    }
    thumbs.forEach((t, i) => drawOverlay(t, i, byPage.get(i + 1) || []));
  }

  /**
   * Text markup as one rect per quad (at least 2 px high), other annotations (notes) as a
   * small square at their rect's top-left corner, from PDF user space via the page's view
   * box. Only for unrotated pages (neither /Rotate nor the viewer's rotation): a rotated
   * page shows no marks in the minimap.
   * @param {Thumb} t @param {number} i @param {Ann[]} list
   */
  function drawOverlay(t, i, list) {
    const pdfPage = pdfViewer.getPageView(i)?.pdfPage;
    if (!list.length || !pdfPage || ((pdfPage.rotate || 0) + pdfViewer.pagesRotation) % 360 !== 0) {
      t.overlay.replaceChildren();
      return;
    }
    const [vx0, vy0, vx1, vy1] = pdfPage.view;
    const sx = THUMB_W / (vx1 - vx0);
    const sy = thumbHeight(t) / (vy1 - vy0);
    /** @type {HTMLElement[]} */
    const marks = [];
    for (const a of list) {
      const color = a.color ? hex(a.color) : NO_COLOR;
      const rects = a.quads.length ? a.quads.map(quadRect) : [normRect(a.rect)];
      for (const [x0, y0, x1, y1] of rects) {
        const m = document.createElement("div");
        m.style.left = `${(x0 - vx0) * sx}px`;
        m.style.top = `${(vy1 - y1) * sy}px`;
        if (a.quads.length) {
          m.style.width = `${(x1 - x0) * sx}px`;
          m.style.height = `${Math.max(2, (y1 - y0) * sy)}px`;
        } else {
          m.className = "noteMark";
        }
        m.style.background = color;
        marks.push(m);
      }
    }
    t.overlay.replaceChildren(...marks);
  }

  // ---- the box over the visible pages -------------------------------------------------------
  /** Top of a page div in the main view's scrolled content. @param {HTMLElement} div */
  function mainTop(div) {
    // The pages' offsetParent is the container (#viewer is not positioned); add up any
    // positioned element in between.
    let top = 0;
    for (let el = /** @type {HTMLElement | null} */ (div); el && el !== container && container.contains(el);
      el = /** @type {HTMLElement | null} */ (el.offsetParent)) top += el.offsetTop;
    return top;
  }

  /** Where each page and its thumbnail are: measured once, kept until the layout changes. @returns {PageSpan[]} */
  function spans() {
    if (geometry) return geometry;
    /** @type {PageSpan[]} */
    const out = [];
    thumbs.forEach((t, i) => {
      const div = pdfViewer.getPageView(i)?.div;
      if (div) out.push({ top: mainTop(div), height: div.offsetHeight, thumbTop: t.el.offsetTop, thumbHeight: t.el.offsetHeight });
    });
    geometry = out;
    return out;
  }

  let boxQueued = false;
  let follow = false;
  /** @param {boolean} fromPages the pages moved: let the minimap follow them */
  function scheduleBox(fromPages) {
    follow ||= fromPages;
    if (boxQueued) return;
    boxQueued = true;
    requestAnimationFrame(() => {
      boxQueued = false;
      const f = follow;
      follow = false;
      updateBox(f);
    });
  }

  /**
   * Place the box; when the pages moved, scroll the minimap in proportion to them, so the
   * box stays in view in a long document (not while the user scrolls the minimap itself).
   * With the geometry kept, this reads only scroll positions, all before it writes.
   * @param {boolean} followPages
   */
  function updateBox(followPages) {
    if (!open || !thumbs.length || !isVisible()) return;
    const pages = spans();
    const { scrollTop, clientHeight, scrollHeight } = container;
    const range = minimap.scrollHeight - minimap.clientHeight;
    const { top, height } = mapScrollToMinimap(pages, scrollTop, clientHeight);
    box.style.top = `${top}px`;
    box.style.height = `${Math.max(2, height)}px`;
    box.hidden = false;
    if (followPages && performance.now() - userAt > USER_SCROLL_MS) {
      minimap.scrollTop = (scrollTop / Math.max(1, scrollHeight - clientHeight)) * range;
    }
  }

  container.addEventListener("scroll", () => {
    pagesMoved();
    scheduleBox(true);
  }, { passive: true });

  // ---- click and drag ----------------------------------------------------------------------
  /**
   * Scroll the pages so the point of the document at the pointer is in the middle of the
   * view. Through scrollTop rather than the page number, so the place in the page is kept.
   * @param {number} clientY
   */
  function seek(clientY) {
    userAt = performance.now();
    const r = minimap.getBoundingClientRect();
    const y = clientY - r.top - minimap.clientTop + minimap.scrollTop;
    const target = mapMinimapToScroll(spans(), y) - container.clientHeight / 2;
    container.scrollTop = Math.min(Math.max(0, target), Math.max(0, container.scrollHeight - container.clientHeight));
  }
  minimap.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !thumbs.length) return;
    // on the scrollbar: that scrolls the minimap itself, not the pages
    if (e.clientX - minimap.getBoundingClientRect().left - minimap.clientLeft >= minimap.clientWidth) return;
    e.preventDefault();
    minimap.setPointerCapture(e.pointerId);
    dragging = e.pointerId;
    seek(e.clientY);
  });
  /** @param {PointerEvent} e */
  const release = (e) => {
    if (dragging !== e.pointerId) return;
    dragging = null;
    if (minimap.hasPointerCapture(e.pointerId)) minimap.releasePointerCapture(e.pointerId);
  };
  minimap.addEventListener("pointermove", (e) => {
    if (dragging !== e.pointerId) return;
    // the button came up where the minimap did not hear it: the drag is over
    if (e.buttons === 0) release(e);
    else seek(e.clientY);
  });
  minimap.addEventListener("pointerup", release);
  minimap.addEventListener("pointercancel", release);
  // the capture went (the element hidden, another taker): what follows is not this drag
  minimap.addEventListener("lostpointercapture", release);
  minimap.addEventListener("wheel", () => {
    userAt = performance.now();
  }, { passive: true });

  // ---- open and close ----------------------------------------------------------------------
  function renderToggle() {
    toggle.setAttribute("aria-pressed", String(open));
    minimap.hidden = !open;
    document.body.classList.toggle("minimap-open", open);
  }

  /** @param {boolean} value */
  function setOpen(value) {
    open = value;
    vscode.setState?.({ ...(vscode.getState?.() || {}), minimapOpen: open });
    renderToggle();
    if (open) sync();
    else stopRenders();
  }
  toggle.addEventListener("click", () => setOpen(!open));

  // ---- events --------------------------------------------------------------------------------
  function start() {
    clearTimeout(startTimer);
    if (started) return;
    started = true;
    pump();
  }

  // setDocument drops the shown document (a reload): from here until pagesinit,
  // getDocument() is already the new one while the thumbnails are still the old one's
  eventBus.on("pagesdestroy", () => stopRenders());
  eventBus.on("pagesinit", () => {
    stopRenders();
    geometry = null;
    for (const t of thumbs) if (t.rendered) t.stale = true;
    // the main view first: start on its first rendered page
    started = false;
    clearTimeout(startTimer);
    startTimer = setTimeout(start, START_FALLBACK_MS);
    if (open) sync();
    else needsSync = true;
  });
  eventBus.on("pagerendered", (/** @type {{source: any, pageNumber: number, cssTransform: boolean, isDetailView?: boolean, error: any}} */ e) => {
    // a CSS-only zoom has no new pixels; a detail view's canvas is only part of the page
    if (!e.cssTransform && !e.isDetailView && !e.error) copyFrom(e.source, e.pageNumber);
    if (!started) start();
  });
  eventBus.on("pagesloaded", () => {
    geometry = null;
    resizeThumbs();
  });
  eventBus.on("rotationchanging", () => {
    stopRenders();
    geometry = null;
    for (const t of thumbs) if (t.rendered) t.stale = true;
    if (open) sync();
    else needsSync = true;
  });
  eventBus.on("pagechanging", (/** @type {{pageNumber: number}} */ { pageNumber }) => {
    markCurrent(pageNumber);
    scheduleBox(true);
  });
  eventBus.on("scalechanging", () => {
    geometry = null;
    pagesMoved();
    scheduleBox(true);
  });
  eventBus.on("annotationsrebuilt", (/** @type {{anns: Ann[]}} */ e) => {
    anns = e.anns;
    drawOverlays();
  });

  renderToggle();

  return {
    /** The tab is shown again: render what was waiting, place the box. */
    onShown() {
      if (!isVisible()) return;
      geometry = null;
      pump();
      scheduleBox(true);
      scheduleEvict();
    },
    /** The view was resized. */
    refresh() {
      geometry = null;
      scheduleBox(true);
      pump();
    },
    /** No messages of its own; kept like the other modules'. @param {any} _msg */
    handle(_msg) {
      return false;
    },
  };
}
