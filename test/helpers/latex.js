// @ts-check
/**
 * A small multi-file LaTeX project for the SyncTeX tests, compiled with
 * `pdflatex -synctex=1`: an `\input` file, a wrapped paragraph, display math (equation
 * and align), a list, two-column text (multicol) and a second page with a line that
 * repeats a word and a figure whose caption spans three source lines.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { which } = require("../../lib/backend");

/** Is pdflatex installed (and the synctex CLI, for the oracle; pdftotext, for word boxes)? */
const HAVE_PDFLATEX = !!which("pdflatex", process.env);
const HAVE_SYNCTEX = !!which("synctex", process.env);
const HAVE_PDFTOTEXT = !!which("pdftotext", process.env);

/** @param {string} [extraChapterLines] lines inserted at the top of chapters/one.tex (rebuild tests) */
function projectFiles(extraChapterLines = "") {
  return {
    "main.tex": [
      "\\documentclass[11pt]{article}",
      "\\usepackage{amsmath}",
      "\\usepackage{multicol}",
      "\\begin{document}",
      "\\section{Introduction}",
      "Reachability of timed automata is decidable via regions. This paragraph is long",
      "enough to wrap over several lines of the page, so that a reverse search",
      "from its second or third printed line has to land on the right source line.",
      "We keep writing a little more text here to make sure it wraps at least twice,",
      "and then a little more for good measure.",
      "",
      "\\input{chapters/one}",
      "",
      "\\begin{equation}",
      "  \\int_0^1 x^2 \\, dx = \\frac{1}{3}",
      "\\end{equation}",
      "",
      "\\begin{itemize}",
      "\\item The first item of a list.",
      "\\item A second item, with a little more text in it.",
      "\\end{itemize}",
      "",
      "\\begin{multicols}{2}",
      "Left column text starts here and goes on for a while so that it fills",
      "the first column with several lines of words.",
      "\\columnbreak",
      "",
      "Right column text is here and also runs for several lines so the",
      "second column has some words too.",
      "\\end{multicols}",
      "",
      "\\newpage",
      "\\section{Second page}",
      "Text on the second page, written on one source line.",
      "Another sentence on the next source line of the second page.",
      "The word model appears twice: a model of the model checker, with \\emph{efficient} offline~fluffy text.",
      "\\begin{figure}[h]",
      "\\centering",
      "\\fbox{A boxed figure body}",
      "\\caption{A caption that spans several source lines,",
      "  with a distinctive word zeppelin in the middle",
      "  and its last words here.}",
      "\\end{figure}",
      "\\end{document}",
      "",
    ].join("\n"),
    "chapters/one.tex": [
      ...(extraChapterLines ? [extraChapterLines] : []),
      "\\section{Chapter one}",
      "This text comes from an input file.",
      "It has a second source line too.",
      "",
      "\\begin{align}",
      "  a &= b + c \\\\",
      "  d &= e",
      "\\end{align}",
      "",
    ].join("\n"),
  };
}

/**
 * Write the project into `dir` and compile it (twice is not needed: no references).
 * @param {string} dir @param {{extraChapterLines?: string}} [opts]
 * @returns {{pdf: string, main: string, chapter: string, synctex: string}}
 */
function buildProject(dir, { extraChapterLines = "" } = {}) {
  compile(dir, projectFiles(extraChapterLines));
  return {
    pdf: path.join(dir, "main.pdf"),
    main: path.join(dir, "main.tex"),
    chapter: path.join(dir, "chapters", "one.tex"),
    synctex: path.join(dir, "main.synctex.gz"),
  };
}

/**
 * Write `files` (relative path -> text) into `dir` and compile `main` there with
 * `pdflatex -synctex=1`, `runs` times, in the environment `env` (e.g. a TEXINPUTS).
 * @param {string} dir @param {Record<string, string>} files @param {string} [main]
 * @param {{runs?: number, env?: NodeJS.ProcessEnv}} [opts]
 */
function compile(dir, files, main = "main.tex", { runs = 1, env = process.env } = {}) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  for (let i = 0; i < runs; i++) {
    const r = spawnSync("pdflatex", ["-synctex=1", "-interaction=nonstopmode", "-halt-on-error", main],
      { cwd: dir, encoding: "utf8", timeout: 60000, env });
    if (r.status !== 0) throw new Error(`pdflatex failed (${r.status}):\n${(r.stdout || "").slice(-2000)}`);
  }
}

/**
 * The words of `pdf` with their boxes (bp, top-left origin), from `pdftotext -bbox`.
 * @param {string} pdf @returns {{page: number, word: string, box: [number, number, number, number]}[]}
 */
function wordBoxes(pdf) {
  const r = spawnSync("pdftotext", ["-bbox", pdf, "-"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`pdftotext failed (${r.status}): ${r.stderr}`);
  /** @type {{page: number, word: string, box: [number, number, number, number]}[]} */
  const out = [];
  let page = 0;
  for (const l of r.stdout.split("\n")) {
    if (l.includes("<page ")) page++;
    const m = /xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</.exec(l);
    if (m && page) {
      const [x0, y0, x1, y1] = m.slice(1, 5).map(Number);
      out.push({ page, word: m[5], box: [x0, y0, x1, y1] });
    }
  }
  return out;
}

module.exports = { HAVE_PDFLATEX, HAVE_SYNCTEX, HAVE_PDFTOTEXT, projectFiles, buildProject, compile, wordBoxes };
