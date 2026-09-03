import type { NativeModelMessage } from "./native-model-client.js";

export function estimateNativeTokens(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of value) {
    if (character.charCodeAt(0) < 128) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 3.5 + nonAscii * 1.25);
}

export function estimateNativeMessages(messages: NativeModelMessage[]): number {
  return messages.reduce((total, message) => {
    const toolCalls = message.tool_calls
      ? JSON.stringify(message.tool_calls)
      : "";
    return total + 12 + estimateNativeTokens(message.content || "") + estimateNativeTokens(toolCalls);
  }, 0);
}

function boundedTail(value: string, tokens: number): string {
  if (estimateNativeTokens(value) <= tokens) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateNativeTokens(value.slice(-middle)) <= tokens) low = middle;
    else high = middle - 1;
  }
  return `[earlier content omitted]\n${value.slice(-low)}`;
}

function describe(message: NativeModelMessage): string {
  if (message.role === "tool") {
    return `Tool result ${message.tool_call_id || ""}: ${boundedTail(message.content || "", 300)}`;
  }
  const calls = message.tool_calls?.map((call) => (
    `${call.function.name}(${boundedTail(call.function.arguments, 120)})`
  )).join(", ");
  return [
    `${message.role}: ${boundedTail(message.content || "", 500)}`,
    calls ? `Tool calls: ${calls}` : ""
  ].filter(Boolean).join("\n");
}

function turnStarts(messages: NativeModelMessage[]): number[] {
  const starts: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === "user") starts.push(index);
  });
  return starts;
}

export function compactNativeMessages(
  messages: NativeModelMessage[],
  targetTokens: number
): { messages: NativeModelMessage[]; compacted: boolean; summary: string } {
  if (estimateNativeMessages(messages) <= targetTokens) {
    return { messages, compacted: false, summary: "" };
  }
  const system = messages.find((message) => message.role === "system");
  const starts = turnStarts(messages);
  let keepFrom = starts.at(-1) ?? Math.max(1, messages.length - 2);
  for (let index = starts.length - 2; index >= 0; index -= 1) {
    const candidate = messages.slice(starts[index]);
    if (estimateNativeMessages([
      ...(system ? [system] : []),
      ...candidate
    ]) > targetTokens * 0.62) break;
    keepFrom = starts[index];
  }
  const older = messages.slice(system ? 1 : 0, keepFrom);
  const recent = messages.slice(keepFrom);
  const summary = boundedTail(
    older.map(describe).join("\n\n"),
    Math.max(500, Math.floor(targetTokens * 0.28))
  );
  const compactedMessages: NativeModelMessage[] = [
    ...(system ? [system] : []),
    {
      role: "system",
      content: [
        "Compacted prior Cowork context. Treat completed tools and decisions as established; do not repeat them.",
        summary || "No material earlier context."
      ].join("\n\n")
    },
    ...recent
  ];
  return {
    messages: compactedMessages,
    compacted: true,
    summary
  };
}

export function isNativeContextOverflow(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /context size|context window|exceed(?:s|ed|_context)|n_ctx|too many tokens/i.test(text);
}
