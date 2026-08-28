import WebSocket from "ws";

const port = Number(process.env.LUMEN_CDP_PORT || "9223");
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
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

async function evaluate(expression, timeout = 90_000) {
  let timer;
  const result = await Promise.race([
    command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Model router test timed out.")), timeout);
    })
  ]).finally(() => clearTimeout(timer));
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

await command("Runtime.enable");
const original = await evaluate("window.lumen.settings.get()");
try {
  await evaluate(`window.lumen.settings.set({ model: "Qwen3-VL-8B" })`);
  const refreshed = await evaluate("window.lumen.models.refreshCatalog(true)");
  if (!refreshed.status?.online || !refreshed.status?.router) {
    throw new Error(`Router restart failed: ${JSON.stringify(refreshed.status)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const stable = await evaluate("window.lumen.models.status()");
  if (!stable.online || !stable.router || stable.url !== refreshed.status.url) {
    throw new Error(`Router did not remain stable: ${JSON.stringify(stable)}`);
  }
  const catalog = await fetch(`${stable.url.replace(/\/v1\/?$/, "")}/v1/models`)
    .then((response) => {
      if (!response.ok) throw new Error(`Router catalog returned HTTP ${response.status}.`);
      return response.json();
    });
  const ids = (catalog.data || []).map((item) => item.id).sort();
  const expected = ["Gemma4-26B-A4B", "Qwen3-VL-8B", "Qwen3.8-27B"].sort();
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected router catalog: ${JSON.stringify(ids)}`);
  }
  const vision = stable.localModels.find((item) => item.name === "Qwen3-VL-8B");
  if (!vision?.vision || !vision.mmproj) {
    throw new Error(`Vision projector was not detected: ${JSON.stringify(vision)}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    platform: process.platform,
    url: stable.url,
    models: ids,
    vision: vision.name,
    mmproj: vision.mmproj
  })}\n`);
} finally {
  await evaluate(`window.lumen.settings.set({ model: ${JSON.stringify(original.model)} })`)
    .catch(() => undefined);
  socket.close();
}
