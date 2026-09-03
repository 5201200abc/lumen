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
async function evaluate(expression) {
  const result = await command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

await command("Runtime.enable");
if (process.env.LUMEN_CLEANUP_RUNTIME === "1") {
  const removed = await evaluate(`(async () => {
    const removedTasks = [];
    for (const task of await window.lumen.cowork.listTasks()) {
      const messages = await window.lumen.cowork.getMessages(task.id);
      if (messages.some((message) =>
        String(message.content || "").includes("Use the Lumen MCP tools in this exact order")
        || String(message.content || "").includes("Use browser_snapshot to inspect the current GitHub page.")
      )) {
        await window.lumen.cowork.stop(task.id);
        await window.lumen.cowork.deleteTask(task.id);
        removedTasks.push(task.id);
      }
    }
    const removedChats = [];
    for (const chat of await window.lumen.chats.list()) {
      const messages = await window.lumen.chats.messages(chat.id);
      if (messages.some((message) => String(message.content || "") === "只回复 GEMMA4_CHAT_OK")) {
        await window.lumen.chats.delete(chat.id);
        removedChats.push(chat.id);
      }
    }
    return { removedTasks, removedChats };
  })()`);
  socket.close();
  process.stdout.write(`${JSON.stringify({ ok: true, ...removed })}\n`);
  process.exit(0);
}
if (process.env.LUMEN_INSPECT_TASKS === "1") {
  const state = await evaluate(`(async () => {
    const tasks = await window.lumen.cowork.listTasks();
    const taskState = await Promise.all(tasks.slice(0, 5).map(async (task) => ({
      id: task.id,
      title: task.title,
      updatedAt: task.updatedAt,
      messages: (await window.lumen.cowork.getMessages(task.id)).slice(-2).map((message) => ({
        role: message.role,
        status: message.status,
        activity: message.activity,
        content: String(message.content || "").slice(-300),
        runtimeOutput: String(message.runtimeOutput || "").slice(-500),
        tools: (message.toolCalls || []).map((tool) => ({
          name: tool.name,
          status: tool.status,
          outputLength: String(tool.output || "").length,
          output: String(tool.output || "").slice(-300)
        }))
      }))
    })));
    const chats = await window.lumen.chats.list();
    const chatState = await Promise.all(chats.slice(0, 2).map(async (chat) => ({
      id: chat.id,
      title: chat.title,
      updatedAt: chat.updatedAt,
      messages: (await window.lumen.chats.messages(chat.id)).slice(-2).map((message) => ({
        role: message.role,
        phase: message.phase,
        content: String(message.content || "").slice(-300)
      }))
    })));
    const pane = document.querySelector(".mode-pane:not([hidden])");
    return {
      model: await window.lumen.models.status(),
      chrome: await window.lumen.tools.chromeStatus(),
      tasks: taskState,
      chats: chatState,
      ui: {
        activeTab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
        textarea: pane?.querySelector("textarea")?.value,
        sendDisabled: pane?.querySelector("button.send")?.disabled
      }
    };
  })()`);
  socket.close();
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  process.exit(0);
}
const original = await evaluate("window.lumen.settings.get()");
try {
  const result = await evaluate(`(async () => {
    await window.lumen.settings.set({
      coworkPermissionMode: "full",
      coworkFullAccess: true,
      computerUseChromeEnabled: true,
      browserControlMode: "isolated",
      plugins: { browser: true, sites: true, plugins: true }
    });
    const opened = await window.lumen.tools.chromeOpen("http://localhost:5173/");
    const snapshot = await window.lumen.tools.chromeSnapshot();
    const chrome = await window.lumen.tools.chromeStatus();
    const tools = await window.lumen.tools.status();
    return { opened, snapshot, chrome, tools };
  })()`);
  const browser = result.tools.capabilities.find((item) => item.id === "browser");
  const windowState = browser?.window;
  if (!result.chrome.installed || !result.chrome.running || !windowState?.visible) {
    throw new Error(`Google Chrome did not start through Lumen: ${JSON.stringify(result)}`);
  }
  if (result.snapshot?.title !== "Lumen" || result.snapshot?.url !== "http://localhost:5173/") {
    throw new Error(`Google Chrome snapshot did not read the Lumen page: ${JSON.stringify(result.snapshot)}`);
  }
  const { bounds, parentBounds } = windowState;
  if (!parentBounds) throw new Error(`Lumen parent bounds are missing: ${JSON.stringify(windowState)}`);
  const rightGap = parentBounds.x + parentBounds.width - (bounds.x + bounds.width);
  const bottomGap = parentBounds.y + parentBounds.height - (bounds.y + bounds.height);
  if (
    bounds.width >= parentBounds.width ||
    bounds.height >= parentBounds.height ||
    bounds.width > 440 ||
    bounds.height > 300 ||
    Math.abs(rightGap - 16) > 2 ||
    Math.abs(bottomGap - 16) > 2
  ) {
    throw new Error(`Google Chrome is not bottom-right docked: ${JSON.stringify(windowState)}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    browser: "Google Chrome",
    url: result.opened?.url,
    bounds,
    parentBounds,
    rightGap,
    bottomGap
  })}\n`);
} finally {
  await evaluate(`window.lumen.settings.set({
    coworkPermissionMode: ${JSON.stringify(original.coworkPermissionMode)},
    coworkFullAccess: ${JSON.stringify(original.coworkFullAccess)},
    computerUseChromeEnabled: ${JSON.stringify(original.computerUseChromeEnabled)},
    browserControlMode: ${JSON.stringify(original.browserControlMode || "auto")},
    plugins: ${JSON.stringify(original.plugins)}
  })`).catch(() => undefined);
  socket.close();
}
