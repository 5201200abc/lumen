export const MAX_OUTPUT_CONTINUATIONS = 3;
export const OUTPUT_BOUNDARY_MARKER = "<lumen_output_boundary/>";

export type CompletedRecoveryTool = {
  name: string;
  status: string;
  input: Record<string, unknown>;
  output?: string;
};

export function isContextOverflowError(value: unknown): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  return /exceeds the available context size|exceedcontextsizeerror|exceed_context_size|n_prompt_tokens.{0,80}n_ctx/i.test(text);
}

export function isOutputLimitError(value: unknown): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  return /response exceeded the \d+ output token maximum|output token (?:limit|maximum)|finish_reason.{0,40}length/i.test(text);
}

export function isTransientBackendError(value: unknown): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  return /TypeError:\s*fetch failed|local model connection (?:was interrupted|failed)|ECONNRESET|ECONNREFUSED|socket hang up/i.test(text);
}

export function stripRuntimeApiError(value: string): string {
  return value.replace(
    /\n*API Error:\s*(?:400\s*)?(?:TypeError:\s*)?fetch failed\.?/gi,
    ""
  ).trim();
}

export function stripOutputLimitError(value: string): string {
  return value.replace(
    /\n*API Error:\s*[^\n]*response exceeded the \d+ output token maximum\.[^\n]*/gi,
    ""
  ).trim();
}

export function stripOutputBoundaryMarker(value: string): string {
  return value.split(OUTPUT_BOUNDARY_MARKER).join("");
}

export function buildOutputRecoveryPrompt(opts: {
  effectivePrompt: string;
  assistantContent: string;
  assistantThinking?: string;
  completedTools: CompletedRecoveryTool[];
}): string {
  const taskContext = opts.assistantThinking?.trim()
    ? `<prior_reasoning>\n${opts.assistantThinking.slice(-6_000)}\n</prior_reasoning>`
    : `<original_task>\n${opts.effectivePrompt.slice(-12_000)}\n</original_task>`;
  return [
    taskContext,
    opts.assistantContent
      ? `<partial_answer>\n${opts.assistantContent.slice(-8_000)}\n</partial_answer>`
      : "",
    opts.completedTools.length
      ? `<completed_tools>\n${JSON.stringify(opts.completedTools).slice(-8_000)}\n</completed_tools>`
      : "",
    [
      "<output_limit_recovery>",
      "The previous model turn reached its output limit. Continue the original task from the exact unfinished point.",
      "The original task and completed progress are explicitly included above because no hidden session memory is available.",
      "Do not repeat text, code, tool calls, or checks already completed.",
      "Treat any interrupted explanatory prose as sufficient; do not continue or restart a requested long explanation.",
      "Ignore any original instruction to produce a minimum amount of prose before acting; that prose phase is complete.",
      "Begin this response with the next native tool call. Emit no preamble and do not spend output on additional reasoning.",
      "Immediately execute the next pending tool call or bounded file write. If no action remains, conclude in at most 200 words.",
      "Do not return a complete large artifact in chat. Write the next bounded section directly to its target file, verify it, then continue with another bounded section if needed.",
      "Keep this turn concise and below 12000 output tokens.",
      "</output_limit_recovery>"
    ].join("\n")
  ].filter(Boolean).join("\n\n");
}
