// @ts-check
/**
 * The SyncTeX data of the PDFs this window shows, parsed in-process (lib/synctex.js) so
 * that hover lookups are instant. Each PDF's directory is watched for its
 * `.synctex.gz`/`.synctex`, which a build rewrites: the data is re-parsed when the file
 * changes and dropped when it disappears. Pure Node: no `vscode` import.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { synctexFileFor, readSynctex } = require("../lib/synctex");

/**
 * @typedef {import("../lib/synctex").Synctex} Synctex
 * @typedef {{pdf: string, refs: number, watcher: fs.FSWatcher | null,
 *   timer: ReturnType<typeof setTimeout> | undefined,
 *   sig: {file: string, mtimeMs: number, size: number} | null, data: Synctex | null,
 *   loading: Promise<Synctex | null> | null, version: number}} Entry
 */

class SynctexStore {
  /**
   * @param {{onChange?: (pdf: string, data: Synctex | null) => void, log?: (msg: string) => void,
   *   debounceMs?: number}} [opts]
   */
  constructor({ onChange = () => {}, log = () => {}, debounceMs = 250 } = {}) {
    this.onChange = onChange;
    this.log = log;
    this.debounceMs = debounceMs;
    /** @type {Map<string, Entry>} by the PDF's realpath */
    this.entries = new Map();
  }

  /** @param {string} pdf @returns {Entry} */
  entry(pdf) {
    let e = this.entries.get(pdf);
    if (!e) {
      e = { pdf, refs: 0, watcher: null, timer: undefined, sig: null, data: null, loading: null, version: 0 };
      this.entries.set(pdf, e);
    }
    return e;
  }

  /**
   * Start following `pdf` (a realpath): parse its synctex file now and whenever it
   * changes. Reference-counted, one per tab.
   * @param {string} pdf
   */
  watch(pdf) {
    const e = this.entry(pdf);
    if (e.refs++ > 0) return;
    const dir = path.dirname(pdf);
    const stem = path.basename(pdf).replace(/\.pdf$/i, "");
    try {
      e.watcher = fs.watch(dir, { persistent: false }, (_event, name) => {
        const n = name ? name.toString() : "";
        if (n && n !== `${stem}.synctex.gz` && n !== `${stem}.synctex`) return;
        clearTimeout(e.timer);
        e.timer = setTimeout(() => void this.refresh(pdf), this.debounceMs);
      });
      e.watcher.on("error", (err) => this.log(`synctex watch ${dir}: ${err.message}`));
    } catch (err) {
      this.log(`cannot watch ${dir} for SyncTeX: ${err instanceof Error ? err.message : err}`);
    }
    void this.refresh(pdf);
  }

  /** Stop following `pdf` (when its last tab closes); its data is dropped. @param {string} pdf */
  unwatch(pdf) {
    const e = this.entries.get(pdf);
    if (!e || --e.refs > 0) return;
    e.watcher?.close();
    clearTimeout(e.timer);
    this.entries.delete(pdf);
  }

  /** The parsed data of `pdf` if it is loaded, else null (no waiting). @param {string} pdf */
  peek(pdf) {
    return this.entries.get(pdf)?.data ?? null;
  }

  /**
   * The data of `pdf`, loading or refreshing it first (also for a PDF no tab follows).
   * @param {string} pdf @returns {Promise<Synctex | null>}
   */
  async get(pdf) {
    const e = this.entry(pdf);
    await this.refresh(pdf);
    // An entry no tab follows stays (unwatched, refreshed on each get), so a forward
    // search that opens the PDF next does not parse it twice.
    return e.data;
  }

  /**
   * Re-read the synctex file if its mtime or size changed (or drop the data if it is
   * gone); calls `onChange` when the data changes.
   * @param {string} pdf @returns {Promise<Synctex | null>}
   */
  refresh(pdf) {
    const e = this.entry(pdf);
    if (e.loading) return e.loading.then(() => (this.entries.get(pdf) === e ? this.refreshNow(e) : e.data));
    return this.refreshNow(e);
  }

  /** @param {Entry} e @returns {Promise<Synctex | null>} */
  refreshNow(e) {
    const found = synctexFileFor(e.pdf);
    if (!found) {
      // A TeX engine writes `X.synctex(busy)` during a run and renames it at the end: the
      // old data still matches the PDF on screen until then.
      if (e.data && fs.existsSync(`${e.pdf.replace(/\.pdf$/i, "")}.synctex(busy)`)) return Promise.resolve(e.data);
      if (e.data || e.sig) {
        e.data = null;
        e.sig = null;
        e.version++;
        this.log(`SyncTeX data gone for ${e.pdf}`);
        this.onChange(e.pdf, null);
      }
      return Promise.resolve(null);
    }
    const sig = e.sig;
    if (sig && sig.file === found.file && sig.mtimeMs === found.mtimeMs && sig.size === found.size) return Promise.resolve(e.data);
    e.loading = (async () => {
      try {
        const t0 = Date.now();
        const data = await readSynctex(found.file);
        e.data = data;
        e.sig = found;
        e.version++;
        this.log(`SyncTeX: parsed ${found.file} (${data.pages.length} pages, ${Date.now() - t0} ms)`);
        this.onChange(e.pdf, data);
        return data;
      } catch (err) {
        // caught mid-write (a build in progress): keep the old data; the next change retries
        this.log(`SyncTeX: cannot read ${found.file}: ${err instanceof Error ? err.message : err}`);
        return e.data;
      } finally {
        e.loading = null;
      }
    })();
    return e.loading;
  }

  dispose() {
    for (const e of this.entries.values()) {
      e.watcher?.close();
      clearTimeout(e.timer);
    }
    this.entries.clear();
  }
}

/**
 * The PDF a `.tex` file builds into, by its `% !TEX root = <file>` magic comment (in the
 * first 20 lines, relative to the file's directory), else the same base name. The result
 * is not checked for existence.
 * @param {string} tex absolute
 * @returns {string[]} candidates, best first
 */
function pdfCandidatesForTex(tex) {
  /** @type {string[]} */
  const out = [];
  try {
    const head = fs.readFileSync(tex, "utf8").split(/\r?\n/, 20);
    for (const l of head) {
      const m = /^\s*%\s*!\s*tex\s+root\s*=\s*(.+?)\s*$/i.exec(l);
      if (m) {
        const root = path.resolve(path.dirname(tex), m[1]);
        out.push(/\.(tex|ltx|latex)$/i.test(root) ? root.replace(/\.[^.]+$/, ".pdf") : `${root}.pdf`);
        break;
      }
    }
  } catch {
    // unreadable: only the base name
  }
  out.push(tex.replace(/\.[^./]+$/, "") + ".pdf");
  return [...new Set(out)];
}

/** @type {Map<string, {mtimeMs: number, size: number, lines: string[]}>} */
const lineCache = new Map();

/**
 * The lines of a text file, [] when unreadable. Cached by mtime and size.
 * @param {string} file @returns {string[]}
 */
function sourceLines(file) {
  try {
    const st = fs.statSync(file);
    let c = lineCache.get(file);
    if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
      c = { mtimeMs: st.mtimeMs, size: st.size, lines: fs.readFileSync(file, "utf8").split(/\r?\n/) };
      lineCache.set(file, c);
      if (lineCache.size > 50) lineCache.delete(/** @type {string} */ (lineCache.keys().next().value));
    }
    return c.lines;
  } catch {
    return [];
  }
}

/**
 * Line `line` (1-based) of a text file, whitespace-collapsed and cut at `max` characters
 * with "…"; "" when unreadable.
 * @param {string} file @param {number} line @param {number} [max]
 */
function sourceLine(file, line, max = 80) {
  return snippet(sourceLines(file)[line - 1] || "", null, max).text;
}

/**
 * A source line for the tip: whitespace collapsed, at most about `max` characters, cut
 * with "…" around the stretch [start, end) of the raw line when one is given (so that it
 * shows), else at the end; `em` is that stretch in the result.
 * @param {string} raw @param {[number, number] | null} stretch @param {number} [max]
 * @returns {{text: string, em?: [number, number]}}
 */
function snippet(raw, stretch, max = 80) {
  let text = "";
  /** @type {number[]} position in `text` of each raw offset */
  const at = [];
  for (let i = 0; i < raw.length; i++) {
    at.push(text.length);
    if (/\s/.test(raw[i])) {
      if (text && !text.endsWith(" ")) text += " ";
    } else {
      text += raw[i];
    }
  }
  at.push(text.length);
  const lead = text.length - text.trimStart().length;
  text = text.trimEnd();
  let em = stretch && stretch[1] > stretch[0] && stretch[1] <= raw.length
    ? /** @type {[number, number]} */ ([at[stretch[0]] - lead, Math.min(at[stretch[1]], text.length) - lead]) : null;
  text = text.slice(lead);
  if (em && em[1] <= em[0]) em = null;
  if (text.length <= max) return em ? { text, em } : { text };
  if (!em || em[1] <= max - 1) return { text: `${text.slice(0, max - 1).trimEnd()}…`, ...(em ? { em } : {}) };
  // the word is further in: a window around it, a third of the room before it; one that
  // reaches the end of the line ends there, with "…" in front only
  let from = Math.max(0, em[0] - Math.floor((max - (em[1] - em[0])) / 3));
  let to = from + (from > 0 ? max - 2 : max - 1);
  if (to >= text.length) {
    to = text.length;
    from = Math.max(0, to - (max - 1));
  }
  const head = from > 0 ? "…" : "";
  const tail = to < text.length ? "…" : "";
  const body = text.slice(from, to);
  return { text: head + body + tail, em: [Math.max(em[0], from) - from + head.length, Math.min(em[1], to) - from + head.length] };
}

module.exports = { SynctexStore, pdfCandidatesForTex, sourceLine, sourceLines, snippet };
