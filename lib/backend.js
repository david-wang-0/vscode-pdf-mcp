// @ts-check
/**
 * Viewer backend shared by the MCP server and the hook: reads the state files that each
 * VS Code window publishes, picks the active entry, sends `goto` over a window's socket,
 * and reads the system clipboard. No VS Code and no pdf.js in here.
 *
 * See README "Internals" for the state-file and socket protocol.
 */
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ensureSessionEnv, stateDir } = require("./runtime");

/** C1 / C3: nothing open. */
const NO_WINDOW = "no VS Code window with a PDF open";
/** C2: bad `source`. */
const BAD_SOURCE = "source must be 'primary' or 'clipboard'";
/** goto with a path that is not open anywhere and no VS Code window to open it in. */
const NO_EXTENSION = "no VS Code window is running the vscode-pdf-mcp extension";

class ViewerError extends Error {}

/**
 * @typedef {{file: string, lines: [number, number]}} TexLines
 * @typedef {{text: string, page: number, tex?: TexLines[]}} PanelSelection
 * @typedef {{id: string, path: string, page: number, pages: number, active: boolean,
 *            lastActiveAt: number, selection: PanelSelection | null}} Panel
 * @typedef {{version: 1, pid: number, socket: string, focused: boolean, focusedAt: number,
 *            workspaceFolders: string[], panels: Panel[]}} WindowState
 * @typedef {{viewer: "vscode", window: string, path: string, page: number, pages: number,
 *            active: boolean}} Entry
 * @typedef {{state: WindowState, panel: Panel}} Located
 */

/**
 * `p` with symlinks resolved (CONTRACT C3 compares paths by realpath); the lexically
 * resolved path when it does not exist.
 * @param {string} p
 */
function realPath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** @param {number} pid */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
}

/** @param {unknown} x @returns {x is number} */
const isInt = (x) => typeof x === "number" && Number.isInteger(x);
/** @param {unknown} x */
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : 0);

/**
 * Validate one parsed state file; null if it is not a usable v1 state.
 * @param {any} raw
 * @returns {WindowState | null}
 */
function normaliseState(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== 1 || !isInt(raw.pid) || raw.pid <= 0) return null;
  if (!Array.isArray(raw.panels)) return null;
  /** @type {Panel[]} */
  const panels = [];
  for (const p of raw.panels) {
    if (!p || typeof p.path !== "string" || !path.isAbsolute(p.path)) continue;
    /** @type {PanelSelection | null} */
    const sel = p.selection && typeof p.selection.text === "string" && isInt(p.selection.page)
      ? { text: p.selection.text, page: p.selection.page } : null;
    const tex = sel ? normaliseTex(p.selection.tex) : null;
    if (sel && tex) sel.tex = tex;
    panels.push({
      id: String(p.id),
      path: p.path,
      page: isInt(p.page) ? p.page : 0,
      pages: isInt(p.pages) ? p.pages : 0,
      active: p.active === true,
      lastActiveAt: num(p.lastActiveAt),
      selection: sel,
    });
  }
  return {
    version: 1,
    pid: raw.pid,
    socket: typeof raw.socket === "string" ? raw.socket : "",
    focused: raw.focused === true,
    focusedAt: num(raw.focusedAt),
    workspaceFolders: Array.isArray(raw.workspaceFolders)
      ? raw.workspaceFolders.filter((/** @type {unknown} */ f) => typeof f === "string") : [],
    panels,
  };
}

/**
 * A selection's SyncTeX source lines (CONTRACT C2 `tex`): a non-empty list of
 * `{file: <absolute path>, lines: [first, last]}`, else null.
 * @param {unknown} raw
 * @returns {TexLines[] | null}
 */
function normaliseTex(raw) {
  if (!Array.isArray(raw)) return null;
  /** @type {TexLines[]} */
  const out = [];
  for (const t of raw) {
    if (!t || typeof t.file !== "string" || !path.isAbsolute(t.file) || !Array.isArray(t.lines) || t.lines.length !== 2) continue;
    const [a, b] = t.lines;
    if (!isInt(a) || !isInt(b) || a < 1 || b < a) continue;
    out.push({ file: t.file, lines: [a, b] });
  }
  return out.length ? out : null;
}

/**
 * Windows ordered most recently focused first: a focused window, then by `focusedAt`.
 * @param {WindowState[]} states
 */
function byFocus(states) {
  return [...states].sort((a, b) =>
    Number(b.focused) - Number(a.focused) || b.focusedAt - a.focusedAt || a.pid - b.pid);
}

/**
 * The live windows' states, most recently focused first. Files that fail to parse, are
 * not version 1, or whose pid is dead are ignored.
 * @param {string} [dir]
 * @returns {WindowState[]}
 */
function readStates(dir = stateDir()) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  /** @type {WindowState[]} */
  const out = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    let state;
    try {
      state = normaliseState(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
    } catch {
      continue;
    }
    if (state && isAlive(state.pid)) out.push(state);
  }
  return byFocus(out);
}

/**
 * The active entry (CONTRACT Terms): the panel that is its window's active editor, in the
 * most recently focused window that has one; failing that (unless `strict`), the panel
 * with the greatest `lastActiveAt` overall.
 * @param {WindowState[]} states
 * @param {{strict?: boolean}} [opts]
 * @returns {Located | null}
 */
function activePanel(states, { strict = false } = {}) {
  for (const state of byFocus(states)) {
    const panel = state.panels.find((p) => p.active);
    if (panel) return { state, panel };
  }
  if (strict) return null;
  /** @type {Located | null} */
  let best = null;
  for (const state of byFocus(states)) {
    for (const panel of state.panels) {
      if (!best || panel.lastActiveAt > best.panel.lastActiveAt) best = { state, panel };
    }
  }
  return best;
}

/**
 * @param {WindowState} state @param {Panel} panel @param {boolean} active
 * @returns {Entry}
 */
function entryOf(state, panel, active) {
  return {
    viewer: "vscode",
    window: `${state.pid}:${panel.id}`,
    path: panel.path,
    page: panel.page,
    pages: panel.pages,
    active,
  };
}

/**
 * Every open document as a CONTRACT entry, the active one first and the only one with
 * `active: true`; then by window focus order and most recent activity.
 * @param {WindowState[]} states
 * @returns {Entry[]}
 */
function entries(states) {
  const act = activePanel(states);
  /** @type {Located[]} */
  const rest = [];
  for (const state of byFocus(states)) {
    const panels = [...state.panels].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    for (const panel of panels) if (!act || panel !== act.panel) rest.push({ state, panel });
  }
  const list = rest.map(({ state, panel }) => entryOf(state, panel, false));
  if (act) list.unshift(entryOf(act.state, act.panel, true));
  return list;
}

/**
 * Panels showing `file` (compared by realpath), best candidate first (the active entry,
 * then focus order).
 * @param {WindowState[]} states @param {string} file
 * @returns {Located[]}
 */
function findPanels(states, file) {
  const real = realPath(file);
  const act = activePanel(states);
  /** @type {Located[]} */
  const found = [];
  for (const state of byFocus(states)) {
    const panels = [...state.panels].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    for (const panel of panels) if (panel.path === file || realPath(panel.path) === real) found.push({ state, panel });
  }
  if (act) {
    const i = found.findIndex((l) => l.panel === act.panel);
    if (i > 0) found.unshift(...found.splice(i, 1));
  }
  return found;
}

/**
 * One request over a window's socket: send a JSON line, read one JSON line back.
 * @param {string} socket @param {object} message @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
function request(socket, message, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socket);
    let buf = "";
    let done = false;
    /** @param {Error | null} err @param {any} [value] */
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new ViewerError(`VS Code did not answer within ${timeoutMs / 1000} s`)),
      timeoutMs);
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(JSON.stringify(message) + "\n"));
    conn.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        finish(null, JSON.parse(buf.slice(0, nl)));
      } catch {
        finish(new ViewerError("bad response from the VS Code extension"));
      }
    });
    conn.on("error", (e) => finish(new ViewerError(`cannot reach VS Code at ${socket}: ${e.message}`)));
    conn.on("end", () => finish(new ViewerError("the VS Code extension closed the connection without answering")));
  });
}

/**
 * C3: show `page` of `file` (default: the active entry's document) and return its entry.
 * @param {number} page
 * @param {string | null | undefined} file
 * @param {{dir?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<Entry>}
 */
async function goto(page, file, { dir = stateDir(), timeoutMs = 10000 } = {}) {
  const states = readStates(dir);
  /** @type {string} */
  let target;
  if (file === undefined || file === null || file === "") {
    const act = activePanel(states);
    if (!act) throw new ViewerError(noWindow(states));
    target = act.panel.path;
  } else {
    target = path.resolve(file);
    let isFile = false;
    try {
      isFile = fs.statSync(target).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) throw new ViewerError(`no such file: ${file}`);
  }
  if (!isInt(page)) throw new ViewerError(`page must be an integer, got ${page}`);
  const open = findPanels(states, target);
  /** @type {WindowState | undefined} */
  let state;
  if (open.length) {
    const { pages } = open[0].panel;
    if (pages > 0 && (page < 1 || page > pages)) throw new ViewerError(`page ${page} outside 1-${pages}`);
    state = open[0].state;
  } else {
    state = byFocus(states)[0];
    if (!state) throw new ViewerError(NO_EXTENSION);
  }
  const resp = await request(state.socket, { op: "goto", path: target, page }, timeoutMs);
  if (!resp || resp.ok !== true) throw new ViewerError(String(resp?.error || "goto failed"));
  return resp.entry;
}

/**
 * The windows to send a request about `files` to, best first: one that has the first of
 * them open (the active entry first), then those whose workspace folder contains one of
 * them, then the rest, most recently focused first.
 * @param {WindowState[]} states @param {string[]} files absolute
 * @returns {WindowState[]}
 */
function pickWindows(states, files) {
  /** @type {WindowState[]} */
  const out = [];
  const add = (/** @type {WindowState} */ s) => {
    if (!out.includes(s)) out.push(s);
  };
  if (files.length) for (const { state } of findPanels(states, files[0])) add(state);
  const reals = files.map(realPath);
  for (const state of byFocus(states)) {
    const folders = state.workspaceFolders.map(realPath);
    if (reals.some((f) => folders.some((w) => {
      const rel = path.relative(w, f);
      return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    }))) add(state);
  }
  for (const state of byFocus(states)) add(state);
  return out;
}

/**
 * Send `message` to the first of `windows` that answers; a window that cannot be reached
 * (gone since its state file was written) is skipped, one that answers too late is not.
 * @param {WindowState[]} windows @param {object} message @param {number} timeoutMs
 */
async function requestFirst(windows, message, timeoutMs) {
  if (!windows.length) throw new ViewerError(NO_EXTENSION);
  /** @type {unknown} */
  let last = null;
  for (const state of windows) {
    try {
      return await request(state.socket, message, timeoutMs);
    } catch (e) {
      last = e;
      if (e instanceof Error && /did not answer within/.test(e.message)) throw e;
    }
  }
  const why = last instanceof Error ? last.message : String(last);
  throw new ViewerError(windows.length === 1 ? why : `no VS Code window answered (${windows.length} tried; last: ${why})`);
}

/**
 * Open (or reveal) `file` in the VS Code PDF viewer; returns its entry.
 * @param {string} file
 * @param {{dir?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<Entry>}
 */
async function openPdf(file, { dir = stateDir(), timeoutMs = 10000 } = {}) {
  const target = path.resolve(file);
  if (!isRegularFile(target)) throw new ViewerError(`no such file: ${file}`);
  const resp = await requestFirst(pickWindows(readStates(dir), [target]), { op: "open", path: target }, timeoutMs);
  if (!resp || resp.ok !== true) throw new ViewerError(String(resp?.error || "open failed"));
  return resp.entry;
}

/**
 * SyncTeX forward search: show `line` of `tex` in `pdf` (default: the window finds the
 * PDF) and flash it; returns the PDF's entry.
 * @param {{tex: string, line: number, column?: number, pdf?: string}} query
 * @param {{dir?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<Entry>}
 */
async function synctexForward({ tex, line, column, pdf }, { dir = stateDir(), timeoutMs = 10000 } = {}) {
  const source = path.resolve(tex);
  if (!isInt(line) || line < 1) throw new ViewerError(`line must be a positive integer, got ${line}`);
  const target = pdf ? path.resolve(pdf) : undefined;
  if (target && !isRegularFile(target)) throw new ViewerError(`no such file: ${pdf}`);
  /** @type {Record<string, unknown>} */
  const req = { op: "synctexForward", tex: source, line };
  if (isInt(column)) req.column = column;
  if (target) req.pdf = target;
  const resp = await requestFirst(pickWindows(readStates(dir), target ? [target, source] : [source]), req, timeoutMs);
  if (!resp || resp.ok !== true) throw new ViewerError(String(resp?.error || "forward search failed"));
  return resp.entry;
}

/** @param {string} p */
function isRegularFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * First executable called `name` on `env.PATH`.
 * @param {string} name @param {NodeJS.ProcessEnv} env
 */
function which(name, env) {
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return null;
}

/**
 * The system primary selection or clipboard, read straight from the display server with
 * `wl-paste` (Wayland), else `xclip`, else `xsel`. Mirrors okular-mcp's selection.py.
 * @param {string} source "primary" or "clipboard"
 * @param {NodeJS.ProcessEnv} [env] filled per C5 before any tool runs
 * @returns {string}
 */
function readSystemSelection(source, env = process.env) {
  if (source !== "primary" && source !== "clipboard") throw new ViewerError(BAD_SOURCE);
  ensureSessionEnv(env);
  const primary = source === "primary";
  /** @type {string[] | null} */
  let argv = null;
  /** @type {string | null} */
  let exe = null;
  if (env.WAYLAND_DISPLAY && (exe = which("wl-paste", env))) {
    argv = primary ? ["wl-paste", "--primary", "--no-newline"] : ["wl-paste", "--no-newline"];
  } else if ((exe = which("xclip", env))) {
    argv = ["xclip", "-o", "-selection", source];
  } else if ((exe = which("xsel", env))) {
    argv = ["xsel", "-o", primary ? "--primary" : "--clipboard"];
  }
  if (!argv || !exe) {
    throw new ViewerError("no clipboard tool found: install wl-clipboard (Wayland) or xclip/xsel (X11)");
  }
  const r = spawnSync(exe, argv.slice(1), { env, encoding: "utf8", timeout: 5000 });
  if (r.error) {
    const code = /** @type {NodeJS.ErrnoException} */ (r.error).code;
    if (code === "ETIMEDOUT") throw new ViewerError(`${argv[0]} timed out`);
    throw new ViewerError(`${argv.join(" ")} failed: ${r.error.message}`);
  }
  if (r.status !== 0) {
    const err = (r.stderr || "").trim();
    if (err.includes("Nothing is copied") || err.toLowerCase().includes("no selection")) return "";
    throw new ViewerError(`${argv.join(" ")} failed: ${err}`);
  }
  return r.stdout;
}

/**
 * C2: `{text, source}` plus `viewer`, `path`, `page` when attributable.
 * `primary` is the text selected in the VS Code PDF viewer (never the system primary
 * selection); `clipboard` is the system clipboard, never attributed.
 * @param {string} source
 * @param {{dir?: string, env?: NodeJS.ProcessEnv}} [opts]
 */
function getSelection(source = "primary", { dir = stateDir(), env = process.env } = {}) {
  if (source === "clipboard") return { text: readSystemSelection(source, env), source };
  if (source !== "primary") throw new ViewerError(BAD_SOURCE);
  const act = activePanel(readStates(dir));
  const sel = act?.panel.selection;
  if (!act || !sel || !sel.text) return { text: "", source };
  return {
    text: sel.text, source, viewer: "vscode", path: act.panel.path, page: sel.page,
    ...(sel.tex && sel.tex.length ? { tex: sel.tex.map((t) => ({ file: t.file, lines: [...t.lines] })) } : {}),
  };
}

/**
 * C1: the entries, active first; throws when nothing is open.
 * @param {{dir?: string}} [opts]
 */
function viewerState({ dir = stateDir() } = {}) {
  const states = readStates(dir);
  const list = entries(states);
  if (!list.length) throw new ViewerError(noWindow(states));
  return list;
}

/**
 * C1's message, with the cause in brackets when no window runs the extension at all.
 * @param {WindowState[]} states
 */
function noWindow(states) {
  return states.length ? NO_WINDOW : `${NO_WINDOW} (${NO_EXTENSION})`;
}

module.exports = {
  NO_WINDOW,
  BAD_SOURCE,
  NO_EXTENSION,
  ViewerError,
  isAlive,
  realPath,
  normaliseState,
  readStates,
  activePanel,
  entryOf,
  entries,
  findPanels,
  pickWindows,
  request,
  goto,
  openPdf,
  synctexForward,
  which,
  readSystemSelection,
  getSelection,
  viewerState,
};
