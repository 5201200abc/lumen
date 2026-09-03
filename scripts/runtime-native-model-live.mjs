import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const outputDir = mkdtempSync(path.join(os.tmpdir(), "lumen-native-model-live-"));
try {
  execFileSync(
    path.join(process.cwd(), "node_modules", ".bin", "tsc"),
    [
      "src/main/native-model-client.ts",
      "--target", "ES2022",
      "--module", "ESNext",
      "--moduleResolution", "Bundler",
      "--outDir", outputDir,
      "--skipLibCheck",
      "--strict"
    ],
    { cwd: process.cwd(), stdio: "pipe" }
  );
  const { NativeModelClient } = await import(
    pathToFileURL(path.join(outputDir, "native-model-client.js"))
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240_000);
  const events = [];
  try {
    const client = new NativeModelClient(
      process.env.LUMEN_MODEL_URL || "http://127.0.0.1:18123/v1"
    );
    const response = await client.stream({
      model: process.env.LUMEN_MODEL || "Gemma4-26B-A4B",
      messages: [{
        role: "user",
        content: "Reply with exactly LUMEN_NATIVE_MODEL_OK and nothing else."
      }],
      temperature: 0,
      maxTokens: 64,
      reasoningEffort: "none",
      signal: controller.signal
    }, (event) => events.push(event));
    assert.match(response.message.content, /LUMEN_NATIVE_MODEL_OK/);
    assert(events.some((event) => event.type === "text_delta"));
    assert.notEqual(response.finishReason, "length");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      model: process.env.LUMEN_MODEL || "Gemma4-26B-A4B",
      finishReason: response.finishReason,
      eventTypes: [...new Set(events.map((event) => event.type))],
      content: response.message.content.trim()
    })}\n`);
  } finally {
    clearTimeout(timeout);
  }
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
