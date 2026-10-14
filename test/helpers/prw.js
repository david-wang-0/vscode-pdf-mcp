// @ts-check
/**
 * Where the test runners find pdf-reader-writer-mcp: its edit service and MCP server, a
 * Python with pymupdf to read PDFs back, and its LaTeX package pdfnotes.sty. Each one comes
 * from its environment variable when set, else from the installed edit service: the Python
 * of its `#!` line (the tool's own environment has pymupdf), and the `latex/` directory of
 * the source tree it was installed from (an editable install, e.g. `uv tool install -e`).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { which } = require("../../lib/backend");

/**
 * The interpreter of a Python console script (its `#!` line), if that is an absolute path
 * to an executable.
 * @param {string} script
 */
function shebangPython(script) {
  let first = "";
  try {
    first = fs.readFileSync(script, "utf8").split("\n", 1)[0];
  } catch {
    return "";
  }
  const m = /^#!\s*(\/\S+)\s*$/.exec(first);
  if (!m || !/python[\d.]*$/.test(path.basename(m[1]))) return "";
  try {
    fs.accessSync(m[1], fs.constants.X_OK);
    return m[1];
  } catch {
    return "";
  }
}

/** Does `python -I -c code` exit 0? @param {string} python @param {string} code */
function runs(python, code) {
  const r = spawnSync(python, ["-I", "-c", code], { encoding: "utf8", timeout: 20000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [root] this checkout, for a pdf-reader-writer-mcp checkout next to it
 * @returns {{editCommand: string, mcpCommand: string, python: string, pdfnotesDir: string}}
 */
function findPrw(env = process.env, root = path.resolve(__dirname, "../..")) {
  const editCommand = env.VSCODE_PDF_MCP_EDIT_COMMAND || which("pdf-reader-writer-edit", env) || "";
  const mcpCommand = env.VPDF_PRW_MCP || which("pdf-reader-writer-mcp", env) || "";
  const toolPython = editCommand ? shebangPython(editCommand) : "";
  let python = env.VPDF_PYTHON || "";
  if (!python && toolPython && runs(toolPython, "import pymupdf") !== null) python = toolPython;
  const has = (/** @type {string} */ d) => !!d && fs.existsSync(path.join(d, "pdfnotes.sty"));
  let pdfnotesDir = env.VPDF_PDFNOTES_DIR || ["pdf-reader-writer-mcp-pdfnotes", "pdf-reader-writer-mcp"]
    .map((d) => path.join(root, "..", d, "latex")).find(has) || "";
  if (!pdfnotesDir && toolPython) {
    const pkg = runs(toolPython, "import os, pdf_reader_writer_mcp as m; print(os.path.dirname(os.path.abspath(m.__file__)))");
    const latex = pkg ? path.join(path.dirname(pkg), "latex") : "";
    if (has(latex)) pdfnotesDir = latex;
  }
  return { editCommand, mcpCommand, python, pdfnotesDir };
}

module.exports = { findPrw, shebangPython };
