#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const home = os.homedir();
const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error("Usage: lumen-claude <task>");
  process.exit(2);
}

const candidates = [
  process.env.CLAUDE_BIN,
  path.join(home, ".local/bin/claude"),
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude"
].filter(Boolean);
const claude = candidates.find((candidate) => fs.existsSync(candidate)) || "claude";
const args = [
  "--session-id", crypto.randomUUID(),
  "--tools", "Bash,Read,Edit,Write,Glob,Grep",
  "--verbose",
  "--permission-mode", "bypassPermissions",
  "--output-format", "stream-json",
  "-p", prompt
];
const child = spawn(claude, args, {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "inherit"],
  env: process.env
});

let final = "";
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
lines.on("line", (line) => {
  try {
    const event = JSON.parse(line);
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      const text = event.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text || "")
        .join("\n\n");
      if (text) final = text;
    }
    if (event.type === "result" && typeof event.result === "string" && event.result) {
      final = event.result;
    }
  } catch {}
});
child.on("error", (error) => {
  console.error(`Could not start Claude Code: ${error.message}`);
});
child.on("exit", (code) => {
  if (final) {
    process.stdout.write(`${final}\n`);
  }
  process.exit(code ?? 1);
});
