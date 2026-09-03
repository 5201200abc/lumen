import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AgentRuntime,
  AgentRuntimeContentBlock,
  AgentRuntimeOptions,
  AgentRuntimeUsage
} from "./agent-runtime.js";
import {
  NativeModelClient,
  type NativeModelMessage,
  type NativeModelResponse,
  type NativeModelToolCall
} from "./native-model-client.js";
import {
  executeNativeCoreTool,
  nativeAgentToolDefinitions,
  nativeCoreToolDefinitions,
  type NativeToolExecutionResult
} from "./native-agent-tools.js";
import {
  compactNativeMessages,
  estimateNativeMessages,
  isNativeContextOverflow
} from "./native-context.js";
import { NativeSessionStore } from "./native-session.js";
import { NativeMcpClient } from "./native-mcp-client.js";

type QueueItem = { prompt: string; uuid: string };
const MAX_OUTPUT_CONTINUATIONS = 3;
const MAX_EMPTY_FINAL_RECOVERIES = 1;
const execFileAsync = promisify(execFile);

type NativeSubtask = {
  id: string;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  output: string;
  error?: string;
  worktree?: string;
  runtime: AgentRuntime;
  done: Promise<void>;
};

function usage(response: NativeModelResponse): AgentRuntimeUsage | undefined {
  if (!response.usage) return undefined;
  return {
    input_tokens: response.usage.promptTokens,
    output_tokens: response.usage.completionTokens,
    cache_read_input_tokens: response.usage.cacheTokens
  };
}

function parseArguments(call: NativeModelToolCall): Record<string, unknown> {
  if (!call.function.arguments.trim()) return {};
  try {
    const parsed = JSON.parse(call.function.arguments) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("arguments must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Invalid arguments for ${call.function.name}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function systemPrompt(options: AgentRuntimeOptions): string {
  return [
    options.env.LLAMA_SYSTEM_PROMPT || "",
    options.env.LUMEN_SUBAGENT === "1"
      ? "You are a focused Lumen subagent. Complete only the delegated subtask and report concise evidence."
      : "You are Lumen Cowork, a native code agent. Use tools to inspect, edit, and verify the active workspace.",
    `Active workspace: ${options.cwd}`,
    "Never claim a tool action succeeded unless its tool result says it succeeded.",
    "After completing the task, give a concise result with verification evidence."
  ].filter(Boolean).join("\n\n");
}

export function startNativeAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  if (!options.modelEndpoint) {
    throw new Error("Native Agent requires an OpenAI-compatible model endpoint.");
  }
  const abortController = new AbortController();
  const client = new NativeModelClient(
    options.modelEndpoint.baseUrl,
    options.modelEndpoint.apiKey
  );
  const sessionStore = new NativeSessionStore(
    options.resume,
    options.env.LUMEN_NATIVE_SESSION_DIR
  );
  let messages: NativeModelMessage[] = [
    { role: "system", content: systemPrompt(options) }
  ];
  let tools = [
    ...nativeCoreToolDefinitions(options.tools),
    ...nativeAgentToolDefinitions(options.tools)
  ];
  const enabledTools = new Set(options.tools);
  const wantsMcp = options.tools.some((tool) => tool.startsWith("mcp__lumen__"));
  const mcp = wantsMcp
    ? new NativeMcpClient(
        options.mcpServer.command,
        options.mcpServer.args,
        options.mcpServer.env,
        options.onStderr
      )
    : null;
  const queue: QueueItem[] = [];
  const waiters: Array<() => void> = [];
  const subtasks = new Map<string, NativeSubtask>();
  let closed = false;
  let activeTurn: AbortController | null = null;

  const wake = (): void => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  const waitForWork = (): Promise<void> => new Promise((resolve) => waiters.push(resolve));

  const createWorktree = async (description: string): Promise<string> => {
    const repository = (
      await execFileAsync(
        "git",
        ["-C", options.cwd, "rev-parse", "--show-toplevel"],
        { encoding: "utf8", timeout: 10_000 }
      )
    ).stdout.trim();
    const root = options.env.LUMEN_WORKTREE_ROOT ||
      path.join(os.tmpdir(), "lumen-native-worktrees");
    const label = description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "task";
    const destination = path.join(
      root,
      `${path.basename(repository)}-${label}-${crypto.randomUUID().slice(0, 8)}`
    );
    await fs.mkdir(root, { recursive: true });
    await execFileAsync(
      "git",
      ["-C", repository, "worktree", "add", "--detach", destination, "HEAD"],
      { encoding: "utf8", timeout: 60_000 }
    );
    return destination;
  };

  const launchSubtask = async (
    input: Record<string, unknown>
  ): Promise<NativeToolExecutionResult> => {
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) return { content: "Task prompt is required.", isError: true };
    const description = typeof input.description === "string" && input.description.trim()
      ? input.description.trim()
      : prompt.slice(0, 80);
    const taskId = crypto.randomUUID();
    let cwd = options.cwd;
    let worktree: string | undefined;
    if (input.isolation === "worktree") {
      try {
        worktree = await createWorktree(description);
        cwd = worktree;
      } catch (error) {
        return {
          content: `Worktree creation failed: ${error instanceof Error ? error.message : String(error)}`,
          isError: true
        };
      }
    }
    options.onEvent({ type: "status", status: "subtask_start" });
    let record: NativeSubtask;
    const child = startNativeAgentRuntime({
      ...options,
      prompt: [
        `<delegated_task id="${taskId}">`,
        prompt,
        "</delegated_task>",
        "Do not broaden scope. Use tools as needed, verify the result, then report only the outcome and evidence."
      ].join("\n"),
      persistent: false,
      cwd,
      resume: undefined,
      tools: options.tools.filter(
        (tool) => !["Task", "TaskOutput", "TaskStop"].includes(tool)
      ),
      env: {
        ...options.env,
        LUMEN_SUBAGENT: "1"
      },
      canUseTool: options.canUseTool
        ? (toolName, toolInput, context) => options.canUseTool!(
            toolName,
            toolInput,
            { ...context, agentID: taskId }
          )
        : undefined,
      onEvent: (event) => {
        if (event.type === "status") {
          options.onEvent({ type: "status", status: "subtask_progress" });
        }
        if (event.type !== "result") return;
        record.output = event.output || "";
        record.error = event.success
          ? undefined
          : event.error instanceof Error
            ? event.error.message
            : String(event.error || "Subtask failed.");
        record.status = event.success ? "completed" : "failed";
      }
    });
    record = {
      id: taskId,
      description,
      status: "running",
      output: "",
      worktree,
      runtime: child,
      done: Promise.resolve()
    };
    record.done = child.done
      .catch((error) => {
        record.status = "failed";
        record.error = error instanceof Error ? error.message : String(error);
      })
      .then(() => {
        if (record.status === "running") {
          record.status = "failed";
          record.error = "Subtask ended without a terminal result.";
        }
      });
    subtasks.set(taskId, record);
    if (input.run_in_background === true) {
      return {
        content: JSON.stringify({
          task_id: taskId,
          status: record.status,
          description,
          worktree
        }),
        isError: false
      };
    }
    await record.done;
    return {
      content: JSON.stringify({
        task_id: taskId,
        status: record.status,
        output: record.output,
        error: record.error,
        worktree
      }),
      isError: record.status !== "completed"
    };
  };

  const subtaskOutput = async (
    input: Record<string, unknown>
  ): Promise<NativeToolExecutionResult> => {
    const taskId = typeof input.task_id === "string" ? input.task_id : "";
    const record = subtasks.get(taskId);
    if (!record) return { content: `Unknown background task: ${taskId}`, isError: true };
    if (input.block === true && record.status === "running") {
      const timeout = Math.min(60_000, Math.max(0, Number(input.timeout_ms || 30_000)));
      await Promise.race([
        record.done,
        new Promise<void>((resolve) => setTimeout(resolve, timeout))
      ]);
    }
    return {
      content: JSON.stringify({
        task_id: record.id,
        status: record.status,
        output: record.output,
        error: record.error,
        worktree: record.worktree
      }),
      isError: record.status === "failed"
    };
  };

  const stopSubtask = async (
    input: Record<string, unknown>
  ): Promise<NativeToolExecutionResult> => {
    const taskId = typeof input.task_id === "string" ? input.task_id : "";
    const record = subtasks.get(taskId);
    if (!record) return { content: `Unknown background task: ${taskId}`, isError: true };
    if (record.status === "running") {
      await record.runtime.interrupt();
      record.runtime.close();
      record.status = "stopped";
    }
    return {
      content: JSON.stringify({ task_id: taskId, status: record.status }),
      isError: false
    };
  };
  const emitResult = (
    call: NativeModelToolCall,
    result: NativeToolExecutionResult
  ): Promise<void> => {
    options.onEvent({
      type: "tool_result",
      toolUseId: call.id,
      content: result.content,
      isError: result.isError
    });
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: result.content
    });
    return sessionStore.appendMessage(messages.at(-1)!);
  };

  const runTurn = async (item: QueueItem): Promise<void> => {
    activeTurn = new AbortController();
    const abort = (): void => activeTurn?.abort();
    abortController.signal.addEventListener("abort", abort, { once: true });
    options.onEvent({ type: "session", sessionId: sessionStore.sessionId });
    options.onEvent({ type: "status", status: "working" });
    await sessionStore.beginTurn(item.uuid);
    await sessionStore.createCheckpoint(options.cwd, item.uuid).catch((error) => {
      options.onStderr(
        `Native Agent checkpoint unavailable: ${error instanceof Error ? error.message : String(error)}\n`
      );
    });
    messages.push({ role: "user", content: item.prompt });
    await sessionStore.appendMessage(messages.at(-1)!);
    try {
      let outputContinuations = 0;
      let emptyFinalRecoveries = 0;
      let completedToolRound = false;
      let contextRetryUsed = false;
      for (let round = 0; round < 64; round += 1) {
        const contextWindow = Math.max(
          256,
          Number(options.env.LUMEN_CONTEXT_WINDOW || 16_384)
        );
        const autoCompactRatio = Math.min(
          0.9,
          Math.max(0.35, Number(options.env.LUMEN_AUTO_COMPACT_RATIO || 0.62))
        );
        if (estimateNativeMessages(messages) >= contextWindow * autoCompactRatio) {
          const compacted = compactNativeMessages(
            messages,
            Math.floor(contextWindow * 0.45)
          );
          if (compacted.compacted) {
            messages = compacted.messages;
            await sessionStore.replaceMessages(messages);
            options.onEvent({ type: "status", status: "compacting" });
          }
        }
        const blocks: AgentRuntimeContentBlock[] = [];
        const started = new Set<number>();
        options.onEvent({ type: "message_start" });
        const modelRequest = {
          model: options.model,
          messages,
          tools,
          toolChoice: tools.length ? "auto" as const : "none" as const,
          temperature: 0.2,
          maxTokens: 4_096,
          reasoningEffort: options.effort || "medium",
          signal: activeTurn.signal
        };
        let response: NativeModelResponse;
        const onModelEvent = (event: Parameters<NativeModelClient["stream"]>[1] extends (
          event: infer Event
        ) => void ? Event : never): void => {
          if (event.type === "reasoning_delta") {
            const index = 0;
            if (!started.has(index)) {
              started.add(index);
              blocks.push({ type: "reasoning", text: "" });
              options.onEvent({
                type: "content_start",
                index,
                block: { type: "reasoning", text: "" }
              });
            }
            const block = blocks.find((candidate) => candidate.type === "reasoning");
            if (block?.type === "reasoning") block.text += event.text;
            options.onEvent({
              type: "content_delta",
              index,
              delta: { type: "reasoning", text: event.text }
            });
          } else if (event.type === "text_delta") {
            const index = 1;
            if (!started.has(index)) {
              started.add(index);
              blocks.push({ type: "text", text: "" });
              options.onEvent({
                type: "content_start",
                index,
                block: { type: "text", text: "" }
              });
            }
            const block = blocks.find((candidate) => candidate.type === "text");
            if (block?.type === "text") block.text += event.text;
            options.onEvent({
              type: "content_delta",
              index,
              delta: { type: "text", text: event.text }
            });
          } else if (event.type === "tool_call_delta") {
            const index = event.index + 2;
            if (!started.has(index)) {
              started.add(index);
              const block: AgentRuntimeContentBlock = {
                type: "tool_use",
                id: event.id || "",
                name: event.name || "",
                input: {}
              };
              blocks.push(block);
              options.onEvent({ type: "content_start", index, block });
            }
            if (event.arguments) {
              options.onEvent({
                type: "content_delta",
                index,
                delta: { type: "tool_input", partialJson: event.arguments }
              });
            }
          }
        };
        try {
          response = await client.stream(modelRequest, onModelEvent);
        } catch (error) {
          if (!contextRetryUsed && isNativeContextOverflow(error)) {
            contextRetryUsed = true;
            const compacted = compactNativeMessages(
              messages,
              Math.floor(contextWindow * 0.35)
            );
            messages = compacted.messages;
            await sessionStore.replaceMessages(messages);
            options.onEvent({ type: "status", status: "compacting" });
            round -= 1;
            continue;
          }
          throw error;
        }
        for (const index of started) options.onEvent({ type: "content_stop", index });

        const toolCalls = response.message.tool_calls || [];
        for (const call of toolCalls) {
          const existing = blocks.find(
            (block) => block.type === "tool_use" && (!block.id || block.id === call.id)
          );
          if (existing?.type === "tool_use") {
            existing.id = call.id;
            existing.name = call.function.name;
            try {
              existing.input = parseArguments(call);
            } catch {
              existing.input = { raw: call.function.arguments };
            }
          } else {
            blocks.push({
              type: "tool_use",
              id: call.id,
              name: call.function.name,
              input: {}
            });
          }
        }
        options.onEvent({ type: "assistant", content: blocks, usage: usage(response) });
        messages.push(response.message);
        await sessionStore.appendMessage(response.message);

        if (!toolCalls.length) {
          if (
            completedToolRound &&
            !response.message.content?.trim() &&
            emptyFinalRecoveries < MAX_EMPTY_FINAL_RECOVERIES
          ) {
            emptyFinalRecoveries += 1;
            messages.push({
              role: "user",
              content: "Provide the concise final answer now using the completed tool results. Do not call another tool."
            });
            await sessionStore.appendMessage(messages.at(-1)!);
            options.onEvent({ type: "status", status: "working" });
            continue;
          }
          if (
            response.finishReason === "length" &&
            outputContinuations < MAX_OUTPUT_CONTINUATIONS
          ) {
            outputContinuations += 1;
            messages.push({
              role: "user",
              content: [
                `Continue from the exact unfinished point (${outputContinuations}/${MAX_OUTPUT_CONTINUATIONS}).`,
                "Do not repeat prior text or completed tool calls. Finish concisely."
              ].join(" ")
            });
            await sessionStore.appendMessage(messages.at(-1)!);
            options.onEvent({ type: "status", status: "working" });
            continue;
          }
          options.onEvent({
            type: "result",
            success: response.finishReason !== "length",
            subtype: response.finishReason === "length" ? "output_limit" : "success",
            output: response.message.content || "",
            usage: usage(response)
          });
          return;
        }

        for (const call of toolCalls) {
          let input: Record<string, unknown>;
          try {
            input = parseArguments(call);
          } catch (error) {
            await emitResult(call, {
              content: error instanceof Error ? error.message : String(error),
              isError: true
            });
            continue;
          }
          const allowed = options.permissionMode === "bypassPermissions"
            ? { behavior: "allow" as const }
            : options.canUseTool
              ? await options.canUseTool(call.function.name, input, {
                  signal: activeTurn.signal,
                  toolUseID: call.id,
                  requestId: crypto.randomUUID()
                })
              : { behavior: "deny" as const, message: "Tool permission was not granted." };
          if (allowed.behavior === "deny") {
            await emitResult(call, { content: allowed.message, isError: true });
            if (allowed.interrupt) throw new Error(allowed.message);
            continue;
          }
          const effectiveInput = allowed.updatedInput || input;
          const result = await (
            call.function.name === "Task"
              ? launchSubtask(effectiveInput)
              : call.function.name === "TaskOutput"
                ? subtaskOutput(effectiveInput)
                : call.function.name === "TaskStop"
                  ? stopSubtask(effectiveInput)
                  : call.function.name.startsWith("mcp__lumen__") && mcp
              ? mcp.call(call.function.name, effectiveInput)
              : executeNativeCoreTool(
                  call.function.name,
                  effectiveInput,
                  options.cwd,
                  activeTurn.signal
                )
          ).catch((error): NativeToolExecutionResult => ({
            content: error instanceof Error ? error.message : String(error),
            isError: true
          }));
          await emitResult(call, result);
        }
        completedToolRound = true;
      }
      throw new Error("Native Agent exceeded 64 model/tool rounds.");
    } catch (error) {
      const interrupted = activeTurn.signal.aborted || abortController.signal.aborted;
      options.onEvent({
        type: "result",
        success: false,
        subtype: interrupted ? "interrupted" : "error",
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      abortController.signal.removeEventListener("abort", abort);
      activeTurn = null;
    }
  };

  const done = (async () => {
    try {
      const recovered = await sessionStore.loadMessages();
      if (recovered.length) messages = recovered;
      if (mcp) {
        options.onEvent({ type: "status", status: "initializing" });
        const mcpTools = await mcp.start();
        tools = [
          ...tools,
          ...mcpTools.filter((tool) => enabledTools.has(tool.function.name))
        ];
      }
      if (!options.persistent && options.prompt) {
        await runTurn({ prompt: options.prompt, uuid: crypto.randomUUID() });
        return;
      }
      while (!closed && !abortController.signal.aborted) {
        const item = queue.shift();
        if (item) await runTurn(item);
        else await waitForWork();
      }
    } finally {
      mcp?.close();
    }
  })();

  return {
    kind: "native",
    abortController,
    done,
    send: (prompt, uuid) => {
      if (!options.persistent) throw new Error("This Native Agent runtime is not persistent.");
      if (closed) throw new Error("Native Agent session is closed.");
      queue.push({ prompt, uuid });
      wake();
    },
    interrupt: async () => {
      activeTurn?.abort();
    },
    close: () => {
      closed = true;
      activeTurn?.abort();
      for (const subtask of subtasks.values()) {
        if (subtask.status !== "running") continue;
        void subtask.runtime.interrupt();
        subtask.runtime.close();
        subtask.status = "stopped";
      }
      mcp?.close();
      wake();
    },
    rewindFiles: (userMessageId, rewindOptions) => sessionStore.rewindFiles(
      options.cwd,
      userMessageId,
      rewindOptions?.dryRun === true
    )
  };
}
