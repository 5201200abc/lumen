import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { app } from "electron";
import type { LlamaStatus, LocalModel, ModelBenchmarkResult, Settings } from "@shared/types";
import { detectReasoningControl, detectReasoningEfforts } from "@shared/types";
import { readGgufTextMetadata } from "./gguf-metadata";
import { setDetectedLlamaPort } from "./store";

const DEFAULT_DIR = join(homedir(), "models");
const MAX_LOCAL_MODELS = 5;
const LOOPBACK_URL = "http://127.0.0.1/v1";
const execFileAsync = promisify(execFile);
type LlamaListener = { pid: number; port: number };
let managedRouterProcess: ReturnType<typeof spawn> | null = null;
let managedRouterPort = 0;

function walkGgufs(root: string, depth = 0, acc: string[] = []): string[] {
  if (depth > 5 || !existsSync(root)) return acc;
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".cache" || name === "websearch" || name === "logs") {
      continue;
    }
    const full = join(root, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walkGgufs(full, depth + 1, acc);
    else if (/\.gguf$/i.test(name)) acc.push(full);
  }
  return acc;
}

function isPrimaryModelGguf(path: string): boolean {
  const name = basename(path);
  if (/mmproj/i.test(name)) return false;
  const shard = name.match(/-(\d{5})-of-(\d{5})\.gguf$/i);
  return !shard || shard[1] === "00001";
}

function standaloneModelName(path: string): string {
  return basename(path)
    .replace(/\.gguf$/i, "")
    .replace(/-\d{5}-of-\d{5}$/i, "")
    .replace(/[-_.](?:uncensored[-_.])?(?:q\d(?:_[a-z0-9]+)*|iq\d(?:_[a-z0-9]+)*|f16|bf16)$/i, "");
}

export function discoverLocal(modelsDir = DEFAULT_DIR): {
  ggufs: string[];
  models: LocalModel[];
} {
  const dir = modelsDir || DEFAULT_DIR;
  const ggufs = walkGgufs(dir).sort((a, b) => a.localeCompare(b));
  const modelFiles = ggufs.filter(isPrimaryModelGguf);
  const discoveredModels = modelFiles.map((path) => {
    const parent = dirname(path);
    const relativeParent = relative(dir, parent);
    const name = relativeParent && relativeParent !== "."
      ? relativeParent.split(/[\\/]/)[0]
      : standaloneModelName(path);
    const projector =
      ggufs.find((candidate) => dirname(candidate) === parent && /mmproj/i.test(basename(candidate))) ||
      null;
    const capabilityName = `${name} ${basename(path)}`;
    const metadata = readGgufTextMetadata(path);
    const chatTemplate = Object.entries(metadata)
      .filter(([key]) => key.startsWith("tokenizer.chat_template"))
      .map(([, value]) => value)
      .join("\n");
    return {
      name,
      path,
      mmproj: projector,
      vision: Boolean(projector),
      reasoningControl: detectReasoningControl(capabilityName, chatTemplate),
      reasoningEfforts: detectReasoningEfforts(capabilityName, chatTemplate)
    };
  });
  const models = [...new Map(discoveredModels.map((model) => [model.name, model])).values()]
    .slice(0, MAX_LOCAL_MODELS);
  return {
    ggufs: models.map((model) => model.path),
    models
  };
}

function origin(url: string): string {
  return url.replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

export function isManagedLocalLlamaUrl(url: string): boolean {
  try {
    const parsed = new URL(url || LOOPBACK_URL);
    return ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function urlForPort(port: number): string {
  return `http://127.0.0.1:${port}/v1`;
}

function configuredPort(settings: Settings): number {
  if (settings.llamaPort > 0) return settings.llamaPort;
  try {
    const parsed = new URL(settings.llamaUrl);
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
  } catch {
    return 0;
  }
}

async function processListeners(): Promise<LlamaListener[]> {
  if (process.platform === "win32") {
    const script = [
      "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |",
      "ForEach-Object {",
      "$p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue;",
      "if ($p -and $p.ProcessName -eq 'llama-server') {",
      "'{0}:{1}' -f $_.OwningProcess,$_.LocalPort",
      "}}"
    ].join(" ");
    try {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script]);
      return stdout.split(/\r?\n/).map((line) => {
        const [pid, port] = line.trim().split(":").map(Number);
        return { pid, port };
      }).filter((item) => Number.isInteger(item.pid) && Number.isInteger(item.port));
    } catch {
      return [];
    }
  }

  try {
    const { stdout: ps } = await execFileAsync("ps", ["-axo", "pid=,comm="]);
    const pids = ps.split(/\r?\n/).flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      return match && basename(match[2]) === "llama-server" ? [Number(match[1])] : [];
    });
    const listeners = await Promise.all(pids.map(async (pid) => {
      try {
        const { stdout } = await execFileAsync("lsof", [
          "-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"
        ]);
        return stdout.split(/\r?\n/).flatMap((line) => {
          const match = line.match(/^n(?:127\.0\.0\.1|0\.0\.0\.0|\*|\[::1\]|\[::\]):(\d+)$/);
          return match ? [{ pid, port: Number(match[1]) }] : [];
        });
      } catch {
        return [];
      }
    }));
    return listeners.flat();
  } catch {
    return [];
  }
}

async function healthyListener(preferredPort = 0, routerOnly = false): Promise<LlamaListener | null> {
  const listeners = await processListeners();
  const candidates = preferredPort
    ? listeners.filter((listener) => listener.port === preferredPort)
    : listeners;
  candidates.sort((a, b) =>
    Number(b.port === preferredPort) - Number(a.port === preferredPort) || a.port - b.port
  );
  for (const listener of candidates) {
    if (!(await fetchJson(`http://127.0.0.1:${listener.port}/health`, 900))) continue;
    if (routerOnly) {
      const props = await fetchJson(`http://127.0.0.1:${listener.port}/props`, 900) as
        | { role?: string }
        | null;
      if (props?.role !== "router") continue;
    }
    return listener;
  }
  return null;
}

async function freeLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function resolveLocalEndpoint(settings: Settings, allocate = false): Promise<{
  url: string;
  port: number;
  pid: number | null;
}> {
  const preferred = configuredPort(settings);
  if (
    managedRouterProcess &&
    managedRouterPort > 0 &&
    (!preferred || preferred === managedRouterPort) &&
    await fetchJson(`http://127.0.0.1:${managedRouterPort}/health`, 900)
  ) {
    setDetectedLlamaPort(managedRouterPort);
    return {
      url: urlForPort(managedRouterPort),
      port: managedRouterPort,
      pid: managedRouterProcess.pid || null
    };
  }
  const listener = preferred
    ? await healthyListener(preferred)
    : await healthyListener(0, true);
  if (listener) {
    setDetectedLlamaPort(listener.port);
    return { url: urlForPort(listener.port), port: listener.port, pid: listener.pid };
  }
  const preferredOnline = preferred
    ? await fetchJson(`http://127.0.0.1:${preferred}/health`, 900)
    : null;
  if (preferred && preferredOnline) {
    return {
      url: urlForPort(preferred),
      port: preferred,
      pid: managedRouterPort === preferred ? managedRouterProcess?.pid || null : null
    };
  }
  const port = preferred || (allocate ? await freeLoopbackPort() : 0);
  if (port) setDetectedLlamaPort(port);
  return { url: port ? urlForPort(port) : settings.llamaUrl || LOOPBACK_URL, port, pid: null };
}

async function fetchJson(url: string, ms = 2500): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeLlama(settings: Settings): Promise<LlamaStatus> {
  const local = isManagedLocalLlamaUrl(settings.llamaUrl);
  const endpoint = local
    ? await resolveLocalEndpoint(settings)
    : { url: settings.llamaUrl, port: Number(new URL(settings.llamaUrl).port) || 0, pid: null };
  const url = endpoint.url;
  const found = discoverLocal(settings.modelsDir || DEFAULT_DIR);
  const base = origin(url);
  const health = await fetchJson(`${base}/health`);
  const models = (await fetchJson(`${base}/v1/models`)) as
    | { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> }
    | null;
  const props = (await fetchJson(`${base}/props`)) as
    | {
        role?: string;
        modalities?: { vision?: boolean };
        model_alias?: string;
        model_path?: string;
      }
    | null;
  const online = Boolean(health);
  const managedLocal = isManagedLocalLlamaUrl(url);
  const pathModel = found.models.find((candidate) => candidate.path === props?.model_path);
  const router = props?.role === "router";
  const remoteModel = router
    ? settings.model
    : pathModel?.name ||
      props?.model_alias ||
      models?.data?.[0]?.id ||
      models?.models?.[0]?.name ||
      settings.model;
  const liveData = Array.isArray(models?.data)
    ? (models!.data.map((d) => d.id).filter(Boolean) as string[])
    : [];
  const liveModels = Array.isArray(models?.models)
    ? (models!.models.map((d) => d.name).filter(Boolean) as string[])
    : [];
  const live = [...liveData, ...liveModels];
  const unique = [...new Set(live.length ? live : [remoteModel || settings.model].filter(Boolean))];
  const runningModel = router ? null : (pathModel?.name || remoteModel || null);
  const selectedLocal = found.models.find((candidate) => candidate.name === settings.model);
  const mismatchedSingleModel =
    online &&
    !router &&
    Boolean(selectedLocal && props?.model_path && selectedLocal.path !== props.model_path);
  return {
    online,
    port: endpoint.port || null,
    pid: endpoint.pid,
    managed: managedLocal,
    model: remoteModel || settings.model,
    vision: Boolean(props?.modalities?.vision) || Boolean(router && selectedLocal?.vision),
    url,
    modelsDir: settings.modelsDir || DEFAULT_DIR,
    ggufs: found.ggufs,
    models: managedLocal
      ? [...new Set([...unique, ...found.models.map((model) => model.name)])]
      : unique,
    localModels: found.models,
    router,
    runningModel,
    runningModelPath: props?.model_path || null,
    mmproj: selectedLocal?.mmproj || null,
    error: !online
      ? "本地模型路由服务未连接。"
      : mismatchedSingleModel
        ? `${endpoint.port} 端口当前是旧单模型服务（${runningModel}），Lumen 将替换为多模型路由服务。`
        : undefined
  };
}

export async function benchmarkLocalModel(settings: Settings, model: string): Promise<ModelBenchmarkResult> {
  if (!model || model !== settings.model) {
    throw new Error("Only the current active model can be benchmarked.");
  }
  if (!settings.llamaModels.some((candidate) => candidate.name === model)) {
    throw new Error(`Model "${model}" is no longer available. Refresh the local model list.`);
  }

  let status = await ensureLocalLlama(settings);
  if (!status.online) throw new Error(status.error || "llama-server is not running.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  const startedAt = performance.now();
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (settings.llamaApiKey) headers.Authorization = `Bearer ${settings.llamaApiKey}`;
    const body = JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: "Write exactly 100 short lowercase English words separated by spaces. Output only the words."
        }
      ],
      temperature: 0,
      max_tokens: 128,
      stream: false
    });
    const request = (url: string) => fetch(`${url.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body
    });
    let response = await request(status.url);
    let raw = await response.text();
    if (
      response.status === 400 &&
      /model\s+['"][^'"]+['"]\s+not found/i.test(raw) &&
      status.managed
    ) {
      status = await ensureLocalLlama(settings, true);
      if (!status.online || !status.router) {
        throw new Error(status.error || "The local model router could not be restarted.");
      }
      response = await request(status.url);
      raw = await response.text();
    }
    const elapsedMs = performance.now() - startedAt;
    let payload: {
      error?: { message?: string } | string;
      timings?: {
        predicted_per_second?: number;
        predicted_n?: number;
        predicted_ms?: number;
      };
      usage?: { completion_tokens?: number };
    } = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      if (!response.ok) throw new Error(`llama-server returned HTTP ${response.status}: ${raw.slice(0, 240)}`);
    }
    if (!response.ok) {
      const detail = typeof payload.error === "string" ? payload.error : payload.error?.message;
      throw new Error(detail || `llama-server returned HTTP ${response.status}.`);
    }

    const directSpeed = Number(payload.timings?.predicted_per_second);
    const timingTokens = Number(payload.timings?.predicted_n);
    const timingDuration = Number(payload.timings?.predicted_ms);
    const completionTokens = Number(payload.usage?.completion_tokens);
    const hasDirectSpeed = Number.isFinite(directSpeed) && directSpeed > 0;
    const tokens = Number.isFinite(timingTokens) && timingTokens > 0
      ? timingTokens
      : completionTokens;
    const durationMs = Number.isFinite(timingDuration) && timingDuration > 0
      ? timingDuration
      : elapsedMs;
    const tokensPerSecond = hasDirectSpeed
      ? directSpeed
      : Number.isFinite(tokens) && tokens > 0 && elapsedMs > 0
        ? tokens / (elapsedMs / 1000)
        : 0;
    if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) {
      throw new Error("llama-server did not return generation timing or completion token usage.");
    }
    return {
      model,
      tokensPerSecond,
      tokens: Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0,
      durationMs: Math.round(durationMs),
      source: hasDirectSpeed ? "llama.cpp" : "measured"
    };
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") {
      throw new Error("Speed test timed out after 120 seconds.");
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

async function llamaServerBinary(): Promise<string | null> {
  const executable = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  const candidates = [
    process.env.LLAMA_SERVER_BIN,
    process.platform === "darwin" ? "/opt/homebrew/bin/llama-server" : undefined,
    process.platform !== "win32" ? "/usr/local/bin/llama-server" : undefined,
    process.platform !== "win32" ? "/usr/bin/llama-server" : undefined,
    process.platform !== "win32" ? join(homedir(), ".local", "bin", "llama-server") : undefined,
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "Programs", "llama.cpp", executable)
      : undefined,
    process.platform === "win32" && process.env.PROGRAMFILES
      ? join(process.env.PROGRAMFILES, "llama.cpp", executable)
      : undefined,
    process.platform === "win32"
      ? join(homedir(), "scoop", "apps", "llama.cpp", "current", executable)
      : undefined,
    process.platform === "win32"
      ? join("C:\\", "ProgramData", "chocolatey", "bin", executable)
      : undefined
  ].filter((candidate): candidate is string => Boolean(candidate));
  try {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const { stdout } = await execFileAsync(locator, [executable], { timeout: 2500 });
    candidates.unshift(...stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  } catch {
    // Common install locations below still support GUI launches with a minimal PATH.
  }
  return [...new Set(candidates)].find((candidate) => {
    try {
      return existsSync(candidate) && statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) || null;
}

async function terminateManagedListener(port: number): Promise<void> {
  if (
    managedRouterProcess &&
    managedRouterPort === port &&
    managedRouterProcess.pid &&
    !managedRouterProcess.killed
  ) {
    const child = managedRouterProcess;
    child.stdin?.end();
    child.kill("SIGTERM");
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!(await fetchJson(`http://127.0.0.1:${port}/health`, 250))) return;
    }
  }
  const listener = await healthyListener(port);
  if (!listener) {
    if (await fetchJson(`http://127.0.0.1:${port}/health`, 500)) {
      throw new Error(
        `A llama-server is running on port ${port}, but Lumen cannot identify its process. Stop it before restarting.`
      );
    }
    return;
  }
  try {
    process.kill(listener.pid, "SIGTERM");
  } catch (cause) {
    throw new Error(`Unable to stop llama-server pid ${listener.pid}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!(await healthyListener(port))) return;
  }
  try {
    process.kill(listener.pid, "SIGKILL");
  } catch {
    // The process may have exited between the final probe and kill.
  }
}

function routerArgs(modelsDir: string, port: number): string[] {
  return [
    "--models-dir",
    modelsDir,
    "--models-max",
    "1",
    "--models-autoload",
    "-ngl",
    "999",
    "-c",
    "16384",
    "-np",
    "1",
    "-b",
    "2048",
    "-ub",
    "2048",
    "-t",
    "5",
    "-fa",
    "on",
    "-ctk",
    "q4_0",
    "-ctv",
    "q4_0",
    "--jinja",
    "--reasoning-format",
    "auto",
    "--host",
    "127.0.0.1",
    "--port",
    String(port)
  ];
}

export async function startLocalLlama(settings: Settings, restart = false): Promise<void> {
  const found = discoverLocal(settings.modelsDir || DEFAULT_DIR);
  if (!found.ggufs.length) {
    throw new Error(`No usable GGUF model was found under ${settings.modelsDir || DEFAULT_DIR}.`);
  }
  const endpoint = await resolveLocalEndpoint(settings, true);
  if (restart && endpoint.port) await terminateManagedListener(endpoint.port);
  if (!restart && endpoint.port && await fetchJson(`http://127.0.0.1:${endpoint.port}/health`, 900)) {
    return;
  }
  const binary = await llamaServerBinary();
  if (!binary) {
    throw new Error(
      process.platform === "win32"
        ? "llama-server.exe was not found. Install llama.cpp and add it to PATH."
        : "llama-server was not found. Install llama.cpp and add it to PATH."
    );
  }

  const logDir = join(app.getPath("userData"), "runtime");
  mkdirSync(logDir, { recursive: true });
  const logFd = openSync(join(logDir, "llama-server.log"), "a");
  const child = spawn(binary, routerArgs(settings.modelsDir || DEFAULT_DIR, endpoint.port), {
    env: process.env,
    windowsHide: true,
    stdio: ["pipe", logFd, logFd]
  });
  closeSync(logFd);
  managedRouterProcess = child;
  managedRouterPort = endpoint.port;
  child.once("error", () => {
    if (managedRouterProcess === child) {
      managedRouterProcess = null;
      managedRouterPort = 0;
    }
  });
  child.once("exit", () => {
    if (managedRouterProcess === child) {
      managedRouterProcess = null;
      managedRouterPort = 0;
    }
  });
}

export async function ensureLocalLlama(settings: Settings, restart = false): Promise<LlamaStatus> {
  let status = await probeLlama(settings);
  // A custom remote OpenAI-compatible endpoint must never trigger or restart
  // the local llama-server process.
  if (!isManagedLocalLlamaUrl(settings.llamaUrl || LOOPBACK_URL)) return status;
  const needStart = !status.online || !status.router || restart;
  if (!needStart) return status;
  await startLocalLlama(settings, status.online || restart);
  const port = configuredPort(settings) || status.port;
  const liveSettings = port ? { ...settings, llamaPort: port, llamaUrl: urlForPort(port) } : settings;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    status = await probeLlama(liveSettings);
    if (status.online && status.router) break;
  }
  return status;
}

export async function stopLocalLlama(settings: Settings): Promise<LlamaStatus> {
  const port = configuredPort(settings) || managedRouterPort;
  if (port && managedRouterProcess && managedRouterPort === port) {
    await terminateManagedListener(port);
    return probeLlama(settings);
  }
  const listener = port
    ? await healthyListener(port)
    : await healthyListener(0, true);
  if (!listener) return probeLlama(settings);
  await terminateManagedListener(listener.port);
  if (managedRouterProcess?.pid === listener.pid) managedRouterProcess.stdin?.end();
  return probeLlama(settings);
}

export function shutdownLocalLlamaRuntime(): void {
  const child = managedRouterProcess;
  managedRouterProcess = null;
  managedRouterPort = 0;
  if (!child || child.killed) return;
  child.stdin?.end();
  child.kill("SIGTERM");
}
