import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const outputDir = mkdtempSync(path.join(os.tmpdir(), "lumen-native-agent-build-"));
const workspace = mkdtempSync(path.join(os.tmpdir(), "lumen-native-agent-workspace-"));
const sessionRoot = mkdtempSync(path.join(os.tmpdir(), "lumen-native-agent-sessions-"));
let server;

function sse(response, payloads) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const payload of payloads) response.write(`data: ${JSON.stringify(payload)}\n\n`);
  response.end("data: [DONE]\n\n");
}

try {
  execFileSync(
    path.join(process.cwd(), "node_modules", ".bin", "tsc"),
    [
      "src/main/agent-runtime.ts",
      "src/main/native-model-client.ts",
      "src/main/native-agent-tools.ts",
      "src/main/native-agent-runtime.ts",
      "--target", "ES2022",
      "--module", "ESNext",
      "--moduleResolution", "Bundler",
      "--outDir", outputDir,
      "--skipLibCheck",
      "--strict",
      "--esModuleInterop"
    ],
    { cwd: process.cwd(), stdio: "pipe" }
  );
  const { startNativeAgentRuntime } = await import(
    pathToFileURL(path.join(outputDir, "native-agent-runtime.js"))
  );
  const { executeNativeCoreTool } = await import(
    pathToFileURL(path.join(outputDir, "native-agent-tools.js"))
  );

  writeFileSync(path.join(workspace, "input.txt"), "native agent evidence\n", "utf8");
  const toolSignal = new AbortController().signal;
  assert.equal((await executeNativeCoreTool(
    "Write",
    { file_path: "core.txt", content: "alpha\n" },
    workspace,
    toolSignal
  )).isError, false);
  assert.equal((await executeNativeCoreTool(
    "Edit",
    { file_path: "core.txt", old_string: "alpha", new_string: "beta" },
    workspace,
    toolSignal
  )).isError, false);
  assert.match((await executeNativeCoreTool(
    "Read",
    { file_path: "core.txt" },
    workspace,
    toolSignal
  )).content, /beta/);
  assert.match((await executeNativeCoreTool(
    "Glob",
    { pattern: "*.txt" },
    workspace,
    toolSignal
  )).content, /core\.txt/);
  assert.match((await executeNativeCoreTool(
    "Grep",
    { pattern: "beta" },
    workspace,
    toolSignal
  )).content, /core\.txt/);
  assert.match((await executeNativeCoreTool(
    "Bash",
    { command: "pwd" },
    workspace,
    toolSignal
  )).content, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const rounds = new Map();
  const requests = [];
  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push(parsed);
    const round = rounds.get(parsed.model) || 0;
    rounds.set(parsed.model, round + 1);

    if (round === 0) {
      const isAllow = parsed.model !== "deny";
      const toolName = isAllow ? "Read" : "Write";
      const args = isAllow
        ? '{"file_path":"input.txt","limit":10}'
        : '{"file_path":"denied.txt","content":"must not exist"}';
      sse(response, [
        { choices: [{ delta: { reasoning_content: "Use a tool." } }] },
        { choices: [{ delta: { tool_calls: [{
          index: 0,
          id: `call-${parsed.model}`,
          type: "function",
          function: { name: toolName, arguments: args }
        }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: {
          prompt_tokens: 20,
          completion_tokens: 5,
          total_tokens: 25
        } }
      ]);
      return;
    }
    if (parsed.model === "empty" && round === 2) {
      assert.equal(parsed.messages.at(-1)?.role, "user");
      assert.match(parsed.messages.at(-1)?.content || "", /final answer now/);
      sse(response, [
        { choices: [{ delta: { content: "EMPTY_RECOVERED_OK" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] }
      ]);
      return;
    }
    const toolMessage = parsed.messages.at(-1);
    assert.equal(toolMessage.role, "tool");
    if (parsed.model !== "deny") assert.match(toolMessage.content, /native agent evidence/);
    else assert.match(toolMessage.content, /denied by test/);
    if (parsed.model === "empty") {
      sse(response, [{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
      return;
    }
    sse(response, [
      { choices: [{ delta: { content: parsed.model === "allow" ? "READ_OK" : "DENIED_OK" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: {
        prompt_tokens: 30,
        completion_tokens: 2,
        total_tokens: 32
      } }
    ]);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  async function run(model, permissionMode, canUseTool) {
    const events = [];
    let resolveTerminal;
    const terminal = new Promise((resolve) => { resolveTerminal = resolve; });
    const runtime = startNativeAgentRuntime({
      prompt: "",
      persistent: true,
      cwd: workspace,
      model,
      modelEndpoint: { baseUrl },
      tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      mcpServer: { command: "", args: [], env: {} },
      env: { LUMEN_NATIVE_SESSION_DIR: sessionRoot },
      permissionMode,
      canUseTool,
      onStderr: () => {},
      onEvent: (event) => {
        events.push(event);
        if (event.type === "result") resolveTerminal(event);
      }
    });
    runtime.send("perform the test", `session-${model}`);
    const result = await Promise.race([
      terminal,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Native Agent timed out.")), 5_000))
    ]);
    runtime.close();
    await runtime.done;
    return { events, result };
  }

  const allowed = await run("allow", "bypassPermissions");
  assert.equal(allowed.result.success, true);
  assert.equal(allowed.result.output, "READ_OK");
  const allowedToolResults = allowed.events.filter((event) => event.type === "tool_result");
  assert.equal(allowedToolResults.length, 1);
  assert.equal(allowedToolResults[0].isError, false);

  let permissionChecks = 0;
  const denied = await run("deny", "default", async () => {
    permissionChecks += 1;
    return { behavior: "deny", message: "denied by test" };
  });
  assert.equal(denied.result.success, true);
  assert.equal(permissionChecks, 1);
  const deniedToolResults = denied.events.filter((event) => event.type === "tool_result");
  assert.equal(deniedToolResults.length, 1);
  assert.equal(deniedToolResults[0].isError, true);
  assert.equal(existsSync(path.join(workspace, "denied.txt")), false);

  const emptyRecovered = await run("empty", "bypassPermissions");
  assert.equal(emptyRecovered.result.success, true);
  assert.equal(emptyRecovered.result.output, "EMPTY_RECOVERED_OK");

  for (const runResult of [allowed, denied, emptyRecovered]) {
    const assistantsWithTools = runResult.events.filter(
      (event) => event.type === "assistant" &&
        event.content.some((block) => block.type === "tool_use")
    );
    assert.equal(assistantsWithTools.length, 1);
    assert.equal(
      runResult.events.filter((event) => event.type === "tool_result").length,
      assistantsWithTools[0].content.filter((block) => block.type === "tool_use").length
    );
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    modelCalls: requests.length,
    allowToolResults: allowedToolResults.length,
    denyToolResults: deniedToolResults.length,
    emptyFinalRecovered: true,
    permissionChecks,
    coreToolsChecked: 6,
    deniedFileCreated: false
  })}\n`);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  rmSync(outputDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  rmSync(sessionRoot, { recursive: true, force: true });
}
