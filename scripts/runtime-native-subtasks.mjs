import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const outputDir = mkdtempSync(path.join(os.tmpdir(), "lumen-subtasks-build-"));
const workspace = mkdtempSync(path.join(os.tmpdir(), "lumen-subtasks-repo-"));
const sessions = mkdtempSync(path.join(os.tmpdir(), "lumen-subtasks-sessions-"));
const worktrees = mkdtempSync(path.join(os.tmpdir(), "lumen-subtasks-worktrees-"));
const hangingResponses = new Set();
let server;

function sse(response, payloads) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const payload of payloads) response.write(`data: ${JSON.stringify(payload)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function toolCall(response, id, name, args) {
  sse(response, [
    { choices: [{ delta: { tool_calls: [{
      index: 0,
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) }
    }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
  ]);
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
  const { startNativeAgentRuntime } = await import(
    pathToFileURL(path.join(outputDir, "native-agent-runtime.js"))
  );

  execFileSync("git", ["init", "-q", workspace]);
  execFileSync("git", ["-C", workspace, "config", "user.email", "test@lumen.local"]);
  execFileSync("git", ["-C", workspace, "config", "user.name", "Lumen Test"]);
  writeFileSync(path.join(workspace, "seed.txt"), "seed\n", "utf8");
  execFileSync("git", ["-C", workspace, "add", "seed.txt"]);
  execFileSync("git", ["-C", workspace, "commit", "-qm", "seed"]);

  const parentPhases = new Map();
  const childWorkspaces = [];
  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    const system = parsed.messages[0]?.content || "";
    const isChild = /focused Lumen subagent/.test(system);
    if (isChild) {
      const childWorkspace = system.match(/Active workspace:\s*(.+)/)?.[1]?.trim();
      childWorkspaces.push({ model: parsed.model, path: childWorkspace });
      if (parsed.model === "stop") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(': waiting\n\n');
        hangingResponses.add(response);
        request.once("close", () => hangingResponses.delete(response));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
      sse(response, [
        { choices: [{ delta: { content: "CHILD_BACKGROUND_OK" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] }
      ]);
      return;
    }

    const phase = parentPhases.get(parsed.model) || 0;
    parentPhases.set(parsed.model, phase + 1);
    if (phase === 0) {
      toolCall(response, `task-${parsed.model}`, "Task", {
        prompt: "Inspect the delegated workspace and report CHILD_BACKGROUND_OK.",
        description: `${parsed.model} delegated check`,
        run_in_background: true,
        isolation: parsed.model === "background" ? "worktree" : "workspace"
      });
      return;
    }
    const lastTool = parsed.messages.at(-1);
    assert.equal(lastTool.role, "tool");
    const result = JSON.parse(lastTool.content);
    if (phase === 1) {
      toolCall(
        response,
        `${parsed.model}-control`,
        parsed.model === "background" ? "TaskOutput" : "TaskStop",
        parsed.model === "background"
          ? { task_id: result.task_id, block: true, timeout_ms: 5_000 }
          : { task_id: result.task_id }
      );
      return;
    }
    if (parsed.model === "background") {
      assert.equal(result.status, "completed");
      assert.match(result.output, /CHILD_BACKGROUND_OK/);
    } else {
      assert.equal(result.status, "stopped");
    }
    sse(response, [
      { choices: [{ delta: {
        content: parsed.model === "background"
          ? "PARENT_BACKGROUND_OK"
          : "PARENT_STOP_OK"
      } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] }
    ]);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  async function run(model) {
    const events = [];
    let resolveResult;
    const terminal = new Promise((resolve) => { resolveResult = resolve; });
    const runtime = startNativeAgentRuntime({
      prompt: "",
      persistent: true,
      cwd: workspace,
      model,
      modelEndpoint: { baseUrl },
      tools: ["Task", "TaskOutput", "TaskStop"],
      mcpServer: { command: "", args: [], env: {} },
      env: {
        LUMEN_NATIVE_SESSION_DIR: sessions,
        LUMEN_WORKTREE_ROOT: worktrees
      },
      permissionMode: "bypassPermissions",
      onStderr: () => {},
      onEvent: (event) => {
        events.push(event);
        if (event.type === "result") resolveResult(event);
      }
    });
    runtime.send(`run ${model} subtask`, `${model}-turn`);
    const result = await Promise.race([
      terminal,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`${model} subtask test timed out.`)),
        10_000
      ))
    ]);
    runtime.close();
    await runtime.done;
    return { events, result };
  }

  const background = await run("background");
  assert.equal(background.result.success, true);
  assert.equal(background.result.output, "PARENT_BACKGROUND_OK");
  assert.equal(
    background.events.filter((event) => event.type === "tool_result").length,
    2
  );
  assert(background.events.some(
    (event) => event.type === "status" && event.status === "subtask_start"
  ));
  assert(background.events.some(
    (event) => event.type === "status" && event.status === "subtask_progress"
  ));
  const worktree = childWorkspaces.find((item) => item.model === "background")?.path;
  assert(worktree && worktree !== workspace);
  assert.equal(
    execFileSync("git", ["-C", worktree, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8"
    }).trim(),
    "true"
  );

  const stopped = await run("stop");
  assert.equal(stopped.result.success, true);
  assert.equal(stopped.result.output, "PARENT_STOP_OK");
  assert.equal(
    stopped.events.filter((event) => event.type === "tool_result").length,
    2
  );
  for (const response of hangingResponses) response.destroy();

  process.stdout.write(`${JSON.stringify({
    ok: true,
    backgroundToolResults: 2,
    stopToolResults: 2,
    worktree,
    worktreeVerified: true,
    backgroundOutput: background.result.output,
    stopOutput: stopped.result.output
  })}\n`);
} finally {
  for (const response of hangingResponses) response.destroy();
  if (server) await new Promise((resolve) => server.close(resolve));
  rmSync(outputDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  rmSync(sessions, { recursive: true, force: true });
  rmSync(worktrees, { recursive: true, force: true });
}
