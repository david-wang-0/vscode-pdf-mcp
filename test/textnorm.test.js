// @ts-check
/** media/textnorm.mjs: how a text-layer selection is normalised before it is posted. */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../media/textnorm.mjs");

test("selection: lines are joined with spaces and whitespace collapses", async () => {
  const { normaliseSelection } = await load();
  assert.equal(normaliseSelection("  Reachability of\ntimed  automata\r\nis decidable.\n"), "Reachability of timed automata is decidable.");
});

test("selection: a hyphen between lower-case letters at a line end is removed", async () => {
  const { normaliseSelection } = await load();
  assert.equal(normaliseSelection("This sentence is hyphen-\nated across lines."), "This sentence is hyphenated across lines.");
  assert.equal(normaliseSelection("soft­\nhyphen and in­line"), "softhyphen and inline");
});

test("selection: other line-end hyphens are kept (not trivially safe)", async () => {
  const { normaliseSelection } = await load();
  assert.equal(normaliseSelection("see Section-\n3"), "see Section- 3");
  assert.equal(normaliseSelection("non-\nDeterministic"), "non- Deterministic");
  assert.equal(normaliseSelection("a - \n b"), "a - b");
});
