// @ts-check
/**
 * The manifest: SyncTeX: Show in PDF is in the right-click menu of the
 * same editors whose command palette has it, Open in Okular is in the command palette
 * only, and the executables are registered.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const pkg = require("../package.json");

test("SyncTeX: Show in PDF is in a .tex editor's right-click menu, as in its palette", () => {
  const { menus, commands } = pkg.contributes;
  assert.ok(commands.some((/** @type {any} */ c) => c.command === "vscodePdfMcp.synctexForward"));
  const palette = menus.commandPalette.find((/** @type {any} */ m) => m.command === "vscodePdfMcp.synctexForward");
  const context = menus["editor/context"].find((/** @type {any} */ m) => m.command === "vscodePdfMcp.synctexForward");
  assert.ok(context, "in editor/context");
  assert.equal(context.when, palette.when);
  assert.match(context.when, /editorLangId == latex/);
  assert.match(context.group, /^navigation/);
  // the context menu shows the title alone, so it must read on its own
  assert.equal(commands.find((/** @type {any} */ c) => c.command === "vscodePdfMcp.synctexForward").title, "Show in PDF");
});

test("Open in Okular is a command-palette command only: no action above the editor, no icon", () => {
  const { menus, commands } = pkg.contributes;
  const cmd = commands.find((/** @type {any} */ c) => c.command === "vscodePdfMcp.openExternal");
  assert.deepEqual(cmd, { command: "vscodePdfMcp.openExternal", title: "Open in Okular", category: "PDF" });
  assert.ok(menus.commandPalette.some((/** @type {any} */ m) => m.command === "vscodePdfMcp.openExternal"));
  for (const [where, items] of Object.entries(menus)) {
    if (where === "commandPalette") continue;
    assert.ok(!(/** @type {any[]} */ (items)).some((m) => m.command === "vscodePdfMcp.openExternal"), `not in ${where}`);
  }
});

test("bin: vscode-pdf-mcp, vscode-pdf-mcp-hook and vscode-pdf-mcp-open are registered, executable Node scripts", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  assert.deepEqual(pkg.bin, { "vscode-pdf-mcp": "mcp/server.js", "vscode-pdf-mcp-hook": "bin/hook.js", "vscode-pdf-mcp-open": "bin/open.js" });
  for (const file of Object.values(pkg.bin)) {
    const abs = path.resolve(__dirname, "..", file);
    fs.accessSync(abs, fs.constants.X_OK);
    assert.equal(fs.readFileSync(abs, "utf8").split("\n", 1)[0], "#!/usr/bin/env node", file);
  }
});
