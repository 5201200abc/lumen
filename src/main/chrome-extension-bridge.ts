import { app, shell } from "electron";
import fs from "node:fs";
import http, { type Server } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { WebSocket, RawData } from "ws";
import { spawn } from "node:child_process";

const EXTENSION_ID = "ppnjleofcmnlhbcllcmndobbfhemnnno";
const PORTS = Array.from({ length: 9 }, (_, index) => 17341 + index);
const pending = new Map<number, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>();

let bridgeServer: Server | null = null;
let bridgeSocket: WebSocket | null = null;
let bridgePort = 0;
let bridgeVersion = "";
let bridgeFeatures: string[] = [];
let bridgeStart: Promise<void> | null = null;
let nextRequestId = 1;
const runtimeRequire = createRequire(import.meta.url);

function isExpectedExtensionOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "chrome-extension:" && parsed.hostname === EXTENSION_ID;
  } catch {
    return false;
  }
}

function chromeExecutable(): string | null {
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

function extensionDirectory(): string {
  const candidates = [
    path.join(process.resourcesPath, "chrome-extension"),
    path.join(app.getAppPath(), "resources", "chrome-extension")
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "manifest.json"))) || candidates[1];
}

function rejectPending(message: string): void {
  for (const [id, request] of pending) {
    clearTimeout(request.timer);
    request.reject(new Error(message));
    pending.delete(id);
  }
}

function listen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

export async function ensureChromeExtensionBridge(): Promise<void> {
  if (bridgeServer?.listening) return;
  if (bridgeStart) return bridgeStart;
  bridgeStart = (async () => {
    process.env.WS_NO_BUFFER_UTIL = "1";
    process.env.WS_NO_UTF_8_VALIDATE = "1";
    const { WebSocketServer } = runtimeRequire("ws") as typeof import("ws");
    for (const port of PORTS) {
      const server = http.createServer((request, response) => {
        if (request.url === "/health") {
          response.writeHead(204, {
            "Access-Control-Allow-Origin": `chrome-extension://${EXTENSION_ID}`,
            "Cache-Control": "no-store"
          }).end();
          return;
        }
        response.writeHead(404).end();
      });
      const started = await listen(server, port);
      if (!started) {
        server.close();
        continue;
      }
      const sockets = new WebSocketServer({
        server,
        path: "/chrome-extension",
        verifyClient: ({ origin }: { origin: string }) => isExpectedExtensionOrigin(origin)
      });
      sockets.on("connection", (socket) => {
        bridgeSocket?.close(1000, "A newer Lumen bridge connection replaced this one.");
        bridgeSocket = socket;
        bridgeVersion = "";
        bridgeFeatures = [];
        socket.on("message", (raw: RawData) => {
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(raw.toString()) as Record<string, unknown>;
          } catch {
            return;
          }
          if (message.type === "hello" && message.protocol === "lumen.chrome.v1") {
            bridgeVersion = typeof message.version === "string" ? message.version : "";
            bridgeFeatures = Array.isArray(message.features)
              ? message.features.filter((feature): feature is string => typeof feature === "string")
              : [];
            return;
          }
          if (typeof message.id !== "number") return;
          const request = pending.get(message.id);
          if (!request) return;
          pending.delete(message.id);
          clearTimeout(request.timer);
          if (typeof message.error === "string") request.reject(new Error(message.error));
          else request.resolve(message.result);
        });
        socket.on("close", () => {
          if (bridgeSocket !== socket) return;
          bridgeSocket = null;
          bridgeVersion = "";
          bridgeFeatures = [];
          rejectPending("Lumen Browser Bridge disconnected.");
        });
      });
      bridgeServer = server;
      bridgePort = port;
      return;
    }
    throw new Error(`Lumen Browser Bridge could not bind ports ${PORTS[0]}-${PORTS.at(-1)}.`);
  })().finally(() => {
    bridgeStart = null;
  });
  return bridgeStart;
}

export function chromeExtensionStatus(): {
  id: string;
  available: boolean;
  connected: boolean;
  port: number;
  version: string;
  features: string[];
  directory: string;
} {
  return {
    id: EXTENSION_ID,
    available: fs.existsSync(path.join(extensionDirectory(), "manifest.json")),
    connected: bridgeSocket?.readyState === 1,
    port: bridgePort,
    version: bridgeVersion,
    features: bridgeFeatures,
    directory: extensionDirectory()
  };
}

export async function requestChromeExtension<T>(
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  await ensureChromeExtensionBridge();
  if (!bridgeSocket || bridgeSocket.readyState !== 1) {
    throw new Error("Lumen Browser Bridge extension is not connected. Open Chrome and enable the extension.");
  }
  const id = nextRequestId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Lumen Browser Bridge timed out: ${method}`));
    }, 20_000);
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timer
    });
    bridgeSocket!.send(JSON.stringify({ id, method, params }));
  });
}

export async function openChromeExtensionInstaller(): Promise<ReturnType<typeof chromeExtensionStatus>> {
  await ensureChromeExtensionBridge();
  const directory = extensionDirectory();
  shell.showItemInFolder(path.join(directory, "manifest.json"));
  const executable = chromeExecutable();
  if (executable) {
    const child = spawn(executable, ["chrome://extensions/"], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  }
  return chromeExtensionStatus();
}

export function shutdownChromeExtensionBridge(): void {
  rejectPending("Lumen Browser Bridge stopped.");
  bridgeSocket?.close();
  bridgeSocket = null;
  bridgeVersion = "";
  bridgeFeatures = [];
  bridgeServer?.close();
  bridgeServer = null;
  bridgePort = 0;
}
