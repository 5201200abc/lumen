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

async function evaluate(expression, timeout = 900_000) {
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
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-checkpoint-"));
const proofPath = path.join(tempDir, "checkpoint-proof.txt");
const originalSettings = await evaluate("window.lumen.settings.get()");
let taskId = "";

try {
  await evaluate("window.lumen.settings.set({ coworkPermissionMode: 'full', model: 'Gemma4-26B-A4B' })");
  const result = await evaluate(`(async () => {
    const task = await window.lumen.cowork.createTask({ cwd: ${JSON.stringify(tempDir)} });
    const runTurn = async (prompt) => {
      const events = [];
      const completed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          void window.lumen.cowork.stop(task.id);
          reject(new Error("Checkpoint turn timed out."));
        }, 600000);
        const off = window.lumen.cowork.onEvent((event) => {
          if (event.taskId !== task.id) return;
          events.push(event.type);
          if (event.type === "done" || event.type === "error") {
            clearTimeout(timer);
            off();
            resolve(event);
          }
        });
      });
      const started = await window.lumen.cowork.run({
        taskId: task.id,
        prompt,
        cwd: ${JSON.stringify(tempDir)},
        effort: "high",
        model: "Gemma4-26B-A4B"
      });
      if (!started.ok) throw new Error(started.error || "Checkpoint turn failed to start.");
      const done = await completed;
      return { started, done, events };
    };

    const first = await runTurn(
      "Use the Write tool to create checkpoint-proof.txt with exact content FIRST_CHECKPOINT. Do not use Bash. Then reply exactly WRITE_DONE."
    );
    const second = await runTurn(
      "Use the Read tool to read checkpoint-proof.txt. Then reply exactly SECOND_SEES_FIRST if its content is FIRST_CHECKPOINT."
    );
    let messages = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      messages = await window.lumen.cowork.getMessages(task.id);
      const firstAssistant = messages.find((message) => message.id === first.started.asstMsgId);
      if (firstAssistant?.rewindAvailable) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const firstAssistant = messages.find((message) => message.id === first.started.asstMsgId);
    if (!firstAssistant?.rewindAvailable) throw new Error("First turn checkpoint was not available.");
    const preview = await window.lumen.cowork.rewind(task.id, firstAssistant.id, true);
    if (!preview.canRewind) throw new Error(preview.error || "Checkpoint dry-run failed.");
    const restored = await window.lumen.cowork.rewind(task.id, firstAssistant.id, false);
    return { taskId: task.id, first, second, messages, preview, restored };
  })()`);
  taskId = result.taskId;
  if (!fs.existsSync(proofPath) && !result.restored?.canRewind) {
    throw new Error(`Write was not proven before rewind: ${JSON.stringify(result)}`);
  }
  if (fs.existsSync(proofPath)) {
    throw new Error(`Checkpoint rewind did not remove ${proofPath}`);
  }
  const secondAssistant = result.messages.find(
    (message) => message.id === result.second.started.asstMsgId
  );
  if (!secondAssistant?.content?.includes("SECOND_SEES_FIRST")) {
    throw new Error(`Second persistent turn did not observe first turn: ${JSON.stringify(secondAssistant)}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    model: "Gemma4-26B-A4B",
    secondTurn: secondAssistant.content,
    preview: result.preview,
    restored: result.restored,
    fileExistsAfterRewind: false
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
