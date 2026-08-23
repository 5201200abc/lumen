import { addMemory, recentMemories, searchMemories } from "./db";
import type { ChatMessage } from "@shared/types";

const FACT = /(我是|我叫|我住|我喜欢|我不喜欢|记住|以后|偏好|我用|我的)/;

export function maybeRemember(user: ChatMessage, assistant: ChatMessage): void {
  const text = user.content.trim();
  if (text.length < 8) return;
  if (FACT.test(text) || text.length > 40) {
    const snippet = text.length > 280 ? `${text.slice(0, 280)}…` : text;
    addMemory(snippet, user.conversationId);
  }
  const reply = assistant.content.trim();
  const rememberLine = reply
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("记忆：") || l.startsWith("已记住"));
  if (rememberLine) addMemory(rememberLine.replace(/^(记忆：|已记住[:：]?)/, "").trim(), user.conversationId);
}

export function memoryBlock(query: string): string {
  const hits = query.trim() ? searchMemories(query, 8) : [];
  const extra = recentMemories(8).filter((m) => !hits.some((h) => h.id === m.id));
  const items = [...hits, ...extra].slice(0, 12);
  if (items.length === 0) return "";
  return ["长期记忆：", ...items.map((m) => `- ${m.content}`)].join("\n");
}
