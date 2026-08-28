import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

async function evaluate(expression, timeout = 60_000) {
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
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-model-sync-"));
const names = [
  "A-Gemma4",
  "B-Qwen3.8",
  "C-Plain",
  "D-Plain",
  "E-Plain",
  "F-Overflow"
];
for (const name of names) {
  const directory = path.join(tempDir, name);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, `${name}.gguf`), "");
}
const original = await evaluate("window.lumen.settings.get()");

try {
  await evaluate(`window.lumen.settings.set({ modelsDir: ${JSON.stringify(tempDir)} })`);
  const first = await evaluate("window.lumen.models.refreshCatalog(false)");
  if (first.settings.llamaModels.length !== 5) {
    throw new Error(`Expected five-model cap: ${JSON.stringify(first.settings.llamaModels)}`);
  }
  const removedName = first.settings.llamaModels[1].name;
  fs.rmSync(path.join(tempDir, removedName), { recursive: true, force: true });
  const second = await evaluate("window.lumen.models.refreshCatalog(false)");
  if (second.settings.llamaModels.some((model) => model.name === removedName)) {
    throw new Error(`Removed model remained in catalog: ${removedName}`);
  }
  if (second.settings.modelCatalog.includes(removedName)) {
    throw new Error(`Removed model remained in modelCatalog: ${removedName}`);
  }
  const qwen = first.settings.llamaModels.find((model) => model.name.includes("Qwen3.8"));
  const gemma = first.settings.llamaModels.find((model) => model.name.includes("Gemma4"));
  if (
    qwen?.reasoningControl !== "effort" ||
    JSON.stringify(qwen.reasoningEfforts) !== JSON.stringify(["low", "medium", "xhigh"])
  ) {
    throw new Error(`Qwen3.8 reasoning mismatch: ${JSON.stringify(qwen)}`);
  }
  if (gemma?.reasoningControl !== "toggle" || gemma.reasoningEfforts !== undefined) {
    throw new Error(`Gemma4 reasoning mismatch: ${JSON.stringify(gemma)}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    firstCount: first.settings.llamaModels.length,
    removedName,
    secondNames: second.settings.llamaModels.map((model) => model.name),
    qwen: { control: qwen.reasoningControl, efforts: qwen.reasoningEfforts },
    gemma: { control: gemma.reasoningControl }
  })}\n`);
} finally {
  await evaluate(`window.lumen.settings.set({
    modelsDir: ${JSON.stringify(original.modelsDir)},
    llamaModels: ${JSON.stringify(original.llamaModels)},
    modelCatalog: ${JSON.stringify(original.modelCatalog)},
    model: ${JSON.stringify(original.model)}
  })`).catch(() => {});
  socket.terminate();
  if (tempDir.startsWith(`${os.tmpdir()}${path.sep}`)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
