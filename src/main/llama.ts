import { nativeImage } from "electron";
import type { Attachment, ChatMessage, Effort, Settings } from "@shared/types";
import { memoryBlock } from "./memory";
import { tavilySearch } from "./search";

export type StreamHandlers = {
  onDelta: (chunk: { thinking?: string; content?: string }) => void;
  onDone: (result: { thinking: string; content: string; stopped: boolean }) => void;
  onError: (error: string) => void;
};

type OpenAIPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type OpenAIMessage = {
  role: "system" | "user" | "assistant";
  content: string | OpenAIPart[];
  reasoning_content?: string;
  reasoning?: string;
};

class ThinkSplitter {
  thinking = "";
  content = "";
  private mode: "text" | "think" = "text";
  private tail = "";

  push(piece: string): void {
    const data = this.tail + piece;
    this.tail = "";
    let i = 0;
    while (i < data.length) {
      if (this.mode === "text") {
        const idx = data.indexOf("<think>", i);
        if (idx === -1) {
          const lt = data.lastIndexOf("<");
          if (lt >= i && "<think>".startsWith(data.slice(lt))) {
            this.content += data.slice(i, lt);
            this.tail = data.slice(lt);
            return;
          }
          this.content += data.slice(i);
          return;
        }
        this.content += data.slice(i, idx);
        this.mode = "think";
        i = idx + 7;
      } else {
        const idx = data.indexOf("</think>", i);
        if (idx === -1) {
          const lt = data.lastIndexOf("<");
          if (lt >= i && "</think>".startsWith(data.slice(lt))) {
            this.thinking += data.slice(i, lt);
            this.tail = data.slice(lt);
            return;
          }
          this.thinking += data.slice(i);
          return;
        }
        this.thinking += data.slice(i, idx);
        this.mode = "text";
        i = idx + 8;
      }
    }
  }

  finish(): void {
    if (!this.tail) return;
    if (this.mode === "think") this.thinking += this.tail;
    else this.content += this.tail;
    this.tail = "";
  }
}

function effortParams(effort: Effort): {
  reasoning_effort: Effort;
} {
  return { reasoning_effort: effort };
}

function compactImage(dataUrl: string): string {
  try {
    const img = nativeImage.createFromDataURL(dataUrl);
    const { width, height } = img.getSize();
    const max = 1280;
    const scale = Math.min(1, max / Math.max(width, height, 1));
    const resized =
      scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale) }) : img;
    return `data:image/jpeg;base64,${resized.toJPEG(78).toString("base64")}`;
  } catch {
    return dataUrl;
  }
}

function userContent(text: string, attachments: Attachment[], vision: boolean): string | OpenAIPart[] {
  if (!attachments.length) return text;
  if (!vision) {
    return `${text}\n\n[附件 ${attachments.length} 张图片：当前 llama-server 未加载 mmproj，视觉不可用]`;
  }
  const parts: OpenAIPart[] = [];
  if (text.trim()) parts.push({ type: "text", text });
  for (const file of attachments) {
    parts.push({ type: "image_url", image_url: { url: compactImage(file.dataUrl) } });
  }
  if (!text.trim()) parts.unshift({ type: "text", text: "请描述这些图片。" });
  return parts;
}

function historyMessages(history: ChatMessage[], vision: boolean): OpenAIMessage[] {
  const recent = history.slice(-24);
  const out: OpenAIMessage[] = [];
  for (const item of recent) {
    if (item.role === "system") continue;
    const content =
      item.role === "user"
        ? userContent(item.content, item.attachments, vision)
        : item.content;
    if (item.role === "assistant") {
      out.push({
        role: "assistant",
        content,
        reasoning_content: item.thinking || undefined,
        reasoning: item.thinking || undefined
      });
    } else {
      out.push({ role: "user", content });
    }
  }
  return out;
}

export async function streamChat(opts: {
  settings: Settings;
  history: ChatMessage[];
  userText: string;
  attachments: Attachment[];
  effort: Effort;
  webSearch: boolean;
  vision: boolean;
  abort: AbortController;
  handlers: StreamHandlers;
}): Promise<void> {
  const { settings, handlers, abort } = opts;
  const params = effortParams(opts.effort);
  let searchBlock = "";
  if (opts.webSearch && opts.userText.trim()) {
    try {
      const result = await tavilySearch(settings.tavilyApiKey, opts.userText.trim());
      searchBlock = result.digest;
    } catch (err) {
      handlers.onError(err instanceof Error ? err.message : String(err));
      return;
    }
  }

  const mem = settings.memoryEnabled ? memoryBlock(opts.userText) : "";
  const system = [
    settings.systemPrompt.trim() || "你是本地助手，接在本机 Llama / OpenAI-compatible 接口上。",
    settings.chatInstructions.trim()
      ? `Follow these user-provided custom instructions for Chat:\n${settings.chatInstructions.trim()}`
      : "",
    mem,
    searchBlock ? `全网检索结果：\n${searchBlock}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages: OpenAIMessage[] = [
    { role: "system", content: system },
    ...historyMessages(opts.history, opts.vision),
    { role: "user", content: userContent(opts.userText, opts.attachments, opts.vision) }
  ];

  const url = `${settings.llamaUrl.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.llamaApiKey) headers.Authorization = `Bearer ${settings.llamaApiKey}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: settings.model,
        messages,
        stream: true,
        temperature: 1.0,
        top_p: 0.95,
        top_k: 20,
        min_p: 0.0,
        presence_penalty: 0.0,
        repetition_penalty: 1.0,
        reasoning_effort: params.reasoning_effort,
        chat_template_kwargs: {
          enable_thinking: true,
          preserve_thinking: true,
          reasoning_effort: params.reasoning_effort
        },
        enable_thinking: true,
        preserve_thinking: true,
        reasoning_format: "auto"
      }),
      signal: abort.signal
    });
  } catch (err) {
    if (abort.signal.aborted) {
      handlers.onDone({ thinking: "", content: "", stopped: true });
      return;
    }
    handlers.onError(err instanceof Error ? err.message : String(err));
    return;
  }

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    handlers.onError(`Llama ${res.status}: ${body.slice(0, 400)}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const split = new ThinkSplitter();
  let reasoning = "";

  const consume = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let json: {
      choices?: Array<{
        delta?: {
          content?: string;
          reasoning_content?: string;
          reasoning?: string;
        };
      }>;
    };
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const delta = json.choices?.[0]?.delta;
    if (!delta) return;
    const rc = delta.reasoning_content || delta.reasoning || "";
    const cc = delta.content || "";
    if (rc) {
      reasoning += rc;
      handlers.onDelta({ thinking: reasoning + split.thinking });
    }
    if (cc) {
      split.push(cc);
      handlers.onDelta({
        thinking: reasoning + split.thinking,
        content: split.content
      });
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) consume(line);
    }
    buf += decoder.decode();
    if (buf.trim()) consume(buf);
    split.finish();
    handlers.onDone({
      thinking: reasoning + split.thinking,
      content: split.content,
      stopped: false
    });
  } catch (err) {
    split.finish();
    if (abort.signal.aborted) {
      handlers.onDone({
        thinking: reasoning + split.thinking,
        content: split.content,
        stopped: true
      });
      return;
    }
    handlers.onError(err instanceof Error ? err.message : String(err));
  }
}
