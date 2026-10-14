#!/usr/bin/env node
// @ts-check
// Claude Code UserPromptSubmit hook (CONTRACT C6-C8): tells the model which PDF the user
// is reading in VS Code. Reads only the state files, never a socket; always exits 0.
"use strict";

try {
  const fs = require("node:fs");
  const { readStates } = require("../lib/backend");
  const { hookOutput } = require("../lib/hook");
  let input = "";
  try {
    if (!process.stdin.isTTY) input = fs.readFileSync(0, "utf8");
  } catch {
    input = "";
  }
  let event = null;
  try {
    event = JSON.parse(input);
  } catch {
    event = null;
  }
  const out = hookOutput(event, readStates());
  // A reader that has gone (EPIPE) is reported on the stream, not thrown: without a
  // listener it would end the hook with exit 1.
  process.stdout.on("error", () => {});
  if (out) process.stdout.write(out + "\n");
} catch {
  // Never block a prompt.
}
process.exitCode = 0;
