#!/usr/bin/env node
// @ts-check
/**
 * Integration test in a real VS Code (downloaded by @vscode/test-electron into
 * .vscode-test/, with a scratch user-data and extensions dir), under xvfb-run so no window
 * appears on the desktop. Skipped (exit 0, with a message) when xvfb-run is not installed.
 *
 *   npm run test:integration          [VSCODE_VERSION=1.90.0 to pin the VS Code under test]
 *
 * VS Code runs with a remote-debugging port, so the suite drives the webview with real
 * mouse and keyboard input (playwright-core over CDP). The marking part needs
 * pdf-reader-writer-mcp: its edit service (VSCODE_PDF_MCP_EDIT_COMMAND, else
 * `pdf-reader-writer-edit` on PATH), its MCP server for the concurrency test (VPDF_PRW_MCP,
 * else `pdf-reader-writer-mcp` on PATH) and a Python with pymupdf to read the PDFs back
 * (VPDF_PYTHON, else the Python of the edit service's own environment). Without them that
 * part is skipped, with a message. Marks into the LaTeX source also need protocol 2 of the
 * edit service and pdfnotes.sty: VPDF_PDFNOTES_DIR (a directory with it), else the latex/
 * directory of a pdf-reader-writer-mcp checkout next to this one or of the source tree the
 * edit service was installed from, else wherever kpsewhich finds it (test/helpers/prw.js).
 * The run ends with one line per part, ran or SKIPPED; VPDF_STRICT=1 turns a skip into a
 * failure.
 *
 * Nothing of the user's VS Code is used: the user-data and extensions dirs, the extension's
 * state dir (VSCODE_PDF_MCP_DIR) and the workspace are all in a fresh temp dir, VS Code's
 * own variables of a calling VS Code terminal are dropped, and the suite checks all of it.
 */
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { which } = require("../../lib/backend");

const root = path.resolve(__dirname, "../..");

if (!process.env.VPDF_UNDER_XVFB) {
  const xvfb = which("xvfb-run", process.env);
  if (!xvfb) {
    process.stdout.write("integration test SKIPPED: xvfb-run is not installed (it must not open a window on the desktop)\n");
    process.exit(0);
  }
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, VPDF_UNDER_XVFB: "1" };
  // Make sure Electron uses the Xvfb display, never the user's Wayland session: without
  // WAYLAND_DISPLAY it still picks Wayland from XDG_SESSION_TYPE and connects to the
  // default socket, so the window showed on the desktop. X11 is pinned below as well.
  delete env.WAYLAND_DISPLAY;
  delete env.ELECTRON_OZONE_PLATFORM_HINT;
  delete env.XDG_SESSION_TYPE;
  delete env.DISPLAY;
  // Run from a VS Code terminal, the environment names that VS Code's IPC handles; the
  // VS Code under test must not see them (nor run as plain Node).
  for (const k of Object.keys(env)) {
    if ((k.startsWith("VSCODE_") && !k.startsWith("VSCODE_PDF_MCP_") && k !== "VSCODE_VERSION") || k.startsWith("ELECTRON_")) delete env[k];
  }
  const r = spawnSync(xvfb, ["-a", "-s", "-screen 0 1280x900x24", process.execPath, __filename], { env, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const { runTests } = require("@vscode/test-electron");
const { samplePdf } = require("../helpers/pdf");
const { HAVE_PDFLATEX, buildProject } = require("../helpers/latex");
const { findPrw } = require("../helpers/prw");

/** A free TCP port on 127.0.0.1. @returns {Promise<number>} */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {net.AddressInfo} */ (srv.address());
      srv.close(() => resolve(port));
    });
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vpdf-int-"));
  const cdpPort = await freePort();
  const { editCommand, mcpCommand, python, pdfnotesDir } = findPrw(process.env, root);
  // Keys the viewer handles are bound in VS Code too, to a visible command: if the viewer
  // let one through, an untitled editor would appear. "k" (not the viewer's) is the control.
  const user = path.join(tmp, "user-data", "User");
  fs.mkdirSync(user, { recursive: true });
  const when = "activeCustomEditorId == 'vscodePdfMcp.viewer'";
  fs.writeFileSync(path.join(user, "keybindings.json"), JSON.stringify(["ctrl+z", "h", "k"].map((key) =>
    ({ key, command: "workbench.action.files.newUntitledFile", when }))));
  // Menus drawn in the workbench DOM, not by the OS, so the suite can right-click an editor
  // and pick from its context menu (window.menuStyle, where this VS Code has it).
  fs.writeFileSync(path.join(user, "settings.json"), JSON.stringify({ "window.titleBarStyle": "custom", "window.menuStyle": "custom" }));
  const workspace = path.join(tmp, "workspace");
  const stateDir = path.join(tmp, "state");
  fs.mkdirSync(workspace);
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.writeFileSync(path.join(workspace, "paper.pdf"), samplePdf(5));
  fs.writeFileSync(path.join(workspace, "other.pdf"), samplePdf(2, "other"));
  fs.writeFileSync(path.join(workspace, "broken.pdf"), "%PDF-1.4\nthis is not a PDF\n");
  // SyncTeX: a multi-file LaTeX project compiled with pdflatex -synctex=1 (skipped without pdflatex)
  if (HAVE_PDFLATEX) buildProject(path.join(workspace, "latex"));
  const fake = path.join(tmp, "fake-okular");
  fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${path.join(tmp, "fake-okular.log")}'\n`, { mode: 0o755 });
  try {
    await runTests({
      version: process.env.VSCODE_VERSION || "stable",
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, "suite.js"),
      launchArgs: [
        workspace,
        "--user-data-dir", path.join(tmp, "user-data"),
        "--extensions-dir", path.join(tmp, "extensions"),
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-gpu",
        "--no-sandbox",
        "--ozone-platform=x11", // the Xvfb display (see above)
        `--remote-debugging-port=${cdpPort}`,
      ],
      extensionTestsEnv: {
        VSCODE_PDF_MCP_DIR: stateDir,
        VPDF_TEST_TMP: tmp,
        VPDF_FAKE_VIEWER: fake,
        VSCODE_PDF_MCP_DEBUG: "1",
        VPDF_CDP_PORT: String(cdpPort),
        VSCODE_PDF_MCP_EDIT_COMMAND: editCommand,
        VPDF_PRW_MCP: mcpCommand,
        VPDF_PYTHON: python,
        VPDF_LATEX: HAVE_PDFLATEX ? "1" : "",
        VPDF_PDFNOTES_DIR: pdfnotesDir,
      },
    });
    const left = fs.readdirSync(stateDir);
    if (left.length) throw new Error(`state files left after VS Code exited: ${left.join(", ")}`);
    process.stdout.write("integration test passed\n");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  process.stderr.write(`integration test FAILED: ${e instanceof Error ? e.stack : e}\n`);
  process.exit(1);
});
