import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const root = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(root, "resources", "chrome-extension", "manifest.json");
const workerPath = path.join(root, "resources", "chrome-extension", "service-worker.js");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const worker = fs.readFileSync(workerPath, "utf8");
const extensionId = "ppnjleofcmnlhbcllcmndobbfhemnnno";

if (manifest.manifest_version !== 3 || manifest.background?.service_worker !== "service-worker.js") {
  throw new Error("Lumen Browser Bridge manifest is invalid.");
}
for (const permission of ["debugger", "tabs", "tabGroups"]) {
  if (!manifest.permissions?.includes(permission)) {
    throw new Error(`Lumen Browser Bridge is missing ${permission} permission.`);
  }
}
for (const api of ["chrome.debugger.attach", "chrome.debugger.detach", "chrome.debugger.sendCommand", "chrome.tabs.create", "chrome.tabs.group", "chrome.tabGroups.update", "Runtime.consoleAPICalled", "Network.responseReceived", "/health"]) {
  if (!worker.includes(api)) throw new Error(`Lumen Browser Bridge does not implement ${api}.`);
}

const cdpPort = Number(process.env.LUMEN_CDP_PORT || "9223");
const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) => response.json());
const target = targets.find((item) => item.type === "page" && item.title === "Lumen");
if (!target?.webSocketDebuggerUrl) throw new Error("Lumen renderer CDP target not found.");

const renderer = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  renderer.addEventListener("open", resolve, { once: true });
  renderer.addEventListener("error", reject, { once: true });
});
const pending = new Map();
let nextId = 1;
renderer.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});
const command = (method, params = {}) => {
  const id = nextId++;
  renderer.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
const evaluate = async (expression) => {
  const response = await command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  return response.result?.value;
};
await command("Runtime.enable");

if (process.env.LUMEN_OPEN_EXTENSION_INSTALLER === "1") {
  const status = await evaluate("window.lumen.tools.chromeExtensionInstall()");
  renderer.close();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    openedInstaller: true,
    extensionId: status.id,
    directory: status.directory
  })}\n`);
  process.exit(0);
}

if (process.env.LUMEN_LIVE_EXTENSION === "1") {
  const liveUrl = process.env.LUMEN_LIVE_URL || "http://localhost:5173/";
  const original = await evaluate("window.lumen.settings.get()");
  let liveTaskId = "";
  try {
    const result = await evaluate(`(async () => {
      const before = await window.lumen.tools.chromeStatus();
      if (!before.extension.connected) return { before };
      await window.lumen.settings.set({
        browserControlMode: "extension",
        coworkPermissionMode: "full",
        coworkFullAccess: true,
        computerUseChromeEnabled: true
      });
      const opened = await window.lumen.tools.chromeOpen(${JSON.stringify(liveUrl)});
      const snapshot = await window.lumen.tools.chromeSnapshot();
      const screenshot = await window.lumen.tools.chromeScreenshot();
      const preview = await window.lumen.tools.chromePreview();
      const consoleEntries = await window.lumen.tools.chromeConsole();
      const networkEntries = await window.lumen.tools.chromeNetwork();
      const after = await window.lumen.tools.chromeStatus();
      return {
        before,
        opened,
        snapshot,
        screenshot,
        preview: {
          available: preview.available,
          title: preview.title,
          url: preview.url,
          source: preview.source,
          dataChars: preview.dataUrl?.length || 0
        },
        consoleEntries,
        networkEntries,
        after
      };
    })()`);
    if (!result.before?.extension?.connected) {
      throw new Error("Lumen Browser Bridge is not installed or connected in the active Chrome profile.");
    }
    liveTaskId = await evaluate(`(async () => {
      for (const task of await window.lumen.cowork.listTasks()) {
        if (task.title === "LUMEN_CHROME_LIVE") {
          await window.lumen.cowork.deleteTask(task.id);
        }
      }
      const task = await window.lumen.cowork.createTask({
        title: "LUMEN_CHROME_LIVE",
        cwd: ${JSON.stringify(root)}
      });
      return task.id;
    })()`);
    await command("Page.bringToFront");
    await evaluate(`document.querySelectorAll('[role="tab"]')[1]?.click(); true`);
    let selected = false;
    for (let attempt = 0; attempt < 60 && !selected; attempt += 1) {
      selected = await evaluate(`(() => {
        const row = document.querySelector(
          '[data-task-id=${JSON.stringify(liveTaskId)}]'
        );
        row?.click();
        return Boolean(row);
      })()`);
      if (!selected) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    const ui = await evaluate(`(() => {
      const pip = document.querySelector(".computer-use-pip");
      const pipImage = pip?.querySelector("img");
      return {
        mode: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
        visibility: document.visibilityState,
        pip: pip?.getBoundingClientRect().toJSON(),
        imageChars: pipImage?.getAttribute("src")?.length || 0,
        computerUse: Boolean(document.querySelector(".environment-computer-use-row"))
      };
    })()`);
    await evaluate(`document.querySelector(".environment-computer-use-row button")?.click(); true`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    ui.hidden = await evaluate(`!document.querySelector(".computer-use-pip")`);
    await evaluate(`document.querySelector(".environment-computer-use-row button")?.click(); true`);
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    ui.restored = await evaluate(`Boolean(document.querySelector(".computer-use-pip"))`);
    result.ui = ui;
    for (const feature of ["health-probe", "native-tab-group", "picture-in-picture-source", "detach-on-disconnect"]) {
      if (!result.before.extension.features?.includes(feature)) {
        throw new Error(`Lumen Browser Bridge must be reloaded to enable ${feature}.`);
      }
    }
    if (result.after?.controller !== "extension") {
      throw new Error(`Live Chrome extension was not selected: ${JSON.stringify(result.after)}`);
    }
    if (new URL(result.snapshot?.url).href !== new URL(liveUrl).href) {
      throw new Error(`Live Chrome extension snapshot mismatch: ${JSON.stringify(result.snapshot)}`);
    }
    const snapshotChars = JSON.stringify(result.snapshot).length;
    if (snapshotChars > 9_000) {
      throw new Error(`Live Chrome extension snapshot exceeds 9000 characters (${snapshotChars}).`);
    }
    if (result.opened?.group?.title !== "Lumen" || result.opened?.group?.color !== "orange") {
      throw new Error(`Native Lumen tab group was not created: ${JSON.stringify(result.opened?.group)}`);
    }
    if (!result.screenshot?.path || !fs.existsSync(result.screenshot.path)) {
      throw new Error(`Live Chrome extension screenshot is missing: ${JSON.stringify(result.screenshot)}`);
    }
    if (!result.preview?.available || result.preview.dataChars < 1_000) {
      throw new Error(`Live Chrome picture in picture is missing: ${JSON.stringify(result.preview)}`);
    }
    if (
      result.ui?.mode?.trim() !== "Cowork"
      || result.ui?.pip?.width < 240
      || result.ui?.imageChars < 1_000
      || !result.ui?.hidden
      || !result.ui?.restored
      || !result.ui?.computerUse
    ) {
      throw new Error(`Cowork picture in picture UI is missing: ${JSON.stringify(result.ui)}`);
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      live: true,
      controller: result.after.controller,
      extensionId: result.after.extension.id,
      version: result.after.extension.version,
      features: result.after.extension.features,
      url: result.opened?.url,
      title: result.snapshot?.title,
      snapshotChars,
      group: result.opened.group,
      screenshot: result.screenshot.path,
      preview: result.preview,
      ui: result.ui,
      console: result.consoleEntries?.count,
      network: result.networkEntries?.count
    })}\n`);
  } finally {
    if (liveTaskId) {
      await evaluate(`window.lumen.cowork.deleteTask(${JSON.stringify(liveTaskId)})`)
        .catch(() => undefined);
    }
    await evaluate(`window.lumen.settings.set({
      browserControlMode: ${JSON.stringify(original.browserControlMode || "auto")},
      coworkPermissionMode: ${JSON.stringify(original.coworkPermissionMode)},
      coworkFullAccess: ${JSON.stringify(original.coworkFullAccess)},
      computerUseChromeEnabled: ${JSON.stringify(original.computerUseChromeEnabled)}
    })`).catch(() => undefined);
    renderer.close();
  }
  process.exit(0);
}

if (process.env.LUMEN_VERIFY_EXTENSION_GUARD === "1") {
  const original = await evaluate("window.lumen.settings.get()");
  try {
    const result = await evaluate(`(async () => {
      await window.lumen.settings.set({
        browserControlMode: "auto",
        coworkPermissionMode: "full",
        coworkFullAccess: true,
        computerUseChromeEnabled: true
      });
      try {
        await window.lumen.tools.chromeOpen("http://localhost:5173/");
        return { error: "" };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          chrome: await window.lumen.tools.chromeStatus()
        };
      }
    })()`);
    if (!result.error.includes("Lumen Browser Bridge extension is not connected")) {
      throw new Error(`Missing extension did not fail closed: ${JSON.stringify(result)}`);
    }
    if (result.chrome?.controller === "isolated" || result.chrome?.window?.visible) {
      throw new Error(`Missing extension started an isolated Chrome profile: ${JSON.stringify(result.chrome)}`);
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      failedClosed: true,
      error: result.error
    })}\n`);
  } finally {
    await evaluate(`window.lumen.settings.set({
      browserControlMode: ${JSON.stringify(original.browserControlMode || "auto")},
      coworkPermissionMode: ${JSON.stringify(original.coworkPermissionMode)},
      coworkFullAccess: ${JSON.stringify(original.coworkFullAccess)},
      computerUseChromeEnabled: ${JSON.stringify(original.computerUseChromeEnabled)}
    })`).catch(() => undefined);
    renderer.close();
  }
  process.exit(0);
}

const initialStatus = await evaluate("window.lumen.tools.chromeStatus()");
const bridge = new WebSocket(`ws://127.0.0.1:${initialStatus.extension.port}/chrome-extension`, {
  headers: { Origin: `chrome-extension://${extensionId}` }
});
await new Promise((resolve, reject) => {
  bridge.addEventListener("open", resolve, { once: true });
  bridge.addEventListener("error", reject, { once: true });
});
bridge.send(JSON.stringify({
  type: "hello",
  protocol: "lumen.chrome.v1",
  version: manifest.version,
  features: ["health-probe", "native-tab-group", "picture-in-picture-source", "detach-on-disconnect"]
}));
bridge.addEventListener("message", (event) => {
  const request = JSON.parse(String(event.data));
  const responses = {
    open: { url: String(request.params?.url || ""), title: "Lumen" },
    snapshot: {
      url: "http://localhost:5173/",
      title: "Lumen",
      text: "Lumen",
      controls: []
    },
    click: { clicked: String(request.params?.ref || "") },
    type: { typed: String(request.params?.ref || ""), submitted: request.params?.submit === true },
    screenshot: { data: "" },
    console: { count: 1, entries: [{ level: "log", text: "LUMEN_CONSOLE_OK" }] },
    network: { count: 1, entries: [{ url: "http://localhost:5173/", status: 200 }] },
    status: { connected: true, title: "Lumen", url: "http://localhost:5173/" }
  };
  bridge.send(JSON.stringify({
    id: request.id,
    result: responses[request.method] || null
  }));
});

const original = await evaluate("window.lumen.settings.get()");
try {
  const result = await evaluate(`(async () => {
    await window.lumen.settings.set({
      browserControlMode: "extension",
      coworkPermissionMode: "full",
      coworkFullAccess: true,
      computerUseChromeEnabled: true
    });
    const opened = await window.lumen.tools.chromeOpen("http://localhost:5173/");
    const snapshot = await window.lumen.tools.chromeSnapshot();
    const consoleEntries = await window.lumen.tools.chromeConsole();
    const networkEntries = await window.lumen.tools.chromeNetwork();
    const chrome = await window.lumen.tools.chromeStatus();
    return { opened, snapshot, consoleEntries, networkEntries, chrome };
  })()`);
  if (result.chrome.controller !== "extension" || !result.chrome.extension.connected) {
    throw new Error(`Chrome extension bridge was not selected: ${JSON.stringify(result.chrome)}`);
  }
  if (result.snapshot?.title !== "Lumen" || result.snapshot?.url !== "http://localhost:5173/") {
    throw new Error(`Chrome extension bridge snapshot mismatch: ${JSON.stringify(result.snapshot)}`);
  }
  if (result.consoleEntries?.entries?.[0]?.text !== "LUMEN_CONSOLE_OK" || result.networkEntries?.entries?.[0]?.status !== 200) {
    throw new Error(`Chrome extension diagnostics mismatch: ${JSON.stringify(result)}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    bridgeMock: true,
    controller: result.chrome.controller,
    extensionId: result.chrome.extension.id,
    version: result.chrome.extension.version,
    port: result.chrome.extension.port,
    url: result.opened?.url,
    title: result.snapshot?.title,
    console: result.consoleEntries.count,
    network: result.networkEntries.count
  })}\n`);
} finally {
  await evaluate(`window.lumen.settings.set({
    browserControlMode: ${JSON.stringify(original.browserControlMode || "auto")},
    coworkPermissionMode: ${JSON.stringify(original.coworkPermissionMode)},
    coworkFullAccess: ${JSON.stringify(original.coworkFullAccess)},
    computerUseChromeEnabled: ${JSON.stringify(original.computerUseChromeEnabled)}
  })`).catch(() => undefined);
  bridge.close();
  renderer.close();
}
