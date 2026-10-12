// @ts-check
/** extension/ipc.js (server) with lib/backend.js `request` (client). */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const ipc = require("../extension/ipc");
const { request } = require("../lib/backend");

/** @param {(req: any) => any} handler */
async function server(handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vpdf-ipc-"));
  const socket = path.join(dir, "1.sock");
  const srv = await ipc.serve(socket, handler);
  return {
    socket,
    close() {
      ipc.close(srv, socket);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Raw client: write `chunks` (with optional end), collect everything until the server closes.
 * @param {string} socket @param {string[]} chunks @param {boolean} [end]
 * @returns {Promise<string>}
 */
function raw(socket, chunks, end = false) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socket);
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d) => (buf += d));
    c.on("end", () => resolve(buf));
    c.on("error", reject);
    c.on("connect", async () => {
      for (const ch of chunks) {
        c.write(ch);
        await new Promise((r) => setImmediate(r));
      }
      if (end) c.end();
    });
  });
}

test("ipc: one newline-terminated JSON response per connection, request may arrive in pieces", async () => {
  const s = await server((req) => ({ ok: true, echo: req }));
  try {
    const out = await raw(s.socket, ['{"op":"pi', 'ng","x":1}\n']);
    assert.equal(out, '{"ok":true,"echo":{"op":"ping","x":1}}\n');
    assert.deepEqual(await request(s.socket, { op: "state" }), { ok: true, echo: { op: "state" } });
  } finally {
    s.close();
  }
});

test("ipc: a request without a trailing newline is handled when the client ends", async () => {
  const s = await server(() => ({ ok: true }));
  try {
    assert.equal(await raw(s.socket, ['{"op":"ping"}'], true), '{"ok":true}\n');
  } finally {
    s.close();
  }
});

test("ipc: bad JSON and a missing op are answered with ok: false", async () => {
  /** @type {any[]} */
  const seen = [];
  const s = await server((req) => (seen.push(req), { ok: true }));
  try {
    assert.deepEqual(JSON.parse(await raw(s.socket, ["{nope\n"])), { ok: false, error: "bad request: invalid JSON" });
    assert.deepEqual(JSON.parse(await raw(s.socket, ['{"x":1}\n'])), { ok: false, error: "bad request: no op" });
    assert.deepEqual(seen, []);
  } finally {
    s.close();
  }
});

test("ipc: handler errors (sync or async) become {ok: false, error}", async () => {
  const s = await server(async (req) => {
    if (req.op === "sync") throw new Error("page 9 outside 1-3");
    await new Promise((r) => setImmediate(r));
    throw new Error("cannot open /x.pdf");
  });
  try {
    assert.deepEqual(await request(s.socket, { op: "sync" }), { ok: false, error: "page 9 outside 1-3" });
    assert.deepEqual(await request(s.socket, { op: "async" }), { ok: false, error: "cannot open /x.pdf" });
  } finally {
    s.close();
  }
});

test("ipc: a stale socket file is replaced, the socket is 0600, close removes it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vpdf-ipc-"));
  const socket = path.join(dir, "2.sock");
  fs.writeFileSync(socket, "stale");
  const srv = await ipc.serve(socket, () => ({ ok: true }));
  try {
    assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
    assert.deepEqual(await request(socket, { op: "ping" }), { ok: true });
  } finally {
    ipc.close(srv, socket);
  }
  assert.equal(fs.existsSync(socket), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ipc: the client reports an unreachable socket and a silent server", async () => {
  await assert.rejects(request("/nonexistent/vpdf.sock", { op: "ping" }), { message: /^cannot reach VS Code at \/nonexistent\/vpdf\.sock/ });
  const s = await server(() => new Promise(() => {}));
  try {
    await assert.rejects(request(s.socket, { op: "ping" }, 200), { message: "VS Code did not answer within 0.2 s" });
  } finally {
    s.close();
  }
});
