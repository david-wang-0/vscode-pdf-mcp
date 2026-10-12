// @ts-check
/** The MCP server over stdio, driven by the SDK client against a fake runtime dir. */
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const ipc = require("../extension/ipc");
const { makeRuntime, makeStubs } = require("./helpers/fixtures");

const SERVER = path.resolve(__dirname, "../mcp/server.js");
const NO_WINDOW = "no VS Code window with a PDF open";

const r = makeRuntime();
const stubs = makeStubs(["wl-paste", "xclip"], { stdout: "from the clipboard" });
const docDir = fs.mkdtempSync(path.join(os.tmpdir(), "vpdf-mcpdoc-"));
const pdf = path.join(docDir, "paper.pdf");
fs.writeFileSync(pdf, "%PDF-1.4\n");
fs.writeFileSync(path.join(r.rt, "wayland-0"), ""); // C5: WAYLAND_DISPLAY comes from here
/** @type {Client} */
let client;
/** @type {import("node:net").Server} */
let ext;
/** @type {any[]} */
const requests = [];
const socket = path.join(r.dir, `${process.pid}.sock`);

/** @param {any} panels */
function setWindow(panels) {
  fs.rmSync(path.join(r.dir, `${process.pid}.json`), { force: true });
  if (panels) r.window({ focused: true, focusedAt: 1, workspaceFolders: [docDir], panels, socket });
}

/** @param {string} name @param {Record<string, unknown>} [args] */
async function call(name, args = {}) {
  return /** @type {any} */ (await client.callTool({ name, arguments: args }));
}

/** @param {any} res */
const textOf = (res) => res.content.map((/** @type {any} */ c) => c.text).join("");

before(async () => {
  ext = await ipc.serve(socket, (req) => {
    requests.push(req);
    if (req.op !== "goto") return { ok: false, error: "unexpected" };
    if (req.path.endsWith("broken.pdf")) return { ok: false, error: `cannot open ${req.path}` };
    return { ok: true, entry: { viewer: "vscode", window: `${process.pid}:1`, path: req.path, page: req.page, pages: 12, active: true } };
  });
  // A minimal environment, as MCP clients give: no WAYLAND_DISPLAY, no DBUS address.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { PATH: stubs.bin, XDG_RUNTIME_DIR: r.rt, HOME: os.homedir() },
    stderr: "pipe",
  });
  client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  if (ext) ipc.close(ext, socket);
  r.cleanup();
  stubs.cleanup();
  fs.rmSync(docDir, { recursive: true, force: true });
});

test("C4: the server offers viewer_state, get_selection and goto only (no reload, no writing)", async () => {
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ["get_selection", "goto", "viewer_state"]);
  assert.equal(byName.viewer_state.title, "VS Code PDF: open documents and pages");
  assert.equal(byName.get_selection.title, "VS Code PDF: selection");
  assert.equal(byName.goto.title, "VS Code PDF: show a page to the user");
  assert.equal(byName.viewer_state.annotations?.readOnlyHint, true);
  assert.equal(byName.get_selection.annotations?.readOnlyHint, true);
  assert.equal(byName.goto.annotations?.readOnlyHint, false);
  assert.deepEqual(byName.goto.inputSchema.required, ["page"]);
});

test("mcp: server name and instructions (pairs with pdf-reader-writer-mcp; goto only on request)", () => {
  assert.equal(client.getServerVersion()?.name, "vscode-pdf");
  const instructions = client.getInstructions() || "";
  assert.match(instructions, /pdf-reader-writer-mcp/);
  assert.match(instructions, /goto\s+only when the user asks/);
});

test("C1: viewer_state over MCP: the error is a tool error with the message verbatim", async () => {
  setWindow(null);
  let res = await call("viewer_state");
  assert.equal(res.isError, true);
  assert.equal(textOf(res), `${NO_WINDOW} (no VS Code window is running the vscode-pdf-mcp extension)`);
  setWindow([]);
  res = await call("viewer_state");
  assert.equal(res.isError, true);
  assert.equal(textOf(res), NO_WINDOW);
});

test("C1: viewer_state over MCP returns the entries as JSON, active first", async () => {
  setWindow([
    { id: "1", path: "/p/other.pdf", page: 2, pages: 3, lastActiveAt: 5 },
    { id: "2", path: pdf, page: 4, pages: 12, active: true },
  ]);
  const res = await call("viewer_state");
  assert.ok(!res.isError);
  const list = JSON.parse(textOf(res));
  assert.deepEqual(list, [
    { viewer: "vscode", window: `${process.pid}:2`, path: pdf, page: 4, pages: 12, active: true },
    { viewer: "vscode", window: `${process.pid}:1`, path: "/p/other.pdf", page: 2, pages: 3, active: false },
  ]);
  assert.deepEqual(res.structuredContent, { result: list });
});

test("C2: get_selection over MCP: primary, clipboard (C5-filled env, unattributed) and a bad source", async () => {
  setWindow([{ id: "1", path: pdf, page: 4, pages: 12, active: true, selection: { text: "timed automata", page: 3 } }]);
  let res = await call("get_selection");
  assert.deepEqual(JSON.parse(textOf(res)), { text: "timed automata", source: "primary", viewer: "vscode", path: pdf, page: 3 });
  assert.deepEqual(stubs.calls(), [], "primary never runs a clipboard tool");

  res = await call("get_selection", { source: "clipboard" });
  assert.deepEqual(JSON.parse(textOf(res)), { text: "from the clipboard", source: "clipboard" });
  assert.deepEqual(stubs.calls(), [{ argv: ["wl-paste", "--no-newline"], wayland: "wayland-0" }]);

  res = await call("get_selection", { source: "secondary" });
  assert.equal(res.isError, true);
  assert.equal(textOf(res), "source must be 'primary' or 'clipboard'");
});

test("C3: goto over MCP: moves via the extension socket and returns the entry", async () => {
  setWindow([{ id: "1", path: pdf, page: 1, pages: 12, active: true }]);
  requests.length = 0;
  const res = await call("goto", { page: 7 });
  assert.ok(!res.isError, textOf(res));
  assert.deepEqual(requests, [{ op: "goto", path: pdf, page: 7 }]);
  assert.equal(JSON.parse(textOf(res)).page, 7);
  assert.equal(res.structuredContent.page, 7);
});

test("C3: goto over MCP: error messages verbatim with isError", async () => {
  setWindow([{ id: "1", path: pdf, page: 1, pages: 12, active: true }]);
  let res = await call("goto", { page: 13 });
  assert.equal(res.isError, true);
  assert.equal(textOf(res), "page 13 outside 1-12");
  const missing = path.join(docDir, "missing.pdf");
  res = await call("goto", { page: 1, path: missing });
  assert.equal(res.isError, true);
  assert.equal(textOf(res), `no such file: ${missing}`);
  const broken = path.join(docDir, "broken.pdf");
  fs.writeFileSync(broken, "not a pdf");
  res = await call("goto", { page: 99, path: broken });
  assert.equal(res.isError, true);
  assert.equal(textOf(res), `cannot open ${broken}`);
  setWindow([]);
  res = await call("goto", { page: 1 });
  assert.equal(res.isError, true);
  assert.equal(textOf(res), NO_WINDOW);
});
