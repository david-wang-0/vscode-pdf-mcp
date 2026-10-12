// @ts-check
/** Test fixtures: a temporary runtime dir with fake state files, and clipboard-tool stubs. */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

/** A pid that certainly belonged to a process that has exited and been reaped. */
function deadPid() {
  const r = spawnSync(process.execPath, ["-e", ""]);
  if (!r.pid) throw new Error("could not spawn");
  return r.pid;
}

/** @type {import("node:child_process").ChildProcess[]} */
const children = [];

/** The pid of a fresh idle process (another "VS Code window"); killed by `killLive()`. */
function livePid() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
  children.push(child);
  if (!child.pid) throw new Error("could not spawn");
  return child.pid;
}

function killLive() {
  for (const c of children.splice(0)) c.kill();
}

/**
 * @typedef {{id?: string, path: string, page?: number, pages?: number, active?: boolean,
 *            lastActiveAt?: number, selection?: {text: string, page: number,
 *            tex?: {file: string, lines: number[]}[]} | null}} PanelSpec
 * @typedef {{pid?: number, focused?: boolean, focusedAt?: number, workspaceFolders?: string[],
 *            panels?: PanelSpec[], socket?: string}} WindowSpec
 */

/** A temp dir laid out like `$XDG_RUNTIME_DIR` with an empty `vscode-pdf-mcp/`. */
function makeRuntime() {
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), "vpdf-rt-"));
  const dir = path.join(rt, "vscode-pdf-mcp");
  fs.mkdirSync(dir, { mode: 0o700 });
  return {
    rt,
    dir,
    /**
     * Write `<pid>.json` for a window (default pid: this test process, alive).
     * @param {WindowSpec} w
     */
    window(w) {
      const pid = w.pid ?? process.pid;
      const stem = String(pid);
      const state = {
        version: 1,
        pid,
        socket: w.socket ?? path.join(dir, `${stem}.sock`),
        focused: w.focused ?? false,
        focusedAt: w.focusedAt ?? 0,
        workspaceFolders: w.workspaceFolders ?? [],
        panels: (w.panels ?? []).map((p, i) => ({
          id: p.id ?? String(i + 1),
          path: p.path,
          page: p.page ?? 1,
          pages: p.pages ?? 10,
          active: p.active ?? false,
          lastActiveAt: p.lastActiveAt ?? 0,
          selection: p.selection ?? null,
        })),
      };
      fs.writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify(state));
      return state;
    },
    /** @param {string} name @param {string} content */
    raw(name, content) {
      fs.writeFileSync(path.join(dir, name), content);
    },
    cleanup() {
      fs.rmSync(rt, { recursive: true, force: true });
    },
  };
}

/**
 * Fake `wl-paste`/`xclip`/`xsel` on a temp PATH. Each stub appends its argv (one JSON
 * array per line) and the WAYLAND_DISPLAY it saw to `log`, then prints `stdout` and exits
 * `rc` with `stderr`.
 * @param {string[]} tools @param {{stdout?: string, stderr?: string, rc?: number}} [opts]
 */
function makeStubs(tools, { stdout = "stub text", stderr = "", rc = 0 } = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "vpdf-bin-"));
  const log = path.join(bin, "calls.log");
  const q = (/** @type {string} */ s) => `'${s.replace(/'/g, "'\\''")}'`;
  for (const t of tools) {
    fs.writeFileSync(path.join(bin, t), [
      "#!/bin/sh",
      `node=${q(process.execPath)}`,
      `"$node" -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify({argv: [${JSON.stringify(t)}, ...process.argv.slice(2)], wayland: process.env.WAYLAND_DISPLAY || null}) + "\\n")' ${q(log)} "$@"`,
      `printf '%s' ${q(stdout)}`,
      stderr ? `printf '%s' ${q(stderr)} >&2` : "",
      `exit ${rc}`,
      "",
    ].join("\n"), { mode: 0o755 });
  }
  return {
    bin,
    /** @returns {{argv: string[], wayland: string | null}[]} */
    calls() {
      try {
        return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    cleanup() {
      fs.rmSync(bin, { recursive: true, force: true });
    },
  };
}

module.exports = { deadPid, livePid, killLive, makeRuntime, makeStubs };
