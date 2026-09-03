import fs from "node:fs";
import WebSocket from "ws";

const cdpPort = Number(process.env.LUMEN_CDP_PORT || "9223");
const model = process.env.LUMEN_RUNTIME_MODEL || "Gemma4-26B-A4B";
const title = "LUMEN_COWORK_AGENT_TEST";
const screenshotPath = "/tmp/lumen-cowork-agent-proof.png";
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
      timer = setTimeout(() => reject(new Error("Cowork agent test timed out.")), timeout);
    })
  ]).finally(() => clearTimeout(timer));
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

await command("Runtime.enable");
await command("Page.enable");
const original = await evaluate("window.lumen.settings.get()");
let taskId = "";
try {
  const result = await evaluate(`(async () => {
    const waitForResult = (taskId) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        void window.lumen.cowork.stop(taskId);
        reject(new Error("Cowork agent result timed out."));
      }, 600000);
      const off = window.lumen.cowork.onEvent((event) => {
        if (event.taskId !== taskId || (event.type !== "done" && event.type !== "error")) return;
        clearTimeout(timer);
        off();
        resolve(event);
      });
    });
    const staleTasks = await window.lumen.cowork.listTasks();
    for (const stale of staleTasks) {
      if (stale.title === ${JSON.stringify(title)}) await window.lumen.cowork.deleteTask(stale.id);
    }
    await window.lumen.settings.set({
      model: ${JSON.stringify(model)},
      coworkEngine: "native",
      coworkPermissionMode: "full",
      coworkFullAccess: true
    });
    const task = await window.lumen.cowork.createTask({
      title: ${JSON.stringify(title)},
      cwd: ${JSON.stringify(process.cwd())}
    });
    const firstDone = waitForResult(task.id);
    const firstStart = await window.lumen.cowork.run({
      taskId: task.id,
      prompt: "Use Bash exactly once to run printf LUMEN_COWORK_AGENT_OK. Then reply only LUMEN_COWORK_AGENT_OK.",
      cwd: ${JSON.stringify(process.cwd())},
      effort: "low",
      model: ${JSON.stringify(model)}
    });
    if (!firstStart.ok) throw new Error(firstStart.error || "Cowork agent failed to start.");
    await firstDone;
    const firstMessages = await window.lumen.cowork.getMessages(task.id);
    const firstAssistant = firstMessages.filter((message) => message.role === "assistant").at(-1);
    if (!firstAssistant || firstAssistant.status !== "done") {
      throw new Error("Initial Cowork agent run did not complete.");
    }
    const regenerateDone = waitForResult(task.id);
    const regenerated = await window.lumen.cowork.regenerate({
      taskId: task.id,
      messageId: firstAssistant.id,
      cwd: ${JSON.stringify(process.cwd())},
      effort: "low",
      model: ${JSON.stringify(model)}
    });
    if (!regenerated.ok) throw new Error(regenerated.error || "Cowork regeneration failed to start.");
    await regenerateDone;
    const messages = await window.lumen.cowork.getMessages(task.id);
    const assistants = messages.filter((message) => message.role === "assistant");
    const users = messages.filter((message) => message.role === "user");
    const assistant = assistants.at(-1);
    return {
      taskId: task.id,
      users: users.length,
      assistants: assistants.length,
      replaced: assistant?.id !== firstAssistant.id,
      status: assistant?.status,
      content: assistant?.content,
      runtimeOutput: assistant?.runtimeOutput || "",
      tools: (assistant?.toolCalls || []).map((tool) => ({ name: tool.name, status: tool.status })),
      traceKinds: (assistant?.trace || []).map((entry) => entry.kind)
    };
  })()`);
  taskId = result.taskId;

  await command("Page.reload", { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const ui = await evaluate(`(async () => {
    for (let attempt = 0; attempt < 80 && (!window.lumen || !document.querySelector(".app")); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const coworkTab = [...document.querySelectorAll('[role="tab"]')]
      .find((node) => node.textContent?.trim() === "Cowork");
    coworkTab?.click();
    for (let attempt = 0; attempt < 40 && coworkTab?.getAttribute("aria-selected") !== "true"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    document.querySelector('[data-task-id="${taskId}"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const pane = document.querySelector('.mode-pane:not([hidden])');
    const actions = [...(pane?.querySelectorAll(".assistant-turn .turn-actions button") || [])];
    const labels = actions.map((button) => button.getAttribute("aria-label"));
    const copyIndex = labels.findIndex((label) => label === "Copy" || label === "复制");
    const regenerateIndex = labels.findIndex((label) => label === "Regenerate" || label === "重新生成");
    return {
      coworkSelected: coworkTab?.getAttribute("aria-selected") === "true",
      toolIcons: pane?.querySelectorAll(".assistant-turn .tool-badge-icon svg").length || 0,
      workedCollapsed: Boolean(pane?.querySelector("details.cowork-worked-summary:not([open])")),
      labels,
      regenerateAfterCopy: copyIndex >= 0 && regenerateIndex === copyIndex + 1
    };
  })()`);
  const capture = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(screenshotPath, Buffer.from(capture.data, "base64"));

  const ok =
    result.users === 1 &&
    result.assistants === 1 &&
    result.replaced &&
    result.status === "done" &&
    !/checkpoint unavailable/i.test(result.runtimeOutput) &&
    result.tools.some((tool) => tool.name === "Bash" && tool.status === "completed") &&
    result.traceKinds.includes("tool") &&
    ui.coworkSelected &&
    ui.toolIcons > 0 &&
    ui.workedCollapsed &&
    ui.regenerateAfterCopy;
  process.stdout.write(`${JSON.stringify({ ok, ...result, ui, screenshotPath })}\n`);
  if (!ok) process.exitCode = 1;
} finally {
  await evaluate(`window.lumen.settings.set({
    model: ${JSON.stringify(original.model)},
    coworkPermissionMode: ${JSON.stringify(original.coworkPermissionMode)},
    coworkFullAccess: ${JSON.stringify(original.coworkFullAccess)}
  })`).catch(() => undefined);
  if (taskId && process.env.LUMEN_KEEP_TEST_TASK !== "1") {
    await evaluate(`window.lumen.cowork.deleteTask(${JSON.stringify(taskId)})`).catch(() => undefined);
  }
  socket.close();
}
