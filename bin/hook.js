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
  if (out) process.stdout.write(out + "\n");
} catch {
  // Never block a prompt.
}
process.exitCode = 0;
