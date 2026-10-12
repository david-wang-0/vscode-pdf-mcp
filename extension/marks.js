// @ts-check
/**
 * The user's marks: every write goes through the edit service (see editservice.js); this
 * module validates what the webview asks for, adds the path and author, serialises the
 * writes per document, and keeps a per-document undo stack of this session's own actions.
 *
 * Undo entries and their inverses:
 *   create {xrefs}        -> delete each (only_author), refused if someone else replied
 *   update {xref, prev}   -> update back to the previous note / colour / style
 *   delete {snapshots}    -> restore the snapshots
 * A style change recreates the annotation and a restore recreates them all, so their new
 * xrefs are mapped through every entry still on the stack.
 */
"use strict";

const STYLES = ["highlight", "underline", "squiggly", "strikeout"];
/** @type {Record<string, string>} */
const SUBTYPE_STYLE = { Highlight: "highlight", Underline: "underline", Squiggly: "squiggly", StrikeOut: "strikeout" };

/**
 * @typedef {{kind: "create", label: string, xrefs: number[]}
 *   | {kind: "update", label: string, xref: number, prev: {note?: string, color?: string, style?: string}}
 *   | {kind: "delete", label: string, snapshots: any[]}} UndoEntry
 */

/** A 0-1 RGB triple as the service's `"r,g,b"` colour. @param {number[]} rgb */
function rgbString(rgb) {
  return rgb.slice(0, 3).map((v) => String(+Number(v).toFixed(4))).join(",");
}

class UndoStack {
  /** @param {number} [limit] */
  constructor(limit = 200) {
    this.limit = limit;
    /** @type {UndoEntry[]} */
    this.entries = [];
  }

  get size() {
    return this.entries.length;
  }

  /** @param {UndoEntry} entry */
  push(entry) {
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
  }

  pop() {
    return this.entries.pop();
  }

  /**
   * Point every entry at the new xrefs after annotations were recreated.
   * @param {Map<number, number> | Record<string, number>} map old xref -> new xref
   */
  remap(map) {
    const m = map instanceof Map ? map : new Map(Object.entries(map).map(([k, v]) => [Number(k), Number(v)]));
    if (!m.size) return;
    const to = (/** @type {number} */ x) => m.get(x) ?? x;
    for (const e of this.entries) {
      if (e.kind === "create") e.xrefs = e.xrefs.map(to);
      else if (e.kind === "update") e.xref = to(e.xref);
      else for (const s of e.snapshots) if (s && s.irt) s.irt = to(s.irt);
    }
  }
}

/**
 * The service requests that undo `entry`.
 * @param {UndoEntry} entry @param {string} author
 * @returns {{op: string, fields: Record<string, unknown>}[]}
 */
function inverseOps(entry, author) {
  switch (entry.kind) {
    case "create":
      return [...entry.xrefs].reverse().map((xref) => ({ op: "delete", fields: { xref, only_author: author } }));
    case "update":
      return [{ op: "update", fields: { xref: entry.xref, ...entry.prev, only_author: author } }];
    case "delete":
      return [{ op: "restore", fields: { snapshots: entry.snapshots } }];
  }
}

/** Every annotation in the reply tree under `xref` (not `xref` itself). @param {any[]} list @param {number} xref */
function descendants(list, xref) {
  const out = [];
  const queue = [xref];
  const seen = new Set(queue);
  while (queue.length) {
    const x = queue.shift();
    for (const a of list) {
      if (a.irt === x && !seen.has(a.xref)) {
        seen.add(a.xref);
        out.push(a);
        queue.push(a.xref);
      }
    }
  }
  return out;
}

class BadRequest extends Error {}

/** @param {unknown} v @param {string} what */
function int(v, what) {
  if (!Number.isInteger(v) || /** @type {number} */ (v) < 1) throw new BadRequest(`${what} must be a positive integer`);
  return /** @type {number} */ (v);
}
/** @param {unknown} v @param {number} n @param {string} what */
function nums(v, n, what) {
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
    throw new BadRequest(`${what} must be ${n} numbers`);
  }
  return /** @type {number[]} */ (v);
}
/** @param {unknown} v @param {string} what */
function str(v, what) {
  if (typeof v !== "string") throw new BadRequest(`${what} must be a string`);
  return v;
}
/** @param {unknown} v */
function style(v) {
  if (typeof v !== "string" || !STYLES.includes(v)) throw new BadRequest(`style must be one of ${STYLES.join(", ")}`);
  return v;
}
/** @param {unknown} v */
function color(v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > 40) throw new BadRequest("color must be a palette name, #rrggbb or r,g,b");
  return v;
}

class MarkController {
  /**
   * @param {{request: (op: string, fields: Record<string, unknown>) => Promise<any>,
   *          author: () => string, onWritten?: (path: string) => void}} opts
   */
  constructor({ request, author, onWritten = () => {} }) {
    this.request = request;
    this.author = author;
    this.onWritten = onWritten;
    /** @type {Map<string, UndoStack>} */
    this.stacks = new Map();
    /** @type {Map<string, Promise<unknown>>} */
    this.queues = new Map();
  }

  /** @param {string} path */
  stack(path) {
    let s = this.stacks.get(path);
    if (!s) this.stacks.set(path, (s = new UndoStack()));
    return s;
  }

  /**
   * Run `fn` after every earlier write to `path` has finished.
   * @template T @param {string} path @param {() => Promise<T>} fn @returns {Promise<T>}
   */
  serial(path, fn) {
    const prev = this.queues.get(path) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.queues.set(path, tail);
    void tail.then(() => {
      if (this.queues.get(path) === tail) this.queues.delete(path);
    });
    return run;
  }

  /** @param {string} path @param {string} op @param {Record<string, unknown>} fields */
  async call(path, op, fields) {
    return this.request(op, { path, ...fields });
  }

  /**
   * Mark a selection: one annotation per page part. `parts` = [{page, rects, text?}].
   * @param {string} path @param {any} m
   */
  mark(path, m) {
    const parts = Array.isArray(m.parts) ? m.parts : [];
    if (!parts.length) throw new BadRequest("nothing selected");
    const clean = parts.map((/** @type {any} */ p) => ({
      page: int(p.page, "page"),
      rects: (Array.isArray(p.rects) && p.rects.length ? p.rects : (() => { throw new BadRequest("rects must not be empty"); })())
        .map((/** @type {unknown} */ r) => nums(r, 4, "a rect")),
      text: typeof p.text === "string" && p.text ? p.text : undefined,
    }));
    const st = style(m.style ?? "highlight");
    const col = color(m.color);
    const note = typeof m.note === "string" && m.note ? m.note : undefined;
    return this.serial(path, async () => {
      const author = this.author();
      /** @type {any[]} */
      const results = [];
      try {
        for (const [i, p] of clean.entries()) {
          results.push(await this.call(path, "mark", { ...p, style: st, color: col, note: i === 0 ? note : undefined, author }));
        }
      } finally {
        if (results.length) {
          this.stack(path).push({ kind: "create", label: st, xrefs: results.map((r) => r.xref) });
          this.onWritten(path);
        }
      }
      return { xref: results[0].xref, xrefs: results.map((r) => r.xref), results };
    });
  }

  /** A margin note (Text annotation) at a point. @param {string} path @param {any} m */
  note(path, m) {
    const fields = {
      page: int(m.page, "page"),
      point: nums(m.point, 2, "point"),
      note: str(m.note, "note"),
      color: color(m.color),
    };
    return this.serial(path, async () => {
      const r = await this.call(path, "note", { ...fields, author: this.author() });
      this.stack(path).push({ kind: "create", label: "note", xrefs: [r.xref] });
      this.onWritten(path);
      return r;
    });
  }

  /** A reply in the thread of any annotation. @param {string} path @param {any} m */
  reply(path, m) {
    const fields = { xref: int(m.xref, "xref"), note: str(m.note, "note") };
    return this.serial(path, async () => {
      const r = await this.call(path, "reply", { ...fields, author: this.author() });
      this.stack(path).push({ kind: "create", label: "reply", xrefs: [r.xref] });
      this.onWritten(path);
      return r;
    });
  }

  /** Change the note, colour and/or style of an own annotation. @param {string} path @param {any} m */
  update(path, m) {
    const xref = int(m.xref, "xref");
    /** @type {{note?: string, color?: string, style?: string}} */
    const change = {};
    if (m.note !== undefined) change.note = str(m.note, "note");
    if (m.color !== undefined) change.color = color(m.color);
    if (m.style !== undefined) change.style = style(m.style);
    if (!Object.values(change).some((v) => v !== undefined)) throw new BadRequest("nothing to change");
    return this.serial(path, async () => {
      const author = this.author();
      const snap = await this.call(path, "snapshot", { xref });
      if (snap.author !== author) throw new Error("not your annotation");
      /** @type {{note?: string, color?: string, style?: string}} */
      const prev = {};
      if (change.note !== undefined) prev.note = snap.contents ?? "";
      if (change.color !== undefined && Array.isArray(snap.color)) prev.color = rgbString(snap.color);
      if (change.style !== undefined && SUBTYPE_STYLE[snap.subtype]) prev.style = SUBTYPE_STYLE[snap.subtype];
      const r = await this.call(path, "update", { xref, ...change, only_author: author });
      const stack = this.stack(path);
      if (r.xref !== xref) stack.remap(new Map([[xref, r.xref]]));
      stack.push({ kind: "update", label: change.style ? "style change" : change.color ? "colour change" : "edit", xref: r.xref, prev });
      this.onWritten(path);
      return r;
    });
  }

  /** Delete an own annotation (and its replies). @param {string} path @param {any} m */
  remove(path, m) {
    const xref = int(m.xref, "xref");
    return this.serial(path, async () => {
      const r = await this.call(path, "delete", { xref, only_author: this.author() });
      this.stack(path).push({ kind: "delete", label: "delete", snapshots: r.snapshots || [] });
      this.onWritten(path);
      return r;
    });
  }

  /**
   * Undo this session's last own action on `path`. Resolves with `{label}`, or `null` when
   * there is nothing to undo; an inverse that fails drops the entry and rejects.
   * @param {string} path
   */
  undo(path) {
    return this.serial(path, async () => {
      const stack = this.stack(path);
      const entry = stack.pop();
      if (!entry) return null;
      const author = this.author();
      let wrote = false;
      try {
        if (entry.kind === "create") {
          const list = await this.call(path, "list", {});
          for (const x of entry.xrefs) {
            const others = descendants(list, x).filter((a) => a.author !== author);
            if (others.length) {
              const who = [...new Set(others.map((a) => a.author || "someone"))].join(", ");
              throw new Error(`${who} replied to it`);
            }
          }
        }
        for (const { op, fields } of inverseOps(entry, author)) {
          const r = await this.call(path, op, fields);
          wrote = true;
          if (op === "update" && entry.kind === "update" && r.xref !== entry.xref) stack.remap(new Map([[entry.xref, r.xref]]));
          if (op === "restore" && r && r.xrefs) stack.remap(r.xrefs);
        }
        return { label: entry.label };
      } catch (e) {
        throw new Error(`cannot undo the ${entry.label}: ${e instanceof Error ? e.message : e}`);
      } finally {
        if (wrote) this.onWritten(path);
      }
    });
  }
}

module.exports = { UndoStack, inverseOps, descendants, MarkController, BadRequest, STYLES, rgbString };
