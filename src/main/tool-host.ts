import { app, BrowserWindow, ipcMain } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import http, { type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import type { CoworkToolStatus } from "@shared/types";
import { chromeClick, chromeOpen, chromeScreenshot, chromeSnapshot, chromeStatus, chromeType, shutdownChromeComputerUse } from "./chrome-computer-use";
import { getSettings } from "./store";
import { tavilySearch } from "./search";

type ToolRequest = {
  name: string;
  arguments?: Record<string, unknown>;
  workspace?: string;
};

type ToolResult = {
  ok: boolean;
  content: unknown;
};

const hostToken = crypto.randomBytes(32).toString("hex");
let hostServer: Server | null = null;
let hostStart: Promise<{ url: string; token: string }> | null = null;
let hostUrl = "";
let browserWindow: BrowserWindow | null = null;
let siteServer: Server | null = null;
let siteRoot = "";
let siteUrl = "";
let pluginCache: Array<Record<string, unknown>> = [];
let pluginCacheAt = 0;

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

function runtimeResource(name: string): string | null {
  const candidates = [
    path.join(process.resourcesPath, "runtime", name),
    path.join(app.getAppPath(), "resources", "runtime", name)
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeRealpath(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    throw new Error(`Path does not exist: ${candidate}`);
  }
}

function scopedDirectory(raw: unknown, workspace?: string): string {
  const root = safeRealpath(path.resolve(workspace || os.homedir()));
  const requested = typeof raw === "string" && raw.trim()
    ? path.resolve(root, raw)
    : root;
  const resolved = safeRealpath(requested);
  if (!isInside(root, resolved)) {
    throw new Error("Sites preview is restricted to the active Cowork workspace.");
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return resolved;
}

function siteContentRoot(directory: string): string {
  const candidates = ["dist", "build", "public", "."];
  for (const relative of candidates) {
    const candidate = path.resolve(directory, relative);
    if (isInside(directory, candidate) && fs.existsSync(path.join(candidate, "index.html"))) {
      return safeRealpath(candidate);
    }
  }
  throw new Error("No built site found. Expected index.html in dist, build, public, or the selected directory.");
}

function validBrowserUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("A URL is required.");
  const candidate = raw.trim().includes("://") ? raw.trim() : `https://${raw.trim()}`;
  const parsed = new URL(candidate);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs are supported.");
  }
  return parsed.toString();
}

function ensureBrowserWindow(): BrowserWindow {
  if (browserWindow && !browserWindow.isDestroyed()) return browserWindow;
  browserWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: "Lumen Browser",
    backgroundColor: "#111111",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: "persist:lumen-browser"
    }
  });
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void browserWindow?.loadURL(url);
    }
    return { action: "deny" };
  });
  browserWindow.webContents.on("will-navigate", (event, url) => {
    try {
      if (!["http:", "https:"].includes(new URL(url).protocol)) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  browserWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  browserWindow.on("closed", () => {
    browserWindow = null;
  });
  return browserWindow;
}

async function waitForLoad(win: BrowserWindow): Promise<void> {
  if (!win.webContents.isLoading()) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Browser navigation timed out."));
    }, 20_000);
    const cleanup = () => {
      clearTimeout(timer);
      win.webContents.removeListener("did-finish-load", done);
      win.webContents.removeListener("did-fail-load", failed);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const failed = (_event: unknown, code: number, description: string) => {
      cleanup();
      reject(new Error(`Browser navigation failed (${code}): ${description}`));
    };
    win.webContents.once("did-finish-load", done);
    win.webContents.once("did-fail-load", failed);
  });
}

async function browserOpen(rawUrl: unknown): Promise<unknown> {
  const url = validBrowserUrl(rawUrl);
  const win = ensureBrowserWindow();
  await win.loadURL(url);
  win.show();
  win.focus();
  return {
    url: win.webContents.getURL(),
    title: win.webContents.getTitle(),
    visible: win.isVisible()
  };
}

async function browserSnapshot(): Promise<unknown> {
  const win = ensureBrowserWindow();
  await waitForLoad(win);
  return win.webContents.executeJavaScript(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const interactive = Array.from(document.querySelectorAll(
      'a[href],button,input,textarea,select,[role="button"],[contenteditable="true"]'
    )).filter(visible).slice(0, 120);
    const controls = interactive.map((el, index) => {
      const ref = String(index + 1);
      el.setAttribute("data-lumen-ref", ref);
      const text = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || "").trim().replace(/\\s+/g, " ").slice(0, 180);
      return {
        ref,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || undefined,
        text,
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
  })()`, true);
}

async function browserClick(rawRef: unknown): Promise<unknown> {
  if (typeof rawRef !== "string" && typeof rawRef !== "number") {
    throw new Error("A snapshot control ref is required.");
  }
  const win = ensureBrowserWindow();
  const ref = JSON.stringify(String(rawRef));
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('[data-lumen-ref="' + CSS.escape(${ref}) + '"]');
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "center" });
    el.click();
    return true;
  })()`, true);
  if (!clicked) throw new Error(`Browser control ref ${String(rawRef)} is stale. Take a new snapshot.`);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await waitForLoad(win);
  return { clicked: String(rawRef), url: win.webContents.getURL(), title: win.webContents.getTitle() };
}

async function browserType(rawRef: unknown, rawText: unknown, submit: unknown): Promise<unknown> {
  if ((typeof rawRef !== "string" && typeof rawRef !== "number") || typeof rawText !== "string") {
    throw new Error("A snapshot control ref and text are required.");
  }
  const win = ensureBrowserWindow();
  const ref = JSON.stringify(String(rawRef));
  const value = JSON.stringify(rawText);
  const shouldSubmit = submit === true;
  const typed = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('[data-lumen-ref="' + CSS.escape(${ref}) + '"]');
    if (!el) return false;
    el.focus();
    if ("value" in el) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
      if (setter) setter.call(el, ${value});
      else el.value = ${value};
    } else {
      el.textContent = ${value};
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${value} }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (${JSON.stringify(shouldSubmit)}) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      el.form?.requestSubmit?.();
    }
    return true;
  })()`, true);
  if (!typed) throw new Error(`Browser control ref ${String(rawRef)} is stale. Take a new snapshot.`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await waitForLoad(win);
  return { typed: String(rawRef), submitted: shouldSubmit, url: win.webContents.getURL() };
}

async function browserScreenshot(): Promise<unknown> {
  const win = ensureBrowserWindow();
  await waitForLoad(win);
  const image = await win.webContents.capturePage();
  const destination = path.join(app.getPath("temp"), `lumen-browser-${Date.now()}.png`);
  fs.writeFileSync(destination, image.toPNG());
  return { path: destination, url: win.webContents.getURL(), width: image.getSize().width, height: image.getSize().height };
}

function staticResponse(root: string, request: http.IncomingMessage, response: http.ServerResponse): void {
  const requestedUrl = new URL(request.url || "/", "http://127.0.0.1");
  let pathname = decodeURIComponent(requestedUrl.pathname);
  if (pathname.endsWith("/")) pathname += "index.html";
  let file = path.resolve(root, `.${pathname}`);
  if (!isInside(root, file)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    const fallback = path.join(root, "index.html");
    if (path.extname(pathname) || !fs.existsSync(fallback)) {
      response.writeHead(404).end("Not found");
      return;
    }
    file = fallback;
  }
  file = safeRealpath(file);
  if (!isInside(root, file)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  fs.createReadStream(file).pipe(response);
}

async function sitesPreview(rawDirectory: unknown, workspace?: string): Promise<unknown> {
  const directory = scopedDirectory(rawDirectory, workspace);
  const root = siteContentRoot(directory);
  if (siteServer && siteRoot !== root) {
    await new Promise<void>((resolve) => siteServer?.close(() => resolve()));
    siteServer = null;
    siteRoot = "";
    siteUrl = "";
  }
  if (!siteServer) {
    siteServer = http.createServer((request, response) => staticResponse(root, request, response));
    await new Promise<void>((resolve, reject) => {
      siteServer?.once("error", reject);
      siteServer?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = siteServer.address();
    if (!address || typeof address === "string") throw new Error("Sites preview failed to bind.");
    siteRoot = root;
    siteUrl = `http://127.0.0.1:${address.port}/`;
  }
  await browserOpen(siteUrl);
  return { root: siteRoot, url: siteUrl, browserVisible: true };
}

function pluginManifests(): Array<Record<string, unknown>> {
  if (pluginCache.length && Date.now() - pluginCacheAt < 30_000) return pluginCache;
  const roots = [
    path.join(os.homedir(), ".claude", "plugins"),
    path.join(app.getPath("userData"), "plugins")
  ];
  const manifests: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const visit = (directory: string, depth: number) => {
    if (depth > 7 || manifests.length >= 100) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(candidate, depth + 1);
      } else if (
        entry.isFile() &&
        entry.name === "plugin.json" &&
        [".claude-plugin", ".lumen-plugin"].includes(path.basename(path.dirname(candidate)))
      ) {
        try {
          const data = JSON.parse(fs.readFileSync(candidate, "utf8")) as Record<string, unknown>;
          const key = `${String(data.name || "")}:${String(data.version || "")}`;
          if (!seen.has(key)) {
            seen.add(key);
            manifests.push({
              name: data.name,
              version: data.version,
              description: typeof data.description === "string"
                ? data.description.replace(/\s+/g, " ").trim().slice(0, 240)
                : undefined,
              path: candidate
            });
          }
        } catch {
          // Ignore malformed third-party manifests; the tool reports valid plugins only.
        }
      }
    }
  };
  for (const root of roots) visit(root, 0);
  pluginCache = manifests.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  pluginCacheAt = Date.now();
  return pluginCache;
}

async function dispatchTool(request: ToolRequest): Promise<ToolResult> {
  const args = request.arguments || {};
  const settings = getSettings();
  const pluginForTool =
    request.name.startsWith("browser_") ? "browser"
      : request.name.startsWith("sites_") ? "sites"
        : request.name.startsWith("plugins_") ? "plugins"
          : null;
  if (pluginForTool && !settings.plugins[pluginForTool]) {
    throw new Error(`${pluginForTool} is disabled in Settings → Plugins.`);
  }
  switch (request.name) {
    case "web_search": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) throw new Error("A web search query is required.");
      const maxResults = typeof args.max_results === "number"
        ? Math.max(1, Math.min(Math.round(args.max_results), 10))
        : 5;
      const timeRange = ["day", "week", "month", "year"].includes(String(args.time_range))
        ? args.time_range as "day" | "week" | "month" | "year"
        : undefined;
      const result = await tavilySearch(settings.tavilyApiKey, query, {
        maxResults,
        timeRange
      });
      return {
        ok: true,
        content: {
          query,
          count: result.hits.length,
          results: result.hits.map((hit) => ({
            title: hit.title,
            url: hit.url,
            snippet: hit.content
          }))
        }
      };
    }
    case "browser_open":
      return { ok: true, content: await browserOpen(args.url) };
    case "browser_snapshot":
      return { ok: true, content: await browserSnapshot() };
    case "browser_click":
      return { ok: true, content: await browserClick(args.ref) };
    case "browser_type":
      return { ok: true, content: await browserType(args.ref, args.text, args.submit) };
    case "browser_screenshot":
      return { ok: true, content: await browserScreenshot() };
    case "sites_preview":
      return { ok: true, content: await sitesPreview(args.directory, request.workspace) };
    case "sites_status":
      return { ok: true, content: { running: Boolean(siteServer), root: siteRoot || null, url: siteUrl || null } };
    case "plugins_list": {
      const plugins = pluginManifests();
      return {
        ok: true,
        content: {
          count: plugins.length,
          plugins: plugins.map((plugin) => args.details === true
            ? plugin
            : { name: plugin.name, version: plugin.version })
        }
      };
    }
    case "chrome_open":
      return { ok: true, content: await chromeOpen(args.url) };
    case "chrome_snapshot":
      return { ok: true, content: await chromeSnapshot() };
    case "chrome_click":
      return { ok: true, content: await chromeClick(args.ref) };
    case "chrome_type":
      return { ok: true, content: await chromeType(args.ref, args.text, args.submit) };
    case "chrome_screenshot":
      return { ok: true, content: await chromeScreenshot() };
    default:
      throw new Error(`Unknown Lumen tool: ${request.name}`);
  }
}

async function readJsonBody(request: http.IncomingMessage): Promise<ToolRequest> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 1_000_000) throw new Error("Tool request exceeds 1 MB.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ToolRequest;
}

export async function ensureToolHost(): Promise<{ url: string; token: string; script: string }> {
  const script = runtimeResource("lumen-tools.mjs");
  if (!script) throw new Error("The bundled Lumen tool server is missing from this installation.");
  if (hostServer && hostUrl) return { url: hostUrl, token: hostToken, script };
  if (!hostStart) {
    hostStart = new Promise<{ url: string; token: string }>((resolve, reject) => {
      const server = http.createServer(async (request, response) => {
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        if (request.method !== "POST" || request.url !== "/call") {
          response.writeHead(404).end(JSON.stringify({ error: "Not found" }));
          return;
        }
        if (request.headers.authorization !== `Bearer ${hostToken}`) {
          response.writeHead(401).end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        try {
          const result = await dispatchTool(await readJsonBody(request));
          response.writeHead(200).end(JSON.stringify(result));
        } catch (error) {
          response.writeHead(400).end(JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          }));
        }
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Lumen Tool Host failed to bind."));
          return;
        }
        hostServer = server;
        hostUrl = `http://127.0.0.1:${address.port}`;
        resolve({ url: hostUrl, token: hostToken });
      });
    }).finally(() => {
      hostStart = null;
    });
  }
  const started = await hostStart;
  return { ...started, script };
}

export function getCoworkToolStatus(): CoworkToolStatus {
  const scriptAvailable = Boolean(runtimeResource("lumen-tools.mjs"));
  const plugins = pluginManifests();
  const settings = getSettings();
  const chrome = chromeStatus();
  return {
    online: Boolean(hostServer),
    capabilities: [
      {
        id: "browser",
        available: scriptAvailable && settings.plugins.browser,
        detail: browserWindow && !browserWindow.isDestroyed()
          ? browserWindow.webContents.getURL() || "Ready"
          : "Ready"
      },
      {
        id: "sites",
        available: scriptAvailable && settings.plugins.sites,
        detail: siteUrl || "Local preview"
      },
      {
        id: "plugins",
        available: scriptAvailable && settings.plugins.plugins,
        detail: `${plugins.length} installed`
      },
      {
        id: "chrome",
        available: scriptAvailable && settings.computerUseChromeEnabled && chrome.installed,
        detail: chrome.running ? "Connected" : chrome.installed ? "Installed" : "Not installed"
      }
    ]
  };
}

export function registerToolHostIpc(): void {
  ipcMain.handle("tools:status", () => getCoworkToolStatus());
  ipcMain.handle("tools:chromeStatus", () => chromeStatus());
  ipcMain.handle("tools:chromeOpen", (_event, url: string) => chromeOpen(url));
  ipcMain.handle("tools:chromeSnapshot", () => chromeSnapshot());
  ipcMain.handle("tools:chromeClick", (_event, ref: string | number) => chromeClick(ref));
  ipcMain.handle("tools:chromeType", (_event, ref: string | number, text: string, submit = false) => chromeType(ref, text, submit));
  ipcMain.handle("tools:chromeScreenshot", () => chromeScreenshot());
}

export function shutdownToolHost(): void {
  hostServer?.close();
  hostServer = null;
  hostUrl = "";
  siteServer?.close();
  siteServer = null;
  siteRoot = "";
  siteUrl = "";
  browserWindow?.destroy();
  browserWindow = null;
  shutdownChromeComputerUse();
}
