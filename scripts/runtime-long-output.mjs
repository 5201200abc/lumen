import WebSocket from "ws";

const targets = await fetch(`http://127.0.0.1:${Number(process.env.LUMEN_CDP_PORT || "9223")}/json/list`)
  .then((response) => response.json());
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
async function evaluate(expression, timeout = 630_000) {
  let timer;
  const result = await Promise.race([
    command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Long-output test timed out.")), timeout);
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
      title: "LUMEN_LONG_OUTPUT_TEST",
      cwd: ${JSON.stringify(process.cwd())}
    });
    const terminal = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        void window.lumen.cowork.stop(task.id);
        reject(new Error("Long-output task did not terminate."));
      }, 600000);
      const off = window.lumen.cowork.onEvent((event) => {
        if (event.taskId !== task.id || event.type !== "done") return;
        clearTimeout(timer);
        off();
        resolve(event);
      });
    });
    const started = await window.lumen.cowork.run({
      taskId: task.id,
      prompt: "Use Bash exactly once to run: printf 'LUMEN_LONG_OUTPUT_START'; printf 'x%.0s' {1..20000}; printf 'LUMEN_LONG_OUTPUT_END'. Then briefly confirm completion.",
      cwd: ${JSON.stringify(process.cwd())},
      effort: "high",
      model: "Gemma4-26B-A4B"
    });
    if (!started.ok) throw new Error(started.error || "Cowork failed to start.");
    await terminal;
    return {
      taskId: task.id,
      messages: await window.lumen.cowork.getMessages(task.id)
    };
  })()`);
  taskId = result.taskId;
  const assistant = result.messages.findLast((message) => message.role === "assistant");
  const bash = assistant?.toolCalls?.find((tool) => tool.name === "Bash");
  const output = String(bash?.output || "");
  if (assistant?.status !== "done") throw new Error(`Agent status is ${assistant?.status || "missing"}.`);
  if (bash?.status !== "completed") throw new Error(`Bash status is ${bash?.status || "missing"}.`);
  if (!output.includes("LUMEN_LONG_OUTPUT_START") || !output.includes("LUMEN_LONG_OUTPUT_END")) {
    throw new Error(`Tool output was truncated; received ${output.length} characters.`);
  }
  if (output.length < 20_000) throw new Error(`Tool output is unexpectedly short: ${output.length}.`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    model: "Gemma4-26B-A4B",
    status: assistant.status,
    tool: bash.name,
    outputLength: output.length,
    startVisible: true,
    endVisible: true
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
