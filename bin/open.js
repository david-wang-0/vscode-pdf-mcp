#!/usr/bin/env node
// @ts-check
/**
 * vscode-pdf-mcp-open: open a PDF in the VS Code viewer, or do a SyncTeX forward search
 * into it. This is how LaTeX Workshop (or any other tool) is pointed at the viewer.
 *
 *   vscode-pdf-mcp-open <pdf>
 *   vscode-pdf-mcp-open --tex <file> --line <n> [--column <n>] <pdf>
 *
 * `--column` (0-based) picks the word to flash. The request goes to the VS Code window
 * that has the PDF open, else one whose workspace contains it, else the most recently
 * focused window (README "SyncTeX"). Exit 0 on success, 1 when no window does it (with
 * the reason on stderr), 2 on bad arguments.
 */
"use strict";

const path = require("node:path");
const { openPdf, synctexForward } = require("../lib/backend");

const USAGE = "usage: vscode-pdf-mcp-open <pdf>\n"
  + "       vscode-pdf-mcp-open --tex <file> --line <n> [--column <n>] <pdf>\n";

/**
 * @param {string[]} argv
 * @returns {{pdf: string, tex?: string, line?: number, column?: number} | {help: true} | {error: string}}
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const opts = {};
  /** @type {string[]} */
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { help: true };
    const m = /^--(tex|line|column)(?:=(.*))?$/.exec(a);
    if (m) {
      const value = m[2] !== undefined ? m[2] : argv[++i];
      if (value === undefined) return { error: `--${m[1]} needs a value` };
      opts[m[1]] = value;
    } else if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    } else if (a.startsWith("--")) {
      return { error: `unknown option ${a}` };
    } else {
      rest.push(a);
    }
  }
  if (rest.length !== 1) return { error: rest.length ? "give exactly one PDF" : "no PDF given" };
  const pdf = path.resolve(rest[0]);
  if (opts.tex === undefined) {
    if (opts.line !== undefined || opts.column !== undefined) return { error: "--line and --column need --tex" };
    return { pdf };
  }
  const line = Number(opts.line);
  if (opts.line === undefined || !Number.isInteger(line) || line < 1) return { error: "--tex needs --line <n>, a positive integer" };
  /** @type {{pdf: string, tex: string, line: number, column?: number}} */
  const out = { pdf, tex: path.resolve(opts.tex), line };
  if (opts.column !== undefined) {
    const column = Number(opts.column);
    // LaTeX Workshop and others may pass -1 for "no column"
    if (!Number.isInteger(column)) return { error: "--column must be an integer" };
    if (column >= 0) out.column = column;
  }
  return out;
}

/** @param {string[]} argv @returns {Promise<number>} exit code */
async function main(argv) {
  const args = parseArgs(argv);
  if ("help" in args) {
    process.stdout.write(USAGE);
    return 0;
  }
  if ("error" in args) {
    process.stderr.write(`vscode-pdf-mcp-open: ${args.error}\n${USAGE}`);
    return 2;
  }
  try {
    const entry = args.tex
      ? await synctexForward({ tex: args.tex, line: /** @type {number} */ (args.line), column: args.column, pdf: args.pdf })
      : await openPdf(args.pdf);
    process.stdout.write(`${entry.path}: page ${entry.page} of ${entry.pages}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`vscode-pdf-mcp-open: ${e instanceof Error ? e.message : e}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { USAGE, parseArgs, main };
