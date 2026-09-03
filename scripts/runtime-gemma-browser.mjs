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
      timer = setTimeout(() => reject(new Error("Gemma4 browser click timed out.")), timeout);
    })
  ]).finally(() => clearTimeout(timer));
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

await command("Runtime.enable");
const originalSettings = await evaluate("window.lumen.settings.get()");
let taskId = "";

try {
  await evaluate(`window.lumen.settings.set({
    model: "Gemma4-26B-A4B",
    coworkPermissionMode: "full",
    coworkFullAccess: true,
    computerUseChromeEnabled: true,
    browserControlMode: "extension",
    plugins: { ...${JSON.stringify(originalSettings.plugins)}, browser: true }
  })`);
  const result = await evaluate(`(async () => {
    const task = await window.lumen.cowork.createTask({ cwd: ${JSON.stringify(process.cwd())} });
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        void window.lumen.cowork.stop(task.id);
        reject(new Error("Gemma4 did not finish the browser click task."));
      }, 600000);
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
      prompt: "Use browser_snapshot to inspect the current GitHub page. Find the visible Dashboard control in the page header, use browser_click once on its current ref, then use browser_snapshot again to verify the page remains on GitHub. Do not use Bash, Read, Search, browser_open, or any other tool. Report only whether the click succeeded.",
      cwd: ${JSON.stringify(process.cwd())},
      effort: "low",
      model: "Gemma4-26B-A4B"
    });
    if (!started.ok) throw new Error(started.error || "Gemma4 browser click task failed to start.");
    const done = await completed;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const messages = await window.lumen.cowork.getMessages(task.id);
    return {
      taskId: task.id,
      done,
      chrome: await window.lumen.tools.chromeStatus(),
      toolCalls: messages.flatMap((message) => message.toolCalls || []),
      assistant: messages.filter((message) => message.role === "assistant").at(-1)?.content || ""
    };
  })()`);
  taskId = result.taskId;
  const snapshots = result.toolCalls.filter((tool) => tool.name.includes("browser_snapshot"));
  const click = result.toolCalls.find((tool) => tool.name.includes("browser_click"));
  if (snapshots.length < 2 || !click || click.status !== "completed") {
    throw new Error(`Gemma4 browser click sequence incomplete: ${JSON.stringify({
      done: result.done?.type,
      tools: result.toolCalls.map((tool) => ({ name: tool.name, status: tool.status }))
    })}`);
  }
  if (result.chrome?.controller !== null || result.chrome?.window?.visible) {
    throw new Error(`Chrome control was not released after Gemma4 completed: ${JSON.stringify(result.chrome)}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    model: "Gemma4-26B-A4B",
    snapshots: snapshots.length,
    click: { name: click.name, status: click.status, input: click.input, output: click.output },
    assistant: result.assistant
  })}\n`);
} finally {
  if (taskId) await evaluate(`window.lumen.cowork.deleteTask(${JSON.stringify(taskId)})`).catch(() => undefined);
  await evaluate(`window.lumen.settings.set(${JSON.stringify(originalSettings)})`).catch(() => undefined);
  socket.close();
}
