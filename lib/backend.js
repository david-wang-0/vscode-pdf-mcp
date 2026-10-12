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
 * @typedef {{text: string, page: number}} PanelSelection
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
    const sel = p.selection && typeof p.selection.text === "string" && isInt(p.selection.page)
      ? { text: p.selection.text, page: p.selection.page } : null;
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
  return { text: sel.text, source, viewer: "vscode", path: act.panel.path, page: sel.page };
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
  request,
  goto,
  which,
  readSystemSelection,
  getSelection,
  viewerState,
};
