// @ts-check
/**
 * The manifest's contributions: SyncTeX: show in PDF is in the right-click menu of the
 * same editors whose command palette has it.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const pkg = require("../package.json");

test("SyncTeX: show in PDF is in a .tex editor's right-click menu, as in its palette", () => {
  const { menus, commands } = pkg.contributes;
  assert.ok(commands.some((/** @type {any} */ c) => c.command === "vscodePdfMcp.synctexForward"));
  const palette = menus.commandPalette.find((/** @type {any} */ m) => m.command === "vscodePdfMcp.synctexForward");
  const context = menus["editor/context"].find((/** @type {any} */ m) => m.command === "vscodePdfMcp.synctexForward");
  assert.ok(context, "in editor/context");
  assert.equal(context.when, palette.when);
  assert.match(context.when, /editorLangId == latex/);
  assert.match(context.group, /^navigation/);
});
