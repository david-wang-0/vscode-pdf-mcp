#!/usr/bin/env node
// @ts-check
/**
 * A stand-in for pdf-reader-writer-mcp's `pdf-reader-writer-edit`, for unit tests: the
 * same JSON-lines protocol, ops, fields, results and error messages (edit-service spec
 * v1), but the annotations live in a JSON sidecar `<pdf>.fake-annots.json` instead of the
 * PDF. The page count is the number of `/Type /Page` objects in the file.
 *
 * Test-only ops: `__crash` (exit 3 at once), `__split` (answer in three writes),
 * `__noise` (a non-JSON line and an unmatched response before the answer),
 * `__hang` (never answer), `__slow {ms}` (answer after `ms`, holding up the requests
 * behind it, as the real service handles one at a time).
 */
"use strict";

const fs = require("node:fs");

const COLORS = {
  blue: [0.6, 0.8, 1.0], yellow: [1.0, 0.9, 0.3], green: [0.6, 0.9, 0.6], orange: [1.0, 0.7, 0.4],
  pink: [1.0, 0.7, 0.85], purple: [0.8, 0.7, 1.0], red: [0.9, 0.3, 0.3], cyan: [0.55, 0.95, 0.95],
  grey: [0.75, 0.75, 0.75], gray: [0.75, 0.75, 0.75],
};
const NOTE_COLOR = [0.2, 0.45, 1.0];
/** @type {Record<string, [string, number[]]>} */
const STYLES = {
  highlight: ["Highlight", COLORS.blue], underline: ["Underline", NOTE_COLOR],
  squiggly: ["Squiggly", NOTE_COLOR], strikeout: ["StrikeOut", [0.9, 0.3, 0.3]],
};
const MARKUP = new Set(["Highlight", "Underline", "Squiggly", "StrikeOut"]);
const RESTORABLE = new Set([...MARKUP, "Text", "FileAttachment"]);

/** @type {Record<string, {required: string[], optional: string[]}>} */
const FIELDS = {
  ping: { required: [], optional: [] },
  mark: { required: ["path", "page", "rects", "author"], optional: ["text", "style", "color", "note"] },
  note: { required: ["path", "page", "point", "note", "author"], optional: ["color"] },
  reply: { required: ["path", "xref", "note", "author"], optional: [] },
  update: { required: ["path", "xref"], optional: ["note", "color", "style", "only_author"] },
  delete: { required: ["path", "xref"], optional: ["only_author"] },
  snapshot: { required: ["path", "xref"], optional: [] },
  restore: { required: ["path", "snapshots"], optional: [] },
  list: { required: ["path"], optional: [] },
};

/** @type {Record<string, string>} */
const TYPES = {
  path: "string", note: "string", author: "string", text: "string", style: "string", color: "string", only_author: "string",
  page: "integer", xref: "integer", rects: "list", point: "list", snapshots: "list",
};

class Failure extends Error {}

/** @param {unknown} v */
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** @param {unknown} spec @param {number[]} def */
function parseColor(spec, def) {
  if (!spec) return def;
  const key = String(spec).trim().toLowerCase();
  if (key in COLORS) return /** @type {any} */ (COLORS)[key];
  const h = key.replace(/^#/, "");
  if (/^[0-9a-f]{6}$/.test(h)) return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const rgb = key.split(",").map(Number);
  if (rgb.length === 3 && rgb.every((c) => c >= 0 && c <= 1)) return rgb;
  throw new Failure(`unknown colour '${spec}': use one of blue, yellow, green, orange, pink, purple, red, cyan, grey, #rrggbb, or 'r,g,b' in 0-1`);
}

const now = () => {
  const d = new Date();
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};

/** @param {string} path */
function load(path) {
  if (!fs.existsSync(path) || !fs.statSync(path).isFile()) throw new Failure(`no such file: ${path}`);
  const pages = (fs.readFileSync(path, "latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length;
  const side = `${path}.fake-annots.json`;
  const db = fs.existsSync(side) ? JSON.parse(fs.readFileSync(side, "utf8")) : { next: 100, annots: [] };
  return { pages, db, save: () => fs.writeFileSync(side, JSON.stringify(db)) };
}

/** @param {any} db @param {number} xref */
function find(db, xref) {
  const a = db.annots.find((/** @type {any} */ x) => x.xref === xref);
  if (!a) throw new Failure(`no annotation with xref ${xref}`);
  return a;
}

/** @param {number} page @param {number} pages */
function checkPage(page, pages) {
  if (!(page >= 1 && page <= pages)) throw new Failure(`page ${page} outside 1-${pages}`);
}

/** @param {number[]} r */
const quadOf = ([x0, y0, x1, y1]) => [x0, y1, x1, y1, x0, y0, x1, y0];

/** @param {any} a */
function snapshot(a) {
  const { xref, page, subtype, rect, quads, color, opacity, contents, author, irt, icon, created, modified } = a;
  return { xref, page, subtype, rect, quads, color, opacity, contents, author, irt, icon, created, modified };
}

/** @param {any} db @param {any} a */
function add(db, a) {
  a.xref = db.next++;
  db.annots.push(a);
  return a;
}

/** @param {string} op @param {any} req */
function handle(op, req) {
  switch (op) {
    case "ping":
      return { version: Number(process.env.FAKE_EDIT_VERSION || 1) };
    case "mark": {
      const { pages, db, save } = load(req.path);
      checkPage(req.page, pages);
      if (!req.rects.length) throw new Failure("rects is empty");
      if (!req.rects.every((/** @type {unknown} */ r) => Array.isArray(r) && r.length === 4 && r.every(isNum))) {
        throw new Failure("rects must be a list of [x0, y0, x1, y1]");
      }
      const style = req.style ?? "highlight";
      if (!STYLES[style]) throw new Failure("style must be one of highlight, underline, squiggly, strikeout");
      const [subtype, def] = STYLES[style];
      const quads = req.rects.map((/** @type {number[]} */ r) => quadOf(r));
      const t = now();
      const a = add(db, { page: req.page, subtype, rect: req.rects[0], quads, color: parseColor(req.color, def), opacity: null,
        contents: req.note ?? "", author: req.author, irt: 0, icon: null, created: t, modified: t, text: req.text ?? "" });
      save();
      return { xref: a.xref, page: a.page, quads, text: a.text };
    }
    case "note": {
      const { pages, db, save } = load(req.path);
      checkPage(req.page, pages);
      if (req.point.length !== 2 || !req.point.every(isNum)) throw new Failure("point must be [x, y]");
      const [x, y] = req.point;
      const t = now();
      const a = add(db, { page: req.page, subtype: "Text", rect: [x, y - 16, x + 16, y], quads: [], color: parseColor(req.color, NOTE_COLOR),
        opacity: null, contents: req.note, author: req.author, irt: 0, icon: "Comment", created: t, modified: t });
      save();
      return { xref: a.xref, page: a.page };
    }
    case "reply": {
      const { db, save } = load(req.path);
      const parent = find(db, req.xref);
      const t = now();
      const a = add(db, { page: parent.page, subtype: "Text", rect: [40, parent.rect[3] - 16, 56, parent.rect[3]], quads: [],
        color: NOTE_COLOR, opacity: null, contents: req.note, author: req.author, irt: parent.xref, icon: "Comment", created: t, modified: t });
      save();
      return { xref: a.xref, page: a.page };
    }
    case "update": {
      const { db, save } = load(req.path);
      let a = find(db, req.xref);
      if (req.only_author != null && a.author !== req.only_author) throw new Failure("not your annotation");
      if (req.style != null) {
        if (!MARKUP.has(a.subtype)) throw new Failure(`xref ${a.xref} is a ${a.subtype}, not a text markup`);
        if (!STYLES[req.style]) throw new Failure("style must be one of highlight, underline, squiggly, strikeout");
      }
      if (req.note != null) a.contents = req.note;
      if (req.color != null) a.color = parseColor(req.color, a.color);
      a.modified = now();
      if (req.style != null && STYLES[req.style][0] !== a.subtype) {
        const old = a.xref;
        db.annots = db.annots.filter((/** @type {any} */ x) => x !== a);
        a = add(db, { ...a, subtype: STYLES[req.style][0] });
        for (const r of db.annots) if (r.irt === old) r.irt = a.xref;
      }
      save();
      return { xref: a.xref };
    }
    case "delete": {
      const { db, save } = load(req.path);
      const a = find(db, req.xref);
      if (req.only_author != null && a.author !== req.only_author) throw new Failure("not your annotation");
      const gone = [a];
      for (let i = 0; i < gone.length; i++) gone.push(...db.annots.filter((/** @type {any} */ x) => x.irt === gone[i].xref && !gone.includes(x)));
      db.annots = db.annots.filter((/** @type {any} */ x) => !gone.includes(x));
      save();
      return { snapshots: gone.map(snapshot) };
    }
    case "snapshot": {
      const { db } = load(req.path);
      return snapshot(find(db, req.xref));
    }
    case "restore": {
      const { db, save } = load(req.path);
      for (const s of req.snapshots) {
        if (!s || typeof s !== "object" || !["xref", "page", "subtype", "rect"].every((k) => k in s)) {
          throw new Failure("each snapshot needs at least xref, page, subtype and rect");
        }
        if (!RESTORABLE.has(s.subtype)) throw new Failure(`cannot restore a ${s.subtype} annotation`);
      }
      /** @type {Record<string, number>} */
      const xrefs = {};
      for (const s of req.snapshots) {
        const irt = s.irt ? (xrefs[String(s.irt)] ?? s.irt) : 0;
        const a = add(db, { ...s, irt });
        xrefs[String(s.xref)] = a.xref;
      }
      save();
      return { xrefs };
    }
    case "list": {
      const { db } = load(req.path);
      return db.annots.map((/** @type {any} */ a) => {
        /** @type {any} */
        const e = { page: a.page, type: a.subtype, author: a.author, note: a.contents, modified: a.modified, xref: a.xref };
        if (MARKUP.has(a.subtype)) e.text = a.text ?? "";
        if (a.irt) e.reply_to = a.irt;
        if (a.color) e.color = a.color.map((/** @type {number} */ c) => Math.round(c * 100) / 100);
        e.irt = a.irt || 0;
        e.quads = MARKUP.has(a.subtype) ? a.quads : [];
        e.rect = a.rect;
        return e;
      });
    }
    default:
      throw new Failure(`unknown op: ${op}`);
  }
}

/** @param {unknown} obj */
const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

let buf = "";
/** Lines waiting while `__slow` holds the service. @type {string[]} */
const queue = [];
let busy = false;
const drain = () => {
  while (!busy && queue.length) onLine(/** @type {string} */ (queue.shift()));
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) queue.push(line);
  }
  drain();
});
process.stdin.on("end", () => process.exit(0));

/** @param {string} line */
function onLine(line) {
  /** @type {any} */
  let req;
  try {
    req = JSON.parse(line);
    if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("not an object");
    if (!Number.isInteger(req.id)) throw new Error("id must be an integer");
    if (typeof req.op !== "string") throw new Error("op must be a string");
  } catch (e) {
    write({ id: null, ok: false, error: `bad request: ${e instanceof Error ? e.message : e}` });
    return;
  }
  const { id, op, ...rest } = req;
  if (op === "__crash") process.exit(3);
  if (op === "__hang") return;
  if (op === "__slow") {
    busy = true;
    setTimeout(() => {
      write({ id, ok: true, result: { slow: true } });
      busy = false;
      drain();
    }, Number(rest.ms) || 0);
    return;
  }
  if (op === "__split") {
    const s = JSON.stringify({ id, ok: true, result: { split: true } }) + "\n";
    process.stdout.write(s.slice(0, 5));
    setTimeout(() => process.stdout.write(s.slice(5, 12)), 20);
    setTimeout(() => process.stdout.write(s.slice(12)), 40);
    return;
  }
  if (op === "__noise") {
    process.stdout.write("this is not JSON\n");
    write({ id: 999999, ok: true, result: "stray" });
    write({ id, ok: true, result: { noise: true } });
    return;
  }
  try {
    const spec = FIELDS[op];
    if (!spec) throw new Failure(`unknown op: ${op}`);
    for (const k of Object.keys(rest)) if (!spec.required.includes(k) && !spec.optional.includes(k)) throw new Failure(`unknown field: ${k}`);
    for (const k of Object.keys(rest)) if (rest[k] === null) delete rest[k]; // null = absent
    for (const k of spec.required) if (!(k in rest)) throw new Failure(`missing field: ${k}`);
    for (const [k, v] of Object.entries(rest)) {
      const want = TYPES[k];
      if (want === "string" && typeof v !== "string") throw new Failure(`field ${k} must be a string`);
      if (want === "integer" && !Number.isInteger(v)) throw new Failure(`field ${k} must be an integer`);
      if (want === "list" && !Array.isArray(v)) throw new Failure(`field ${k} must be a list`);
    }
    write({ id, ok: true, result: handle(op, rest) });
  } catch (e) {
    write({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
