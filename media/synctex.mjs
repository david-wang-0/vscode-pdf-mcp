// @ts-check
/**
 * SyncTeX in the viewer. While Ctrl is held over a page of a PDF with SyncTeX data, the
 * text that Ctrl+click would jump to gets a grey underline and a tip names the source
 * file and line; Ctrl+click opens it (inverse search). A forward search scrolls to a
 * place and flashes it. The lookups are the extension's (in-process parser); nothing is
 * parsed here.
 *
 * Coordinates sent and received are SyncTeX's: PDF big points from the page's top-left
 * corner, y downwards. Rects are [left, top, right, bottom].
 *
 * Messages to the extension: synctexHover {reqId, page, x, y}, synctexEdit {page, x, y}.
 * Messages from it: synctex {available}, synctexHit {reqId, hit: {file, rel, line,
 * column, text, rects} | null}. (synctexShow {reqId, page, rects} is handled by viewer.js,
 * which calls `flash`.)
 */

/** After a scroll, how long the view must rest before a lookup (ms). */
const HOVER_DEBOUNCE_MS = 40;
/** A moving pointer is looked up at once, then at most this often (ms); a lookup is cheap. */
const HOVER_FOLLOW_MS = 25;
/** A Ctrl+wheel gesture hides the underline until this long after its last event (ms). */
const WHEEL_QUIET_MS = 300;
/** How long a forward search's flash stays (ms). */
const FLASH_MS = 1500;

/**
 * PDF user space point to SyncTeX space (origin top-left of the page's view box).
 * @param {ArrayLike<number>} p @param {ArrayLike<number>} viewBox [x0, y0, x1, y1]
 * @returns {[number, number]}
 */
export function pdfToSynctex(p, viewBox) {
  return [p[0] - viewBox[0], viewBox[3] - p[1]];
}

/**
 * SyncTeX rect [left, top, right, bottom] to a PDF user space rect [x0, y0, x1, y1].
 * @param {ArrayLike<number>} r @param {ArrayLike<number>} viewBox
 * @returns {[number, number, number, number]}
 */
export function synctexRectToPdf(r, viewBox) {
  return [viewBox[0] + r[0], viewBox[3] - r[3], viewBox[0] + r[2], viewBox[3] - r[1]];
}

/**
 * @param {{pdfViewer: any, eventBus: any, container: HTMLElement, post: (m: any) => void}} ctx
 */
export function setupSynctex({ pdfViewer, eventBus, container, post }) {
  const state = {
    available: false,
    /** Ctrl as the mouse events report it. */
    ctrl: false,
    /** Ctrl held by its keydown (no keyup or blur since): mouse events may not report it. */
    keyCtrl: false,
    /** @type {{x: number, y: number} | null} */
    pointer: null,
    reqSeq: 0,
    quietUntil: 0,
  };
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** Lookups in flight: reqId -> where it was made. @type {Map<number, {page: number, x: number, y: number}>} */
  const pending = new Map();
  /** Answers to requests below this are dropped (made before a hide); so are ones older than the shown one. */
  let validFrom = 1;
  let shownReq = 0;
  let lastLookupAt = 0;

  const layer = document.createElement("div");
  layer.id = "synctexLayer";
  container.append(layer);
  const hover = document.createElement("div");
  hover.className = "synctexHover";
  layer.append(hover);
  const flashBox = document.createElement("div");
  flashBox.className = "synctexFlash";
  layer.append(flashBox);
  const tip = document.createElement("div");
  tip.className = "vpdf-ui synctexTip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  layer.append(tip);

  /** Client point to a position in the scrolled container. @param {number} x @param {number} y */
  function toLayer(x, y) {
    const c = container.getBoundingClientRect();
    return { x: x - c.left + container.scrollLeft, y: y - c.top + container.scrollTop };
  }

  /** @param {number} page */
  function pageGeom(page) {
    const view = pdfViewer.getPageView(page - 1);
    if (!view || !view.div || !view.viewport) return null;
    const r = view.div.getBoundingClientRect();
    return { view, viewport: view.viewport, origin: { left: r.left + view.div.clientLeft, top: r.top + view.div.clientTop } };
  }

  /** The page and SyncTeX point under a client point, or null. @param {number} x @param {number} y */
  function pagePoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || el.closest(".vpdf-ui")) return null;
    const pageEl = /** @type {HTMLElement | null} */ (el.closest(".page[data-page-number]"));
    if (!pageEl) return null;
    const page = Number(pageEl.dataset.pageNumber);
    const g = pageGeom(page);
    if (!g) return null;
    const p = g.viewport.convertToPdfPoint(x - g.origin.left, y - g.origin.top);
    const [sx, sy] = pdfToSynctex(p, g.viewport.viewBox);
    return { page, x: Math.round(sx * 100) / 100, y: Math.round(sy * 100) / 100 };
  }

  /** SyncTeX rects on `page` to client rects. @param {number} page @param {number[][]} rects */
  function clientRects(page, rects) {
    const g = pageGeom(page);
    if (!g) return [];
    return rects.map((r) => {
      const [x0, y0, x1, y1] = synctexRectToPdf(r, g.viewport.viewBox);
      const a = g.viewport.convertToViewportPoint(x0, y0);
      const b = g.viewport.convertToViewportPoint(x1, y1);
      return {
        left: Math.min(a[0], b[0]) + g.origin.left, right: Math.max(a[0], b[0]) + g.origin.left,
        top: Math.min(a[1], b[1]) + g.origin.top, bottom: Math.max(a[1], b[1]) + g.origin.top,
      };
    });
  }

  /** Fill `holder` with one bar per rect. @param {HTMLElement} holder @param {number} page @param {number[][]} rects @param {string} cls */
  function draw(holder, page, rects, cls) {
    holder.replaceChildren();
    for (const r of clientRects(page, rects)) {
      const p = toLayer(r.left, r.top);
      const bar = document.createElement("div");
      bar.className = cls;
      bar.style.left = `${p.x}px`;
      bar.style.top = `${p.y}px`;
      bar.style.width = `${Math.max(2, r.right - r.left)}px`;
      bar.style.height = `${Math.max(3, r.bottom - r.top)}px`;
      holder.append(bar);
    }
  }

  function clearShown() {
    hover.replaceChildren();
    tip.hidden = true;
    document.body.classList.remove("synctex-hover");
  }

  function hide() {
    clearTimeout(timer);
    clearShown();
    validFrom = state.reqSeq + 1; // drop answers in flight
    pending.clear();
  }

  const ctrlHeld = () => state.ctrl || state.keyCtrl;
  const wanted = () => state.available && ctrlHeld() && !!state.pointer && Date.now() >= state.quietUntil;

  function schedule(ms = HOVER_DEBOUNCE_MS) {
    clearTimeout(timer);
    timer = setTimeout(lookup, ms);
  }

  function lookup() {
    if (!wanted() || !state.pointer) return hide();
    const at = pagePoint(state.pointer.x, state.pointer.y);
    if (!at) return hide();
    const reqId = ++state.reqSeq;
    pending.set(reqId, at);
    lastLookupAt = Date.now();
    post({ type: "synctexHover", reqId, page: at.page, x: at.x, y: at.y });
  }

  /**
   * An answer: shown unless a newer one is (while the pointer moves, answers to earlier
   * lookups still show, so the underline follows without waiting for the pointer to rest).
   * @param {number} reqId @param {any} hit
   */
  function answer(reqId, hit) {
    const at = pending.get(reqId);
    if (!at || reqId < validFrom || reqId <= shownReq) return;
    for (const k of pending.keys()) if (k <= reqId) pending.delete(k);
    shownReq = reqId;
    showHit(at, hit);
  }

  /** @param {{page: number, x: number, y: number}} at @param {any} hit */
  function showHit(at, hit) {
    if (!wanted() || !state.pointer) return hide();
    if (!hit) return clearShown();
    draw(hover, at.page, Array.isArray(hit.rects) ? hit.rects : [], "bar");
    document.body.classList.add("synctex-hover");
    tip.replaceChildren();
    const head = document.createElement("div");
    head.className = "synctexWhere";
    head.textContent = `${hit.rel || hit.file}:${hit.line}`;
    tip.append(head);
    if (hit.text) {
      const body = document.createElement("div");
      body.className = "synctexLine";
      body.textContent = hit.text;
      tip.append(body);
    }
    tip.hidden = false;
    // below and right of the pointer, inside the visible area
    const c = container.getBoundingClientRect();
    tip.style.left = "0px";
    tip.style.top = "0px";
    let x = state.pointer.x + 14;
    let y = state.pointer.y + 20;
    if (x + tip.offsetWidth > c.right - 8) x = Math.max(c.left + 4, c.right - 8 - tip.offsetWidth);
    if (y + tip.offsetHeight > c.bottom - 4) y = Math.max(c.top + 4, state.pointer.y - 12 - tip.offsetHeight);
    const p = toLayer(x, y);
    tip.style.left = `${p.x}px`;
    tip.style.top = `${p.y}px`;
  }

  // ---- pointer and keys ---------------------------------------------------------------
  /** @param {KeyboardEvent | MouseEvent} e */
  const ctrlOf = (e) => e.ctrlKey || e.metaKey;
  /** @param {EventTarget | null} t */
  const inUi = (t) => t instanceof Element && !!t.closest(".vpdf-ui");

  // Ctrl may come before or after the pointer arrives, and the pointer may move on while
  // it is held: the underline and tip follow whatever is under it. Pointer moves do not
  // always report a held Ctrl (seen under Wayland), so a Ctrl keydown counts until its keyup.
  container.addEventListener("pointermove", (e) => {
    state.pointer = { x: e.clientX, y: e.clientY };
    state.ctrl = ctrlOf(e);
    if (!ctrlHeld() || e.buttons) return hide();
    if (state.available) schedule(Math.max(0, lastLookupAt + HOVER_FOLLOW_MS - Date.now()));
  }, { passive: true });
  container.addEventListener("pointerleave", () => {
    state.pointer = null;
    hide();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Control" && e.key !== "Meta") {
      // a key without Ctrl: a keyup we missed
      if (!ctrlOf(e) && ctrlHeld()) {
        state.ctrl = state.keyCtrl = false;
        hide();
      }
      return;
    }
    state.keyCtrl = true;
    if (state.available && state.pointer) schedule(0);
  }, true);
  window.addEventListener("keyup", (e) => {
    if (e.key !== "Control" && e.key !== "Meta") return;
    state.ctrl = state.keyCtrl = false;
    hide();
  }, true);
  window.addEventListener("blur", () => {
    state.ctrl = state.keyCtrl = false;
    hide();
  });
  // Ctrl+wheel (and pinch) zooms: no underline during the gesture; it comes back after it.
  container.addEventListener("wheel", (e) => {
    if (ctrlOf(e)) {
      state.quietUntil = Date.now() + WHEEL_QUIET_MS;
      hide();
      if (state.available) schedule(WHEEL_QUIET_MS + 20);
    }
  }, { passive: true, capture: true });
  container.addEventListener("scroll", () => {
    if (hover.childElementCount || !tip.hidden) schedule();
  }, { passive: true });
  eventBus.on("scalechanging", hide);
  eventBus.on("pagesinit", () => {
    hide();
    flashBox.replaceChildren();
  });

  // Ctrl+click: inverse search. It wins over links, selection and the marking UI (a
  // plain click still does those).
  /** @type {{x: number, y: number, at: {page: number, x: number, y: number}} | null} */
  let down = null;
  container.addEventListener("mousedown", (e) => {
    down = null;
    if (!state.available || !ctrlOf(e) || e.button !== 0 || inUi(e.target)) return;
    const at = pagePoint(e.clientX, e.clientY);
    if (!at) return;
    e.preventDefault();
    e.stopPropagation();
    down = { x: e.clientX, y: e.clientY, at };
  }, true);
  container.addEventListener("mouseup", (e) => {
    const d = down;
    down = null;
    if (!d || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
    post({ type: "synctexEdit", page: d.at.page, x: d.at.x, y: d.at.y });
  }, true);
  container.addEventListener("click", (e) => {
    if (!state.available || !ctrlOf(e) || inUi(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // ---- forward search -----------------------------------------------------------------
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let flashTimer;
  /**
   * Scroll `rects` (SyncTeX, on `page`) into view, a third down from the top, and flash
   * them for a moment. Needs the pages laid out (viewer.js waits for that).
   * @param {number} page @param {number[][]} rects
   */
  function flash(page, rects) {
    const view = pdfViewer.getPageView(page - 1);
    const list = Array.isArray(rects) ? rects.filter((r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite)) : [];
    if (!view || !view.viewport) {
      pdfViewer.currentPageNumber = page;
      return;
    }
    if (list.length) {
      const vb = view.viewport.viewBox;
      const top = Math.min(...list.map((r) => r[1]));
      const [, , , y1] = synctexRectToPdf([0, top, 0, top], vb);
      const offset = (container.clientHeight * 0.33) / (view.viewport.scale || 1);
      pdfViewer.scrollPageIntoView({ pageNumber: page, destArray: [null, { name: "XYZ" }, null, Math.min(vb[3], y1 + offset), null],
        allowNegativeOffset: true });
    } else {
      pdfViewer.currentPageNumber = page;
    }
    clearTimeout(flashTimer);
    draw(flashBox, page, list, "bar");
    flashBox.classList.remove("fading");
    void flashBox.offsetWidth; // restart the animation
    flashBox.classList.add("fading");
    flashTimer = setTimeout(() => {
      flashBox.replaceChildren();
      flashBox.classList.remove("fading");
    }, FLASH_MS);
  }

  // ---- the selection's rects ----------------------------------------------------------
  /**
   * The current text-layer selection as SyncTeX rects per page (one per text run, in
   * document order), for the extension to map to source lines; null when there is none.
   * @returns {{page: number, rects: number[][]}[] | null}
   */
  function selectionParts() {
    if (!state.available) return null;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const root = range.commonAncestorContainer;
    const walkRoot = root.nodeType === Node.TEXT_NODE ? root.parentNode : root;
    if (!walkRoot) return null;
    /** @type {{page: number, rects: number[][]}[]} */
    const parts = [];
    const walker = document.createTreeWalker(walkRoot, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!range.intersectsNode(n)) continue;
      const parent = n.parentElement;
      if (!parent || !parent.closest(".textLayer") || parent.closest(".vpdf-ui")) continue;
      const pageEl = /** @type {HTMLElement | null} */ (parent.closest(".page[data-page-number]"));
      if (!pageEl) continue;
      const page = Number(pageEl.dataset.pageNumber);
      const g = pageGeom(page);
      if (!g) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      if (n === range.startContainer) r.setStart(n, range.startOffset);
      if (n === range.endContainer) r.setEnd(n, range.endOffset);
      if (!r.toString().trim()) continue;
      let part = parts[parts.length - 1];
      if (!part || part.page !== page) parts.push((part = { page, rects: [] }));
      for (const cr of r.getClientRects()) {
        if (cr.width < 0.5 || cr.height < 0.5) continue;
        const a = pdfToSynctex(g.viewport.convertToPdfPoint(cr.left - g.origin.left, cr.top - g.origin.top), g.viewport.viewBox);
        const b = pdfToSynctex(g.viewport.convertToPdfPoint(cr.right - g.origin.left, cr.bottom - g.origin.top), g.viewport.viewBox);
        const q = (/** @type {number} */ v) => Math.round(v * 100) / 100;
        part.rects.push([q(Math.min(a[0], b[0])), q(Math.min(a[1], b[1])), q(Math.max(a[0], b[0])), q(Math.max(a[1], b[1]))]);
      }
    }
    return parts.filter((p) => p.rects.length);
  }

  // ---- messages from the extension ----------------------------------------------------
  /** @param {any} msg @returns {boolean} whether it was a SyncTeX message */
  function handle(msg) {
    switch (msg.type) {
      case "synctex": {
        const was = state.available;
        state.available = !!msg.available;
        document.body.classList.toggle("synctex", state.available);
        if (!state.available) hide();
        else if (ctrlHeld() && state.pointer) schedule(0);
        if (was !== state.available) onAvailability(state.available);
        return true;
      }
      case "synctexHit":
        answer(msg.reqId, msg.hit);
        return true;
      default:
        return false;
    }
  }
  /** @type {(available: boolean) => void} */
  let onAvailability = () => {};

  return {
    handle,
    flash,
    selectionParts,
    available: () => state.available,
    /** @param {(available: boolean) => void} fn */
    onAvailabilityChange(fn) {
      onAvailability = fn;
    },
  };
}
