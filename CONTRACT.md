# Viewer-state contract (v1)

Two MCP servers tell an agent what the user is reading: `okular-mcp` (Okular, over D-Bus)
and `vscode-pdf-mcp` (a PDF viewer inside VS Code). They implement **the same contract**,
so an agent, a hook or a rule written against one works with the other. Neither reads or
writes PDF content: that is `pdf-reader-writer-mcp`, which takes the `path` and `page`
these servers report.

Both repositories keep an identical copy of this file. Every numbered clause is pinned by
unit tests in each repository, named after the clause (`test_c3_...` in Python,
`"C3: ..."` in `node:test`). Change the clause and both copies together.

## Terms

- **Entry**: one open document in one viewer window or tab:

  ```json
  {"viewer": "okular", "window": "<opaque id>", "path": "/abs/paper.pdf",
   "page": 3, "pages": 12, "active": true}
  ```

  `viewer` is `"okular"` or `"vscode"`. `window` identifies the window or tab well enough
  to tell entries apart; its format is the server's own. `path` is absolute. `page` is
  1-based. `pages` is the page count.
- **Active entry**: the one document the user is taken to be looking at. VS Code: the
  active PDF tab of the most recently focused VS Code window, or, if no window has a PDF
  tab as its active editor, the PDF tab that was active most recently. Okular: the first
  window that has a document open (Okular reports no focus).

## Tools

**C1. `viewer_state()`** returns the list of entries, the active one first, with
`active: true` on exactly that one and `false` on the rest. If no window has a document
open (including the viewer not running), it raises a tool error whose message starts
`no <viewer> window with a PDF open` (`<viewer>` = `Okular` or `VS Code`), optionally
followed by a cause in brackets, e.g. ` (Okular is not running on the session bus)`.

All error messages in this contract are the server's own text. An MCP SDK may put a
prefix in front of it (the Python SDK reports `Error executing tool <name>: <message>`);
"starts" and quoted messages refer to the text after any such prefix.

**C2. `get_selection(source="primary")`** returns
`{"text": str, "source": str}` plus `viewer`, `path` and `page` when the selection can be
attributed to a document. `text` is `""` when nothing is selected (not an error).
- `source="primary"`, VS Code: the text selected in the PDF viewer, with the document and
  the page the selection starts on. Never the system primary selection.
- `source="primary"`, Okular: the system primary selection (`wl-paste --primary`,
  else `xclip`/`xsel`), attributed to the active entry's path and page.
- `source="clipboard"`: the system clipboard, never attributed (no `viewer`/`path`/`page`).
- Any other `source` raises a tool error `source must be 'primary' or 'clipboard'`.

**C3. `goto(page, path=None)`** shows `page` of `path` (default: the active entry's
document), opening the document first if no window has it open, and returns the entry of
the document after the move, with `page` equal to the requested page.
- Errors: `page N outside 1-M` for a page out of range; `no such file: <path>` for a path
  that does not exist; `cannot open <path>` for a file the viewer fails to load (checked
  before the page range); C1's message if `path` is omitted and nothing is open.
- Paths are compared after resolving symlinks (realpath).
- Agents call it only when the user asks to be shown a place.

**C4.** The servers never write to the PDF and have no reload tool. Both viewers watch the
file and re-render when `pdf-reader-writer-mcp` changes it. (Okular keeps the user's
**unsaved** annotations in memory and loses them on reload, so agents still ask the user to
save in Okular before writing. The VS Code viewer has no unsaved state.)

**C5.** Session environment: when `DBUS_SESSION_BUS_ADDRESS`, `WAYLAND_DISPLAY` or
`XDG_RUNTIME_DIR` is missing (minimal MCP client environments), the server fills it from
`XDG_RUNTIME_DIR` or `/run/user/<uid>` before calling any external tool.

## Prompt hook

**C6.** Each repository ships a hook executable (`okular-mcp-hook`, `vscode-pdf-mcp-hook`)
for Claude Code's `UserPromptSubmit` event. It reads the event JSON on stdin (it uses
only `cwd`) and either prints nothing or prints exactly one JSON object:

```json
{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "<TEXT>"}}
```

It **always exits 0**, even on bad input or internal errors (it must never block a prompt),
and finishes well inside a second.

**C7.** `<TEXT>` is, with `<Viewer>` = `VS Code` or `Okular`:

```
The user is reading <path> in <Viewer>, page <page> of <pages>.
```

followed, when the selection is attributable to that document (C2), by:

```
Selected text (page <p>):
<text>
```

The selected text is cut at 2000 characters, with ` […]` appended when cut. The Okular
hook omits the selection: the system primary selection cannot be tied to Okular (it may
come from the terminal the user is typing in).

**C8.** The hook prints something only when there is an active entry (VS Code: one that is
currently its window's active editor, not the most-recent fallback of the Terms) and it
is *relevant to `cwd`*: the PDF lies inside `cwd`, or (VS Code) one of that window's workspace folders
equals `cwd` or contains it or lies inside it. Otherwise, it prints nothing.
