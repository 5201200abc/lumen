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
await command("Page.enable");
let taskId = "";
try {
  const result = await evaluate(`(async () => {
    const task = await window.lumen.cowork.createTask({
      title: "LUMEN_CONTEXT_TEST",
      cwd: ${JSON.stringify(process.cwd())}
    });
    const goal = await window.lumen.cowork.setGoal(task.id, "Keep context bounded");
    const compact = await window.lumen.cowork.compact(task.id);
    const messages = await window.lumen.cowork.getMessages(task.id);
    return {
      taskId: task.id,
      goal: goal.task.goal,
      contextUsed: compact.task.contextUsed,
      compactedAt: compact.task.compactedAt,
      activities: messages.map((message) => message.activity),
      contents: messages.map((message) => message.content)
    };
  })()`);
  taskId = result.taskId;
  if (result.goal !== "Keep context bounded") throw new Error(`Goal mismatch: ${result.goal}`);
  if (result.contextUsed !== 0 || !result.compactedAt) {
    throw new Error(`Compact state mismatch: ${JSON.stringify(result)}`);
  }
  if (!result.activities.includes("Goal updated") || !result.activities.includes("Context compacted")) {
    throw new Error(`Command messages missing: ${JSON.stringify(result.activities)}`);
  }

  await command("Page.reload");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await evaluate("Boolean(window.lumen && document.querySelector('.app'))").catch(() => false);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const thinking = await evaluate(`(async () => {
    const coworkTab = [...document.querySelectorAll('[role="tab"]')]
      .find((node) => /Cowork/.test(node.textContent || ""));
    coworkTab?.click();
    let taskRow = null;
    for (let attempt = 0; attempt < 30 && !taskRow; attempt += 1) {
      taskRow = document.querySelector('[data-task-id="${taskId}"]');
      if (!taskRow) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    taskRow?.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const turns = [...document.querySelectorAll(".assistant-turn")];
    const sections = [...document.querySelectorAll(".assistant-turn .cowork-thinking")];
    return {
      turns: turns.length,
      sections: sections.length,
      labels: sections.map((section) => section.querySelector(".cowork-thinking-label")?.textContent),
      beforeAnswer: sections.every((section) => {
        const turn = section.closest(".assistant-turn");
        if (!turn) return false;
        const answer = turn.querySelector(".md");
        return !answer || Boolean(section && (section.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING));
      }),
      taskHeading: Boolean(document.querySelector(".cowork-task-heading"))
    };
  })()`);
  if (
    thinking.turns < 2 ||
    thinking.sections !== 0 ||
    !thinking.beforeAnswer ||
    thinking.taskHeading
  ) {
    throw new Error(`Thinking/header layout mismatch: ${JSON.stringify(thinking)}`);
  }

  const styles = await evaluate(`(() => {
    const row = document.createElement("div");
    row.className = "tool-card completed kind-search";
    row.innerHTML = '<div class="tool-card-header"><div class="tool-card-left"><span class="tool-badge-icon"></span><span class="tool-copy"><span class="tool-name">Search code</span><span class="tool-desc">**/*.html</span></span></div></div>';
    document.body.appendChild(row);
    const copy = getComputedStyle(row.querySelector(".tool-copy"));
    const icon = getComputedStyle(row.querySelector(".tool-badge-icon"));
    const drag = document.createElement("div");
    drag.className = "cowork-titlebar-drag";
    document.body.appendChild(drag);
    const timeline = document.createElement("div");
    timeline.className = "cowork-run-timeline";
    timeline.innerHTML = '<div class="run-step run-thinking"><div class="run-thinking-content">Reasoning</div></div>';
    document.body.appendChild(timeline);
    const worked = document.createElement("details");
    worked.className = "cowork-worked-summary";
    worked.innerHTML = "<summary>Worked for 1m</summary>";
    document.body.appendChild(worked);
    const result = {
      rowDirection: copy.flexDirection,
      iconBackground: icon.backgroundColor,
      iconColor: icon.color,
      dragRegion: getComputedStyle(drag).getPropertyValue("-webkit-app-region"),
      timelineMarginLeft: getComputedStyle(timeline).marginLeft,
      timelineRail: getComputedStyle(timeline, "::before").content,
      thinkingWhiteSpace: getComputedStyle(timeline.querySelector(".run-thinking-content")).whiteSpace,
      workedMarginLeft: getComputedStyle(worked).marginLeft,
      toggleMaximize: typeof window.lumen.ui.toggleMaximize
    };
    row.remove();
    drag.remove();
    timeline.remove();
    worked.remove();
    return result;
  })()`);
  if (styles.rowDirection !== "row") throw new Error(`Timeline is not one line: ${JSON.stringify(styles)}`);
  if (!/rgba\([^)]*, 0\)|transparent/.test(styles.iconBackground)) {
    throw new Error(`Timeline icon still has a box: ${JSON.stringify(styles)}`);
  }
  if (styles.dragRegion.trim() !== "drag") throw new Error(`Titlebar is not draggable: ${JSON.stringify(styles)}`);
  if (
    styles.timelineMarginLeft !== "0px" ||
    !["none", "normal"].includes(styles.timelineRail) ||
    styles.thinkingWhiteSpace !== "pre-wrap" ||
    styles.workedMarginLeft !== "0px" ||
    styles.toggleMaximize !== "function"
  ) {
    throw new Error(`Timeline Thinking layout mismatch: ${JSON.stringify(styles)}`);
  }

  process.stdout.write(`${JSON.stringify({ ok: true, commands: result, thinking, styles })}\n`);
} finally {
  if (taskId) await evaluate(`window.lumen.cowork.deleteTask(${JSON.stringify(taskId)})`).catch(() => {});
  socket.terminate();
}
