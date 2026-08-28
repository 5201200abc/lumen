import { BrowserWindow } from "electron";
import type { TokenUsage } from "@shared/types";
import { addTokenUsage, getTokenUsage } from "./db";

export type UsageDelta = {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
};

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function parseModelUsage(raw: unknown): UsageDelta | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  const details =
    usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : usage.input_tokens_details && typeof usage.input_tokens_details === "object"
        ? (usage.input_tokens_details as Record<string, unknown>)
        : {};
  const prompt = num(usage.prompt_tokens ?? usage.input_tokens ?? usage.prompt_n);
  const output = num(usage.completion_tokens ?? usage.output_tokens ?? usage.predicted_n);
  const cached = num(
    details.cached_tokens ??
      details.cache_read_tokens ??
      usage.cache_read_input_tokens ??
      usage.cached_tokens ??
      usage.cache_n
  );
  const created = num(usage.cache_creation_input_tokens ?? details.cache_creation_tokens);
  const cacheTokens = cached + created;
  if (!prompt && !output && !cacheTokens) return null;
  const inputTokens = cacheTokens && cacheTokens <= prompt ? Math.max(0, prompt - cacheTokens) : prompt;
  return { inputTokens, outputTokens: output, cacheTokens };
}

export function tokenUsage(): TokenUsage {
  return getTokenUsage();
}

export function recordTokenUsage(
  inputTokens: number,
  outputTokens: number,
  cacheTokens = 0,
  model = ""
): TokenUsage {
  const usage = addTokenUsage(inputTokens, outputTokens, cacheTokens, model);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("usage:updated", usage);
  }
  return usage;
}

export function recordParsedUsage(raw: unknown, model: string): TokenUsage | null {
  const parsed = parseModelUsage(raw);
  if (!parsed) return null;
  return recordTokenUsage(parsed.inputTokens, parsed.outputTokens, parsed.cacheTokens, model);
}
