#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const home = os.homedir();
const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error("Usage: lumen-codex <task>");
  process.exit(2);
}
const candidates = [
  process.env.CODEX_BIN,
  path.join(home, ".nvm/versions/node/v20.19.4/bin/codex"),
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex"
].filter(Boolean);
const codex = candidates.find((candidate) => fs.existsSync(candidate)) || "codex";
const model = process.env.LLAMA_MODEL_ALIAS || "Qwen3.8-27B";
const effort = process.env.CLAUDE_EFFORT || "medium";
const permissionMode = process.env.LUMEN_COWORK_PERMISSION_MODE || "full";
const permissionArgs =
  permissionMode === "ask" ? ["--sandbox", "workspace-write"]
    : permissionMode === "approve" ? ["--approve-for-me"]
      : ["--dangerously-bypass-approvals-and-sandbox"];
const args = [
  "exec", "--json", "--skip-git-repo-check",
  ...permissionArgs,
  "-m", model,
  "-c", 'model_provider="lumen_local"',
  "-c", 'model_providers.lumen_local={ name = "Lumen Llama", base_url = "http://127.0.0.1:18085/v1", wire_api = "responses", requires_openai_auth = false }',
  "-c", `model_reasoning_effort=${JSON.stringify(effort)}`,
  "-c", "model_context_window=16384",
  "-C", process.cwd(),
  prompt
];
const child = spawn(codex, args, { stdio: ["ignore", "pipe", "inherit"], env: process.env });
let final = "";
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
lines.on("line", (line) => {
  try {
    const event = JSON.parse(line);
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      final = event.item.text || final;
    }
  } catch {}
});
child.on("error", (error) => {
  console.error(`Could not start Codex: ${error.message}`);
});
child.on("exit", (code) => {
  if (final) {
    process.stdout.write(`${final}\n`);
  }
  process.exit(code ?? 1);
});
