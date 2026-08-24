import { nativeImage } from "electron";
import type { Attachment, ChatMessage, Effort, Settings } from "@shared/types";
import { planChatRequest } from "@shared/chat-plan";
import { memoryBlock } from "./memory";
import { tavilySearch } from "./search";

export type StreamHandlers = {
  onDelta: (chunk: { thinking?: string; content?: string }) => void;
  onStatus: (status: {
    phase: "preparing" | "searching" | "thinking" | "answering";
    text: string;
  }) => void;
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
  const images = attachments.filter((file) => file.kind === "image" && file.dataUrl).slice(0, 3);
  const files = attachments.filter((file) => file.kind !== "image").slice(0, 24);
  const fileDetails = files
    .map((file) => {
      const label = file.relativePath || file.name;
      return file.text
        ? `<file name="${label}">\n${trimToTokens(file.text, 1200)}\n</file>`
        : `- ${label}${file.path ? ` (${file.path})` : ""} [binary content is not directly readable by this chat model]`;
    })
    .join("\n\n");
  const fileBlock = files.length
    ? `Attached files:\n${trimToTokens(fileDetails, 5200)}`
    : "";
  const imageNote =
    images.length && !vision
      ? `${images.length} image attachment(s) added, but vision is unavailable because llama-server has no mmproj loaded.`
      : "";
  const combinedText = [text, fileBlock, imageNote].filter(Boolean).join("\n\n");
  if (!images.length || !vision) return combinedText;
  const parts: OpenAIPart[] = [];
  if (combinedText.trim()) parts.push({ type: "text", text: combinedText });
  for (const file of images) {
    parts.push({ type: "image_url", image_url: { url: compactImage(file.dataUrl!) } });
  }
  if (!combinedText.trim()) parts.unshift({ type: "text", text: "Describe these images." });
  return parts;
}

function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 3.5 + nonAscii * 1.25);
}

function trimToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low).trimEnd()}\n\n[Content truncated to fit the model context.]`;
}

function contentTokens(content: string | OpenAIPart[]): number {
  if (typeof content === "string") return estimateTokens(content);
  return content.reduce(
    (total, part) => total + (part.type === "text" ? estimateTokens(part.text) : 1100),
    0
  );
}

function historyMessages(history: ChatMessage[], vision: boolean, budget: number): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  let used = 0;
  for (const item of [...history].reverse()) {
    if (item.role === "system") continue;
    const content =
      item.role === "user"
        ? userContent(trimToTokens(item.content, 2400), item.attachments.slice(0, 8), vision)
        : trimToTokens(item.content, 2400);
    if (item.role === "assistant" && !item.content.trim()) continue;
    const cost = contentTokens(content) + 12;
    if (used + cost > budget) {
      if (item.role === "user" && out[0]?.role === "assistant") out.shift();
      break;
    }
    used += cost;
    if (item.role === "assistant") {
      out.unshift({ role: "assistant", content });
    } else {
      out.unshift({ role: "user", content });
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
  const plan = planChatRequest(opts.userText, opts.webSearch);
  const effectiveEffort: Effort = plan.enableThinking ? opts.effort : "low";
  const params = effortParams(effectiveEffort);
  let searchBlock = "";
  if (plan.useWeb && opts.userText.trim()) {
    if (settings.tavilyApiKey) {
      handlers.onStatus({ phase: "searching", text: "Searching the web" });
      try {
        const result = await tavilySearch(settings.tavilyApiKey, opts.userText.trim());
        searchBlock = result.digest;
      } catch (err) {
        handlers.onStatus({
          phase: "preparing",
          text: `Web search is unavailable; continuing with the local model. ${
            err instanceof Error ? err.message : String(err)
          }`
        });
      }
    } else {
      handlers.onStatus({
        phase: "preparing",
        text: "No Tavily API key is configured; continuing with the local model"
      });
    }
  }

  const mem = settings.memoryEnabled ? memoryBlock(opts.userText) : "";
  const system = [
    trimToTokens(
      settings.systemPrompt.trim() || "你是本地助手，接在本机 Llama / OpenAI-compatible 接口上。",
      1800
    ),
    settings.chatInstructions.trim()
      ? `Follow these user-provided custom instructions for Chat:\n${trimToTokens(settings.chatInstructions.trim(), 1200)}`
      : "",
    "Reasoning discipline: solve simple tasks directly, never repeat the same verification or restart an established reasoning path, and answer as soon as the result is established.",
    plan.kind === "arithmetic"
      ? "Arithmetic response rule: return the result directly with at most one short calculation line."
      : "",
    trimToTokens(mem, 1000),
    searchBlock ? `Web search results:\n${trimToTokens(searchBlock, 2200)}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  const currentUser = userContent(
    trimToTokens(opts.userText, 4200),
    opts.attachments.slice(0, 24),
    opts.vision
  );
  const historyBudget = Math.max(
    0,
    Math.min(4800, 11_500 - estimateTokens(system) - contentTokens(currentUser) - 800)
  );
  const messages: OpenAIMessage[] = [
    { role: "system", content: system },
    ...historyMessages(opts.history, opts.vision, historyBudget),
    { role: "user", content: currentUser }
  ];

  const url = `${settings.llamaUrl.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.llamaApiKey) headers.Authorization = `Bearer ${settings.llamaApiKey}`;

  const request = (requestMessages: OpenAIMessage[]) =>
    fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: settings.model,
        messages: requestMessages,
        stream: true,
        temperature: plan.kind === "creative" ? 0.8 : plan.enableThinking ? 0.7 : 0.3,
        top_p: 0.95,
        top_k: 20,
        min_p: 0.0,
        presence_penalty: 0.0,
        repetition_penalty: 1.05,
        max_tokens:
          plan.kind === "arithmetic"
            ? 128
            : plan.enableThinking
              ? effectiveEffort === "low"
                ? 1024
                : effectiveEffort === "medium"
                  ? 2048
                  : 3072
              : 1536,
        reasoning_effort: params.reasoning_effort,
        chat_template_kwargs: {
          enable_thinking: plan.enableThinking,
          preserve_thinking: plan.enableThinking,
          reasoning_effort: params.reasoning_effort
        },
        enable_thinking: plan.enableThinking,
        preserve_thinking: plan.enableThinking,
        reasoning_format: "auto"
      }),
      signal: abort.signal
    });

  handlers.onStatus({ phase: "preparing", text: "The model is processing the request" });
  let res: Response;
  try {
    res = await request(messages);
  } catch (err) {
    if (abort.signal.aborted) {
      handlers.onDone({ thinking: "", content: "", stopped: true });
      return;
    }
    handlers.onError(err instanceof Error ? err.message : String(err));
    return;
  }

  if (!res.ok) {
    let body = await res.text().catch(() => "");
    if (
      res.status === 400 &&
      /exceed(?:s|_context)|context size|n_ctx/i.test(body)
    ) {
      handlers.onStatus({ phase: "preparing", text: "The context is long; compressing it and retrying" });
      try {
        res = await request([
          { role: "system", content: trimToTokens(system, 2200) },
          { role: "user", content: currentUser }
        ]);
        if (!res.ok) body = await res.text().catch(() => "");
      } catch (err) {
        handlers.onError(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    if (!res.ok) {
      handlers.onError(
        /exceed(?:s|_context)|context size|n_ctx/i.test(body)
          ? "This message still exceeds the model’s context capacity after automatic compression. Shorten it or attach fewer images, then try again."
          : `Llama ${res.status}: ${body.slice(0, 400)}`
      );
      return;
    }
  }
  if (!res.body) {
    const body = await res.text().catch(() => "");
    handlers.onError(`Llama ${res.status}: ${body.slice(0, 400)}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const split = new ThinkSplitter();
  let reasoning = "";
  let phase: "preparing" | "thinking" | "answering" = "preparing";
  let lastDeltaAt = 0;

  const emitDelta = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastDeltaAt < 80) return;
    lastDeltaAt = now;
    handlers.onDelta({
      thinking: reasoning + split.thinking,
      content: split.content
    });
  };

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
      if (phase !== "thinking") {
        phase = "thinking";
        handlers.onStatus({ phase: "thinking", text: "Thinking" });
      }
      reasoning += rc;
      emitDelta();
    }
    if (cc) {
      split.push(cc);
      if (split.thinking && !split.content && phase !== "thinking") {
        phase = "thinking";
        handlers.onStatus({ phase: "thinking", text: "Thinking" });
      }
      if (split.content && phase !== "answering") {
        phase = "answering";
        handlers.onStatus({ phase: "answering", text: "Writing the answer" });
      }
      emitDelta();
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
    emitDelta(true);
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
