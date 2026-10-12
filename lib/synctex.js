// @ts-check
/**
 * SyncTeX in-process: parse a `.synctex(.gz)` file and answer reverse (PDF point to
 * source line) and forward (source line to PDF boxes) queries. Pure Node: no `vscode`.
 *
 * The node model and the search rules (visible hbox sizes, the box boundary nodes, the
 * tag/line fix-ups of heading boundaries and of trailing kern+glue, the smallest
 * containing hbox, the closest left and right children, the kern distance, the "friend"
 * lists of the forward search) are a JavaScript port of the approach of SyncTeX's parser,
 * synctex_parser.c (version 1.21), whose notice follows. Forms (`<`, `>`, `f` records,
 * rare outside ConTeXt) are skipped. Results are checked against the `synctex` command
 * line tool in test/synctex.test.js.
 *
 *   Copyright (c) 2008-2017 jerome DOT laurens AT u-bourgogne DOT fr
 *   This file is part of the __SyncTeX__ package.
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this
 *   software and associated documentation files (the "Software"), to deal in the
 *   Software without restriction, including without limitation the rights to use, copy,
 *   modify, merge, publish, distribute, sublicense, and/or sell copies of the Software,
 *   and to permit persons to whom the Software is furnished to do so, subject to the
 *   following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 *   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 *   PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 *   HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 *   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
 *   OR THE USE OR OTHER DEALINGS IN THE SOFTWARE
 *
 *   Except as contained in this notice, the name of the copyright holder shall not be
 *   used in advertising or otherwise to promote the sale, use or other dealings in this
 *   Software without prior written authorization from the copyright holder.
 *
 * Coordinates: everything public is in PDF big points (1/72 in) with the origin at the
 * top-left corner of the page, as the synctex CLI uses them. (pdf.js PDF space has its
 * origin at the bottom-left; the webview converts.) Rects are `[left, top, right, bottom]`.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

/** sp per bp. */
const SP_PER_BP = 65781.76;

/**
 * Node types: `[` vbox, `(` hbox, `v` void vbox, `h` void hbox, `k` kern, `g` glue,
 * `$` math, `x` boundary, `r` rule, `B` box boundary (made by the parser at both ends of
 * every hbox, as SyncTeX does).
 * @typedef {{t: string, tag: number, line: number, col: number, h: number, v: number,
 *   W: number, H: number, D: number, page: number, parent: SNode | null,
 *   kids: SNode[] | null, hV: number, vV: number, WV: number, HV: number, DV: number,
 *   fl: number}} SNode `fl`: the line a forward search finds the node under (-1: never),
 *   as SyncTeX's "friend" lists file it
 * @typedef {{file: string, line: number, column: number | null}} SourcePos
 * @typedef {[number, number, number, number]} Rect
 * @typedef {{file: string, line: number, column: number | null, rects: Rect[],
 *   results: SourcePos[]}} EditHit
 * @typedef {{page: number, line: number, rects: Rect[], boxes: Rect[]}} ViewHit
 */

const BOXES = new Set(["[", "(", "v", "h"]);
const isBox = (/** @type {SNode | null | undefined} */ n) => !!n && BOXES.has(n.t);
const INT_MAX = Number.MAX_SAFE_INTEGER;

/** @param {string} t @param {number} tag @param {number} line @param {number} col @param {number} h @param {number} v @param {number} page @returns {SNode} */
function mk(t, tag, line, col, h, v, page) {
  return { t, tag, line, col, h, v, W: 0, H: 0, D: 0, page, parent: null, kids: null, hV: 0, vV: 0, WV: 0, HV: 0, DV: 0, fl: -1 };
}

/** Enlarge hbox `box`'s visible size to contain the point. @param {SNode} box @param {number} h @param {number} v */
function containPoint(box, h, v) {
  if (box.t !== "(") return;
  if (box.WV < 0) {
    const max = box.hV;
    const min = max + box.WV;
    if (h < min) box.WV = h - max;
    else if (h > max) {
      box.hV = h;
      box.WV = min - h;
    }
  } else {
    const min = box.hV;
    const max = min + box.WV;
    if (h < min) {
      box.hV = h;
      box.WV = max - h;
    } else if (h > max) box.WV = h - min;
  }
  const n = box.vV;
  if (v < n - box.HV) box.HV = n - v;
  else if (v > n + box.DV) box.DV = v - n;
}

/** Enlarge hbox `box`'s visible size to contain a box. @param {SNode} box @param {number} h0 @param {number} v0 @param {number} h1 @param {number} v1 */
function containBox(box, h0, v0, h1, v1) {
  if (box.t !== "(") return;
  if (box.WV < 0) {
    const max = box.hV;
    const min = max + box.WV;
    if (h0 < min) box.WV = h0 - max;
    else if (h1 > max) {
      box.hV = h1;
      box.WV = min - h1;
    }
  } else {
    const min = box.hV;
    const max = min + box.WV;
    if (h0 < min) {
      box.hV = h0;
      box.WV = max - h0;
    } else if (h1 > max) box.WV = h1 - min;
  }
  const n = box.vV;
  if (v0 < n - box.HV) box.HV = n - v0;
  else if (v1 > n + box.DV) box.DV = v1 - n;
}

/** @param {SNode} to @param {SNode} from */
function setTlc(to, from) {
  to.tag = from.tag;
  to.line = from.line;
  to.col = from.col;
}

/**
 * A float with an optional TeX unit, in sp (post scriptum offsets).
 * @param {string} s
 */
function dimension(s) {
  const m = /^\s*([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?\d+)?)\s*(pt|bp|in|cm|mm|pc|dd|cc|sp)?/.exec(s);
  if (!m) return NaN;
  const per = { pt: 65536, bp: SP_PER_BP, in: 72 * SP_PER_BP, cm: (72 / 2.54) * SP_PER_BP, mm: (7.2 / 2.54) * SP_PER_BP,
    pc: 12 * 65536, dd: (1238 / 1157) * 65536, cc: 12 * (1238 / 1157) * 65536, sp: 1 };
  return Number(m[1]) * per[/** @type {keyof typeof per} */ (m[2] || "sp")];
}

class Synctex {
  /**
   * @param {{inputs: Map<number, string>, sheets: Map<number, SNode>,
   *   hboxes: Map<number, SNode[]>, maxLine: Map<number, number>, unit: number,
   *   xOffset: number, yOffset: number}} d
   */
  constructor(d) {
    /** Absolute input file paths by tag. */
    this.inputs = d.inputs;
    this.sheets = d.sheets;
    /** Per page, every hbox in SyncTeX's order (the last closed first). */
    this.hboxes = d.hboxes;
    /** bp per synctex unit. */
    this.unit = d.unit;
    /** bp. */
    this.xOffset = d.xOffset;
    this.yOffset = d.yOffset;
    /**
     * Forward-search candidates: tag -> line -> nodes, in document order. Only the nodes
     * SyncTeX files in its friend lists (kerns, glue, rules, math, boundaries, the opening
     * boundary of each hbox, empty vboxes), under the line they had when filed.
     * @type {Map<number, Map<number, SNode[]>>}
     */
    this.byLine = new Map();
    /** tag -> the greatest line recorded. */
    this.maxLine = d.maxLine;
    /** @type {Map<string, number[]>} resolved path -> tags */
    this.tagsByPath = new Map();
    for (const [tag, file] of this.inputs) {
      const key = path.resolve(file);
      this.tagsByPath.set(key, [...(this.tagsByPath.get(key) || []), tag]);
    }
    for (const page of [...this.sheets.keys()].sort((a, b) => a - b)) {
      const walk = (/** @type {SNode} */ n) => {
        for (const k of n.kids || []) {
          if (k.tag > 0 && k.fl >= 0) {
            let lines = this.byLine.get(k.tag);
            if (!lines) this.byLine.set(k.tag, (lines = new Map()));
            const list = lines.get(k.fl);
            if (list) list.push(k);
            else lines.set(k.fl, [k]);
          }
          if (k.kids) walk(k);
        }
      };
      walk(/** @type {SNode} */ (this.sheets.get(page)));
    }
  }

  /** Page numbers that have content. */
  get pages() {
    return [...this.sheets.keys()].sort((a, b) => a - b);
  }

  /** Every source file (absolute), in tag order. */
  get files() {
    return [...this.inputs.entries()].sort((a, b) => a[0] - b[0]).map(([, f]) => f);
  }

  /** @param {number} tag @returns {string} */
  fileOf(tag) {
    return this.inputs.get(tag) || "";
  }

  /**
   * The tags of `file` (compared after path.resolve, then by realpath).
   * @param {string} file
   */
  tagsOf(file) {
    const direct = this.tagsByPath.get(path.resolve(file));
    if (direct) return direct;
    const real = realOrResolved(file);
    /** @type {number[]} */
    const out = [];
    for (const [p, tags] of this.tagsByPath) if (realOrResolved(p) === real) out.push(...tags);
    return out;
  }

  /** Does the document have records from `file`? @param {string} file */
  covers(file) {
    return this.tagsOf(file).some((t) => this.maxLine.has(t));
  }

  /** @param {SNode} n @returns {SourcePos} */
  pos(n) {
    return { file: this.fileOf(n.tag), line: n.line, column: n.col >= 0 ? n.col : null };
  }

  /** bp (top-left origin) to synctex units. @param {number} x @param {number} y */
  hitPoint(x, y) {
    return { h: Math.trunc((x - this.xOffset) / this.unit), v: Math.trunc((y - this.yOffset) / this.unit) };
  }

  /** A box in synctex units to a bp rect. @param {number} h0 @param {number} v0 @param {number} h1 @param {number} v1 @returns {Rect} */
  rect(h0, v0, h1, v1) {
    const r = (/** @type {number} */ x) => Math.round(x * 1000) / 1000;
    return [r(h0 * this.unit + this.xOffset), r(v0 * this.unit + this.yOffset), r(h1 * this.unit + this.xOffset), r(v1 * this.unit + this.yOffset)];
  }

  // ---- reverse search ------------------------------------------------------------------

  /**
   * Reverse search, as `synctex edit -o page:x:y:file`: the source position of the
   * point, or null. `results` lists what the CLI would print (one or two positions, the
   * smaller line first); `file`/`line`/`column` is the first. `rects` are the boxes to
   * underline: the stretches of the printed line under the point that come from that
   * source line.
   * @param {number} page @param {number} x @param {number} y bp, top-left origin
   * @returns {EditHit | null}
   */
  edit(page, x, y) {
    const found = this.editNodes(page, x, y);
    if (!found) return null;
    const { nodes, container } = found;
    const results = nodes.map((n) => this.pos(n));
    const first = nodes[0];
    return { ...results[0], results, rects: this.underline(first, container, this.hitPoint(x, y)) };
  }

  /**
   * The result nodes of a reverse search and the hbox the point is in (if any).
   * @param {number} page @param {number} x @param {number} y
   * @returns {{nodes: SNode[], container: SNode | null} | null}
   */
  editNodes(page, x, y) {
    const sheet = this.sheets.get(page);
    if (!sheet) return null;
    const hit = this.hitPoint(x, y);
    const hboxes = this.hboxes.get(page) || [];
    for (let i = 0; i < hboxes.length; i++) {
      let node = hboxes[i];
      if (!inBox(hit, node)) continue;
      // the smallest of the hboxes that contain the point
      for (let j = i + 1; j < hboxes.length; j++) {
        if (inBox(hit, hboxes[j])) node = smallestContainer(hboxes[j], node);
      }
      const container = node;
      const deep = deepestContainerV2(hit, node);
      const nds = deep ? closestChildrenInBox(hit, deep) : { l: ND0(), r: ND0() };
      return { nodes: finish(nds, deep || node), container };
    }
    const top = sheet.kids && sheet.kids[0];
    if (!top) return null;
    const l = closestDeepChild(hit, top);
    return { nodes: finish({ l, r: ND0() }, top), container: null };
  }

  /**
   * The source line of the text under the point: the stretch of the printed line that
   * contains it (see `underline`), else the first reverse-search result. Used to map a
   * selection, where SyncTeX's "smaller line of the two neighbours" would pull in the
   * line before a selection that starts at a source line's first word.
   * @param {number} page @param {number} x @param {number} y
   * @returns {SourcePos | null}
   */
  textAt(page, x, y) {
    const found = this.editNodes(page, x, y);
    if (!found) return null;
    const hit = this.hitPoint(x, y);
    if (found.container) {
      const box = deepestHbox(hit, found.container);
      for (const s of stretches(box)) {
        if (s.node.tag > 0 && hit.h >= s.h0 && hit.h <= s.h1 && s.h1 > s.h0) return this.pos(s.node);
      }
    }
    return found.nodes.length ? this.pos(found.nodes[0]) : null;
  }

  /**
   * Rects to underline for result node `n`: in the hbox under the point (or `n`'s own
   * hbox), the stretches that come from `n`'s source line; the whole hbox if there are
   * none; for a vbox, the band of its line under the point.
   * @param {SNode} n @param {SNode | null} container @param {{h: number, v: number}} hit
   * @returns {Rect[]}
   */
  underline(n, container, hit) {
    /** @type {SNode | null} */
    let box = null;
    if (container) box = deepestHbox(hit, container);
    if (!box || !hasLine(box, n)) box = n.t === "(" ? n : n.parent && n.parent.t === "(" ? n.parent : null;
    if (!box) {
      // a vbox or void box: a band one line high around the point
      const b = n.t === "[" || n.t === "v" || n.t === "h" ? n : n.parent;
      if (!b) return [];
      const lineH = Math.min(Math.abs(b.H) + Math.abs(b.D), 12 / this.unit);
      const top = Math.max(b.v - b.H, hit.v - lineH * 0.75);
      return [this.rect(b.h, top, b.h + b.W, Math.min(b.v + b.D, top + lineH))];
    }
    return this.segments(box, n.tag, n.line);
  }

  /**
   * The stretches of `box` (an hbox) that come from `tag`:`line`, merged, as rects with
   * the box's visible height; the whole box when there are none of useful width.
   * @param {SNode} box @param {number} tag @param {number} line @returns {Rect[]}
   */
  segments(box, tag, line) {
    const top = box.vV - box.HV;
    const bottom = box.vV + box.DV;
    const min = 0.4 / this.unit; // 0.4 bp
    /** @type {[number, number][]} */
    const runs = [];
    for (const s of stretches(box)) {
      if (s.node.tag !== tag || s.node.line !== line || s.h1 - s.h0 < min / 4) continue;
      const last = runs[runs.length - 1];
      if (last && s.h0 <= last[1] + min) last[1] = Math.max(last[1], s.h1);
      else runs.push([s.h0, s.h1]);
    }
    const useful = runs.filter(([a, b]) => b - a >= min);
    if (!useful.length) return [this.rect(box.hV, top, box.hV + Math.abs(box.WV), bottom)];
    return useful.map(([a, b]) => this.rect(a, top, b, bottom));
  }

  // ---- forward search ------------------------------------------------------------------

  /**
   * Forward search, as `synctex view -i line:column:file`: the page and boxes of `line`
   * of `file` (or of the nearest line that has records), or null. `rects` are the
   * stretches of each printed line that come from it; `boxes` the whole visible hboxes,
   * as the CLI reports them. With several pages, the one closest to `pageHint` (default:
   * the first).
   * @param {string} file @param {number} line 1-based @param {{pageHint?: number}} [opts]
   * @returns {ViewHit | null}
   */
  view(file, line, { pageHint = 0 } = {}) {
    const tags = this.tagsOf(file).filter((t) => this.maxLine.has(t));
    if (!tags.length || !Number.isInteger(line)) return null;
    const max = Math.max(...tags.map((t) => this.maxLine.get(t) || 0));
    let l = Math.min(Math.max(1, line), max);
    let offset = 1;
    for (let tries = 100; tries--;) {
      if (l >= 1 && l <= max) {
        /** @type {SNode[]} */
        let matches = [];
        for (const t of tags) matches.push(...(this.byLine.get(t)?.get(l) || []).filter((n) => n.line === l && n.tag === t));
        const leaves = matches.filter((n) => !isBox(n));
        if (leaves.length) matches = leaves;
        if (matches.length) return this.viewResult(matches, l, pageHint);
      }
      l += offset;
      offset = offset < 0 ? -(offset - 1) : -(offset + 1);
      if (l <= 0) {
        l += offset;
        offset = offset < 0 ? -(offset - 1) : -(offset + 1);
      }
    }
    return null;
  }

  /** @param {SNode[]} matches @param {number} line @param {number} pageHint @returns {ViewHit} */
  viewResult(matches, line, pageHint) {
    let page = matches[0].page;
    for (const n of matches) {
      if (Math.abs(pageHint - n.page) < Math.abs(pageHint - page)) page = n.page;
    }
    /** @type {Rect[]} */
    const rects = [];
    /** @type {Rect[]} */
    const boxes = [];
    const seen = new Set();
    const thin = 1 / this.unit; // 1 bp
    for (const n of matches) {
      if (n.page !== page) continue;
      const box = isBox(n) ? n : n.parent;
      if (!box || box.t === "S") continue;
      if (box.t === "(") {
        if (seen.has(box)) continue;
        seen.add(box);
        boxes.push(this.rect(box.hV, box.vV - box.HV, box.hV + Math.abs(box.WV), box.vV + box.DV));
        rects.push(...this.segments(box, n.tag, n.line));
      } else if (box === n) {
        // an empty vbox (or a void box): its box, at least 1 bp high
        const r = this.rect(n.h, n.v - Math.abs(n.H), n.h + Math.abs(n.W), Math.max(n.v + Math.abs(n.D), n.v - Math.abs(n.H) + thin));
        boxes.push(r);
        rects.push(r);
      } else {
        // glue, a kern or a rule between the lines of a vbox: a thin band across the box at it
        if (!seen.has(box)) {
          seen.add(box);
          boxes.push(this.rect(box.h, box.v - Math.abs(box.H), box.h + Math.abs(box.W), box.v + Math.abs(box.D)));
        }
        rects.push(this.rect(box.h, n.v - thin, box.h + Math.abs(box.W), n.v));
      }
    }
    return { page, line, rects, boxes };
  }

  // ---- selections ----------------------------------------------------------------------

  /**
   * The source lines of a selection: each rect's left-middle and right-middle points,
   * mapped with `textAt`, collected as `{file, lines: [first, last]}` per file in the
   * order the files first appear.
   * @param {{page: number, rects: number[][]}[]} parts rects in bp, top-left origin
   * @returns {{file: string, lines: [number, number]}[]}
   */
  sourceOfSelection(parts) {
    /** @type {Map<string, [number, number]>} */
    const out = new Map();
    for (const part of parts || []) {
      if (!part || !Number.isInteger(part.page) || !Array.isArray(part.rects)) continue;
      for (const r of part.rects) {
        if (!Array.isArray(r) || r.length < 4 || !r.every(Number.isFinite)) continue;
        const [l, t, rr, b] = r;
        const w = rr - l;
        if (w <= 0 || b <= t) continue;
        const inset = Math.min(1, w / 4);
        const y = (t + b) / 2;
        for (const x of [l + inset, rr - inset]) {
          const p = this.textAt(part.page, x, y);
          if (!p || !p.file || p.line <= 0) continue;
          const have = out.get(p.file);
          if (have) {
            have[0] = Math.min(have[0], p.line);
            have[1] = Math.max(have[1], p.line);
          } else out.set(p.file, [p.line, p.line]);
        }
      }
    }
    return [...out].map(([file, lines]) => ({ file, lines }));
  }
}

// ---- geometry of the reverse search (after synctex_parser.c) ---------------------------

/** @returns {{node: SNode | null, distance: number}} */
const ND0 = () => ({ node: null, distance: INT_MAX });

/**
 * Signed horizontal distance from the hit to the node: > 0 when the node is to the
 * right, < 0 to the left, 0 inside.
 * @param {{h: number, v: number}} hit @param {SNode} node
 */
function hDistance(hit, node) {
  switch (node.t) {
    case "[":
    case "v":
    case "h": {
      const min = node.h;
      const max = min + Math.abs(node.W);
      return hit.h < min ? min - hit.h : hit.h > max ? max - hit.h : 0;
    }
    case "(": {
      const min = node.hV;
      const max = min + Math.abs(node.WV);
      return hit.h < min ? min - hit.h : hit.h > max ? max - hit.h : 0;
    }
    case "k": {
      // The kern's h is recorded after the move: it spans [h - W, h].
      let min;
      let max;
      if (node.W < 0) {
        min = node.h;
        max = min - node.W;
      } else {
        max = node.h;
        min = max - node.W;
      }
      const med = Math.trunc((min + max) / 2);
      if (hit.h < min) return min - hit.h + 1;
      if (hit.h > max) return max - hit.h - 1;
      if (hit.h > med) return max - hit.h + 1;
      return min - hit.h - 1;
    }
    default: // g $ x r B
      return node.h - hit.h;
  }
}

/** Signed vertical distance (> 0: node below... above the hit; 0 inside). @param {{h: number, v: number}} hit @param {SNode} node */
function vDistance(hit, node) {
  let min;
  let max;
  switch (node.t) {
    case "[":
    case "v":
    case "h":
      min = node.v - Math.abs(node.H);
      max = node.v + Math.abs(node.D);
      break;
    case "(":
      min = node.vV - Math.abs(node.HV);
      max = node.vV + Math.abs(node.DV);
      break;
    case "r":
    case "k":
    case "g":
    case "$": {
      const p = node.parent;
      min = node.v - Math.abs(p ? p.H : 0);
      max = node.v + Math.abs(p ? p.D : 0);
      break;
    }
    default:
      return INT_MAX;
  }
  return hit.v < min ? min - hit.v : hit.v > max ? max - hit.v : 0;
}

/** @param {{h: number, v: number}} hit @param {SNode} node */
const inBox = (hit, node) => hDistance(hit, node) === 0 && vDistance(hit, node) === 0;

/**
 * Of two hboxes that contain the point, the smaller (area, then width, then height).
 * @param {SNode} a @param {SNode} b
 */
function smallestContainer(a, b) {
  const wa = Math.abs(a.WV);
  const wb = Math.abs(b.WV);
  const ha = Math.abs(a.DV) + Math.abs(a.HV);
  const hb = Math.abs(b.DV) + Math.abs(b.HV);
  const aa = ha * wa;
  const ab = hb * wb;
  if (aa < ab) return a;
  if (aa > ab) return b;
  if (Math.abs(a.W) > Math.abs(b.W)) return a;
  if (Math.abs(a.W) < Math.abs(b.W)) return b;
  if (ha < hb) return a;
  if (ha > hb) return b;
  return a;
}

/** L1-ish distance from the hit to a box. @param {{h: number, v: number}} hit @param {number} h0 @param {number} v0 @param {number} h1 @param {number} v1 */
function distanceToBox(hit, h0, v0, h1, v1) {
  if (hit.v < v0) {
    if (hit.h < h0) return v0 - hit.v + h0 - hit.h;
    if (hit.h <= h1) return v0 - hit.v;
    return v0 - hit.v + hit.h - h1;
  }
  if (hit.v <= v1) {
    if (hit.h < h0) return h0 - hit.h;
    if (hit.h <= h1) return 0;
    return hit.h - h1;
  }
  if (hit.h < h0) return hit.v - v1 + h0 - hit.h;
  if (hit.h <= h1) return hit.v - v1;
  return hit.v - v1 + hit.h - h1;
}

/** @param {{h: number, v: number}} hit @param {SNode} node */
function nodeDistance(hit, node) {
  const pH = (/** @type {SNode} */ n) => Math.abs(n.parent ? n.parent.H : 0);
  switch (node.t) {
    case "[":
      return distanceToBox(hit, node.h, node.v - Math.abs(node.H), node.h + Math.abs(node.W), node.v + Math.abs(node.D));
    case "(":
      return distanceToBox(hit, node.hV, node.vV - Math.abs(node.HV), node.hV + Math.abs(node.WV), node.vV + Math.abs(node.DV));
    case "v":
    case "h": {
      const v0 = node.v - Math.abs(node.H);
      const v1 = node.v + Math.abs(node.D);
      const d = distanceToBox(hit, node.h, v0, node.h, v1);
      const h1 = node.h + Math.abs(node.W);
      return Math.min(d, distanceToBox(hit, h1, v0, h1, v1));
    }
    case "k": {
      const d = distanceToBox(hit, node.h, node.v - pH(node), node.h, node.v);
      const h0 = node.h - node.W;
      return Math.min(d, distanceToBox(hit, h0, node.v - pH(node), h0, node.v));
    }
    case "g":
    case "$":
    case "x":
    case "B":
      return distanceToBox(hit, node.h, node.v - pH(node), node.h, node.v);
    default:
      return INT_MAX;
  }
}

/** @param {{h: number, v: number}} hit @param {SNode} node @returns {SNode | null} */
function deepestContainerV2(hit, node) {
  if (!node.kids || !node.kids.length) return null;
  for (const child of node.kids) {
    if (inBox(hit, child)) {
      const deep = deepestContainerV2(hit, child);
      if (deep) return deep;
    }
  }
  if (node.t === "[") {
    /** @type {SNode | null} */
    let best = null;
    let bestD = INT_MAX;
    for (const child of node.kids) {
      if (child.kids && child.kids.length) {
        const d = nodeDistance(hit, child);
        if (d <= bestD) {
          best = child;
          bestD = d;
        }
      }
    }
    if (best) return best;
  }
  return inBox(hit, node) ? node : null;
}

/** @param {{h: number, v: number}} hit @param {SNode} node @returns {{node: SNode | null, distance: number}} */
function deepestContainerV3(hit, node) {
  if (!node.kids || !node.kids.length) return ND0();
  for (const child of node.kids) {
    const deep = deepestContainerV3(hit, child);
    if (deep.node) return deep;
  }
  if (node.t === "[") {
    let best = ND0();
    for (const child of node.kids) {
      if (child.kids && child.kids.length) {
        const d = nodeDistance(hit, child);
        if (d < best.distance) best = { node: child, distance: d };
      }
    }
    if (best.node) return best;
  }
  return inBox(hit, node) ? { node, distance: 0 } : ND0();
}

/** @param {{h: number, v: number}} hit @param {SNode} node @returns {{node: SNode | null, distance: number}} */
function closestDeepChild(hit, node) {
  let best = ND0();
  for (const child of node.kids || []) {
    const nd = isBox(child) ? closestDeepChild(hit, child) : { node: child, distance: nodeDistance(hit, child) };
    if (nd.distance < best.distance || (nd.distance === best.distance && (!nd.node || nd.node.t !== "k"))) best = nd;
  }
  return best;
}

/** Is `a` preferred to `b` at equal distance (same tag, smaller line, then column)? @param {SNode} a @param {SNode} b */
const prefer = (a, b) => a.tag === b.tag && (b.line > a.line || (b.line === a.line && b.col > a.col));

/**
 * The closest children left and right of the hit, in an hbox (descending into a child
 * hbox that contains it). The vbox variant of SyncTeX finds nothing (it starts from no
 * node), so neither does this one.
 * @param {{h: number, v: number}} hit @param {SNode} node
 * @returns {{l: {node: SNode | null, distance: number}, r: {node: SNode | null, distance: number}}}
 */
function closestChildrenInBox(hit, node) {
  const nds = { l: ND0(), r: ND0() };
  if (!node.kids || !node.kids.length || node.t !== "(") return nds;
  for (const child of node.kids) {
    let d = hDistance(hit, child);
    if (d > 0) {
      if (nds.r.distance > d) nds.r = { node: child, distance: d };
      else if (nds.r.distance === d && nds.r.node && prefer(child, nds.r.node)) nds.r = { node: child, distance: d };
    } else if (d === 0) {
      if (child.kids && child.kids.length) return closestChildrenInBox(hit, child);
      nds.l = { node: child, distance: 0 };
    } else {
      d = -d;
      if (nds.l.distance > d) nds.l = { node: child, distance: d };
      else if (nds.l.distance === d && nds.l.node && prefer(child, nds.l.node)) nds.l = { node: child, distance: d };
    }
  }
  for (const side of /** @type {const} */ (["l", "r"])) {
    const cur = nds[side];
    if (!cur.node) continue;
    const deep = deepestContainerV3(hit, cur.node);
    if (deep.node) nds[side] = deep;
    const closest = closestDeepChild(hit, /** @type {SNode} */ (nds[side].node));
    if (closest.node) nds[side] = { node: closest.node, distance: nds[side].distance };
  }
  return nds;
}

/**
 * The result list from the left/right candidates, as synctex_iterator_new_edit orders it.
 * @param {{l: {node: SNode | null, distance: number}, r: {node: SNode | null, distance: number}}} nds
 * @param {SNode} node the fallback
 * @returns {SNode[]}
 */
function finish(nds, node) {
  let { l, r } = nds;
  if (r.node && l.node) {
    const a = l.node;
    const b = r.node;
    if (a.tag !== b.tag || a.line !== b.line || a.col !== b.col) {
      if (b.line < a.line || (b.line === a.line && l.distance > r.distance)) [l, r] = [r, l];
      return [/** @type {SNode} */ (l.node), /** @type {SNode} */ (r.node)];
    }
    return [l.distance > r.distance ? b : a];
  }
  if (r.node) return [r.node];
  if (l.node) return [l.node];
  return node.t === "S" ? [] : [node];
}

/** The deepest hbox under the point, starting at `box`. @param {{h: number, v: number}} hit @param {SNode} box */
function deepestHbox(hit, box) {
  for (;;) {
    const next = (box.kids || []).find((k) => k.t === "(" && inBox(hit, k));
    if (!next) return box;
    box = next;
  }
}

/** Does hbox `box` (or a child hbox) hold nodes of `n`'s tag and line? @param {SNode} box @param {SNode} n @returns {boolean} */
function hasLine(box, n) {
  return (box.kids || []).some((k) => (k.tag === n.tag && k.line === n.line) || (k.t === "(" && hasLine(k, n)));
}

/**
 * The horizontal stretch of each child of an hbox (descending into child hboxes): the
 * text that ends at a boundary, glue or math node is the stretch since the previous
 * node; a kern spans [h - W, h]; a box its width. In synctex units.
 * @param {SNode} box
 * @returns {{node: SNode, h0: number, h1: number}[]}
 */
function stretches(box) {
  /** @type {{node: SNode, h0: number, h1: number}[]} */
  const out = [];
  let end = box.hV;
  for (const k of box.kids || []) {
    switch (k.t) {
      case "(":
        out.push(...stretches(k));
        end = k.hV + Math.abs(k.WV);
        break;
      case "[":
      case "v":
      case "h":
        out.push({ node: k, h0: k.h, h1: k.h + Math.abs(k.W) });
        end = k.h + Math.abs(k.W);
        break;
      case "k": {
        const a = Math.min(k.h - k.W, k.h);
        const b = Math.max(k.h - k.W, k.h);
        out.push({ node: k, h0: a, h1: b });
        end = k.h;
        break;
      }
      case "r":
        out.push({ node: k, h0: k.h, h1: k.h + Math.abs(k.W) });
        end = k.h + Math.abs(k.W);
        break;
      default: // x g $ B
        out.push({ node: k, h0: Math.min(end, k.h), h1: Math.max(end, k.h) });
        end = k.h;
    }
  }
  return out;
}

// ---- parsing ---------------------------------------------------------------------------

/** @param {string} p */
function realOrResolved(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Parse the text of a synctex file.
 * @param {string} text
 * @param {{dir?: string}} [opts] `dir`: the directory the synctex file is in; relative
 *   input paths are taken relative to it (else to the current directory).
 * @returns {Synctex}
 */
function parseSynctex(text, { dir = process.cwd() } = {}) {
  /** @type {Map<number, string>} */
  const inputs = new Map();
  /** @type {Map<number, SNode>} */
  const sheets = new Map();
  /** @type {Map<number, SNode[]>} */
  const hboxes = new Map();
  let preUnit = 0;
  let preMag = 0;
  let preX = 578;
  let preY = 578;
  let postUnit = 0;
  /** @type {number | null} */
  let postX = null;
  /** @type {number | null} */
  let postY = null;

  /** @param {string} rest "N:path" */
  const addInput = (rest) => {
    const c = rest.indexOf(":");
    if (c < 0) return;
    const tag = Number(rest.slice(0, c));
    const file = rest.slice(c + 1);
    if (!Number.isInteger(tag) || !file) return;
    inputs.set(tag, path.isAbsolute(file) ? path.normalize(file) : resolveRelative(file, dir));
  };

  /** @type {Map<number, number>} */
  const maxLine = new Map();
  let lastV = 0;
  /** @param {string} s the record without its type character @param {string} t @param {number} page */
  const record = (s, t, page) => {
    const c1 = s.indexOf(":");
    if (c1 < 0) return null;
    const link = s.slice(0, c1).split(",");
    const tag = Number(link[0]);
    const line = Number(link[1]);
    const col = link.length > 2 ? Number(link[2]) : -1;
    const rest = s.slice(c1 + 1);
    const c2 = rest.indexOf(":");
    const point = (c2 < 0 ? rest : rest.slice(0, c2)).split(",");
    const h = Number(point[0]);
    let v;
    if (point[1] === "=") v = lastV;
    else {
      v = Number(point[1]);
      lastV = v;
    }
    if (!Number.isFinite(tag) || !Number.isFinite(line) || !Number.isFinite(h) || !Number.isFinite(v)) return null;
    const n = mk(t, tag, line, Number.isFinite(col) ? col : -1, h, v, page);
    if (line > (maxLine.get(tag) ?? 0)) maxLine.set(tag, line);
    if (c2 >= 0) {
      const size = rest.slice(c2 + 1).split(",").map(Number);
      n.W = size[0] || 0;
      n.H = size[1] || 0;
      n.D = size[2] || 0;
    }
    return n;
  };

  const lines = text.split("\n");
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("Input:")) addInput(l.slice(6));
    else if (l.startsWith("Magnification:")) preMag = Number(l.slice(14)) || 0;
    else if (l.startsWith("Unit:")) preUnit = Number(l.slice(5)) || 0;
    else if (l.startsWith("X Offset:")) preX = Number(l.slice(9)) || 0;
    else if (l.startsWith("Y Offset:")) preY = Number(l.slice(9)) || 0;
    else if (l.startsWith("Content:")) {
      i++;
      break;
    }
  }

  /**
   * One open box: its node, its last child, the heading boundaries waiting for a tag and
   * line, and the trailing kern and glue.
   * @typedef {{node: SNode, last: SNode | null, pending: SNode[], lastK: SNode | null, lastG: SNode | null}} Level
   */
  /** @type {Level[]} */
  let stack = [];
  /** @type {SNode | null} */
  let sheet = null;
  let page = 0;
  let formDepth = 0;
  /** @type {SNode[]} */
  let pageHboxes = [];

  const top = () => stack[stack.length - 1];
  /** @param {SNode} n */
  const append = (n) => {
    const lv = top();
    n.parent = lv.node;
    /** @type {SNode[]} */ (lv.node.kids).push(n);
    lv.last = n;
  };
  /** A non-boundary node was parsed at this level: pending boundaries take its tag and line. @param {Level} lv @param {SNode} n */
  const settle = (lv, n) => {
    for (const x of lv.pending) {
      setTlc(x, n);
      x.fl = x.line;
    }
    lv.pending = [];
  };

  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const c = l[0];
    if (formDepth > 0) {
      if (c === "<") formDepth++;
      else if (c === ">") formDepth--;
      continue;
    }
    if (c === "<") {
      formDepth = 1;
      continue;
    }
    if (c === "{") {
      page = Number(l.slice(1));
      sheet = mk("S", 0, 0, -1, 0, 0, page);
      sheet.kids = [];
      stack = [{ node: sheet, last: null, pending: [], lastK: null, lastG: null }];
      pageHboxes = [];
      continue;
    }
    if (c === "}") {
      if (sheet) {
        sheets.set(page, sheet);
        hboxes.set(page, pageHboxes.reverse());
      }
      sheet = null;
      stack = [];
      continue;
    }
    if (c === "I" && l.startsWith("Input:")) {
      addInput(l.slice(6));
      continue;
    }
    if (c === "P" && l.startsWith("Postamble:")) {
      i++;
      break;
    }
    if (!sheet || !stack.length) continue;
    const lv = top();
    switch (c) {
      case "[":
      case "(": {
        const n = record(l.slice(1), c, page);
        if (!n) break;
        append(n);
        n.kids = [];
        /** @type {Level} */
        const level = { node: n, last: null, pending: [], lastK: null, lastG: null };
        stack.push(level);
        if (c === "(") {
          n.hV = n.h;
          n.vV = n.v;
          n.WV = n.W;
          n.HV = n.H;
          n.DV = n.D;
          const b = mk("B", n.tag, n.line, n.col, n.h, n.v, page);
          b.parent = n;
          b.fl = n.line;
          n.kids.push(b);
          level.last = b;
        }
        break;
      }
      case "]":
      case ")": {
        if (stack.length < 2 || lv.node.t !== (c === "]" ? "[" : "(")) break;
        const box = lv.node;
        for (const x of lv.pending) x.fl = x.line;
        lv.pending = [];
        if (c === "]" && !(box.kids && box.kids.length)) box.fl = box.line;
        if (c === ")") {
          const kids = /** @type {SNode[]} */ (box.kids);
          const opening = kids[0];
          if (opening && kids[1]) opening.line = kids[1].line;
          const lastChild = kids[kids.length - 1];
          const closing = mk("B", lastChild.tag, lastChild.line, lastChild.col, box.hV + box.WV, box.vV, page);
          closing.parent = box;
          if (opening) {
            opening.h = box.hV;
            opening.v = box.vV;
          }
          if (lv.lastK && lv.lastG) {
            const at = kids.indexOf(lv.lastK);
            if (at > 0) {
              setTlc(lv.lastK, kids[at - 1]);
              setTlc(lv.lastG, kids[at - 1]);
            }
          }
          kids.push(closing);
          pageHboxes.push(box);
        }
        stack.pop();
        const up = top();
        settle(up, box);
        up.lastK = up.lastG = null;
        if (c === ")") containBox(up.node, box.hV, box.vV - box.HV, box.hV + box.WV, box.vV + box.DV);
        break;
      }
      case "v":
      case "h": {
        const n = record(l.slice(1), c, page);
        if (!n) break;
        append(n);
        settle(lv, n);
        if (c === "h") containBox(lv.node, n.h, n.v - n.H, n.h + n.W, n.v + n.D);
        lv.lastK = lv.lastG = null;
        break;
      }
      case "k": {
        const n = record(l.slice(1), c, page);
        if (!n) break;
        n.fl = n.line;
        append(n);
        settle(lv, n);
        if (n.W > 0) containBox(lv.node, n.h - n.W, n.v, n.h, n.v);
        else containBox(lv.node, n.h, n.v, n.h - n.W, n.v);
        lv.lastK = n;
        lv.lastG = null;
        break;
      }
      case "g": {
        const n = record(l.slice(1), c, page);
        if (!n) break;
        n.fl = n.line;
        append(n);
        settle(lv, n);
        containPoint(lv.node, n.h, n.v);
        if (lv.lastK) lv.lastG = n;
        else lv.lastK = lv.lastG = null;
        break;
      }
      case "r":
      case "$": {
        const n = record(l.slice(1), c, page);
        if (!n) break;
        n.fl = n.line;
        append(n);
        settle(lv, n);
        if (c === "$") containPoint(lv.node, n.h, n.v);
        lv.lastK = lv.lastG = null;
        break;
      }
      case "x": {
        const n = record(l.slice(1), c, page);
        if (!n) break;
        const heading = (lv.last && lv.last.t === "B") || lv.pending.length > 0;
        append(n);
        if (heading) lv.pending.push(n);
        else n.fl = n.line;
        containPoint(lv.node, n.h, n.v);
        lv.lastK = lv.lastG = null;
        break;
      }
      default: // f (form ref), c (character), ! (anchor), % and anything else
        if (c === "f" || c === "c") lv.lastK = lv.lastG = null;
    }
  }

  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("Magnification:")) postUnit = Number(l.slice(14)) || 0;
    else if (l.startsWith("X Offset:")) postX = dimension(l.slice(9));
    else if (l.startsWith("Y Offset:")) postY = dimension(l.slice(9));
    else if (l.startsWith("Input:")) addInput(l.slice(6));
  }

  if (preUnit <= 0) preUnit = 8192;
  if (preMag <= 0) preMag = 1000;
  let unit = postUnit > 0 ? postUnit * (preUnit / SP_PER_BP) : preUnit / SP_PER_BP;
  unit *= preMag / 1000;
  const xOffset = postX !== null && Number.isFinite(postX) ? postX / SP_PER_BP : preX * (preUnit / SP_PER_BP);
  const yOffset = postY !== null && Number.isFinite(postY) ? postY / SP_PER_BP : preY * (preUnit / SP_PER_BP);
  return new Synctex({ inputs, sheets, hboxes, maxLine, unit, xOffset, yOffset });
}

/**
 * A relative input path: relative to the synctex file's directory, else to the closest
 * ancestor directory where it exists (a build run from a parent directory).
 * @param {string} file @param {string} dir
 */
function resolveRelative(file, dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const p = path.resolve(d, file);
    if (fs.existsSync(p)) return p;
    if (path.dirname(d) === d) break;
  }
  return path.resolve(dir, file);
}

/**
 * The synctex file of `pdf`: `X.synctex.gz` or `X.synctex` next to `X.pdf`, the newer
 * of the two if both exist; null if neither.
 * @param {string} pdf
 * @returns {{file: string, mtimeMs: number, size: number} | null}
 */
function synctexFileFor(pdf) {
  const stem = pdf.replace(/\.pdf$/i, "");
  /** @type {{file: string, mtimeMs: number, size: number} | null} */
  let best = null;
  for (const file of [`${stem}.synctex.gz`, `${stem}.synctex`]) {
    try {
      const st = fs.statSync(file);
      if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { file, mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      // absent
    }
  }
  return best;
}

/**
 * Read and parse `file` (gzipped when it ends in `.gz`).
 * @param {string} file
 * @returns {Promise<Synctex>}
 */
async function readSynctex(file) {
  const raw = await fs.promises.readFile(file);
  const data = file.endsWith(".gz")
    ? await new Promise((resolve, reject) => zlib.gunzip(raw, (e, out) => (e ? reject(e) : resolve(out))))
    : raw;
  return parseSynctex(/** @type {Buffer} */ (data).toString("utf8"), { dir: path.dirname(file) });
}

/**
 * The parsed SyncTeX data of `pdf`, or null when there is no synctex file next to it.
 * @param {string} pdf
 * @returns {Promise<{data: Synctex, file: string, mtimeMs: number, size: number} | null>}
 */
async function loadSynctex(pdf) {
  const found = synctexFileFor(pdf);
  if (!found) return null;
  return { ...found, data: await readSynctex(found.file) };
}

module.exports = { Synctex, parseSynctex, readSynctex, loadSynctex, synctexFileFor, SP_PER_BP };
