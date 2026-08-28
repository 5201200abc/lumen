import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const cdpPort = Number(process.env.LUMEN_CDP_PORT || "9223");
const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) => response.json());
const target = targets.find((item) => item.type === "page" && item.title === "Lumen");
if (!target?.webSocketDebuggerUrl) throw new Error("Lumen renderer CDP target not found.");

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});

function command(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression, timeout = 660_000) {
  let timer;
  const result = await Promise.race([
    command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("CDP evaluation timed out.")), timeout);
    })
  ]).finally(() => clearTimeout(timer));
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

await command("Runtime.enable");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-permission-"));
const proofPath = path.join(tempDir, "approval-proof.txt");
const originalSettings = await evaluate("window.lumen.settings.get()");
let taskId = "";

try {
  await evaluate(`(async () => {
    const stale = (await window.lumen.cowork.listTasks())
      .filter((task) => task.cwd.includes("lumen-permission-"));
    for (const task of stale) await window.lumen.cowork.deleteTask(task.id);
  })()`);
  await evaluate("window.lumen.settings.set({ coworkPermissionMode: 'ask', model: 'Gemma4-26B-A4B' })");
  const result = await evaluate(`(async () => {
    const task = await window.lumen.cowork.createTask({
      cwd: ${JSON.stringify(tempDir)},
    });
    const events = [];
    let approval = null;
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        void window.lumen.cowork.stop(task.id);
        reject(new Error("Permission test timed out."));
      }, 600000);
      const off = window.lumen.cowork.onEvent((event) => {
        if (event.taskId !== task.id) return;
        events.push({
          type: event.type,
          activity: event.activity,
          approval: event.approval
            ? { id: event.approval.id, toolName: event.approval.toolName, status: event.approval.status }
            : null
        });
        if (event.type === "permission_request" && event.approval?.status === "pending") {
          approval = event.approval;
          void window.lumen.cowork.resolveApproval(event.approval.id, "deny");
        }
        if (event.type === "done" || event.type === "error") {
          clearTimeout(timer);
          off();
          resolve(event);
        }
      });
    });
    const started = await window.lumen.cowork.run({
      taskId: task.id,
      prompt: "Use the Write tool to create approval-proof.txt in the current workspace with exact content SHOULD_NOT_EXIST. Do not use Bash. You must attempt the Write tool once.",
      cwd: ${JSON.stringify(tempDir)},
      effort: "high",
      model: "Gemma4-26B-A4B",
    });
    if (!started.ok) throw new Error(started.error || "Permission test failed to start.");
    const done = await completed;
    const messages = await window.lumen.cowork.getMessages(task.id);
    return {
      taskId: task.id,
      approval: approval ? { id: approval.id, toolName: approval.toolName, status: approval.status } : null,
      done,
      events,
      messages
    };
  })()`);
  taskId = result.taskId;
  if (!result.approval) throw new Error(`No permission request was emitted: ${JSON.stringify(result)}`);
  if (!["Write", "Edit"].includes(result.approval.toolName)) {
    throw new Error(`Unexpected approval tool: ${JSON.stringify(result.approval)}`);
  }
  if (fs.existsSync(proofPath)) {
    throw new Error(`Denied write created a file: ${proofPath}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    approval: result.approval,
    exitCode: result.done?.exitCode,
    fileCreated: false,
    eventTypes: result.events.map((event) => event.type)
  })}\n`);
} finally {
  if (taskId) await evaluate(`window.lumen.cowork.deleteTask(${JSON.stringify(taskId)})`).catch(() => {});
  await evaluate(`window.lumen.settings.set({
    coworkPermissionMode: ${JSON.stringify(originalSettings.coworkPermissionMode)},
    model: ${JSON.stringify(originalSettings.model)}
  })`).catch(() => {});
  socket.terminate();
  if (tempDir.startsWith(`${os.tmpdir()}${path.sep}`)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
