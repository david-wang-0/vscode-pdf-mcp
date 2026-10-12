// @ts-check
/**
 * Client for pdf-reader-writer-mcp's edit service (`pdf-reader-writer-edit`): one
 * long-lived child process per window, spoken to in JSON lines over stdin/stdout.
 * Request `{"id": N, "op": "...", ...fields}`, response `{"id": N, "ok": true, "result":
 * ...}` or `{"id": N, "ok": false, "error": "..."}`, handled in order. EOF on stdin ends it.
 *
 * The process is started on the first request and started again on the next request after
 * it dies. A missing executable fails every request with `EditServiceUnavailable`
 * (`missing: true`) until the configuration changes.
 */
"use strict";

const { spawn } = require("node:child_process");

/** The service reported an error (`ok: false`): its message is the service's own text. */
class EditServiceError extends Error {}

/** The service cannot be reached: not installed, failed to start, or died mid-request. */
class EditServiceUnavailable extends Error {
  /** @param {string} message @param {{missing?: boolean}} [opts] */
  constructor(message, { missing = false } = {}) {
    super(message);
    this.missing = missing;
  }
}

/** The protocol version this client speaks (`ping` answers `{version}`). */
const PROTOCOL_VERSION = 1;

class EditService {
  /**
   * @param {{command: string, args?: string[], env?: NodeJS.ProcessEnv,
   *          log?: (line: string) => void, timeoutMs?: number}} opts
   */
  constructor({ command, args = [], env = process.env, log = () => {}, timeoutMs = 30000 }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.log = log;
    this.timeoutMs = timeoutMs;
    /** @type {import("node:child_process").ChildProcessWithoutNullStreams | null} */
    this.child = null;
    this.seq = 0;
    /** @type {Map<number, {resolve: (v: any) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout>, op: string, child: any}>} */
    this.pending = new Map();
    this.buf = "";
    /** Number of processes started so far (for tests and the log). */
    this.starts = 0;
    /** Writes one request line to the current process. @type {(line: string) => void} */
    this.send = () => {};
    this.disposed = false;
  }

  /** Start the process unless it runs. */
  start() {
    if (this.child) return this.child;
    if (this.disposed) throw new EditServiceUnavailable("edit service disposed");
    this.starts++;
    this.buf = "";
    const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"], env: this.env });
    this.child = child;
    // Requests wait for the process to exist: writing to a process that failed to start
    // raises SIGPIPE in the extension host.
    /** @type {string[] | null} */
    let held = [];
    this.send = (/** @type {string} */ line) => {
      if (held) held.push(line);
      else child.stdin.write(line);
    };
    child.once("spawn", () => {
      const lines = held || [];
      held = null;
      for (const line of lines) child.stdin.write(line);
    });
    let gone = false;
    /** @param {Error} err */
    const onGone = (err) => {
      if (gone) return;
      gone = true;
      this.abandon(child, err);
    };
    child.on("error", (e) => {
      held = null;
      this.send = () => {};
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      const missing = code === "ENOENT" || code === "EACCES";
      this.log(`edit service ${this.command}: ${e.message}`);
      onGone(new EditServiceUnavailable(missing
        ? `${this.command} not found: install pdf-reader-writer-mcp (it provides pdf-reader-writer-edit) or set vscodePdfMcp.editCommand`
        : `cannot start ${this.command}: ${e.message}`, { missing }));
    });
    child.on("exit", (code, signal) => {
      this.log(`edit service exited (${signal || `code ${code}`})`);
      onGone(new EditServiceUnavailable(`edit service exited (${signal || `code ${code}`})`));
    });
    child.stdin.on("error", () => {}); // EPIPE after a crash; "exit" reports it
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (this.child === child) this.onData(String(chunk));
    });
    child.stderr.setEncoding("utf8");
    let errBuf = "";
    child.stderr.on("data", (chunk) => {
      errBuf += chunk;
      let i;
      while ((i = errBuf.indexOf("\n")) >= 0) {
        const line = errBuf.slice(0, i).trimEnd();
        errBuf = errBuf.slice(i + 1);
        if (line) this.log(`edit service: ${line}`);
      }
    });
    return child;
  }

  /**
   * Stop using `child`: fail the requests sent to it; the next request starts a new one.
   * @param {any} child @param {Error} err
   */
  abandon(child, err) {
    if (this.child === child) {
      this.child = null;
      this.buf = "";
    }
    for (const [id, p] of this.pending) {
      if (p.child !== child) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(err);
    }
  }

  /** @param {string} chunk */
  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      /** @type {any} */
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.log(`edit service: not JSON: ${line.slice(0, 200)}`);
        continue;
      }
      const p = msg && typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
      if (!p) {
        this.log(`edit service: unmatched response: ${line.slice(0, 200)}`);
        continue;
      }
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok === true) p.resolve(msg.result);
      else p.reject(new EditServiceError(typeof msg.error === "string" ? msg.error : `${p.op} failed`));
    }
  }

  /**
   * Send one request; resolves with `result`, rejects with EditServiceError (the service's
   * message) or EditServiceUnavailable. Fields that are `undefined` are left out.
   * @param {string} op @param {Record<string, unknown>} [fields]
   * @returns {Promise<any>}
   */
  request(op, fields = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.start();
      } catch (e) {
        reject(e);
        return;
      }
      const id = ++this.seq;
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        // A hung service would answer everything late: give up on it and start afresh.
        this.abandon(child, new EditServiceUnavailable(`edit service did not answer ${op} within ${Math.round(this.timeoutMs / 1000)} s`));
        child.kill("SIGKILL");
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, op, child });
      this.send(JSON.stringify({ id, op, ...fields }) + "\n");
    });
  }

  /**
   * Start the service if needed and check its protocol version.
   * @returns {Promise<{ok: true, version: number} | {ok: false, reason: string, missing: boolean}>}
   */
  async probe() {
    try {
      const r = await this.request("ping");
      if (!r || r.version !== PROTOCOL_VERSION) {
        return { ok: false, missing: false,
          reason: `${this.command} speaks edit protocol ${r?.version}, this viewer needs ${PROTOCOL_VERSION}: update pdf-reader-writer-mcp or vscode-pdf-mcp` };
      }
      return { ok: true, version: r.version };
    } catch (e) {
      const missing = e instanceof EditServiceUnavailable && e.missing;
      return { ok: false, missing, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Close stdin (the service exits on EOF); kill it if it lingers. */
  dispose() {
    this.disposed = true;
    const child = this.child;
    if (!child) return;
    this.abandon(child, new EditServiceUnavailable("edit service disposed"));
    child.stdin.end();
    const t = setTimeout(() => child.kill("SIGKILL"), 2000);
    t.unref?.();
    child.once("exit", () => clearTimeout(t));
  }
}

module.exports = { EditService, EditServiceError, EditServiceUnavailable, PROTOCOL_VERSION };
