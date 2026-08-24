import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { LlamaStatus, Settings } from "@shared/types";

const DEFAULT_DIR = join(homedir(), "models");
const DEFAULT_URL = "http://127.0.0.1:18082/v1";
export const VISION_MMPROJ = join(
  DEFAULT_DIR,
  "Qwen3.8-27B",
  "mmproj-Qwen3.8-27B-Uncensored-f16.gguf"
);

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
    else if (name.endsWith(".gguf")) acc.push(full);
  }
  return acc;
}

export function discoverLocal(modelsDir = DEFAULT_DIR): {
  ggufs: string[];
  mmproj: string | null;
  startScript: string | null;
} {
  const dir = modelsDir || DEFAULT_DIR;
  const ggufs = walkGgufs(dir);
  const preferred = existsSync(VISION_MMPROJ) ? VISION_MMPROJ : null;
  const mmproj =
    preferred ||
    ggufs.find((p) => /mmproj-Qwen3\.8-27B-Uncensored-f16\.gguf$/i.test(p)) ||
    ggufs.find((p) => /mmproj/i.test(p.split("/").pop() || "")) ||
    null;
  const start = join(dir, "start-llama.sh");
  return {
    ggufs: ggufs.filter((p) => !/mmproj/i.test(p.split("/").pop() || "")),
    mmproj: mmproj && existsSync(mmproj) ? mmproj : null,
    startScript: existsSync(start) ? start : null
  };
}

function origin(url: string): string {
  return url.replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

export function isManagedLocalLlamaUrl(url: string): boolean {
  try {
    const parsed = new URL(url || DEFAULT_URL);
    return (
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1") &&
      (parsed.port === "" || parsed.port === "18082")
    );
  } catch {
    return false;
  }
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
  const url = settings.llamaUrl || DEFAULT_URL;
  const found = discoverLocal(settings.modelsDir || DEFAULT_DIR);
  const base = origin(url);
  const health = await fetchJson(`${base}/health`);
  const models = (await fetchJson(`${base}/v1/models`)) as
    | { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> }
    | null;
  const props = (await fetchJson(`${base}/props`)) as
    | { modalities?: { vision?: boolean }; model_alias?: string }
    | null;
  const online = Boolean(health);
  const remoteModel =
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
  return {
    online,
    model: remoteModel || settings.model,
    vision: Boolean(props?.modalities?.vision),
    url,
    modelsDir: settings.modelsDir || DEFAULT_DIR,
    ggufs: found.ggufs,
    models: unique,
    mmproj: found.mmproj,
    error: online ? undefined : "llama-server 未连接"
  };
}

export function startLocalLlama(settings: Settings, mmproj?: string | null): void {
  const found = discoverLocal(settings.modelsDir || DEFAULT_DIR);
  const script = found.startScript;
  const env = {
    ...process.env,
    HOME: homedir(),
    LLAMA_HOST: "127.0.0.1",
    LLAMA_PORT: "18082",
    LLAMA_ALIAS: settings.model || "Qwen3.8-27B"
  } as NodeJS.ProcessEnv;
  const projector = mmproj || found.mmproj || (existsSync(VISION_MMPROJ) ? VISION_MMPROJ : "");
  if (projector) env.LLAMA_MMPROJ = projector;
  if (found.ggufs[0]) env.LLAMA_MODEL = found.ggufs[0];
  if (script) {
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", script], { env, detached: true, stdio: "ignore" }).unref();
    } else {
      const shellBin = process.env.SHELL || "/bin/sh";
      spawn(shellBin, [script], { env, detached: true, stdio: "ignore" }).unref();
    }
    return;
  }
  const model = found.ggufs[0];
  if (!model) return;
  const args = [
    "-m",
    model,
    "-a",
    settings.model || "Qwen3.8-27B",
    "-ngl",
    "999",
    "-c",
    "8192",
    "-np",
    "1",
    "--jinja",
    "--reasoning",
    "auto",
    "--reasoning-effort",
    "default",
    "--reasoning-preserve",
    "--reasoning-format",
    "auto",
    "--host",
    "127.0.0.1",
    "--port",
    "18082"
  ];
  if (env.LLAMA_MMPROJ) args.push("--mmproj", env.LLAMA_MMPROJ);
  spawn("llama-server", args, { env, detached: true, stdio: "ignore" }).unref();
}

export async function ensureLocalLlama(settings: Settings, restart = false): Promise<LlamaStatus> {
  const found = discoverLocal(settings.modelsDir || DEFAULT_DIR);
  let status = await probeLlama(settings);
  // A custom remote OpenAI-compatible endpoint must never trigger or restart
  // the local llama-server process.
  if (!isManagedLocalLlamaUrl(settings.llamaUrl || DEFAULT_URL)) return status;
  const needStart = !status.online || restart || (!status.vision && Boolean(found.mmproj));
  if (!needStart) return status;
  startLocalLlama(settings, found.mmproj);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    status = await probeLlama(settings);
    if (status.online && (!found.mmproj || status.vision || i > 8)) break;
  }
  return status;
}

export function nearestMmproj(modelPath: string, mmproj: string | null): string | null {
  if (!mmproj) return null;
  const dir = dirname(modelPath);
  if (mmproj.startsWith(dir)) return mmproj;
  return mmproj;
}
