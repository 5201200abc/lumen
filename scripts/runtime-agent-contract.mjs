import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const outputDir = mkdtempSync(path.join(os.tmpdir(), "lumen-agent-contract-"));
try {
  execFileSync(
    path.join(process.cwd(), "node_modules", ".bin", "tsc"),
    [
      "src/main/agent-runtime.ts",
      "--target", "ES2022",
      "--module", "ESNext",
      "--moduleResolution", "Bundler",
      "--outDir", outputDir,
      "--skipLibCheck",
      "--strict"
    ],
    { cwd: process.cwd(), stdio: "pipe" }
  );
  const source = readFileSync(
    path.join(process.cwd(), "src", "main", "agent-runtime.ts"),
    "utf8"
  );
  for (const eventType of [
    "session",
    "status",
    "message_start",
    "content_start",
    "content_delta",
    "content_stop",
    "assistant",
    "tool_result",
    "result"
  ]) {
    assert(source.includes(`type: "${eventType}"`), `Missing runtime event ${eventType}`);
  }
  assert.match(source, /AgentRuntimeKind = "native"/);
  assert.doesNotMatch(source, /Anthropic|Claude|OpenAI/);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    runtime: "native",
    eventTypes: 9,
    providerNeutral: true
  })}\n`);
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
