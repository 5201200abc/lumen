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

async function evaluate(expression, timeout = 120_000) {
  let timer;
  const result = await Promise.race([
    command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Cancel test timed out.")), timeout);
    })
  ]).finally(() => clearTimeout(timer));
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

await command("Runtime.enable");
const original = await evaluate("window.lumen.settings.get()");
let taskId = "";
try {
  await evaluate(`window.lumen.settings.set({
    model: "Gemma4-26B-A4B",
    coworkPermissionMode: "full",
    coworkFullAccess: true
  })`);
  const result = await evaluate(`(async () => {
    const task = await window.lumen.cowork.createTask({
      title: "LUMEN_CANCEL_TEST",
      cwd: ${JSON.stringify(process.cwd())}
    });
    const terminal = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error("Cancelled task did not terminate."));
      }, 30000);
      const off = window.lumen.cowork.onEvent((event) => {
        if (event.taskId !== task.id || event.type !== "done") return;
        clearTimeout(timer);
        off();
        resolve(event);
      });
    });
    const started = await window.lumen.cowork.run({
      taskId: task.id,
      prompt: "Use the Bash tool to sleep for 60 seconds, then report completion.",
      cwd: ${JSON.stringify(process.cwd())},
      effort: "high",
      model: "Gemma4-26B-A4B"
    });
    if (!started.ok) throw new Error(started.error || "Cowork failed to start.");
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const stopped = await window.lumen.cowork.stop(task.id);
    const event = await terminal;
    const messages = await window.lumen.cowork.getMessages(task.id);
    return { taskId: task.id, stopped, elapsedMs: Date.now() - startedAt, event, messages };
  })()`);
  taskId = result.taskId;
  const assistant = result.messages.findLast((message) => message.role === "assistant");
  if (!result.stopped) throw new Error("cowork.stop returned false.");
  if (result.elapsedMs > 30000) throw new Error(`Cancellation took ${result.elapsedMs}ms.`);
  if (assistant?.status !== "error") {
    throw new Error(`Cancelled message status is ${assistant?.status || "missing"}.`);
  }
  if (!String(assistant.runtimeOutput).includes("Stopped by user.")) {
    throw new Error("Cancelled message does not expose the stop reason.");
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    model: "Gemma4-26B-A4B",
    stopped: result.stopped,
    elapsedMs: result.elapsedMs,
    status: assistant.status,
    runtimeOutput: assistant.runtimeOutput
  })}\n`);
} finally {
  if (taskId) {
    await evaluate(`window.lumen.cowork.deleteTask(${JSON.stringify(taskId)})`).catch(() => undefined);
  }
  await evaluate(`window.lumen.settings.set({
    model: ${JSON.stringify(original.model)},
    coworkPermissionMode: ${JSON.stringify(original.coworkPermissionMode)},
    coworkFullAccess: ${JSON.stringify(original.coworkFullAccess)}
  })`).catch(() => undefined);
  socket.close();
}
