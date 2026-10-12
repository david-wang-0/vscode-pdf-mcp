// @ts-check
/**
 * VS Code glue: a readonly custom editor for *.pdf backed by pdf.js in a webview. Each
 * window (extension host) publishes `<pid>.json` and serves `<pid>.sock` in the runtime
 * directory, so the MCP server and the hook can see what the user is reading and the
 * server can `goto`. Everything vscode-free lives in state.js, ipc.js, html.js and lib/.
 */
"use strict";

const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { StateStore } = require("./state");
const ipc = require("./ipc");
const { renderHtml, nonce } = require("./html");
const { stateDir } = require("../lib/runtime");
const { isAlive, realPath, NO_WINDOW } = require("../lib/backend");

const VIEW_TYPE = "vscodePdfMcp.viewer";
const EXTERNAL_VIEW_TYPE = "pdfExternalOpen.editor";
/** The server waits 10 s; answer (or fail) a little before that. */
const OPEN_TIMEOUT_MS = 9000;
const RELOAD_DEBOUNCE_MS = 200;

/** @type {vscode.OutputChannel | undefined} */
let log;
/** @param {string} msg */
const trace = (msg) => {
  log?.appendLine(`[${new Date().toISOString()}] ${msg}`);
  if (process.env.VSCODE_PDF_MCP_DEBUG) console.log(`vscode-pdf-mcp: ${msg}`);
};

/**
 * @template T
 * @param {Promise<T>} promise @param {number} ms @param {string} what
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, what) {
  /** @type {ReturnType<typeof setTimeout>} */
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** One open PDF tab. */
class PdfPanel {
  /**
   * @param {Viewer} owner @param {string} id @param {vscode.Uri} uri
   * @param {vscode.WebviewPanel} panel
   */
  constructor(owner, id, uri, panel) {
    this.owner = owner;
    this.id = id;
    this.uri = uri;
    this.path = uri.fsPath;
    this.realPath = realPath(this.path);
    this.panel = panel;
    this.pages = 0;
    this.page = 0;
    this.disposed = false;
    /** @type {{mtimeMs: number, size: number} | null} */
    this.signature = null;
    /** @type {fs.FSWatcher | null} */
    this.watcher = null;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.reloadTimer = undefined;
    this.reqSeq = 0;
    /** @type {Map<number, (page: number) => void>} */
    this.gotoWaiters = new Map();
    /** @type {(() => void) | null} */
    this.resolveLoaded = null;
    /** @type {((e: Error) => void) | null} */
    this.rejectLoaded = null;
    /** Settles on the first successful load (or the first failure). @type {Promise<void>} */
    this.loaded = new Promise((resolve, reject) => {
      this.resolveLoaded = resolve;
      this.rejectLoaded = reject;
    });
    this.loaded.catch(() => {});

    const root = owner.context.extensionUri;
    const webview = panel.webview;
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(root, "media"),
      vscode.Uri.joinPath(root, "node_modules", "pdfjs-dist")] };
    webview.html = renderHtml({
      cspSource: webview.cspSource,
      nonce: nonce(),
      // Directory URLs (cmaps, fonts, wasm, images) keep their trailing slash: pdf.js appends names.
      uri: (rel) => webview.asWebviewUri(vscode.Uri.joinPath(root, ...rel.split("/").filter(Boolean))).toString()
        + (rel.endsWith("/") ? "/" : ""),
    });

    owner.store.addPanel(id, this.path);
    owner.store.updatePanel(id, { active: panel.active });
    const subs = [
      webview.onDidReceiveMessage((m) => this.onMessage(m)),
      panel.onDidChangeViewState((e) => {
        owner.store.updatePanel(id, { active: e.webviewPanel.active });
        void webview.postMessage({ type: "visibility", visible: e.webviewPanel.visible });
      }),
    ];
    panel.onDidDispose(() => {
      this.disposed = true;
      subs.forEach((s) => s.dispose());
      this.watcher?.close();
      clearTimeout(this.reloadTimer);
      this.rejectLoaded?.(new Error(`the tab for ${this.path} was closed`));
      owner.removePanel(this);
    });
    this.watch();
  }

  /** @param {any} m */
  onMessage(m) {
    if (!m || typeof m !== "object") return;
    const store = this.owner.store;
    switch (m.type) {
      case "ready":
        void this.panel.webview.postMessage({ type: "visibility", visible: this.panel.visible });
        void this.sendFile(false);
        break;
      case "loaded":
        this.pages = m.pages;
        this.page = m.page;
        store.updatePanel(this.id, { pages: m.pages, page: m.page });
        this.resolveLoaded?.();
        if (m.reload) trace(`reloaded ${this.path} (${m.pages} pages, at page ${m.page})`);
        break;
      case "loadError":
        trace(`cannot load ${this.path}: ${m.message}`);
        this.signature = null; // retry on the next change, whatever its mtime and size
        if (!m.reload) this.rejectLoaded?.(new Error(`cannot open ${this.path}`));
        break;
      case "page":
        this.page = m.page;
        store.updatePanel(this.id, { page: m.page });
        break;
      case "selection":
        store.updatePanel(this.id, { selection: m.selection || null });
        break;
      case "gotoDone": {
        const done = this.gotoWaiters.get(m.reqId);
        this.gotoWaiters.delete(m.reqId);
        done?.(m.page);
        break;
      }
      case "openLink":
        if (typeof m.url === "string" && /^(https?|mailto):/i.test(m.url)) {
          void vscode.env.openExternal(vscode.Uri.parse(m.url, true));
        }
        break;
      case "error":
        trace(`webview ${this.path}: ${m.message}`);
        break;
      case "openExternalViewer":
        void openExternalViewer(this.uri);
        break;
    }
  }

  /** @param {boolean} reload */
  async sendFile(reload) {
    try {
      const st = fs.statSync(this.path);
      const read = await vscode.workspace.fs.readFile(this.uri);
      if (this.disposed) return;
      this.signature = { mtimeMs: st.mtimeMs, size: st.size };
      // A view into a shared Node buffer does not survive postMessage; send an exact copy.
      const data = new Uint8Array(read.byteLength);
      data.set(read);
      await this.panel.webview.postMessage({ type: "load", data, reload });
    } catch (e) {
      trace(`cannot read ${this.path}: ${e instanceof Error ? e.message : e}`);
      if (!reload) this.rejectLoaded?.(new Error(`cannot open ${this.path}`));
    }
  }

  /**
   * Watch the file's directory (survives replace-by-rename, works outside the workspace)
   * and reload when its mtime or size changes.
   */
  watch() {
    const dir = path.dirname(this.path);
    const base = path.basename(this.path);
    try {
      this.watcher = fs.watch(dir, { persistent: false }, (_event, name) => {
        if (name && name.toString() !== base) return;
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.checkChanged(), RELOAD_DEBOUNCE_MS);
      });
      this.watcher.on("error", (e) => trace(`watch ${dir}: ${e.message}`));
    } catch (e) {
      trace(`cannot watch ${dir}: ${e instanceof Error ? e.message : e}`);
    }
  }

  checkChanged() {
    if (this.disposed) return;
    let st;
    try {
      st = fs.statSync(this.path);
    } catch {
      return; // gone for now (mid-replace); the next event retries
    }
    const sig = this.signature;
    if (sig && sig.mtimeMs === st.mtimeMs && sig.size === st.size) return;
    void this.sendFile(true);
  }

  /** @param {number} page */
  async goto(page) {
    await withTimeout(this.loaded, OPEN_TIMEOUT_MS, `loading ${this.path}`);
    if (page < 1 || page > this.pages) throw new Error(`page ${page} outside 1-${this.pages}`);
    this.panel.reveal(this.panel.viewColumn, false);
    const reqId = ++this.reqSeq;
    const done = new Promise((resolve) => this.gotoWaiters.set(reqId, resolve));
    await this.panel.webview.postMessage({ type: "goto", page, reqId });
    const shown = await withTimeout(done, 5000, "goto");
    this.page = /** @type {number} */ (shown);
    this.owner.store.updatePanel(this.id, { page: this.page });
    return this.entry();
  }

  entry() {
    return {
      viewer: "vscode",
      window: `${this.owner.pid}:${this.id}`,
      path: this.path,
      page: this.page,
      pages: this.pages,
      active: this.panel.active,
    };
  }
}

/** The custom editor provider plus this window's registry of panels. */
class Viewer {
  /** @param {vscode.ExtensionContext} context @param {StateStore} store @param {number} pid */
  constructor(context, store, pid) {
    this.context = context;
    this.store = store;
    this.pid = pid;
    this.seq = 0;
    /** @type {Set<PdfPanel>} */
    this.panels = new Set();
    /** @type {Map<string, Set<(p: PdfPanel) => void>>} realpath -> waiters */
    this.panelWaiters = new Map();
  }

  /** @param {vscode.Uri} uri @returns {vscode.CustomDocument} */
  openCustomDocument(uri) {
    return { uri, dispose() {} };
  }

  /** @param {vscode.CustomDocument} document @param {vscode.WebviewPanel} panel */
  resolveCustomEditor(document, panel) {
    const p = new PdfPanel(this, String(++this.seq), document.uri, panel);
    this.panels.add(p);
    const waiters = this.panelWaiters.get(p.realPath);
    this.panelWaiters.delete(p.realPath);
    for (const w of waiters || []) w(p);
  }

  /** @param {PdfPanel} p */
  removePanel(p) {
    this.panels.delete(p);
    this.store.removePanel(p.id);
  }

  /** Resolves when a tab for `real` (a realpath) is created. @param {string} real @returns {Promise<PdfPanel>} */
  waitForPanel(real) {
    return new Promise((resolve) => {
      const set = this.panelWaiters.get(real) || new Set();
      set.add(resolve);
      this.panelWaiters.set(real, set);
    });
  }

  /**
   * Best panel for `file`, compared by realpath (null: this window's active or most
   * recent PDF).
   * @param {string | null} file
   */
  pick(file) {
    const real = file === null ? null : realPath(file);
    const candidates = [...this.panels].filter((p) => real === null || p.realPath === real);
    const lastActive = (/** @type {PdfPanel} */ p) => this.store.panels.get(p.id)?.lastActiveAt ?? 0;
    candidates.sort((a, b) => Number(b.panel.active) - Number(a.panel.active) || lastActive(b) - lastActive(a));
    return candidates[0] || null;
  }

  /** @param {string | null} file @param {number} page */
  async goto(file, page) {
    if (!Number.isInteger(page)) throw new Error(`page must be an integer, got ${page}`);
    const existing = this.pick(file);
    if (existing) return existing.goto(page);
    if (file === null) throw new Error(NO_WINDOW);
    if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`);
    const created = this.waitForPanel(realPath(file));
    await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.file(file), VIEW_TYPE);
    const p = await withTimeout(created, OPEN_TIMEOUT_MS, `opening ${file}`);
    return p.goto(page);
  }

  /** Socket handler. @param {any} req */
  async handle(req) {
    switch (req.op) {
      case "ping":
        return { ok: true, pid: this.pid };
      case "state":
        return { ok: true, state: this.store.serialise() };
      case "goto": {
        const file = typeof req.path === "string" && req.path ? path.resolve(req.path) : null;
        return { ok: true, entry: await this.goto(file, req.page) };
      }
      default:
        return { ok: false, error: `unknown op: ${req.op}` };
    }
  }
}

/** Open in pdf-external-open's editor if installed (it hands off to Okular), else spawn. */
/** @param {vscode.Uri} uri */
async function openExternalViewer(uri) {
  const hasStub = vscode.extensions.all.some((e) =>
    (e.packageJSON?.contributes?.customEditors || []).some((/** @type {any} */ c) => c.viewType === EXTERNAL_VIEW_TYPE));
  if (hasStub) {
    await vscode.commands.executeCommand("vscode.openWith", uri, EXTERNAL_VIEW_TYPE);
    return;
  }
  const cmd = vscode.workspace.getConfiguration("vscodePdfMcp").get("externalViewer", "okular");
  try {
    const child = spawn(cmd, [uri.fsPath], { detached: true, stdio: "ignore" });
    child.on("error", (e) => void vscode.window.showErrorMessage(`vscode-pdf-mcp: could not run ${cmd}: ${e.message}`));
    child.unref();
  } catch (e) {
    void vscode.window.showErrorMessage(`vscode-pdf-mcp: could not run ${cmd}: ${e instanceof Error ? e.message : e}`);
  }
}

/** Remove our own pid's leftovers and files of windows that are gone. @param {string} dir @param {number} pid */
function removeStale(dir, pid) {
  for (const name of fs.readdirSync(dir)) {
    const m = /^(\d+)\.(json|sock)$/.exec(name);
    if (!m) continue;
    const owner = Number(m[1]);
    if (owner === pid || !isAlive(owner)) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        // raced with another window
      }
    }
  }
}

/** @type {{dispose(): void} | null} */
let teardown = null;

/** @param {vscode.ExtensionContext} context */
async function activate(context) {
  log = vscode.window.createOutputChannel("PDF viewer (vscode-pdf-mcp)");
  context.subscriptions.push(log);
  const pid = process.pid;
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // not ours to change
  }
  removeStale(dir, pid);
  const file = path.join(dir, `${pid}.json`);
  const socket = path.join(dir, `${pid}.sock`);
  const store = new StateStore({ pid, socket, file, onError: (e) => trace(`state write failed: ${e}`) });
  const viewer = new Viewer(context, store, pid);

  const folders = () => (vscode.workspace.workspaceFolders || [])
    .filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath);
  store.setFocused(vscode.window.state.focused);
  store.setWorkspaceFolders(folders());

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, viewer, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.onDidChangeWindowState((s) => store.setFocused(s.focused)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => store.setWorkspaceFolders(folders())),
    vscode.commands.registerCommand("vscodePdfMcp.openExternal", (/** @type {unknown} */ arg) => {
      const uri = arg instanceof vscode.Uri ? arg : viewer.pick(null)?.uri;
      if (uri) return openExternalViewer(uri);
    }),
  );

  /** @type {import("node:net").Server | null} */
  let server = null;
  try {
    server = await ipc.serve(socket, (req) => viewer.handle(req));
  } catch (e) {
    trace(`cannot listen on ${socket}: ${e instanceof Error ? e.message : e}`);
  }
  store.flush();
  trace(`window ${pid}: state ${file}`);

  teardown = {
    dispose() {
      store.dispose();
      if (server) ipc.close(server, socket);
      for (const f of [file, socket]) {
        try {
          fs.unlinkSync(f);
        } catch {
          // gone
        }
      }
    },
  };
  context.subscriptions.push(teardown);
  return { viewer, store, stateFile: file, socket };
}

function deactivate() {
  teardown?.dispose();
  teardown = null;
}

module.exports = { activate, deactivate, VIEW_TYPE };
