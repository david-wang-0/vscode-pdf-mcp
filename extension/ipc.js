// @ts-check
/**
 * The window's unix socket: newline-delimited JSON, one request and one response per
 * connection. The request handler is injected, so this is testable without VS Code.
 */
"use strict";

const fs = require("node:fs");
const net = require("node:net");

/**
 * @callback Handler
 * @param {any} request the parsed request object
 * @returns {Promise<object> | object} the response object (`{ok: true, ...}` or `{ok: false, error}`)
 */

/**
 * Listen on `socketPath` (an existing socket file there is removed first).
 * @param {string} socketPath @param {Handler} handler
 * @param {{maxBytes?: number}} [opts]
 * @returns {Promise<net.Server>}
 */
function serve(socketPath, handler, { maxBytes = 1 << 20 } = {}) {
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // none
  }
  // allowHalfOpen: a client may end its side after the request and still read the reply.
  const server = net.createServer({ allowHalfOpen: true }, (conn) => {
    let buf = "";
    let handled = false;
    conn.setEncoding("utf8");
    /** @param {object} response */
    const reply = (response) => {
      if (!conn.destroyed) conn.end(JSON.stringify(response) + "\n");
    };
    /** @param {string} line */
    const handle = async (line) => {
      handled = true;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        reply({ ok: false, error: "bad request: invalid JSON" });
        return;
      }
      if (!req || typeof req !== "object" || typeof req.op !== "string") {
        reply({ ok: false, error: "bad request: no op" });
        return;
      }
      try {
        reply(await handler(req));
      } catch (e) {
        reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    };
    conn.on("data", (chunk) => {
      if (handled) return;
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) void handle(buf.slice(0, nl));
      else if (buf.length > maxBytes) {
        handled = true;
        reply({ ok: false, error: "bad request: too long" });
      }
    });
    conn.on("end", () => {
      if (handled) return;
      if (buf.trim()) void handle(buf);
      else conn.end();
    });
    conn.on("error", () => {});
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch {
        // best effort; the directory is 0700 anyway
      }
      resolve(server);
    });
  });
}

/**
 * Stop listening and remove the socket file.
 * @param {net.Server} server @param {string} socketPath
 */
function close(server, socketPath) {
  server.close();
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // already gone
  }
}

module.exports = { serve, close };
