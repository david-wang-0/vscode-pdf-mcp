// @ts-check
/**
 * Runtime directory and session environment (CONTRACT C5).
 *
 * MCP clients commonly start stdio servers with a minimal environment (Codex keeps only
 * HOME, PATH, SHELL and USER), which loses XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS and
 * WAYLAND_DISPLAY. All three have well-known defaults under the per-user runtime
 * directory on a systemd desktop, so fill them in from there. Mirrors okular-mcp's env.py.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** Name of the directory under the runtime dir that holds state files and sockets. */
const DIR_NAME = "vscode-pdf-mcp";

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} `$XDG_RUNTIME_DIR`, else `/run/user/<uid>`.
 */
function runtimeDir(env = process.env) {
  return env.XDG_RUNTIME_DIR || `/run/user/${process.getuid ? process.getuid() : 0}`;
}

/**
 * The directory where each VS Code window publishes `<pid>.json` and `<pid>.sock`.
 * `VSCODE_PDF_MCP_DIR` overrides it (tests, unusual setups).
 * @param {NodeJS.ProcessEnv} [env]
 */
function stateDir(env = process.env) {
  return env.VSCODE_PDF_MCP_DIR || path.join(runtimeDir(env), DIR_NAME);
}

/**
 * Fill XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS and WAYLAND_DISPLAY when missing.
 * Existing values are never overwritten.
 * @param {NodeJS.ProcessEnv} [env] mutated in place
 */
function ensureSessionEnv(env = process.env) {
  const rt = runtimeDir(env);
  if (!env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = rt;
  if (!("DBUS_SESSION_BUS_ADDRESS" in env) && fs.existsSync(`${rt}/bus`)) {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${rt}/bus`;
  }
  if (!("WAYLAND_DISPLAY" in env)) {
    for (const name of ["wayland-0", "wayland-1"]) {
      if (fs.existsSync(`${rt}/${name}`)) {
        env.WAYLAND_DISPLAY = name;
        break;
      }
    }
  }
  return env;
}

module.exports = { DIR_NAME, runtimeDir, stateDir, ensureSessionEnv };
