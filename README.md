# vscode-pdf-mcp

A PDF viewer inside VS Code that an AI agent can see into. Read papers in a VS Code tab
and let an agent (Claude Code, or any MCP client) know which document and page you are
on and what you have selected, and let it show you a place when you ask.

Three parts, one npm package:

1. **A VS Code extension**: a custom editor for `*.pdf` built on
   [pdf.js](https://mozilla.github.io/pdf.js/) (text selection, annotations with their
   notes, links, Ctrl+F). It publishes what you are reading and accepts `goto`.
2. **An MCP stdio server**, `vscode-pdf-mcp` (server name `vscode-pdf`), with the tools
   `viewer_state`, `get_selection` and `goto`.
3. **A Claude Code `UserPromptSubmit` hook**, `vscode-pdf-mcp-hook`, that adds one line of
   context to each prompt: the PDF you are reading in VS Code, the page, and your selection.

## How it fits with okular-mcp and pdf-reader-writer-mcp

[`CONTRACT.md`](CONTRACT.md) is the viewer-state contract this repository shares with
[okular-mcp](https://github.com/david-wang-0/okular-mcp): the same tools, entries, error
messages and hook output, so an agent, a hook or a rule written against one works with the
other. Neither server reads or writes PDF content. That is **pdf-reader-writer-mcp**: it
reads page text, links and annotations and writes highlights and notes into the file with
PyMuPDF (incremental saves), taking the `path` and `page` these servers report. The VS Code
viewer watches the file and re-renders when it changes, keeping your page, scroll position
and zoom; it has no unsaved state, so unlike Okular there is nothing to save first.

## Tools

| Tool | What it does |
|---|---|
| `viewer_state()` | Every PDF open in a VS Code tab as an entry `{viewer, window, path, page, pages, active}`, the active one first (C1) |
| `get_selection(source="primary")` | `primary`: the text selected in the active PDF tab, with its `path` and the `page` the selection starts on; `""` when nothing is selected. `clipboard`: the system clipboard, unattributed (C2) |
| `goto(page, path=None)` | Shows `page` of `path` (default: the active document), opening it in VS Code if no tab has it; returns the entry after the move (C3). Only when the user asks to be shown a place |

The **active entry** is the active PDF tab of the most recently focused VS Code window or,
if no window has a PDF tab as its active editor, the PDF tab that was active most recently.

Errors are MCP tool errors (`isError: true`) whose text is the contract's message verbatim:
`no VS Code window with a PDF open` (optionally followed by a cause in brackets),
`source must be 'primary' or 'clipboard'`, `page N outside 1-M`, `no such file: <path>`,
`cannot open <path>`.

## Install

Requirements: VS Code 1.90 or newer, Node.js 20 or newer, Linux (the server and hook use a
per-user runtime directory and unix sockets). The `clipboard` source needs `wl-paste`
(Wayland) or `xclip`/`xsel` (X11).

```sh
git clone https://github.com/david-wang-0/vscode-pdf-mcp
cd vscode-pdf-mcp
npm ci
```

**The extension**, either as a package:

```sh
npx @vscode/vsce package          # writes vscode-pdf-mcp-<version>.vsix
code --install-extension vscode-pdf-mcp-0.1.0.vsix
```

or linked from the checkout, so `git pull` updates it (reload the VS Code window after):

```sh
ln -s "$PWD" "$HOME/.vscode/extensions/david-wang-0.vscode-pdf-mcp-0.1.0"
```

**The two executables** (`vscode-pdf-mcp`, `vscode-pdf-mcp-hook`) on your `PATH`:

```sh
npm install -g .
```

**The MCP server** in Claude Code, at whichever scope you like. For all your projects:

```sh
claude mcp add vscode-pdf -s user -- vscode-pdf-mcp
```

or for one project (`-s project` writes the repository's `.mcp.json`; `-s local` keeps it
private to you):

```sh
claude mcp add vscode-pdf -s project -- vscode-pdf-mcp
```

which is the same as this `.mcp.json` entry:

```json
{ "mcpServers": { "vscode-pdf": { "command": "vscode-pdf-mcp" } } }
```

Any other MCP client: run `vscode-pdf-mcp` as a stdio server.

**The hook** in a Claude Code `settings.json` (your user settings, `.claude/settings.json`
in your home directory, or a project's `.claude/settings.json`):

```json
{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"vscode-pdf-mcp-hook","timeout":5}]}]}}
```

The hook works on its own: it reads the state files the extension writes and needs neither
the MCP server nor any particular registration scope. `UserPromptSubmit` takes no matcher.
The hook prints nothing, or one JSON object whose `hookSpecificOutput.additionalContext`
Claude Code adds to the prompt (capped by Claude Code at 10,000 characters):

```
The user is reading /path/to/paper.pdf in VS Code, page 3 of 12.
Selected text (page 3):
<the selection, cut at 2000 characters with " […]">
```

It speaks only when the PDF is its window's active editor and is relevant to the session's
working directory: the PDF lies inside it, or one of that VS Code window's workspace folders
equals it, contains it, or lies inside it (C8). It always exits 0 and never blocks a prompt.

## Making it the default PDF viewer

The editor registers for `*.pdf` with priority `default`. If another extension also claims
PDFs (for example `pdf-external-open`, which hands every PDF to Okular), pick this one in VS
Code's `settings.json`:

```json
"workbench.editorAssociations": { "*.pdf": "vscodePdfMcp.viewer" }
```

This displaces `pdf-external-open` for every open path (explorer, Ctrl+click, links). LaTeX
Workshop's own tab viewer is unaffected: it does not go through editor associations.

**Open in Okular**: the toolbar button and the editor-title action (also *PDF: Open in
Okular* in the command palette) hand the file to `pdf-external-open` when that extension is
installed (`vscode.openWith(uri, 'pdfExternalOpen.editor')`), and otherwise run the
`vscodePdfMcp.externalViewer` command with the file.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `vscodePdfMcp.externalViewer` | `okular` | Executable for *Open in Okular* when `pdf-external-open` is not installed; run with the PDF's absolute path as its only argument |

Environment variables (server, hook and extension host alike):

| Variable | Meaning |
|---|---|
| `XDG_RUNTIME_DIR` | Where the state directory lives; `/run/user/<uid>` when unset |
| `VSCODE_PDF_MCP_DIR` | Overrides the whole state directory (tests, unusual setups) |
| `VSCODE_PDF_MCP_DEBUG` | Extension: also print its log to the extension host's stdout |

The extension logs to the output channel *PDF viewer (vscode-pdf-mcp)*.

## The viewer

- pdf.js `PDFViewer` with the text layer (select text), the annotation layer (Highlight,
  Underline, Squiggly, StrikeOut, Text notes and file attachments render; their notes pop
  up on hover and click as in Firefox), internal links (citations, sections) and external
  links (opened in your browser through `vscode.env.openExternal`).
- Toolbar: page number / total, zoom out, zoom in, fit width (the default; it keeps fitting
  when the editor is resized), *Open in Okular*. Ctrl+F opens a find bar (Enter, Shift+Enter,
  Escape).
- Chrome follows the VS Code theme; pages stay white.
- The file is read through `vscode.workspace.fs` and posted to the webview, so PDFs outside
  the workspace work.
- **Reload on change**: the file's *directory* is watched with Node's `fs.watch`, filtered by
  the file name, so a replace-by-rename (as LaTeX and PyMuPDF do) and files outside the
  workspace are seen. After 200 ms of quiet, if the size or mtime changed, the new file is
  parsed and swapped in at the same page, in-page offset and zoom. A file that fails to parse
  (caught mid-write) keeps the old render, and the next change is retried. A tab in the
  background parses the new file at once (so its page count is current) and shows it when
  you come back to it.

## Internals

The extension and the server/hook talk through files and sockets in a private directory,
`$XDG_RUNTIME_DIR/vscode-pdf-mcp/` (else `/run/user/<uid>/vscode-pdf-mcp/`), mode 0700.
Each VS Code window (one extension host) owns two entries named after its pid. It activates
on startup, so every window has them even before a PDF is open; it removes stale files of
its own pid and of dead pids on start and removes both on deactivate.

**`<pid>.json`**, the window's state, written atomically (temporary file, then rename) at
most every ~100 ms whenever something changes:

```json
{
 "version": 1,
 "pid": 4242,
 "socket": "/run/user/1000/vscode-pdf-mcp/4242.sock",
 "focused": true,
 "focusedAt": 1760000000000,
 "workspaceFolders": ["/abs/project"],
 "panels": [
  {"id": "1", "path": "/abs/project/paper.pdf", "page": 3, "pages": 12, "active": true,
   "lastActiveAt": 1759999990000, "selection": {"text": "timed automata", "page": 3}}
 ]
}
```

- `focusedAt` is the epoch ms of the window's last focus gain, or the write time while it
  is focused. `active` is `WebviewPanel.active` (the tab is its window's active editor);
  `lastActiveAt` is stamped whenever `active` changes. `selection` is `null` when nothing is
  selected; its `page` is the page the selection starts on.
- Readers ignore files that fail to parse, are not version 1, or whose `pid` is dead
  (`kill(pid, 0)`).
- Active entry: among live windows ordered by focus (focused first, then `focusedAt`), the
  first window's panel with `active: true`; failing that (no active PDF tab anywhere), the
  panel with the greatest `lastActiveAt`. The hook requires the first case.
- `window` in entries is `"<pid>:<panel id>"`.

**`<pid>.sock`**, a unix socket speaking newline-delimited JSON, one request and one response
per connection (mode 0600):

| Request | Response |
|---|---|
| `{"op":"ping"}` | `{"ok":true,"pid":4242}` |
| `{"op":"state"}` | `{"ok":true,"state":{...}}` (as in the state file) |
| `{"op":"goto","path":"/abs/paper.pdf" or null,"page":3}` | `{"ok":true,"entry":{...}}` or `{"ok":false,"error":"<message>"}` |

For `goto`, the server resolves the path (default: the active entry's), checks that it
exists and, when a tab has it open, the page range, and sends the request to the window that
shows the document (preferring the active entry), or, when no tab has it, to the most
recently focused window. Paths are compared by realpath. The extension reveals the tab and
scrolls, or opens the file with `vscode.openWith(uri, 'vscodePdfMcp.viewer')` and waits until
pdf.js has loaded it, then answers with the entry. A file pdf.js cannot load answers
`cannot open <path>` before any page check. The server gives up after 10 s.

The hook reads only the state files: no socket, no pdf.js, a few milliseconds.

Webview to extension messages: `ready`, `loaded {pages, page, reload}`,
`loadError {message, reload}`, `page {page}`, `selection {selection}`,
`gotoDone {reqId, page}`, `openLink {url}`, `openExternalViewer`, `error {message}`.
Extension to webview: `load {data, reload}`, `goto {page, reqId}`, `visibility {visible}`.

## Gotchas

- **One window per pid**: the state is per extension host. Remote windows (SSH, WSL,
  containers) run the extension on the remote side, so their state files are there, not
  where a local MCP server or hook looks.
- **`active` means the active editor.** If you type into an agent's chat that is itself an
  *editor tab* in the same window, that tab is the active editor and the PDF is not, so the
  hook stays silent for that prompt; the MCP server still falls back to the most recently active PDF tab. A
  terminal panel or a separate terminal window does not take the active editor away.
- `goto` reveals the tab in its window but cannot raise the window above others on your
  desktop.
- The selection is the text layer's: lines are joined with spaces and a line-end hyphen
  between two lower-case letters is removed (`hyphen-\nated` gives `hyphenated`); other
  line-end hyphens are kept. Text pdf.js cannot extract (scanned pages) cannot be selected.
- pdf.js is pinned to 5.4.624, its legacy build: pdf.js 6 needs a newer Chromium than
  VS Code 1.90 ships (CSS `round()`), and 5.6 to 6.2 carry a security advisory
  (GHSA-hq66-cqwq-w95j). The webview runs with a strict CSP (nonce, no `eval`).
- PDFs with JavaScript or XFA forms are shown without running scripts or XFA.

## Development

```sh
npm ci
npm test                      # unit and contract tests (node:test), no VS Code needed
npm run test:webview          # the webview in headless Chromium (see below)
npm run test:integration      # a real VS Code under xvfb-run (skipped without xvfb-run)
```

- `npm test` runs `test/*.test.js`: one or more tests per contract clause (named
  `C<N>: ...`), the state store, the socket framing, selection normalisation, and the MCP
  server over stdio with the SDK client. They use a temporary runtime directory with fake
  state files, a fake extension socket built from `extension/ipc.js`, and fake
  `wl-paste`/`xclip`/`xsel` scripts on a temporary `PATH`.
- `npm run test:webview` serves the webview through `scripts/serve-webview.js` (the same
  HTML and CSP as in VS Code, with a mocked `acquireVsCodeApi`) and drives it with
  `playwright-core`: rendering, mouse selection, goto, reload in place, a half-written
  file, find, toolbar. Set `CHROMIUM` to a Chromium or Chrome executable (otherwise
  Playwright's own download is used) and `VPDF_PYTHON` to a Python with `pymupdf` to also
  check PyMuPDF-written underlines and notes (`scripts/make-annotated-pdf.py`) and links.
- `npm run test:integration` downloads VS Code into `.vscode-test/` with
  `@vscode/test-electron` and runs `test/integration/suite.js` in it with a scratch
  user-data and extensions directory, under `xvfb-run` with `WAYLAND_DISPLAY` unset, so no
  window appears on your desktop. `VSCODE_VERSION=1.90.0` tests the oldest supported VS
  Code. It opens generated PDFs, checks the state file, goto over the socket (including
  opening a closed file and `cannot open`), replace-by-rename reloads of a background tab,
  the hook, and *Open in Okular* against a fake command.
- `node scripts/serve-webview.js some.pdf 8000` serves the webview for a browser by hand.
- Plain JavaScript with `// @ts-check` and JSDoc types, no build step. vscode-free logic
  lives in `lib/` and `extension/{state,ipc,html}.js`; `extension/extension.js` is the glue.

## License

MIT, see [LICENSE](LICENSE).
