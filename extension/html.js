// @ts-check
/**
 * The webview's HTML, as a pure function so the development harness
 * (scripts/serve-webview.js) serves exactly what VS Code shows.
 */
"use strict";

const crypto = require("node:crypto");

/** Files under the extension root that the webview loads. */
const ASSETS = {
  pdfjs: "node_modules/pdfjs-dist/legacy/build/pdf.mjs",
  worker: "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  pdfViewer: "node_modules/pdfjs-dist/legacy/web/pdf_viewer.mjs",
  pdfViewerCss: "node_modules/pdfjs-dist/legacy/web/pdf_viewer.css",
  cMapUrl: "node_modules/pdfjs-dist/cmaps/",
  standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/",
  wasmUrl: "node_modules/pdfjs-dist/wasm/",
  iccUrl: "node_modules/pdfjs-dist/iccs/",
  imageResourcesPath: "node_modules/pdfjs-dist/legacy/web/images/",
  viewerJs: "media/viewer.js",
  viewerCss: "media/viewer.css",
};

function nonce() {
  return crypto.randomBytes(18).toString("base64url");
}

/** @param {string} s */
function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * @param {{cspSource: string, nonce: string, uri: (rel: string) => string,
 *          extraHead?: string}} opts `uri` maps an ASSETS path to a webview URL
 */
function renderHtml({ cspSource, nonce: n, uri, extraHead = "" }) {
  /** @type {Record<string, string>} */
  const urls = {};
  for (const [k, rel] of Object.entries(ASSETS)) urls[k] = uri(rel);
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} data: blob:`,
    `style-src ${cspSource} 'nonce-${n}'`,
    `font-src ${cspSource} data: blob:`,
    `script-src 'nonce-${n}' ${cspSource}`,
    `worker-src ${cspSource} blob:`,
    `connect-src ${cspSource}`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${urls.pdfViewerCss}">
<link rel="stylesheet" href="${urls.viewerCss}">
${extraHead}</head>
<body data-config="${escapeAttr(JSON.stringify(urls))}">
<div id="toolbar" role="toolbar">
  <span class="group">
    <input id="pageNumber" type="text" inputmode="numeric" value="" size="4" aria-label="Page" title="Page">
    <span id="numPages">/ 0</span>
  </span>
  <span class="group">
    <button id="zoomOut" title="Zoom out" aria-label="Zoom out">&minus;</button>
    <button id="zoomIn" title="Zoom in" aria-label="Zoom in">+</button>
    <button id="fitWidth" title="Fit width" aria-label="Fit width">Fit width</button>
    <span id="zoomValue"></span>
  </span>
  <span class="spacer"></span>
  <button id="openExternal" title="Open this PDF in Okular">Open in Okular</button>
</div>
<div id="findbar" hidden>
  <input id="findInput" type="text" placeholder="Find in document" aria-label="Find in document">
  <button id="findPrev" title="Previous match (Shift+Enter)" aria-label="Previous match">&uarr;</button>
  <button id="findNext" title="Next match (Enter)" aria-label="Next match">&darr;</button>
  <span id="findResult"></span>
  <button id="findClose" title="Close (Escape)" aria-label="Close">&times;</button>
</div>
<div id="viewerContainer" tabindex="0"><div id="viewer" class="pdfViewer"></div></div>
<div id="message" hidden></div>
<script type="module" nonce="${n}" src="${urls.viewerJs}"></script>
</body>
</html>
`;
}

module.exports = { ASSETS, renderHtml, nonce };
