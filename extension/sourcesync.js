// @ts-check
/**
 * Marks into the LaTeX source: after the user's marks change a PDF, the edit service's
 * `sync` (protocol v2) writes them into the PDF's LaTeX sources as pdfnotes macros. This
 * module decides when, per PDF:
 *
 * - a burst of writes gives one sync, `debounceMs` after the last; never two at a time
 *   (one asked for meanwhile runs after the first);
 * - only with a SyncTeX file next to the PDF and a service that has `sync` (v2);
 * - not while a source of the PDF has unsaved changes in an editor: the sync is then
 *   pending and runs once those are saved or dropped (`recheck`), not before;
 * - a document none of whose sources loads pdfnotes is not tried again until its
 *   SyncTeX file changes (a rebuild).
 *
 * Pure Node: the editor's side (settings, dirty documents, messages) comes in as hooks.
 */
"use strict";

const path = require("node:path");
const { synctexFileFor } = require("../lib/synctex");

/** The first edit-service protocol version with `sync`. */
const SYNC_VERSION = 2;
/** The service's error when no source loads the package. */
const NO_PDFNOTES = /does not load the pdfnotes package/;
/** Files that may be sources of a PDF without SyncTeX data to tell. */
const SOURCE_EXT = /\.(tex|ltx|latex|sty|cls|bib)$/i;

/**
 * @typedef {{id: string, file: string, line: number, macro: string}} SyncItem
 * @typedef {{source: string | null, reason?: string, inserted?: SyncItem[], updated?: SyncItem[],
 *   removed?: SyncItem[], fallback?: SyncItem[], skipped?: any[]}} SyncReport
 * @typedef {{
 *   request: (pdf: string) => Promise<SyncReport>,
 *   version: () => Promise<number>,
 *   dirtySources: (pdf: string) => string[],
 *   enabled?: () => boolean,
 *   synctexSig?: (pdf: string) => string | null,
 *   serial?: (pdf: string, fn: () => Promise<any>) => Promise<any>,
 *   onSynced?: (pdf: string, report: SyncReport) => void,
 *   onNoPdfnotes?: (pdf: string, message: string) => void,
 *   onError?: (pdf: string, message: string) => void,
 *   log?: (msg: string) => void,
 *   debounceMs?: number,
 * }} Hooks
 * `request` sends `sync`; `serial` runs it in the PDF's write queue (the checks run there
 * too, right before it); `onNoPdfnotes` and `onError` are called once per PDF.
 * @typedef {{timer: ReturnType<typeof setTimeout> | undefined, running: Promise<void> | null,
 *   again: boolean, pending: boolean}} State
 */

/** The SyncTeX file's identity (name, mtime, size), null without one. @param {string} pdf */
function synctexSig(pdf) {
  const f = synctexFileFor(pdf);
  return f ? `${f.file}:${f.mtimeMs}:${f.size}` : null;
}

/** The files a sync of this report changed, as it names them. @param {SyncReport} r */
function changedFiles(r) {
  const items = [...(r.inserted || []), ...(r.updated || []), ...(r.removed || []), ...(r.fallback || [])];
  return [...new Set(items.map((i) => i.file))];
}

/**
 * Which of the `dirty` files (absolute) are sources of `pdf`: those in its SyncTeX data
 * when there is some, else LaTeX files under the PDF's directory.
 * @param {string} pdf @param {{tagsOf: (file: string) => number[]} | null} data @param {string[]} dirty
 */
function sourcesAmong(pdf, data, dirty) {
  if (data) return dirty.filter((f) => data.tagsOf(f).length > 0);
  const dir = path.dirname(pdf) + path.sep;
  return dirty.filter((f) => SOURCE_EXT.test(f) && path.resolve(f).startsWith(dir));
}

class SourceSync {
  /** @param {Hooks} hooks */
  constructor(hooks) {
    this.hooks = hooks;
    this.debounceMs = hooks.debounceMs ?? 300;
    this.log = hooks.log || (() => {});
    /** @type {Map<string, State>} */
    this.states = new Map();
    /** PDF -> the SyncTeX identity it had when the service said no source loads pdfnotes. @type {Map<string, string | null>} */
    this.noPdfnotes = new Map();
    /** PDFs already told about (no pdfnotes, other errors). @type {Set<string>} */
    this.toldNoPdfnotes = new Set();
    /** @type {Set<string>} */
    this.warned = new Set();
    this.oldService = false;
    this.disposed = false;
  }

  /** @param {string} pdf @returns {State} */
  state(pdf) {
    let s = this.states.get(pdf);
    if (!s) this.states.set(pdf, (s = { timer: undefined, running: null, again: false, pending: false }));
    return s;
  }

  enabled() {
    return !this.disposed && (this.hooks.enabled ? this.hooks.enabled() : true);
  }

  /** A write to `pdf` (by the user) has finished: sync after the burst. @param {string} pdf */
  schedule(pdf) {
    if (!this.enabled()) return;
    const s = this.state(pdf);
    clearTimeout(s.timer);
    s.timer = setTimeout(() => void this.fire(pdf), this.debounceMs);
  }

  /** Sync `pdf` now, or right after the sync that runs. @param {string} pdf */
  fire(pdf) {
    const s = this.state(pdf);
    clearTimeout(s.timer);
    s.timer = undefined;
    if (s.running) {
      s.again = true;
      return s.running;
    }
    s.running = this.once(pdf).finally(() => {
      s.running = null;
      if (s.again) {
        s.again = false;
        this.schedule(pdf);
      }
    });
    return s.running;
  }

  /** Is a sync of `pdf` waiting for its sources to be saved? @param {string} pdf */
  isPending(pdf) {
    return !!this.states.get(pdf)?.pending;
  }

  /** Is anything scheduled or running for `pdf`? @param {string} pdf */
  isBusy(pdf) {
    const s = this.states.get(pdf);
    return !!s && (!!s.timer || !!s.running);
  }

  /** A document was saved, closed or reverted: run the pending syncs whose sources are all saved. */
  recheck() {
    for (const [pdf, s] of this.states) {
      if (!s.pending) continue;
      if (!this.enabled()) {
        s.pending = false;
        continue;
      }
      if (this.hooks.dirtySources(pdf).length) continue;
      s.pending = false;
      this.log(`sync ${pdf}: its sources are saved, syncing`);
      void this.fire(pdf);
    }
  }

  /**
   * One sync of `pdf`, with its checks, in the PDF's write queue.
   * @param {string} pdf
   */
  async once(pdf) {
    const h = this.hooks;
    const serial = h.serial || ((_p, fn) => fn());
    const sigOf = h.synctexSig || synctexSig;
    /** @type {string | null} */
    let sig = null;
    /** @type {SyncReport | null} */
    let report = null;
    try {
      report = await serial(pdf, async () => {
        if (!this.enabled()) return null;
        sig = sigOf(pdf);
        if (!sig) {
          this.log(`sync ${pdf}: skipped, no SyncTeX file next to it`);
          return null;
        }
        const version = await h.version();
        if (version < SYNC_VERSION) {
          if (!this.oldService) this.log(`sync: skipped, the edit service speaks protocol ${version}; marks go into the LaTeX source from ${SYNC_VERSION} on`);
          this.oldService = true;
          return null;
        }
        if (this.noPdfnotes.has(pdf)) {
          if (this.noPdfnotes.get(pdf) === sig) {
            this.log(`sync ${pdf}: skipped, no source loads pdfnotes (until it is rebuilt)`);
            return null;
          }
          this.noPdfnotes.delete(pdf);
        }
        const dirty = h.dirtySources(pdf);
        if (dirty.length) {
          this.state(pdf).pending = true;
          this.log(`sync ${pdf}: pending until these are saved: ${dirty.join(", ")}`);
          return null;
        }
        return h.request(pdf);
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (NO_PDFNOTES.test(message)) {
        this.noPdfnotes.set(pdf, sig);
        this.log(`sync ${pdf}: not copied, ${message}`);
        if (!this.toldNoPdfnotes.has(pdf)) {
          this.toldNoPdfnotes.add(pdf);
          h.onNoPdfnotes?.(pdf, message);
        }
      } else {
        this.log(`sync ${pdf} failed: ${message}`);
        if (!this.warned.has(pdf)) {
          this.warned.add(pdf);
          h.onError?.(pdf, message);
        }
      }
      return;
    }
    if (!report) return;
    if (!report.source) {
      this.log(`sync ${pdf}: ${report.reason || "no source"}`);
      return;
    }
    const n = (/** @type {any[] | undefined} */ l) => (l || []).length;
    this.log(`sync ${pdf} -> ${report.source}: ${n(report.inserted)} inserted, ${n(report.updated)} updated, `
      + `${n(report.removed)} removed, ${n(report.fallback)} as notes, ${n(report.skipped)} skipped`);
    for (const k of report.skipped || []) this.log(`sync ${pdf}: skipped xref ${k.xref} (page ${k.page}, ${k.subtype}): ${k.reason}`);
    if (changedFiles(report).length) h.onSynced?.(pdf, report);
  }

  /** Resolves when nothing is scheduled or running for `pdf` (tests). @param {string} pdf */
  async settled(pdf) {
    for (;;) {
      const s = this.states.get(pdf);
      if (!s || (!s.timer && !s.running)) return;
      if (s.running) await s.running;
      else await new Promise((r) => setTimeout(r, this.debounceMs / 2 + 1));
    }
  }

  dispose() {
    this.disposed = true;
    for (const s of this.states.values()) clearTimeout(s.timer);
  }
}

module.exports = { SourceSync, SYNC_VERSION, NO_PDFNOTES, changedFiles, sourcesAmong, synctexSig };
