// @ts-check
/**
 * Marking in the viewer, as in Okular: a floating mini-bar on a text selection, sticky
 * tools in the toolbar, a margin-note tool, keyboard shortcuts, a popover with the whole
 * thread at each annotation (reply, and edit / delete / restyle your own), a side panel
 * listing every annotation, and undo. Nothing is written here: each action is a message
 * to the extension, which writes through pdf-reader-writer-mcp's edit service; the file
 * then reloads and the new annotations come back through pdf.js.
 *
 * Messages to the extension: mark {reqId, parts: [{page, rects, text}], style, color,
 * note?}, note {reqId, page, point, note, color}, reply {reqId, xref, note}, update {reqId,
 * xref, note?, color?, style?}, delete {reqId, xref}, undo {reqId}, prefs {style, color}.
 * Messages from it: marking {enabled, reason, author, keys, style?, color?}, annotations
 * {list}, editResult {reqId, ok, result | error}.
 * Events it dispatches: annotationsrebuilt {anns} (after each rebuild of the model).
 */

import {
  PALETTE, STYLES, SUBTYPE_STYLE, hex, paletteColor, paletteName, clientRectsToPdf,
  clientPointToPdf, pdfRectToClient, splitQuads, quadRect, hitTest, isOwn, xrefOf, buildThreads,
  threadRoot, formatPdfDate, typeLabel,
} from "./marking.mjs";
import { keymap, actionFor } from "./keys.mjs";
import { normaliseSelection } from "./textnorm.mjs";

/** @typedef {import("./marking.mjs").Ann} Ann */

const STYLE_LABEL = { highlight: "Highlight", underline: "Underline", squiggly: "Squiggly", strikeout: "Strikeout" };
/** Annotation types not listed or hit-tested (links and forms keep their own behaviour). */
const SKIP = new Set(["Link", "Popup", "Widget"]);

/**
 * @param {{pdfViewer: any, eventBus: any, container: HTMLElement, post: (m: any) => void,
 *          getDocument: () => any, vscode: any}} ctx
 */
export function setupMarking({ pdfViewer, eventBus, container, post, getDocument, vscode }) {
  /** @param {string} id */
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const saved = (vscode.getState && vscode.getState()) || {};

  const state = {
    enabled: false,
    reason: "waiting for the edit service (pdf-reader-writer-edit)",
    author: "",
    keys: keymap({}),
    /** @type {string} */
    tool: "none",
    style: STYLES.includes(saved.style) ? saved.style : "highlight",
    color: paletteColor(saved.color) ? saved.color : "yellow",
    panelOpen: !!saved.panelOpen,
  };

  /** @type {Ann[]} */
  let anns = [];
  /** @type {Map<string, Ann>} */
  let byId = new Map();
  /** @type {Map<number, Ann[]>} */
  let byPage = new Map();
  /** Marked text from the service's `list`, by xref. @type {Map<number, string>} */
  let serviceText = new Map();
  let modelGen = 0;

  // ---- requests -------------------------------------------------------------------
  let reqSeq = 0;
  /** @type {Map<number, (r: any) => void>} */
  const waiting = new Map();
  /** @param {string} type @param {Record<string, unknown>} fields @returns {Promise<any>} */
  function request(type, fields) {
    const reqId = ++reqSeq;
    post({ type, reqId, ...fields });
    return new Promise((resolve) => waiting.set(reqId, resolve));
  }
  /** @param {string} what @param {any} r */
  function reportFailure(what, r) {
    if (r && !r.ok) showStatus(`Could not ${what}: ${r.error}`, true);
    return !!(r && r.ok);
  }

  // ---- status line ----------------------------------------------------------------
  const status = $("status");
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let statusTimer;
  /** @param {string} text @param {boolean} [error] */
  function showStatus(text, error = false) {
    status.textContent = text;
    status.hidden = !text;
    status.classList.toggle("error", error);
    clearTimeout(statusTimer);
    if (text) statusTimer = setTimeout(() => (status.hidden = true), error ? 8000 : 3000);
  }

  // ---- overlay layer (scrolls with the pages) --------------------------------------
  const layer = document.createElement("div");
  layer.id = "vpdfLayer";
  container.append(layer);

  /** Client rect -> position inside the scrolled container. @param {number} x @param {number} y */
  function toLayer(x, y) {
    const c = container.getBoundingClientRect();
    return { x: x - c.left + container.scrollLeft, y: y - c.top + container.scrollTop };
  }

  /** Place `el` below (or above, if no room) a client rect, inside the visible area. @param {HTMLElement} el @param {{left: number, top: number, right: number, bottom: number}} r */
  function place(el, r) {
    const c = container.getBoundingClientRect();
    el.style.left = "0px";
    el.style.top = "0px";
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = Math.min(Math.max(r.left, c.left + 4), c.right - w - 18);
    let y = r.bottom + 6;
    if (y + h > c.bottom - 4 && r.top - h - 6 > c.top) y = r.top - h - 6;
    x = Math.max(x, c.left + 4);
    const p = toLayer(x, y);
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
  }

  // ---- geometry of a page ------------------------------------------------------------
  /** @param {number} page */
  function pageGeom(page) {
    const view = pdfViewer.getPageView(page - 1);
    if (!view || !view.div) return null;
    const r = view.div.getBoundingClientRect();
    return { view, viewport: view.viewport, origin: { left: r.left + view.div.clientLeft, top: r.top + view.div.clientTop } };
  }
  /** @param {Element | null} el */
  function pageNumberOf(el) {
    const p = el?.closest(".page[data-page-number]");
    return p ? Number(/** @type {HTMLElement} */ (p).dataset.pageNumber) : null;
  }
  /** Client rect covering an annotation. @param {Ann} a */
  function clientBox(a) {
    const g = pageGeom(a.page);
    if (!g) return null;
    const boxes = (a.quads.length ? a.quads.map(quadRect) : [a.rect]).map((b) => pdfRectToClient(b, g.origin, g.viewport));
    return {
      left: Math.min(...boxes.map((b) => b.left)), top: Math.min(...boxes.map((b) => b.top)),
      right: Math.max(...boxes.map((b) => b.right)), bottom: Math.max(...boxes.map((b) => b.bottom)),
    };
  }
  /** The annotation under a client point. @param {number} x @param {number} y @param {Element | null} target */
  function annotationAt(x, y, target) {
    const page = pageNumberOf(target);
    if (!page) return null;
    const g = pageGeom(page);
    const list = byPage.get(page);
    if (!g || !list) return null;
    return hitTest(list, clientPointToPdf(x, y, g.origin, g.viewport));
  }

  // ---- the annotation model (pdf.js data + the service's marked text) ----------------
  async function rebuild() {
    const doc = getDocument();
    const gen = ++modelGen;
    if (!doc) return;
    /** @type {Ann[]} */
    const out = [];
    for (let n = 1; n <= doc.numPages; n++) {
      let items;
      try {
        items = await (await doc.getPage(n)).getAnnotations({ intent: "display" });
      } catch {
        continue;
      }
      if (gen !== modelGen) return;
      for (const d of items) {
        if (SKIP.has(d.subtype) || !d.subtype) continue;
        out.push({
          id: String(d.id),
          xref: xrefOf(String(d.id)),
          page: n,
          subtype: d.subtype,
          rect: Array.from(d.rect || [0, 0, 0, 0]),
          quads: SUBTYPE_STYLE[d.subtype] ? splitQuads(d.quadPoints) : [],
          color: d.color ? Array.from(d.color).map((c) => Number(c) / 255) : null,
          note: d.contentsObj?.str || "",
          author: d.titleObj?.str || "",
          modified: d.modificationDate || "",
          created: d.creationDate || d.modificationDate || "",
          irt: d.inReplyTo || null,
        });
      }
    }
    if (gen !== modelGen) return;
    anns = out;
    byId = new Map(out.map((a) => [a.id, a]));
    byPage = new Map();
    for (const a of out) byPage.set(a.page, [...(byPage.get(a.page) || []), a]);
    refreshViews();
    // the minimap (minimap.mjs) draws the marks over its thumbnails from the model
    eventBus.dispatch("annotationsrebuilt", { source: null, anns });
  }
  /** @param {Ann} a */
  const textOf = (a) => (a.xref != null && serviceText.get(a.xref)) || "";

  function refreshViews() {
    renderPanel();
    if (popover.id) {
      if (byId.has(popover.id)) openPopover(popover.id, { keepReply: true });
      else closePopover();
    }
  }

  eventBus.on("pagesinit", () => {
    hideTip();
    hideMiniBar();
    closeNoteEditor();
    void rebuild();
  });

  // ---- toolbar ---------------------------------------------------------------------
  const toolButtons = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll("#markTools .tool")]);
  const colorButton = /** @type {HTMLButtonElement} */ ($("colorButton"));
  const colorMenu = $("colorMenu");
  const undoButton = /** @type {HTMLButtonElement} */ ($("undo"));
  const panelToggle = $("panelToggle");
  const panel = $("annotPanel");

  /** @param {string} action */
  function keyLabel(action) {
    const spec = state.keys[action];
    if (!spec) return "";
    const mods = [spec.ctrl && "Ctrl", spec.alt && "Alt", spec.shift && "Shift", spec.meta && "Meta"].filter(Boolean);
    return [...mods, spec.key.length === 1 ? spec.key.toUpperCase() : spec.key].join("+");
  }

  function renderToolbar() {
    for (const b of toolButtons) {
      const tool = /** @type {string} */ (b.dataset.tool);
      b.disabled = !state.enabled;
      b.setAttribute("aria-pressed", String(state.tool === tool));
      const name = tool === "note" ? "Margin note tool" : `${STYLE_LABEL[/** @type {keyof typeof STYLE_LABEL} */ (tool)]} tool`;
      b.title = state.enabled ? `${name} (${keyLabel(tool)})` : `${name}: marking is off (${state.reason})`;
    }
    colorButton.disabled = !state.enabled;
    undoButton.disabled = !state.enabled;
    undoButton.title = state.enabled ? `Undo your last mark action (${keyLabel("undo")})` : `Undo: marking is off (${state.reason})`;
    $("colorSwatch").style.background = hex(/** @type {any} */ (paletteColor(state.color)).rgb);
    colorButton.title = `Colour: ${state.color}`;
    document.body.classList.toggle("tool-note", state.tool === "note");
    document.body.classList.toggle("tool-mark", STYLES.includes(state.tool));
    panelToggle.setAttribute("aria-pressed", String(state.panelOpen));
    panel.hidden = !state.panelOpen;
    document.body.classList.toggle("panel-open", state.panelOpen);
  }

  function savePrefs() {
    vscode.setState?.({ ...(vscode.getState?.() || {}), style: state.style, color: state.color, panelOpen: state.panelOpen });
    post({ type: "prefs", style: state.style, color: state.color });
  }

  /** @param {string} tool */
  function setTool(tool) {
    state.tool = tool;
    if (STYLES.includes(tool)) state.style = tool;
    if (tool !== "note") closeNoteEditor();
    renderToolbar();
  }

  for (const b of toolButtons) {
    b.addEventListener("click", () => {
      const tool = /** @type {string} */ (b.dataset.tool);
      setTool(state.tool === tool ? "none" : tool);
      if (STYLES.includes(tool)) savePrefs();
    });
  }

  /** @param {(name: string) => void} onPick @param {string} current */
  function swatches(onPick, current) {
    const row = document.createElement("span");
    row.className = "swatches";
    for (const p of PALETTE) {
      const s = document.createElement("button");
      s.type = "button";
      s.className = "swatchButton";
      s.dataset.color = p.name;
      s.title = p.name;
      s.setAttribute("aria-label", p.name);
      s.setAttribute("aria-pressed", String(p.name === current));
      s.style.setProperty("--swatch", hex(p.rgb));
      s.addEventListener("mousedown", (e) => e.preventDefault());
      s.addEventListener("click", (e) => {
        e.stopPropagation();
        onPick(p.name);
      });
      row.append(s);
    }
    return row;
  }

  function closeColorMenu() {
    colorMenu.hidden = true;
    colorButton.setAttribute("aria-expanded", "false");
  }
  colorButton.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!colorMenu.hidden) return closeColorMenu();
    colorMenu.replaceChildren(swatches((name) => {
      state.color = name;
      savePrefs();
      renderToolbar();
      closeColorMenu();
    }, state.color));
    const r = colorButton.getBoundingClientRect();
    colorMenu.style.left = `${r.left}px`;
    colorMenu.style.top = `${r.bottom + 2}px`;
    colorMenu.hidden = false;
    colorButton.setAttribute("aria-expanded", "true");
  });
  document.addEventListener("click", (e) => {
    if (!colorMenu.hidden && !colorMenu.contains(/** @type {Node} */ (e.target))) closeColorMenu();
  });
  undoButton.addEventListener("click", () => void undo());
  panelToggle.addEventListener("click", () => {
    state.panelOpen = !state.panelOpen;
    savePrefs();
    renderToolbar();
    renderPanel();
  });

  // ---- the selection ---------------------------------------------------------------
  /**
   * The current text-layer selection as mark parts: per page, its client rects (one per
   * text run, clipped to the selection) converted to PDF user space, and its text.
   */
  function captureSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const root = range.commonAncestorContainer;
    const walkRoot = root.nodeType === Node.TEXT_NODE ? /** @type {Node} */ (root.parentNode) : root;
    if (!walkRoot) return null;
    /** @type {Map<number, {rects: DOMRect[], texts: string[]}>} */
    const pages = new Map();
    const walker = document.createTreeWalker(walkRoot, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!range.intersectsNode(n)) continue;
      const parent = n.parentElement;
      if (!parent || !parent.closest(".textLayer") || parent.closest(".vpdf-ui")) continue;
      const page = pageNumberOf(parent);
      if (!page) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      if (n === range.startContainer) r.setStart(n, range.startOffset);
      if (n === range.endContainer) r.setEnd(n, range.endOffset);
      const text = r.toString();
      if (!text.trim()) continue;
      const part = pages.get(page) || { rects: [], texts: [] };
      part.rects.push(...r.getClientRects());
      part.texts.push(text);
      pages.set(page, part);
    }
    if (!pages.size) return null;
    const whole = normaliseSelection(sel.toString());
    /** @type {{page: number, rects: number[][], text: string}[]} */
    const parts = [];
    for (const [page, part] of [...pages].sort((a, b) => a[0] - b[0])) {
      const g = pageGeom(page);
      if (!g) continue;
      const rects = clientRectsToPdf(part.rects, g.origin, g.viewport);
      if (!rects.length) continue;
      parts.push({ page, rects, text: pages.size === 1 ? whole : normaliseSelection(part.texts.join(" ")) });
    }
    if (!parts.length) return null;
    const last = range.getClientRects();
    const anchor = last.length ? last[last.length - 1] : range.getBoundingClientRect();
    return { parts, anchor: { left: anchor.left, top: anchor.top, right: anchor.right, bottom: anchor.bottom } };
  }

  /**
   * Mark `sel` (or the live selection). The DOM selection is cleared, so the published
   * selection becomes null, as after any click.
   * @param {string} style @param {string} color @param {string | null} note
   * @param {ReturnType<typeof captureSelection>} [sel]
   */
  async function markSelection(style, color, note, sel = captureSelection()) {
    if (!state.enabled) return showStatus(`Marking is off: ${state.reason}`, true);
    if (!sel) return showStatus("Select some text first");
    state.style = style;
    state.color = color;
    savePrefs();
    renderToolbar();
    window.getSelection()?.removeAllRanges();
    hideMiniBar();
    const r = await request("mark", { parts: sel.parts, style, color, ...(note ? { note } : {}) });
    reportFailure(`mark the selection`, r);
  }

  // ---- mini-bar --------------------------------------------------------------------
  const bar = document.createElement("div");
  bar.className = "vpdf-ui miniBar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Mark the selection");
  bar.hidden = true;
  layer.append(bar);
  /** @type {ReturnType<typeof captureSelection>} */
  let barSel = null;

  function renderMiniBar() {
    bar.replaceChildren();
    const styles = document.createElement("span");
    styles.className = "styles";
    for (const st of STYLES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "styleButton";
      b.dataset.style = st;
      b.title = `${STYLE_LABEL[/** @type {keyof typeof STYLE_LABEL} */ (st)]} (${keyLabel(st)})`;
      b.setAttribute("aria-label", STYLE_LABEL[/** @type {keyof typeof STYLE_LABEL} */ (st)]);
      b.setAttribute("aria-pressed", String(st === state.style));
      const g = document.createElement("span");
      g.className = `glyph g-${st}`;
      g.textContent = "ab";
      g.style.setProperty("--mark", hex(/** @type {any} */ (paletteColor(state.color)).rgb));
      b.append(g);
      b.addEventListener("click", () => void markSelection(st, state.color, null, barSel));
      styles.append(b);
    }
    const noteButton = document.createElement("button");
    noteButton.type = "button";
    noteButton.className = "noteButton";
    noteButton.textContent = "+ note";
    noteButton.title = "Mark and add a note";
    noteButton.addEventListener("click", () => openBarNote());
    bar.append(styles, swatches((name) => void markSelection(state.style, name, null, barSel), state.color), noteButton);
  }

  function openBarNote() {
    if (bar.querySelector("textarea")) return;
    const box = document.createElement("div");
    box.className = "noteBox";
    const ta = document.createElement("textarea");
    ta.rows = 3;
    ta.placeholder = "Note (Enter to save, Shift+Enter for a new line, Esc to cancel)";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "primary";
    ok.textContent = "Mark";
    const go = () => void markSelection(state.style, state.color, ta.value.trim() || null, barSel);
    ok.addEventListener("click", go);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        go();
      }
    });
    box.append(ta, ok);
    bar.append(box);
    ta.focus();
  }

  /** @param {NonNullable<ReturnType<typeof captureSelection>>} sel */
  function showMiniBar(sel) {
    barSel = sel;
    closePopover();
    renderMiniBar();
    bar.hidden = false;
    place(bar, sel.anchor);
  }
  function hideMiniBar() {
    bar.hidden = true;
    barSel = null;
    bar.replaceChildren();
  }
  bar.addEventListener("mousedown", (e) => {
    // keep the text selection while clicking the bar (but let text fields take focus)
    if (!(e.target instanceof HTMLTextAreaElement)) e.preventDefault();
  });

  document.addEventListener("selectionchange", () => {
    if (bar.hidden || bar.contains(document.activeElement)) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) hideMiniBar();
  });

  /** A selection was made with the mouse (or keyboard) in the pages. */
  function onSelectionEnd() {
    const sel = captureSelection();
    if (!sel) return;
    if (!state.enabled) return;
    if (STYLES.includes(state.tool)) void markSelection(state.tool, state.color, null, sel);
    else showMiniBar(sel);
  }

  // ---- margin notes ----------------------------------------------------------------
  const noteEditor = document.createElement("div");
  noteEditor.className = "vpdf-ui noteEditor";
  noteEditor.hidden = true;
  layer.append(noteEditor);

  /** @param {number} page @param {[number, number]} point @param {{left: number, top: number}} at */
  function openNoteEditor(page, point, at) {
    noteEditor.replaceChildren();
    const ta = document.createElement("textarea");
    ta.rows = 3;
    ta.placeholder = "Margin note (Enter to save, Shift+Enter for a new line, Esc to cancel)";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "primary";
    ok.textContent = "Add note";
    const go = async () => {
      const note = ta.value.trim();
      if (!note) return closeNoteEditor();
      closeNoteEditor();
      reportFailure("add the note", await request("note", { page, point, note, color: state.color }));
    };
    ok.addEventListener("click", () => void go());
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void go();
      }
    });
    noteEditor.append(ta, ok);
    noteEditor.hidden = false;
    noteEditor.dataset.page = String(page);
    noteEditor.dataset.point = JSON.stringify(point);
    const p = toLayer(at.left, at.top);
    noteEditor.style.left = `${p.x}px`;
    noteEditor.style.top = `${p.y}px`;
    ta.focus();
  }
  function closeNoteEditor() {
    noteEditor.hidden = true;
    noteEditor.replaceChildren();
  }

  // ---- hover tip -------------------------------------------------------------------
  const tip = document.createElement("div");
  tip.className = "vpdf-ui tip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  layer.append(tip);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let tipTimer;
  let tipId = "";
  /** @param {Ann} a */
  function showTip(a) {
    if (tipId === a.id && !tip.hidden) return;
    clearTimeout(tipTimer);
    tipId = a.id;
    tipTimer = setTimeout(() => {
      if (popover.id === a.id) return;
      tip.replaceChildren();
      const head = document.createElement("div");
      head.className = "tipHead";
      head.textContent = [a.author || "(no author)", typeLabel(a.subtype)].join(" · ");
      const body = document.createElement("div");
      body.className = "tipBody";
      const replies = anns.filter((x) => x.irt === a.id).length;
      body.textContent = a.note || (replies ? "" : "(no note)");
      tip.append(head, body);
      if (replies) {
        const more = document.createElement("div");
        more.className = "tipMore";
        more.textContent = `${replies} ${replies === 1 ? "reply" : "replies"}: click to open`;
        tip.append(more);
      }
      tip.hidden = false;
      const box = clientBox(a);
      if (box) place(tip, box);
    }, 250);
  }
  function hideTip() {
    clearTimeout(tipTimer);
    tipId = "";
    tip.hidden = true;
  }

  // ---- popover with the thread -------------------------------------------------------
  const pop = document.createElement("div");
  pop.className = "vpdf-ui popover";
  pop.setAttribute("role", "dialog");
  pop.hidden = true;
  layer.append(pop);
  /** Open popover: its annotation, reply target, the entry being edited, and unsent text. */
  const popover = { id: "", replyTo: "", editing: "", draft: "", editDraft: /** @type {string | null} */ (null) };

  /** @param {string} tag @param {string} [cls] @param {string} [text] */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  /** @param {string} label @param {() => void} fn @param {string} [cls] */
  function button(label, fn, cls) {
    const b = /** @type {HTMLButtonElement} */ (el("button", cls, label));
    b.type = "button";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  }

  /** A chip in the annotation's colour. @param {Ann} a */
  function chip(a) {
    const c = el("span", "chip");
    c.style.background = a.color ? hex(a.color) : "transparent";
    c.title = (a.color && paletteName(a.color)) || (a.color ? hex(a.color) : "no colour");
    return c;
  }

  /** One annotation in a thread (popover) with its replies. @param {any} node @param {number} depth */
  function threadItem(node, depth) {
    /** @type {Ann} */
    const a = node;
    const own = state.enabled && isOwn(a, state.author);
    const item = el("div", "item");
    item.dataset.id = a.id;
    item.classList.toggle("own", isOwn(a, state.author));
    item.classList.toggle("current", a.id === popover.id);
    const head = el("div", "head");
    head.append(chip(a), el("span", "type", typeLabel(a.subtype)), el("span", "author", a.author || "(no author)"),
      el("span", "date", formatPdfDate(a.modified || a.created)));
    item.append(head);
    const quote = textOf(a);
    if (quote) item.append(el("blockquote", "quote", quote));
    if (popover.editing === a.id) {
      const ta = /** @type {HTMLTextAreaElement} */ (el("textarea", "editNote"));
      ta.rows = 3;
      ta.value = popover.editDraft ?? a.note;
      const save = async () => {
        popover.editing = "";
        popover.editDraft = null;
        const note = ta.value;
        openPopover(popover.id, { keepReply: true });
        reportFailure("change the note", await request("update", { xref: a.xref, note }));
      };
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          void save();
        }
      });
      const row = el("div", "actions");
      row.append(button("Save", () => void save(), "primary"), button("Cancel", () => {
        popover.editing = "";
        popover.editDraft = null;
        openPopover(popover.id, { keepReply: true });
      }));
      item.append(ta, row);
      setTimeout(() => ta.focus(), 0);
    } else if (a.note) {
      item.append(el("div", "note", a.note));
    }
    const actions = el("div", "actions");
    if (state.enabled && a.xref != null) {
      actions.append(button("Reply", () => {
        popover.replyTo = a.id;
        openPopover(popover.id, { keepReply: true, focusReply: true });
      }, "replyButton"));
    }
    if (own && popover.editing !== a.id) {
      actions.append(button("Edit", () => {
        popover.editing = a.id;
        popover.editDraft = null;
        openPopover(popover.id, { keepReply: true });
      }, "editButton"));
      actions.append(button("Delete", () => void (async () => {
        reportFailure("delete it", await request("delete", { xref: a.xref }));
      })(), "deleteButton"));
    }
    if (actions.childElementCount) item.append(actions);
    if (own) {
      const restyle = el("div", "restyle");
      if (SUBTYPE_STYLE[a.subtype]) {
        const styles = el("span", "styles");
        for (const st of STYLES) {
          const b = button("ab", () => void (async () => {
            const r = await request("update", { xref: a.xref, style: st });
            if (reportFailure("change the style", r) && r.result?.xref && popover.id === a.id) popover.id = `${r.result.xref}R`;
          })(), "styleButton");
          b.dataset.style = st;
          b.title = STYLE_LABEL[/** @type {keyof typeof STYLE_LABEL} */ (st)];
          b.setAttribute("aria-pressed", String(SUBTYPE_STYLE[a.subtype] === st));
          b.replaceChildren(el("span", `glyph g-${st}`, "ab"));
          styles.append(b);
        }
        restyle.append(styles);
      }
      restyle.append(swatches((name) => void (async () => {
        reportFailure("change the colour", await request("update", { xref: a.xref, color: name }));
      })(), (a.color && paletteName(a.color)) || ""));
      item.append(restyle);
    }
    if (node.replies.length) {
      const rep = el("div", "replies");
      for (const r of node.replies) rep.append(threadItem(r, depth + 1));
      item.append(rep);
    }
    return item;
  }

  /**
   * Open (or re-render) the popover for annotation `id`, showing its whole thread.
   * @param {string} id @param {{keepReply?: boolean, focusReply?: boolean}} [opts]
   */
  function openPopover(id, { keepReply = false, focusReply = false } = {}) {
    const a = byId.get(id);
    if (!a) return closePopover();
    hideTip();
    // Re-rendered (a reload, a new reply target): keep what is being typed, and the focus.
    const draftEl = /** @type {HTMLTextAreaElement | null} */ (pop.querySelector(".replyBox textarea"));
    const editEl = /** @type {HTMLTextAreaElement | null} */ (pop.querySelector("textarea.editNote"));
    const typingReply = !!draftEl && document.activeElement === draftEl;
    if (keepReply && draftEl) popover.draft = draftEl.value;
    if (keepReply && editEl && popover.editing) popover.editDraft = editEl.value;
    if (!keepReply || popover.id !== id) {
      if (popover.id !== id) {
        popover.draft = "";
        popover.editing = "";
        popover.editDraft = null;
      }
      popover.replyTo = id;
    }
    popover.id = id;
    const root = threadRoot(byId, id) || a;
    const thread = buildThreads(anns).find((t) => t.id === root.id) || { ...root, replies: [] };
    pop.replaceChildren();
    const top = el("div", "popHead");
    top.append(el("span", "title", `Page ${a.page}`), button("×", closePopover, "close"));
    /** @type {HTMLButtonElement} */ (top.lastChild).title = "Close (Escape)";
    pop.append(top, el("div", "thread"));
    /** @type {HTMLElement} */ (pop.lastChild).append(threadItem(thread, 0));
    if (state.enabled) {
      const target = byId.get(popover.replyTo) || a;
      if (target.xref != null) {
        const box = el("div", "replyBox");
        const label = el("label", "replyLabel", `Reply to ${target.author || "this"} (${typeLabel(target.subtype).toLowerCase()})`);
        const ta = /** @type {HTMLTextAreaElement} */ (el("textarea"));
        ta.rows = 2;
        ta.placeholder = "Reply (Enter to send, Shift+Enter for a new line)";
        ta.value = popover.draft;
        const send = async () => {
          const note = ta.value.trim();
          if (!note) return;
          popover.draft = "";
          ta.value = "";
          reportFailure("reply", await request("reply", { xref: target.xref, note }));
        };
        ta.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        });
        box.append(label, ta, button("Reply", () => void send(), "primary sendReply"));
        pop.append(box);
        if (focusReply || (keepReply && typingReply)) setTimeout(() => ta.focus(), 0);
      }
    } else {
      pop.append(el("div", "off", `Marking is off: ${state.reason}`));
    }
    pop.hidden = false;
    const box = clientBox(a);
    if (box) place(pop, box);
  }
  function closePopover() {
    popover.id = "";
    popover.editing = "";
    popover.draft = "";
    popover.editDraft = null;
    pop.hidden = true;
    pop.replaceChildren();
  }

  // ---- side panel ------------------------------------------------------------------
  /** @param {any} node */
  function panelItem(node) {
    /** @type {Ann} */
    const a = node;
    const item = el("div", "panelItem");
    item.dataset.id = a.id;
    item.tabIndex = 0;
    item.classList.toggle("own", isOwn(a, state.author));
    const head = el("div", "head");
    head.append(chip(a), el("span", "type", typeLabel(a.subtype)), el("span", "author", a.author || "(no author)"));
    item.append(head);
    const quote = textOf(a);
    if (quote) item.append(el("div", "quote", quote));
    if (a.note) item.append(el("div", "note", a.note));
    if (node.replies.length) {
      const rep = el("div", "replies");
      for (const r of node.replies) rep.append(panelItem(r));
      item.append(rep);
    }
    const open = (/** @type {Event} */ e) => {
      e.stopPropagation();
      jumpTo(a);
    };
    item.addEventListener("click", open);
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter") open(e);
    });
    return item;
  }

  function renderPanel() {
    if (!state.panelOpen) return;
    const roots = buildThreads(anns);
    const head = el("div", "panelHead", `Annotations (${anns.length})`);
    panel.replaceChildren(head);
    if (!roots.length) {
      panel.append(el("div", "empty", "No annotations in this PDF."));
      return;
    }
    let page = 0;
    for (const r of roots) {
      if (r.page !== page) {
        page = r.page;
        panel.append(el("div", "pageHead", `Page ${page}`));
      }
      panel.append(panelItem(r));
    }
  }

  /** Scroll the annotation into view and open its popover. @param {Ann} a */
  function jumpTo(a) {
    const top = a.quads.length ? Math.max(...a.quads.map((q) => quadRect(q)[3])) : a.rect[3];
    pdfViewer.scrollPageIntoView({ pageNumber: a.page, destArray: [null, { name: "XYZ" }, null, top + 36, null], allowNegativeOffset: true });
    requestAnimationFrame(() => openPopover(a.id));
  }

  // ---- undo ------------------------------------------------------------------------
  async function undo() {
    if (!state.enabled) return showStatus(`Marking is off: ${state.reason}`, true);
    const r = await request("undo", {});
    if (!r.ok) return showStatus(r.error, true);
    showStatus(r.result ? `Undone: ${r.result.label}` : "Nothing to undo");
  }

  // ---- pointer ---------------------------------------------------------------------
  /** @param {EventTarget | null} t */
  const inUi = (t) => t instanceof Element && !!t.closest(".vpdf-ui");
  /** @param {EventTarget | null} t */
  const onLink = (t) => t instanceof Element && !!t.closest("a[href], .linkAnnotation, [class*='WidgetAnnotation']");

  let moveQueued = false;
  /** @type {PointerEvent | null} */
  let lastMove = null;
  container.addEventListener("pointermove", (e) => {
    lastMove = e;
    if (moveQueued) return;
    moveQueued = true;
    requestAnimationFrame(() => {
      moveQueued = false;
      const ev = lastMove;
      if (!ev || ev.buttons || inUi(ev.target) || state.tool === "note") {
        document.body.classList.remove("over-annot");
        return;
      }
      const a = annotationAt(ev.clientX, ev.clientY, /** @type {Element} */ (ev.target));
      document.body.classList.toggle("over-annot", !!a);
      if (a) showTip(a);
      else hideTip();
    });
  }, { passive: true });
  container.addEventListener("pointerleave", () => {
    document.body.classList.remove("over-annot");
    hideTip();
  });

  // A click is a mousedown and mouseup close together with no text selected. (The `click`
  // event is unreliable here: pdf.js moves the text layer's end-of-content node on
  // mousedown, and Chrome then drops the click.)
  /** @type {{x: number, y: number, target: EventTarget | null} | null} */
  let down = null;
  container.addEventListener("mousedown", (e) => {
    down = null;
    if (inUi(e.target) || e.button !== 0) return;
    hideTip();
    closeColorMenu();
    down = { x: e.clientX, y: e.clientY, target: e.target };
  });
  container.addEventListener("mouseup", (e) => {
    const start = down;
    down = null;
    if (!start || e.button !== 0 || inUi(e.target)) return;
    const { clientX: x, clientY: y } = e;
    setTimeout(() => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return onSelectionEnd();
      if (Math.hypot(x - start.x, y - start.y) > 4 || onLink(start.target)) return;
      onClick(x, y, /** @type {Element} */ (start.target));
    }, 0);
  });

  /** @param {number} x @param {number} y @param {Element} target */
  function onClick(x, y, target) {
    if (state.tool === "note") {
      const page = pageNumberOf(target);
      const g = page ? pageGeom(page) : null;
      if (!page || !g || !state.enabled) return;
      closePopover();
      openNoteEditor(page, clientPointToPdf(x, y, g.origin, g.viewport), { left: x, top: y });
      return;
    }
    const a = annotationAt(x, y, target);
    if (a) openPopover(a.id);
    else if (!pop.hidden) closePopover();
  }

  // ---- keys ------------------------------------------------------------------------
  /** Escape: close what is open, else drop the tool. @returns {boolean} whether it did something */
  function escape() {
    if (!colorMenu.hidden) return closeColorMenu(), true;
    if (!noteEditor.hidden) return closeNoteEditor(), true;
    if (popover.editing) {
      popover.editing = "";
      popover.editDraft = null;
      openPopover(popover.id, { keepReply: true });
      return true;
    }
    if (!pop.hidden) return closePopover(), true;
    if (!bar.hidden) {
      hideMiniBar();
      return true;
    }
    if (state.tool !== "none") return setTool("none"), true;
    return false;
  }

  // VS Code forwards the webview's keydown/keyup events from bubble-phase listeners on this
  // window; stopping a handled key in the capture phase keeps VS Code from acting on it.
  /** @type {Set<string>} */
  const swallowed = new Set();
  window.addEventListener("keyup", (e) => {
    if (swallowed.delete(e.code)) e.stopPropagation();
  }, true);
  window.addEventListener("keydown", (e) => {
    const action = actionFor(e, state.keys);
    if (!action) return;
    if (action === "escape") {
      if (escape()) {
        e.preventDefault();
        e.stopPropagation();
        swallowed.add(e.code);
      }
      return;
    }
    // Ours: VS Code must not act on it too.
    e.preventDefault();
    e.stopPropagation();
    swallowed.add(e.code);
    if (!state.enabled) return showStatus(`Marking is off: ${state.reason}`, true);
    if (action === "undo") void undo();
    else if (action === "note") setTool(state.tool === "note" ? "none" : "note");
    else void markSelection(action, state.color, null, barSel && !bar.hidden ? barSel : captureSelection());
  }, true);

  container.addEventListener("scroll", () => hideTip(), { passive: true });

  // ---- messages from the extension -------------------------------------------------
  /** @param {any} msg @returns {boolean} whether it was a marking message */
  function handle(msg) {
    switch (msg.type) {
      case "marking":
        state.enabled = !!msg.enabled;
        state.reason = msg.reason || "";
        state.author = typeof msg.author === "string" ? msg.author : "";
        state.keys = keymap(msg.keys);
        if (typeof msg.style === "string" && STYLES.includes(msg.style) && !saved.style) state.style = msg.style;
        if (typeof msg.color === "string" && paletteColor(msg.color) && !saved.color) state.color = msg.color;
        if (!state.enabled) setTool("none");
        renderToolbar();
        refreshViews();
        return true;
      case "annotations":
        serviceText = new Map((Array.isArray(msg.list) ? msg.list : [])
          .filter((/** @type {any} */ a) => typeof a.xref === "number" && typeof a.text === "string")
          .map((/** @type {any} */ a) => [a.xref, a.text]));
        refreshViews();
        return true;
      case "editResult": {
        const done = waiting.get(msg.reqId);
        waiting.delete(msg.reqId);
        done?.(msg);
        return true;
      }
      default:
        return false;
    }
  }

  renderToolbar();
  return { handle, rebuild };
}
