// @ts-check
/**
 * The state one VS Code window publishes for the MCP server and the hook (README
 * "Internals"): a registry of PDF panels plus window focus, serialised to `<pid>.json`,
 * written atomically (tmp + rename) and debounced. Pure Node: no `vscode` import.
 */
"use strict";

const fs = require("node:fs");

/**
 * @typedef {import("../lib/backend").Panel} Panel
 * @typedef {import("../lib/backend").WindowState} WindowState
 */

/**
 * Write `data` to `file` atomically: readers see the old or the new content, never a
 * partial file. The temporary name does not match `<pid>.json`, so readers skip it.
 * @param {string} file @param {string} data
 */
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

class StateStore {
  /**
   * @param {{pid: number, socket: string, file: string, debounceMs?: number,
   *          now?: () => number, write?: (file: string, data: string) => void,
   *          onError?: (e: unknown) => void}} opts
   */
  constructor({ pid, socket, file, debounceMs = 100, now = Date.now, write = writeAtomic, onError }) {
    this.pid = pid;
    this.socket = socket;
    this.file = file;
    this.debounceMs = debounceMs;
    this.now = now;
    this.write = write;
    this.onError = onError || (() => {});
    /** @type {Map<string, Panel>} */
    this.panels = new Map();
    this.focused = false;
    this.focusGainAt = 0;
    /** @type {string[]} */
    this.workspaceFolders = [];
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.timer = null;
    this.disposed = false;
  }

  /** @param {string} id @param {string} path */
  addPanel(id, path) {
    /** @type {Panel} */
    const panel = { id, path, page: 0, pages: 0, active: false, lastActiveAt: 0, selection: null };
    this.panels.set(id, panel);
    this.changed();
    return panel;
  }

  /**
   * Merge `patch` into a panel. A change of `active` (either way) stamps `lastActiveAt`,
   * so the most recent activity wins the fallback rule.
   * @param {string} id @param {Partial<Omit<Panel, "id" | "lastActiveAt">>} patch
   */
  updatePanel(id, patch) {
    const panel = this.panels.get(id);
    if (!panel) return;
    if (patch.active !== undefined && patch.active !== panel.active) panel.lastActiveAt = this.now();
    Object.assign(panel, patch);
    this.changed();
  }

  /** @param {string} id */
  removePanel(id) {
    if (this.panels.delete(id)) this.changed();
  }

  /** @param {boolean} focused */
  setFocused(focused) {
    if (focused && !this.focused) this.focusGainAt = this.now();
    if (focused !== this.focused) {
      this.focused = focused;
      this.changed();
    }
  }

  /** @param {string[]} folders */
  setWorkspaceFolders(folders) {
    this.workspaceFolders = [...folders];
    this.changed();
  }

  /** @returns {WindowState} */
  serialise() {
    return {
      version: 1,
      pid: this.pid,
      socket: this.socket,
      focused: this.focused,
      focusedAt: this.focused ? this.now() : this.focusGainAt,
      workspaceFolders: [...this.workspaceFolders],
      panels: [...this.panels.values()].map((p) => ({
        ...p,
        selection: p.selection ? { ...p.selection } : null,
      })),
    };
  }

  /** Schedule a debounced write; a burst of changes yields one write. */
  changed() {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
  }

  /** Write now (cancelling a pending debounced write). */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.disposed) return;
    try {
      this.write(this.file, JSON.stringify(this.serialise(), null, 1) + "\n");
    } catch (e) {
      this.onError(e);
    }
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.disposed = true;
  }
}

module.exports = { StateStore, writeAtomic };
