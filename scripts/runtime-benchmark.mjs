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
      timer = setTimeout(() => reject(new Error("Benchmark test timed out.")), timeout);
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
  await evaluate(`window.lumen.settings.set({ model: "Gemma4-26B-A4B" })`);
  const result = await evaluate(`window.lumen.models.benchmark("Gemma4-26B-A4B")`);
  if (
    result.model !== "Gemma4-26B-A4B" ||
    !Number.isFinite(result.tokensPerSecond) ||
    result.tokensPerSecond <= 0 ||
    result.tokens <= 0 ||
    result.durationMs <= 0
  ) {
    throw new Error(`Invalid benchmark result: ${JSON.stringify(result)}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} finally {
  await evaluate(`window.lumen.settings.set({ model: ${JSON.stringify(original.model)} })`)
    .catch(() => undefined);
  socket.close();
}
