import WebSocket from "ws";

const phase = process.argv[2];
const expectedTaskId = process.argv[3];
const originalModel = process.argv[4];
if (!["create", "verify", "cleanup"].includes(phase)) {
  throw new Error("Usage: node scripts/runtime-interruption.mjs <create|verify|cleanup> [task-id] [original-model]");
}

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
      timer = setTimeout(() => reject(new Error("Interruption test timed out.")), timeout);
    })
  ]).finally(() => clearTimeout(timer));
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

await command("Runtime.enable");
if (phase === "cleanup") {
  const deleted = await evaluate(`(async () => {
    const tasks = await window.lumen.cowork.listTasks();
    let count = 0;
    for (const task of tasks) {
      const messages = await window.lumen.cowork.getMessages(task.id);
      if (!messages.some((message) =>
        message.role === "user" &&
        message.content === "Use Bash to sleep for 60 seconds, then report completion."
      )) continue;
      await window.lumen.cowork.deleteTask(task.id);
      count += 1;
    }
    return count;
  })()`);
  process.stdout.write(`${JSON.stringify({ ok: true, deleted })}\n`);
} else if (phase === "create") {
  const result = await evaluate(`(async () => {
    const original = await window.lumen.settings.get();
    await window.lumen.settings.set({
      model: "Gemma4-26B-A4B",
      coworkPermissionMode: "full",
      coworkFullAccess: true
    });
    const task = await window.lumen.cowork.createTask({
      title: "LUMEN_INTERRUPTION_TEST",
      cwd: ${JSON.stringify(process.cwd())}
    });
    const started = await window.lumen.cowork.run({
      taskId: task.id,
      prompt: "Use Bash to sleep for 60 seconds, then report completion.",
      cwd: ${JSON.stringify(process.cwd())},
      effort: "high",
      model: "Gemma4-26B-A4B"
    });
    if (!started.ok) throw new Error(started.error || "Cowork failed to start.");
    const messages = await window.lumen.cowork.getMessages(task.id);
    return { taskId: task.id, originalModel: original.model, messages };
  })()`);
  const assistant = result.messages.findLast((message) => message.role === "assistant");
  if (assistant?.status !== "streaming") {
    throw new Error(`Seed task is not streaming: ${assistant?.status || "missing"}.`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    taskId: result.taskId,
    originalModel: result.originalModel,
    assistantStatus: assistant.status
  })}\n`);
} else {
  if (!expectedTaskId) throw new Error("verify requires the task id from create.");
  const result = await evaluate(`(async () => {
    const tasks = await window.lumen.cowork.listTasks();
    const task = tasks.find((item) => item.id === ${JSON.stringify(expectedTaskId)});
    return {
      task,
      messages: task ? await window.lumen.cowork.getMessages(task.id) : []
    };
  })()`);
  const assistant = result.messages.findLast((message) => message.role === "assistant");
  if (!result.task || assistant?.status !== "error") {
    throw new Error(`Interrupted task did not recover as an error: ${JSON.stringify(result)}`);
  }
  if (!String(assistant.runtimeOutput).includes("Lumen restarted before this run completed.")) {
    throw new Error("Interrupted task does not expose the restart reason.");
  }
  await evaluate(`window.lumen.cowork.deleteTask(${JSON.stringify(expectedTaskId)})`);
  if (originalModel) {
    await evaluate(`window.lumen.settings.set({ model: ${JSON.stringify(originalModel)} })`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    taskId: result.task.id,
    assistantStatus: assistant.status,
    runtimeOutput: assistant.runtimeOutput
  })}\n`);
}
socket.close();
