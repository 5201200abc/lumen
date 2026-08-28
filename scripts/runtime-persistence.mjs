import WebSocket from "ws";

const phase = process.argv[2];
const expectedTaskId = process.argv[3];
const originalModel = process.argv[4];
if (!["create", "verify"].includes(phase)) {
  throw new Error("Usage: node scripts/runtime-persistence.mjs <create|verify> [task-id]");
}

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

async function evaluate(expression, timeout = 150_000) {
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
if (phase === "create") {
  const result = await evaluate(`(async () => {
    const originalSettings = await window.lumen.settings.get();
    await window.lumen.settings.set({ model: "Gemma4-26B-A4B" });
    const task = await window.lumen.cowork.createTask({ cwd: ${JSON.stringify(process.cwd())} });
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        void window.lumen.cowork.stop(task.id);
        reject(new Error("Persistence create timed out."));
      }, 120000);
      const off = window.lumen.cowork.onEvent((event) => {
        if (event.taskId !== task.id) return;
        if (event.type === "done" || event.type === "error") {
          clearTimeout(timer);
          off();
          resolve(event);
        }
      });
    });
    const started = await window.lumen.cowork.run({
      taskId: task.id,
      prompt: "你会干什么",
      cwd: ${JSON.stringify(process.cwd())},
      effort: "none",
      model: "Gemma4-26B-A4B",
    });
    if (!started.ok) throw new Error(started.error || "Persistence task failed to start.");
    const done = await completed;
    const messages = await window.lumen.cowork.getMessages(task.id);
    return { taskId: task.id, done, messages, originalModel: originalSettings.model };
  })()`);
  if (!result.done?.content?.trim()) throw new Error(`Persistence seed returned no content: ${JSON.stringify(result)}`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    taskId: result.taskId,
    messages: result.messages.length,
    originalModel: result.originalModel
  })}\n`);
} else {
  if (!expectedTaskId) throw new Error("verify requires the task id from create.");
  const result = await evaluate(`(async () => {
    const tasks = await window.lumen.cowork.listTasks();
    const task = tasks.find((item) => item.id === ${JSON.stringify(expectedTaskId)});
    const messages = task ? await window.lumen.cowork.getMessages(task.id) : [];
    return { task, messages };
  })()`);
  const assistant = result.messages.find((message) => message.role === "assistant");
  if (!result.task || !assistant?.content?.trim() || assistant.status !== "done") {
    throw new Error(`Cowork task did not survive restart: ${JSON.stringify(result)}`);
  }
  await evaluate(`window.lumen.cowork.deleteTask(${JSON.stringify(expectedTaskId)})`);
  if (originalModel) {
    await evaluate(`window.lumen.settings.set({ model: ${JSON.stringify(originalModel)} })`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    taskId: result.task.id,
    title: result.task.title,
    messages: result.messages.length,
    assistantStatus: assistant.status
  })}\n`);
}
socket.terminate();
