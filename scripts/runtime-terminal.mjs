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

async function evaluate(expression, timeout = 30_000) {
  let timer;
  const result = await Promise.race([
    command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Terminal test timed out.")), timeout);
    })
  ]).finally(() => clearTimeout(timer));
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

await command("Runtime.enable");
try {
  const result = await evaluate(`(async () => {
    let output = "";
    const off = window.lumen.terminal.onData((data) => { output += data; });
    const restarted = await window.lumen.terminal.restart({
      cols: 80,
      rows: 24,
      cwd: ${JSON.stringify(process.cwd())}
    });
    if (!restarted.ok) throw new Error(restarted.error || "Local Shell restart failed.");
    await window.lumen.terminal.write("printf 'LUMEN_LOCAL_SHELL_OK\\\\n'\\n");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (output.includes("LUMEN_LOCAL_SHELL_OK")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    off();
    return { restarted, output };
  })()`);
  if (!result.output.includes("LUMEN_LOCAL_SHELL_OK")) {
    throw new Error(`Local Shell produced no proof output: ${JSON.stringify(result)}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    cwd: result.restarted.cwd,
    proof: "LUMEN_LOCAL_SHELL_OK"
  })}\n`);
} finally {
  socket.close();
}
