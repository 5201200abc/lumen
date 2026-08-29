import WebSocket from "ws";

const cdpPort = Number(process.env.LUMEN_CDP_PORT || "9223");
const runtimeModel = process.env.LUMEN_RUNTIME_MODEL || "Gemma4-26B-A4B";
const verifyAutoCompact = process.env.LUMEN_VERIFY_AUTO_COMPACT === "1";
const targetList = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) => response.json());
const target = targetList.find((item) => item.type === "page" && item.title === "Lumen");
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

async function evaluate(expression, timeout = 600_000) {
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

async function waitForRenderer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await evaluate("Boolean(window.lumen && document.querySelector('.app'))", 10_000).catch(() => false);
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Lumen renderer did not become ready.");
}

await command("Runtime.enable");
await waitForRenderer();

const originalSettings = await evaluate("window.lumen.settings.get()");
const baselineIds = await evaluate("window.lumen.chats.list().then(items => items.map(item => item.id))");
const createdIds = [];
let coworkTaskId = "";

try {
  await evaluate(`window.lumen.settings.set({
    model: ${JSON.stringify(runtimeModel)},
    coworkPermissionMode: "full",
    coworkFullAccess: true,
    plugins: { browser: true, sites: true, plugins: true }
  })`);

  const newChat = await evaluate(`(async () => {
    const chatTab = [...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent?.trim() === "Chat");
    chatTab?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = await window.lumen.chats.list();
    const button = document.querySelector(".new-chat-btn") ||
      [...document.querySelectorAll("button")].find((node) => /New chat|新建会话/.test(node.getAttribute("aria-label") || ""));
    if (!button) throw new Error("New chat button not found.");
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const after = await window.lumen.chats.list();
    return {
      before: before.length,
      after: after.length,
      clean: Boolean(document.querySelector(".mode-pane:not([hidden]) .empty"))
    };
  })()`);

  if (newChat.before !== newChat.after || !newChat.clean) {
    throw new Error(`New chat regression: ${JSON.stringify(newChat)}`);
  }

  const newCowork = await evaluate(`(async () => {
    const coworkTab = [...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent?.trim() === "Cowork");
    coworkTab?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = await window.lumen.cowork.listTasks();
    const button = document.querySelector(".new-chat-btn") ||
      [...document.querySelectorAll("button")].find((node) => /New chat|新建会话/.test(node.getAttribute("aria-label") || ""));
    if (!button) throw new Error("Cowork new chat button not found.");
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const after = await window.lumen.cowork.listTasks();
    const clean = Boolean(document.querySelector(".mode-pane:not([hidden]) .empty"));
    const chatTab = [...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent?.trim() === "Chat");
    chatTab?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { before: before.length, after: after.length, clean };
  })()`);
  if (newCowork.before !== newCowork.after || !newCowork.clean) {
    throw new Error(`Cowork new chat regression: ${JSON.stringify(newCowork)}`);
  }

  const chat = await evaluate(`(async () => {
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error("Gemma4 Chat response timed out."));
      }, 360000);
      const off = window.lumen.chat.onDone((event) => {
        clearTimeout(timer);
        off();
        resolve(event);
      });
    });
    const pane = document.querySelector(".mode-pane:not([hidden])");
    const textarea = pane?.querySelector("textarea");
    const send = pane?.querySelector("button.send");
    if (!textarea || !send) throw new Error("Chat composer not found.");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(
      textarea,
      "只回复 GEMMA4_CHAT_OK"
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    send.click();
    const result = await done;
    const chats = await window.lumen.chats.list();
    return { result, chatIds: chats.map((item) => item.id) };
  })()`, 390_000);

  for (const id of chat.chatIds) {
    if (!baselineIds.includes(id)) createdIds.push(id);
  }
  if (!chat.result?.content?.trim()) throw new Error("Gemma4 Chat returned no content.");
  if (createdIds.length !== 1) {
    throw new Error(`First send should create exactly one conversation; created ${createdIds.length}.`);
  }

  const cowork = await evaluate(`(async () => {
    const task = await window.lumen.cowork.createTask({
      cwd: ${JSON.stringify(process.cwd())}
    });
    const events = [];
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        void window.lumen.cowork.stop(task.id);
        reject(new Error(${JSON.stringify(`${runtimeModel} Cowork response timed out.`)}));
      }, 600000);
      const off = window.lumen.cowork.onEvent((event) => {
        if (event.taskId !== task.id) return;
        events.push(event);
        if (event.type === "done" || event.type === "error") {
          clearTimeout(timer);
          off();
          resolve(event);
        }
      });
    });
    const started = await window.lumen.cowork.run({
      taskId: task.id,
      prompt: "Use the Lumen MCP tools in this exact order: (1) plugins_list once with details false, (2) sites_preview with directory exactly scripts/fixtures/tool-site, (3) browser_snapshot. Then report the installed plugin count and the preview page title in one short sentence.",
      cwd: ${JSON.stringify(process.cwd())},
      effort: "high",
      model: ${JSON.stringify(runtimeModel)}
    });
    if (!started.ok) throw new Error(started.error || "Cowork failed to start.");
    const done = await completed;
    let messages = await window.lumen.cowork.getMessages(task.id);
    const toolCalls = messages.flatMap((message) => message.toolCalls || []);
    const assistant = messages.filter((message) => message.role === "assistant").at(-1);
    if (${JSON.stringify(verifyAutoCompact)}) {
      const followupDone = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error("Automatic context compaction follow-up timed out."));
        }, 180000);
        const off = window.lumen.cowork.onEvent((event) => {
          if (event.taskId !== task.id) return;
          if (event.type !== "done" && event.type !== "error") return;
          clearTimeout(timer);
          off();
          resolve(event);
        });
      });
      const followup = await window.lumen.cowork.run({
        taskId: task.id,
        prompt: "Continue from the compacted context and reply only AUTO_COMPACT_OK.",
        cwd: ${JSON.stringify(process.cwd())},
        effort: "none",
        model: ${JSON.stringify(runtimeModel)}
      });
      if (!followup.ok) throw new Error(followup.error || "Automatic context compaction follow-up failed.");
      await followupDone;
      messages = await window.lumen.cowork.getMessages(task.id);
    }
    return {
      taskId: task.id,
      done,
      toolCalls,
      messages,
      contextUsed: assistant?.contextUsed || 0,
      thinkingLength: assistant?.thinking?.length || 0,
      autoCompacted: messages.some((message) => message.activity === "Context automatically compacted")
    };
  })()`, 630_000);
  coworkTaskId = cowork.taskId;
  const pluginCall = cowork.toolCalls.find((tool) => tool.name.includes("plugins_list"));
  const sitesCall = cowork.toolCalls.find((tool) => tool.name.includes("sites_preview"));
  const snapshotCall = cowork.toolCalls.find((tool) => tool.name.includes("browser_snapshot"));
  if ([pluginCall, sitesCall, snapshotCall].some((tool) => !tool || tool.status !== "completed")) {
    throw new Error(`Gemma4 Cowork did not complete plugins_list: ${JSON.stringify({
      done: cowork.done,
      toolCalls: cowork.toolCalls,
      messages: cowork.messages
    })}`);
  }
  if (verifyAutoCompact && !cowork.autoCompacted) {
    throw new Error(`Automatic context compaction did not run: ${JSON.stringify(cowork.messages)}`);
  }
  if (!String(sitesCall.output).includes("scripts/fixtures/tool-site") ||
      !String(snapshotCall.output).includes("LUMEN_SITE_OK") ||
      !String(snapshotCall.output).includes("Lumen Tool Host Fixture")) {
    throw new Error(`Sites/Browser did not render the verification fixture: ${JSON.stringify({
      sites: sitesCall.output,
      snapshot: snapshotCall.output
    })}`);
  }

  const tools = await evaluate("window.lumen.tools.status()");
  if (!tools.online || tools.capabilities.some((item) => !item.available)) {
    throw new Error(`Tool Host capability status is invalid: ${JSON.stringify(tools)}`);
  }
  const browserWindow = tools.capabilities.find((item) => item.id === "browser")?.window;
  if (!browserWindow?.visible || !browserWindow.parentBounds) {
    throw new Error(`Lumen browser window is not docked: ${JSON.stringify(browserWindow)}`);
  }
  const bounds = browserWindow.bounds;
  const parentBounds = browserWindow.parentBounds;
  const rightGap = parentBounds.x + parentBounds.width - (bounds.x + bounds.width);
  const bottomGap = parentBounds.y + parentBounds.height - (bounds.y + bounds.height);
  if (
    bounds.width >= parentBounds.width ||
    bounds.height >= parentBounds.height ||
    Math.abs(rightGap - 16) > 2 ||
    Math.abs(bottomGap - 16) > 2
  ) {
    throw new Error(`Lumen browser bounds are not bottom-right docked: ${JSON.stringify(browserWindow)}`);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    newChat,
    newCowork,
    chat: {
      model: runtimeModel,
      content: chat.result.content,
      createdConversations: createdIds.length
    },
    cowork: {
      model: runtimeModel,
      engine: "claude-agent",
      contextUsed: cowork.contextUsed,
      thinkingLength: cowork.thinkingLength,
      autoCompacted: cowork.autoCompacted,
      tools: [pluginCall, sitesCall, snapshotCall].map((tool) => ({
        name: tool.name,
        status: tool.status,
        output: tool.output
      }))
    },
    tools
  }, null, 2)}\n`);
} finally {
  for (const id of createdIds) {
    await evaluate(`window.lumen.chats.delete(${JSON.stringify(id)})`).catch(() => undefined);
  }
  if (coworkTaskId) {
    await evaluate(`window.lumen.cowork.deleteTask(${JSON.stringify(coworkTaskId)})`).catch(() => undefined);
  }
  await evaluate(`window.lumen.settings.set({
    model: ${JSON.stringify(originalSettings.model)},
    coworkPermissionMode: ${JSON.stringify(originalSettings.coworkPermissionMode)},
    coworkFullAccess: ${JSON.stringify(originalSettings.coworkFullAccess)},
    plugins: ${JSON.stringify(originalSettings.plugins)}
  })`).catch(() => undefined);
  socket.close();
}
