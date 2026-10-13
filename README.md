# vscode-pdf-mcp

A PDF viewer inside VS Code that an AI agent can see into. Read papers in a VS Code tab
and let an agent (Claude Code, or any MCP client) know which document and page you are
on and what you have selected, and let it show you a place when you ask.

Three parts, one npm package:

1. **A VS Code extension**: a custom editor for `*.pdf` built on
   [pdf.js](https://mozilla.github.io/pdf.js/) (text selection, annotations with their
   notes and reply threads, links, Ctrl+F). It publishes what you are reading and accepts
   `goto`, and you mark the PDF in it as in Okular: highlight, underline, squiggly,
   strikeout, margin notes and replies (see [Marking](#marking)). For LaTeX documents it
   does SyncTeX: Ctrl+click jumps to the source line, forward search shows a source line
   in the PDF (also from LaTeX Workshop), and a selection carries its source lines (see
   [SyncTeX](#synctex)).
2. **An MCP stdio server**, `vscode-pdf-mcp` (server name `vscode-pdf`), with the tools
   `viewer_state`, `get_selection` and `goto`.
3. **A Claude Code `UserPromptSubmit` hook**, `vscode-pdf-mcp-hook`, that adds one line of
   context to each prompt: the PDF you are reading in VS Code, the page, and your selection
   (with its LaTeX source lines when the PDF has SyncTeX data).

## How it fits with okular-mcp and pdf-reader-writer-mcp

[`CONTRACT.md`](CONTRACT.md) is the viewer-state contract this repository shares with
[okular-mcp](https://github.com/david-wang-0/okular-mcp): the same tools, entries, error
messages and hook output, so an agent, a hook or a rule written against one works with the
other. The one part of the contract that only this viewer fills in is SyncTeX: a
selection's `tex` source lines (C2) and the hook's `Source:` lines (C7); Okular reports no
selection position, so okular-mcp never sends them. Neither server reads or writes PDF
content. That is **pdf-reader-writer-mcp**: it
reads page text, links and annotations and writes highlights and notes into the file with
PyMuPDF (incremental saves), taking the `path` and `page` these servers report. The VS Code
viewer watches the file and re-renders when it changes, keeping your page, scroll position
and zoom; it has no unsaved state, so unlike Okular there is nothing to save first. Your
own marks take the same path: the viewer writes them through pdf-reader-writer-mcp's
*edit service*, so the agent's marks and yours are the same kind of standard annotation,
written under one file lock.

## Tools

| Tool | What it does |
|---|---|
| `viewer_state()` | Every PDF open in a VS Code tab as an entry `{viewer, window, path, page, pages, active}`, the active one first (C1) |
| `get_selection(source="primary")` | `primary`: the text selected in the active PDF tab, with its `path` and the `page` the selection starts on, plus `tex` (`[{file, lines: [first, last]}]`, one entry per source file) when the PDF has SyncTeX data; `""` when nothing is selected. `clipboard`: the system clipboard, unattributed (C2) |
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

**Marking** needs pdf-reader-writer-mcp's edit service, `pdf-reader-writer-edit`, on your
`PATH`. Installing pdf-reader-writer-mcp puts it there next to `pdf-reader-writer-mcp`:

```sh
uv tool install git+https://github.com/david-wang-0/pdf-reader-writer-mcp
```

Elsewhere, point the `vscodePdfMcp.editCommand` setting at it (and `vscodePdfMcp.editArgs`
for arguments). Without it the viewer works as before, with the mark tools off and one
message per window saying why.

**The three executables** (`vscode-pdf-mcp`, `vscode-pdf-mcp-hook`, and
`vscode-pdf-mcp-open` for [SyncTeX](#synctex) from other tools) on your `PATH`:

```sh
npm install -g .
```

(or link `mcp/server.js`, `bin/hook.js` and `bin/open.js` of the checkout into a directory
on your `PATH` under those names).

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
Source: paper.tex:41-43
Source: sections/intro.tex:7
```

The `Source:` lines come only with SyncTeX data (one per source file, relative to the
session's working directory when the file lies inside it, else absolute).

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
| `vscodePdfMcp.editCommand` | `pdf-reader-writer-edit` | The edit service every mark is written through (looked up on `PATH` unless absolute) |
| `vscodePdfMcp.editArgs` | `[]` | Its arguments |
| `vscodePdfMcp.author` | your login name | The author (`/T`) of your marks, and whose marks you may edit and delete |
| `vscodePdfMcp.keys` | see [Marking](#marking) | Shortcuts, e.g. `{"highlight": "shift+h", "undo": "ctrl+z"}` |

Environment variables (server, hook and extension host alike):

| Variable | Meaning |
|---|---|
| `XDG_RUNTIME_DIR` | Where the state directory lives; `/run/user/<uid>` when unset |
| `VSCODE_PDF_MCP_DIR` | Overrides the whole state directory (tests, unusual setups) |
| `VSCODE_PDF_MCP_DEBUG` | Extension: also print its log to the extension host's stdout |
| `VSCODE_PDF_MCP_EDIT_COMMAND` | Extension: the edit service's executable, over `vscodePdfMcp.editCommand` (tests) |

The extension logs to the output channel *PDF viewer (vscode-pdf-mcp)*.

## The viewer

- pdf.js `PDFViewer` with the text layer (select text), the annotation layer (Highlight,
  Underline, Squiggly, StrikeOut, Text notes, file attachments and the rest render from
  their appearance streams), internal links (citations, sections) and external links
  (opened in your browser through `vscode.env.openExternal`). Notes and threads show in the
  viewer's own tip and popover (see [Marking](#marking)), not in pdf.js's popups.
- Toolbar: page number / total, zoom out, zoom in, fit width (the default; it keeps fitting
  when the editor is resized), the mark tools, *Annotations* (the side panel), *Open in
  Okular*. Ctrl+F opens a find bar (Enter, Shift+Enter, Escape).
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

## Marking

You mark the PDF in the viewer much as in Okular. Every action is written to the file at
once (there is nothing to save), and the tab reloads in place to show it.

- **Mini-bar.** When you finish selecting text, a small bar appears next to it: the four
  styles (highlight, underline, squiggly, strikeout), the nine colours, and *+ note*, which
  opens a textbox for a note on the mark (Enter saves, Shift+Enter is a new line, Esc
  cancels). A style marks in the current colour; a colour marks in the last style. Both are
  remembered. Esc closes the bar.
- **Toolbar.** The four style tools are sticky, like Okular's annotation bar: while one is
  on, every selection you finish is marked at once. *Note* is the margin-note tool: click a
  point on a page, type, Enter, and a comment icon is placed there (its top-left corner at
  the point). The swatch button picks the colour, *Undo* undoes, *Annotations* opens the
  side panel. Esc returns to no tool.
- **Keys**, only when the focus is not in a text field: `H` highlight, `U` underline, `S`
  squiggly, `X` strikeout (each marks the current selection), `N` the margin-note tool,
  Esc no tool, Ctrl+Z undo. Change them with `vscodePdfMcp.keys` (actions `highlight`,
  `underline`, `squiggly`, `strikeout`, `note`, `undo`; values like `"h"`, `"shift+h"`,
  `"ctrl+z"`). The viewer stops the keys it handles, so VS Code does not act on them too.
- **Colours**: blue, yellow (the default), green, orange, pink, purple, red, cyan and grey,
  the palette of pdf-reader-writer-mcp; the viewer sends the name and the service writes its
  exact value. The agent's marks default to light blue, so yours stand apart.
- **Reading marks.** Hovering a mark shows its author and note. Clicking it opens a popover
  with its whole thread: author, date, the marked text, the note and the replies, nested.
  You can reply to any annotation, the agent's (`llm`) included, from the box at the bottom
  or with *Reply* on any entry. On your own marks you also get *Edit* (the note), *Delete*,
  the style buttons and the colours. Marks by others cannot be edited or deleted from the
  viewer. **Own** means the annotation's author (`/T`) equals `vscodePdfMcp.author` (default:
  your login name).
- **Side panel** (*Annotations*): every annotation by page, in reading order, with a colour
  chip, its type, author, the marked text, the note and the replies. Click one to go to it
  and open its popover. It follows every reload.
- **Undo** (Ctrl+Z or *Undo*) takes back your last action on this document in this window:
  a new mark, note or reply is deleted, an edit, colour or style change is reverted, a
  deletion is restored with its replies. The history is per document and lasts as long as
  the window. Undoing a mark that someone else has replied to since is refused rather than
  delete their reply. Marks made elsewhere (the agent, Okular) are not in it.

The agent's marks keep appearing while you read: pdf-reader-writer-mcp writes the file, the
viewer sees the change and reloads at the same place.

### How it writes

The extension starts **one edit service per window** (`pdf-reader-writer-edit`, from
pdf-reader-writer-mcp) when the first PDF tab opens and talks to it in JSON lines over
stdin and stdout; the protocol is pdf-reader-writer-mcp's `EDITING.md`. Each request opens
the PDF fresh under an exclusive `flock` on the file, adds or changes the annotation with
PyMuPDF and saves incrementally, so a mark from the viewer and one from the agent at the
same moment never lose each other. Selections go over as rects in PDF user space (pdf.js
`convertToPdfPoint`), one per text run, and the service snaps them to whole words. The
service is restarted on the next action if it dies; if it is missing or speaks another
protocol version, the mark tools are disabled with the reason in their tooltips and one
warning per window. The extension never writes PDF bytes itself and does not use pdf.js's
annotation editor.

## SyncTeX

For a PDF `X.pdf` with `X.synctex.gz` (or `X.synctex`) next to it, as `pdflatex`,
`xelatex` and `lualatex` write with `-synctex=1` (latexmk and LaTeX Workshop do by
default), the viewer links the PDF and the LaTeX source. The synctex file is parsed in
the extension host (`lib/synctex.js`, no `synctex` binary involved), so lookups are
instant; it is parsed again whenever a build rewrites it (and kept while a build is still
writing it), and dropped when it disappears.

- **Ctrl + hover.** Hold Ctrl over a page: the text that Ctrl+click would jump to (the
  stretch of the printed line under the pointer that comes from one source line) gets a
  grey underline, and a tip next to the pointer shows `<file>:<line>` (relative to the
  workspace) and that source line's text. Ctrl can go down before or after the pointer
  arrives, and while it is held both follow the pointer as it moves. Both go when you
  release Ctrl or leave the page, and during a Ctrl+wheel (or pinch) zoom. They do not
  catch the pointer, so selection, marks and popovers work as before. (Pointer moves do not
  always report a held Ctrl, as seen under Wayland: the viewer also goes by the Ctrl key
  itself, which it sees when its tab has the keyboard focus.)
- **Ctrl + click** opens the source at that line (inverse search): in an editor that
  already shows the file, else in a group that has it open, else in the group right of
  the PDF's or the text group you used last, else in a new group beside the PDF; never in
  the PDF tab's own group. Ctrl+click on a link does SyncTeX, not the link (a plain click
  still follows links). Without SyncTeX data, Ctrl+click does nothing special.
- **Forward search** (source line to PDF): **SyncTeX: show in PDF**
  (`vscodePdfMcp.synctexForward`, in the command palette of a `.tex` editor; bind a key
  to it if you like) takes the line at the cursor. The PDF is the open one whose SyncTeX
  data has that file, else `<root>.pdf` of a `% !TEX root = <root>.tex` magic comment in
  the file's first 20 lines, else the PDF of the same base name. The viewer opens it (or
  reveals its tab, keeping the focus in your editor), scrolls there and flashes the text
  in grey for a moment.
- **Selections** on such a PDF carry their source lines: `get_selection` returns `tex`
  (CONTRACT C2) and the hook adds `Source:` lines (C7). Each line of the selection is
  mapped at its left and right ends.
- **Rebuilds** keep your place: the PDF reloads at the same page, offset and zoom (as for
  any change on disk) and the SyncTeX data is refreshed with it.

Reverse and forward search follow the rules of SyncTeX's own parser (Jérôme Laurens's
`synctex_parser.c`, ported to JavaScript), so they land where `synctex edit` and
`synctex view` (and so Okular, Zathura and LaTeX Workshop's viewer) land;
`test/synctex.test.js` checks that on a compiled document. One deliberate difference: pdfTeX
tags the boundary after the first word of a source line with the line before, so
`synctex edit` gives that word the previous line. The viewer takes the line of the node
after the boundary instead, so hover, Ctrl+click, selections and the forward-search flash
put a source line's first word on its own line (where Ctrl+click can then differ from
`synctex edit`'s first result). Text inside a macro argument (a caption, a footnote) still
maps to the argument's last line: TeX reads the whole argument before typesetting it.

### From other tools: `vscode-pdf-mcp-open`

```sh
vscode-pdf-mcp-open <pdf>                                         # open the PDF, or reveal its tab
vscode-pdf-mcp-open --tex <file> --line <n> [--column <n>] <pdf>  # forward search
```

It sends the request to the VS Code window that has the PDF open, else one whose
workspace contains it, else the most recently focused window running the extension, and
prints `<pdf>: page <n> of <pages>`. It exits 1 with the reason on stderr when no window
can do it (none running, the file not in the PDF's SyncTeX data, ...) and 2 on bad
arguments. `--column` is accepted for tools that pass one; TeX engines record no columns,
so it does not change the result.

### LaTeX Workshop

Point LaTeX Workshop's external viewer at it, in VS Code's `settings.json`:

```json
"latex-workshop.view.pdf.viewer": "external",
"latex-workshop.view.pdf.external.viewer.command": "vscode-pdf-mcp-open",
"latex-workshop.view.pdf.external.viewer.args": ["%PDF%"],
"latex-workshop.view.pdf.external.synctex.command": "vscode-pdf-mcp-open",
"latex-workshop.view.pdf.external.synctex.args": ["--tex", "%TEX%", "--line", "%LINE%", "%PDF%"]
```

Then *View LaTeX PDF* opens this viewer and LaTeX Workshop's forward search
(Ctrl+Alt+J) lands in it; inverse search is this viewer's Ctrl+click. LaTeX Workshop
(checked with 10.19.0) fills `%PDF%` (the PDF's absolute path), `%TEX%` (the file in the
active editor) and `%LINE%` (the cursor's line, 1-based) in the SyncTeX arguments; it has
no column placeholder, hence no `--column`. Use the absolute path of
`vscode-pdf-mcp-open` as the command if VS Code does not have it on its `PATH`. Builds
need no setting: the viewer reloads the PDF when LaTeX Workshop rewrites it.

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
   "lastActiveAt": 1759999990000, "selection": {"text": "timed automata", "page": 3,
   "tex": [{"file": "/abs/project/paper.tex", "lines": [41, 43]}]}}
 ]
}
```

- `focusedAt` is the epoch ms of the window's last focus gain, or the write time while it
  is focused. `active` is `WebviewPanel.active` (the tab is its window's active editor);
  `lastActiveAt` is stamped whenever `active` changes. `selection` is `null` when nothing is
  selected; its `page` is the page the selection starts on; `tex` (C2) is there only when
  the PDF has SyncTeX data and the selection maps to source lines.
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
| `{"op":"open","path":"/abs/paper.pdf"}` | the same: opens the PDF (beside the active editor, keeping the focus) or reveals its tab |
| `{"op":"synctexForward","tex":"/abs/paper.tex","line":42,"column"?:0,"pdf"?:"/abs/paper.pdf"}` | the same, after the SyncTeX forward search: scrolled there and flashed; without `pdf` the window finds the PDF as *SyncTeX: show in PDF* does |

For `goto`, the server resolves the path (default: the active entry's), checks that it
exists and, when a tab has it open, the page range, and sends the request to the window that
shows the document (preferring the active entry), or, when no tab has it, to the most
recently focused window. Paths are compared by realpath. The extension reveals the tab and
scrolls, or opens the file with `vscode.openWith(uri, 'vscodePdfMcp.viewer')` and waits until
pdf.js has loaded it, then answers with the entry. A file pdf.js cannot load answers
`cannot open <path>` before any page check. The server gives up after 10 s.

The hook reads only the state files: no socket, no pdf.js, a few milliseconds.

Webview to extension messages: `ready`, `loaded {pages, page, reload}`,
`loadError {message, reload}`, `page {page}`, `selection {selection}` (with `parts: [{page,
rects}]`, the selection's rects in SyncTeX space, when the PDF has SyncTeX data),
`gotoDone {reqId, page}`, `openLink {url}`, `openExternalViewer`, `error {message}`,
for SyncTeX `synctexHover {reqId, page, x, y}` and `synctexEdit {page, x, y}`, and
for marking `mark {reqId, parts: [{page, rects, text}], style, color, note?}`,
`note {reqId, page, point, note, color}`, `reply {reqId, xref, note}`,
`update {reqId, xref, note?, color?, style?}`, `delete {reqId, xref}`, `undo {reqId}`,
`prefs {style, color}`.
Extension to webview: `load {data, reload}`, `goto {page, reqId}`, `visibility {visible}`,
`synctex {available}`, `synctexHit {reqId, hit: {file, rel, line, column, text, rects} |
null}`, `synctexShow {page, rects, reqId}` (answered with `gotoDone`),
`marking {enabled, reason, author, keys, style?, color?}`, `annotations {list}` (the edit
service's `list`, for the marked text), `editResult {reqId, op, ok, result | error}`.

SyncTeX positions and rects are in PDF big points from the page's top-left corner (as the
`synctex` CLI has them; pdf.js PDF space starts at the bottom-left), rects as `[left, top,
right, bottom]`. SyncTeX code: `lib/synctex.js` (parser and queries),
`extension/synctexstore.js` (per-PDF data that follows its synctex file, the PDF of a
`.tex`, source-line text), `media/synctex.mjs` (hover, Ctrl+click, flash, selection
rects), `bin/open.js` (the CLI).

Marking code: `extension/editservice.js` (the service client: spawn, framing, ids,
restart), `extension/marks.js` (requests, per-document write queue and undo stack),
`media/annotate.mjs` (the UI), `media/marking.mjs` and `media/keys.mjs` (palette,
geometry, threads, shortcuts; shared with the unit tests).

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
- **Okular does not take the file lock.** It writes only when you save, so marks you have
  made in Okular and not saved yet are at risk when this viewer or the agent writes the
  file: Okular offers to reload, and reloading drops them. Save in Okular before marking
  the same PDF here.
- **Undo is this window's, per document, for this session**: it covers only what you did in
  this viewer since the window opened, not the agent's marks or Okular's, and it does not
  survive a window reload. Undoing the creation of a mark someone has since replied to is
  refused.
- Writers wait for the file lock by polling it, so a long burst from one side (dozens of
  back-to-back writes) makes the other side wait until it ends; after 10 s the waiting side
  gives up with `PDF is locked by another writer`, shown in the viewer's status line.
- Each own write reloads the whole document in pdf.js (as any change on disk does), so a
  very large PDF flickers briefly after each mark.

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
  `wl-paste`/`xclip`/`xsel` scripts on a temporary `PATH`. The marking units (service
  client, request checks, ownership, undo stack and its xref remapping, palette, geometry,
  threads, keys) run against `test/helpers/fake-edit-service.js`, a stand-in for
  `pdf-reader-writer-edit` that speaks the same protocol. The SyncTeX parser is checked
  against the `synctex` CLI as an oracle on a small multi-file LaTeX project compiled with
  `pdflatex -synctex=1` (`test/helpers/latex.js`: `\input`, a wrapped paragraph, display
  math, a list, two columns, two pages): reverse search on points over the text and on a
  grid over whole pages (same file and line, and the same result list), forward search on
  every source line (same page, overlapping boxes); skipped without `pdflatex` or
  `synctex`. `vscode-pdf-mcp-open` runs against fake extension sockets.
- `npm run test:webview` serves the webview through `scripts/serve-webview.js` (the same
  HTML and CSP as in VS Code, with a mocked `acquireVsCodeApi`) and drives it with
  `playwright-core`: rendering, mouse selection, goto, reload in place, a half-written
  file, find, toolbar, and marking with a mocked extension: the mini-bar and the `mark`
  request with PDF-space rects, sticky tools, the margin-note click, keys, the popover
  thread and replies, edit/restyle/delete only on own marks, the side panel, and SyncTeX
  with a mocked extension: the Ctrl+hover underline and tip, Ctrl+click (also on a link),
  the forward-search flash, and Ctrl+wheel zoom with SyncTeX on. Set
  `CHROMIUM` to a Chromium or Chrome executable (otherwise Playwright's own download is
  used) and `VPDF_PYTHON` to a Python with `pymupdf` to also check PyMuPDF-written
  underlines and notes (`scripts/make-annotated-pdf.py`) and links.
- `npm run test:integration` downloads VS Code into `.vscode-test/` with
  `@vscode/test-electron` and runs `test/integration/suite.js` in it with a scratch
  user-data and extensions directory, under `xvfb-run` with `WAYLAND_DISPLAY` unset, so no
  window appears on your desktop. `VSCODE_VERSION=1.90.0` tests the oldest supported VS
  Code. It opens generated PDFs, checks the state file, goto over the socket (including
  opening a closed file and `cannot open`), replace-by-rename reloads of a background tab,
  the hook, and *Open in Okular* against a fake command; with `pdflatex`, a LaTeX project
  compiled into the workspace: Ctrl+click with the real mouse opens the `\input` file at
  the line, *SyncTeX: show in PDF* and `vscode-pdf-mcp-open --tex` scroll the PDF, a
  selection gives `tex` and `Source:`, and a rebuild refreshes the SyncTeX data. VS Code
  runs with a remote-debugging port and the suite drives the webview with real mouse and
  keyboard input over CDP: it marks a selection, replies to an agent note, edits and
  deletes a mark and
  undoes both with Ctrl+Z (checking that VS Code's own keybindings never see the keys), and
  reads the PDF back with PyMuPDF. A concurrency test has the viewer and
  pdf-reader-writer-mcp's MCP server mark one file at the same time and checks that every
  mark of both is there; a control run against a writer that skips the lock logs what it
  loses. This part needs `pdf-reader-writer-edit` (`VSCODE_PDF_MCP_EDIT_COMMAND` or `PATH`),
  `pdf-reader-writer-mcp` (`VPDF_PRW_MCP` or `PATH`) and `VPDF_PYTHON`, and is skipped
  without them. On VS Code 1.90, Playwright cannot reach the webview's frame, so the
  mouse-and-keyboard steps are skipped there.
- `node scripts/serve-webview.js some.pdf 8000` serves the webview for a browser by hand.
- Plain JavaScript with `// @ts-check` and JSDoc types, no build step. vscode-free logic
  lives in `lib/` and `extension/{state,ipc,html,editservice,marks,synctexstore}.js`;
  `extension/extension.js` is the glue.

## License

MIT, see [LICENSE](LICENSE).
