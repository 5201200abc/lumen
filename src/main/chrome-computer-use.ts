import { app, BrowserWindow, desktopCapturer, dialog, screen } from "electron";
import type { MessageBoxOptions } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ComputerUsePermission } from "@shared/types";
import { getSettings } from "./store";
import { chromeExtensionStatus, requestChromeExtension } from "./chrome-extension-bridge";
import { selectChromeController } from "./chrome-control-policy";

type ChromeTarget = {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
};

let chromeProcess: ChildProcess | null = null;
let chromePort = 0;
let activeTargetId = "";
let chromeSocket: WebSocket | null = null;
let chromeSocketTargetId = "";
let activeController: "extension" | "isolated" | null = null;
let consoleEntries: Array<Record<string, unknown>> = [];
let networkEntries: Array<Record<string, unknown>> = [];
let networkRequests = new Map<string, { method?: string; url?: string }>();
let nextCommandId = 1;
let chromeWindow: {
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  parentBounds: { x: number; y: number; width: number; height: number } | null;
} | undefined;
const pendingCommands = new Map<number, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>();

export function chromeExecutable(): string | null {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")]
    : process.platform === "win32"
      ? [
          path.join(process.env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] || "", "Google/Chrome/Application/chrome.exe"),
          path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe")
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function profileDirectory(): string {
  return path.join(app.getPath("userData"), "chrome-computer-use");
}

async function waitForPort(): Promise<number> {
  const portFile = path.join(profileDirectory(), "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const port = Number(fs.readFileSync(portFile, "utf8").split(/\r?\n/, 1)[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // Chrome has not written DevToolsActivePort yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Google Chrome did not expose a CDP port within 10 seconds.");
}

async function ensureChrome(): Promise<number> {
  const settings = getSettings();
  if (!settings.computerUseChromeEnabled) throw new Error("Google Chrome Computer use is disabled in Settings.");
  const executable = chromeExecutable();
  if (!executable) throw new Error("Google Chrome is not installed.");
  if (chromePort) {
    try {
      const response = await fetch(`http://127.0.0.1:${chromePort}/json/version`);
      if (response.ok) return chromePort;
    } catch {
      chromePort = 0;
    }
  }
  fs.mkdirSync(profileDirectory(), { recursive: true });
  try {
    fs.rmSync(path.join(profileDirectory(), "DevToolsActivePort"), { force: true });
  } catch {
    // A stale port file is non-fatal.
  }
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = 420;
  const height = 280;
  chromeProcess = spawn(executable, [
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDirectory()}`,
    `--window-size=${width},${height}`,
    `--window-position=${workArea.x + workArea.width - width - 18},${workArea.y + workArea.height - height - 18}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  ], { stdio: "ignore" });
  chromeProcess.once("exit", () => {
    chromeSocket?.close();
    chromeSocket = null;
    chromeSocketTargetId = "";
    chromeProcess = null;
    chromePort = 0;
    activeTargetId = "";
    chromeWindow = undefined;
  });
  chromePort = await waitForPort();
  return chromePort;
}

async function dockChromeWindow(): Promise<void> {
  const target = await activeTarget();
  const current = await cdp<{ windowId: number }>("Browser.getWindowForTarget", {
    targetId: target.id
  });
  const parent = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && win.getTitle() === "Lumen");
  const anchor = parent?.getBounds() || screen.getPrimaryDisplay().workArea;
  const width = Math.min(420, anchor.width - 32);
  const height = Math.min(280, anchor.height - 32);
  const bounds = {
    x: anchor.x + anchor.width - width - 16,
    y: anchor.y + anchor.height - height - 16,
    width,
    height
  };
  await cdp("Browser.setWindowBounds", {
    windowId: current.windowId,
    bounds: {
      left: bounds.x,
      top: bounds.y,
      width,
      height,
      windowState: "normal"
    }
  });
  chromeWindow = {
    visible: true,
    bounds,
    parentBounds: parent ? parent.getBounds() : null
  };
}

async function targets(): Promise<ChromeTarget[]> {
  const port = await ensureChrome();
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`Google Chrome target discovery failed (${response.status}).`);
  return response.json() as Promise<ChromeTarget[]>;
}

async function activeTarget(): Promise<ChromeTarget> {
  const list = await targets();
  let target = list.find((item) => item.id === activeTargetId && item.type === "page")
    || list.find((item) => item.type === "page");
  if (!target) {
    const port = await ensureChrome();
    const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
    if (response.ok) target = await response.json() as ChromeTarget;
  }
  if (!target?.webSocketDebuggerUrl) throw new Error("Google Chrome has no controllable page.");
  activeTargetId = target.id;
  return target;
}

async function cdp<T>(
  method: string,
  params: Record<string, unknown> = {},
  connectionAttempt = 0
): Promise<T> {
  const target = await activeTarget();
  if (!chromeSocket || chromeSocket.readyState !== 1 || chromeSocketTargetId !== target.id) {
    chromeSocket?.close();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    chromeSocket = socket;
    chromeSocketTargetId = target.id;
    consoleEntries = [];
    networkEntries = [];
    networkRequests = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id !== "number") {
        if (message.method === "Runtime.consoleAPICalled") {
          const params = message.params || {};
          consoleEntries.push({
            level: params.type,
            text: (params.args || []).map((arg: Record<string, unknown>) => arg.value ?? arg.description ?? "").join(" ").slice(0, 2000),
            timestamp: params.timestamp
          });
        } else if (message.method === "Log.entryAdded") {
          const entry = message.params?.entry || {};
          consoleEntries.push({
            level: entry.level || "log",
            text: String(entry.text || "").slice(0, 2000),
            url: entry.url,
            timestamp: entry.timestamp
          });
        } else if (message.method === "Network.requestWillBeSent") {
          const request = message.params?.request || {};
          networkRequests.set(String(message.params?.requestId || ""), {
            method: request.method,
            url: request.url
          });
        } else if (message.method === "Network.responseReceived") {
          const response = message.params?.response || {};
          const request = networkRequests.get(String(message.params?.requestId || ""));
          networkEntries.push({
            method: request?.method,
            url: response.url,
            status: response.status,
            mimeType: response.mimeType,
            type: message.params?.type,
            timestamp: message.params?.timestamp
          });
        }
        if (consoleEntries.length > 500) consoleEntries.splice(0, consoleEntries.length - 500);
        if (networkEntries.length > 500) networkEntries.splice(0, networkEntries.length - 500);
        return;
      }
      const pending = pendingCommands.get(message.id);
      if (!pending) return;
      pendingCommands.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      if (chromeSocket === socket) {
        chromeSocket = null;
        chromeSocketTargetId = "";
        for (const [id, pending] of pendingCommands) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Google Chrome CDP connection closed."));
          pendingCommands.delete(id);
        }
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("Google Chrome CDP connection failed.")), { once: true });
      });
    } catch (error) {
      socket.close();
      if (chromeSocket === socket) {
        chromeSocket = null;
        chromeSocketTargetId = "";
      }
      if (connectionAttempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return cdp<T>(method, params, connectionAttempt + 1);
      }
      throw error;
    }
  }
  const id = nextCommandId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(`Google Chrome CDP command timed out: ${method}`));
    }, 20_000);
    pendingCommands.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timer
    });
    chromeSocket!.send(JSON.stringify({ id, method, params }));
  });
}

async function permitted(kind: "approval", label: string): Promise<void> {
  const settings = getSettings();
  if (settings.coworkPermissionMode === "full" && settings.coworkFullAccess) return;
  const mode: ComputerUsePermission = settings.computerUsePermissions[kind];
  if (mode === "block") throw new Error(`${label} is blocked in Computer use settings.`);
  if (mode === "allow") return;
  const options: MessageBoxOptions = {
    type: "question",
    buttons: ["Allow", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    title: "Google Chrome Computer use",
    message: label,
    detail: chromeExtensionStatus().connected
      ? "Lumen will control the active Chrome profile through the Lumen Browser Bridge extension."
      : "Lumen will control its dedicated Google Chrome profile for this action."
  };
  const parent = BrowserWindow.getFocusedWindow();
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  if (result.response !== 0) throw new Error("Google Chrome Computer use was not approved.");
}

function controller(requireExisting = false): "extension" | "isolated" {
  return selectChromeController({
    mode: getSettings().browserControlMode,
    extensionConnected: chromeExtensionStatus().connected,
    activeController,
    requireExisting
  });
}

async function enableDiagnostics(): Promise<void> {
  await Promise.all([
    cdp("Runtime.enable"),
    cdp("Log.enable"),
    cdp("Network.enable")
  ]);
}

export async function chromeOpen(rawUrl: unknown): Promise<unknown> {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) throw new Error("A URL is required.");
  const candidate = rawUrl.includes("://") ? rawUrl.trim() : `https://${rawUrl.trim()}`;
  const parsed = new URL(candidate);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only http and https URLs are supported.");
  await permitted("approval", `Open ${parsed.hostname} in Google Chrome?`);
  if (controller() === "extension") {
    const result = await requestChromeExtension<{
      url?: string;
      title?: string;
      group?: unknown;
      window?: { left: number; top: number; width: number; height: number };
    }>("open", { url: parsed.toString() });
    activeController = "extension";
    const parent = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && win.getTitle() === "Lumen");
    const actual = result.window;
    chromeWindow = {
      visible: true,
      bounds: actual
        ? { x: actual.left, y: actual.top, width: actual.width, height: actual.height }
        : { x: 0, y: 0, width: 0, height: 0 },
      parentBounds: parent?.getBounds() || null
    };
    return result;
  }
  activeController = "isolated";
  await ensureChrome();
  await enableDiagnostics();
  await cdp("Page.enable");
  await cdp("Page.navigate", { url: parsed.toString() });
  await dockChromeWindow();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const result = await cdp<{ result: { value: unknown } }>("Runtime.evaluate", {
    expression: "({url: location.href, title: document.title})",
    returnByValue: true
  });
  return result.result.value;
}

export async function chromeSnapshot(): Promise<unknown> {
  if (controller(Boolean(activeController)) === "extension") {
    activeController = "extension";
    return requestChromeExtension("snapshot");
  }
  activeController = "isolated";
  await enableDiagnostics();
  const result = await cdp<{ result: { value: unknown } }>("Runtime.evaluate", {
    expression: `(() => {
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const controls = Array.from(document.querySelectorAll(
        'a[href],button,input,textarea,select,[role="button"],[contenteditable="true"]'
      )).filter(visible).slice(0, 36).map((el, index) => {
        const ref = String(index + 1);
        el.setAttribute("data-lumen-chrome-ref", ref);
        const value = "value" in el ? String(el.value || "").slice(0, 120) : "";
        return {
          ref,
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type") || undefined,
          text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().replace(/\\s+/g, " ").slice(0, 100),
          value: value || undefined,
          disabled: Boolean(el.disabled)
        };
      });
      return {
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || "").trim().replace(/\\n{3,}/g, "\\n\\n").slice(0, 2200),
        controls
      };
    })()`,
    returnByValue: true
  });
  return result.result.value;
}

export async function chromeClick(rawRef: unknown): Promise<unknown> {
  if (controller(Boolean(activeController)) === "extension") {
    activeController = "extension";
    return requestChromeExtension("click", { ref: rawRef });
  }
  activeController = "isolated";
  const ref = JSON.stringify(String(rawRef ?? ""));
  const result = await cdp<{ result: { value: boolean } }>("Runtime.evaluate", {
    expression: `(() => {
      const el = document.querySelector('[data-lumen-chrome-ref="' + CSS.escape(${ref}) + '"]');
      if (!el) return false;
      el.scrollIntoView({block: "center", inline: "center"});
      el.click();
      return true;
    })()`,
    returnByValue: true
  });
  if (!result.result.value) throw new Error(`Google Chrome control ref ${String(rawRef)} is stale. Take a new snapshot.`);
  return { clicked: String(rawRef) };
}

export async function chromeType(rawRef: unknown, rawText: unknown, submit: unknown): Promise<unknown> {
  if (typeof rawText !== "string") throw new Error("Text is required.");
  if (controller(Boolean(activeController)) === "extension") {
    activeController = "extension";
    return requestChromeExtension("type", { ref: rawRef, text: rawText, submit: submit === true });
  }
  activeController = "isolated";
  const ref = JSON.stringify(String(rawRef ?? ""));
  const text = JSON.stringify(rawText);
  const shouldSubmit = submit === true;
  const result = await cdp<{ result: { value: boolean } }>("Runtime.evaluate", {
    expression: `(() => {
      const el = document.querySelector('[data-lumen-chrome-ref="' + CSS.escape(${ref}) + '"]');
      if (!el) return false;
      el.focus();
      if ("value" in el) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
        setter ? setter.call(el, ${text}) : el.value = ${text};
      } else {
        el.textContent = ${text};
      }
      el.dispatchEvent(new Event("input", {bubbles: true}));
      el.dispatchEvent(new Event("change", {bubbles: true}));
      if (${shouldSubmit}) el.form?.requestSubmit();
      return true;
    })()`,
    returnByValue: true
  });
  if (!result.result.value) throw new Error(`Google Chrome control ref ${String(rawRef)} is stale. Take a new snapshot.`);
  return { typed: String(rawRef), submitted: shouldSubmit };
}

export async function chromeScreenshot(): Promise<unknown> {
  if (controller(Boolean(activeController)) === "extension") {
    activeController = "extension";
    const result = await requestChromeExtension<{ data: string }>("screenshot");
    return saveScreenshot(result.data);
  }
  activeController = "isolated";
  const result = await cdp<{ data: string }>("Page.captureScreenshot", { format: "png" });
  return saveScreenshot(result.data);
}

export async function chromeConsole(clear: unknown): Promise<unknown> {
  if (controller(Boolean(activeController)) === "extension") {
    activeController = "extension";
    return requestChromeExtension("console", { clear: clear === true });
  }
  activeController = "isolated";
  await enableDiagnostics();
  const entries = consoleEntries.slice(-200);
  if (clear === true) consoleEntries = [];
  return { count: entries.length, entries };
}

export async function chromeNetwork(clear: unknown): Promise<unknown> {
  if (controller(Boolean(activeController)) === "extension") {
    activeController = "extension";
    return requestChromeExtension("network", { clear: clear === true });
  }
  activeController = "isolated";
  await enableDiagnostics();
  const entries = networkEntries.slice(-200);
  if (clear === true) networkEntries = [];
  return { count: entries.length, entries };
}

export async function chromePreview(): Promise<{
  available: boolean;
  dataUrl?: string;
  title?: string;
  url?: string;
  source?: "window" | "tab";
}> {
  if (activeController !== "extension" || !chromeWindow?.visible || !chromeExtensionStatus().connected) {
    return { available: false };
  }
  const status = await requestChromeExtension<{
    title?: string;
    url?: string;
  }>("status");
  const title = String(status.title || "").trim();
  try {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 720, height: 480 },
      fetchWindowIcons: false
    });
    const source = sources.find((item) => item.name === title)
      || sources.find((item) => title && item.name.includes(title))
      || sources.find((item) => /Google Chrome/i.test(item.name));
    if (source && !source.thumbnail.isEmpty()) {
      return {
        available: true,
        dataUrl: `data:image/jpeg;base64,${source.thumbnail.toJPEG(72).toString("base64")}`,
        title,
        url: status.url,
        source: "window"
      };
    }
  } catch {
    // Fall through to the tab capture when macOS window capture permission is unavailable.
  }
  if (/^(?:chrome|edge|about):/i.test(String(status.url || ""))) {
    return { available: false, title, url: status.url };
  }
  const screenshot = await requestChromeExtension<{ data?: string }>("screenshot");
  if (!screenshot.data) return { available: false, title, url: status.url };
  return {
    available: true,
    dataUrl: `data:image/png;base64,${screenshot.data}`,
    title,
    url: status.url,
    source: "tab"
  };
}

export async function releaseChromeComputerUse(): Promise<void> {
  if (activeController === "extension" && chromeExtensionStatus().connected) {
    await requestChromeExtension("release").catch(() => undefined);
  }
  activeController = null;
  chromeWindow = undefined;
}

function saveScreenshot(data: string): { path: string } {
  const directory = path.join(app.getPath("temp"), "lumen-chrome");
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, `chrome-${Date.now()}.png`);
  fs.writeFileSync(output, Buffer.from(data, "base64"));
  return { path: output };
}

export function chromeStatus(): {
  installed: boolean;
  running: boolean;
  executable: string | null;
  mode: "auto" | "extension" | "isolated";
  controller: "extension" | "isolated" | null;
  extension: ReturnType<typeof chromeExtensionStatus>;
  window?: typeof chromeWindow;
} {
  const extension = chromeExtensionStatus();
  return {
    installed: Boolean(chromeExecutable()),
    running: extension.connected || Boolean(chromePort),
    executable: chromeExecutable(),
    mode: getSettings().browserControlMode,
    controller: activeController,
    extension,
    window: chromeWindow
  };
}

export function shutdownChromeComputerUse(): void {
  chromeSocket?.close();
  chromeSocket = null;
  chromeSocketTargetId = "";
  chromeProcess?.kill("SIGTERM");
  chromeProcess = null;
  chromePort = 0;
  activeTargetId = "";
  activeController = null;
  consoleEntries = [];
  networkEntries = [];
  networkRequests = new Map();
  chromeWindow = undefined;
}
