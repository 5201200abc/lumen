import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const outputDir = mkdtempSync(path.join(os.tmpdir(), "lumen-native-mcp-build-"));
const workspace = mkdtempSync(path.join(os.tmpdir(), "lumen-native-mcp-workspace-"));
const sessions = mkdtempSync(path.join(os.tmpdir(), "lumen-native-mcp-sessions-"));
let toolServer;
let modelServer;

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
      "src/main/native-context.ts",
      "src/main/native-session.ts",
      "src/main/native-mcp-client.ts",
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
  const { NativeMcpClient } = await import(
    pathToFileURL(path.join(outputDir, "native-mcp-client.js"))
  );
  const { startNativeAgentRuntime } = await import(
    pathToFileURL(path.join(outputDir, "native-agent-runtime.js"))
  );

  const toolCalls = [];
  toolServer = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer mcp-secret");
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    toolCalls.push(parsed);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      content: {
        called: parsed.name,
        arguments: parsed.arguments,
        workspace: parsed.workspace
      }
    }));
  });
  await new Promise((resolve) => toolServer.listen(0, "127.0.0.1", resolve));
  const toolAddress = toolServer.address();
  assert(toolAddress && typeof toolAddress === "object");
  const mcpEnv = {
    LUMEN_TOOL_HOST_URL: `http://127.0.0.1:${toolAddress.port}`,
    LUMEN_TOOL_HOST_TOKEN: "mcp-secret",
    LUMEN_TOOL_WORKSPACE: workspace,
    LUMEN_PLUGIN_BROWSER: "1",
    LUMEN_PLUGIN_SITES: "1",
    LUMEN_PLUGIN_MANAGEMENT: "1",
    LUMEN_COMPUTER_USE_CHROME: "1"
  };
  const mcpScript = path.join(process.cwd(), "resources", "runtime", "lumen-tools.mjs");
  const client = new NativeMcpClient(process.execPath, [mcpScript], mcpEnv, () => {});
  const listed = await client.start();
  const names = listed.map((tool) => tool.function.name);
  for (const expected of [
    "mcp__lumen__web_search",
    "mcp__lumen__sites_preview",
    "mcp__lumen__plugins_list",
    "mcp__lumen__skills_list",
    "mcp__lumen__skills_read",
    "mcp__lumen__chrome_snapshot"
  ]) assert(names.includes(expected), `Missing MCP tool ${expected}`);
  const direct = await client.call("mcp__lumen__skills_list", {});
  assert.equal(direct.isError, false);
  assert.match(direct.content, /skills_list/);
  client.close();

  let modelCalls = 0;
  let modelToolNames = [];
  modelServer = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    modelCalls += 1;
    modelToolNames = parsed.tools.map((tool) => tool.function.name);
    if (modelCalls === 1) {
      sse(response, [
        { choices: [{ delta: { tool_calls: [{
          index: 0,
          id: "skill-list-1",
          type: "function",
          function: { name: "mcp__lumen__skills_list", arguments: "{}" }
        }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
      ]);
      return;
    }
    assert.equal(parsed.messages.at(-1).role, "tool");
    assert.match(parsed.messages.at(-1).content, /skills_list/);
    sse(response, [
      { choices: [{ delta: { content: "MCP_AGENT_OK" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] }
    ]);
  });
  await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const modelAddress = modelServer.address();
  assert(modelAddress && typeof modelAddress === "object");

  let resolveResult;
  const terminal = new Promise((resolve) => { resolveResult = resolve; });
  const events = [];
  const runtime = startNativeAgentRuntime({
    prompt: "",
    persistent: true,
    cwd: workspace,
    model: "mcp-agent",
    modelEndpoint: { baseUrl: `http://127.0.0.1:${modelAddress.port}/v1` },
    tools: ["mcp__lumen__skills_list"],
    mcpServer: {
      command: process.execPath,
      args: [mcpScript],
      env: mcpEnv
    },
    env: { LUMEN_NATIVE_SESSION_DIR: sessions },
    permissionMode: "bypassPermissions",
    onStderr: () => {},
    onEvent: (event) => {
      events.push(event);
      if (event.type === "result") resolveResult(event);
    }
  });
  runtime.send("list skills", "mcp-turn");
  const result = await terminal;
  assert.equal(result.success, true);
  assert.equal(result.output, "MCP_AGENT_OK");
  assert.deepEqual(modelToolNames, ["mcp__lumen__skills_list"]);
  assert.equal(events.filter((event) => event.type === "tool_result").length, 1);
  runtime.close();
  await runtime.done;

  process.stdout.write(`${JSON.stringify({
    ok: true,
    listedTools: names.length,
    ecosystems: ["web", "chrome", "sites", "plugins", "skills"],
    agentModelCalls: modelCalls,
    toolResults: events.filter((event) => event.type === "tool_result").length
  })}\n`);
} finally {
  if (toolServer) await new Promise((resolve) => toolServer.close(resolve));
  if (modelServer) await new Promise((resolve) => modelServer.close(resolve));
  rmSync(outputDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  rmSync(sessions, { recursive: true, force: true });
}
