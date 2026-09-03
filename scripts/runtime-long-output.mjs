import WebSocket from "ws";

const verifyRecovery = process.env.LUMEN_VERIFY_OUTPUT_RECOVERY === "1";
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
if (process.env.LUMEN_CLEANUP_TEST === "1") {
  const removed = await evaluate(`(async () => {
    const tasks = await window.lumen.cowork.listTasks();
    const matches = [];
    for (const task of tasks) {
      const messages = await window.lumen.cowork.getMessages(task.id);
      const isTest = task.title === "LUMEN_LONG_OUTPUT_TEST" || messages.some((message) =>
        String(message.content || "").includes("LUMEN_RECOVERY_OK") ||
        String(message.content || "").includes("LUMEN_LONG_OUTPUT_START")
      );
      if (isTest) matches.push(task);
    }
    for (const task of matches) {
      await window.lumen.cowork.stop(task.id);
      await window.lumen.cowork.deleteTask(task.id);
    }
    return matches.map((task) => task.id);
  })()`);
  socket.close();
  process.stdout.write(`${JSON.stringify({ ok: true, removed })}\n`);
  process.exit(0);
}
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
      prompt: ${JSON.stringify(
        verifyRecovery
          ? "Do not inspect the workspace. Before using any tool, explain the implementation in at least 1000 English words so this turn deliberately reaches the configured test output limit. After the automatic continuation, use Bash to run exactly: printf 'LUMEN_RECOVERY_OK'. Finally confirm completion in one short sentence."
          : "Use Bash exactly once to run: printf 'LUMEN_LONG_OUTPUT_START'; printf 'x%.0s' {1..20000}; printf 'LUMEN_LONG_OUTPUT_END'. Then briefly confirm completion."
      )},
      cwd: ${JSON.stringify(process.cwd())},
      effort: ${JSON.stringify(verifyRecovery ? "low" : "high")},
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
  const bash = assistant?.toolCalls?.find(
    (tool) => tool.name === "Bash" && String(tool.output || "").includes("LUMEN_RECOVERY_OK")
  ) || assistant?.toolCalls?.find((tool) => tool.name === "Bash");
  const output = String(bash?.output || "");
  if (assistant?.status !== "done") {
    throw new Error(`Agent status is ${assistant?.status || "missing"}: ${JSON.stringify({
      content: assistant?.content,
      runtimeOutput: assistant?.runtimeOutput,
      activity: assistant?.activity,
      toolCalls: assistant?.toolCalls
    })}`);
  }
  if (bash?.status !== "completed") throw new Error(`Bash status is ${bash?.status || "missing"}.`);
  if (verifyRecovery) {
    if (!output.includes("LUMEN_RECOVERY_OK")) throw new Error(`Recovery tool did not run: ${output}`);
    if (!String(assistant.runtimeOutput || "").includes("automatically continuing unfinished work")) {
      throw new Error(`Output-limit recovery did not activate: ${assistant.runtimeOutput || ""}`);
    }
    if (/API Error:|output token maximum/i.test(assistant.content || "")) {
      throw new Error(`Output-limit error leaked into the answer: ${assistant.content}`);
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      model: "Gemma4-26B-A4B",
      recovered: true,
      status: assistant.status,
      tool: bash.name
    })}\n`);
  } else {
  const startVisible = output.includes("LUMEN_LONG_OUTPUT_START");
  const endVisible = output.includes("LUMEN_LONG_OUTPUT_END");
  if (!startVisible || !endVisible) {
    throw new Error(`Tool output boundary missing: ${JSON.stringify({
      length: output.length,
      startVisible,
      endVisible,
      head: output.slice(0, 120),
      tail: output.slice(-120)
    })}`);
  }
  if (output.length < 20_000) throw new Error(`Tool output is unexpectedly short: ${output.length}.`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    model: "Gemma4-26B-A4B",
    status: assistant.status,
    tool: bash.name,
    outputLength: output.length,
    startVisible,
    endVisible
  })}\n`);
  }
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
