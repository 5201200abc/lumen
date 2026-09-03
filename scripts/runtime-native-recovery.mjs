import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const outputDir = mkdtempSync(path.join(os.tmpdir(), "lumen-native-recovery-"));
const workspace = mkdtempSync(path.join(os.tmpdir(), "lumen-native-recovery-workspace-"));
const sessionRoot = mkdtempSync(path.join(os.tmpdir(), "lumen-native-recovery-sessions-"));
let server;

function sse(response, content, finishReason = "stop") {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  response.write(`data: ${JSON.stringify({
    choices: [{ delta: {}, finish_reason: finishReason }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

try {
  execFileSync(
    path.join(process.cwd(), "node_modules", ".bin", "tsc"),
    [
      "src/main/agent-runtime.ts",
      "src/main/native-model-client.ts",
      "src/main/native-context.ts",
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
  const {
    compactNativeMessages,
    estimateNativeMessages
  } = await import(pathToFileURL(path.join(outputDir, "native-context.js")));

  const compactInput = [
    { role: "system", content: "system" },
    { role: "user", content: `old task ${"x".repeat(1_000)}` },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "old-call",
        type: "function",
        function: { name: "Read", arguments: '{"file_path":"old.txt"}' }
      }]
    },
    { role: "tool", tool_call_id: "old-call", content: `old result ${"y".repeat(1_000)}` },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "latest task" }
  ];
  const compacted = compactNativeMessages(compactInput, 300);
  assert.equal(compacted.compacted, true);
  assert.equal(compacted.messages[0].role, "system");
  assert.match(compacted.messages[1].content, /Compacted prior Cowork context/);
  assert.equal(compacted.messages.at(-1).content, "latest task");
  assert(estimateNativeMessages(compacted.messages) < estimateNativeMessages(compactInput));

  const counts = new Map();
  const seenRequests = [];
  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    seenRequests.push(parsed);
    const count = counts.get(parsed.model) || 0;
    counts.set(parsed.model, count + 1);
    if (parsed.model === "overflow" && count === 0) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end('{"error":{"message":"request exceeds context size n_ctx=256"}}');
      return;
    }
    if (parsed.model === "length") {
      sse(response, count === 0 ? "PART_A" : "PART_B", count === 0 ? "length" : "stop");
      return;
    }
    sse(response, `AUTO_${count + 1}`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  function runtime(model, env = {}) {
    const events = [];
    const terminalQueue = [];
    const terminalWaiters = [];
    const instance = startNativeAgentRuntime({
      prompt: "",
      persistent: true,
      cwd: workspace,
      model,
      modelEndpoint: { baseUrl },
      tools: [],
      mcpServer: { command: "", args: [], env: {} },
      env: {
        LUMEN_NATIVE_SESSION_DIR: sessionRoot,
        ...env
      },
      permissionMode: "bypassPermissions",
      onStderr: () => {},
      onEvent: (event) => {
        events.push(event);
        if (event.type !== "result") return;
        const waiter = terminalWaiters.shift();
        if (waiter) waiter(event);
        else terminalQueue.push(event);
      }
    });
    const nextResult = () => {
      const value = terminalQueue.shift();
      if (value) return Promise.resolve(value);
      return new Promise((resolve) => terminalWaiters.push(resolve));
    };
    return { instance, events, nextResult };
  }

  const overflow = runtime("overflow", { LUMEN_CONTEXT_WINDOW: "512" });
  overflow.instance.send(`recover ${"z".repeat(900)}`, "overflow-session");
  const overflowResult = await overflow.nextResult();
  assert.equal(overflowResult.success, true);
  assert.equal(counts.get("overflow"), 2);
  assert(overflow.events.some(
    (event) => event.type === "status" && event.status === "compacting"
  ));
  overflow.instance.close();
  await overflow.instance.done;

  const length = runtime("length");
  length.instance.send("continue output", "length-session");
  const lengthResult = await length.nextResult();
  assert.equal(lengthResult.success, true);
  assert.equal(counts.get("length"), 2);
  assert.deepEqual(
    length.events
      .filter((event) => event.type === "assistant")
      .flatMap((event) => event.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text),
    ["PART_A", "PART_B"]
  );
  const continuationRequest = seenRequests.find(
    (request) => request.model === "length" &&
      request.messages.some((message) => /exact unfinished point/.test(message.content || ""))
  );
  assert(continuationRequest);
  length.instance.close();
  await length.instance.done;

  const auto = runtime("auto", {
    LUMEN_CONTEXT_WINDOW: "600",
    LUMEN_AUTO_COMPACT_RATIO: "0.5"
  });
  auto.instance.send(`first ${"a".repeat(500)}`, "auto-1");
  assert.equal((await auto.nextResult()).success, true);
  auto.instance.send(`second ${"b".repeat(500)}`, "auto-2");
  assert.equal((await auto.nextResult()).success, true);
  assert(auto.events.some(
    (event) => event.type === "status" && event.status === "compacting"
  ));
  auto.instance.close();
  await auto.instance.done;

  process.stdout.write(`${JSON.stringify({
    ok: true,
    compactedMessages: compacted.messages.length,
    overflowRequests: counts.get("overflow"),
    outputSegments: counts.get("length"),
    autoCompactObserved: true
  })}\n`);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  rmSync(outputDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  rmSync(sessionRoot, { recursive: true, force: true });
}
