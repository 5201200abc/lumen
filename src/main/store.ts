import Store from "electron-store";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Effort, FontSize, Language, Settings, Theme } from "@shared/types";
import { decryptLocalSecret, encryptLocalSecret } from "./local-secret";

const DEFAULT_MODELS_DIR = join(homedir(), "models");
const LOCAL_ENV = join(DEFAULT_MODELS_DIR, "websearch", ".env");
export const SYSTEM_PROMPT_PATH = join(homedir(), ".config", "llama", "LLAMA.md");

type Disk = {
  llamaUrl: string;
  llamaApiKeyEnc: string;
  model: string;
  tavilyApiKeyEnc: string;
  defaultEffort: Effort | "light" | "high";
  memoryEnabled: boolean;
  theme: Theme;
  modelsDir: string;
  chatInstructions: string;
  coworkInstructions: string;
  googleClientId: string;
  language: Language;
  fontSize: FontSize;
  modelCatalog: string[];
  llamaEndpoints: Array<{ id: string; name: string; url: string }>;
};

const store = new Store<Disk>({
  name: "settings",
  defaults: {
    llamaUrl: "http://127.0.0.1:18082/v1",
    llamaApiKeyEnc: "",
    model: "Qwen3.8-27B",
    tavilyApiKeyEnc: "",
    defaultEffort: "xhigh",
    memoryEnabled: true,
    theme: "system",
    modelsDir: DEFAULT_MODELS_DIR,
    chatInstructions: "",
    coworkInstructions: "",
    googleClientId: "",
    language: "en",
    fontSize: "small",
    modelCatalog: ["Qwen3.8-27B"],
    llamaEndpoints: [{ id: "local", name: "Local llama", url: "http://127.0.0.1:18082/v1" }]
  }
});

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
  // Preserve existing local preferences while migrating to Qwen3.8 names.
  if (value === "low" || value === "light") return "low";
  if (value === "xhigh" || value === "high") return "xhigh";
  return "medium";
}

export function getSettings(): Settings {
  seedTavily();
  const activeUrl = store.get("llamaUrl");
  const endpoints = store.get("llamaEndpoints") || [];
  const normalizedEndpoints = endpoints.some((endpoint) => endpoint.url === activeUrl)
    ? endpoints
    : [{ id: "active", name: "Current Llama", url: activeUrl }, ...endpoints];
  return {
    llamaUrl: activeUrl,
    llamaApiKey: decryptLocalSecret(store.get("llamaApiKeyEnc")),
    model: store.get("model"),
    tavilyApiKey: decryptLocalSecret(store.get("tavilyApiKeyEnc")),
    defaultEffort: normalizeEffort(store.get("defaultEffort")),
    memoryEnabled: store.get("memoryEnabled"),
    theme: store.get("theme"),
    modelsDir: store.get("modelsDir") || DEFAULT_MODELS_DIR,
    systemPrompt: readSystemPrompt(),
    systemPromptPath: SYSTEM_PROMPT_PATH,
    chatInstructions: store.get("chatInstructions"),
    coworkInstructions: store.get("coworkInstructions"),
    language: store.get("language") || "en",
    fontSize: store.get("fontSize") || "small",
    modelCatalog: [...new Set([...(store.get("modelCatalog") || []), store.get("model")].filter(Boolean))],
    llamaEndpoints: normalizedEndpoints
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
  if (patch.chatInstructions !== undefined && patch.chatInstructions.length > 20_000) {
    throw new Error("Chat custom instructions cannot exceed 20,000 characters.");
  }
  if (patch.coworkInstructions !== undefined && patch.coworkInstructions.length > 20_000) {
    throw new Error("Cowork custom instructions cannot exceed 20,000 characters.");
  }
  if (patch.systemPrompt !== undefined && patch.systemPrompt.length > 100_000) {
    throw new Error("Model rule style cannot exceed 100,000 characters.");
  }
  if (
    patch.defaultEffort !== undefined &&
    !["low", "medium", "xhigh"].includes(patch.defaultEffort)
  ) {
    throw new Error("Default effort must be low, medium, or xhigh.");
  }
  if (patch.theme !== undefined && !["system", "light", "dark"].includes(patch.theme)) {
    throw new Error("Theme must be system, light, or dark.");
  }
  if (patch.language !== undefined && !["en", "zh"].includes(patch.language)) {
    throw new Error("Language must be English or Chinese.");
  }
  if (patch.fontSize !== undefined && !["small", "medium", "large"].includes(patch.fontSize)) {
    throw new Error("Font size must be small, medium, or large.");
  }
  if (patch.modelCatalog !== undefined) {
    if (!Array.isArray(patch.modelCatalog) || patch.modelCatalog.length > 50) {
      throw new Error("Model list must contain no more than 50 models.");
    }
    if (patch.modelCatalog.some((model) => typeof model !== "string" || !model.trim() || model.length > 200)) {
      throw new Error("Every model must have a valid name.");
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

  if (patch.llamaUrl !== undefined) store.set("llamaUrl", patch.llamaUrl.trim());
  if (patch.model !== undefined) store.set("model", patch.model.trim());
  if (patch.defaultEffort !== undefined) store.set("defaultEffort", normalizeEffort(patch.defaultEffort));
  if (patch.memoryEnabled !== undefined) store.set("memoryEnabled", patch.memoryEnabled);
  if (patch.theme !== undefined) store.set("theme", patch.theme);
  if (patch.language !== undefined) store.set("language", patch.language);
  if (patch.fontSize !== undefined) store.set("fontSize", patch.fontSize);
  if (patch.modelCatalog !== undefined) store.set("modelCatalog", [...new Set(patch.modelCatalog.map((model) => model.trim()))]);
  if (patch.llamaEndpoints !== undefined) {
    store.set("llamaEndpoints", patch.llamaEndpoints.map((endpoint) => ({
      id: endpoint.id,
      name: endpoint.name.trim(),
      url: endpoint.url.trim()
    })));
  }
  if (patch.modelsDir !== undefined) store.set("modelsDir", patch.modelsDir.trim());
  if (patch.chatInstructions !== undefined) store.set("chatInstructions", patch.chatInstructions);
  if (patch.coworkInstructions !== undefined) store.set("coworkInstructions", patch.coworkInstructions);
  if (patch.llamaApiKey !== undefined) store.set("llamaApiKeyEnc", encryptLocalSecret(patch.llamaApiKey.trim()));
  if (patch.tavilyApiKey !== undefined) store.set("tavilyApiKeyEnc", encryptLocalSecret(patch.tavilyApiKey.trim()));
  if (patch.systemPrompt !== undefined) writeSystemPrompt(patch.systemPrompt);
  return getSettings();
}
