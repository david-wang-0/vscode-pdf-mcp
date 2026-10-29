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
   does SyncTeX, down to the word: Ctrl+click jumps to the word in the source, forward
   search shows the word at the cursor in the PDF (also from LaTeX Workshop), and a
   selection carries its source lines (see [SyncTeX](#synctex)). With the pdfnotes
   package, your marks are copied into the LaTeX source as you make them (see
   [Marks into the LaTeX source](#marks-into-the-latex-source)).
2. **An MCP stdio server**, `vscode-pdf-mcp` (server name `vscode-pdf`), with the tools
   `viewer_state`, `get_selection` and `goto`.
3. **A Claude Code `UserPromptSubmit` hook**, `vscode-pdf-mcp-hook`, that adds one line of
   context to each prompt: the PDF you are reading in VS Code, the page, and your selection
   (with its LaTeX source lines when the PDF has SyncTeX data).

## How it fits with okular-mcp and pdf-reader-writer-mcp

[`CONTRACT.md`](CONTRACT.md) is the viewer-state contract this repository shares with
[okular-mcp](https://github.com/david-wang-0/okular-mcp): the same tools, entries, error
messages and hook output, so an agent, a hook or a rule written against one works with the
other. Both fill in SyncTeX: a selection's `tex` source lines (C2) and the hook's
`Source:` lines (C7). Okular reports no selection position, so okular-mcp looks for the
selected words in the text of the current page and the pages next to it, and maps them
with `synctex edit` only when they occur there exactly once; its hook adds the selection
only when it finds the words, since the system primary selection may come from any
window. This viewer knows where the selection is, so it always sends both. Both also
have a command for LaTeX tools (`vscode-pdf-mcp-open`, `okular-mcp-open`) with the same
arguments. Neither server reads or writes PDF content. That is **pdf-reader-writer-mcp**: it
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

**Open in Okular**: *PDF: Open in Okular* in the command palette (there is no button for it
above the editor or in the toolbar) hands the file to `pdf-external-open` when that extension is
installed (`vscode.openWith(uri, 'pdfExternalOpen.editor')`), and otherwise runs the
`vscodePdfMcp.externalViewer` command with the file.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `vscodePdfMcp.externalViewer` | `okular` | Executable for *Open in Okular* when `pdf-external-open` is not installed; run with the PDF's absolute path as its only argument |
| `vscodePdfMcp.editCommand` | `pdf-reader-writer-edit` | The edit service every mark is written through (looked up on `PATH` unless absolute) |
| `vscodePdfMcp.editArgs` | `[]` | Its arguments |
| `vscodePdfMcp.author` | your login name | The author (`/T`) of your marks, and whose marks you may edit and delete |
| `vscodePdfMcp.syncMarksToSource` | `true` | Copy the marks into the LaTeX source after each of your actions (see [Marks into the LaTeX source](#marks-into-the-latex-source)) |
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
  when the editor is resized), the mark tools, *Annotations* (the side panel), the minimap
  icon (page thumbnails with your marks as coloured ticks; click or drag in it to scroll; on
  by default, and remembered). When the editor is too narrow for the toolbar, it scrolls
  sideways (wheel or touchpad). Ctrl+F opens a find bar (Enter, Shift+Enter, Escape).
- The toolbar and the find bar are icon buttons in the style of VS Code's own editor
  toolbars and find widget: VS Code's codicons (`@vscode/codicons`), each with a tooltip
  and an accessible name, no fill until hovered, and a tool that is on framed like the find
  widget's *Match Case* option. Zoom out and in are magnifiers, fit width a double arrow
  (↔), the margin-note tool a speech bubble, undo the curved arrow of *Discard*,
  *Annotations* a list, the minimap a page with a strip of thumbnails at its right; the
  four style tools show "ab" in their style, the colour button a swatch.
- Chrome follows the VS Code theme (light, dark and high contrast); pages stay white.
- The file is read through `vscode.workspace.fs` and posted to the webview, so PDFs outside
  the workspace work.
- **Reload on change**: the file's *directory* is watched with Node's `fs.watch`, filtered by
  the file name, so a replace-by-rename (as LaTeX and PyMuPDF do) and files outside the
  workspace are seen. After 200 ms of quiet, if the size or mtime changed, the new file is
  parsed and swapped in at the same page, in-page offset and zoom. A file that fails to parse
  (caught mid-write) keeps the old render, and the next change is retried. A tab in the
  background parses the new file at once (so its page count is current) and shows it when
  you come back to it.

### Minimap

A column of page thumbnails to the right of the pages, 100 px wide, each in its page's
aspect ratio, with a translucent box over the part of the document on screen. It is on
by default; the toolbar's minimap icon (*Minimap*) hides it, and the choice is remembered per tab. A click
scrolls the pages so the point you clicked is in the middle of the view (keeping the
place within the page); a drag keeps doing so. In a long document the minimap scrolls
along with the pages, so the box stays in view; the wheel scrolls it on its own.

- Thumbnails are copied from the pages the viewer renders: each page drawn in the main
  view is scaled down into its thumbnail, at no rendering cost. Only pages the main view
  has not shown are rendered on their own, lazily (those in or near the minimap's visible
  part), one at a time, and only when the viewer is idle: when pdf.js's rendering queue
  has nothing of its own left to draw, not within 250 ms of a scroll or zoom (one under
  way is cancelled when the pages move), at the browser's idle time. A hidden tab renders
  none. The box's geometry is measured once per layout, so a scroll frame reads only
  scroll positions.
- Your marks are drawn over the thumbnails from the viewer's annotation model, one
  coloured rect per marked line and a small square for a note, so they show as soon as
  the model has them. A thumbnail rendered on its own leaves the annotations out; one
  copied from the page has them in its image too, under the rects. Replies are not
  drawn, and neither are the marks of a rotated page.
- Every mark rewrites the file and reloads it. A reload whose pages have the same count
  and sizes keeps the thumbnails on screen: the pages the main view draws again refresh
  theirs, the others are re-rendered lazily, each replaced only when its new image is
  ready; other changes make the thumbnails anew.
- In a long document, a second after the minimap stops moving, thumbnails more than 40
  pages from the part in or near view are emptied (except the current page's), so a book
  holds about the visible part and 40 pages each side (a thumbnail is about 52 KB, or
  210 KB on a high-density screen) rather than every page shown so far. They come back
  the same way as before when they are near view again. A paper of up to 40 pages never
  loses one.

## Marking

You mark the PDF in the viewer much as in Okular. Every action is written to the file at
once (there is nothing to save), and the tab reloads in place to show it.

- **Mini-bar.** When you finish selecting text, a small bar appears next to it: the four
  styles (highlight, underline, squiggly, strikeout), the nine colours, and *+ note*, which
  opens a textbox for a note on the mark (Enter saves, Shift+Enter is a new line, Esc
  cancels). A style marks in the current colour; a colour marks in the last style. Both are
  remembered. Esc closes the bar.
- **Toolbar.** The four style tools are sticky, like Okular's annotation bar: while one is
  on, every selection you finish is marked at once. The speech bubble (*Margin note tool*)
  is the margin-note tool: click a point on a page, type, Enter, and a comment icon is
  placed there (its top-left corner at the point). The swatch button picks the colour, the
  curved arrow (*Undo*) undoes, the list (*Annotations*) opens the side panel. Esc returns
  to no tool.
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
  and open its popover. It follows every reload. With the minimap open it sits to the
  minimap's left, so the two columns are in the order of their toolbar buttons.
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
service is restarted on the next action if it dies; if it is missing or speaks a
protocol version older than 1, the mark tools are disabled with the reason in their
tooltips and one warning per window (a newer version is accepted: versions add ops and
fields; marks go into the LaTeX source from version 2 on). Requests are answered one at a
time, and each has 30 s (a `sync`, 120 s) from when the service gets to it. The extension never writes PDF bytes itself and does not use pdf.js's
annotation editor.

### Marks into the LaTeX source

Marks in a PDF built from LaTeX are gone after the next build. For a document whose
sources load the [pdfnotes](https://github.com/david-wang-0/pdf-reader-writer-mcp/blob/main/latex/README.md)
package (part of pdf-reader-writer-mcp), the viewer therefore copies the marks into the
source as you make them: after each mark, note, reply, edit, deletion or undo, the edit
service's `sync` writes the PDF's highlights and notes as `\pdfmark[id=…,…]{marked
words}{note}` and `\pdfnote[…]{text}` macros where SyncTeX places them (replies after their
parent, with `replyto=`), brings the macros of changed marks up to date and removes those of
marks deleted in the viewer. Each annotation gets its macro's id as its `/NM`
(`pdfnotes:<id>`), so the rebuilt document has the same marks again, and undoing a deletion
puts the macro back with the same id. The status bar names the files it changed
(*Marks copied into paper.tex*); an editor showing such a file without unsaved changes
reloads it from disk by itself.

- **When**: 0.3 s after the last of a burst of actions, one sync at a time per PDF, only
  when `X.synctex.gz` or `X.synctex` lies next to `X.pdf` and the edit service speaks
  protocol 2 or newer.
- **Never over unsaved edits**: while a source of the PDF (a file in its SyncTeX data;
  without data, a LaTeX file under the PDF's directory) has unsaved changes in an editor,
  the sync waits. It runs when they are saved, reverted or closed without saving, and not
  before.
- **No pdfnotes**: when no source loads the package, nothing is written. One message per
  PDF and window says so, with a button for the package's README, and the viewer does not
  try again until the document is rebuilt (its SyncTeX file changes). Any other failure
  shows one warning per PDF; the output channel has the details of each sync.
- **Builds**: pdfnotes places its annotations from positions recorded in the run before,
  so a build needs two LaTeX runs (latexmk, LaTeX Workshop and Overleaf do that). A build
  that was already under way when the sync wrote the source (one started by saving it, say)
  does not have the new marks; they are safe in the source and come with the next build.
- **What**: the sync copies every highlight and note of the PDF, not only yours: the
  agent's marks go into the source too.
- **Where**: a new macro goes where the SyncTeX data of the last build puts the mark,
  looking for its words a few lines around. Saved edits that move lines put that off until
  the next build: a new mark may then be written as a `\pdfnote` next to the text instead
  of a `\pdfmark` around it.
- Off with `"vscodePdfMcp.syncMarksToSource": false`.

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
  workspace) and that source line's text, with the word under the pointer in bold when it
  is found in the source (see [Down to the word](#down-to-the-word)). Ctrl can go down
  before or after the pointer arrives, and while it is held both follow the pointer as it
  moves. Both go when you release Ctrl or leave the page, and during a Ctrl+wheel (or
  pinch) zoom. They do not catch the pointer, so selection, marks and popovers work as
  before. (Pointer moves do not always report a held Ctrl, as seen under Wayland: the
  viewer also goes by the Ctrl key itself, which it sees when its tab has the keyboard
  focus.)
- **Ctrl + click** opens the source with the cursor on the clicked word (inverse search),
  or at the start of the line when the word cannot be placed: in an editor that already
  shows the file, else in a group that has it open, else in the group right of the PDF's
  or the text group you used last, else in a new group beside the PDF; never in the PDF
  tab's own group. Ctrl+click on a link does SyncTeX, not the link (a plain click still
  follows links). Without SyncTeX data, Ctrl+click does nothing special.
- **Forward search** (source line to PDF): **SyncTeX: Show in PDF**
  (`vscodePdfMcp.synctexForward`, in a `.tex` editor's right-click menu and command
  palette; bind a key to it if you like) takes the line and the word at the cursor (or
  the words of a selection within the line). A right-click puts the cursor where you
  clicked (unless inside the selection), so the menu entry shows the word you clicked. The PDF is the open one whose SyncTeX data has that file,
  else `<root>.pdf` of a `% !TEX root = <root>.tex` magic comment in the file's first 20
  lines, else the PDF of the same base name. The viewer opens it (or reveals its tab,
  keeping the focus in your editor), scrolls to the line and flashes that word in grey
  for a moment, or the line's text when the word cannot be placed.
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

### Down to the word

SyncTeX records source lines, not columns, so the viewer gets to the word by matching
text, as TeXstudio does (`media/wordmatch.mjs`). Both sides become plain words: in the
source, comments, control words and braces go (`\emph{x}` is `x`), the keys of `\cite`,
`\ref`, `\label` and the like go with them, `~` is a space, quotes and dashes separate
words; in the PDF, ligatures (fi, ffl, ...) are letters again and a word TeX hyphenated at
a line end is one word; accents, case and punctuation around a word do not count. The
word is looked for with about six words of context on each side:

- **Ctrl+click**: on the source line SyncTeX names (preferred) and up to five lines above
  and two below; found nowhere there, in the rest of a macro argument that ends on that
  line (a caption or footnote: TeX gives all of it the argument's last line).
- **Forward search**: among the words printed in the line's boxes (preferred), on the
  same printed lines, and in the boxes of the next few source lines (again for a macro
  argument: a caption's first line has no boxes of its own). The page's text layer must
  be rendered first, which takes a moment on a page far away.

A word that occurs more than once is told apart by its context. When two places are about
as good, or the word is not found, it stays at the line: the cursor at the line's start,
the flash on the whole line. The column of a forward search comes from the cursor (or
the selection) for *SyncTeX: Show in PDF*, from `--column` for `vscode-pdf-mcp-open`, and
otherwise, as for LaTeX Workshop, which passes no column, from a text editor that shows
the file with its cursor on that line (the active editor first); without one, it is the
line. Limits: math (`$...$`, display math) is opaque, since the PDF prints symbols, and
text that macros make up (`\citet`'s author names, `\Cref`'s "Section", running heads,
`\newcommand` text) is not in the source; such a word stays at the line, or now and then
lands on the same word nearby (LaTeX's "Figure" on a "figure" in the source).

### From other tools: `vscode-pdf-mcp-open`

```sh
vscode-pdf-mcp-open <pdf>                                         # open the PDF, or reveal its tab
vscode-pdf-mcp-open --tex <file> --line <n> [--column <n>] <pdf>  # forward search
```

It sends the request to the VS Code window that has the PDF open, else one whose
workspace contains it, else the most recently focused window running the extension, and
prints `<pdf>: page <n> of <pages>`. It exits 1 with the reason on stderr when no window
can do it (none running, the file not in the PDF's SyncTeX data, ...) and 2 on bad
arguments. `--column` (0-based; negative for none) picks the word to flash; without it, a
text editor with its cursor on that line of the file gives the column (see
[Down to the word](#down-to-the-word)).

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
no column placeholder, hence no `--column`: the viewer takes the column from that
editor's cursor, which is on that line, so the flash is still the word at the cursor. Use the absolute path of
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
| `{"op":"synctexForward","tex":"/abs/paper.tex","line":42,"column"?:0,"pdf"?:"/abs/paper.pdf"}` | the same, after the SyncTeX forward search: scrolled there and flashed (the word at the 0-based `column`, else at the cursor of an editor on that line, else the line); without `pdf` the window finds the PDF as *SyncTeX: Show in PDF* does |

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
`gotoDone {reqId, page}`, `openLink {url}`, `error {message}`,
for SyncTeX `synctexHover {reqId, page, x, y, anchor?}` and `synctexEdit {page, x, y,
anchor?}` (`anchor`: `{before, words, after}`, the normalised word under the pointer and
up to six words of context each side, from the text layer), and
for marking `mark {reqId, parts: [{page, rects, text}], style, color, note?}`,
`note {reqId, page, point, note, color}`, `reply {reqId, xref, note}`,
`update {reqId, xref, note?, color?, style?}`, `delete {reqId, xref}`, `undo {reqId}`,
`prefs {style, color}`.
Extension to webview: `load {data, reload}`, `goto {page, reqId}`, `visibility {visible}`,
`synctex {available}`, `synctexHit {reqId, hit: {file, rel, line, column, text, em?, rects} |
null}` (`em`: the matched word's `[start, end)` in `text`), `synctexShow {page, rects, reqId,
anchor?, near?}` (answered with `gotoDone`; `anchor` the word at the cursor in the same form,
`near: [{page, rects}]` the boxes of the next source lines to look in too),
`marking {enabled, reason, author, keys, style?, color?}`, `annotations {list}` (the edit
service's `list`, for the marked text), `editResult {reqId, op, ok, result | error}`.

SyncTeX positions and rects are in PDF big points from the page's top-left corner (as the
`synctex` CLI has them; pdf.js PDF space starts at the bottom-left), rects as `[left, top,
right, bottom]`. SyncTeX code: `lib/synctex.js` (parser and queries),
`extension/synctexstore.js` (per-PDF data that follows its synctex file, the PDF of a
`.tex`, source-line text), `media/synctex.mjs` (hover, Ctrl+click, flash, selection
rects, the text layer's words), `media/wordmatch.mjs` (normalising source and PDF text,
matching an anchor; shared by the webview and the extension), `bin/open.js` (the CLI).

Marking code: `extension/editservice.js` (the service client: spawn, framing, ids,
restart), `extension/marks.js` (requests, per-document write queue and undo stack),
`extension/sourcesync.js` (when the `sync` of the marks into the LaTeX source runs),
`media/annotate.mjs` (the UI), `media/marking.mjs` and `media/keys.mjs` (palette,
geometry, threads, shortcuts; shared with the unit tests).

Minimap code: `media/minimap.mjs` (thumbnails, their render queue, the marks over them,
the box, click and drag; it takes the marks from annotate.mjs's `annotationsrebuilt`
event), `media/minimaplayout.mjs` (the mapping between the pages' scroll position and the
minimap, without DOM; shared with the unit tests).

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
VPDF_STRICT=1 npm run test:integration   # the same, failing if any part is skipped
node --test --experimental-test-coverage test/*.test.js   # unit tests with coverage
```

What each suite needs (each skips what it cannot run, saying why):

| Suite | Needs | Optional, else that part is skipped |
|---|---|---|
| `npm test` | Node 20+ | `pdflatex`, `synctex`, `pdftotext` (TeX Live) for the SyncTeX oracle and word tests; `script` (util-linux) for one hook test |
| `npm run test:webview` | `playwright-core` (a devDependency) and its Chromium: `node node_modules/playwright-core/cli.js install chromium-headless-shell` once, or `CHROMIUM=<executable>` | a Python with `pymupdf` (`VPDF_PYTHON`, else the one of the installed `pdf-reader-writer-edit`) |
| `npm run test:integration` | `xvfb-run`; network once, to download VS Code into `.vscode-test/` | pdf-reader-writer-mcp (its `pdf-reader-writer-edit` and `pdf-reader-writer-mcp` on `PATH`) for marking, the concurrency test and marks into the LaTeX source; `pdflatex` for SyncTeX; `todonotes` and pdfnotes.sty for marks into the source |

`test/helpers/prw.js` finds pdf-reader-writer-mcp's pieces for the last two: the edit
service (`VSCODE_PDF_MCP_EDIT_COMMAND`, else `PATH`), the MCP server (`VPDF_PRW_MCP`, else
`PATH`), a Python with `pymupdf` (`VPDF_PYTHON`, else the interpreter of the edit service's
own environment) and pdfnotes.sty (`VPDF_PDFNOTES_DIR`, else the `latex/` directory of a
pdf-reader-writer-mcp checkout next to this one or of the source tree the edit service was
installed from, as with `uv tool install -e`, else `kpsewhich`). With pdf-reader-writer-mcp
installed that way, no variable is needed.

- `npm test` runs `test/*.test.js`: one or more tests per contract clause (named
  `C<N>: ...`), the state store, the socket framing, selection normalisation, the
  minimap's mapping between scroll position and thumbnails (pages of different heights,
  clamping, round trip), and the MCP server over stdio with the SDK client. They use a temporary runtime directory with fake
  state files, a fake extension socket built from `extension/ipc.js`, and fake
  `wl-paste`/`xclip`/`xsel` scripts on a temporary `PATH`. The marking units (service
  client, request checks, ownership, undo stack and its xref remapping, palette, geometry,
  threads, keys) run against `test/helpers/fake-edit-service.js`, a stand-in for
  `pdf-reader-writer-edit` that speaks the same protocol. The scheduling of the marks'
  sync into the LaTeX source (debounce, one at a time, pending while a source is unsaved
  and run on save, protocol and SyncTeX checks, the no-pdfnotes memory until a rebuild) is
  tested with stub hooks. The SyncTeX parser is checked
  against the `synctex` CLI as an oracle on a small multi-file LaTeX project compiled with
  `pdflatex -synctex=1` (`test/helpers/latex.js`: `\input`, a wrapped paragraph, display
  math, a list, two columns, two pages): reverse search on points over the text and on a
  grid over whole pages (same file and line, and the same result list), forward search on
  every source line (same page, overlapping boxes); skipped without `pdflatex` or
  `synctex`. The word matching (`media/wordmatch.mjs`) has unit tests for the
  normalisation (macros, citations, math, quotes, dashes, ligatures, hyphenation) and the
  matching (repeated words by context, no confident match, macro arguments), and an
  inverse search from every word of the project's second page must land on that word;
  hand-written SyncTeX files (no TeX needed) cover the post scriptum's scale and offsets,
  junk in the file, right-to-left lines and symlinked sources.
  `vscode-pdf-mcp-open` runs against fake extension sockets, with okular-mcp-open's
  argument cases and error messages word for word. The contract tests mirror okular-mcp's
  (`tests/test_*.py` there) wherever a case applies to VS Code: the clipboard tools'
  messages and timeouts, the hook's exit 0 on bad input, a closed stdout, an unreadable
  stdin and internal errors, and the C7/C8 path tables.
- `npm run test:webview` serves the webview through `scripts/serve-webview.js` (the same
  HTML and CSP as in VS Code, with a mocked `acquireVsCodeApi`) and drives it with
  `playwright-core`: rendering, mouse selection, goto, reload in place, a half-written
  file, find, the toolbar (Annotations then the minimap icon at its right end, no *Open in
  Okular*; icon buttons with their codicon, an accessible name and a tooltip, the codicon
  font loaded, 22 px high and transparent, a toggled tool in the theme's
  `inputOption.active*` colours rather than the primary button's, the popovers' buttons
  unchanged; too narrow, it scrolls sideways with a plain wheel but not Ctrl+wheel and keeps
  every button whole, in a Chromium that draws scrollbars, so none takes height), and
  marking with a mocked extension: the mini-bar and the `mark`
  request with PDF-space rects, sticky tools, the margin-note click, keys, the popover
  thread and replies, edit/restyle/delete only on own marks, the side panel, and SyncTeX
  with a mocked extension: the Ctrl+hover underline and tip, Ctrl+click (also on a link)
  with the clicked word, the forward-search flash of a line and of a word (a repeated one,
  a hyphenated one, one in the next lines' boxes), and Ctrl+wheel zoom with SyncTeX on,
  and the minimap: thumbnails in each page's aspect ratio that render, its state kept
  next to the marking preferences, the box following goto, scrolling and zoom, click and
  drag, a reload that keeps the thumbnails and re-renders them, marks drawn as coloured
  rects (replies left out), a 60-page document whose minimap scrolls with the pages and
  renders only the thumbnails near view, the emptying of thumbnails far from view (and
  their return), a saved "closed" state that starts it closed, and, with the browser's
  idle callbacks stubbed out, thumbnails copied from the pages the main view draws (also
  after a reload) while a page it has not drawn stays blank.
  With a Python with `pymupdf` (see above) it also checks PyMuPDF-written underlines and
  notes (`scripts/make-annotated-pdf.py`) and links.
- `npm run test:integration` downloads VS Code into `.vscode-test/` with
  `@vscode/test-electron` and runs `test/integration/suite.js` in it with a scratch
  user-data and extensions directory, under `xvfb-run` with `WAYLAND_DISPLAY` and
  `XDG_SESSION_TYPE` unset and Electron pinned to X11, so no window appears on your
  desktop. It leaves your VS Code alone: the extension's state directory
  (`VSCODE_PDF_MCP_DIR`), the user-data and extensions directories and the workspace are
  in a fresh temporary directory, the `VSCODE_*` and `ELECTRON_*` variables of a VS Code
  terminal it may be started from are dropped, and the suite checks that the extension
  uses only these and writes nothing into your state directory. It ends with one line per
  part (ran, or SKIPPED with the reason); `VPDF_STRICT=1` fails the run on a skip.
  `VSCODE_VERSION=1.90.0` tests the oldest supported VS Code. It opens generated
  PDFs, checks the state file, goto over the socket (including opening a closed file and
  `cannot open`), replace-by-rename reloads of a background tab,
  the hook, *Open in Okular* against a fake command (in the command palette only, not
  above the editor), the toolbar in the webview over CDP (no *Open in Okular* button, the
  codicon font loaded through the webview's resource URIs, the minimap icon toggles with a
  real click); with `pdflatex`, a LaTeX project
  compiled into the workspace: Ctrl+click with the real mouse opens the `\input` file at
  the line, *SyncTeX: Show in PDF* and `vscode-pdf-mcp-open --tex` scroll the PDF, both
  down to the word (the flash on the word's text-layer box, the cursor on the clicked
  word, the column from the editor's cursor when the request has none, a word of a
  three-line caption both ways), the entry in a `.tex` editor's right-click menu (custom,
  DOM-drawn menus in the test settings) on a word and on a selection, and not in a Markdown
  editor's menu, a selection gives `tex` and `Source:`, and a rebuild
  refreshes the SyncTeX data. VS Code
  runs with a remote-debugging port and the suite drives the webview with real mouse and
  keyboard input over CDP: it marks a selection, replies to an agent note, edits and
  deletes a mark and
  undoes both with Ctrl+Z (checking that VS Code's own keybindings never see the keys), and
  reads the PDF back with PyMuPDF. A concurrency test has the viewer and
  pdf-reader-writer-mcp's MCP server mark one file at the same time and checks that every
  mark of both is there; a control run against a writer that skips the lock logs what it
  loses. This part needs pdf-reader-writer-mcp's edit service, its MCP server and a
  Python with `pymupdf` (found as above), and is skipped without them. Marks into the LaTeX source: a document that loads todonotes and pdfnotes,
  built with two `pdflatex` runs, its source open in an editor; a highlight made with the
  mouse becomes a `\pdfmark` with an id that is the annotation's `/NM`, and the editor
  shows it; a note on it, its deletion and Ctrl+Z follow in the source (the macro back
  with the same id); with unsaved changes in the source, a mark leaves the file alone until
  it is saved; one sync per action, none from the reloads they cause. It also needs
  protocol 2 of the edit service and pdfnotes.sty (found as above), and is skipped without
  them. On VS Code 1.90, Playwright cannot
  reach the webview's frame, so the mouse-and-keyboard steps are skipped there.
- `node scripts/serve-webview.js some.pdf 8000` serves the webview for a browser by hand.
- Plain JavaScript with `// @ts-check` and JSDoc types, no build step. vscode-free logic
  lives in `lib/` and `extension/{state,ipc,html,editservice,marks,sourcesync,synctexstore}.js`;
  `extension/extension.js` is the glue.

## License

MIT, see [LICENSE](LICENSE). The .vsix also carries VS Code's codicons
(`@vscode/codicons`: the icon font under CC BY 4.0, its code under MIT), with their licence
files.
