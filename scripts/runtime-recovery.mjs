import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const outputDir = mkdtempSync(path.join(os.tmpdir(), "lumen-recovery-"));
try {
  execFileSync(
    path.join(process.cwd(), "node_modules", ".bin", "tsc"),
    [
      "src/main/cowork-recovery.ts",
      "--target", "ES2022",
      "--module", "NodeNext",
      "--moduleResolution", "NodeNext",
      "--outDir", outputDir,
      "--skipLibCheck"
    ],
    { cwd: process.cwd(), stdio: "pipe" }
  );
  const recovery = await import(pathToFileURL(path.join(outputDir, "cowork-recovery.js")));
  const outputError = "API Error: Model response exceeded the 20000 output token maximum.";
  const contextError = '{"error":{"code":400,"message":"request (16670 tokens) exceeds the available context size (16384 tokens), try increasing it","type":"exceedcontextsizeerror","nprompttokens":16670,"nctx":16384}}';
  const fetchError = "API Error: 400 TypeError: fetch failed";

  assert.equal(recovery.isOutputLimitError(outputError), true);
  assert.equal(recovery.isContextOverflowError(contextError), true);
  assert.equal(recovery.isTransientBackendError(fetchError), true);
  assert.equal(recovery.stripRuntimeApiError(fetchError), "");
  assert.equal(recovery.stripOutputLimitError(`partial result\n${outputError}`), "partial result");
  assert.equal(
    recovery.stripOutputBoundaryMarker(`partial result${recovery.OUTPUT_BOUNDARY_MARKER}`),
    "partial result"
  );

  const prompt = recovery.buildOutputRecoveryPrompt({
    effectivePrompt: "Implement the requested feature.",
    assistantContent: "Phase one completed.",
    assistantThinking: "The next pending action is to write the file.",
    completedTools: [{
      name: "Write",
      status: "completed",
      input: { file_path: "/tmp/example" },
      output: "ok"
    }]
  });
  assert.match(prompt, /Phase one completed/);
  assert.match(prompt, /The next pending action is to write the file/);
  assert.doesNotMatch(prompt, /<original_task>/);
  assert.match(prompt, /Begin this response with the next native tool call/);
  assert.match(prompt, /Do not repeat text, code, tool calls, or checks already completed/);
  assert.doesNotMatch(recovery.stripOutputLimitError(outputError), /API Error|output token maximum/);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    outputLimitDetected: true,
    contextOverflowDetected: true,
    rawErrorRemoved: true,
    transientFetchErrorRemoved: true,
    boundaryMarkerRemoved: true,
    recoveryPromptBounded: prompt.length < 30_000
  })}\n`);
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
