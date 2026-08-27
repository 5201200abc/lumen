import { app, BrowserWindow, dialog } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ComputerUsePermission } from "@shared/types";
import { getSettings } from "./store";

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
let nextCommandId = 1;
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
  chromeProcess = spawn(executable, [
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDirectory()}`,
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
  });
  chromePort = await waitForPort();
  return chromePort;
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

async function cdp<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const target = await activeTarget();
  if (!chromeSocket || chromeSocket.readyState !== 1 || chromeSocketTargetId !== target.id) {
    chromeSocket?.close();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    chromeSocket = socket;
    chromeSocketTargetId = target.id;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id !== "number") return;
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
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Google Chrome CDP connection failed.")), { once: true });
    });
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
  const mode: ComputerUsePermission = getSettings().computerUsePermissions[kind];
  if (mode === "block") throw new Error(`${label} is blocked in Computer use settings.`);
  if (mode === "allow") return;
  const options = {
    type: "question",
    buttons: ["Allow", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    title: "Google Chrome Computer use",
    message: label,
    detail: "Lumen will control its dedicated Google Chrome profile for this action."
  } as const;
  const parent = BrowserWindow.getFocusedWindow();
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  if (result.response !== 0) throw new Error("Google Chrome Computer use was not approved.");
}

export async function chromeOpen(rawUrl: unknown): Promise<unknown> {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) throw new Error("A URL is required.");
  const candidate = rawUrl.includes("://") ? rawUrl.trim() : `https://${rawUrl.trim()}`;
  const parsed = new URL(candidate);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only http and https URLs are supported.");
  await permitted("approval", `Open ${parsed.hostname} in Google Chrome?`);
  await ensureChrome();
  await cdp("Page.enable");
  await cdp("Page.navigate", { url: parsed.toString() });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const result = await cdp<{ result: { value: unknown } }>("Runtime.evaluate", {
    expression: "({url: location.href, title: document.title})",
    returnByValue: true
  });
  return result.result.value;
}

export async function chromeSnapshot(): Promise<unknown> {
  const result = await cdp<{ result: { value: unknown } }>("Runtime.evaluate", {
    expression: `(() => {
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const controls = Array.from(document.querySelectorAll(
        'a[href],button,input,textarea,select,[role="button"],[contenteditable="true"]'
      )).filter(visible).slice(0, 120).map((el, index) => {
        const ref = String(index + 1);
        el.setAttribute("data-lumen-chrome-ref", ref);
        return {
          ref,
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type") || undefined,
          text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().replace(/\\s+/g, " ").slice(0, 180),
          value: "value" in el ? el.value : undefined,
          href: el.href || undefined,
          disabled: Boolean(el.disabled)
        };
      });
      return {
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || "").trim().replace(/\\n{3,}/g, "\\n\\n").slice(0, 12000),
        controls
      };
    })()`,
    returnByValue: true
  });
  return result.result.value;
}

export async function chromeClick(rawRef: unknown): Promise<unknown> {
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
  const result = await cdp<{ data: string }>("Page.captureScreenshot", { format: "png" });
  const directory = path.join(app.getPath("temp"), "lumen-chrome");
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, `chrome-${Date.now()}.png`);
  fs.writeFileSync(output, Buffer.from(result.data, "base64"));
  return { path: output };
}

export function chromeStatus(): { installed: boolean; running: boolean; executable: string | null } {
  return { installed: Boolean(chromeExecutable()), running: Boolean(chromePort), executable: chromeExecutable() };
}

export function shutdownChromeComputerUse(): void {
  chromeSocket?.close();
  chromeSocket = null;
  chromeSocketTargetId = "";
  chromeProcess?.kill("SIGTERM");
  chromeProcess = null;
  chromePort = 0;
  activeTargetId = "";
}
