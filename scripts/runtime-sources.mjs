import fs from "node:fs";
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
socket.addEventListener("close", () => {
  for (const waiter of pending.values()) waiter.reject(new Error("Lumen CDP connection closed."));
  pending.clear();
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
      timer = setTimeout(() => reject(new Error("Sources test timed out.")), timeout);
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
if (process.argv.includes("--status")) {
  const status = await evaluate(`(async () => {
    const tasks = await window.lumen.cowork.listTasks();
    let task = null;
    let messages = [];
    for (const candidate of tasks) {
      const candidateMessages = await window.lumen.cowork.getMessages(candidate.id);
      if (!candidateMessages.some((message) =>
        message.attachments?.some((attachment) => attachment.id === "sources-proof-image")
      )) continue;
      task = candidate;
      messages = candidateMessages;
      break;
    }
    const ui = {
      tabs: [...document.querySelectorAll('[role="tab"]')].map((node) => ({
        text: node.textContent?.trim(),
        selected: node.getAttribute("aria-selected")
      })),
      visiblePanes: document.querySelectorAll('.mode-pane:not([hidden])').length,
      coworkView: Boolean(document.querySelector('.mode-pane:not([hidden]) .cowork-view')),
      environmentOpen: Boolean(document.querySelector('.mode-pane:not([hidden]) .cowork-view.environment-open')),
      environmentToggle: Boolean(document.querySelector('.mode-pane:not([hidden]) .environment-toggle')),
      sourcesButton: Boolean(document.querySelector('.mode-pane:not([hidden]) .environment-sources-title'))
    };
    if (!task) return { task: null, messages: [], ui };
    return {
      task,
      messages: messages.map((message) => ({
        role: message.role,
        status: message.status,
        contentLength: message.content?.length || 0,
        toolCalls: message.toolCalls?.map((tool) => ({
          name: tool.name,
          status: tool.status,
          outputLength: String(tool.output || "").length
        })) || []
      })),
      ui
    };
  })()`);
  process.stdout.write(`${JSON.stringify(status)}\n`);
  socket.close();
  process.exit(0);
}
if (process.argv.includes("--direct")) {
  const direct = await evaluate(`(async () => {
    await window.lumen.settings.set({
      model: "Gemma4-26B-A4B",
      coworkPermissionMode: "full",
      coworkFullAccess: true
    });
    const task = await window.lumen.cowork.createTask({
      title: "LUMEN_DIRECT_TEST",
      cwd: ${JSON.stringify(process.cwd())}
    });
    await window.lumen.cowork.setGoal(task.id, "Previous agent context");
    const started = await window.lumen.cowork.run({
      taskId: task.id,
      prompt: "能干什么呢兄弟",
      cwd: ${JSON.stringify(process.cwd())},
      effort: "none",
      model: "Gemma4-26B-A4B"
    });
    if (!started.ok) throw new Error(started.error || "Direct task failed to start.");
    const initialTitle = (await window.lumen.cowork.listTasks()).find((item) => item.id === task.id)?.title || "";
    for (let attempt = 0; attempt < 360; attempt += 1) {
      const messages = await window.lumen.cowork.getMessages(task.id);
      const assistant = messages.findLast((message) => message.role === "assistant");
      if (assistant?.status === "done" || assistant?.status === "error") {
        const toolCalls = messages.filter((message) => message.toolName || message.kind === "trace").length;
        let title = initialTitle;
        for (let titleAttempt = 0; titleAttempt < 80; titleAttempt += 1) {
          title = (await window.lumen.cowork.listTasks()).find((item) => item.id === task.id)?.title || title;
          if (title && title !== initialTitle) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        await window.lumen.cowork.deleteTask(task.id);
        return {
          status: assistant.status,
          content: assistant.content,
          toolCalls,
          initialTitle,
          title,
          titleUpdated: Boolean(title && title !== initialTitle),
          rawApiError: /API Error:|TypeError:\\s*fetch failed/i.test(assistant.content || "")
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await window.lumen.cowork.deleteTask(task.id);
    throw new Error("Direct Cowork regression timed out.");
  })()`, 200_000);
  await evaluate(`window.lumen.settings.set({
    model: ${JSON.stringify(original.model)},
    coworkPermissionMode: ${JSON.stringify(original.coworkPermissionMode)},
    coworkFullAccess: ${JSON.stringify(original.coworkFullAccess)}
  })`).catch(() => undefined);
  const ok = direct.status === "done" && !direct.rawApiError && direct.toolCalls === 0 && direct.titleUpdated;
  process.stdout.write(`${JSON.stringify({ ok, ...direct })}\n`);
  socket.close();
  process.exit(ok ? 0 : 1);
}
if (process.argv.includes("--cleanup-direct")) {
  const deleted = await evaluate(`(async () => {
    let count = 0;
    const tasks = await window.lumen.cowork.listTasks();
    for (const task of tasks) {
      const messages = await window.lumen.cowork.getMessages(task.id);
      if (!messages.some((message) => message.role === "user" && message.content === "能干什么呢兄弟")) continue;
      await window.lumen.cowork.deleteTask(task.id);
      count += 1;
    }
    return count;
  })()`);
  process.stdout.write(`${JSON.stringify({ ok: true, deleted })}\n`);
  socket.close();
  process.exit(0);
}
if (process.argv.includes("--cleanup")) {
  const deleted = await evaluate(`(async () => {
    let count = 0;
    const tasks = await window.lumen.cowork.listTasks();
    for (const task of tasks) {
      const messages = await window.lumen.cowork.getMessages(task.id);
      const isProof = messages.some((message) =>
        message.attachments?.some((attachment) => attachment.id === "sources-proof-image")
      );
      if (!isProof) continue;
      await window.lumen.cowork.deleteTask(task.id);
      count += 1;
    }
    return count;
  })()`);
  process.stdout.write(`${JSON.stringify({ ok: true, deleted })}\n`);
  socket.close();
  process.exit(0);
}
let taskId = "";
const model = process.env.LUMEN_SOURCES_MODEL || "Gemma4-26B-A4B";
const screenshotPath = "/tmp/lumen-sources-proof.png";
const timelineScreenshotPath = "/tmp/lumen-cowork-timeline-proof.png";
try {
  if (!original.tavilyApiKey) throw new Error("Tavily API key is required for the Sources runtime test.");
  await evaluate(`(async () => {
    const tasks = await window.lumen.cowork.listTasks();
    for (const task of tasks) {
      const messages = await window.lumen.cowork.getMessages(task.id);
      const stale = messages.some((message) =>
        message.attachments?.some((attachment) => attachment.id === "sources-proof-image")
      );
      if (stale) await window.lumen.cowork.deleteTask(task.id);
    }
  })()`);
  await evaluate(`window.lumen.settings.set({
    model: ${JSON.stringify(model)},
    coworkPermissionMode: "full",
    coworkFullAccess: true
  })`);
  const startedTask = await evaluate(`(async () => {
    const task = await window.lumen.cowork.createTask({
      title: "LUMEN_SOURCES_TEST",
      cwd: ${JSON.stringify(process.cwd())}
    });
    const started = await window.lumen.cowork.run({
      taskId: task.id,
      prompt: "Search the public web for the official llama.cpp GitHub repository. Use one concise query, do not open a browser, and reply with one short sentence containing the repository URL.",
      attachments: [{
        id: "sources-proof-image",
        mime: "image/png",
        name: "sources-proof.png",
        dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        kind: "image",
        size: 68
      }],
      cwd: ${JSON.stringify(process.cwd())},
      effort: "high",
      model: ${JSON.stringify(model)}
    });
    if (!started.ok) throw new Error(started.error || "Sources task failed to start.");
    return { taskId: task.id };
  })()`);
  taskId = startedTask.taskId;
  let completed = false;
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    const status = await evaluate(`(async () => {
      const messages = await window.lumen.cowork.getMessages(${JSON.stringify(taskId)});
      return messages.findLast((message) => message.role === "assistant")?.status || "";
    })()`, 10_000);
    if (status === "done" || status === "error") {
      completed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!completed) {
    await evaluate(`window.lumen.cowork.stop(${JSON.stringify(taskId)})`).catch(() => undefined);
    throw new Error("Sources agent run timed out.");
  }
  const result = await evaluate(`(async () => ({
      taskId: ${JSON.stringify(taskId)},
      task: (await window.lumen.cowork.listTasks()).find(
        (item) => item.id === ${JSON.stringify(taskId)}
      ),
      messages: await window.lumen.cowork.getMessages(${JSON.stringify(taskId)})
    }))()`);
  const user = result.messages.find((message) => message.role === "user");
  const assistant = result.messages.findLast((message) => message.role === "assistant");
  const search = assistant?.toolCalls?.find((tool) => tool.name.endsWith("web_search"));
  const imagePath = user?.attachments?.[0]?.path;
  if (!imagePath || !fs.existsSync(imagePath)) throw new Error("Cowork image was not materialized.");
  if (search?.status !== "completed") {
    throw new Error(`Web search did not complete: ${JSON.stringify(search)}`);
  }
  const query = typeof search.input?.query === "string" ? search.input.query.trim() : "";
  if (!query || query.split(/\s+/).length > 6) {
    throw new Error(`Model Rule Style search query was not concise: ${JSON.stringify(query)}`);
  }
  if (!String(search.output).includes("https://")) throw new Error("Web search returned no URL.");
  if (!result.task?.title || /^Use mcp__lumen/i.test(result.task.title)) {
    throw new Error(`Semantic title was not generated: ${JSON.stringify(result.task?.title)}`);
  }

  await evaluate(`location.reload(); "reloading"`, 10_000);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await evaluate("Boolean(window.lumen && document.querySelector('.app'))", 10_000)
      .catch(() => false);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const ui = await evaluate(`(async () => {
    const coworkTab = [...document.querySelectorAll('[role="tab"]')]
      .find((node) => node.textContent?.trim() === "Cowork");
    coworkTab?.click();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (
        coworkTab?.getAttribute("aria-selected") === "true" &&
        document.querySelector('.mode-pane:not([hidden]) .cowork-view')
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const taskItem = document.querySelector(
        ${JSON.stringify(`[data-task-id="${taskId}"]`)}
      );
      if (taskItem) {
        taskItem.click();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    let sourceButton = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      sourceButton = document.querySelector(
        ".mode-pane:not([hidden]) .environment-sources-title"
      );
      if (sourceButton) break;
      const toggle = document.querySelector(".environment-toggle");
      if (toggle?.getAttribute("aria-pressed") === "false") toggle.click();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!sourceButton) throw new Error("Sources button was not rendered.");
    sourceButton.click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const dialog = document.querySelector(".sources-dialog");
    const rect = dialog?.getBoundingClientRect();
    return {
      visible: Boolean(dialog),
      text: dialog?.textContent || "",
      files: dialog?.querySelectorAll(".sources-file").length || 0,
      searches: dialog?.querySelectorAll(".sources-search").length || 0,
      results: dialog?.querySelectorAll(".sources-search-result").length || 0,
      display: dialog ? getComputedStyle(dialog).display : "",
      rect: rect ? { width: rect.width, height: rect.height, left: rect.left } : null
    };
  })()`);
  if (
    !ui.visible ||
    !ui.text.includes("sources-proof.png") ||
    !ui.text.includes(query) ||
    ui.files !== 1 ||
    ui.searches !== 1 ||
    ui.results < 1
  ) {
    throw new Error(`Sources UI mismatch: ${JSON.stringify(ui)}`);
  }
  const capture = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(screenshotPath, Buffer.from(capture.data, "base64"));
  const timeline = await evaluate(`(() => {
    document.querySelector('.sources-dialog-actions button:last-child')?.click();
    const root = document.querySelector('.mode-pane:not([hidden]) .cowork-run-timeline');
    return {
      visible: Boolean(root),
      actions: root?.querySelectorAll('.tool-card').length || 0,
      webActions: root?.querySelectorAll('.tool-card.kind-web').length || 0,
      text: root?.textContent || ""
    };
  })()`);
  if (
    !timeline.visible ||
    timeline.actions < 1 ||
    timeline.webActions !== 1 ||
    timeline.text.includes("View input and output")
  ) {
    throw new Error(`Cowork timeline mismatch: ${JSON.stringify(timeline)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  const timelineCapture = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(timelineScreenshotPath, Buffer.from(timelineCapture.data, "base64"));
  process.stdout.write(`${JSON.stringify({
    ok: true,
    model,
    title: result.task.title,
    imageMaterialized: true,
    searchStatus: search.status,
    ui: { files: ui.files, searches: ui.searches, results: ui.results },
    screenshotPath,
    timeline: { actions: timeline.actions, webActions: timeline.webActions },
    timelineScreenshotPath
  })}\n`);
} finally {
  if (taskId && process.env.LUMEN_KEEP_SOURCES_PROOF !== "1") {
    await evaluate(`window.lumen.cowork.deleteTask(${JSON.stringify(taskId)})`).catch(() => undefined);
  }
  await evaluate(`window.lumen.settings.set({
    model: ${JSON.stringify(original.model)},
    coworkPermissionMode: ${JSON.stringify(original.coworkPermissionMode)},
    coworkFullAccess: ${JSON.stringify(original.coworkFullAccess)}
  })`).catch(() => undefined);
  socket.close();
}
