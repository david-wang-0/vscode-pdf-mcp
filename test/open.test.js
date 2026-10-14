// @ts-check
/**
 * bin/open.js (vscode-pdf-mcp-open) and the backend's openPdf / synctexForward, against
 * fake extension sockets in a temporary runtime dir: the requests sent, the window
 * chosen, the exit codes and messages.
 */
"use strict";

const { test, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const backend = require("../lib/backend");
const ipc = require("../extension/ipc");
const { parseArgs, main, USAGE } = require("../bin/open");
const { deadPid, livePid, killLive, makeRuntime } = require("./helpers/fixtures");

const OPEN = path.resolve(__dirname, "../bin/open.js");

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

/** A project dir with a PDF and its .tex. */
function project() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vpdf-open-")));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, "main.pdf"), "%PDF-1.4\n");
  fs.writeFileSync(path.join(d, "main.tex"), "\\documentclass{article}\n");
  return { dir: d, pdf: path.join(d, "main.pdf"), tex: path.join(d, "main.tex") };
}

/**
 * A fake extension socket; answers open and synctexForward with an entry.
 * @param {string} socket @param {(req: any) => any} [reply]
 */
async function fakeExtension(socket, reply) {
  /** @type {any[]} */
  const requests = [];
  const server = await ipc.serve(socket, async (req) => {
    requests.push(req);
    if (reply) return reply(req);
    const file = req.op === "open" ? req.path : req.pdf;
    return { ok: true, entry: { viewer: "vscode", window: "x:1", path: file, page: req.op === "open" ? 1 : 4, pages: 9, active: true } };
  });
  cleanups.push(() => ipc.close(server, socket));
  return requests;
}

/** Run bin/open.js. @param {string[]} args @param {string} dir the state dir */
function runOpen(args, dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [OPEN, ...args], { env: { PATH: process.env.PATH, VSCODE_PDF_MCP_DIR: dir } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("open CLI: arguments (LaTeX Workshop's --tex %TEX% --line %LINE% %PDF%), errors are usage errors", () => {
  assert.deepEqual(parseArgs(["/a/b.pdf"]), { pdf: "/a/b.pdf" });
  assert.deepEqual(parseArgs(["--tex", "/a/c.tex", "--line", "12", "/a/b.pdf"]), { pdf: "/a/b.pdf", tex: "/a/c.tex", line: 12 });
  assert.deepEqual(parseArgs(["--tex=/a/c.tex", "--line=3", "--column=5", "/a/b.pdf"]), { pdf: "/a/b.pdf", tex: "/a/c.tex", line: 3, column: 5 });
  assert.deepEqual(parseArgs(["--tex", "/a/c.tex", "--line", "3", "--column", "-1", "/a/b.pdf"]), { pdf: "/a/b.pdf", tex: "/a/c.tex", line: 3 });
  assert.deepEqual(parseArgs(["rel.pdf"]), { pdf: path.resolve("rel.pdf") });
  assert.deepEqual(parseArgs(["--help"]), { help: true });
  for (const bad of [[], ["a.pdf", "b.pdf"], ["--tex", "x.tex", "a.pdf"], ["--tex", "x.tex", "--line", "0", "a.pdf"],
    ["--line", "3", "a.pdf"], ["--frob", "a.pdf"], ["--tex"], ["--tex", "x.tex", "--line", "2", "--column", "x", "a.pdf"]]) {
    assert.ok("error" in parseArgs(bad), JSON.stringify(bad));
  }
});

test("open CLI: the same arguments as okular-mcp-open: any order, --opt=value, -- before an odd name, column 0", () => {
  for (const argv of [["--tex", "m.tex", "--line", "12", "a.pdf"], ["--tex=m.tex", "--line=12", "a.pdf"], ["a.pdf", "--line", "12", "--tex", "m.tex"]]) {
    assert.deepEqual(parseArgs(argv), { pdf: path.resolve("a.pdf"), tex: path.resolve("m.tex"), line: 12 }, JSON.stringify(argv));
  }
  assert.deepEqual(parseArgs(["--", "--odd.pdf"]), { pdf: path.resolve("--odd.pdf") });
  for (const [column, expected] of /** @type {[string, object][]} */ ([["3", { column: 3 }], ["0", { column: 0 }], ["-1", {}]])) {
    assert.deepEqual(parseArgs(["--tex", "/m.tex", "--line", "2", "--column", column, "/a.pdf"]), { pdf: "/a.pdf", tex: "/m.tex", line: 2, ...expected });
  }
  assert.deepEqual(parseArgs(["x.pdf", "-h"]), { help: true });
});

test("open CLI: the error messages, word for word as okular-mcp-open's", () => {
  for (const [argv, error] of /** @type {[string[], string][]} */ ([
    [[], "no PDF given"],
    [["a.pdf", "b.pdf"], "give exactly one PDF"],
    [["--tex"], "--tex needs a value"],
    [["--page", "3", "a.pdf"], "unknown option --page"],
    [["--line", "3", "a.pdf"], "--line and --column need --tex"],
    [["--column", "3", "a.pdf"], "--line and --column need --tex"],
    [["--tex", "m.tex", "a.pdf"], "--tex needs --line <n>, a positive integer"],
    [["--tex", "m.tex", "--line", "0", "a.pdf"], "--tex needs --line <n>, a positive integer"],
    [["--tex", "m.tex", "--line", "x", "a.pdf"], "--tex needs --line <n>, a positive integer"],
    [["--tex", "m.tex", "--line", "2.5", "a.pdf"], "--tex needs --line <n>, a positive integer"],
    [["--tex", "m.tex", "--line", "2", "--column", "x", "a.pdf"], "--column must be an integer"],
  ])) assert.deepEqual(parseArgs(argv), { error }, JSON.stringify(argv));
});

test("open CLI: -h and --help print the usage on stdout and exit 0; bad arguments exit 2 without asking a window", async () => {
  const r = rt();
  const w = r.window({ focused: true, panels: [] });
  const requests = await fakeExtension(w.socket);
  for (const flag of ["-h", "--help"]) {
    const out = /** @type {any} */ (await runOpen(["x.pdf", flag], r.dir));
    assert.deepEqual([out.code, out.stderr], [0, ""]);
    assert.equal(out.stdout, USAGE);
    assert.match(out.stdout, /--column/);
  }
  const out = /** @type {any} */ (await runOpen(["--line", "3", "a.pdf"], r.dir));
  assert.deepEqual([out.code, out.stdout], [2, ""]);
  assert.equal(out.stderr, `vscode-pdf-mcp-open: --line and --column need --tex\n${USAGE}`);
  assert.deepEqual(requests, []);
});

test("open CLI: a forward search into a missing PDF exits 1 without asking a window", async () => {
  const r = rt();
  const p = project();
  const w = r.window({ focused: true, panels: [] });
  const requests = await fakeExtension(w.socket);
  const gone = path.join(p.dir, "gone.pdf");
  const out = /** @type {any} */ (await runOpen(["--tex", p.tex, "--line", "3", gone], r.dir));
  assert.deepEqual([out.code, out.stdout, out.stderr], [1, "", `vscode-pdf-mcp-open: no such file: ${gone}\n`]);
  assert.deepEqual(requests, []);
});

test("open CLI: main() returns the exit code (2 for no arguments, 0 for --help)", async (t) => {
  /** @type {string[]} */
  const written = [];
  t.mock.method(process.stderr, "write", (/** @type {string} */ s) => written.push(s));
  t.mock.method(process.stdout, "write", (/** @type {string} */ s) => written.push(s));
  assert.equal(await main([]), 2);
  assert.equal(await main(["--help"]), 0);
  t.mock.restoreAll();
  assert.deepEqual(written, [`vscode-pdf-mcp-open: no PDF given\n${USAGE}`, USAGE]);
});

test("open CLI: <pdf> sends open to the window that has it, prints the entry, exits 0", async () => {
  const r = rt();
  const p = project();
  const other = livePid();
  const focused = r.window({ focused: true, focusedAt: 90, panels: [{ path: "/x.pdf", active: true }] });
  const owner = r.window({ pid: other, focusedAt: 10, panels: [{ path: p.pdf, pages: 9 }] });
  const toFocused = await fakeExtension(focused.socket);
  const toOwner = await fakeExtension(owner.socket);
  const out = /** @type {any} */ (await runOpen([p.pdf], r.dir));
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.stdout, `${p.pdf}: page 1 of 9\n`);
  assert.deepEqual(toOwner, [{ op: "open", path: p.pdf }]);
  assert.deepEqual(toFocused, []);
});

test("open CLI: --tex --line sends synctexForward, preferring the window whose workspace contains the PDF", async () => {
  const r = rt();
  const p = project();
  const other = livePid();
  const focused = r.window({ focused: true, focusedAt: 90, workspaceFolders: ["/elsewhere"], panels: [] });
  const mine = r.window({ pid: other, focusedAt: 10, workspaceFolders: [p.dir], panels: [] });
  const toFocused = await fakeExtension(focused.socket);
  const toMine = await fakeExtension(mine.socket);
  const out = /** @type {any} */ (await runOpen(["--tex", p.tex, "--line", "7", "--column", "2", p.pdf], r.dir));
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.stdout, `${p.pdf}: page 4 of 9\n`);
  assert.deepEqual(toMine, [{ op: "synctexForward", tex: p.tex, line: 7, column: 2, pdf: p.pdf }]);
  assert.deepEqual(toFocused, []);
});

test("open CLI: otherwise the most recently focused window; a gone window is skipped", async () => {
  const r = rt();
  const p = project();
  const gone = livePid();
  r.window({ pid: gone, focused: true, focusedAt: 99, panels: [] }); // alive pid, but nobody listens
  const older = r.window({ focusedAt: 50, panels: [] });
  const toOlder = await fakeExtension(older.socket);
  const out = /** @type {any} */ (await runOpen([p.pdf], r.dir));
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(toOlder, [{ op: "open", path: p.pdf }]);
});

test("open CLI: no window, an error from the window, a missing file, bad arguments: non-zero with a message", async () => {
  const r = rt();
  const p = project();
  let out = /** @type {any} */ (await runOpen([p.pdf], r.dir));
  assert.equal(out.code, 1);
  assert.equal(out.stderr, "vscode-pdf-mcp-open: no VS Code window is running the vscode-pdf-mcp extension\n");
  r.window({ pid: deadPid(), focused: true, panels: [] });
  out = await runOpen([p.pdf], r.dir);
  assert.equal(out.code, 1, "a dead window does not count");
  const w = r.window({ focused: true, panels: [] });
  await fakeExtension(w.socket, () => ({ ok: false, error: `${p.tex} is not in the SyncTeX data of ${p.pdf}` }));
  out = await runOpen(["--tex", p.tex, "--line", "3", p.pdf], r.dir);
  assert.equal(out.code, 1);
  assert.equal(out.stderr, `vscode-pdf-mcp-open: ${p.tex} is not in the SyncTeX data of ${p.pdf}\n`);
  out = await runOpen([path.join(p.dir, "missing.pdf")], r.dir);
  assert.equal(out.code, 1);
  assert.equal(out.stderr, `vscode-pdf-mcp-open: no such file: ${path.join(p.dir, "missing.pdf")}\n`);
  out = await runOpen(["--line", "3", p.pdf], r.dir);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /^vscode-pdf-mcp-open: --line and --column need --tex\nusage: /);
});

test("open CLI: a window that does not answer is an error after the timeout, not a hang", async () => {
  const r = rt();
  const p = project();
  const w = r.window({ focused: true, panels: [] });
  await fakeExtension(w.socket, () => new Promise(() => {}));
  await assert.rejects(backend.openPdf(p.pdf, { dir: r.dir, timeoutMs: 300 }), { message: "VS Code did not answer within 0.3 s" });
  await assert.rejects(backend.synctexForward({ tex: p.tex, line: 1 }, { dir: r.dir, timeoutMs: 300 }),
    { message: "VS Code did not answer within 0.3 s" });
});

test("backend: synctexForward without a PDF lets the window find it; the window with the .tex in its workspace wins", async () => {
  const r = rt();
  const p = project();
  const other = livePid();
  const focused = r.window({ focused: true, focusedAt: 90, panels: [] });
  const mine = r.window({ pid: other, focusedAt: 10, workspaceFolders: [p.dir], panels: [] });
  await fakeExtension(focused.socket);
  const toMine = await fakeExtension(mine.socket, (req) => ({ ok: true, entry: { path: p.pdf, page: 2, pages: 3 } }));
  const entry = await backend.synctexForward({ tex: p.tex, line: 5 }, { dir: r.dir });
  assert.equal(entry.page, 2);
  assert.deepEqual(toMine, [{ op: "synctexForward", tex: p.tex, line: 5 }]);
  await assert.rejects(backend.synctexForward({ tex: p.tex, line: 0 }, { dir: r.dir }), { message: "line must be a positive integer, got 0" });
});
