// @ts-check
/** extension/editservice.js against the fake edit service (test/helpers/fake-edit-service.js). */
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EditService, EditServiceError, EditServiceUnavailable } = require("../extension/editservice");
const { samplePdf } = require("./helpers/pdf");

const FAKE = path.join(__dirname, "helpers", "fake-edit-service.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vpdf-edit-"));
const pdf = path.join(tmp, "paper.pdf");
fs.writeFileSync(pdf, samplePdf(3));
/** @type {EditService[]} */
const services = [];
after(() => {
  for (const s of services) s.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** @param {Partial<ConstructorParameters<typeof EditService>[0]>} [opts] */
function fake(opts = {}) {
  /** @type {string[]} */
  const logs = [];
  const s = new EditService({ command: process.execPath, args: [FAKE], log: (l) => logs.push(l), ...opts });
  services.push(s);
  return Object.assign(s, { logs });
}

test("edit service: started lazily on the first request, answers ping", async () => {
  const s = fake();
  assert.equal(s.child, null);
  assert.deepEqual(await s.request("ping"), { version: 1 });
  assert.ok(s.child);
  assert.equal(s.starts, 1);
  assert.deepEqual(await s.probe(), { ok: true, version: 1 });
  assert.equal(s.starts, 1, "one process for every request");
});

test("edit service: concurrent requests are matched to their responses by id", async () => {
  const s = fake();
  const [a, b, c, d] = await Promise.allSettled([
    s.request("mark", { path: pdf, page: 1, rects: [[72, 690, 300, 704]], author: "david" }),
    s.request("snapshot", { path: pdf, xref: 424242 }),
    s.request("mark", { path: pdf, page: 9, rects: [[72, 690, 300, 704]], author: "david" }),
    s.request("ping"),
  ]);
  assert.equal(a.status, "fulfilled");
  assert.equal(/** @type {any} */ (a).value.page, 1);
  assert.equal(b.status, "rejected");
  assert.ok(/** @type {any} */ (b).reason instanceof EditServiceError);
  assert.equal(/** @type {any} */ (b).reason.message, "no annotation with xref 424242");
  assert.equal(/** @type {any} */ (c).reason.message, "page 9 outside 1-3");
  assert.deepEqual(/** @type {any} */ (d).value, { version: 1 });
});

test("edit service: a response split over several writes is reassembled", async () => {
  const s = fake();
  assert.deepEqual(await s.request("__split"), { split: true });
});

test("edit service: blank lines are skipped; non-JSON lines, non-responses and unmatched ids are logged and skipped", async () => {
  const s = fake();
  assert.deepEqual(await s.request("__noise"), { noise: true });
  assert.deepEqual(s.logs.filter((l) => /not JSON|unmatched/.test(l)), [
    "edit service: not JSON: this is not JSON",
    "edit service: unmatched response: null",
    `edit service: unmatched response: {"id":"1","ok":true,"result":"an id that is not a number"}`,
    `edit service: unmatched response: {"id":999999,"ok":true,"result":"stray"}`,
  ]);
  assert.deepEqual(await s.request("ping"), { version: 1 }, "still in step");
});

test("edit service: its stderr goes to the log line by line, blank lines left out", async () => {
  const s = fake();
  assert.deepEqual(await s.request("__stderr"), { stderr: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(s.logs.filter((l) => l.includes("warning")), ["edit service: first warning", "edit service: second warning"]);
});

test("edit service: a failure without a message is '<op> failed'", async () => {
  await assert.rejects(fake().request("__noerror"), (e) => e instanceof EditServiceError && e.message === "__noerror failed");
});

test("edit service: the service's errors reach the caller verbatim", async () => {
  const s = fake();
  await assert.rejects(s.request("bogus"), (e) => e instanceof EditServiceError && e.message === "unknown op: bogus");
  await assert.rejects(s.request("ping", { extra: 1 }), { message: "unknown field: extra" });
  await assert.rejects(s.request("mark", { path: pdf, page: 1, rects: [[1, 2, 3, 4]] }), { message: "missing field: author" });
});

test("edit service: undefined fields are left out of the request", async () => {
  const s = fake();
  const r = await s.request("mark", { path: pdf, page: 1, rects: [[72, 690, 300, 704]], author: "david", note: undefined, color: undefined });
  assert.equal(r.page, 1);
});

test("edit service: restarted on the next request after it dies", async () => {
  const s = fake();
  await s.request("ping");
  const pending = s.request("ping");
  await assert.rejects(s.request("__crash"), (e) => e instanceof EditServiceUnavailable && /exited \(code 3\)/.test(e.message));
  // A request already sent to the dying process is answered before it dies (in order).
  assert.deepEqual(await pending, { version: 1 });
  assert.deepEqual(await s.request("ping"), { version: 1 });
  assert.equal(s.starts, 2);
});

test("edit service: a missing executable is reported as missing, naming pdf-reader-writer-mcp", async () => {
  const s = fake({ command: path.join(tmp, "no-such-pdf-reader-writer-edit"), args: [] });
  const r = await s.probe();
  assert.equal(r.ok, false);
  assert.equal(/** @type {any} */ (r).missing, true);
  assert.match(/** @type {any} */ (r).reason, /not found: install pdf-reader-writer-mcp/);
  await assert.rejects(s.request("ping"), (e) => e instanceof EditServiceUnavailable && e.missing);
});

test("edit service: an executable without the x bit is reported as missing too", async () => {
  const plain = path.join(tmp, "not-executable");
  fs.writeFileSync(plain, "#!/bin/sh\n", { mode: 0o644 });
  const s = fake({ command: plain, args: [] });
  const r = await s.probe();
  assert.deepEqual([r.ok, /** @type {any} */ (r).missing], [false, true]);
  assert.match(/** @type {any} */ (r).reason, /not found: install pdf-reader-writer-mcp/);
  assert.ok(s.logs.some((l) => l.startsWith(`edit service ${plain}: `)), s.logs.join("\n"));
});

test("edit service: probe after dispose reports it, not as missing", async () => {
  const s = fake();
  s.dispose();
  assert.deepEqual(await s.probe(), { ok: false, missing: false, reason: "edit service disposed" });
});

test("edit service: protocol 2 (and newer) is accepted, an older one turns marking off", async () => {
  assert.deepEqual(await fake({ env: { ...process.env, FAKE_EDIT_VERSION: "2" } }).probe(), { ok: true, version: 2 });
  assert.deepEqual(await fake({ env: { ...process.env, FAKE_EDIT_VERSION: "3" } }).probe(), { ok: true, version: 3 });
  const r = await fake({ env: { ...process.env, FAKE_EDIT_VERSION: "0" } }).probe();
  assert.equal(r.ok, false);
  assert.match(/** @type {any} */ (r).reason, /protocol 0, this viewer needs 1 or newer/);
});

test("edit service: a request's time counts from when the service gets to it", async () => {
  const s = fake({ timeoutMs: 300 });
  await s.request("ping");
  // a long request (a sync) with its own timeout, and a short one queued behind it
  const slow = s.request("__slow", { ms: 600 }, { timeoutMs: 5000 });
  const ping = s.request("ping");
  assert.deepEqual(await slow, { slow: true });
  assert.deepEqual(await ping, { version: 1 });
  assert.equal(s.starts, 1, "nothing timed out");
  // the default still applies to a request the service sits on
  await assert.rejects(s.request("__slow", { ms: 2000 }), /did not answer __slow within/);
});

test("edit service: a hung request times out, and the process is replaced", async () => {
  const s = fake({ timeoutMs: 300 });
  await assert.rejects(s.request("__hang"), /did not answer __hang within/);
  assert.deepEqual(await s.request("ping"), { version: 1 });
  assert.equal(s.starts, 2);
});

test("edit service: dispose closes stdin and the service exits 0", async () => {
  const s = fake();
  await s.request("ping");
  const child = /** @type {import("node:child_process").ChildProcess} */ (s.child);
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  s.dispose();
  assert.equal(await exited, 0);
  await assert.rejects(s.request("ping"), /disposed/);
});
