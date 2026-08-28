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

async function evaluate(expression, timeout = 300_000) {
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
const original = await evaluate("window.lumen.settings.get()");
let conversationId = "";
let taskId = "";
try {
  await evaluate(`window.lumen.settings.set({
    model: "Gemma4-26B-A4B",
    systemPrompt: "You are Lumen. Every answer must include the exact marker MODEL_STYLE_OK.",
    chatInstructions: "Every Chat answer must include the exact marker CHAT_INSTRUCTION_OK.",
    coworkInstructions: "Every Cowork answer must include the exact marker COWORK_INSTRUCTION_OK."
  })`);
  const result = await evaluate(`(async () => {
    const conversation = await window.lumen.chats.create();
    const chatDone = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        offDone();
        offError();
        reject(new Error("Chat style test timed out."));
      }, 180000);
      const offDone = window.lumen.chat.onDone((event) => {
        if (event.conversationId !== conversation.id) return;
        clearTimeout(timer);
        offDone();
        offError();
        resolve(event);
      });
      const offError = window.lumen.chat.onError((event) => {
        if (event.conversationId !== conversation.id) return;
        clearTimeout(timer);
        offDone();
        offError();
        reject(new Error(event.error));
      });
    });
    await window.lumen.chat.send({
      conversationId: conversation.id,
      content: "Acknowledge these instructions in one short line.",
      attachments: [],
      effort: "none",
      webSearch: false
    });
    const chat = await chatDone;

    const task = await window.lumen.cowork.createTask({ cwd: ${JSON.stringify(process.cwd())} });
    const coworkDone = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        void window.lumen.cowork.stop(task.id);
        reject(new Error("Cowork style test timed out."));
      }, 180000);
      const off = window.lumen.cowork.onEvent((event) => {
        if (event.taskId !== task.id) return;
        if (event.type === "done") {
          clearTimeout(timer);
          off();
          resolve(event);
        } else if (event.type === "error") {
          clearTimeout(timer);
          off();
          reject(new Error(event.error || "Cowork style test failed."));
        }
      });
    });
    const started = await window.lumen.cowork.run({
      taskId: task.id,
      prompt: "你是谁",
      cwd: ${JSON.stringify(process.cwd())},
      effort: "none",
      model: "Gemma4-26B-A4B"
    });
    if (!started.ok) throw new Error(started.error || "Cowork style test failed to start.");
    const cowork = await coworkDone;
    return { conversationId: conversation.id, taskId: task.id, chat, cowork };
  })()`);
  conversationId = result.conversationId;
  taskId = result.taskId;
  for (const marker of ["MODEL_STYLE_OK", "CHAT_INSTRUCTION_OK"]) {
    if (!result.chat.content.includes(marker)) {
      throw new Error(`Chat did not apply ${marker}: ${result.chat.content}`);
    }
  }
  for (const marker of ["MODEL_STYLE_OK", "COWORK_INSTRUCTION_OK"]) {
    if (!result.cowork.content.includes(marker)) {
      throw new Error(`Cowork did not apply ${marker}: ${result.cowork.content}`);
    }
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    model: "Gemma4-26B-A4B",
    chat: result.chat.content,
    cowork: result.cowork.content
  })}\n`);
} finally {
  if (conversationId) await evaluate(`window.lumen.chats.delete(${JSON.stringify(conversationId)})`).catch(() => {});
  if (taskId) await evaluate(`window.lumen.cowork.deleteTask(${JSON.stringify(taskId)})`).catch(() => {});
  await evaluate(`window.lumen.settings.set({
    model: ${JSON.stringify(original.model)},
    systemPrompt: ${JSON.stringify(original.systemPrompt)},
    chatInstructions: ${JSON.stringify(original.chatInstructions)},
    coworkInstructions: ${JSON.stringify(original.coworkInstructions)}
  })`).catch(() => {});
  socket.terminate();
}
