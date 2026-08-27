import { BrowserWindow } from "electron";
import type { TokenUsage } from "@shared/types";
import { addTokenUsage, getTokenUsage } from "./db";

export function tokenUsage(): TokenUsage {
  return getTokenUsage();
}

export function recordTokenUsage(inputTokens: number, outputTokens: number): TokenUsage {
  const usage = addTokenUsage(inputTokens, outputTokens);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("usage:updated", usage);
  }
  return usage;
}
