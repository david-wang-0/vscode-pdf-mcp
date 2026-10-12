// @ts-check
/**
 * A small multi-file LaTeX project for the SyncTeX tests, compiled with
 * `pdflatex -synctex=1`: an `\input` file, a wrapped paragraph, display math (equation
 * and align), a list, two-column text (multicol) and a second page.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { which } = require("../../lib/backend");

/** Is pdflatex installed (and the synctex CLI, for the oracle)? */
const HAVE_PDFLATEX = !!which("pdflatex", process.env);
const HAVE_SYNCTEX = !!which("synctex", process.env);

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
  for (const [rel, text] of Object.entries(projectFiles(extraChapterLines))) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  const r = spawnSync("pdflatex", ["-synctex=1", "-interaction=nonstopmode", "-halt-on-error", "main.tex"],
    { cwd: dir, encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) throw new Error(`pdflatex failed (${r.status}):\n${(r.stdout || "").slice(-2000)}`);
  return {
    pdf: path.join(dir, "main.pdf"),
    main: path.join(dir, "main.tex"),
    chapter: path.join(dir, "chapters", "one.tex"),
    synctex: path.join(dir, "main.synctex.gz"),
  };
}

module.exports = { HAVE_PDFLATEX, HAVE_SYNCTEX, projectFiles, buildProject };
