// @ts-check
/** CONTRACT.md clauses C1-C8, one or more tests each, named "C<N>: ...". */
"use strict";

const { test, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const backend = require("../lib/backend");
const { ensureSessionEnv, runtimeDir, stateDir } = require("../lib/runtime");
const { hookOutput, relativeToCwd, within } = require("../lib/hook");
const ipc = require("../extension/ipc");
const { deadPid, livePid, killLive, makeRuntime, makeStubs } = require("./helpers/fixtures");

const HOOK = path.resolve(__dirname, "../bin/hook.js");
const NO_WINDOW = "no VS Code window with a PDF open";

/** @type {(() => void)[]} */
const cleanups = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
after(killLive);

function rt() {
  const r = makeRuntime();
  cleanups.push(r.cleanup);
  return r;
}

/** A real file to point panels at (goto checks existence). */
function pdfFile(name = "paper.pdf") {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vpdf-doc-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  const p = path.join(d, name);
  fs.writeFileSync(p, "%PDF-1.4\n");
  return p;
}

/**
 * A fake extension socket built from extension/ipc.js; records requests.
 * @param {string} socket @param {(req: any) => any} [reply]
 */
async function fakeExtension(socket, reply) {
  /** @type {any[]} */
  const requests = [];
  const server = await ipc.serve(socket, async (req) => {
    requests.push(req);
    if (reply) return reply(req);
    return { ok: true, entry: { viewer: "vscode", window: "x:1", path: req.path, page: req.page, pages: 10, active: true } };
  });
  cleanups.push(() => ipc.close(server, socket));
  return requests;
}

// ---- C1 -------------------------------------------------------------------------------

test("C1: entries list the active entry first, with active: true on exactly that one", () => {
  const r = rt();
  r.window({
    focused: true, focusedAt: 100,
    panels: [
      { id: "1", path: "/p/a.pdf", page: 2, pages: 9, lastActiveAt: 50 },
      { id: "2", path: "/p/b.pdf", page: 4, pages: 7, active: true, lastActiveAt: 40 },
      { id: "3", path: "/p/c.pdf", page: 1, pages: 3, lastActiveAt: 60 },
    ],
  });
  const list = backend.viewerState({ dir: r.dir });
  assert.deepEqual(list[0], { viewer: "vscode", window: `${process.pid}:2`, path: "/p/b.pdf", page: 4, pages: 7, active: true });
  assert.equal(list.filter((e) => e.active).length, 1);
  assert.deepEqual(list.map((e) => e.path), ["/p/b.pdf", "/p/c.pdf", "/p/a.pdf"]);
});

test("C1: the active entry is the active tab of the most recently focused window", () => {
  const r = rt();
  const other = livePid();
  r.window({ pid: other, focusedAt: 200, panels: [{ id: "7", path: "/w2/x.pdf", active: true, lastActiveAt: 1 }] });
  r.window({ focusedAt: 100, panels: [{ id: "1", path: "/w1/y.pdf", active: true, lastActiveAt: 999 }] });
  const list = backend.viewerState({ dir: r.dir });
  assert.equal(list[0].path, "/w2/x.pdf");
  assert.equal(list[0].window, `${other}:7`);
  assert.deepEqual(list.map((e) => e.active), [true, false]);
});

test("C1: a currently focused window wins even with an older focusedAt", () => {
  const r = rt();
  r.window({ pid: livePid(), focused: false, focusedAt: 500, panels: [{ path: "/a.pdf", active: true }] });
  r.window({ focused: true, focusedAt: 10, panels: [{ path: "/b.pdf", active: true }] });
  assert.equal(backend.viewerState({ dir: r.dir })[0].path, "/b.pdf");
});

test("C1: a window without an active PDF tab is skipped for one that has one", () => {
  const r = rt();
  r.window({ pid: livePid(), focusedAt: 900, panels: [{ path: "/recent-window.pdf", lastActiveAt: 899 }] });
  r.window({ focusedAt: 100, panels: [{ path: "/active-tab.pdf", active: true, lastActiveAt: 5 }] });
  assert.equal(backend.viewerState({ dir: r.dir })[0].path, "/active-tab.pdf");
});

test("C1: with no PDF tab active anywhere, the most recently active tab is the active entry", () => {
  const r = rt();
  r.window({ pid: livePid(), focusedAt: 900, panels: [{ path: "/older.pdf", lastActiveAt: 10 }] });
  r.window({ focusedAt: 100, panels: [{ path: "/newer.pdf", lastActiveAt: 20 }, { path: "/oldest.pdf", lastActiveAt: 5 }] });
  const list = backend.viewerState({ dir: r.dir });
  assert.deepEqual(list.map((e) => [e.path, e.active]), [["/newer.pdf", true], ["/older.pdf", false], ["/oldest.pdf", false]]);
});

test("C1: state files of dead pids, unparsable files and other versions are ignored", () => {
  const r = rt();
  r.window({ pid: deadPid(), focused: true, focusedAt: 999, panels: [{ path: "/dead.pdf", active: true }] });
  r.raw("12345.json", "{not json");
  r.raw("23456.json", JSON.stringify({ version: 2, pid: process.pid, panels: [{ path: "/v2.pdf", active: true }] }));
  r.raw("notes.txt", "x");
  r.window({ focusedAt: 1, panels: [{ path: "/live.pdf" }] });
  assert.deepEqual(backend.viewerState({ dir: r.dir }).map((e) => e.path), ["/live.pdf"]);
});

test("C1: nothing open raises 'no VS Code window with a PDF open'", () => {
  const r = rt();
  r.window({ focused: true, panels: [] });
  assert.throws(() => backend.viewerState({ dir: r.dir }), { message: NO_WINDOW });
});

test("C1: VS Code not running gives the same message, with the cause in brackets", () => {
  const r = rt();
  r.window({ pid: deadPid(), panels: [{ path: "/x.pdf", active: true }] });
  assert.throws(() => backend.viewerState({ dir: r.dir }), (e) => {
    assert.ok(e instanceof Error);
    assert.ok(e.message.startsWith(NO_WINDOW));
    assert.equal(e.message, `${NO_WINDOW} (no VS Code window is running the vscode-pdf-mcp extension)`);
    return true;
  });
  assert.throws(() => backend.viewerState({ dir: path.join(r.rt, "missing") }), { message: /^no VS Code window with a PDF open/ });
});

// ---- C2 -------------------------------------------------------------------------------

test("C2: primary is the text selected in the active PDF tab, with its path and the selection's page", () => {
  const r = rt();
  r.window({ focused: true, panels: [
    { path: "/p/a.pdf", page: 5, active: true, selection: { text: "timed automata", page: 4 } },
  ] });
  assert.deepEqual(backend.getSelection("primary", { dir: r.dir }),
    { text: "timed automata", source: "primary", viewer: "vscode", path: "/p/a.pdf", page: 4 });
  assert.deepEqual(backend.getSelection(undefined, { dir: r.dir }).source, "primary");
});

test("C2: nothing selected is text \"\" without attribution, not an error", () => {
  const r = rt();
  r.window({ focused: true, panels: [{ path: "/p/a.pdf", active: true, selection: null }] });
  assert.deepEqual(backend.getSelection("primary", { dir: r.dir }), { text: "", source: "primary" });
  const empty = rt();
  assert.deepEqual(backend.getSelection("primary", { dir: empty.dir }), { text: "", source: "primary" });
});

test("C2: primary comes from the active entry only, never another tab's selection", () => {
  const r = rt();
  r.window({ focused: true, panels: [
    { path: "/p/a.pdf", active: true, selection: null },
    { path: "/p/b.pdf", selection: { text: "stale", page: 1 } },
  ] });
  assert.equal(backend.getSelection("primary", { dir: r.dir }).text, "");
});

test("C2: primary never reads the system primary selection", () => {
  const r = rt();
  const s = makeStubs(["wl-paste", "xclip", "xsel"]);
  cleanups.push(s.cleanup);
  r.window({ focused: true, panels: [{ path: "/p/a.pdf", active: true }] });
  const env = { PATH: s.bin, WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: r.rt };
  assert.deepEqual(backend.getSelection("primary", { dir: r.dir, env }), { text: "", source: "primary" });
  assert.deepEqual(s.calls(), []);
});

for (const [name, tools, wayland, argv] of /** @type {[string, string[], boolean, string[]][]} */ ([
  ["wl-paste on Wayland", ["wl-paste", "xclip", "xsel"], true, ["wl-paste", "--no-newline"]],
  ["xclip on X11", ["wl-paste", "xclip", "xsel"], false, ["xclip", "-o", "-selection", "clipboard"]],
  ["xclip when Wayland has no wl-paste", ["xclip"], true, ["xclip", "-o", "-selection", "clipboard"]],
  ["xsel without xclip", ["xsel"], false, ["xsel", "-o", "--clipboard"]],
])) {
  test(`C2: clipboard is read with ${name} and never attributed`, () => {
    const r = rt();
    const s = makeStubs(tools, { stdout: "copied text" });
    cleanups.push(s.cleanup);
    r.window({ focused: true, panels: [{ path: "/p/a.pdf", active: true, selection: { text: "sel", page: 1 } }] });
    /** @type {NodeJS.ProcessEnv} */
    const env = { PATH: s.bin, XDG_RUNTIME_DIR: r.rt, DBUS_SESSION_BUS_ADDRESS: "x" };
    if (wayland) env.WAYLAND_DISPLAY = "wayland-0";
    assert.deepEqual(backend.getSelection("clipboard", { dir: r.dir, env }), { text: "copied text", source: "clipboard" });
    assert.deepEqual(s.calls().map((c) => c.argv), [argv]);
  });
}

test("C2: the system primary selection argv mirrors okular-mcp (wl-paste --primary, xclip, xsel)", () => {
  for (const [tools, wayland, argv] of /** @type {[string[], boolean, string[]][]} */ ([
    [["wl-paste"], true, ["wl-paste", "--primary", "--no-newline"]],
    [["xclip"], false, ["xclip", "-o", "-selection", "primary"]],
    [["xsel"], false, ["xsel", "-o", "--primary"]],
  ])) {
    const s = makeStubs(tools);
    cleanups.push(s.cleanup);
    /** @type {NodeJS.ProcessEnv} */
    const env = { PATH: s.bin, XDG_RUNTIME_DIR: "/nonexistent" };
    if (wayland) env.WAYLAND_DISPLAY = "wayland-0";
    assert.equal(backend.readSystemSelection("primary", env), "stub text");
    assert.deepEqual(s.calls().map((c) => c.argv), [argv]);
  }
});

test("C2: an empty clipboard is \"\", other tool failures are errors", () => {
  const empty = makeStubs(["xclip"], { rc: 1, stderr: "Error: target STRING not available, no selection", stdout: "junk" });
  cleanups.push(empty.cleanup);
  assert.equal(backend.readSystemSelection("clipboard", { PATH: empty.bin, XDG_RUNTIME_DIR: "/nonexistent" }), "");
  const bad = makeStubs(["xclip"], { rc: 1, stderr: "Can't open display" });
  cleanups.push(bad.cleanup);
  assert.throws(() => backend.readSystemSelection("clipboard", { PATH: bad.bin, XDG_RUNTIME_DIR: "/nonexistent" }),
    { message: "xclip -o -selection clipboard failed: Can't open display" });
  const none = makeStubs([]);
  cleanups.push(none.cleanup);
  assert.throws(() => backend.readSystemSelection("clipboard", { PATH: none.bin, XDG_RUNTIME_DIR: "/nonexistent" }),
    { message: "no clipboard tool found: install wl-clipboard (Wayland) or xclip/xsel (X11)" });
});

test("C2: each tool's nothing-selected message is \"\", whatever it printed on stdout", () => {
  for (const stderr of ["Nothing is copied", "Error: No selection", "xclip: no selection\n", "Error: target STRING not available, no selection"]) {
    const s = makeStubs(["xclip"], { rc: 1, stderr, stdout: "junk" });
    cleanups.push(s.cleanup);
    assert.equal(backend.readSystemSelection("clipboard", { PATH: s.bin, XDG_RUNTIME_DIR: "/nonexistent" }), "", stderr);
  }
});

test("C2: the clipboard tool's output is returned verbatim (whitespace and newlines kept)", () => {
  const s = makeStubs(["xclip"], { stdout: "  two\nlines \n" });
  cleanups.push(s.cleanup);
  assert.equal(backend.readSystemSelection("clipboard", { PATH: s.bin, XDG_RUNTIME_DIR: "/nonexistent" }), "  two\nlines \n");
});

test("C2: a clipboard tool that hangs is an error '<tool> timed out', after 5 s by default", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "vpdf-bin-"));
  cleanups.push(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, "xclip"), "#!/bin/sh\nexec sleep 10\n", { mode: 0o755 });
  const t0 = Date.now();
  assert.throws(() => backend.readSystemSelection("clipboard", { PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: "/nonexistent" }, { timeoutMs: 300 }),
    { message: "xclip timed out" });
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(backend.SELECTION_TIMEOUT_MS, 5000);
});

test("C2: a clipboard tool that cannot be started is an error naming it", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "vpdf-bin-"));
  cleanups.push(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, "xsel"), "#!/nonexistent/interpreter\n", { mode: 0o755 });
  assert.throws(() => backend.readSystemSelection("primary", { PATH: bin, XDG_RUNTIME_DIR: "/nonexistent" }),
    (/** @type {any} */ e) => e instanceof backend.ViewerError && e.message.startsWith("xsel -o --primary failed: "));
});

test("C2: any other source raises 'source must be 'primary' or 'clipboard'' before running anything", () => {
  const r = rt();
  const s = makeStubs(["wl-paste", "xclip", "xsel"]);
  cleanups.push(s.cleanup);
  for (const source of ["secondary", "", "PRIMARY"]) {
    assert.throws(() => backend.getSelection(source, { dir: r.dir, env: { PATH: s.bin } }),
      { message: "source must be 'primary' or 'clipboard'" });
  }
  assert.deepEqual(s.calls(), []);
});

test("C2: tex lists the selection's SyncTeX source lines per file, in document order", () => {
  const r = rt();
  const tex = [{ file: "/proj/main.tex", lines: [12, 14] }, { file: "/proj/chapters/one.tex", lines: [3, 3] }];
  r.window({ focused: true, panels: [{ path: "/proj/main.pdf", active: true, selection: { text: "some words", page: 2, tex } }] });
  assert.deepEqual(backend.getSelection("primary", { dir: r.dir }),
    { text: "some words", source: "primary", viewer: "vscode", path: "/proj/main.pdf", page: 2, tex });
});

test("C2: tex is absent without SyncTeX data, with an empty or malformed list, and with nothing selected", () => {
  for (const tex of [undefined, [], [{ file: "relative.tex", lines: [1, 2] }], [{ file: "/a.tex", lines: [3, 1] }], [{ file: "/a.tex", lines: [0, 1] }], "x"]) {
    const r = rt();
    r.window({ focused: true, panels: [{ path: "/proj/main.pdf", active: true, selection: /** @type {any} */ ({ text: "w", page: 1, tex }) }] });
    const got = backend.getSelection("primary", { dir: r.dir });
    assert.equal("tex" in got, false, JSON.stringify(tex));
    assert.deepEqual(got, { text: "w", source: "primary", viewer: "vscode", path: "/proj/main.pdf", page: 1 });
  }
  const r = rt();
  r.window({ focused: true, panels: [{ path: "/proj/main.pdf", active: true,
    selection: { text: "", page: 1, tex: [{ file: "/proj/main.tex", lines: [1, 1] }] } }] });
  assert.deepEqual(backend.getSelection("primary", { dir: r.dir }), { text: "", source: "primary" });
  // the clipboard is never attributed, so never has tex
  const s = makeStubs(["xclip"], { stdout: "clip" });
  cleanups.push(s.cleanup);
  r.window({ focused: true, panels: [{ path: "/proj/main.pdf", active: true,
    selection: { text: "w", page: 1, tex: [{ file: "/proj/main.tex", lines: [1, 1] }] } }] });
  assert.deepEqual(backend.getSelection("clipboard", { dir: r.dir, env: { PATH: s.bin, XDG_RUNTIME_DIR: "/nonexistent" } }),
    { text: "clip", source: "clipboard" });
});

// ---- C3 -------------------------------------------------------------------------------

test("C3: goto without a path shows the page of the active entry's document and returns its entry", async () => {
  const r = rt();
  const file = pdfFile();
  const w = r.window({ focused: true, panels: [{ path: file, page: 1, pages: 12, active: true }] });
  const requests = await fakeExtension(w.socket);
  const entry = await backend.goto(7, undefined, { dir: r.dir });
  assert.deepEqual(requests, [{ op: "goto", path: file, page: 7 }]);
  assert.equal(entry.page, 7);
  assert.equal(entry.path, file);
});

test("C3: goto sends to the window that has the document open, not the focused one", async () => {
  const r = rt();
  const file = pdfFile();
  const other = livePid();
  const focused = r.window({ focused: true, focusedAt: 50, panels: [{ path: "/elsewhere.pdf", active: true }] });
  const owner = r.window({ pid: other, focusedAt: 10, panels: [{ path: file, pages: 3 }] });
  const toFocused = await fakeExtension(focused.socket);
  const toOwner = await fakeExtension(owner.socket);
  await backend.goto(2, file, { dir: r.dir });
  assert.deepEqual(toFocused, []);
  assert.deepEqual(toOwner, [{ op: "goto", path: file, page: 2 }]);
});

test("C3: a document open nowhere is opened in the most recently focused window", async () => {
  const r = rt();
  const file = pdfFile();
  const recent = r.window({ pid: livePid(), focusedAt: 90, panels: [] });
  const older = r.window({ focusedAt: 10, panels: [{ path: "/x.pdf", active: true }] });
  const toRecent = await fakeExtension(recent.socket);
  const toOlder = await fakeExtension(older.socket);
  const entry = await backend.goto(1, file, { dir: r.dir });
  assert.deepEqual(toRecent, [{ op: "goto", path: file, page: 1 }]);
  assert.deepEqual(toOlder, []);
  assert.equal(entry.page, 1);
});

test("C3: a page out of range raises 'page N outside 1-M' without moving the viewer", async () => {
  const r = rt();
  const file = pdfFile();
  const w = r.window({ focused: true, panels: [{ path: file, pages: 12, active: true }] });
  const requests = await fakeExtension(w.socket);
  await assert.rejects(backend.goto(13, null, { dir: r.dir }), { message: "page 13 outside 1-12" });
  await assert.rejects(backend.goto(0, file, { dir: r.dir }), { message: "page 0 outside 1-12" });
  assert.deepEqual(requests, []);
});

test("C3: a path that does not exist raises 'no such file: <path>'", async () => {
  const r = rt();
  r.window({ focused: true, panels: [{ path: "/x.pdf", active: true }] });
  const missing = path.join(os.tmpdir(), "vpdf-definitely-missing", "paper.pdf");
  await assert.rejects(backend.goto(1, missing, { dir: r.dir }), { message: `no such file: ${missing}` });
});

test("C3: 'no such file' is raised before any window is asked, also for a directory", async () => {
  const r = rt();
  const file = pdfFile();
  const w = r.window({ focused: true, panels: [{ path: file, active: true }] });
  const requests = await fakeExtension(w.socket);
  const missing = path.join(path.dirname(file), "gone.pdf");
  await assert.rejects(backend.goto(1, missing, { dir: r.dir }), { message: `no such file: ${missing}` });
  const folder = path.dirname(file);
  await assert.rejects(backend.goto(1, folder, { dir: r.dir }), { message: `no such file: ${folder}` });
  assert.deepEqual(requests, []);
});

test("C3: a relative path is taken from the current directory and matches the open document", async (t) => {
  const r = rt();
  const file = pdfFile();
  const other = livePid();
  const focused = r.window({ focused: true, focusedAt: 50, panels: [{ path: "/elsewhere.pdf", active: true }] });
  const owner = r.window({ pid: other, focusedAt: 10, panels: [{ path: file, pages: 3 }] });
  const toFocused = await fakeExtension(focused.socket);
  const toOwner = await fakeExtension(owner.socket);
  const cwd = process.cwd();
  process.chdir(path.dirname(file));
  t.after(() => process.chdir(cwd));
  await assert.rejects(backend.goto(4, path.basename(file), { dir: r.dir }), { message: "page 4 outside 1-3" });
  await backend.goto(2, `./${path.basename(file)}`, { dir: r.dir });
  assert.deepEqual(toOwner, [{ op: "goto", path: file, page: 2 }]);
  assert.deepEqual(toFocused, []);
});

test("C3: a page that is not an integer is refused before any window is asked", async () => {
  const r = rt();
  const file = pdfFile();
  const w = r.window({ focused: true, panels: [{ path: file, active: true }] });
  const requests = await fakeExtension(w.socket);
  for (const page of [1.5, NaN, "2"]) {
    await assert.rejects(backend.goto(/** @type {any} */ (page), file, { dir: r.dir }), { message: `page must be an integer, got ${page}` });
  }
  assert.deepEqual(requests, []);
});

test("C3: a window that answers with nonsense or hangs up is an error, not a hang", async () => {
  const r = rt();
  const file = pdfFile();
  const w = r.window({ focused: true, panels: [{ path: file, active: true }] });
  const raw = net.createServer((c) => {
    c.once("data", () => (fs.existsSync(path.join(r.rt, "hangup")) ? c.end() : c.end("not json\n")));
  });
  await new Promise((resolve) => raw.listen(w.socket, () => resolve(undefined)));
  cleanups.push(() => raw.close());
  await assert.rejects(backend.goto(1, null, { dir: r.dir }), { message: "bad response from the VS Code extension" });
  fs.writeFileSync(path.join(r.rt, "hangup"), "");
  await assert.rejects(backend.goto(1, null, { dir: r.dir }), { message: "the VS Code extension closed the connection without answering" });
  const silent = rt();
  const gone = silent.window({ focused: true, panels: [{ path: file, active: true }] });
  await assert.rejects(backend.goto(1, null, { dir: silent.dir }), { message: new RegExp(`^cannot reach VS Code at ${gone.socket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `) });
});

test("C3: without a path and nothing open, goto raises C1's message", async () => {
  const r = rt();
  r.window({ focused: true, panels: [] });
  await assert.rejects(backend.goto(1, undefined, { dir: r.dir }), { message: NO_WINDOW });
  const none = rt();
  await assert.rejects(backend.goto(1, null, { dir: none.dir }), { message: /^no VS Code window with a PDF open/ });
});

test("C3: 'cannot open <path>' from the viewer is passed through verbatim", async () => {
  const r = rt();
  const file = pdfFile("broken.pdf");
  const w = r.window({ focused: true, panels: [] });
  await fakeExtension(w.socket, (req) => ({ ok: false, error: `cannot open ${req.path}` }));
  await assert.rejects(backend.goto(99, file, { dir: r.dir }), { message: `cannot open ${file}` });
});

test("C3: 'cannot open' is checked before the page range for a tab that failed to load", async () => {
  const r = rt();
  const file = pdfFile("broken.pdf");
  // a tab whose load failed reports no page count; the server must not invent a range error
  const w = r.window({ focused: true, panels: [{ path: file, page: 0, pages: 0, active: true }] });
  const requests = await fakeExtension(w.socket, (req) => ({ ok: false, error: `cannot open ${req.path}` }));
  await assert.rejects(backend.goto(5, file, { dir: r.dir }), { message: `cannot open ${file}` });
  assert.equal(requests.length, 1);
});

test("C3: paths are compared by realpath", async () => {
  const r = rt();
  const file = pdfFile();
  const link = path.join(path.dirname(file), "link.pdf");
  fs.symlinkSync(file, link);
  const other = livePid();
  const focused = r.window({ focused: true, focusedAt: 50, panels: [{ path: "/elsewhere.pdf", active: true }] });
  const owner = r.window({ pid: other, focusedAt: 10, panels: [{ path: file, pages: 3 }] });
  const toFocused = await fakeExtension(focused.socket);
  const toOwner = await fakeExtension(owner.socket);
  await assert.rejects(backend.goto(4, link, { dir: r.dir }), { message: "page 4 outside 1-3" });
  await backend.goto(3, link, { dir: r.dir });
  assert.deepEqual(toFocused, []);
  assert.equal(toOwner.length, 1);
});

test("C3: a window that does not answer is an error, not a hang", async () => {
  const r = rt();
  const file = pdfFile();
  const w = r.window({ focused: true, panels: [{ path: file, active: true }] });
  await fakeExtension(w.socket, () => new Promise(() => {}));
  await assert.rejects(backend.goto(1, null, { dir: r.dir, timeoutMs: 300 }), { message: "VS Code did not answer within 0.3 s" });
});

// ---- C4 -------------------------------------------------------------------------------

test("C4: the backend never writes to the PDF (goto, selection and state leave it untouched)", async () => {
  const r = rt();
  const file = pdfFile();
  const before = fs.readFileSync(file);
  const mtime = fs.statSync(file).mtimeMs;
  const w = r.window({ focused: true, panels: [{ path: file, active: true, selection: { text: "x", page: 1 } }] });
  await fakeExtension(w.socket);
  backend.viewerState({ dir: r.dir });
  backend.getSelection("primary", { dir: r.dir });
  await backend.goto(2, file, { dir: r.dir });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
});

// (The tool list, without a reload or write tool, is pinned in mcp.test.js; re-rendering
// on change is checked by test/webview/run.js and the integration test.)

// ---- C5 -------------------------------------------------------------------------------

test("C5: XDG_RUNTIME_DIR falls back to /run/user/<uid>", () => {
  assert.equal(runtimeDir({}), `/run/user/${process.getuid?.()}`);
  assert.equal(runtimeDir({ XDG_RUNTIME_DIR: "/x" }), "/x");
  assert.equal(stateDir({ XDG_RUNTIME_DIR: "/x" }), "/x/vscode-pdf-mcp");
  /** @type {NodeJS.ProcessEnv} */
  const env = { DBUS_SESSION_BUS_ADDRESS: "a", WAYLAND_DISPLAY: "b" };
  ensureSessionEnv(env);
  assert.equal(env.XDG_RUNTIME_DIR, `/run/user/${process.getuid?.()}`);
});

test("C5: DBUS_SESSION_BUS_ADDRESS and WAYLAND_DISPLAY are filled from the runtime dir, never overwritten", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vpdf-c5-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  /** @type {NodeJS.ProcessEnv} */
  let env = { XDG_RUNTIME_DIR: dir };
  ensureSessionEnv(env);
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, undefined);
  assert.equal(env.WAYLAND_DISPLAY, undefined);
  fs.writeFileSync(path.join(dir, "bus"), "");
  fs.writeFileSync(path.join(dir, "wayland-1"), "");
  ensureSessionEnv(env);
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, `unix:path=${dir}/bus`);
  assert.equal(env.WAYLAND_DISPLAY, "wayland-1");
  fs.writeFileSync(path.join(dir, "wayland-0"), "");
  env = { XDG_RUNTIME_DIR: dir };
  ensureSessionEnv(env);
  assert.equal(env.WAYLAND_DISPLAY, "wayland-0");
  env = { XDG_RUNTIME_DIR: dir, WAYLAND_DISPLAY: "wayland-7", DBUS_SESSION_BUS_ADDRESS: "unix:path=/elsewhere" };
  ensureSessionEnv(env);
  assert.equal(env.WAYLAND_DISPLAY, "wayland-7");
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/elsewhere");
});

test("C5: the environment is filled before the clipboard tool runs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vpdf-c5-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "wayland-0"), "");
  const s = makeStubs(["wl-paste", "xclip"]);
  cleanups.push(s.cleanup);
  /** @type {NodeJS.ProcessEnv} */
  const env = { PATH: s.bin, XDG_RUNTIME_DIR: dir };
  backend.readSystemSelection("clipboard", env);
  assert.deepEqual(s.calls(), [{ argv: ["wl-paste", "--no-newline"], wayland: "wayland-0" }]);
});

// ---- C6 -------------------------------------------------------------------------------

/**
 * Run the real bin/hook.js.
 * @param {string | Buffer} input @param {NodeJS.ProcessEnv} env
 */
function runHook(input, env) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HOOK], { input, env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 5000 });
  return { ...r, ms: Date.now() - t0 };
}

test("C6: the hook exits 0 and prints nothing on garbage, empty or non-object input", () => {
  const r = rt();
  r.window({ focused: true, panels: [{ path: path.join(r.rt, "a.pdf"), active: true }] });
  for (const input of ["", "garbage{", "null", "[1,2]", '"str"', "{}", '{"cwd": 42}', Buffer.from([0xff, 0xfe, 0])]) {
    const out = runHook(input, { XDG_RUNTIME_DIR: r.rt });
    assert.equal(out.status, 0, `status for ${String(input)}`);
    assert.equal(out.stdout, "");
  }
});

test("C6: the hook exits 0 on internal errors (unreadable state dir)", () => {
  const r = rt();
  fs.rmSync(r.dir, { recursive: true });
  fs.writeFileSync(r.dir, "not a directory");
  const out = runHook(JSON.stringify({ cwd: r.rt }), { XDG_RUNTIME_DIR: r.rt });
  assert.equal(out.status, 0);
  assert.equal(out.stdout, "");
});

test("C6: the hook exits 0 silently on events without a usable cwd (empty, null, relative, cut-off JSON)", () => {
  const r = rt();
  const proj = path.join(r.rt, "proj");
  r.window({ focused: true, workspaceFolders: [proj], panels: [{ path: path.join(proj, "a.pdf"), active: true }] });
  assert.notEqual(runHook(JSON.stringify({ cwd: proj }), { XDG_RUNTIME_DIR: r.rt }).stdout, "", "control: a good event prints");
  for (const input of ['{"cwd": ""}', '{"cwd": null}', '{"cwd": "proj"}', `{"cwd": ${JSON.stringify(proj)}`, `{"cwd": [${JSON.stringify(proj)}]}`]) {
    const out = runHook(input, { XDG_RUNTIME_DIR: r.rt, PWD: r.rt });
    assert.deepEqual([out.status, out.stdout, out.stderr], [0, "", ""], input);
  }
});

test("C6: the hook exits 0 when its reader has gone (stdout closed: EPIPE)", async () => {
  const r = rt();
  const proj = path.join(r.rt, "proj");
  r.window({ focused: true, panels: [{ path: path.join(proj, "a.pdf"), active: true }] });
  const child = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: r.rt }, stdio: "pipe" });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  // the hook reads stdin to its end before it writes, so its stdout is closed by then
  child.stdout.destroy();
  child.stdin.end(JSON.stringify({ cwd: proj }));
  const [code] = await once(child, "close");
  assert.equal(code, 0, stderr);
  assert.equal(stderr, "");
});

test("C6: a closed stdin, or a terminal on stdin, exits 0 at once and prints nothing", { skip: !backend.which("script", process.env) && "needs script(1)" }, () => {
  const r = rt();
  r.window({ focused: true, workspaceFolders: ["/"], panels: [{ path: "/a.pdf", active: true }] });
  const env = { PATH: process.env.PATH, XDG_RUNTIME_DIR: r.rt };
  const closed = spawnSync("sh", ["-c", 'exec "$0" "$1" <&-', process.execPath, HOOK], { env, encoding: "utf8", timeout: 5000 });
  assert.deepEqual([closed.status, closed.stdout, closed.stderr], [0, "", ""]);
  // under script(1) stdin is a terminal: the hook must not wait for input from it
  const t0 = Date.now();
  const tty = spawnSync("script", ["-qec", `'${process.execPath}' '${HOOK}'`, "/dev/null"], { env, input: "", encoding: "utf8", timeout: 5000 });
  assert.deepEqual([tty.status, tty.stdout, tty.error], [0, "", undefined]);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test("C6: the hook reads only the state files, never a window's socket, so a hung window cannot slow it", async () => {
  const r = rt();
  const proj = path.join(r.rt, "proj");
  const w = r.window({ focused: true, panels: [{ path: path.join(proj, "a.pdf"), active: true }] });
  let connections = 0;
  const server = net.createServer(() => { connections++; }); // accepts, never answers
  await new Promise((resolve) => server.listen(w.socket, () => resolve(undefined)));
  cleanups.push(() => server.close());
  const input = JSON.stringify({ cwd: proj });
  const child = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: r.rt } });
  let stdout = "";
  child.stdout.on("data", (d) => { stdout += d; });
  const t0 = Date.now();
  child.stdin.end(input);
  const [code] = await once(child, "close");
  assert.equal(code, 0);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  assert.match(stdout, /The user is reading .*a\.pdf in VS Code/);
  assert.equal(connections, 0);
});

test("C6: the hook prints exactly one UserPromptSubmit JSON object, well inside a second", () => {
  const r = rt();
  const file = path.join(r.rt, "proj", "paper.pdf");
  r.window({ focused: true, panels: [{ path: file, page: 3, pages: 12, active: true }] });
  const out = runHook(JSON.stringify({ session_id: "s", hook_event_name: "UserPromptSubmit", prompt: "hi", cwd: path.join(r.rt, "proj") }),
    { XDG_RUNTIME_DIR: r.rt });
  assert.equal(out.status, 0);
  assert.ok(out.ms < 1000, `took ${out.ms} ms`);
  const lines = out.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: `The user is reading ${file} in VS Code, page 3 of 12.`,
    },
  });
});

// ---- C7 -------------------------------------------------------------------------------

/** @param {any} panel @param {string} [cwd] */
function hookText(panel, cwd = "/proj") {
  const r = rt();
  r.window({ focused: true, panels: [{ active: true, ...panel }] });
  const out = hookOutput({ cwd }, backend.readStates(r.dir));
  return out === null ? null : JSON.parse(out).hookSpecificOutput.additionalContext;
}

test("C7: the text names path, viewer, page and page count", () => {
  assert.equal(hookText({ path: "/proj/paper.pdf", page: 3, pages: 12 }),
    "The user is reading /proj/paper.pdf in VS Code, page 3 of 12.");
});

test("C7: an attributable selection follows, with the page it starts on", () => {
  assert.equal(hookText({ path: "/proj/paper.pdf", page: 3, pages: 12, selection: { text: "timed automata", page: 2 } }),
    "The user is reading /proj/paper.pdf in VS Code, page 3 of 12.\nSelected text (page 2):\ntimed automata");
});

test("C7: the selection is cut at 2000 characters with ' […]' appended", () => {
  const long = "x".repeat(1999) + "yz";
  assert.equal(hookText({ path: "/proj/a.pdf", page: 1, pages: 1, selection: { text: long, page: 1 } }),
    "The user is reading /proj/a.pdf in VS Code, page 1 of 1.\nSelected text (page 1):\n" + "x".repeat(1999) + "y […]");
  const exact = "y".repeat(2000);
  assert.equal(hookText({ path: "/proj/a.pdf", page: 1, pages: 1, selection: { text: exact, page: 1 } }),
    "The user is reading /proj/a.pdf in VS Code, page 1 of 1.\nSelected text (page 1):\n" + exact);
});

test("C7: an empty selection adds nothing", () => {
  assert.equal(hookText({ path: "/proj/a.pdf", page: 1, pages: 2, selection: { text: "", page: 1 } }),
    "The user is reading /proj/a.pdf in VS Code, page 1 of 2.");
});

test("C7: with tex, one Source line per file after the selection, relative to cwd inside it", () => {
  const tex = [{ file: "/proj/main.tex", lines: [12, 14] }, { file: "/proj/chapters/one.tex", lines: [3, 3] },
    { file: "/elsewhere/macros.tex", lines: [7, 9] }];
  assert.equal(hookText({ path: "/proj/main.pdf", page: 2, pages: 5, selection: { text: "some words", page: 2, tex } }),
    "The user is reading /proj/main.pdf in VS Code, page 2 of 5.\nSelected text (page 2):\nsome words"
    + "\nSource: main.tex:12-14\nSource: chapters/one.tex:3\nSource: /elsewhere/macros.tex:7-9");
});

test("C7: Source paths are absolute when the file is outside cwd, even if the PDF is inside", () => {
  assert.equal(hookText({ path: "/proj/sub/main.pdf", page: 1, pages: 1, selection: { text: "w", page: 1, tex: [{ file: "/proj/main.tex", lines: [2, 2] }] } }, "/proj/sub"),
    "The user is reading /proj/sub/main.pdf in VS Code, page 1 of 1.\nSelected text (page 1):\nw\nSource: /proj/main.tex:2");
});

test("C7: Source lines follow the cut selection", () => {
  const long = "x".repeat(2001);
  assert.equal(hookText({ path: "/proj/a.pdf", page: 1, pages: 1, selection: { text: long, page: 1, tex: [{ file: "/proj/a.tex", lines: [1, 40] }] } }),
    "The user is reading /proj/a.pdf in VS Code, page 1 of 1.\nSelected text (page 1):\n" + "x".repeat(2000) + " […]\nSource: a.tex:1-40");
});

test("C7: without tex there is no Source line, and an empty selection prints none either", () => {
  assert.equal(hookText({ path: "/proj/a.pdf", page: 1, pages: 2, selection: { text: "w", page: 1 } }),
    "The user is reading /proj/a.pdf in VS Code, page 1 of 2.\nSelected text (page 1):\nw");
  assert.equal(hookText({ path: "/proj/a.pdf", page: 1, pages: 2, selection: { text: "", page: 1, tex: [{ file: "/proj/a.tex", lines: [1, 1] }] } }),
    "The user is reading /proj/a.pdf in VS Code, page 1 of 2.");
});

test("C7: the hook binary prints the Source lines", () => {
  const r = rt();
  const proj = path.join(r.rt, "proj");
  r.window({ focused: true, panels: [{ path: path.join(proj, "main.pdf"), page: 1, pages: 3, active: true,
    selection: { text: "w", page: 1, tex: [{ file: path.join(proj, "main.tex"), lines: [5, 6] }] } }] });
  const out = runHook(JSON.stringify({ cwd: proj }), { XDG_RUNTIME_DIR: r.rt });
  assert.equal(out.status, 0);
  assert.match(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, /\nSelected text \(page 1\):\nw\nSource: main\.tex:5-6$/);
});

test("C7: Source paths relative to cwd: normalised, never for a sibling with a common prefix", () => {
  for (const [file, cwd, expected] of [
    ["/p/sec/a.tex", "/p", "sec/a.tex"],
    ["/p/a.tex", "/p/", "a.tex"],
    ["/p/./sec/../a.tex", "/p", "a.tex"],
    ["/q/a.tex", "/p", "/q/a.tex"],
    ["/pq/a.tex", "/p", "/pq/a.tex"],
    ["/p", "/p", "p"],
  ]) assert.equal(relativeToCwd(file, cwd), expected, `${file} from ${cwd}`);
});

test("C7: Source paths relative to cwd after resolving symlinks, either way round", () => {
  const r = rt();
  fs.mkdirSync(path.join(r.rt, "real", "sec"), { recursive: true });
  const tex = path.join(r.rt, "real", "sec", "a.tex");
  fs.writeFileSync(tex, "x");
  fs.symlinkSync(path.join(r.rt, "real"), path.join(r.rt, "link"));
  assert.equal(relativeToCwd(tex, path.join(r.rt, "link")), path.join("sec", "a.tex"));
  assert.equal(relativeToCwd(path.join(r.rt, "link", "sec", "a.tex"), path.join(r.rt, "real")), path.join("sec", "a.tex"));
});

// ---- C8 -------------------------------------------------------------------------------

/** @param {any} w @param {string} cwd */
function hookFor(w, cwd) {
  const r = rt();
  r.window(w);
  return hookOutput({ cwd }, backend.readStates(r.dir));
}

test("C8: a PDF inside cwd is relevant", () => {
  assert.ok(hookFor({ focused: true, panels: [{ path: "/work/proj/docs/a.pdf", active: true }] }, "/work/proj"));
  assert.ok(hookFor({ focused: true, panels: [{ path: "/work/proj/a.pdf", active: true }] }, "/work/proj/"));
});

test("C8: a workspace folder equal to cwd makes any PDF of that window relevant", () => {
  assert.ok(hookFor({ focused: true, workspaceFolders: ["/work/proj"], panels: [{ path: "/papers/a.pdf", active: true }] }, "/work/proj"));
});

test("C8: a workspace folder containing cwd is relevant", () => {
  assert.ok(hookFor({ focused: true, workspaceFolders: ["/work/proj"], panels: [{ path: "/papers/a.pdf", active: true }] }, "/work/proj/sub/dir"));
});

test("C8: a workspace folder inside cwd is relevant", () => {
  assert.ok(hookFor({ focused: true, workspaceFolders: ["/work/proj/paper"], panels: [{ path: "/papers/a.pdf", active: true }] }, "/work/proj"));
});

test("C8: an unrelated PDF and workspace print nothing (no prefix confusion)", () => {
  assert.equal(hookFor({ focused: true, workspaceFolders: ["/work/projX"], panels: [{ path: "/work/projY/a.pdf", active: true }] }, "/work/proj"), null);
  assert.equal(hookFor({ focused: true, workspaceFolders: ["/elsewhere"], panels: [{ path: "/papers/a.pdf", active: true }] }, "/work/proj"), null);
});

test("C8: a cwd below the PDF's directory is not relevant (without a workspace folder)", () => {
  assert.equal(hookFor({ focused: true, panels: [{ path: "/work/papers/a.pdf", active: true }] }, "/work/papers/sub"), null);
  assert.ok(hookFor({ focused: true, panels: [{ path: "/work/papers/a.pdf", active: true }] }, "/work/papers"));
});

test("C8: inside: a trailing slash and / as the directory, never a sibling with a common prefix", () => {
  for (const [inner, outer, expected] of /** @type {[string, string, boolean][]} */ ([
    ["/a/b/c.pdf", "/a/b", true],
    ["/a/b/c.pdf", "/a/b/", true],
    ["/a/b/c.pdf", "/", true],
    ["/a/b", "/a/b", true],
    ["/a/bc/c.pdf", "/a/b", false],
    ["/a/c.pdf", "/a/b", false],
    ["/a/b/../c.pdf", "/a/b", false],
  ])) assert.equal(within(inner, outer), expected, `${inner} in ${outer}`);
});

test("C8: the most-recent fallback is not enough: no tab active means nothing", () => {
  assert.equal(hookFor({ focused: true, workspaceFolders: ["/proj"], panels: [{ path: "/proj/a.pdf", lastActiveAt: 99 }] }, "/proj"), null);
});

test("C8: only the active entry counts, even if another window's tab would be relevant", () => {
  const r = rt();
  r.window({ focused: true, focusedAt: 50, workspaceFolders: ["/other"], panels: [{ path: "/other/a.pdf", active: true }] });
  r.window({ pid: livePid(), focusedAt: 10, workspaceFolders: ["/proj"], panels: [{ path: "/proj/b.pdf", active: true }] });
  assert.equal(hookOutput({ cwd: "/proj" }, backend.readStates(r.dir)), null);
});

test("C8: nothing open or a dead window prints nothing", () => {
  assert.equal(hookFor({ focused: true, panels: [] }, "/proj"), null);
  assert.equal(hookFor({ pid: deadPid(), focused: true, workspaceFolders: ["/proj"], panels: [{ path: "/proj/a.pdf", active: true }] }, "/proj"), null);
});

test("C8: the hook binary applies relevance to the event's cwd", () => {
  const r = rt();
  r.window({ focused: true, workspaceFolders: [path.join(r.rt, "proj")], panels: [{ path: "/papers/a.pdf", active: true }] });
  assert.notEqual(runHook(JSON.stringify({ cwd: path.join(r.rt, "proj", "sub") }), { XDG_RUNTIME_DIR: r.rt }).stdout, "");
  assert.equal(runHook(JSON.stringify({ cwd: path.join(r.rt, "elsewhere") }), { XDG_RUNTIME_DIR: r.rt }).stdout, "");
});

test("C8: relevance also holds through symlinks", () => {
  const r = rt();
  const real = path.join(r.rt, "real-proj");
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(r.rt, "link-proj"));
  r.window({ focused: true, panels: [{ path: path.join(real, "a.pdf"), active: true }] });
  assert.ok(hookOutput({ cwd: path.join(r.rt, "link-proj") }, backend.readStates(r.dir)));
});
