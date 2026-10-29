#!/usr/bin/env node
// @ts-check
/**
 * Development harness: serves the webview (the exact HTML VS Code gets, same CSP) on
 * 127.0.0.1 with a mocked `acquireVsCodeApi`, so it can be opened in a (headless) browser.
 *
 *   node scripts/serve-webview.js some.pdf [port]
 *
 * In the page: `window.__posted` holds every message the viewer sent to the "extension";
 * `window.__send(msg)` delivers a message to the viewer; `window.__reload()` re-sends the
 * PDF from disk as an on-disk reload would; `window.__state` is the webview state
 * (`getState`/`setState`), empty at the start unless a test seeds it before the page's
 * scripts run (Playwright's addInitScript).
 */
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { renderHtml, nonce } = require("../extension/html");

const root = path.resolve(__dirname, "..");
const pdf = path.resolve(process.argv[2] || "");
const port = Number(process.argv[3] || 0);
if (!process.argv[2] || !fs.existsSync(pdf)) {
  process.stderr.write("usage: serve-webview.js <file.pdf> [port]\n");
  process.exit(2);
}

/** @type {Record<string, string>} */
const TYPES = {
  ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".wasm": "application/wasm", ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream", ".ttf": "font/ttf", ".icc": "application/octet-stream",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const origin = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  if (url.pathname === "/") {
    const n = nonce();
    const mock = `<script nonce="${n}">
window.__posted = [];
window.__state = window.__state || {};
window.acquireVsCodeApi = () => ({
  postMessage(m) {
    window.__posted.push(m);
    if (m && m.type === "ready") window.__reload(false);
  },
  getState() { return window.__state; },
  setState(s) { window.__state = s; },
});
window.__send = (data) => window.dispatchEvent(new MessageEvent("message", { data }));
window.__reload = async (reload = true) => {
  const data = new Uint8Array(await (await fetch("/__pdf")).arrayBuffer());
  window.__send({ type: "load", data, reload });
};
</script>
`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderHtml({ cspSource: origin, nonce: n, uri: (rel) => `${origin}/${rel}`, extraHead: mock }));
    return;
  }
  // no icon, and no 404 for it in the console (Chromium asks for one)
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  const file = url.pathname === "/__pdf" ? pdf : path.join(root, decodeURIComponent(url.pathname));
  const allowed = file === pdf || file.startsWith(path.join(root, "media") + path.sep)
    || file.startsWith(path.join(root, "node_modules", "pdfjs-dist") + path.sep)
    || file.startsWith(path.join(root, "node_modules", "@vscode", "codicons", "dist") + path.sep);
  if (!allowed || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/pdf" });
  fs.createReadStream(file).pipe(res);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}/\n`);
});
