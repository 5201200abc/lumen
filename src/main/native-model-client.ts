export type NativeModelRole = "system" | "user" | "assistant" | "tool";

export type NativeModelToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type NativeModelMessage = {
  role: NativeModelRole;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: NativeModelToolCall[];
};

export type NativeModelTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type NativeModelUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheTokens?: number;
};

export type NativeModelFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | string
  | null;

export type NativeModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | {
      type: "tool_call_delta";
      index: number;
      id?: string;
      name?: string;
      arguments?: string;
    }
  | { type: "usage"; usage: NativeModelUsage }
  | { type: "finish"; reason: NativeModelFinishReason };

export type NativeModelRequest = {
  model: string;
  messages: NativeModelMessage[];
  tools?: NativeModelTool[];
  toolChoice?: "auto" | "none" | "required";
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;
  signal?: AbortSignal;
};

export type NativeModelResponse = {
  message: NativeModelMessage;
  reasoning: string;
  finishReason: NativeModelFinishReason;
  usage?: NativeModelUsage;
};

type WireUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
};

type WireToolCall = {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type WireChoice = {
  delta?: {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: WireToolCall[];
  };
  message?: {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: WireToolCall[];
  };
  finish_reason?: string | null;
};

type WireResponse = {
  choices?: WireChoice[];
  usage?: WireUsage;
  timings?: WireUsage;
  error?: unknown;
};

function endpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

function usageFromWire(value: WireUsage | undefined): NativeModelUsage | undefined {
  if (!value) return undefined;
  const promptTokens = Number(value.prompt_tokens || 0);
  const completionTokens = Number(value.completion_tokens || 0);
  const totalTokens = Number(value.total_tokens || promptTokens + completionTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(value.prompt_tokens_details?.cached_tokens !== undefined
      ? { cacheTokens: Number(value.prompt_tokens_details.cached_tokens) }
      : {})
  };
}

function serializeRequest(request: NativeModelRequest, stream: boolean): string {
  return JSON.stringify({
    model: request.model,
    messages: request.messages,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(request.tools?.length ? { tools: request.tools } : {}),
    ...(request.tools?.length && request.toolChoice
      ? { tool_choice: request.toolChoice }
      : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    ...(request.reasoningEffort
      ? {
          reasoning_effort: request.reasoningEffort,
          chat_template_kwargs: { reasoning_effort: request.reasoningEffort }
        }
      : {})
  });
}

function applyToolCall(
  calls: Map<number, NativeModelToolCall>,
  delta: WireToolCall,
  fallbackIndex: number
): { index: number; call: NativeModelToolCall } {
  const index = delta.index ?? fallbackIndex;
  const current = calls.get(index) || {
    id: "",
    type: "function" as const,
    function: { name: "", arguments: "" }
  };
  if (delta.id) current.id = delta.id;
  if (delta.function?.name) current.function.name += delta.function.name;
  if (delta.function?.arguments) current.function.arguments += delta.function.arguments;
  calls.set(index, current);
  return { index, call: current };
}

function errorBody(status: number, statusText: string, body: string): Error {
  const detail = body.trim() || statusText || "empty response";
  return new Error(`OpenAI-compatible model ${status}: ${detail.slice(0, 2_000)}`);
}

export class NativeModelClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string
  ) {}

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
    };
  }

  async complete(request: NativeModelRequest): Promise<NativeModelResponse> {
    const response = await fetch(endpoint(this.baseUrl), {
      method: "POST",
      headers: this.headers(),
      body: serializeRequest(request, false),
      signal: request.signal
    });
    const body = await response.text();
    if (!response.ok) throw errorBody(response.status, response.statusText, body);

    let payload: WireResponse;
    try {
      payload = JSON.parse(body) as WireResponse;
    } catch {
      throw new Error(`OpenAI-compatible model returned invalid JSON: ${body.slice(0, 500)}`);
    }
    const choice = payload.choices?.[0];
    if (!choice?.message) {
      throw new Error("OpenAI-compatible model returned no assistant message.");
    }
    const calls = new Map<number, NativeModelToolCall>();
    choice.message.tool_calls?.forEach((call, index) => applyToolCall(calls, call, index));
    return {
      message: {
        role: "assistant",
        content: choice.message.content || "",
        ...(calls.size
          ? { tool_calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) }
          : {})
      },
      reasoning: choice.message.reasoning_content || choice.message.reasoning || "",
      finishReason: choice.finish_reason ?? null,
      usage: usageFromWire(payload.usage || payload.timings)
    };
  }

  async stream(
    request: NativeModelRequest,
    onEvent: (event: NativeModelStreamEvent) => void
  ): Promise<NativeModelResponse> {
    const response = await fetch(endpoint(this.baseUrl), {
      method: "POST",
      headers: this.headers(),
      body: serializeRequest(request, true),
      signal: request.signal
    });
    if (!response.ok) {
      throw errorBody(response.status, response.statusText, await response.text());
    }
    if (!response.body) {
      throw new Error("OpenAI-compatible model returned an empty streaming body.");
    }

    const calls = new Map<number, NativeModelToolCall>();
    let content = "";
    let reasoning = "";
    let finishReason: NativeModelFinishReason = null;
    let usage: NativeModelUsage | undefined;
    let buffer = "";
    let eventData: string[] = [];

    const consumeEvent = (): boolean => {
      if (!eventData.length) return false;
      const data = eventData.join("\n").trim();
      eventData = [];
      if (!data) return false;
      if (data === "[DONE]") return true;

      let payload: WireResponse;
      try {
        payload = JSON.parse(data) as WireResponse;
      } catch {
        throw new Error(`OpenAI-compatible model returned invalid SSE JSON: ${data.slice(0, 500)}`);
      }
      const parsedUsage = usageFromWire(payload.usage || payload.timings);
      if (parsedUsage) {
        usage = parsedUsage;
        onEvent({ type: "usage", usage: parsedUsage });
      }
      const choice = payload.choices?.[0];
      const delta = choice?.delta;
      if (delta?.reasoning_content || delta?.reasoning) {
        const text = delta.reasoning_content || delta.reasoning || "";
        reasoning += text;
        onEvent({ type: "reasoning_delta", text });
      }
      if (delta?.content) {
        content += delta.content;
        onEvent({ type: "text_delta", text: delta.content });
      }
      delta?.tool_calls?.forEach((toolDelta, fallbackIndex) => {
        const { index } = applyToolCall(calls, toolDelta, fallbackIndex);
        onEvent({
          type: "tool_call_delta",
          index,
          ...(toolDelta.id ? { id: toolDelta.id } : {}),
          ...(toolDelta.function?.name ? { name: toolDelta.function.name } : {}),
          ...(toolDelta.function?.arguments
            ? { arguments: toolDelta.function.arguments }
            : {})
        });
      });
      if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
        finishReason = choice.finish_reason;
        onEvent({ type: "finish", reason: finishReason });
      }
      return false;
    };

    const consumeLines = (flush: boolean): boolean => {
      const lines = buffer.split(/\r?\n/);
      buffer = flush ? "" : lines.pop() || "";
      for (const line of lines) {
        if (!line) {
          if (consumeEvent()) return true;
          continue;
        }
        if (line.startsWith(":")) continue;
        if (line.startsWith("data:")) eventData.push(line.slice(5).trimStart());
      }
      if (flush) {
        if (buffer) {
          if (buffer.startsWith("data:")) eventData.push(buffer.slice(5).trimStart());
          buffer = "";
        }
        return consumeEvent();
      }
      return false;
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let doneMarker = false;
    while (!doneMarker) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      doneMarker = consumeLines(false);
    }
    buffer += decoder.decode();
    if (!doneMarker) consumeLines(true);

    const toolCalls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call);
    return {
      message: {
        role: "assistant",
        content,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      },
      reasoning,
      finishReason,
      usage
    };
  }
}
