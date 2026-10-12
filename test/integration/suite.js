// @ts-check
/**
 * Runs inside the VS Code extension host (see run.js). Drives the real custom editor and
 * checks the state file, goto over the socket, reload on disk change, the hook and
 * "Open in Okular" (against a fake command).
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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
}

module.exports = { run };
