// @ts-check
/**
 * Runs inside the VS Code extension host (see run.js). Drives the real custom editor and
 * checks the state file, goto over the socket, reload on disk change, the hook and
 * "Open in Okular" (against a fake command). Then, with pdf-reader-writer-mcp's edit
 * service, marking with real mouse and keyboard input over CDP: mark, reply, edit,
 * delete, undo, keys kept from VS Code, and concurrent writes with the MCP server.
 * With pdflatex, SyncTeX: Ctrl+click opens the source, forward search from the command
 * and from vscode-pdf-mcp-open, both down to the word, the entry in a .tex editor's
 * right-click menu, the selection's source lines, and a rebuild.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn, spawnSync } = require("node:child_process");
const vscode = require("vscode");
const backend = require("../../lib/backend");
const { hookOutput } = require("../../lib/hook");
const { samplePdf } = require("../helpers/pdf");

const dir = /** @type {string} */ (process.env.VSCODE_PDF_MCP_DIR);
const tmp = /** @type {string} */ (process.env.VPDF_TEST_TMP);
const workspace = path.join(tmp, "workspace");
const paper = path.join(workspace, "paper.pdf");
const other = path.join(workspace, "other.pdf");
const broken = path.join(workspace, "broken.pdf");

/**
 * Resolve with the first truthy value of `fn()`, checked on each change in the state dir
 * and at least every 100 ms.
 * @template T @param {() => T} fn @param {string} what @param {number} [ms]
 * @returns {Promise<NonNullable<T>>}
 */
function waitFor(fn, what, ms = 15000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      let v;
      try {
        v = fn();
      } catch {
        v = null;
      }
      if (v) {
        done();
        resolve(/** @type {NonNullable<T>} */ (v));
      }
    };
    const watcher = fs.watch(dir, check);
    const tick = setInterval(check, 100);
    const timer = setTimeout(() => {
      done();
      const states = fs.readdirSync(dir).filter((n) => n.endsWith(".json"))
        .map((n) => fs.readFileSync(path.join(dir, n), "utf8")).join("\n");
      reject(new Error(`timed out waiting for ${what}; state:\n${states}`));
    }, ms);
    const done = () => {
      watcher.close();
      clearInterval(tick);
      clearTimeout(timer);
    };
    check();
  });
}

/** This window's panel for `file`, from the state file. @param {string} file */
function panelFor(file) {
  const mine = backend.readStates(dir).find((s) => s.pid === process.pid);
  return mine?.panels.find((p) => p.path === file) || null;
}

async function run() {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "vscode-pdf-mcp");
  assert.ok(ext, "extension present");
  await ext.activate();
  await waitFor(() => fs.existsSync(path.join(dir, `${process.pid}.json`)) && fs.existsSync(path.join(dir, `${process.pid}.sock`)),
    "state file and socket");

  // 1. *.pdf opens in our editor by default; the state file shows it with its page count.
  await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(paper));
  const p1 = await waitFor(() => { const p = panelFor(paper); return p && p.pages === 5 ? p : null; }, "paper.pdf loaded");
  assert.equal(p1.page, 1);
  await waitFor(() => panelFor(paper)?.active, "paper.pdf active");
  const [state] = backend.readStates(dir);
  assert.deepEqual(state.workspaceFolders, [workspace]);
  assert.equal(backend.viewerState({ dir })[0].path, paper);

  // 2. goto over the socket, as the MCP server does it.
  const e1 = await backend.goto(3, paper, { dir });
  assert.equal(e1.page, 3);
  assert.equal(e1.pages, 5);
  await waitFor(() => panelFor(paper)?.page === 3, "page 3 in the state file");
  await assert.rejects(backend.goto(6, paper, { dir }), { message: "page 6 outside 1-5" });

  // 3. goto a document that is not open opens it here and scrolls once it has loaded.
  const e2 = await backend.goto(2, other, { dir });
  assert.deepEqual([e2.path, e2.page, e2.pages], [other, 2, 2]);
  await waitFor(() => backend.viewerState({ dir })[0].path === other, "other.pdf is the active entry");

  // 4. A file pdf.js cannot read: 'cannot open <path>', checked before the page range.
  await assert.rejects(backend.goto(99, broken, { dir }), { message: `cannot open ${broken}` });
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

  // 5. Replace-by-rename (as LaTeX does) reloads the background tab and keeps its page.
  const tmpFile = path.join(workspace, "paper.pdf.tmp");
  fs.writeFileSync(tmpFile, samplePdf(7, "v2"));
  fs.renameSync(tmpFile, paper);
  const p2 = await waitFor(() => { const p = panelFor(paper); return p && p.pages === 7 ? p : null; }, "reload to 7 pages");
  assert.equal(p2.page, 3);
  // A half-written file keeps the old render; the next good write is picked up.
  fs.writeFileSync(paper, samplePdf(6, "v3").subarray(0, 300));
  fs.writeFileSync(paper, samplePdf(6, "v3"));
  await waitFor(() => panelFor(paper)?.pages === 6, "reload to 6 pages");
  // Shown again, the tab displays the new file at the old place.
  await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(paper));
  await waitFor(() => panelFor(paper)?.active, "paper.pdf shown again");
  await new Promise((r) => setTimeout(r, 750)); // let pdf.js settle its scroll position
  assert.deepEqual([panelFor(paper)?.page, panelFor(paper)?.pages], [3, 6]);

  // 6. The hook sees the active tab for this workspace, and nothing for another cwd.
  await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(other));
  await waitFor(() => panelFor(other)?.active, "other.pdf active again");
  const states = backend.readStates(dir);
  const out = hookOutput({ cwd: workspace }, states);
  assert.ok(out, "hook prints for the workspace");
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext,
    new RegExp(`^The user is reading ${other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} in VS Code, page \\d+ of 2\\.`));
  assert.equal(hookOutput({ cwd: path.join(tmp, "elsewhere") }, states), null);

  // 7. "Open in Okular" without pdf-external-open spawns the configured command (a fake).
  await vscode.workspace.getConfiguration("vscodePdfMcp").update("externalViewer", process.env.VPDF_FAKE_VIEWER,
    vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand("vscodePdfMcp.openExternal");
  const log = path.join(tmp, "fake-okular.log");
  await waitFor(() => fs.existsSync(log) && fs.readFileSync(log, "utf8") === `${other}\n`, "fake viewer called with the PDF");

  // 8. Closing the tabs empties the state.
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor(() => backend.readStates(dir).find((s) => s.pid === process.pid)?.panels.length === 0, "no panels left");
  assert.throws(() => backend.viewerState({ dir }), { message: "no VS Code window with a PDF open" });

  await marking(ext);
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor(() => backend.readStates(dir).find((s) => s.pid === process.pid)?.panels.length === 0, "no panels left");

  await synctex(ext);
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor(() => backend.readStates(dir).find((s) => s.pid === process.pid)?.panels.length === 0, "no panels left");

  await sourceSync(ext);
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor(() => backend.readStates(dir).find((s) => s.pid === process.pid)?.panels.length === 0, "no panels left");
}

// ---- marking -----------------------------------------------------------------------

const me = os.userInfo().username;
const python = process.env.VPDF_PYTHON || "";
const helpers = path.join(__dirname, "..", "helpers");
/** @param {number} ms */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The PDF's annotations, read back with PyMuPDF.
 * @param {string} file @returns {Promise<{repaired: boolean, annots: any[]}>}
 */
function readPdf(file) {
  return new Promise((resolve, reject) => {
    execFile(python, ["-I", path.join(helpers, "read-annots.py"), file], (err, out, errOut) => {
      if (err) reject(new Error(`${err.message}\n${errOut}`));
      else resolve(JSON.parse(out));
    });
  });
}

/**
 * Resolve with the first truthy `fn(annots)` of the file on disk, polled.
 * @template T @param {string} file @param {(a: any[]) => T} fn @param {string} what
 * @returns {Promise<NonNullable<T>>}
 */
async function onDisk(file, fn, what, ms = 15000) {
  const end = Date.now() + ms;
  let last = null;
  for (;;) {
    try {
      last = (await readPdf(file)).annots;
      const v = fn(last);
      if (v) return /** @type {NonNullable<T>} */ (v);
    } catch {
      // caught mid-write: next round
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; annotations:\n${JSON.stringify(last, null, 1)}`);
    await delay(150);
  }
}

/** Untitled editors (what a key that reached VS Code would open). */
const untitled = () => vscode.workspace.textDocuments.filter((d) => d.uri.scheme === "untitled").length;

/** @param {any} ext */
async function marking(ext) {
  const editCommand = process.env.VSCODE_PDF_MCP_EDIT_COMMAND;
  const mcpCommand = process.env.VPDF_PRW_MCP;
  if (!editCommand || !python) {
    console.log("integration: marking SKIPPED: needs pdf-reader-writer-edit (VSCODE_PDF_MCP_EDIT_COMMAND or PATH) and VPDF_PYTHON");
    return;
  }
  console.log(`integration: marking through ${editCommand}`);
  const { chromium } = require("playwright-core");
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

  const pdf = path.join(workspace, "marks.pdf");
  fs.writeFileSync(pdf, samplePdf(3));
  await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(pdf));
  await waitFor(() => panelFor(pdf)?.pages === 3, "marks.pdf loaded");

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.VPDF_CDP_PORT}`);
  /** @type {any} */
  let client = null;
  if (mcpCommand) {
    client = new Client({ name: "vpdf-integration", version: "0" });
    await client.connect(new StdioClientTransport({ command: mcpCommand, stderr: "ignore" }));
  }
  try {
    // The webview's content frame (VS Code nests it in two iframes).
    const found = await webviewFrame(browser, "/ 3");
    const chrome = Number((process.versions.chrome || "999").split(".")[0]);
    if (found) {
      await markingUi(pdf, found.page, found.frame, client);
    } else if (chrome < 130) {
      // Playwright does not reach the webview's out-of-process iframe in old Electrons
      // (VS Code 1.90 has Chromium 122): the extension and service paths are still tested.
      console.log(`integration: marking UI SKIPPED: the webview is not reachable over CDP here (VS Code ${vscode.version}, Chromium ${chrome})`);
    } else {
      throw new Error("no webview frame for marks.pdf");
    }
    if (client) await concurrency(ext, client);
    else console.log("integration: concurrency SKIPPED: needs pdf-reader-writer-mcp (VPDF_PRW_MCP or PATH)");
  } finally {
    await client?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * The content frame of the webview whose page count reads `pagesText`, or null.
 * @param {import("playwright-core").Browser} browser @param {string} pagesText
 */
async function webviewFrame(browser, pagesText) {
  const end = Date.now() + 15000;
  for (;;) {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        for (const frame of page.frames()) {
          const n = await frame.evaluate(() => document.getElementById("numPages")?.textContent).catch(() => null);
          if (n === pagesText) return { page, frame };
        }
      }
    }
    if (Date.now() > end) return null;
    await delay(100);
  }
}

/**
 * Mouse actions in a PDF webview.
 * @param {import("playwright-core").Page} page @param {import("playwright-core").Frame} f
 */
function markActions(page, f) {
  /** Drag-select the text-layer span with `text` on `pageNo`. @param {number} pageNo @param {string} text */
  const select = async (pageNo, text) => {
    const span = f.locator(`.page[data-page-number='${pageNo}'] .textLayer span`).filter({ hasText: text }).first();
    await span.scrollIntoViewIfNeeded();
    const b = await span.boundingBox();
    assert.ok(b, `span ${text}`);
    await page.mouse.move(b.x + 1, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 6 });
    await page.mouse.up();
  };
  /**
   * Click the middle of annotation `xref` (its sections let the pointer through). Tried
   * again when a reload (the file changed, as after a sync) replaces the layer meanwhile.
   * @param {number} xref
   */
  const clickAnnot = async (xref) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const sec = f.locator(`.annotationLayer section[data-annotation-id='${xref}R']`).first();
        await sec.waitFor({ state: "attached", timeout: 15000 });
        await sec.scrollIntoViewIfNeeded({ timeout: 5000 });
        const b = await sec.boundingBox();
        assert.ok(b, `annotation ${xref} on screen`);
        await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
        await f.locator(`.popover:visible .item[data-id='${xref}R']`).waitFor({ timeout: attempt < 3 ? 5000 : 15000 });
        return;
      } catch (e) {
        if (attempt >= 3) throw e;
        await delay(500);
      }
    }
  };
  /** Click the blank right margin mid-view (closes popovers, focuses the viewer, not a text field). */
  const clickBlank = async () => {
    const p1 = await f.locator(".page[data-page-number='1']").boundingBox();
    const c = await f.locator("#viewerContainer").boundingBox();
    assert.ok(p1 && c);
    await page.mouse.click(p1.x + p1.width - 20, c.y + c.height / 2);
  };
  return { select, clickAnnot, clickBlank };
}

/**
 * Marking with real mouse and keyboard input in the webview.
 * @param {string} pdf @param {import("playwright-core").Page} page @param {import("playwright-core").Frame} f
 * @param {any} client the MCP client, or null
 */
async function markingUi(pdf, page, f, client) {
  await f.waitForSelector("#markTools .tool:not([disabled])", { timeout: 15000 });
  const { select, clickAnnot, clickBlank } = markActions(page, f);

  // 1. Select text: the selection reaches the state file and the hook (unchanged);
  //    mark it from the mini-bar: a /Highlight with /T = the login name and QuadPoints.
  await select(1, "Reachability of timed automata");
  const sel = await waitFor(() => panelFor(pdf)?.selection, "selection in the state file");
  assert.deepEqual(sel, { text: "Reachability of timed automata is decidable via regions.", page: 1 });
  const hook = hookOutput({ cwd: workspace }, backend.readStates(dir));
  assert.ok(hook);
  assert.match(JSON.parse(hook).hookSpecificOutput.additionalContext,
    /\nSelected text \(page 1\):\nReachability of timed automata is decidable via regions\.$/);
  await f.locator(".miniBar:visible .styleButton[data-style='highlight']").click();
  const hl = await onDisk(pdf, (a) => a.find((x) => x.subtype === "Highlight" && x.author === me), "the user's highlight");
  assert.ok(hl.quads >= 1, "QuadPoints");
  assert.deepEqual(hl.color, [1, 0.9, 0.3], "palette yellow, as pdf-reader-writer-mcp defines it");
  await waitFor(() => panelFor(pdf)?.selection === null, "selection cleared after marking");

  // 2. Reply to the agent's note: the reply is a Text annotation in its thread (IRT).
  let llmXref;
  if (client) {
    const r = await client.callTool({ name: "add_note", arguments: { path: pdf, page: 1, note: "Is this decidable?", near_text: "Unique marker alpha1" } });
    llmXref = (r.structuredContent?.result ?? r.structuredContent ?? JSON.parse(r.content[0].text)).xref;
  } else {
    // no MCP server: an agent note written with PyMuPDF directly
    llmXref = await new Promise((resolve, reject) => execFile(python, ["-I", "-c",
      "import sys,pymupdf;d=pymupdf.open(sys.argv[1]);a=d[0].add_text_annot((40,140),'Is this decidable?');a.set_info(title='llm');a.update();d.saveIncr();print(a.xref)", pdf],
    (e, out) => (e ? reject(e) : resolve(Number(out)))));
  }
  assert.ok(Number.isInteger(llmXref));
  await clickAnnot(llmXref);
  assert.equal(await f.locator(`.popover .item[data-id='${llmXref}R'] > .actions .editButton`).count(), 0, "not mine to edit");
  await f.locator(".popover .replyBox textarea").fill("Yes, via regions.");
  await f.locator(".popover .replyBox textarea").press("Enter");
  const reply = await onDisk(pdf, (a) => a.find((x) => x.subtype === "Text" && x.author === me && x.irt === llmXref), "the reply");
  assert.equal(reply.contents, "Yes, via regions.");
  // the thread shows the reply once the file has reloaded
  await f.locator(`.popover:visible .item[data-id='${llmXref}R'] .replies .item[data-id='${reply.xref}R']`).waitFor({ timeout: 15000 });

  // 3. Edit an own mark, undo it with Ctrl+Z; delete it, undo that. VS Code never sees
  //    the keys (bound there to "new untitled file").
  await clickBlank();
  await clickAnnot(hl.xref);
  await f.locator(`.popover .item[data-id='${hl.xref}R'] > .actions .editButton`).click();
  await f.locator(".popover textarea.editNote").fill("edited in VS Code");
  await f.locator(".popover textarea.editNote").press("Enter");
  await onDisk(pdf, (a) => a.find((x) => x.xref === hl.xref && x.contents === "edited in VS Code"), "the edited note");
  await clickBlank();
  await page.keyboard.press("Control+z");
  await onDisk(pdf, (a) => a.find((x) => x.xref === hl.xref && x.contents === ""), "the note undone");

  await clickAnnot(hl.xref);
  await f.locator(`.popover .item[data-id='${hl.xref}R'] > .actions .deleteButton`).click();
  await onDisk(pdf, (a) => !a.some((x) => x.subtype === "Highlight" && x.author === me) && a, "the highlight deleted");
  await clickBlank();
  await page.keyboard.press("Control+z");
  const back = await onDisk(pdf, (a) => a.find((x) => x.subtype === "Highlight" && x.author === me), "the highlight restored");
  assert.ok(back.quads >= 1);
  assert.deepEqual(back.color, [1, 0.9, 0.3]);

  // H marks the selection from the keyboard
  await select(1, "Filler line 3 on page 1");
  await page.keyboard.press("h");
  await onDisk(pdf, (a) => a.filter((x) => x.subtype === "Highlight" && x.author === me).length === 2, "a highlight from the H key");
  assert.equal(untitled(), 0, "VS Code did not act on Ctrl+Z or H");
  // control: a key the viewer does not handle does reach VS Code's keybindings
  await clickBlank();
  await page.keyboard.press("k");
  await waitFor(() => untitled() === 1, "the control key reached VS Code");
  await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
}

/**
 * The viewer and the MCP server write marks into one file at the same time; every mark
 * of both must be there. Both writers are warmed up first and released together, and the
 * test checks that their writes really interleaved. A control run against a writer that
 * skips the lock shows what the test catches (logged).
 * @param {any} ext @param {any} client
 */
async function concurrency(ext, client) {
  const N = 20;
  const GAP = 30;
  const { viewer } = ext.exports;
  const controller = viewer.marking.controller;
  const file = path.join(workspace, "concurrent.pdf");
  fs.writeFileSync(file, samplePdf(3));
  await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file));
  await waitFor(() => panelFor(file)?.pages === 3, "concurrent.pdf loaded");
  const panel = [...viewer.panels].find((p) => p.path === file);
  assert.ok(panel);
  // Filler line k of a page: baseline y = 720 - 14 * (5 + k).
  const rect = (/** @type {number} */ k) => [72, 720 - 14 * (5 + k) - 3, 300, 720 - 14 * (5 + k) + 10];
  /** A mark from the viewer, through the same message the webview sends. @param {number} k */
  const viewerMark = (k) => panel.onMessage({ type: "mark", reqId: 1000 + k, style: "underline", color: "green",
    parts: [{ page: 2, rects: [rect(k)], text: `Filler line ${k} on page 2.` }] });
  /** @param {number} k */
  const mcpMark = (k) => client.callTool({ name: "mark_text", arguments: { path: file, page: 3, text: `Filler line ${k} on page 3.`, color: "pink" } });

  // warm up both writers (processes started, PyMuPDF loaded), then go together
  assert.equal((await viewerMark(30)).ok, true);
  assert.equal((await mcpMark(30)).isError ?? false, false);
  /** @type {{side: string, t: number}[]} */
  const done = [];
  const t0 = Date.now();
  // Both sides write one mark after the other, at the same time, with a short gap after
  // each write (as even a fast user or agent has). Writers wait for the lock by polling it
  // every 20 ms, so a side writing back-to-back would hold the lock almost all the time and
  // the other would only get its turn after the burst: the writes would not interleave.
  await Promise.all([
    (async () => {
      for (let k = 1; k <= N; k++) {
        const r = await viewerMark(k);
        assert.equal(r.ok, true, r.error);
        done.push({ side: "viewer", t: Date.now() - t0 });
        await delay(GAP);
      }
    })(),
    (async () => {
      for (let k = 1; k <= N; k++) {
        const r = await mcpMark(k);
        assert.notEqual(r.isError, true, JSON.stringify(r.content));
        done.push({ side: "mcp", t: Date.now() - t0 });
        await delay(GAP);
      }
    })(),
  ]);
  const order = done.sort((a, b) => a.t - b.t).map((d) => (d.side === "viewer" ? "V" : "M")).join("");
  const switches = [...order].filter((c, i) => i && c !== order[i - 1]).length;
  console.log(`integration: concurrency: completion order ${order} (${switches} switches, ${done.at(-1)?.t} ms)`);
  assert.ok(switches >= 4, `the two writers interleaved (${order})`);
  const { repaired, annots } = await readPdf(file);
  assert.equal(repaired, false, "the file opens cleanly");
  assert.equal(annots.filter((a) => a.page === 2 && a.author === me && a.subtype === "Underline").length, N + 1, "every viewer mark");
  assert.equal(annots.filter((a) => a.page === 3 && a.author === "llm").length, N + 1, "every MCP mark");

  // Control: the same viewer burst against a writer that does not take the lock.
  const ctl = path.join(workspace, "control.pdf");
  fs.writeFileSync(ctl, samplePdf(3));
  await controller.mark(ctl, { parts: [{ page: 2, rects: [rect(30)] }], style: "underline" }); // warm
  const w = spawn(python, ["-I", path.join(helpers, "unlocked-writer.py"), ctl, "3", String(N)], { stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise((resolve) => w.once("exit", resolve));
  let out = "";
  w.stdout.setEncoding("utf8");
  w.stdout.on("data", (d) => (out += d));
  await new Promise((resolve) => w.stdout.once("data", resolve)); // "ready"
  w.stdin.write("go\n");
  let fulfilled = 0;
  for (let k = 1; k <= N; k++) {
    try {
      await controller.mark(ctl, { parts: [{ page: 2, rects: [rect(k)] }], style: "underline" });
      fulfilled++;
    } catch {
      // the racing writer broke the file for a moment
    }
    await delay(GAP);
  }
  await exited;
  const nolock = JSON.parse(out.trim().split("\n").pop() || "{}");
  let survived = "unreadable";
  let ctlRepaired = true;
  try {
    const r = await readPdf(ctl);
    ctlRepaired = r.repaired;
    survived = `${r.annots.filter((a) => a.author === me).length - 1}/${N} viewer, ${r.annots.filter((a) => a.author === "nolock").length}/${N} unlocked`;
  } catch {
    // corrupted beyond reading
  }
  console.log(`integration: control without the lock: viewer writes ok ${fulfilled}/${N}, `
    + `unlocked writer ok ${nolock.ok}/${N}; in the file: ${survived}; repaired: ${ctlRepaired}`);
}

// ---- SyncTeX ------------------------------------------------------------------------

/** @param {any} ext */
async function synctex(ext) {
  if (!process.env.VPDF_LATEX) {
    console.log("integration: SyncTeX SKIPPED: pdflatex is not installed");
    return;
  }
  const { chromium } = require("playwright-core");
  const { buildProject } = require("../helpers/latex");
  const latex = path.join(workspace, "latex");
  const pdf = path.join(latex, "main.pdf");
  const main = path.join(latex, "main.tex");
  const chapter = path.join(latex, "chapters", "one.tex");
  const { viewer } = ext.exports;
  const real = fs.realpathSync(pdf);

  // 1. Open the PDF; its SyncTeX data is parsed in the extension host.
  await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(pdf));
  await waitFor(() => panelFor(pdf)?.pages === 2, "main.pdf loaded");
  const data0 = await waitFor(() => viewer.synctex.peek(real), "SyncTeX data of main.pdf");
  const panel = [...viewer.panels].find((p) => p.path === pdf);
  const pdfColumn = panel.panel.viewColumn;

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.VPDF_CDP_PORT}`);
  try {
    const found = await webviewFrame(browser, "/ 2");
    const chrome = Number((process.versions.chrome || "999").split(".")[0]);
    if (!found && chrome >= 130) throw new Error("no webview frame for main.pdf");
    if (!found) console.log(`integration: SyncTeX mouse steps SKIPPED: the webview is not reachable over CDP here (Chromium ${chrome})`);
    const page = found?.page;
    const f = found?.frame;
    await f?.waitForFunction(() => document.body.classList.contains("synctex"), null, { timeout: 15000 });

    /** The client point of a SyncTeX point on a page of the webview. @param {number} pageNo @param {number} x @param {number} y */
    const clientPoint = async (pageNo, x, y) => {
      if (!f) throw new Error("no frame");
      const div = f.locator(`.page[data-page-number='${pageNo}']`);
      await div.scrollIntoViewIfNeeded();
      const box = await div.boundingBox();
      const g = await div.evaluate((el) => ({ l: el.clientLeft, t: el.clientTop, w: el.clientWidth }));
      assert.ok(box);
      const scale = g.w / 595.276; // A4
      return { x: box.x + g.l + x * scale, y: box.y + g.t + y * scale };
    };
    /** Ctrl+click the middle of `file`:`line`'s first stretch; resolves with the line expected there. @param {any} data @param {string} file @param {number} line */
    const ctrlClickLine = async (data, file, line) => {
      const v = data.view(file, line);
      assert.ok(v, `${file}:${line} in the SyncTeX data`);
      const [l, t, r, b] = v.rects[0];
      const sx = (l + r) / 2;
      const sy = t + (b - t) * 0.6;
      const expected = data.edit(v.page, sx, sy);
      const at = await clientPoint(v.page, sx, sy);
      await /** @type {any} */ (page).keyboard.down("Control");
      await /** @type {any} */ (page).mouse.click(at.x, at.y);
      await /** @type {any} */ (page).keyboard.up("Control");
      return expected;
    };

    // 2. Ctrl+hover over the \input file's text: the underline and the tip naming it.
    if (f && page) {
      const v = data0.view(chapter, 2);
      const [l, t, r, b] = v.rects[0];
      const at = await clientPoint(v.page, (l + r) / 2, t + (b - t) * 0.6);
      await page.mouse.move(at.x - 20, at.y);
      await page.keyboard.down("Control");
      await page.mouse.move(at.x, at.y, { steps: 4 });
      const tip = f.locator(".synctexTip:not([hidden])");
      await tip.waitFor({ timeout: 5000 });
      assert.match(await tip.innerText(), /chapters\/one\.tex:2/);
      assert.ok(await f.locator(".synctexHover .bar").count() > 0, "the underline");
      // the webview may not have the focus (then it sees no keys): the next move tells it
      await page.keyboard.up("Control");
      await page.mouse.move(at.x + 1, at.y);
      await f.locator(".synctexTip").waitFor({ state: "hidden", timeout: 5000 });
    }

    // 3. Ctrl+click on the \input file's text opens it at that line, beside the PDF.
    if (f) {
      const hit = await ctrlClickLine(data0, chapter, 2);
      assert.deepEqual([hit.file, hit.line], [chapter, 2]);
      const ed = await waitFor(() => {
        const e = vscode.window.activeTextEditor;
        return e && e.document.uri.fsPath === chapter && e.selection.active.line === 1 ? e : null;
      }, "chapters/one.tex open at line 2");
      assert.notEqual(ed.viewColumn, pdfColumn, "not in the PDF tab's group");
      assert.ok(panel.panel.visible, "the PDF stays visible");
    }

    // 3. Forward search with the command, from a .tex editor at the cursor: page 2.
    const doc = await vscode.workspace.openTextDocument(main);
    const mainEd = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Two });
    mainEd.selection = new vscode.Selection(33, 3, 33, 3); // line 34: text on the second page
    const e1 = await vscode.commands.executeCommand("vscodePdfMcp.synctexForward");
    assert.deepEqual([/** @type {any} */ (e1)?.path, /** @type {any} */ (e1)?.page], [pdf, 2]);
    await waitFor(() => panelFor(pdf)?.page === 2, "page 2 after the forward search");
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, main, "the .tex editor keeps the focus");
    if (f) await f.locator(".synctexFlash .bar").first().waitFor({ timeout: 5000 });

    // 4. vscode-pdf-mcp-open, as LaTeX Workshop calls it: back to page 1 (\input file, line 3).
    const cli = (/** @type {string[]} */ args) => new Promise((resolve) => {
      execFile(process.execPath, [path.join(__dirname, "..", "..", "bin", "open.js"), ...args],
        { env: { ...process.env, VSCODE_PDF_MCP_DIR: dir } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    });
    let out = /** @type {any} */ (await cli(["--tex", chapter, "--line", "3", pdf]));
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout, `${pdf}: page 1 of 2\n`);
    await waitFor(() => panelFor(pdf)?.page === 1, "page 1 after vscode-pdf-mcp-open --tex");
    out = await cli([pdf]);
    assert.equal(out.code, 0, out.stderr);
    out = await cli(["--tex", path.join(latex, "nope.tex"), "--line", "3", pdf]);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /is not in the SyncTeX data of/);

    // 4b. Word level, both ways (the page-2 line that repeats "model", the three-line caption).
    if (f && page) await wordLevel({ f, page, main, pdf, mainEd });
    // 4c. The same from the .tex editor's right-click menu.
    if (f && page) await contextMenu({ f, page, main, pdf, mainEd });

    // 5. A selection: its source lines in the state file (C2 tex) and the hook (C7 Source).
    if (f && page) {
      const first = f.locator(".page[data-page-number='1'] .textLayer span").filter({ hasText: "This text comes" }).first();
      const last = f.locator(".page[data-page-number='1'] .textLayer span").filter({ hasText: "line too" }).last();
      await first.scrollIntoViewIfNeeded();
      const a = await first.boundingBox();
      const b = await last.boundingBox();
      assert.ok(a && b);
      await page.mouse.move(a.x + 1, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 8 });
      await page.mouse.up();
      const sel = await waitFor(() => panelFor(pdf)?.selection?.tex && panelFor(pdf)?.selection, "a selection with tex");
      assert.match(sel.text, /^This text comes from an input file\. It has a second source line too\.?$/);
      assert.deepEqual(sel.tex, [{ file: chapter, lines: [2, 3] }]);
      assert.deepEqual(backend.getSelection("primary", { dir }).tex, [{ file: chapter, lines: [2, 3] }]);
    }
    // the hook only speaks for the active editor: make the PDF tab active
    panel.panel.reveal(panel.panel.viewColumn, false);
    await waitFor(() => panelFor(pdf)?.active, "main.pdf active");
    if (f) {
      const hook = hookOutput({ cwd: workspace }, backend.readStates(dir));
      assert.ok(hook);
      assert.match(JSON.parse(hook).hookSpecificOutput.additionalContext, /\nSource: latex\/chapters\/one\.tex:2-3$/);
    }

    // 6. Rebuild with three lines more at the top of the \input file: the PDF reloads in
    //    place and the SyncTeX data is refreshed (the same text is now line 5).
    const before = panelFor(pdf);
    buildProject(latex, { extraChapterLines: "% one\n% two\n% three" });
    const data1 = await waitFor(() => {
      const d = viewer.synctex.peek(real);
      return d && d !== data0 && d.view(chapter, 5)?.page === 1 ? d : null;
    }, "SyncTeX data refreshed after the rebuild");
    assert.equal(data1.edit(1, ...mid(data1.view(chapter, 5).rects[0]))?.line, 5);
    assert.deepEqual([panelFor(pdf)?.page, panelFor(pdf)?.pages], [before?.page, 2], "the view is kept");
    if (f) {
      const hit = await ctrlClickLine(data1, chapter, 5);
      assert.equal(hit.line, 5);
      await waitFor(() => {
        const e = vscode.window.activeTextEditor;
        return e && e.document.uri.fsPath === chapter && e.selection.active.line === 4;
      }, "chapters/one.tex at line 5 after the rebuild");
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * The PDF webview's page-2 words and flashes, for the word-level checks.
 * @param {import("playwright-core").Frame} f @param {import("playwright-core").Page} page
 */
function pdfWords(f, page) {
  /**
   * The frame-client box of the `nth` `word` in the text-layer span of page 2 that contains `text`.
   * @param {string} text @param {string} word @param {number} [nth]
   */
  const wordRect = (text, word, nth = 0) => f.evaluate(([text, word, nth]) => {
    const span = [...document.querySelectorAll(".page[data-page-number='2'] .textLayer span")]
      .find((e) => (e.textContent || "").includes(String(text)));
    const node = span?.firstChild;
    if (!node) return null;
    let at = -1;
    for (let i = 0; i <= Number(nth); i++) at = String(node.textContent).indexOf(String(word), at + 1);
    if (at < 0) return null;
    const r = document.createRange();
    r.setStart(node, at);
    r.setEnd(node, at + String(word).length);
    const b = r.getBoundingClientRect();
    return { x: b.left, y: b.top, width: b.width, height: b.height };
  }, /** @type {[string, string, number]} */ ([text, word, nth]));
  const clearFlash = () => f.evaluate(() => document.querySelector(".synctexFlash")?.replaceChildren());
  /** The flash's bars (frame-client boxes), once there. */
  const flashed = async () => {
    const h = await f.waitForFunction(() => {
      const bars = [...document.querySelectorAll(".synctexFlash .bar")];
      return bars.length ? bars.map((b) => {
        const r = b.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      }) : null;
    }, null, { timeout: 5000 });
    return /** @type {{x: number, y: number, width: number, height: number}[]} */ (await h.jsonValue());
  };
  /** @param {any} bars @param {any} word @param {string} what */
  const onWord = (bars, word, what) => {
    assert.ok(word, `${what}: the word in the text layer`);
    assert.equal(bars.length, 1, `${what}: one bar ${JSON.stringify(bars)}`);
    const [b] = bars;
    assert.ok(Math.abs(b.x - word.x) < 3 && Math.abs(b.width - word.width) < 3 && Math.abs(b.y + b.height / 2 - (word.y + word.height / 2)) < word.height,
      `${what}: flash ${JSON.stringify(b)} on the word ${JSON.stringify(word)}`);
  };
  /** Ctrl+click the middle of a frame-client box. @param {any} box */
  const ctrlClick = async (box) => {
    const div = f.locator(".page[data-page-number='2']");
    const outer = await div.boundingBox();
    const inner = await div.evaluate((el) => el.getBoundingClientRect().toJSON());
    assert.ok(outer && box);
    const x = box.x + box.width / 2 + outer.x - inner.left;
    const y = box.y + box.height / 2 + outer.y - inner.top;
    await page.keyboard.down("Control");
    await page.mouse.click(x, y);
    await page.keyboard.up("Control");
  };
  return { wordRect, clearFlash, flashed, onWord, ctrlClick };
}

/**
 * Word-level SyncTeX in the real viewer: (a) the command from a cursor on a word flashes
 * that word; (b) Ctrl+click on a word puts the cursor on it; (c) a request without a
 * column (as from LaTeX Workshop) takes the cursor's column; (d) a caption's word, whose
 * text SyncTeX gives the argument's last line, both ways.
 * @param {{f: import("playwright-core").Frame, page: import("playwright-core").Page, main: string, pdf: string,
 *   mainEd: vscode.TextEditor}} ctx
 */
async function wordLevel({ f, page, main, pdf, mainEd }) {
  const lines = fs.readFileSync(main, "utf8").split("\n");
  const repeated = lines.findIndex((l) => l.startsWith("The word model appears twice")) + 1;
  const caption = lines.findIndex((l) => l.startsWith("\\caption{")) + 1;
  assert.ok(repeated > 0 && caption > 0);
  const { wordRect, clearFlash, flashed, onWord, ctrlClick } = pdfWords(f, page);
  /** The editor of `main` once its cursor is at `line` (1-based), `column`. @param {number} line @param {number} column @param {string} what */
  const cursorAt = (line, column, what) => waitFor(() => {
    const e = vscode.window.activeTextEditor;
    return e && e.document.uri.fsPath === main && e.selection.active.line === line - 1 && e.selection.active.character === column ? e : null;
  }, what, 5000);

  // (a) the command from the cursor on the second "model" (`a model of the`): that word
  const second = lines[repeated - 1].indexOf("model of the");
  const ed0 = await vscode.window.showTextDocument(mainEd.document, { viewColumn: mainEd.viewColumn });
  ed0.selection = new vscode.Selection(repeated - 1, second + 2, repeated - 1, second + 2);
  await clearFlash();
  const e1 = /** @type {any} */ (await vscode.commands.executeCommand("vscodePdfMcp.synctexForward"));
  assert.equal(e1?.page, 2);
  onWord(await flashed(), await wordRect("model of the model", "model", 0), "(a) the command");

  // (b) Ctrl+click on the third "model" (`model checker`): the cursor on it
  await ctrlClick(await wordRect("model of the model", "model", 1));
  const third = lines[repeated - 1].indexOf("model checker");
  await cursorAt(repeated, third, "(b) Ctrl+click puts the cursor on the word");

  // (c) no column (LaTeX Workshop): the cursor of the editor on that line gives it; now on
  //     the third "model" after (b)
  await clearFlash();
  const e2 = await backend.synctexForward({ tex: main, line: repeated, pdf }, { dir });
  assert.equal(e2.page, 2);
  onWord(await flashed(), await wordRect("model of the model", "model", 1), "(c) the cursor's column");
  //     and on another line of the file (no cursor there): the line, not a word
  await clearFlash();
  await backend.synctexForward({ tex: main, line: repeated - 1, pdf }, { dir });
  const bars = await flashed();
  const word = await wordRect("model of the model", "model", 1);
  assert.ok(bars.reduce((w, b) => w + b.width, 0) > 3 * word.width, `(c) the line: ${JSON.stringify(bars)}, a word ${word.width} wide`);

  // (d) the caption: Ctrl+click on "zeppelin" (SyncTeX: the argument's last line) goes to
  //     its own line and column; forward search from "several" flashes that word
  await ctrlClick(await wordRect("zeppelin", "zeppelin"));
  await cursorAt(caption + 1, lines[caption].indexOf("zeppelin"), "(d) Ctrl+click on a caption's word");
  const ed = /** @type {vscode.TextEditor} */ (vscode.window.activeTextEditor);
  const several = lines[caption - 1].indexOf("several");
  ed.selection = new vscode.Selection(caption - 1, several + 1, caption - 1, several + 1);
  await clearFlash();
  await vscode.commands.executeCommand("vscodePdfMcp.synctexForward");
  onWord(await flashed(), await wordRect("spans several", "several"), "(d) forward search from a caption's first line");
}

/** The entry in the editor context menu: the title only (the palette shows "SyncTeX: Show in PDF"; VS Code drops the category in context menus). */
const MENU_ENTRY = /^Show in PDF$/;

/**
 * "SyncTeX: Show in PDF" in a text editor's right-click menu, with the real mouse: (e) on
 * a word, the right-click puts the cursor there and the entry flashes that word; (f)
 * inside a two-word selection, the selection stays and both words flash; (g) a Markdown
 * editor's menu has no such entry.
 * @param {{f: import("playwright-core").Frame, page: import("playwright-core").Page, main: string, pdf: string,
 *   mainEd: vscode.TextEditor}} ctx
 */
async function contextMenu({ f, page, main, pdf, mainEd }) {
  const lines = fs.readFileSync(main, "utf8").split("\n");
  const prefix = "The word model appears twice";
  const line = lines.findIndex((l) => l.startsWith(prefix));
  assert.ok(line >= 0);
  const text = lines[line];
  const { wordRect, clearFlash, flashed, onWord } = pdfWords(f, page);
  /**
   * The page box of characters [from, to) of the one visible editor line starting with
   * `start`, once rendered, not covered (by the minimap, say) and in the same place twice
   * 100 ms apart (the layout settles after a bar closes).
   * Spaces may be drawn as nbsp, or as dots in a selection.
   * @param {string} start @param {number} from @param {number} to
   */
  const editorRect = async (start, from, to) => {
    const end = Date.now() + 5000;
    let last = "";
    for (;;) {
      const v = await page.evaluate(([start, from, to]) => {
        const norm = (/** @type {string} */ s) => s.replace(/[\u00a0\u00b7\u2e31]/g, " ");
        const shown = [...document.querySelectorAll(".monaco-editor .view-line")].filter((l) => l.getClientRects().length);
        const found = shown.filter((l) => norm(l.textContent || "").startsWith(String(start)));
        if (found.length !== 1) return { why: `${found.length} lines`, lines: shown.map((l) => l.textContent) };
        const walk = document.createTreeWalker(found[0], NodeFilter.SHOW_TEXT);
        const r = document.createRange();
        let at = 0;
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const len = String(n.textContent).length;
          if (Number(from) >= at && Number(from) < at + len) r.setStart(n, Number(from) - at);
          if (Number(to) > at && Number(to) <= at + len) r.setEnd(n, Number(to) - at);
          at += len;
        }
        const b = r.getBoundingClientRect();
        const box = { x: b.left, y: b.top, width: b.width, height: b.height };
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return b.width && hit && found[0].contains(hit) ? { box } : { why: "covered", box, hit: hit?.outerHTML.slice(0, 200) };
      }, /** @type {[string, number, number]} */ ([start, from, to]));
      if (v.box && !v.why && JSON.stringify(v.box) === last) return v.box;
      last = JSON.stringify(v.box);
      if (Date.now() > end) throw new Error(`no editor line starting "${start}" to right-click: ${JSON.stringify(v)}`);
      await delay(100);
    }
  };
  const menu = page.locator(".monaco-menu").first();
  /** Right-click the middle of a page box; resolves with the menu's labels. @param {{x: number, y: number, width: number, height: number}} box */
  const rightClick = async (box) => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    await menu.locator(".action-label").first().waitFor({ timeout: 5000 });
    await delay(250); // menu items take a mouse-up only 100 ms after they render
    return menu.locator(".action-item .action-label").allInnerTexts();
  };
  const closeMenu = async () => {
    await page.keyboard.press("Escape");
    await page.locator(".monaco-menu").waitFor({ state: "detached", timeout: 5000 });
  };
  /** Click the entry; it must be there. @param {string[]} labels @param {string} what */
  const choose = async (labels, what) => {
    assert.ok(labels.some((l) => MENU_ENTRY.test(l)), `${what}: the entry in the menu ${JSON.stringify(labels)}`);
    await menu.locator(".action-item .action-label", { hasText: MENU_ENTRY }).click();
    await page.locator(".monaco-menu").waitFor({ state: "detached", timeout: 5000 });
  };
  /** The PDF back on page 1, unflashed, so the entry has to bring page 2. */
  const reset = async () => {
    await backend.goto(1, pdf, { dir });
    await waitFor(() => panelFor(pdf)?.page === 1, "main.pdf on page 1");
    await clearFlash();
  };

  // (e) a right-click on "appears" (cursor elsewhere): the cursor moves to it, the entry
  //     flashes it on page 2
  //     (no chat or side bar: room for the line beside the PDF)
  await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
  await vscode.commands.executeCommand("workbench.action.closeSidebar");
  const ed = await vscode.window.showTextDocument(mainEd.document, { viewColumn: mainEd.viewColumn });
  ed.selection = new vscode.Selection(line - 3, 0, line - 3, 0);
  ed.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
  await reset();
  const appears = text.indexOf("appears");
  const labels = await rightClick(await editorRect(prefix, appears, appears + "appears".length));
  await choose(labels, "(e)");
  await waitFor(() => {
    const e = vscode.window.activeTextEditor;
    const c = e?.selection.active;
    return e?.document.uri.fsPath === main && e.selection.isEmpty && c?.line === line && c.character >= appears && c.character <= appears + 7;
  }, "(e) the right-click puts the cursor on the word", 5000);
  onWord(await flashed(), await wordRect("appears", "appears"), "(e) the menu entry");
  await waitFor(() => panelFor(pdf)?.page === 2, "(e) page 2 after the menu entry");

  // (f) "appears twice" selected, a right-click on "twice": the selection stays, both flash
  const from = text.indexOf("appears twice");
  const to = from + "appears twice".length;
  const sel = new vscode.Selection(line, from, line, to);
  ed.selection = sel;
  await reset();
  await choose(await rightClick(await editorRect(prefix, to - "twice".length, to)), "(f)");
  assert.ok(ed.selection.isEqual(sel), `(f) the selection stays: ${JSON.stringify(ed.selection)}`);
  const bars = await flashed();
  const words = [await wordRect("appears", "appears"), await wordRect("twice", "twice")];
  for (const w of words) {
    assert.ok(w, "(f) the word in the text layer");
    assert.ok(bars.some((b) => b.x < w.x + 3 && b.x + b.width > w.x + w.width - 3 && Math.abs(b.y + b.height / 2 - (w.y + w.height / 2)) < w.height),
      `(f) a bar ${JSON.stringify(bars)} on ${JSON.stringify(w)}`);
  }
  const width = words.reduce((s, w) => s + (w?.width || 0), 0);
  assert.ok(bars.reduce((s, b) => s + b.width, 0) < 1.5 * width, `(f) the two words, not the line: ${JSON.stringify(bars)}`);
  await waitFor(() => panelFor(pdf)?.page === 2, "(f) page 2 after the menu entry");

  // (g) a Markdown file: the menu (with Copy) but not the entry
  const notes = path.join(workspace, "notes.md");
  fs.writeFileSync(notes, "Plain notes, not TeX at all.\n");
  await vscode.window.showTextDocument(vscode.Uri.file(notes), { viewColumn: mainEd.viewColumn });
  const other = await rightClick(await editorRect("Plain notes", 6, 11));
  assert.ok(other.some((l) => /^Copy\b/.test(l)), `(g) the menu ${JSON.stringify(other)}`);
  assert.ok(!other.some((l) => MENU_ENTRY.test(l)), `(g) no entry in a .md editor's menu ${JSON.stringify(other)}`);
  await closeMenu();
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  fs.rmSync(notes);
}

// ---- marks into the LaTeX source -----------------------------------------------------

/** `\pdfmark[opts]{text}{note}` in LaTeX source, parsed (no nested braces). @param {string} text */
const pdfmarks = (text) => [...text.matchAll(/\\pdfmark\[([^\]]*)\]\{([^{}]*)\}\{([^{}]*)\}/g)]
  .map((m) => ({ id: (/(?:^|,)id=([^,]+)/.exec(m[1]) || [])[1] || "", opts: m[1], text: m[2], note: m[3] }));

/**
 * Marks copied into the LaTeX source as they are made (the edit service's `sync`), with
 * the real mouse on a document that loads pdfnotes, the source open in an editor: (a) a
 * highlight becomes a `\pdfmark` with an id, which is the annotation's /NM, and the editor
 * shows it; (b) a note on it is the macro's note; (c) deleting it removes the macro; (d)
 * Ctrl+Z brings it back with the same id; (e) while the source has unsaved changes nothing
 * is written, and once it is saved the sync runs.
 * @param {any} ext
 */
async function sourceSync(ext) {
  const editCommand = process.env.VSCODE_PDF_MCP_EDIT_COMMAND;
  const skip = (/** @type {string} */ why) => console.log(`integration: marks into the LaTeX source SKIPPED: ${why}`);
  if (!editCommand || !python) return skip("needs pdf-reader-writer-edit and VPDF_PYTHON");
  if (!process.env.VPDF_LATEX) return skip("pdflatex is not installed");
  const { viewer } = ext.exports;
  const probe = await viewer.marking.probe();
  if (!probe.ok || probe.version < 2) return skip(`the edit service speaks protocol ${probe.version ?? "?"}, sync needs 2`);
  const kpse = (/** @type {string} */ f) => (spawnSync("kpsewhich", [f], { encoding: "utf8" }).stdout || "").trim();
  /** @type {NodeJS.ProcessEnv} */
  let env = process.env;
  const styDir = process.env.VPDF_PDFNOTES_DIR || "";
  if (styDir && fs.existsSync(path.join(styDir, "pdfnotes.sty"))) {
    env = { ...process.env, TEXINPUTS: `${styDir}${path.delimiter}${process.env.TEXINPUTS || ""}` };
  } else if (!kpse("pdfnotes.sty")) {
    return skip("pdfnotes.sty not found (VPDF_PDFNOTES_DIR, a pdf-reader-writer-mcp checkout next to this one, or kpsewhich)");
  }
  if (!kpse("todonotes.sty")) return skip("todonotes is not installed");
  const { compile } = require("../helpers/latex");
  const { chromium } = require("playwright-core");

  const proj = path.join(workspace, "notes");
  const main = path.join(proj, "main.tex");
  const pdf = path.join(proj, "main.pdf");
  const FIRST = "Reachability of timed automata is decidable via regions.";
  const SECOND = "A second sentence stands in a paragraph of its own.";
  compile(proj, { "main.tex": [
    "\\documentclass[11pt]{article}",
    "\\usepackage{todonotes}",
    "\\usepackage{pdfnotes}",
    "\\begin{document}",
    "\\section{Marks}",
    FIRST,
    "",
    SECOND,
    "\\end{document}",
    "",
  ].join("\n") }, "main.tex", { runs: 2, env });
  const real = fs.realpathSync(pdf);
  const source = () => fs.readFileSync(main, "utf8");
  const original = source();
  /** The file on disk once `fn(its \pdfmarks, text)` holds. @param {(m: ReturnType<typeof pdfmarks>, t: string) => any} fn @param {string} what */
  const onSource = (fn, what) => waitFor(() => fn(pdfmarks(source()), source()) && source(), `${what}; main.tex:\n${source()}`);

  // the source open in an editor, unchanged: it follows what the sync writes
  const doc = await vscode.workspace.openTextDocument(main);
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Two, preview: false });
  await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(pdf), { viewColumn: vscode.ViewColumn.One });
  await waitFor(() => panelFor(pdf)?.pages === 1, "notes/main.pdf loaded");
  await waitFor(() => viewer.synctex.peek(real), "SyncTeX data of notes/main.pdf");

  // count the syncs: one per action, none from the reloads they cause (they write the /NM)
  const ss = viewer.marking.sourceSync;
  const request = ss.hooks.request;
  let syncs = 0;
  ss.hooks.request = (/** @type {string} */ p) => {
    syncs++;
    return request(p);
  };
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.VPDF_CDP_PORT}`);
  try {
    const found = await webviewFrame(browser, "/ 1");
    if (!found) return skip(`the webview is not reachable over CDP here (VS Code ${vscode.version})`);
    const { page, frame: f } = found;
    await f.waitForSelector("#markTools .tool:not([disabled])", { timeout: 15000 });
    const { select, clickAnnot, clickBlank } = markActions(page, f);

    // (a) highlight the first sentence: a \pdfmark around it, its id in the annotation's /NM
    await select(1, FIRST);
    await f.locator(".miniBar:visible .styleButton[data-style='highlight']").click();
    await onSource((m) => m.length === 1 && m[0].text === FIRST && m[0].id, "(a) a \\pdfmark around the highlighted words");
    const [mark] = pdfmarks(source());
    assert.match(mark.opts, new RegExp(`author=${me}`));
    assert.equal(mark.note, "");
    const hl = await onDisk(pdf, (a) => a.find((x) => x.subtype === "Highlight" && x.nm === `pdfnotes:${mark.id}`), "(a) the /NM");
    assert.equal(source(), original.replace(FIRST, `\\pdfmark[${mark.opts}]{${FIRST}}{}`), "(a) nothing else changed");
    await waitFor(() => doc.getText() === source() && !doc.isDirty, "(a) the open editor shows the macro");
    await delay(1000);
    assert.equal(syncs, 1, "(a) one sync, and none after the reload it caused");

    // (b) a note on it: the macro's note
    await clickAnnot(hl.xref);
    await f.locator(`.popover .item[data-id='${hl.xref}R'] > .actions .editButton`).click();
    await f.locator(".popover textarea.editNote").fill("Cite the region construction.");
    await f.locator(".popover textarea.editNote").press("Enter");
    await onSource((m) => m.length === 1 && m[0].id === mark.id && m[0].note === "Cite the region construction.", "(b) the note in the macro");

    // (c) delete it: the macro goes, the words stay
    await clickBlank();
    await clickAnnot(hl.xref);
    await f.locator(`.popover .item[data-id='${hl.xref}R'] > .actions .deleteButton`).click();
    await onSource((m, t) => m.length === 0 && t === original, "(c) the macro removed");

    // (d) Ctrl+Z: the mark is back, and so is its macro, with the same id and note
    await clickBlank();
    await page.keyboard.press("Control+z");
    await onSource((m) => m.length === 1 && m[0].id === mark.id && m[0].text === FIRST && m[0].note === "Cite the region construction.",
      "(d) the macro back after undo");
    await onDisk(pdf, (a) => a.find((x) => x.subtype === "Highlight" && x.nm === `pdfnotes:${mark.id}`), "(d) the restored /NM");
    await waitFor(() => doc.getText() === source(), "(d) the editor follows");

    // (e) unsaved changes in the source: a mark is not written into it until it is saved
    const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Two, preserveFocus: true });
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    assert.ok(await ed.edit((b) => b.insert(end, "% an unsaved line\n")));
    assert.ok(doc.isDirty);
    const before = source();
    await select(1, SECOND);
    await f.locator(".miniBar:visible .styleButton[data-style='highlight']").click();
    await onDisk(pdf, (a) => a.filter((x) => x.subtype === "Highlight" && x.author === me).length === 2, "(e) the second highlight");
    await waitFor(() => viewer.marking.sourceSync.isPending(real), "(e) the sync pending");
    await delay(1500);
    assert.equal(source(), before, "(e) the source untouched while unsaved");
    assert.ok(viewer.marking.sourceSync.isPending(real));
    assert.ok(await doc.save());
    const saved = await onSource((m) => m.length === 2 && m.some((x) => x.text === SECOND), "(e) the macro after saving");
    assert.match(saved, /% an unsaved line\n$/, "(e) the saved edit kept");
    assert.equal(viewer.marking.sourceSync.isPending(real), false);
    await waitFor(() => doc.getText() === source() && !doc.isDirty, "(e) the editor follows");
    await delay(1000);
    assert.equal(syncs, 5, "one sync per action");
  } finally {
    ss.hooks.request = request;
    await browser.close().catch(() => {});
  }
}

/** The middle of a rect, as [x, y]. @param {number[]} r @returns {[number, number]} */
const mid = (r) => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];

module.exports = { run };
