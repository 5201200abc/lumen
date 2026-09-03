import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const outputDir = mkdtempSync(path.join(os.tmpdir(), "lumen-native-model-"));
let server;
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

  const requests = [];
  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push({ url: request.url, body: parsed, authorization: request.headers.authorization });

    if (parsed.model === "http-error") {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end('{"error":{"message":"context size exceeded"}}');
      return;
    }
    if (!parsed.stream) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: "complete",
            reasoning_content: "checked",
            tool_calls: [{
              id: "call-complete",
              type: "function",
              function: { name: "Read", arguments: "{\"path\":\"a\"}" }
            }]
          },
          finish_reason: "tool_calls"
        }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
      }));
      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache"
    });
    const events = [
      ': keepalive\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"inspect "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"hello "}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"Re","arguments":"{\\"path\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"ad","arguments":"\\"a\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17,"prompt_tokens_details":{"cached_tokens":2}}}\n\n',
      'data: [DONE]\n\n'
    ];
    for (const event of events) {
      const midpoint = Math.max(1, Math.floor(event.length / 2));
      response.write(event.slice(0, midpoint));
      response.write(event.slice(midpoint));
    }
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const client = new NativeModelClient(`http://127.0.0.1:${address.port}/v1/`, "secret");

  const events = [];
  const streamed = await client.stream({
    model: "gemma",
    messages: [{ role: "user", content: "test" }],
    tools: [{
      type: "function",
      function: {
        name: "Read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } }
      }
    }],
    toolChoice: "auto",
    maxTokens: 256,
    reasoningEffort: "high"
  }, (event) => events.push(event));

  assert.equal(streamed.reasoning, "inspect ");
  assert.equal(streamed.message.content, "hello ");
  assert.deepEqual(streamed.message.tool_calls, [{
    id: "call-1",
    type: "function",
    function: { name: "Read", arguments: "{\"path\":\"a\"}" }
  }]);
  assert.equal(streamed.finishReason, "tool_calls");
  assert.deepEqual(streamed.usage, {
    promptTokens: 12,
    completionTokens: 5,
    totalTokens: 17,
    cacheTokens: 2
  });
  assert.deepEqual(events.map((event) => event.type), [
    "reasoning_delta",
    "text_delta",
    "tool_call_delta",
    "tool_call_delta",
    "finish",
    "usage"
  ]);

  const completed = await client.complete({
    model: "gemma",
    messages: [{ role: "user", content: "test" }]
  });
  assert.equal(completed.message.content, "complete");
  assert.equal(completed.reasoning, "checked");
  assert.equal(completed.message.tool_calls?.[0].function.name, "Read");

  await assert.rejects(
    () => client.complete({
      model: "http-error",
      messages: [{ role: "user", content: "overflow" }]
    }),
    /OpenAI-compatible model 400: .*context size exceeded/
  );
  assert.equal(requests[0].url, "/v1/chat/completions");
  assert.equal(requests[0].authorization, "Bearer secret");
  assert.equal(requests[0].body.stream, true);
  assert.equal(requests[0].body.tools[0].function.name, "Read");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    endpoint: requests[0].url,
    streamEvents: events.length,
    toolCalls: streamed.message.tool_calls?.length,
    httpErrorChecked: true
  })}\n`);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  rmSync(outputDir, { recursive: true, force: true });
}
