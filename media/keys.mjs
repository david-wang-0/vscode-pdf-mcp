// @ts-check
/**
 * Keyboard shortcuts of the marking tools, shared by the webview and the unit tests.
 * A key spec is a key name with optional modifiers, e.g. `"h"`, `"ctrl+z"`, `"shift+n"`.
 */

/** Default bindings; the `vscodePdfMcp.keys` setting overrides any of them. */
export const DEFAULT_KEYS = Object.freeze({
  highlight: "h",
  underline: "u",
  squiggly: "s",
  strikeout: "x",
  note: "n",
  undo: "ctrl+z",
});

/** @typedef {{key: string, ctrl: boolean, shift: boolean, alt: boolean, meta: boolean}} KeySpec */

/** @param {string} spec @returns {KeySpec | null} */
export function parseKey(spec) {
  if (typeof spec !== "string" || !spec.trim()) return null;
  const parts = spec.toLowerCase().split("+").map((s) => s.trim());
  // "ctrl++" means the plus key
  if (parts.length > 1 && parts[parts.length - 1] === "" && parts[parts.length - 2] === "") parts.splice(-2, 2, "+");
  const key = parts.pop();
  if (!key) return null;
  const out = { key, ctrl: false, shift: false, alt: false, meta: false };
  for (const m of parts) {
    if (m === "ctrl" || m === "control") out.ctrl = true;
    else if (m === "shift") out.shift = true;
    else if (m === "alt" || m === "option") out.alt = true;
    else if (m === "meta" || m === "cmd" || m === "super") out.meta = true;
    else return null;
  }
  return out;
}

/**
 * Does the keyboard event match? Letters compare case-insensitively (Shift is a modifier
 * of its own); Ctrl and Meta are interchangeable so Ctrl+Z is also Cmd+Z on a Mac.
 * @param {KeySpec} spec @param {{key: string, ctrlKey: boolean, shiftKey: boolean, altKey: boolean, metaKey: boolean}} e
 */
export function matches(spec, e) {
  const key = (e.key || "").toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  return key === spec.key && ctrl === (spec.ctrl || spec.meta) && e.shiftKey === spec.shift && e.altKey === spec.alt;
}

/**
 * Merge user bindings over the defaults; unknown actions and bad specs are ignored.
 * @param {Record<string, unknown> | null | undefined} user
 * @returns {Record<string, KeySpec>}
 */
export function keymap(user) {
  /** @type {Record<string, KeySpec>} */
  const out = {};
  for (const [action, def] of Object.entries(DEFAULT_KEYS)) {
    const want = user && typeof user[action] === "string" ? /** @type {string} */ (user[action]) : def;
    const spec = parseKey(want) || parseKey(def);
    if (spec) out[action] = spec;
  }
  return out;
}

/**
 * Is the event target somewhere the user types (so shortcuts must not fire)?
 * @param {any} target
 */
export function isTextField(target) {
  if (!target || typeof target !== "object") return false;
  const tag = String(target.tagName || "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = String(target.type || "text").toLowerCase();
    return !["button", "checkbox", "radio", "range", "color", "submit", "reset", "image", "file"].includes(type);
  }
  return !!target.isContentEditable;
}

/**
 * The action bound to `e`, or null; Escape is always "escape". Nothing fires from a text
 * field, except Escape.
 * @param {{key: string, ctrlKey: boolean, shiftKey: boolean, altKey: boolean, metaKey: boolean, target?: any}} e
 * @param {Record<string, KeySpec>} map
 */
export function actionFor(e, map) {
  if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey) return "escape";
  if (isTextField(e.target)) return null;
  for (const [action, spec] of Object.entries(map)) if (matches(spec, e)) return action;
  return null;
}
