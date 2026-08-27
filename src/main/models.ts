import { existsSync, readdirSync, statSync } from "node:fs";
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

function walkGgufs(root: string, depth = 0, acc: string[] = []): string[] {
  if (depth > 3 || !existsSync(root)) return acc;
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

export function discoverLocal(modelsDir = DEFAULT_DIR): {
  ggufs: string[];
  models: LocalModel[];
} {
  const dir = modelsDir || DEFAULT_DIR;
  const ggufs = walkGgufs(dir).sort((a, b) => a.localeCompare(b));
  const modelFiles = ggufs.filter((p) => !/mmproj/i.test(basename(p)));
  const discoveredModels = modelFiles.map((path) => {
    const parent = dirname(path);
    const relativeParent = relative(dir, parent);
    const name = relativeParent && relativeParent !== "."
      ? relativeParent.split(/[\\/]/)[0]
      : basename(path)
          .replace(/\.gguf$/i, "")
          .replace(/[-_.](?:uncensored[-_.])?(?:q\d(?:_[a-z0-9]+)?|iq\d(?:_[a-z0-9]+)?|f16|bf16)$/i, "");
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

function bundledRuntimeScript(): string | null {
  const name = process.platform === "win32" ? "start-llama.ps1" : "start-llama.sh";
  const candidates = [
    join(process.resourcesPath, "runtime", name),
    join(app.getAppPath(), "resources", "runtime", name)
  ];
  return candidates.find((candidate) => existsSync(candidate)) || null;
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

async function healthyListener(preferredPort = 0): Promise<LlamaListener | null> {
  const listeners = await processListeners();
  listeners.sort((a, b) =>
    Number(b.port === preferredPort) - Number(a.port === preferredPort) || a.port - b.port
  );
  for (const listener of listeners) {
    if (await fetchJson(`http://127.0.0.1:${listener.port}/health`, 900)) return listener;
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
  const listener = await healthyListener(preferred);
  if (listener) {
    setDetectedLlamaPort(listener.port);
    return { url: urlForPort(listener.port), port: listener.port, pid: listener.pid };
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

  const status = await probeLlama(settings);
  if (!status.online) throw new Error(status.error || "llama-server is not running.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  const startedAt = performance.now();
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (settings.llamaApiKey) headers.Authorization = `Bearer ${settings.llamaApiKey}`;
    const response = await fetch(`${settings.llamaUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
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
      })
    });
    const elapsedMs = performance.now() - startedAt;
    const raw = await response.text();
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

export async function startLocalLlama(settings: Settings, restart = false): Promise<void> {
  const found = discoverLocal(settings.modelsDir || DEFAULT_DIR);
  const endpoint = await resolveLocalEndpoint(settings, true);
  const script = bundledRuntimeScript();
  const env = {
    ...process.env,
    LLAMA_HOST: "127.0.0.1",
    LLAMA_PORT: String(endpoint.port),
    LLAMA_CTX: "16384",
    LLAMA_PARALLEL: "1",
    LLAMA_MODELS_DIR: settings.modelsDir || DEFAULT_DIR,
    LLAMA_MODELS_MAX: "1",
    LLAMA_LOG_DIR: join(app.getPath("userData"), "runtime"),
    LUMEN_RESTART: restart ? "1" : "0"
  } as NodeJS.ProcessEnv;
  if (script) {
    if (process.platform === "win32") {
      spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
        { env, detached: true, stdio: "ignore" }
      ).unref();
    } else {
      spawn("/bin/sh", [script], { env, detached: true, stdio: "ignore" }).unref();
    }
    return;
  }
  if (!found.ggufs.length) return;
  // Fallback remains router-only. Lumen never starts llama-server with -m.
  const args = [
    "--models-dir",
    settings.modelsDir || DEFAULT_DIR,
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
    String(endpoint.port)
  ];
  spawn("llama-server", args, { env, detached: true, stdio: "ignore" }).unref();
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
  const listener = await healthyListener(configuredPort(settings));
  if (!listener) return probeLlama(settings);
  try {
    process.kill(listener.pid, "SIGTERM");
  } catch (cause) {
    throw new Error(`Unable to stop llama-server pid ${listener.pid}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!(await healthyListener(listener.port))) return probeLlama(settings);
  }
  throw new Error(`llama-server pid ${listener.pid} did not stop.`);
}
