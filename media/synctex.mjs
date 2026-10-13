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
 * Word level (wordmatch.mjs): SyncTeX records lines only, so a Ctrl+click or hover also
 * sends the word under the pointer with a few words of context (`anchor`), which the
 * extension looks for in the source; a forward search may bring the word at the cursor,
 * which `flash` looks for in the text layer on and around the line's boxes and flashes
 * alone. Without a confident match both stay at the line.
 *
 * Messages to the extension: synctexHover {reqId, page, x, y, anchor?}, synctexEdit
 * {page, x, y, anchor?}. Messages from it: synctex {available}, synctexHit {reqId, hit:
 * {file, rel, line, column, text, em?, rects} | null}. (synctexShow {reqId, page, rects,
 * anchor?, near?} is handled by viewer.js, which calls `flash`.)
 */

import { pdfTokens, anchorOf, findAnchor, validAnchor } from "./wordmatch.mjs";

/** After a scroll, how long the view must rest before a lookup (ms). */
const HOVER_DEBOUNCE_MS = 40;
/** A moving pointer is looked up at once, then at most this often (ms); a lookup is cheap. */
const HOVER_FOLLOW_MS = 25;
/** A Ctrl+wheel gesture hides the underline until this long after its last event (ms). */
const WHEEL_QUIET_MS = 300;
/** How long a forward search's flash stays (ms). */
const FLASH_MS = 1500;
/** How long a forward search with a word waits for the page's text layer (ms). */
const TEXT_LAYER_WAIT_MS = 2000;

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

  /** Client rects to SyncTeX rects on a page. @param {Iterable<DOMRect>} crs @param {NonNullable<ReturnType<typeof pageGeom>>} g */
  function synctexRects(crs, g) {
    const q = (/** @type {number} */ v) => Math.round(v * 100) / 100;
    /** @type {number[][]} */
    const out = [];
    for (const cr of crs) {
      if (cr.width < 0.5 || cr.height < 0.5) continue;
      const a = pdfToSynctex(g.viewport.convertToPdfPoint(cr.left - g.origin.left, cr.top - g.origin.top), g.viewport.viewBox);
      const b = pdfToSynctex(g.viewport.convertToPdfPoint(cr.right - g.origin.left, cr.bottom - g.origin.top), g.viewport.viewBox);
      out.push([q(Math.min(a[0], b[0])), q(Math.min(a[1], b[1])), q(Math.max(a[0], b[0])), q(Math.max(a[1], b[1]))]);
    }
    return out;
  }

  // ---- words of the text layer (wordmatch.mjs) -------------------------------------------
  /**
   * @typedef {{text: string, nodes: Text[], starts: number[], tokens: import("./wordmatch.mjs").Token[]}} PageWords
   *   the text layer's text (a <br> is "\n"), its text nodes with their offsets, its words
   */
  /** @type {WeakMap<Element, PageWords>} by text layer div, dropped when it renders again */
  const wordsCache = new WeakMap();

  /** The page's text layer div once pdf.js has rendered it, else null. @param {number} page */
  function textLayerOf(page) {
    const div = pdfViewer.getPageView(page - 1)?.textLayer?.div;
    return div && div.querySelector(".endOfContent") ? div : null;
  }

  /** @param {number} page @returns {PageWords | null} */
  function pageWords(page) {
    const div = textLayerOf(page);
    if (!div) return null;
    let w = wordsCache.get(div);
    if (w) return w;
    let text = "";
    /** @type {Text[]} */
    const nodes = [];
    /** @type {number[]} */
    const starts = [];
    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        if (n.nodeName === "BR") text += "\n";
        continue;
      }
      nodes.push(/** @type {Text} */ (n));
      starts.push(text.length);
      text += /** @type {Text} */ (n).data;
    }
    w = { text, nodes, starts, tokens: pdfTokens(text) };
    wordsCache.set(div, w);
    return w;
  }

  /** The text node and offset of a text offset. @param {PageWords} w @param {number} off @returns {[Text, number]} */
  function nodeAt(w, off) {
    let lo = 0;
    for (let hi = w.starts.length - 1; lo < hi;) {
      const mid = (lo + hi + 1) >> 1;
      if (w.starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return [w.nodes[lo], Math.min(off - w.starts[lo], w.nodes[lo].length)];
  }

  /** Client rects of words [index, index + count). @param {PageWords} w @param {number} index @param {number} count */
  function wordClientRects(w, index, count) {
    const r = document.createRange();
    const [a, ao] = nodeAt(w, w.tokens[index].start);
    const [b, bo] = nodeAt(w, w.tokens[index + count - 1].end - 1);
    r.setStart(a, ao);
    r.setEnd(b, Math.min(bo + 1, b.length));
    return [...r.getClientRects()].filter((cr) => cr.width >= 0.5 && cr.height >= 0.5);
  }

  /**
   * The anchor of the word under a client point on `page` (its words and context), or
   * null when the point is not on a word of the text layer.
   * @param {number} page @param {number} x @param {number} y
   * @returns {import("./wordmatch.mjs").Anchor | null}
   */
  function anchorAt(page, x, y) {
    const w = pageWords(page);
    if (!w || !w.tokens.length) return null;
    const slack = 1;
    const inside = (/** @type {DOMRect} */ r) => x >= r.left - slack && x <= r.right + slack && y >= r.top - slack && y <= r.bottom + slack;
    for (let k = 0; k < w.nodes.length; k++) {
      const span = w.nodes[k].parentElement;
      if (!span || !inside(span.getBoundingClientRect())) continue;
      const from = w.starts[k];
      const to = from + w.nodes[k].length;
      for (let i = 0; i < w.tokens.length; i++) {
        const t = w.tokens[i];
        if (t.end <= from || t.start >= to) continue;
        if (wordClientRects(w, i, 1).some(inside)) {
          const a = anchorOf(w.tokens, i, 1);
          return validAnchor(a) ? a : null;
        }
      }
    }
    return null;
  }

  /**
   * Where a forward search's anchor is on `page`: among the words in the line's `rects`
   * (best), on the same printed lines, or in the `near` rects (lines just after it that
   * may hold a macro argument's text); the words' SyncTeX rects, or null.
   * @param {number} page @param {number[][]} rects @param {import("./wordmatch.mjs").Anchor} anchor
   * @param {number[][]} near
   */
  function findWords(page, rects, anchor, near) {
    const w = pageWords(page);
    const g = pageGeom(page);
    if (!w || !g) return null;
    const pad = 1.5;
    const inRect = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number[]} */ r) =>
      x >= r[0] - pad && x <= r[2] + pad && y >= r[1] - pad && y <= r[3] + pad;
    /** @type {Map<number, number[][]>} */
    const seen = new Map();
    const hit = findAnchor(w.tokens, anchor, (i, count) => {
      const rs = synctexRects(wordClientRects(w, i, count), g);
      seen.set(i, rs);
      if (!rs.length) return null;
      const [l, t, r, b] = rs[0];
      const x = (l + r) / 2;
      const y = (t + b) / 2;
      if (rects.some((q) => inRect(x, y, q))) return 2;
      if (rects.some((q) => y >= q[1] - pad && y <= q[3] + pad)) return 1;
      if (near.some((q) => inRect(x, y, q))) return 0;
      return null;
    });
    return hit ? /** @type {number[][]} */ (seen.get(hit.index)) : null;
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
    const anchor = anchorAt(at.page, state.pointer.x, state.pointer.y);
    post({ type: "synctexHover", reqId, page: at.page, x: at.x, y: at.y, ...(anchor ? { anchor } : {}) });
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
      const em = Array.isArray(hit.em) && hit.em.length === 2 && hit.em.every(Number.isInteger) && hit.em[0] < hit.em[1] ? hit.em : null;
      if (em) {
        const word = document.createElement("b");
        word.className = "synctexWord";
        word.textContent = hit.text.slice(em[0], em[1]);
        body.append(hit.text.slice(0, em[0]), word, hit.text.slice(em[1]));
      } else {
        body.textContent = hit.text;
      }
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
  eventBus.on("textlayerrendered", (/** @type {{pageNumber: number}} */ e) => {
    const div = pdfViewer.getPageView(e.pageNumber - 1)?.textLayer?.div;
    if (div) wordsCache.delete(div);
  });
  eventBus.on("pagesinit", () => {
    hide();
    flashBox.replaceChildren();
  });

  // Ctrl+click: inverse search. It wins over links, selection and the marking UI (a
  // plain click still does those).
  /** @type {{x: number, y: number, at: {page: number, x: number, y: number}, anchor: any} | null} */
  let down = null;
  container.addEventListener("mousedown", (e) => {
    down = null;
    if (!state.available || !ctrlOf(e) || e.button !== 0 || inUi(e.target)) return;
    const at = pagePoint(e.clientX, e.clientY);
    if (!at) return;
    e.preventDefault();
    e.stopPropagation();
    down = { x: e.clientX, y: e.clientY, at, anchor: anchorAt(at.page, e.clientX, e.clientY) };
  }, true);
  container.addEventListener("mouseup", (e) => {
    const d = down;
    down = null;
    if (!d || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
    post({ type: "synctexEdit", page: d.at.page, x: d.at.x, y: d.at.y, ...(d.anchor ? { anchor: d.anchor } : {}) });
  }, true);
  container.addEventListener("click", (e) => {
    if (!state.available || !ctrlOf(e) || inUi(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // ---- forward search -----------------------------------------------------------------
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let flashTimer;
  let flashSeq = 0;
  /** @param {unknown} rects @returns {number[][]} */
  const validRects = (rects) => (Array.isArray(rects)
    ? rects.filter((r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite)) : []);

  /** Scroll `rects` (SyncTeX, on `page`) into view, a third down from the top. @param {number} page @param {number[][]} list */
  function scrollTo(page, list) {
    const view = pdfViewer.getPageView(page - 1);
    if (!list.length || !view?.viewport) {
      pdfViewer.currentPageNumber = page;
      return;
    }
    const vb = view.viewport.viewBox;
    const top = Math.min(...list.map((r) => r[1]));
    const [, , , y1] = synctexRectToPdf([0, top, 0, top], vb);
    const offset = (container.clientHeight * 0.33) / (view.viewport.scale || 1);
    pdfViewer.scrollPageIntoView({ pageNumber: page, destArray: [null, { name: "XYZ" }, null, Math.min(vb[3], y1 + offset), null],
      allowNegativeOffset: true });
  }

  /** Are all of `rects` inside the visible area? @param {number} page @param {number[][]} list */
  function inView(page, list) {
    const c = container.getBoundingClientRect();
    return clientRects(page, list).every((r) => r.top >= c.top && r.bottom <= c.bottom && r.left >= c.left && r.right <= c.right);
  }

  /** Resolves (true) once pdf.js has rendered the page's text layer, or (false) after a while. @param {number} page */
  function whenTextLayer(page) {
    if (textLayerOf(page)) return Promise.resolve(true);
    return new Promise((resolve) => {
      /** @param {boolean} ok */
      const done = (ok) => {
        clearTimeout(timer);
        eventBus.off("textlayerrendered", on);
        resolve(ok);
      };
      const on = (/** @type {{pageNumber: number}} */ e) => {
        if (e.pageNumber === page && textLayerOf(page)) done(true);
      };
      const timer = setTimeout(() => done(!!textLayerOf(page)), TEXT_LAYER_WAIT_MS);
      eventBus.on("textlayerrendered", on);
    });
  }

  /** Flash `list` on `page` for a moment. @param {number} page @param {number[][]} list */
  function show(page, list) {
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

  /**
   * Scroll `rects` (SyncTeX, on `page`: a source line's boxes) into view, a third down
   * from the top, and flash them for a moment. With an `anchor` (the word at the cursor),
   * once the page's text layer is there, flash just that word if it is found on or around
   * those boxes or in the `near` ones; else the boxes. Needs the pages laid out (viewer.js
   * waits for that).
   * @param {number} page @param {number[][]} rects
   * @param {{anchor?: any, near?: {page: number, rects: number[][]}[]}} [opts]
   */
  function flash(page, rects, { anchor = null, near = [] } = {}) {
    const view = pdfViewer.getPageView(page - 1);
    const list = validRects(rects);
    if (!view || !view.viewport) {
      pdfViewer.currentPageNumber = page;
      return;
    }
    scrollTo(page, list);
    const seq = ++flashSeq;
    if (!validAnchor(anchor)) {
      show(page, list);
      return;
    }
    clearTimeout(flashTimer);
    flashBox.replaceChildren();
    const areas = (Array.isArray(near) ? near : []).filter((a) => a && Number.isInteger(a.page))
      .map((a) => ({ page: a.page, rects: validRects(a.rects) }));
    void whenTextLayer(page).then(() => {
      if (seq !== flashSeq) return;
      let at = page;
      let found = findWords(page, list, anchor, areas.filter((a) => a.page === page).flatMap((a) => a.rects));
      for (const a of areas) {
        if (found) break;
        if (a.page === page) continue;
        found = findWords(a.page, [], anchor, a.rects);
        at = a.page;
      }
      if (!found) at = page;
      if (found && !inView(at, found)) scrollTo(at, found);
      show(at, found || list);
    });
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
      part.rects.push(...synctexRects(r.getClientRects(), g));
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
