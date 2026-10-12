// @ts-check
/** extension/state.js: serialisation, focus and activity stamps, atomic write, debounce. */
"use strict";

const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { StateStore, writeAtomic } = require("../extension/state");
const backend = require("../lib/backend");

/** @param {Partial<ConstructorParameters<typeof StateStore>[0]>} [opts] */
function store(opts = {}) {
  let t = 1000;
  /** @type {[string, string][]} */
  const writes = [];
  const s = new StateStore({
    pid: 42, socket: "/run/x/42.sock", file: "/run/x/42.json",
    now: () => t, write: (f, d) => writes.push([f, d]), ...opts,
  });
  return { s, writes, tick: (/** @type {number} */ ms) => (t += ms) };
}

test("state: serialises the documented v1 shape", () => {
  const { s } = store();
  s.setWorkspaceFolders(["/work/proj"]);
  s.addPanel("1", "/work/proj/a.pdf");
  s.updatePanel("1", { page: 3, pages: 12, selection: { text: "hi", page: 2 } });
  assert.deepEqual(s.serialise(), {
    version: 1, pid: 42, socket: "/run/x/42.sock", focused: false, focusedAt: 0,
    workspaceFolders: ["/work/proj"],
    panels: [{ id: "1", path: "/work/proj/a.pdf", page: 3, pages: 12, active: false, lastActiveAt: 0,
      selection: { text: "hi", page: 2 } }],
  });
  s.dispose();
});

test("state: the serialised state is what readers accept", () => {
  const { s } = store({ pid: process.pid });
  s.addPanel("1", "/a.pdf");
  s.updatePanel("1", { active: true, page: 1, pages: 2 });
  assert.deepEqual(backend.normaliseState(JSON.parse(JSON.stringify(s.serialise()))), s.serialise());
  s.dispose();
});

test("state: focusedAt is the last focus gain, or now while focused", () => {
  const { s, tick } = store();
  s.setFocused(true);
  assert.equal(s.serialise().focusedAt, 1000);
  tick(500);
  assert.equal(s.serialise().focusedAt, 1500, "now while focused");
  s.setFocused(false);
  tick(500);
  assert.equal(s.serialise().focusedAt, 1000, "the last gain once blurred");
  s.setFocused(true);
  assert.equal(s.serialise().focusedAt, 2000);
  s.dispose();
});

test("state: a change of active (either way) stamps lastActiveAt; other changes do not", () => {
  const { s, tick } = store();
  s.addPanel("1", "/a.pdf");
  tick(10);
  s.updatePanel("1", { active: true });
  assert.equal(s.panels.get("1")?.lastActiveAt, 1010);
  tick(10);
  s.updatePanel("1", { page: 4, active: true });
  assert.equal(s.panels.get("1")?.lastActiveAt, 1010);
  tick(10);
  s.updatePanel("1", { active: false });
  assert.equal(s.panels.get("1")?.lastActiveAt, 1030);
  s.removePanel("1");
  assert.deepEqual(s.serialise().panels, []);
  s.updatePanel("1", { page: 2 }); // unknown id: ignored
  s.dispose();
});

test("state: a burst of changes is written once, after the debounce", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { s, writes } = store();
    s.addPanel("1", "/a.pdf");
    s.updatePanel("1", { page: 2 });
    s.setFocused(true);
    mock.timers.tick(99);
    assert.equal(writes.length, 0);
    mock.timers.tick(1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], "/run/x/42.json");
    const written = JSON.parse(writes[0][1]);
    assert.equal(written.panels[0].page, 2);
    assert.equal(written.focused, true);
    s.updatePanel("1", { page: 3 });
    mock.timers.tick(100);
    assert.equal(writes.length, 2);
    s.dispose();
  } finally {
    mock.timers.reset();
  }
});

test("state: flush writes at once and cancels the pending write; dispose stops writing", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { s, writes } = store();
    s.addPanel("1", "/a.pdf");
    s.flush();
    assert.equal(writes.length, 1);
    mock.timers.tick(200);
    assert.equal(writes.length, 1);
    s.updatePanel("1", { page: 9 });
    s.dispose();
    mock.timers.tick(200);
    s.flush();
    assert.equal(writes.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("state: write errors go to onError, not up the stack", () => {
  /** @type {unknown[]} */
  const errors = [];
  const s = new StateStore({ pid: 1, socket: "", file: "/x", write: () => { throw new Error("disk full"); }, onError: (e) => errors.push(e) });
  s.flush();
  assert.equal(errors.length, 1);
  s.dispose();
});

test("state: writeAtomic replaces the file by rename, mode 0600, no temp file left", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vpdf-state-"));
  try {
    const file = path.join(dir, "42.json");
    writeAtomic(file, "one");
    const ino = fs.statSync(file).ino;
    writeAtomic(file, "two");
    assert.equal(fs.readFileSync(file, "utf8"), "two");
    assert.notEqual(fs.statSync(file).ino, ino, "a new inode: replaced, not rewritten in place");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ["42.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state: a real store writes a file that readStates picks up", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vpdf-state-"));
  try {
    const s = new StateStore({ pid: process.pid, socket: path.join(dir, "s.sock"), file: path.join(dir, `${process.pid}.json`) });
    s.addPanel("1", "/a.pdf");
    s.updatePanel("1", { active: true, page: 2, pages: 5 });
    s.flush();
    s.dispose();
    const [w] = backend.readStates(dir);
    assert.equal(w.panels[0].page, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
