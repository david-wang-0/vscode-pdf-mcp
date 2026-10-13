// @ts-check
/** media/wordmatch.mjs: normalising LaTeX source and PDF text into words, and finding an anchor. */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../media/wordmatch.mjs");

/** @param {{norm: string, math?: boolean}[]} toks */
const norms = (toks) => toks.map((t) => (t.math ? "<math>" : t.norm));

test("source: comments, control words, braces and ~ go; \\emph{x} gives x; offsets are the source's", async () => {
  const { texTokens } = await load();
  const s = "With \\emph{efficient}~offline {T}ext. % a comment with words";
  const t = texTokens(s);
  assert.deepEqual(norms(t), ["with", "efficient", "offline", "text"]);
  assert.equal(s.slice(t[1].start, t[1].end), "efficient");
  assert.equal(s.slice(t[3].start, t[3].end), "T}ext", "from its first letter to its last");
  assert.deepEqual(norms(texTokens("100\\% sure, a\\_b")), ["100", "sure", "a", "b"]);
});

test("source: \\cite, \\ref, \\label keys are dropped entirely; a citation's optional argument stays", async () => {
  const { texTokens } = await load();
  assert.deepEqual(norms(texTokens("see \\cite{knuth84,lamport94} and Fig.~\\ref{fig:a}\\label{sec:x} here")),
    ["see", "and", "fig", "here"]);
  assert.deepEqual(norms(texTokens("\\citet*[Chapter~4]{arora} shows \\Cref{a,b}")), ["chapter", "4", "shows"]);
  assert.deepEqual(norms(texTokens("\\href{https://x.org/a}{the link} and \\includegraphics[width=3cm]{pic}")), ["the", "link", "and"]);
});

test("source: math is one opaque token ($...$, \\(...\\), \\[...\\], equation), across lines", async () => {
  const { texTokens } = await load();
  assert.deepEqual(norms(texTokens("if $x_1 = y$ then \\(a\\) and \\[b\\] or $$c$$ end")),
    ["if", "<math>", "then", "<math>", "and", "<math>", "or", "<math>", "end"]);
  assert.deepEqual(norms(texTokens("before\n\\begin{align*}\n  a &= b \\\\\n  c\n\\end{align*}\nafter")), ["before", "<math>", "after"]);
  assert.deepEqual(norms(texTokens("a $x\n+ y$ b")), ["a", "<math>", "b"]);
});

test("source: quotes, dashes, accents, hyphenated compounds, apostrophes", async () => {
  const { texTokens } = await load();
  assert.deepEqual(norms(texTokens("``quoted'' text---dash -- en; non-deterministic don't B\\\"uchi na\\\"{\\i}ve \\c{c}a")),
    ["quoted", "text", "dash", "en", "nondeterministic", "dont", "buchi", "naive", "ca"]);
});

test("PDF text: ligatures, accents, curly quotes, dashes and case are normalised", async () => {
  const { pdfTokens } = await load();
  assert.deepEqual(norms(pdfTokens("The ﬁrst eﬃcient ﬂuﬀy Büchi “quoted” text—dash don’t non-deterministic")),
    ["the", "first", "efficient", "fluffy", "buchi", "quoted", "text", "dash", "dont", "nondeterministic"]);
});

test("PDF text: a word hyphenated at a line end is one word, spanning both parts", async () => {
  const { pdfTokens } = await load();
  const text = "This sentence is hyphen-\nated across two lines, soft­\nhyphen too; Section-\n3 is kept apart.";
  const t = pdfTokens(text);
  assert.deepEqual(norms(t), ["this", "sentence", "is", "hyphenated", "across", "two", "lines", "softhyphen", "too", "section", "3", "is", "kept", "apart"]);
  assert.equal(text.slice(t[3].start, t[3].end), "hyphen-\nated");
});

test("anchor: a repeated word is told apart by its context, in source and in PDF text", async () => {
  const { texTokens, pdfTokens, anchorOf, findAnchor, sourceAnchor } = await load();
  const src = "The word model appears twice: a model of the model checker, with \\emph{efficient} offline~fluffy text.";
  const col = src.indexOf("model checker");
  const anchor = sourceAnchor([src], 1, col + 2);
  assert.ok(anchor);
  assert.deepEqual(anchor.words, ["model"]);
  assert.deepEqual(anchor.after.slice(0, 2), ["checker", "with"]);
  const pdf = "the next source line of the second page. The word model appears twice: a\nmodel of the model checker, with eﬃcient oﬄine ﬂuﬀy text.";
  const toks = pdfTokens(pdf);
  const hit = findAnchor(toks, anchor);
  assert.ok(hit);
  assert.equal(pdf.slice(toks[hit.index].start, toks[hit.index].end), "model");
  assert.equal(toks[hit.index].start, pdf.indexOf("model checker"));
  // and back: the first "model" of the second printed line, from the PDF, to the source
  const back = anchorOf(toks, toks.findIndex((t) => t.start === pdf.indexOf("model of")));
  const st = texTokens(src);
  const found = findAnchor(st, back);
  assert.ok(found);
  assert.equal(st[found.index].start, src.indexOf("model of"));
});

test("anchor: no confident match gives null (absent word, equal contexts, math, empty)", async () => {
  const { pdfTokens, findAnchor, sourceAnchor, validAnchor } = await load();
  const toks = pdfTokens("one two three four five");
  assert.equal(findAnchor(toks, { before: [], words: ["six"], after: [] }), null);
  // the same word twice with the same context on both sides
  assert.equal(findAnchor(pdfTokens("x a b c a b c y"), { before: [], words: ["b"], after: [] }), null);
  assert.equal(findAnchor(pdfTokens("a b c d a b c e"), { before: ["a"], words: ["b"], after: ["c"] }), null);
  // a word that is there once is enough
  assert.equal(findAnchor(toks, { before: ["x"], words: ["three"], after: ["y"] })?.index, 2);
  // the cursor on math, on a line with no words, or anchors that are not
  assert.equal(sourceAnchor(["where $x + y$ holds"], 1, 8), null);
  assert.equal(sourceAnchor(["% only a comment"], 1, 3), null);
  assert.equal(sourceAnchor(["text"], 2, 0), null);
  assert.equal(validAnchor({ before: [], words: [], after: [] }), false);
  assert.equal(validAnchor({ before: [], words: [""], after: [] }), false);
  assert.equal(validAnchor(null), false);
  assert.equal(findAnchor(toks, /** @type {any} */ ({ words: "two" })), null);
});

test("anchor at a column: the word under the cursor, right after it, the next one, or the selected stretch", async () => {
  const { sourceAnchor } = await load();
  const line = "Some \\emph{words} here, then \\cite{k} more.";
  assert.deepEqual(sourceAnchor([line], 1, 0)?.words, ["some"]);
  assert.deepEqual(sourceAnchor([line], 1, 4)?.words, ["some"], "just after the word");
  assert.deepEqual(sourceAnchor([line], 1, 6)?.words, ["words"], "on the macro: the next word");
  assert.deepEqual(sourceAnchor([line], 1, line.indexOf("k}"))?.words, ["more"], "in a citation key: the next word");
  assert.deepEqual(sourceAnchor([line], 1, line.length)?.words, ["more"], "at the end: the last word");
  assert.deepEqual(sourceAnchor([line], 1, line.indexOf("here"), line.indexOf("then") + 2)?.words, ["here", "then"]);
  // context comes from the lines around
  const a = sourceAnchor(["first line ends", "second starts here"], 2, 0);
  assert.deepEqual([a?.before, a?.words, a?.after], [["first", "line", "ends"], ["second"], ["starts", "here"]]);
});

test("inverse search: the word on SyncTeX's line, else on a nearby line (a caption), only if unique", async () => {
  const { findInSource } = await load();
  const lines = [
    "\\begin{figure}",                                       // 1
    "\\centering",                                           // 2
    "\\fbox{A boxed figure body}",                           // 3
    "\\caption{A caption that spans several source lines,", // 4
    "  with a distinctive word zeppelin in the middle",      // 5
    "  and its last words here.}",                           // 6
    "\\end{figure}",                                         // 7
  ];
  // SyncTeX gives a caption's text the argument's last line (6)
  assert.deepEqual(findInSource(lines, 6, { before: ["word"], words: ["zeppelin"], after: ["in", "the"] }),
    { line: 5, column: lines[4].indexOf("zeppelin"), end: lines[4].indexOf("zeppelin") + 8 });
  assert.deepEqual(findInSource(lines, 6, { before: ["a", "caption", "that"], words: ["spans"], after: [] })?.line, 4);
  assert.deepEqual(findInSource(lines, 6, { before: ["its"], words: ["last"], after: ["words"] })?.line, 6);
  // on SyncTeX's line first: "a" is on lines 3, 4 and 5, its context picks line 5
  assert.equal(findInSource(lines, 6, { before: ["with"], words: ["a"], after: ["distinctive"] })?.line, 5);
  // not there at all, or two equally good places
  assert.equal(findInSource(lines, 6, { before: [], words: ["absent"], after: [] }), null);
  assert.equal(findInSource(["x y", "x y", "", "z"], 4, { before: [], words: ["x"], after: ["y"] }), null);
});

test("inverse search: a long macro argument is searched to its start, beyond the nearby lines", async () => {
  const { findInSource } = await load();
  const lines = ["\\paragraph{Title}", "\\newtheorem{x}{y}", "\\mybox{%", "  First words of a long argument,",
    "  ...", "  ...", "  ...", "  ...", "  ...", "  ...", "  ...", "  ...", "}"];
  assert.equal(findInSource(lines, 13, { before: ["first"], words: ["words"], after: ["of", "a"] })?.line, 4);
  // a word found in no window stays unfound
  assert.equal(findInSource(lines, 13, { before: [], words: ["title2"], after: [] }), null);
});
