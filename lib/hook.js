// @ts-check
/**
 * The UserPromptSubmit hook as a pure function (CONTRACT C6-C8): event + window states
 * in, output line (or null) out. `bin/hook.js` does the I/O.
 */
"use strict";

const path = require("node:path");
const { activePanel, realPath } = require("./backend");

/** C7: the selection is cut at this many characters. */
const MAX_SELECTION = 2000;

/** @param {string} inner @param {string} outer */
function lexicallyWithin(inner, outer) {
  const rel = path.relative(path.resolve(outer), path.resolve(inner));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Is `inner` equal to `outer` or inside it, lexically or after resolving symlinks?
 * @param {string} inner @param {string} outer
 */
function within(inner, outer) {
  return lexicallyWithin(inner, outer) || lexicallyWithin(realPath(inner), realPath(outer));
}

/**
 * C8: the PDF lies inside `cwd`, or one of the window's workspace folders equals `cwd`,
 * contains it, or lies inside it.
 * @param {import("./backend").Located} located @param {string} cwd
 */
function relevant({ state, panel }, cwd) {
  if (within(panel.path, cwd)) return true;
  return state.workspaceFolders.some((f) => within(cwd, f) || within(f, cwd));
}

/**
 * C7 text for the strict active entry.
 * @param {import("./backend").Located} located
 */
function contextText({ panel }) {
  let text = `The user is reading ${panel.path} in VS Code, page ${panel.page} of ${panel.pages}.`;
  const sel = panel.selection;
  if (sel && sel.text) {
    const cut = sel.text.length > MAX_SELECTION ? sel.text.slice(0, MAX_SELECTION) + " […]" : sel.text;
    text += `\nSelected text (page ${sel.page}):\n${cut}`;
  }
  return text;
}

/**
 * The hook's stdout for `event`, or null to print nothing.
 * @param {unknown} event the parsed stdin JSON (anything)
 * @param {import("./backend").WindowState[]} states
 * @returns {string | null}
 */
function hookOutput(event, states) {
  const cwd = event && typeof event === "object" ? /** @type {any} */ (event).cwd : undefined;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  const act = activePanel(states, { strict: true });
  if (!act || !relevant(act, cwd)) return null;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: contextText(act) },
  });
}

module.exports = { MAX_SELECTION, within, relevant, contextText, hookOutput };
