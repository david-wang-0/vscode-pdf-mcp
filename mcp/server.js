#!/usr/bin/env node
// @ts-check
/**
 * The MCP stdio server `vscode-pdf`: three tools over the VS Code PDF viewer
 * (CONTRACT C1-C5). Reads the state files the extension publishes; `goto` talks to the
 * extension over its socket.
 */
"use strict";

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const backend = require("../lib/backend");
const { ensureSessionEnv, stateDir } = require("../lib/runtime");

const INSTRUCTIONS =
  "VS Code PDF viewer bridge. viewer_state tells you which PDF the user is reading in a VS Code " +
  "tab and on which page (the active entry first); get_selection returns the text they selected " +
  "in the viewer, with its document and page. This server does not read or write PDF content: " +
  "pair it with pdf-reader-writer-mcp, which takes the path and page reported here. Use goto " +
  "only when the user asks to be shown a place. The viewer re-renders by itself when the file " +
  "changes on disk, and it has no unsaved state.";

/**
 * A successful tool result: the JSON as text, plus structured content.
 * @param {unknown} value
 */
function ok(value) {
  return {
    content: [{ type: /** @type {const} */ ("text"), text: JSON.stringify(value, null, 1) }],
    structuredContent: Array.isArray(value) ? { result: value } : /** @type {Record<string, unknown>} */ (value),
  };
}

/**
 * A tool error carrying `message` verbatim (returned, not thrown, so no layer rewrites it).
 * @param {unknown} e
 */
function fail(e) {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: /** @type {const} */ ("text"), text: message }], isError: true };
}

/** @param {{dir?: string, timeoutMs?: number}} [opts] */
function createServer({ dir, timeoutMs } = {}) {
  const where = () => dir || stateDir();
  const server = new McpServer({ name: "vscode-pdf", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "viewer_state",
    {
      title: "VS Code PDF: open documents and pages",
      description:
        "Which PDF and page VS Code is showing.\n\n" +
        "Every PDF open in a VS Code tab: viewer, window, absolute path, current page (1-based) " +
        "and page count, the active one (the tab the user is looking at) first with active: true.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return ok(backend.viewerState({ dir: where() }));
      } catch (e) {
        return fail(e);
      }
    });

  server.registerTool(
    "get_selection",
    {
      title: "VS Code PDF: selection",
      description:
        "Text the user has selected in the VS Code PDF viewer, with document and page.\n\n" +
        "source='primary' (default): the text selected in the active PDF tab, with its path and the " +
        "page the selection starts on; text is \"\" when nothing is selected. source='clipboard': " +
        "the system clipboard, not tied to any document.",
      inputSchema: { source: z.string().optional().describe("'primary' (default) or 'clipboard'") },
      annotations: { readOnlyHint: true },
    },
    async ({ source }) => {
      try {
        return ok(backend.getSelection(source ?? "primary", { dir: where() }));
      } catch (e) {
        return fail(e);
      }
    });

  server.registerTool(
    "goto",
    {
      title: "VS Code PDF: show a page to the user",
      description:
        "Jump the VS Code PDF viewer to a page for the user.\n\n" +
        "Show `page` (1-based) of `path` (default: the active document), opening the PDF in VS Code " +
        "first if no tab has it. Returns the document's entry after the move. Only when the user asks " +
        "to be shown a place.",
      inputSchema: {
        page: z.number().int().describe("1-based page number"),
        path: z.string().nullable().optional().describe("absolute path of the PDF (default: the active one)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ page, path }) => {
      try {
        return ok(await backend.goto(page, path, { dir: where(), timeoutMs }));
      } catch (e) {
        return fail(e);
      }
    });

  return server;
}

async function main() {
  ensureSessionEnv();
  await createServer().connect(new StdioServerTransport());
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`vscode-pdf-mcp: ${e instanceof Error ? e.stack : e}\n`);
    process.exit(1);
  });
}

module.exports = { createServer, INSTRUCTIONS };
