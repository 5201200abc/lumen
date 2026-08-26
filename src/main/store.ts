import Store from "electron-store";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CoworkEngine, Effort, FontSize, Language, LlamaModel, ResearchExtractor, Settings, Theme } from "@shared/types";
import { detectReasoningControl } from "@shared/types";
import { decryptLocalSecret, encryptLocalSecret } from "./local-secret";

const DEFAULT_MODELS_DIR = join(homedir(), "models");
const LOCAL_ENV = join(DEFAULT_MODELS_DIR, "websearch", ".env");
export const SYSTEM_PROMPT_PATH = join(homedir(), ".config", "llama", "LLAMA.md");

type Disk = {
  llamaUrl: string;
  llamaPort: number;
  llamaAutoStart: boolean;
  llamaApiKeyEnc: string;
  llamaApiKeysEnc: string;
  model: string;
  tavilyApiKeyEnc: string;
  tavilyApiKeysEnc: string;
  firecrawlUrl: string;
  firecrawlApiKeyEnc: string;
  researchExtractor: ResearchExtractor;
  tavilyExtractDepth: "basic" | "advanced";
  defaultEffort: Effort | "light";
  memoryEnabled: boolean;
  theme: Theme;
  modelsDir: string;
  chatInstructions: string;
  coworkInstructions: string;
  coworkEngine: CoworkEngine;
  googleClientId: string;
  language: Language;
  fontSize: FontSize;
  modelCatalog: string[];
  llamaModels: LlamaModel[];
  llamaEndpoints: Array<{ id: string; name: string; url: string }>;
};

const store = new Store<Disk>({
  name: "settings",
  defaults: {
    llamaUrl: "http://127.0.0.1/v1",
    llamaPort: 0,
    llamaAutoStart: true,
    llamaApiKeyEnc: "",
    llamaApiKeysEnc: "",
    model: "Qwen3.8-27B",
    tavilyApiKeyEnc: "",
    tavilyApiKeysEnc: "",
    firecrawlUrl: "http://127.0.0.1:3002",
    firecrawlApiKeyEnc: "",
    researchExtractor: "tavily",
    tavilyExtractDepth: "advanced",
    defaultEffort: "xhigh",
    memoryEnabled: true,
    theme: "system",
    modelsDir: DEFAULT_MODELS_DIR,
    chatInstructions: "",
    coworkInstructions: "",
    coworkEngine: "claude-code",
    googleClientId: "",
    language: "en",
    fontSize: "small",
    modelCatalog: ["Qwen3.8-27B"],
    llamaModels: [],
    llamaEndpoints: [{ id: "local", name: "Current model", url: "http://127.0.0.1/v1" }]
  }
});

function localLlamaUrl(port: number): string {
  return port > 0 ? `http://127.0.0.1:${port}/v1` : "http://127.0.0.1/v1";
}

function portFromUrl(value: string): number {
  try {
    const parsed = new URL(value);
    if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) return 0;
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
  } catch {
    return 0;
  }
}

export function setDetectedLlamaPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  const url = localLlamaUrl(port);
  store.set("llamaPort", port);
  store.set("llamaUrl", url);
  const endpoints = store.get("llamaEndpoints") || [];
  const local = endpoints.find((endpoint) => endpoint.id === "local");
  store.set("llamaEndpoints", [
    { id: "local", name: "Current model", url },
    ...endpoints.filter((endpoint) => endpoint.id !== "local" && endpoint.id !== local?.id)
  ]);
}

function seedTavily(): void {
  if (decryptLocalSecret(store.get("tavilyApiKeyEnc"))) return;
  if (!existsSync(LOCAL_ENV)) return;
  const text = readFileSync(LOCAL_ENV, "utf8");
  const match = text.match(/^\s*TAVILY_API_KEY\s*=\s*(.+)\s*$/m);
  const key = match?.[1]?.trim();
  if (key) store.set("tavilyApiKeyEnc", encryptLocalSecret(key));
}

export function readSystemPrompt(): string {
  if (!existsSync(SYSTEM_PROMPT_PATH)) return "";
  return readFileSync(SYSTEM_PROMPT_PATH, "utf8");
}

export function writeSystemPrompt(text: string): void {
  mkdirSync(dirname(SYSTEM_PROMPT_PATH), { recursive: true });
  writeFileSync(SYSTEM_PROMPT_PATH, text, "utf8");
}

function normalizeEffort(value: string | undefined): Effort {
  if (value === "low" || value === "light") return "low";
  if (value === "high" || value === "xhigh") return value;
  return "medium";
}

function normalizeFontSize(value: unknown): FontSize {
  if (value === "small" || value === 13 || value === "13") return 13;
  if (value === 14 || value === "14") return 14;
  if (value === "medium" || value === 15 || value === "15") return 15;
  if (value === "large" || value === 16 || value === "16") return 16;
  const parsed = parseInt(String(value), 10);
  if (!isNaN(parsed) && parsed >= 13 && parsed <= 16) return parsed as FontSize;
  return 13;
}

export function getSettings(): Settings {
  seedTavily();
  if (/api\.firecrawl\.dev/i.test(store.get("firecrawlUrl") || "")) {
    store.set("firecrawlUrl", "http://127.0.0.1:3002");
    store.set("firecrawlApiKeyEnc", "");
  }
  const storedUrl = store.get("llamaUrl");
  const storedPort = store.get("llamaPort") || portFromUrl(storedUrl);
  if (storedPort && storedPort !== store.get("llamaPort")) store.set("llamaPort", storedPort);
  const activeUrl = storedPort ? localLlamaUrl(storedPort) : storedUrl;
  if (activeUrl !== storedUrl) store.set("llamaUrl", activeUrl);
  const storedEndpoints = store.get("llamaEndpoints") || [];
  let normalizedEndpoints = storedEndpoints.map((endpoint) =>
    endpoint.name.trim().toLowerCase() === "local llama"
      ? { ...endpoint, name: "Current model" }
      : endpoint
  );
  const localUrl = localLlamaUrl(storedPort);
  normalizedEndpoints = [
    { id: "local", name: "Current model", url: localUrl },
    ...normalizedEndpoints.filter((endpoint) => endpoint.id !== "local")
  ];
  if (!normalizedEndpoints.some((endpoint) => endpoint.url === activeUrl)) {
    normalizedEndpoints = [{ id: "active", name: "Current model", url: activeUrl }, ...normalizedEndpoints];
  }
  if (JSON.stringify(normalizedEndpoints) !== JSON.stringify(storedEndpoints)) {
    store.set("llamaEndpoints", normalizedEndpoints);
  }
  const catalog = [...new Set([...(store.get("modelCatalog") || []), store.get("model")].filter(Boolean))];
  const storedModels = store.get("llamaModels") || [];
  const activeEndpoint = normalizedEndpoints.find((endpoint) => endpoint.url === activeUrl) || normalizedEndpoints[0];
  const llamaModels = storedModels.length
    ? storedModels
    : catalog.map((name, index) => ({
        id: index === 0 ? "default-model" : `legacy-model-${index}`,
        name,
        endpointId: activeEndpoint?.id || "local",
        reasoningControl: detectReasoningControl(name)
      }));

  const activeTavilyKey = decryptLocalSecret(store.get("tavilyApiKeyEnc"));
  const rawTavilyKeys = decryptLocalSecret(store.get("tavilyApiKeysEnc"));
  let tavilyApiKeys: Array<{ id: string; name: string; key: string }> = [];
  try {
    if (rawTavilyKeys) tavilyApiKeys = JSON.parse(rawTavilyKeys);
  } catch {}
  if (activeTavilyKey && !tavilyApiKeys.some((k) => k.key === activeTavilyKey)) {
    tavilyApiKeys = [{ id: "default-tavily", name: "Default Key", key: activeTavilyKey }, ...tavilyApiKeys];
  }

  const activeLlamaKey = decryptLocalSecret(store.get("llamaApiKeyEnc"));
  const rawLlamaKeys = decryptLocalSecret(store.get("llamaApiKeysEnc"));
  let llamaApiKeys: Array<{ id: string; name: string; key: string }> = [];
  try {
    if (rawLlamaKeys) llamaApiKeys = JSON.parse(rawLlamaKeys);
  } catch {}
  if (activeLlamaKey && !llamaApiKeys.some((k) => k.key === activeLlamaKey)) {
    llamaApiKeys = [{ id: "default-llama", name: "Default Key", key: activeLlamaKey }, ...llamaApiKeys];
  }

  return {
    llamaUrl: activeUrl,
    llamaPort: storedPort,
    llamaAutoStart: store.get("llamaAutoStart"),
    llamaApiKey: activeLlamaKey,
    model: store.get("model"),
    tavilyApiKey: activeTavilyKey,
    firecrawlUrl: store.get("firecrawlUrl") || "http://127.0.0.1:3002",
    firecrawlApiKey: decryptLocalSecret(store.get("firecrawlApiKeyEnc")),
    researchExtractor: store.get("researchExtractor") || "tavily",
    tavilyExtractDepth: store.get("tavilyExtractDepth") || "advanced",
    defaultEffort: normalizeEffort(store.get("defaultEffort")),
    memoryEnabled: store.get("memoryEnabled"),
    theme: store.get("theme"),
    modelsDir: store.get("modelsDir") || DEFAULT_MODELS_DIR,
    systemPrompt: readSystemPrompt(),
    systemPromptPath: SYSTEM_PROMPT_PATH,
    chatInstructions: store.get("chatInstructions"),
    coworkInstructions: store.get("coworkInstructions"),
    coworkEngine: store.get("coworkEngine") || "claude-code",
    language: store.get("language") || "en",
    fontSize: normalizeFontSize(store.get("fontSize")),
    modelCatalog: catalog,
    llamaModels,
    llamaEndpoints: normalizedEndpoints,
    tavilyApiKeys,
    llamaApiKeys
  };
}

export function getLegacyGoogleClientId(): string {
  return store.get("googleClientId");
}

export function setSettings(patch: Partial<Settings>): Settings {
  if (patch.llamaUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(patch.llamaUrl.trim());
    } catch {
      throw new Error("Llama API URL must be a valid http or https URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Llama API URL must use http or https.");
    }
  }
  if (patch.model !== undefined && !patch.model.trim()) {
    throw new Error("Model cannot be empty.");
  }
  if (patch.model !== undefined && patch.model.length > 200) {
    throw new Error("Model name is too long.");
  }
  if (
    patch.llamaPort !== undefined &&
    (!Number.isInteger(patch.llamaPort) || patch.llamaPort < 0 || patch.llamaPort > 65535)
  ) {
    throw new Error("Llama port must be 0 (automatic) or between 1 and 65535.");
  }
  if (patch.researchExtractor !== undefined && !["tavily", "firecrawl"].includes(patch.researchExtractor)) {
    throw new Error("Web Research extractor must be Tavily or Firecrawl.");
  }
  if (patch.tavilyExtractDepth !== undefined && !["basic", "advanced"].includes(patch.tavilyExtractDepth)) {
    throw new Error("Tavily Extract depth must be basic or advanced.");
  }
  if (patch.firecrawlUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(patch.firecrawlUrl.trim());
    } catch {
      throw new Error("Firecrawl API URL must be a valid http or https URL.");
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Firecrawl API URL must use http or https.");
    }
    if (url.hostname === "api.firecrawl.dev") {
      throw new Error("Web Research reserves Firecrawl for self-hosted endpoints; use Tavily for cloud extraction.");
    }
  }
  if (patch.chatInstructions !== undefined && patch.chatInstructions.length > 20_000) {
    throw new Error("Chat custom instructions cannot exceed 20,000 characters.");
  }
  if (patch.coworkInstructions !== undefined && patch.coworkInstructions.length > 20_000) {
    throw new Error("Cowork custom instructions cannot exceed 20,000 characters.");
  }
  if (patch.coworkEngine !== undefined && !["claude-code", "codex"].includes(patch.coworkEngine)) {
    throw new Error("Cowork engine must be claude-code or codex.");
  }
  if (patch.systemPrompt !== undefined && patch.systemPrompt.length > 100_000) {
    throw new Error("Model rule style cannot exceed 100,000 characters.");
  }
  if (
    patch.defaultEffort !== undefined &&
    !["low", "medium", "high", "xhigh"].includes(patch.defaultEffort)
  ) {
    throw new Error("Default effort must be low, medium, high, or xhigh.");
  }
  if (patch.theme !== undefined && !["system", "light", "dark"].includes(patch.theme)) {
    throw new Error("Theme must be system, light, or dark.");
  }
  if (patch.language !== undefined && !["en", "zh"].includes(patch.language)) {
    throw new Error("Language must be English or Chinese.");
  }
  if (patch.fontSize !== undefined) {
    const validSizes = [13, 14, 15, 16, "13", "14", "15", "16", "small", "medium", "large"];
    if (!validSizes.includes(patch.fontSize as any)) {
      throw new Error("Font size must be between 13 and 16.");
    }
  }
  if (patch.modelCatalog !== undefined) {
    if (!Array.isArray(patch.modelCatalog) || patch.modelCatalog.length > 50) {
      throw new Error("Model list must contain no more than 50 models.");
    }
    if (patch.modelCatalog.some((model) => typeof model !== "string" || !model.trim() || model.length > 200)) {
      throw new Error("Every model must have a valid name.");
    }
  }
  if (patch.llamaModels !== undefined) {
    if (!Array.isArray(patch.llamaModels) || patch.llamaModels.length > 100) {
      throw new Error("Model list must contain no more than 100 models.");
    }
    const endpointIds = new Set((patch.llamaEndpoints || getSettings().llamaEndpoints).map((endpoint) => endpoint.id));
    for (const model of patch.llamaModels) {
      if (
        !model ||
        typeof model.id !== "string" ||
        typeof model.name !== "string" ||
        !model.name.trim() ||
        model.name.length > 200 ||
        !endpointIds.has(model.endpointId) ||
        !["effort", "toggle", "none"].includes(model.reasoningControl) ||
        (model.reasoningEfforts !== undefined &&
          (!Array.isArray(model.reasoningEfforts) ||
            model.reasoningEfforts.some((effort) => !["low", "medium", "high", "xhigh"].includes(effort))))
      ) {
        throw new Error("Every model must have a valid name, Llama server, and reasoning control.");
      }
    }
  }
  if (patch.llamaEndpoints !== undefined) {
    if (!Array.isArray(patch.llamaEndpoints) || patch.llamaEndpoints.length > 20) {
      throw new Error("Llama list must contain no more than 20 endpoints.");
    }
    for (const endpoint of patch.llamaEndpoints) {
      if (!endpoint || typeof endpoint.id !== "string" || typeof endpoint.name !== "string" || typeof endpoint.url !== "string") {
        throw new Error("Every Llama endpoint must have an id, name, and URL.");
      }
      const url = new URL(endpoint.url.trim());
      if (!["http:", "https:"].includes(url.protocol) || !endpoint.name.trim()) {
        throw new Error("Every Llama endpoint must have a valid name and http or https URL.");
      }
    }
  }

  if (patch.tavilyApiKeys !== undefined) {
    if (!Array.isArray(patch.tavilyApiKeys) || patch.tavilyApiKeys.length > 50) {
      throw new Error("Tavily API list must contain no more than 50 entries.");
    }
    for (const item of patch.tavilyApiKeys) {
      if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.key !== "string") {
        throw new Error("Every Tavily key must have an id, name, and key string.");
      }
    }
  }

  if (patch.llamaApiKeys !== undefined) {
    if (!Array.isArray(patch.llamaApiKeys) || patch.llamaApiKeys.length > 50) {
      throw new Error("Llama API key list must contain no more than 50 keys.");
    }
    for (const item of patch.llamaApiKeys) {
      if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.key !== "string") {
        throw new Error("Every Llama key must have an id, name, and key string.");
      }
    }
  }

  if (patch.llamaUrl !== undefined) store.set("llamaUrl", patch.llamaUrl.trim());
  if (patch.llamaPort !== undefined) {
    store.set("llamaPort", patch.llamaPort);
    store.set("llamaUrl", localLlamaUrl(patch.llamaPort));
  }
  if (patch.llamaAutoStart !== undefined) store.set("llamaAutoStart", patch.llamaAutoStart);
  if (patch.firecrawlUrl !== undefined) store.set("firecrawlUrl", patch.firecrawlUrl.trim().replace(/\/+$/, ""));
  if (patch.researchExtractor !== undefined) store.set("researchExtractor", patch.researchExtractor);
  if (patch.tavilyExtractDepth !== undefined) store.set("tavilyExtractDepth", patch.tavilyExtractDepth);
  if (patch.model !== undefined) store.set("model", patch.model.trim());
  if (patch.defaultEffort !== undefined) store.set("defaultEffort", normalizeEffort(patch.defaultEffort));
  if (patch.coworkEngine !== undefined) store.set("coworkEngine", patch.coworkEngine);
  if (patch.memoryEnabled !== undefined) store.set("memoryEnabled", patch.memoryEnabled);
  if (patch.theme !== undefined) store.set("theme", patch.theme);
  if (patch.language !== undefined) store.set("language", patch.language);
  if (patch.fontSize !== undefined) store.set("fontSize", normalizeFontSize(patch.fontSize));
  if (patch.modelCatalog !== undefined) store.set("modelCatalog", [...new Set(patch.modelCatalog.map((model) => model.trim()))]);
  if (patch.llamaModels !== undefined) {
    store.set("llamaModels", patch.llamaModels.map((model) => ({ ...model, name: model.name.trim() })));
    store.set("modelCatalog", [...new Set(patch.llamaModels.map((model) => model.name.trim()))]);
  }
  if (patch.llamaEndpoints !== undefined) {
    store.set("llamaEndpoints", patch.llamaEndpoints.map((endpoint) => ({
      id: endpoint.id,
      name: endpoint.name.trim(),
      url: endpoint.url.trim()
    })));
  }
  if (patch.tavilyApiKeys !== undefined) {
    const clean = patch.tavilyApiKeys.map((k) => ({
      id: k.id,
      name: k.name.trim() || "Tavily Key",
      key: k.key.trim()
    }));
    store.set("tavilyApiKeysEnc", encryptLocalSecret(JSON.stringify(clean)));
    if (patch.tavilyApiKey === undefined && clean.length > 0 && !clean.some((k) => k.key === getSettings().tavilyApiKey)) {
      store.set("tavilyApiKeyEnc", encryptLocalSecret(clean[0].key));
    }
  }
  if (patch.llamaApiKeys !== undefined) {
    const clean = patch.llamaApiKeys.map((k) => ({
      id: k.id,
      name: k.name.trim() || "Llama Key",
      key: k.key.trim()
    }));
    store.set("llamaApiKeysEnc", encryptLocalSecret(JSON.stringify(clean)));
    if (patch.llamaApiKey === undefined && clean.length > 0 && !clean.some((k) => k.key === getSettings().llamaApiKey)) {
      store.set("llamaApiKeyEnc", encryptLocalSecret(clean[0].key));
    }
  }
  if (patch.modelsDir !== undefined) store.set("modelsDir", patch.modelsDir.trim());
  if (patch.chatInstructions !== undefined) store.set("chatInstructions", patch.chatInstructions);
  if (patch.coworkInstructions !== undefined) store.set("coworkInstructions", patch.coworkInstructions);
  if (patch.llamaApiKey !== undefined) store.set("llamaApiKeyEnc", encryptLocalSecret(patch.llamaApiKey.trim()));
  if (patch.tavilyApiKey !== undefined) store.set("tavilyApiKeyEnc", encryptLocalSecret(patch.tavilyApiKey.trim()));
  if (patch.firecrawlApiKey !== undefined) store.set("firecrawlApiKeyEnc", encryptLocalSecret(patch.firecrawlApiKey.trim()));
  if (patch.systemPrompt !== undefined) writeSystemPrompt(patch.systemPrompt);
  return getSettings();
}
