import { safeStorage } from "electron";
import Store from "electron-store";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Effort, Settings, Theme } from "@shared/types";

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
    googleClientId: ""
  }
});

function encrypt(plain: string): string {
  if (!plain) return "";
  if (!safeStorage.isEncryptionAvailable()) return `plain:${plain}`;
  return safeStorage.encryptString(plain).toString("base64");
}

function decrypt(value: string): string {
  if (!value) return "";
  if (value.startsWith("plain:")) return value.slice(6);
  if (!safeStorage.isEncryptionAvailable()) return "";
  try {
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  } catch {
    return "";
  }
}

function seedTavily(): void {
  if (decrypt(store.get("tavilyApiKeyEnc"))) return;
  if (!existsSync(LOCAL_ENV)) return;
  const text = readFileSync(LOCAL_ENV, "utf8");
  const match = text.match(/^\s*TAVILY_API_KEY\s*=\s*(.+)\s*$/m);
  const key = match?.[1]?.trim();
  if (key) store.set("tavilyApiKeyEnc", encrypt(key));
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
  return {
    llamaUrl: store.get("llamaUrl"),
    llamaApiKey: decrypt(store.get("llamaApiKeyEnc")),
    model: store.get("model"),
    tavilyApiKey: decrypt(store.get("tavilyApiKeyEnc")),
    defaultEffort: normalizeEffort(store.get("defaultEffort")),
    memoryEnabled: store.get("memoryEnabled"),
    theme: store.get("theme"),
    modelsDir: store.get("modelsDir") || DEFAULT_MODELS_DIR,
    systemPrompt: readSystemPrompt(),
    systemPromptPath: SYSTEM_PROMPT_PATH,
    chatInstructions: store.get("chatInstructions"),
    coworkInstructions: store.get("coworkInstructions"),
    googleClientId: store.get("googleClientId")
  };
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
    patch.googleClientId !== undefined &&
    patch.googleClientId.trim() &&
    !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(patch.googleClientId.trim())
  ) {
    throw new Error("Google OAuth Client ID must end with .apps.googleusercontent.com.");
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

  if (patch.llamaUrl !== undefined) store.set("llamaUrl", patch.llamaUrl.trim());
  if (patch.model !== undefined) store.set("model", patch.model.trim());
  if (patch.defaultEffort !== undefined) store.set("defaultEffort", normalizeEffort(patch.defaultEffort));
  if (patch.memoryEnabled !== undefined) store.set("memoryEnabled", patch.memoryEnabled);
  if (patch.theme !== undefined) store.set("theme", patch.theme);
  if (patch.modelsDir !== undefined) store.set("modelsDir", patch.modelsDir.trim());
  if (patch.chatInstructions !== undefined) store.set("chatInstructions", patch.chatInstructions);
  if (patch.coworkInstructions !== undefined) store.set("coworkInstructions", patch.coworkInstructions);
  if (patch.googleClientId !== undefined) store.set("googleClientId", patch.googleClientId.trim());
  if (patch.llamaApiKey !== undefined) store.set("llamaApiKeyEnc", encrypt(patch.llamaApiKey.trim()));
  if (patch.tavilyApiKey !== undefined) store.set("tavilyApiKeyEnc", encrypt(patch.tavilyApiKey.trim()));
  if (patch.systemPrompt !== undefined) writeSystemPrompt(patch.systemPrompt);
  return getSettings();
}
