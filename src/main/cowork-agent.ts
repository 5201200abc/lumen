import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { execFile } from "child_process";
import crypto from "node:crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { Attachment, CoworkMessage, CoworkTask, CoworkToolCall, CoworkTraceEntry, CoworkApproval, CoworkApprovalDecision, CoworkEngine, Effort, Settings, WorkspaceInfo } from "@shared/types";
import { toolActivity } from "@shared/cowork-status";
import { generateConversationTitle, immediateConversationTitle } from "./title";
import { getSettings } from "./store";
import { ensureLocalLlama, probeLlama } from "./models";
import { ensureToolHost } from "./tool-host";
import { parseModelUsage, recordTokenUsage } from "./usage";
import { startNativeAgentRuntime } from "./native-agent-runtime";
import type {
  AgentPermissionResult,
  AgentPermissionUpdate,
  AgentRuntime,
  AgentRuntimeEvent
} from "./agent-runtime";
import {
  buildOutputRecoveryPrompt,
  isContextOverflowError,
  isOutputLimitError,
  isTransientBackendError,
  MAX_OUTPUT_CONTINUATIONS,
  OUTPUT_BOUNDARY_MARKER,
  stripOutputBoundaryMarker,
  stripOutputLimitError,
  stripRuntimeApiError
} from "./cowork-recovery";
import { releaseChromeComputerUse } from "./chrome-computer-use";
import {
  deleteCoworkMessage as deletePersistedCoworkMessage,
  deleteCoworkTask as deletePersistedCoworkTask,
  listCoworkMessages,
  listCoworkTasks,
  saveCoworkMessage,
  saveCoworkTask
} from "./db";

const tasks = new Map<string, CoworkTask>();
const messages = new Map<string, CoworkMessage[]>();
type PersistentRunHandlers = {
  onEvent: (event: AgentRuntimeEvent) => void;
  onStderr: (data: string) => void;
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      suggestions?: AgentPermissionUpdate[];
      blockedPath?: string;
      title?: string;
    }
  ) => Promise<AgentPermissionResult>;
  finish: (exitCode: number, error?: string) => void;
};
type PersistentAgentSession = {
  runtime: AgentRuntime;
  configKey: string;
  current?: PersistentRunHandlers;
};
const persistentAgentSessions = new Map<string, PersistentAgentSession>();
type AgentSessionState = { id?: string; started: boolean };
const agentSessions = new Map<string, AgentSessionState>();
const compactContexts = new Map<string, string>();
type PendingApproval = {
  taskId: string;
  messageId: string;
  approval: CoworkApproval;
  suggestions?: AgentPermissionUpdate[];
  resolve: (result: AgentPermissionResult) => void;
};
const pendingApprovals = new Map<string, PendingApproval>();
const taskAllowedTools = new Map<string, Set<string>>();
const DEFAULT_CONTEXT_TOTAL = 16_384;
const configuredAutoCompactRatio = Number(process.env.LUMEN_AUTO_COMPACT_RATIO || 0.62);
const AUTO_COMPACT_RATIO = Number.isFinite(configuredAutoCompactRatio)
  ? Math.min(0.9, Math.max(0.35, configuredAutoCompactRatio))
  : 0.62;

function runtimeEventAsCoworkMessage(event: AgentRuntimeEvent): Record<string, unknown> {
  if (event.type === "session") {
    return { session_id: event.sessionId };
  }
  if (event.type === "status") {
    const subtype = {
      initializing: "init",
      hooks: "hook_started",
      retrying: "api_retry",
      compacting: "compact_boundary",
      subtask_start: "task_started",
      subtask_progress: "task_progress",
      working: "status"
    }[event.status];
    return {
      type: "system",
      subtype,
      ...(event.error ? { error: { message: event.error } } : {})
    };
  }
  if (event.type === "message_start") {
    return { type: "stream_event", event: { type: "message_start" } };
  }
  if (event.type === "content_start") {
    const contentBlock = event.block.type === "reasoning"
      ? { type: "thinking", thinking: event.block.text }
      : event.block;
    return {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: event.index,
        content_block: contentBlock
      }
    };
  }
  if (event.type === "content_delta") {
    const delta = event.delta.type === "text"
      ? { type: "text_delta", text: event.delta.text }
      : event.delta.type === "reasoning"
        ? { type: "thinking_delta", thinking: event.delta.text }
        : { type: "input_json_delta", partial_json: event.delta.partialJson };
    return {
      type: "stream_event",
      event: { type: "content_block_delta", index: event.index, delta }
    };
  }
  if (event.type === "content_stop") {
    return {
      type: "stream_event",
      event: { type: "content_block_stop", index: event.index }
    };
  }
  if (event.type === "assistant") {
    return {
      type: "assistant",
      parent_tool_use_id: event.parentToolUseId,
      message: {
        usage: event.usage,
        content: event.content.map((block) => (
          block.type === "reasoning"
            ? { type: "thinking", thinking: block.text }
            : block
        ))
      }
    };
  }
  if (event.type === "tool_result") {
    return {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: event.toolUseId,
          content: event.content,
          is_error: event.isError
        }]
      }
    };
  }
  return {
    type: "result",
    subtype: event.subtype || (event.success ? "success" : "error_during_execution"),
    result: event.output,
    error: event.error,
    errors: event.errors,
    usage: event.usage,
    is_error: !event.success
  };
}

function persistTask(task: CoworkTask): void {
  saveCoworkTask(task, agentSessions.get(task.id)?.id, compactContexts.get(task.id));
}

function restoreCoworkState(): void {
  for (const record of listCoworkTasks()) {
    const task = record.task;
    const restoredMessages = listCoworkMessages(task.id).map((message) => {
      if (message.status !== "streaming") return message;
      message.status = "error";
      message.activity = "Task interrupted";
      message.runtimeOutput = [
        message.runtimeOutput,
        "Lumen restarted before this run completed."
      ].filter(Boolean).join("\n");
      message.approvals = message.approvals?.map((approval) => (
        approval.status === "pending" ? { ...approval, status: "denied" as const } : approval
      ));
      saveCoworkMessage(message);
      return message;
    });
    tasks.set(task.id, task);
    messages.set(task.id, restoredMessages);
    if (record.agentSessionId) {
      agentSessions.set(task.id, { id: record.agentSessionId, started: true });
    }
    if (record.compactContext) compactContexts.set(task.id, record.compactContext);
  }
}

function emitApproval(win: BrowserWindow | null, message: CoworkMessage, approval: CoworkApproval): void {
  const existing = message.approvals || [];
  const index = existing.findIndex((item) => item.id === approval.id);
  if (index >= 0) existing[index] = approval;
  else existing.push(approval);
  message.approvals = [...existing];
  saveCoworkMessage(message);
  if (win && !win.isDestroyed()) {
    win.webContents.send("cowork:event", {
      taskId: message.taskId,
      messageId: message.id,
      type: "permission_request",
      approval,
      approvals: message.approvals
    });
  }
}

function cancelTaskApprovals(taskId: string, reason = "Task stopped before approval."): void {
  for (const [id, pending] of pendingApprovals) {
    if (pending.taskId !== taskId) continue;
    pending.approval.status = "denied";
    pending.resolve({ behavior: "deny", message: reason, interrupt: true });
    pendingApprovals.delete(id);
  }
}

function compactTaskContext(taskMessages: CoworkMessage[]): string {
  return taskMessages
    .filter((message) => message.role !== "system" && message.content.trim())
    .slice(-16)
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content.trim().slice(0, 1600)}`)
    .join("\n\n")
    .slice(-12000);
}

function estimateCoworkContext(task: CoworkTask, taskMessages: CoworkMessage[]): number {
  let characters = task.compactedAt ? 11_200 : 0;
  let assistantTurns = 0;
  for (const message of taskMessages) {
    if (message.role === "system" || message.createdAt <= (task.compactedAt || 0)) continue;
    characters += message.content.length + (message.thinking?.length || 0);
    if (message.role !== "assistant") continue;
    assistantTurns += 1;
    for (const toolCall of message.toolCalls || []) {
      characters += JSON.stringify(toolCall.input || {}).length;
      characters += Math.min(48_000, toolCall.output?.length || 0);
    }
  }
  const sdkAndToolSchemaTokens = 6_000;
  return Math.ceil(characters / 3.2) + sdkAndToolSchemaTokens + assistantTurns * 160;
}

function compactCoworkTask(
  task: CoworkTask,
  mode: "manual" | "automatic"
): CoworkMessage {
  const taskId = task.id;
  const agentSession = persistentAgentSessions.get(taskId);
  if (agentSession) {
    agentSession.current = undefined;
    agentSession.runtime.abortController.abort();
    agentSession.runtime.close();
    persistentAgentSessions.delete(taskId);
  }
  compactContexts.set(taskId, compactTaskContext(messages.get(taskId) || []));
  agentSessions.set(taskId, { started: false });
  taskAllowedTools.delete(taskId);
  task.contextUsed = 0;
  task.compactedAt = Date.now();
  task.updatedAt = Date.now();
  const automatic = mode === "automatic";
  const message: CoworkMessage = {
    id: crypto.randomUUID(),
    taskId,
    role: "system",
    content: automatic
      ? "Context automatically compacted before the next turn."
      : "Context compacted. The next turn will continue from a bounded summary.",
    status: "done",
    activity: automatic ? "Context automatically compacted" : "Context compacted",
    createdAt: Date.now()
  };
  const taskMessages = messages.get(taskId) || [];
  taskMessages.push(message);
  messages.set(taskId, taskMessages);
  saveCoworkMessage(message);
  persistTask(task);
  return message;
}

const homeDir = process.env.HOME || os.homedir();
const launchCwd = process.env.PWD;
let defaultCwd =
  launchCwd && launchCwd !== "/" && fs.existsSync(launchCwd)
    ? path.resolve(launchCwd)
    : homeDir;

function resolveWorkingDir(rawPath?: string): string {
  if (!rawPath || rawPath === "~" || rawPath.trim() === "") return homeDir;
  if (rawPath.startsWith("~/")) return path.join(homeDir, rawPath.slice(2));
  try {
    const abs = path.resolve(rawPath);
    if (fs.existsSync(abs)) return abs;
  } catch (e) {}
  return homeDir;
}

function refreshCoworkTitleAfterAnswer(
  win: BrowserWindow | null,
  task: CoworkTask,
  assistant: CoworkMessage,
  settings: Settings
): void {
  if (!assistant.content.trim()) return;
  const taskMessages = messages.get(task.id) || [];
  const userMessages = taskMessages.filter((message) => message.role === "user");
  if (userMessages.length !== 1) return;
  const firstPrompt = userMessages[0].content.trim();
  if (!firstPrompt) return;
  const initialTitle = immediateConversationTitle(firstPrompt);
  if (task.title !== initialTitle) return;
  const taskId = task.id;
  void generateConversationTitle(firstPrompt, assistant.content, settings)
    .then((generatedTitle) => {
      const currentTask = tasks.get(taskId);
      if (!currentTask || currentTask.title !== initialTitle || generatedTitle === initialTitle) return;
      currentTask.title = generatedTitle;
      currentTask.updatedAt = Date.now();
      persistTask(currentTask);
      win?.webContents.send("cowork:event", {
        taskId,
        type: "renamed",
        title: generatedTitle
      });
    })
    .catch(() => undefined);
}

export function shutdownCoworkRuntime(): void {
  for (const session of persistentAgentSessions.values()) {
    session.runtime.abortController.abort();
    session.runtime.close();
  }
  persistentAgentSessions.clear();
  for (const taskId of new Set(Array.from(pendingApprovals.values()).map((item) => item.taskId))) {
    cancelTaskApprovals(taskId, "Lumen is shutting down.");
  }
}

function taskAttachmentDirectory(taskId: string): string {
  const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
  return path.join(app.getPath("userData"), "cowork-attachments", safeTaskId || "task");
}

function materializeCoworkAttachments(taskId: string, attachments: Attachment[]): Attachment[] {
  return attachments.map((attachment) => {
    if (attachment.path || !attachment.dataUrl) return attachment;
    const match = attachment.dataUrl.match(/^data:([^;,]+);base64,([a-zA-Z0-9+/=\s]+)$/);
    if (!match || match[2].length > 36_000_000) return attachment;
    const extensions: Record<string, string> = {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/svg+xml": ".svg"
    };
    const extension = extensions[match[1]] || "";
    if (!extension) return attachment;
    const directory = taskAttachmentDirectory(taskId);
    fs.mkdirSync(directory, { recursive: true });
    const safeId = attachment.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100) || crypto.randomUUID();
    const filePath = path.join(directory, `${safeId}${extension}`);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, Buffer.from(match[2], "base64"));
    return { ...attachment, path: filePath, kind: "image" };
  });
}

function persistentSessionKey(opts: {
  cwd: string;
  model: string;
  effort?: string;
  settings: Settings;
  tools: string[];
}): string {
  return JSON.stringify({
    cwd: opts.cwd,
    model: opts.model,
    engine: opts.settings.coworkEngine,
    effort: opts.effort || "medium",
    permission: opts.settings.coworkPermissionMode,
    plugins: opts.settings.plugins,
    chrome: opts.settings.computerUseChromeEnabled,
    tools: opts.tools
  });
}

function startPersistentAgentRun(opts: {
  win: BrowserWindow | null;
  task: CoworkTask;
  assistant: CoworkMessage;
  checkpointId: string;
  effectivePrompt: string;
  cwd: string;
  model: string;
  effort?: string;
  settings: Settings;
  toolHost: Awaited<ReturnType<typeof ensureToolHost>>;
  permissionMode: Settings["coworkPermissionMode"];
  tools: string[];
  session: AgentSessionState;
  autoCompactAttempt?: number;
  outputContinuationAttempt?: number;
}): void {
  const { win, task, assistant, settings } = opts;
  const taskId = task.id;
  const messageId = assistant.id;
  const startedAt = Date.now();
  const toolCalls = new Map<string, CoworkToolCall>(
    (assistant.toolCalls || []).map((toolCall) => [toolCall.id, toolCall])
  );
  const streamingTools = new Map<number, { id: string; partialJson: string }>();
  const streamingThinking = new Map<number, string>();
  const repeatedToolErrors = new Map<string, number>();
  const trace: CoworkTraceEntry[] = assistant.trace || [];
  const committedText: string[] = assistant.content ? [assistant.content] : [];
  let thinkingText = assistant.thinking || "";
  let partialText = "";
  let finalUsage: ReturnType<typeof parseModelUsage>;
  let finished = false;
  let backendOutputBoundaryReached = false;
  let outputContinuationAttempts = opts.outputContinuationAttempt || 0;
  let persistTimer: NodeJS.Timeout | null = null;
  let textTimer: NodeJS.Timeout | null = null;
  let runtimeTimer: NodeJS.Timeout | null = null;
  let lastTextSentAt = 0;

  assistant.checkpointId = opts.checkpointId;
  assistant.rewindAvailable = false;
  assistant.trace = trace;

  const persistAssistant = (immediate = false) => {
    if (immediate) {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = null;
      saveCoworkMessage(assistant);
      return;
    }
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      saveCoworkMessage(assistant);
    }, 300);
  };
  const send = (event: Record<string, unknown>, persistNow = false) => {
    persistAssistant(persistNow);
    if (win && !win.isDestroyed()) {
      win.webContents.send("cowork:event", { taskId, messageId, ...event });
    }
  };
  const flushText = () => {
    if (textTimer) clearTimeout(textTimer);
    textTimer = null;
    lastTextSentAt = Date.now();
    send({ type: "text", content: assistant.content, activity: assistant.activity });
  };
  const publishText = (immediate = false) => {
    assistant.content = [...committedText, partialText]
      .filter((part) => part.trim())
      .join("\n\n");
    assistant.activity = "Writing";
    if (immediate || Date.now() - lastTextSentAt >= 64) {
      flushText();
    } else if (!textTimer) {
      textTimer = setTimeout(flushText, 64);
    }
  };
  const commitText = (text: string) => {
    const value = stripRuntimeApiError(
      stripOutputBoundaryMarker(stripOutputLimitError(text))
    );
    if (value && committedText.at(-1) !== value) committedText.push(value);
    partialText = "";
    publishText(true);
  };
  const publishActivity = (activity: string) => {
    if (assistant.activity === activity) return;
    assistant.activity = activity;
    send({ type: "activity", activity });
  };
  const publishThinking = (thinking: string) => {
    if (!thinking) return;
    thinkingText = thinking.slice(-48_000);
    assistant.thinking = thinkingText;
    assistant.activity = "Thinking";
    send({ type: "thinking", thinking: thinkingText, trace, activity: assistant.activity });
  };
  const startThinkingTrace = (index: number, initial = "") => {
    const last = trace.at(-1);
    const entry = last?.kind === "thinking" && !last.text
      ? last
      : {
          id: crypto.randomUUID(),
          kind: "thinking" as const,
          text: "",
          createdAt: Date.now()
        };
    entry.text = initial;
    if (entry !== last) trace.push(entry);
    streamingThinking.set(index, entry.id);
    assistant.trace = trace;
    if (initial) publishThinking(`${thinkingText}${initial}`);
    else send({ type: "thinking", thinking: thinkingText, trace, activity: "Thinking" });
  };
  const appendThinkingTrace = (index: number, chunk: string) => {
    let entryId = streamingThinking.get(index);
    if (!entryId) {
      startThinkingTrace(index);
      entryId = streamingThinking.get(index);
    }
    const entry = trace.find((item) => item.id === entryId);
    if (entry) entry.text = `${entry.text || ""}${chunk}`.slice(-24_000);
    publishThinking(`${thinkingText}${chunk}`);
  };
  const recordToolTrace = (toolCall: CoworkToolCall) => {
    if (trace.some((entry) => entry.kind === "tool" && entry.toolCallId === toolCall.id)) return;
    trace.push({
      id: crypto.randomUUID(),
      kind: "tool",
      toolCallId: toolCall.id,
      createdAt: toolCall.startedAt || Date.now()
    });
    assistant.trace = trace;
  };
  const publishTools = (type: "tool_use" | "tool_result", toolCall?: CoworkToolCall) => {
    if (textTimer) flushText();
    assistant.toolCalls = Array.from(toolCalls.values());
    if (type === "tool_use" && toolCall) recordToolTrace(toolCall);
    if (toolCall) assistant.activity = type === "tool_use" ? toolActivity(toolCall) : "Reviewing";
    send(
      { type, toolCall, toolCalls: assistant.toolCalls, trace, activity: assistant.activity },
      type === "tool_result"
    );
  };
  const absorbUsage = (raw: unknown) => {
    const usage = parseModelUsage(raw);
    if (!usage) return;
    finalUsage = usage;
    const used = usage.inputTokens + usage.outputTokens + usage.cacheTokens;
    task.contextUsed = used;
    task.contextTotal = 16384;
    assistant.contextUsed = used;
    assistant.contextTotal = 16384;
    task.updatedAt = Date.now();
    persistTask(task);
    send({ type: "usage", contextUsed: used, contextTotal: 16384 });
  };
  const appendRuntimeOutput = (data: string) => {
    assistant.runtimeOutput = `${assistant.runtimeOutput || ""}${data}`
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
      .slice(-262_144);
    if (!runtimeTimer) {
      runtimeTimer = setTimeout(() => {
        runtimeTimer = null;
        send({ type: "runtime_output", runtimeOutput: assistant.runtimeOutput });
      }, 120);
    }
  };
  const canUseTool: PersistentRunHandlers["canUseTool"] = (toolName, input, options) => {
    if (taskAllowedTools.get(taskId)?.has(toolName)) {
      return Promise.resolve({ behavior: "allow" });
    }
    const id = crypto.randomUUID();
    const approval: CoworkApproval = {
      id,
      taskId,
      toolName,
      title: options.title || `${toolName} requires approval`,
      input,
      blockedPath: options.blockedPath,
      status: "pending",
      createdAt: Date.now()
    };
    emitApproval(win, assistant, approval);
    publishActivity("Waiting for approval");
    return new Promise((resolve) => {
      const abort = () => {
        if (!pendingApprovals.has(id)) return;
        approval.status = "denied";
        emitApproval(win, assistant, approval);
        pendingApprovals.delete(id);
        resolve({ behavior: "deny", message: "Task stopped before approval.", interrupt: true });
      };
      options.signal.addEventListener("abort", abort, { once: true });
      pendingApprovals.set(id, {
        taskId,
        messageId,
        approval,
        suggestions: options.suggestions,
        resolve: (result) => {
          options.signal.removeEventListener("abort", abort);
          resolve(result);
        }
      });
    });
  };

  const configKey = persistentSessionKey(opts);
  let agentSession = persistentAgentSessions.get(taskId);
  if (agentSession && agentSession.configKey !== configKey) {
    agentSession.runtime.abortController.abort();
    agentSession.runtime.close();
    persistentAgentSessions.delete(taskId);
    agentSession = undefined;
  }
  if (agentSession?.current) {
    throw new Error("This Cowork task is already running.");
  }
  if (!agentSession) {
    const holder: PersistentAgentSession = {
      runtime: undefined as unknown as AgentRuntime,
      configKey
    };
    const permissionMode =
      opts.permissionMode === "full" ? "bypassPermissions"
        : opts.permissionMode === "approve" ? "auto"
          : "default";
    holder.runtime = startNativeAgentRuntime({
      prompt: "",
      persistent: true,
      cwd: opts.cwd,
      model: opts.model,
      modelEndpoint: { baseUrl: settings.llamaUrl, apiKey: settings.llamaApiKey },
      effort: opts.effort,
      resume: opts.session.started ? opts.session.id : undefined,
      tools: opts.tools,
      mcpServer: {
        command: process.execPath,
        args: [opts.toolHost.script],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          LUMEN_TOOL_HOST_URL: opts.toolHost.url,
          LUMEN_TOOL_HOST_TOKEN: opts.toolHost.token,
          LUMEN_TOOL_WORKSPACE: opts.cwd,
          LUMEN_PLUGIN_BROWSER: settings.plugins.browser ? "1" : "0",
          LUMEN_PLUGIN_SITES: settings.plugins.sites ? "1" : "0",
          LUMEN_PLUGIN_MANAGEMENT: settings.plugins.plugins ? "1" : "0",
          LUMEN_COMPUTER_USE_CHROME: settings.computerUseChromeEnabled ? "1" : "0"
        }
      },
      env: {
        ...process.env,
        PATH: `${homeDir}/.local/bin:${process.env.PATH || ""}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`,
        HOME: homeDir,
        LANG: "en_US.UTF-8",
        LLAMA_MODEL_ALIAS: opts.model,
        LLAMA_SYSTEM_PROMPT: settings.systemPrompt,
        ELECTRON_RUN_AS_NODE: "1",
        LUMEN_TOOL_HOST_URL: opts.toolHost.url,
        LUMEN_TOOL_HOST_TOKEN: opts.toolHost.token,
        LUMEN_TOOL_WORKSPACE: opts.cwd,
        LUMEN_PLUGIN_BROWSER: settings.plugins.browser ? "1" : "0",
        LUMEN_PLUGIN_SITES: settings.plugins.sites ? "1" : "0",
        LUMEN_PLUGIN_MANAGEMENT: settings.plugins.plugins ? "1" : "0",
        LUMEN_COMPUTER_USE_CHROME: settings.computerUseChromeEnabled ? "1" : "0",
        LUMEN_COWORK_PERMISSION_MODE: opts.permissionMode
      },
      permissionMode,
      canUseTool: permissionMode === "bypassPermissions"
        ? undefined
        : (toolName, input, options) => {
            const current = holder.current;
            if (!current) {
              return Promise.resolve({
                behavior: "deny",
                message: "No active Lumen Cowork turn.",
                interrupt: true
              });
            }
            return current.canUseTool(toolName, input, options);
          },
      onStderr: (data) => holder.current?.onStderr(data),
      onEvent: (runtimeEvent) => holder.current?.onEvent(runtimeEvent)
    });
    holder.runtime.done
      .then(() => {
        holder.current?.finish(1, "Agent runtime ended without a terminal result.");
      })
      .catch((error) => {
        holder.current?.finish(1, error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (persistentAgentSessions.get(taskId) === holder) {
          persistentAgentSessions.delete(taskId);
        }
      });
    agentSession = holder;
    persistentAgentSessions.set(taskId, holder);
  }

  const finish = (exitCode: number, error?: string) => {
    if (finished) return;
    if (error && recoverFromOutputLimit(error)) return;
    finished = true;
    if (error) {
      appendRuntimeOutput(
        isOutputLimitError(error)
          ? "Automatic continuation stopped after 3 attempts.\n"
          : `${error}\n`
      );
    }
    cancelTaskApprovals(taskId, "Agent run ended before approval.");
    assistant.status = exitCode === 0 ? "done" : "error";
    assistant.activity = exitCode === 0 ? "Completed" : "Task failed";
    assistant.durationSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    if (textTimer) {
      clearTimeout(textTimer);
      textTimer = null;
    }
    if (runtimeTimer) {
      clearTimeout(runtimeTimer);
      runtimeTimer = null;
    }
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    task.updatedAt = Date.now();
    const estimatedContext = estimateCoworkContext(task, messages.get(taskId) || []);
    task.contextUsed = Math.max(task.contextUsed || 0, estimatedContext);
    assistant.contextUsed = task.contextUsed;
    assistant.contextTotal = task.contextTotal || DEFAULT_CONTEXT_TOTAL;
    if (finalUsage) {
      recordTokenUsage(
        finalUsage.inputTokens,
        finalUsage.outputTokens,
        finalUsage.cacheTokens,
        opts.model
      );
    }
    persistTask(task);
    send({
      type: "done",
      content: assistant.content,
      thinking: assistant.thinking,
      toolCalls: assistant.toolCalls,
      trace: assistant.trace,
      approvals: assistant.approvals,
      runtimeOutput: assistant.runtimeOutput,
      contextUsed: task.contextUsed,
      contextTotal: task.contextTotal || 16384,
      durationSeconds: assistant.durationSeconds,
      exitCode
    }, true);
    if ((assistant.toolCalls || []).some((tool) => /__(?:browser|chrome)_/.test(tool.name))) {
      void releaseChromeComputerUse();
    }
    if (exitCode === 0) refreshCoworkTitleAfterAnswer(win, task, assistant, settings);
    const currentSession = persistentAgentSessions.get(taskId);
    if (currentSession) currentSession.current = undefined;
    if (exitCode === 0) {
      void agentSession!.runtime
        .rewindFiles(opts.checkpointId, { dryRun: true })
        .then((result) => {
          assistant.rewindAvailable = result.canRewind;
          saveCoworkMessage(assistant);
          send({ type: "checkpoint", rewindAvailable: assistant.rewindAvailable });
        })
        .catch(() => {
          assistant.rewindAvailable = false;
          saveCoworkMessage(assistant);
        });
    }
  };

  const recoverFromContextOverflow = () => {
    if (finished || (opts.autoCompactAttempt || 0) >= 1) return false;
    finished = true;
    const previousRuntimeDone = agentSession?.runtime.done.catch(() => undefined);
    if (textTimer) clearTimeout(textTimer);
    if (runtimeTimer) clearTimeout(runtimeTimer);
    if (persistTimer) clearTimeout(persistTimer);
    textTimer = null;
    runtimeTimer = null;
    persistTimer = null;
    cancelTaskApprovals(taskId, "Context was compacted before retrying.");
    assistant.content = stripRuntimeApiError(assistant.content);
    assistant.activity = "Compacting context";
    assistant.runtimeOutput = `${assistant.runtimeOutput || ""}\nContext automatically compacted; continuing the same task.\n`;
    saveCoworkMessage(assistant);
    send({
      type: "activity",
      activity: assistant.activity,
      runtimeOutput: assistant.runtimeOutput
    }, true);
    compactCoworkTask(task, "automatic");
    const compactedContext = compactContexts.get(taskId) || "";
    const completedTools = (assistant.toolCalls || []).slice(-8).map((tool) => ({
      name: tool.name,
      status: tool.status,
      input: tool.input,
      output: tool.output?.slice(-400)
    }));
    const recoveryPrompt = [
      `<compacted_context>\n${compactedContext.slice(0, 1600)}\n</compacted_context>`,
      `<completed_tools>\n${JSON.stringify(completedTools).slice(-1800)}\n</completed_tools>`,
      `<original_task_tail>\n${opts.effectivePrompt.slice(-1800)}\n</original_task_tail>`,
      "<context_recovery>Continue from the next unfinished action. Do not repeat completed tool calls. If all requested actions completed, give only the concise final result.</context_recovery>"
    ].join("\n\n");
    const restart = () => {
      try {
        startPersistentAgentRun({
          ...opts,
          effectivePrompt: recoveryPrompt,
          session: { started: false },
          autoCompactAttempt: (opts.autoCompactAttempt || 0) + 1
        });
        compactContexts.delete(taskId);
        persistTask(task);
      } catch (error) {
        assistant.status = "error";
        assistant.activity = "Task failed";
        assistant.runtimeOutput = `${assistant.runtimeOutput || ""}${error instanceof Error ? error.message : String(error)}\n`;
        saveCoworkMessage(assistant);
        if (win && !win.isDestroyed()) {
          win.webContents.send("cowork:event", {
            taskId,
            messageId,
            type: "done",
            content: assistant.content,
            thinking: assistant.thinking,
            toolCalls: assistant.toolCalls,
            trace: assistant.trace,
            runtimeOutput: assistant.runtimeOutput,
            contextUsed: task.contextUsed,
            contextTotal: task.contextTotal || DEFAULT_CONTEXT_TOTAL,
            exitCode: 1
          });
        }
      }
    };
    void Promise.race([
      previousRuntimeDone || Promise.resolve(),
      new Promise<void>((resolve) => setTimeout(resolve, 750))
    ]).then(restart);
    return true;
  };
  function continueFromOutputBoundary(reason: "backend" | "sdk"): boolean {
    if (
      finished ||
      outputContinuationAttempts >= MAX_OUTPUT_CONTINUATIONS
    ) return false;
    outputContinuationAttempts += 1;
    assistant.content = stripOutputBoundaryMarker(stripOutputLimitError(assistant.content));
    for (let index = 0; index < committedText.length; index += 1) {
      committedText[index] = stripOutputBoundaryMarker(stripOutputLimitError(committedText[index]));
    }
    partialText = stripOutputBoundaryMarker(stripOutputLimitError(partialText));
    const cleanRuntimeOutput = stripOutputLimitError(assistant.runtimeOutput || "");
    assistant.runtimeOutput = cleanRuntimeOutput ? `${cleanRuntimeOutput}\n` : "";
    assistant.activity = "Continuing";
    appendRuntimeOutput(
      `${reason === "backend" ? "Local output segment completed" : "Output limit reached"}; automatically continuing unfinished work (${outputContinuationAttempts}/${MAX_OUTPUT_CONTINUATIONS}).\n`
    );
    send({
      type: "activity",
      activity: assistant.activity,
      content: assistant.content,
      runtimeOutput: assistant.runtimeOutput
    }, true);
    finished = true;
    if (textTimer) clearTimeout(textTimer);
    if (runtimeTimer) clearTimeout(runtimeTimer);
    if (persistTimer) clearTimeout(persistTimer);
    textTimer = null;
    runtimeTimer = null;
    persistTimer = null;
    const previousSession = agentSession!;
    previousSession.current = undefined;
    if (persistentAgentSessions.get(taskId) === previousSession) {
      persistentAgentSessions.delete(taskId);
    }
    previousSession.runtime.close();
    const completedTools = (assistant.toolCalls || []).map((tool) => ({
      name: tool.name,
      status: tool.status,
      input: tool.input,
      output: tool.output?.slice(-2000)
    }));
    const recoveryPrompt = buildOutputRecoveryPrompt({
      effectivePrompt: opts.effectivePrompt,
      assistantContent: assistant.content,
      assistantThinking: assistant.thinking,
      completedTools
    });
    setTimeout(() => {
      try {
        startPersistentAgentRun({
          ...opts,
          effectivePrompt: recoveryPrompt,
          session: { started: false },
          outputContinuationAttempt: outputContinuationAttempts
        });
      } catch (error) {
        assistant.status = "error";
        assistant.activity = "Task failed";
        assistant.runtimeOutput = `${assistant.runtimeOutput || ""}${error instanceof Error ? error.message : String(error)}\n`;
        saveCoworkMessage(assistant);
        if (win && !win.isDestroyed()) {
          win.webContents.send("cowork:event", {
            taskId,
            messageId,
            type: "done",
            content: assistant.content,
            thinking: assistant.thinking,
            toolCalls: assistant.toolCalls,
            trace: assistant.trace,
            runtimeOutput: assistant.runtimeOutput,
            contextUsed: task.contextUsed,
            contextTotal: task.contextTotal || DEFAULT_CONTEXT_TOTAL,
            exitCode: 1
          });
        }
      }
    }, 0);
    return true;
  }

  function recoverFromOutputLimit(source: unknown): boolean {
    if (!isOutputLimitError(source)) return false;
    return continueFromOutputBoundary("sdk");
  }

  const handleStderr = (data: string) => {
    appendRuntimeOutput(data);
    recoverFromOutputLimit(data);
  };

  const onEvent = (event: AgentRuntimeEvent) => {
    const message = runtimeEventAsCoworkMessage(event) as any;
    if (message.session_id) {
      agentSessions.set(taskId, { id: message.session_id, started: true });
      persistTask(task);
    }
    if (message.type === "system") {
      if (message.subtype === "init") publishActivity("Initializing");
      else if (message.subtype === "hook_started") publishActivity("Running hooks");
      else if (message.subtype === "api_retry") {
        const retryError = message.error?.message || "Model request retry";
        publishActivity("Retrying");
        appendRuntimeOutput(`${retryError}\n`);
        recoverFromOutputLimit(retryError);
      } else if (message.subtype === "compact_boundary") publishActivity("Compacting context");
      else if (message.subtype === "task_started") publishActivity("Starting subtask");
      else if (message.subtype === "task_progress") publishActivity("Running subtask");
      else if (message.subtype === "status") publishActivity("Working");
      return;
    }
    if (message.type === "stream_event" && message.event) {
      const event = message.event;
      const index = Number(event.index ?? -1);
      if (event.type === "message_start") {
        partialText = "";
      } else if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block?.type === "tool_use") {
          const id = block.id || crypto.randomUUID();
          const toolCall: CoworkToolCall = toolCalls.get(id) || {
            id,
            name: block.name || "Tool",
            input: block.input || {},
            status: "running",
            startedAt: Date.now()
          };
          toolCalls.set(id, toolCall);
          streamingTools.set(index, { id, partialJson: "" });
          publishTools("tool_use", toolCall);
        } else if (block?.type === "thinking") {
          const initialThinking = block.thinking || block.text || "";
          startThinkingTrace(index, initialThinking);
        }
      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          if (delta.text.includes(OUTPUT_BOUNDARY_MARKER)) {
            backendOutputBoundaryReached = true;
          }
          partialText += stripOutputBoundaryMarker(delta.text);
          publishText();
        } else if (delta?.type === "thinking_delta") {
          const thinking = delta.thinking || delta.text || delta.reasoning_content || "";
          if (thinking) appendThinkingTrace(index, thinking);
          else publishActivity("Thinking");
        } else if (delta?.type === "input_json_delta") {
          const streamed = streamingTools.get(index);
          if (streamed) {
            streamed.partialJson += delta.partial_json || "";
            const toolCall = toolCalls.get(streamed.id);
            if (toolCall) {
              try {
                toolCall.input = JSON.parse(streamed.partialJson);
              } catch {
                toolCall.input = { partial: streamed.partialJson };
              }
            }
          }
        }
      } else if (event.type === "content_block_stop") {
        streamingThinking.delete(index);
        const streamed = streamingTools.get(index);
        if (streamed) {
          streamingTools.delete(index);
          const toolCall = toolCalls.get(streamed.id);
          if (toolCall) publishTools("tool_use", toolCall);
        }
      }
      return;
    }
    if (message.type === "assistant" && Array.isArray(message.message?.content)) {
      absorbUsage(message.message.usage);
      const thinking = message.message.content
        .filter((block: any) => block.type === "thinking")
        .map((block: any) => block.thinking || block.text || "")
        .join("\n\n");
      if (thinking && thinking.length >= thinkingText.length) publishThinking(thinking);
      const text = message.message.content
        .filter((block: any) => block.type === "text" && block.text)
        .map((block: any) => block.text)
        .join("\n\n");
      if (text.includes(OUTPUT_BOUNDARY_MARKER)) {
        backendOutputBoundaryReached = true;
      }
      const visibleText = stripOutputBoundaryMarker(text);
      if (message.parent_tool_use_id) {
        if (visibleText) appendRuntimeOutput(`[Subagent]\n${visibleText}\n`);
        return;
      }
      if (visibleText || partialText) commitText(visibleText || partialText);
      for (const block of message.message.content) {
        if (block.type !== "tool_use") continue;
        const id = block.id || crypto.randomUUID();
        const toolCall: CoworkToolCall = toolCalls.get(id) || {
          id,
          name: block.name || "Tool",
          input: block.input || {},
          status: "running",
          startedAt: Date.now()
        };
        toolCall.name = block.name || toolCall.name;
        toolCall.input = block.input || toolCall.input;
        toolCalls.set(id, toolCall);
        publishTools("tool_use", toolCall);
      }
      return;
    }
    if (message.type === "user" && Array.isArray(message.message?.content)) {
      for (const block of message.message.content) {
        if (block.type !== "tool_result" || !block.tool_use_id) continue;
        const toolCall = toolCalls.get(block.tool_use_id);
        if (!toolCall) continue;
        toolCall.status = block.is_error ? "error" : "completed";
        toolCall.completedAt = Date.now();
        const toolOutput = (
          typeof block.content === "string" ? block.content : JSON.stringify(block.content, null, 2)
        ).slice(-262_144);
        toolCall.output = toolOutput;
        publishTools("tool_result", toolCall);
        if (block.is_error) {
          const errorKey = `${toolCall.name}:${toolOutput.slice(-400)}`;
          const attempts = (repeatedToolErrors.get(errorKey) || 0) + 1;
          repeatedToolErrors.set(errorKey, attempts);
          if (attempts >= 3) {
            void agentSession?.runtime.interrupt().catch(() => undefined);
            finish(1, `Stopped after 3 identical ${toolCall.name} errors: ${toolOutput.slice(-240)}`);
            return;
          }
        } else {
          for (const key of repeatedToolErrors.keys()) {
            if (key.startsWith(`${toolCall.name}:`)) repeatedToolErrors.delete(key);
          }
        }
      }
      return;
    }
    if (message.type === "result") {
      const transientBackendFailure =
        isTransientBackendError(message.result) ||
        isTransientBackendError(message.error) ||
        isTransientBackendError(message.errors);
      if (
        !assistant.content &&
        typeof message.result === "string" &&
        !message.is_error &&
        !transientBackendFailure
      ) {
        commitText(message.result);
      }
      absorbUsage(message.usage);
      if (backendOutputBoundaryReached) {
        if (continueFromOutputBoundary("backend")) return;
        appendRuntimeOutput(
          `Automatic continuation stopped after ${MAX_OUTPUT_CONTINUATIONS} attempts.\n`
        );
        finish(1);
        return;
      }
      if (
        recoverFromOutputLimit(message.result) ||
        recoverFromOutputLimit(message.error) ||
        recoverFromOutputLimit(message.errors)
      ) {
        return;
      }
      if (
        isContextOverflowError(message.result) ||
        isContextOverflowError(message.error) ||
        isContextOverflowError(message.errors)
      ) {
        if (recoverFromContextOverflow()) return;
      }
      if (Array.isArray(message.errors) && message.errors.length) {
        const visibleErrors = message.errors.filter((error: unknown) => !isOutputLimitError(error));
        if (visibleErrors.length) appendRuntimeOutput(`${visibleErrors.join("\n")}\n`);
      }
      if (transientBackendFailure) {
        assistant.content = settings.language === "zh"
          ? "本地模型连接中断，Lumen 已自动重试三次但仍未恢复。请重新发送这一轮消息。"
          : "The local model connection was interrupted. Lumen retried three times but could not recover; please resend this turn.";
      }
      finish(message.subtype === "success" && !message.is_error ? 0 : 1);
    }
  };

  agentSession.current = {
    onEvent,
    onStderr: handleStderr,
    canUseTool,
    finish
  };
  agentSession.runtime.send(opts.effectivePrompt, opts.checkpointId);
}

async function workspaceInfo(rawPath?: string): Promise<WorkspaceInfo> {
  const cwd = resolveWorkingDir(rawPath);
  const git = (args: string[]): Promise<string | null> => new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout: 2500, encoding: "utf8" },
      (error, stdout) => resolve(error ? null : stdout.trim() || null)
    );
  });
  const [branch, numstat, untracked, remote] = await Promise.all([
    git(["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(["diff", "--numstat", "HEAD"]),
    git(["ls-files", "--others", "--exclude-standard"]),
    git(["remote"])
  ]);
  let additions = 0;
  let deletions = 0;
  let trackedFiles = 0;
  for (const line of numstat?.split("\n").filter(Boolean) || []) {
    const [added, deleted] = line.split(/\s+/);
    additions += Number.isFinite(Number(added)) ? Number(added) : 0;
    deletions += Number.isFinite(Number(deleted)) ? Number(deleted) : 0;
    trackedFiles += 1;
  }
  const untrackedFiles = untracked?.split("\n").filter(Boolean).length || 0;
  return {
    cwd,
    name: path.basename(cwd) || cwd,
    branch,
    location: "Local",
    changes: {
      files: trackedFiles + untrackedFiles,
      additions,
      deletions
    },
    hasRemote: Boolean(remote)
  };
}

let coworkIpcRegistered = false;

function stopCoworkTask(taskId: string): boolean {
  let stopped = false;
  const session = persistentAgentSessions.get(taskId);
  if (session?.current) {
    void session.runtime.interrupt().catch(() => undefined);
    session.current.finish(1, "Stopped by user.");
    stopped = true;
  }
  cancelTaskApprovals(taskId);
  return stopped;
}

export function registerCoworkIpc(): void {
  if (coworkIpcRegistered) return;
  coworkIpcRegistered = true;
  restoreCoworkState();

  ipcMain.handle("cowork:getHome", () => defaultCwd);
  ipcMain.handle("cowork:workspaceInfo", (_event, cwd?: string) => workspaceInfo(cwd));
  ipcMain.handle("cowork:listTasks", () => (
    Array.from(tasks.values()).sort((a, b) => b.updatedAt - a.updatedAt)
  ));
  ipcMain.handle("cowork:createTask", (_event, opts: { title?: string; cwd?: string } = {}) => {
    const now = Date.now();
    const settings = getSettings();
    const task: CoworkTask = {
      id: crypto.randomUUID(),
      title: opts.title || "新任务",
      cwd: resolveWorkingDir(opts.cwd),
      engine: settings.coworkEngine,
      contextUsed: 0,
      contextTotal: 16384,
      createdAt: now,
      updatedAt: now
    };
    tasks.set(task.id, task);
    messages.set(task.id, []);
    persistTask(task);
    return task;
  });
  ipcMain.handle("cowork:getMessages", (_event, taskId: string) => messages.get(taskId) || []);
  ipcMain.handle("cowork:deleteTask", (_event, taskId: string) => {
    stopCoworkTask(taskId);
    const agentSession = persistentAgentSessions.get(taskId);
    if (agentSession) {
      agentSession.runtime.abortController.abort();
      agentSession.runtime.close();
      persistentAgentSessions.delete(taskId);
    }
    tasks.delete(taskId);
    messages.delete(taskId);
    agentSessions.delete(taskId);
    compactContexts.delete(taskId);
    taskAllowedTools.delete(taskId);
    deletePersistedCoworkTask(taskId);
    fs.rmSync(taskAttachmentDirectory(taskId), { recursive: true, force: true });
    return true;
  });
  ipcMain.handle("cowork:setGoal", (_event, taskId: string, rawGoal: string) => {
    const task = tasks.get(taskId);
    if (!task) throw new Error("Cowork task not found.");
    const goal = rawGoal.trim().slice(0, 4000);
    if (!goal) throw new Error("Goal cannot be empty.");
    task.goal = goal;
    task.updatedAt = Date.now();
    const message: CoworkMessage = {
      id: crypto.randomUUID(),
      taskId,
      role: "system",
      content: `Goal set: ${goal}`,
      status: "done",
      activity: "Goal updated",
      createdAt: Date.now()
    };
    const taskMessages = messages.get(taskId) || [];
    taskMessages.push(message);
    messages.set(taskId, taskMessages);
    saveCoworkMessage(message);
    persistTask(task);
    return { task, message };
  });
  ipcMain.handle("cowork:compact", (_event, taskId: string) => {
    const task = tasks.get(taskId);
    if (!task) throw new Error("Cowork task not found.");
    const message = compactCoworkTask(task, "manual");
    return { task, message };
  });
  ipcMain.handle("cowork:selectDirectory", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
      title: "选择工程目录 (Working Directory)"
    });
    if (result.canceled || !result.filePaths[0]) return null;
    defaultCwd = result.filePaths[0];
    return defaultCwd;
  });
  ipcMain.handle("cowork:stop", (_event, taskId: string) => stopCoworkTask(taskId));
  ipcMain.handle("cowork:rewind", async (_event, taskId: string, messageId: string, dryRun = false) => {
    const message = (messages.get(taskId) || []).find((item) => item.id === messageId);
    if (!message?.checkpointId) {
      return { canRewind: false, error: "This turn has no file checkpoint." };
    }
    const agentSession = persistentAgentSessions.get(taskId);
    if (!agentSession || agentSession.current) {
      return {
        canRewind: false,
        error: agentSession ? "Stop the running turn before rewinding." : "The task session must be open to rewind files."
      };
    }
    try {
      const result = await agentSession.runtime.rewindFiles(message.checkpointId, { dryRun });
      if (!dryRun && result.canRewind) {
        message.rewindAvailable = false;
        message.activity = "Files restored";
        saveCoworkMessage(message);
      }
      return result;
    } catch (error) {
      return {
        canRewind: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
  ipcMain.handle(
    "cowork:resolveApproval",
    (event, requestId: string, decision: CoworkApprovalDecision) => {
      if (!["allow_once", "allow_session", "deny"].includes(decision)) {
        throw new Error("Invalid Cowork approval decision.");
      }
      const pending = pendingApprovals.get(requestId);
      if (!pending) return false;
      pendingApprovals.delete(requestId);
      pending.approval.status = decision === "deny" ? "denied" : "allowed";
      const message = (messages.get(pending.taskId) || [])
        .find((item) => item.id === pending.messageId);
      if (message) {
        emitApproval(BrowserWindow.fromWebContents(event.sender), message, pending.approval);
      }
      if (decision === "deny") {
        pending.resolve({
          behavior: "deny",
          message: "The user denied this action.",
          interrupt: false
        });
        return true;
      }
      if (decision === "allow_session") {
        const allowed = taskAllowedTools.get(pending.taskId) || new Set<string>();
        allowed.add(pending.approval.toolName);
        taskAllowedTools.set(pending.taskId, allowed);
      }
      const updatedPermissions = decision === "allow_session"
        ? pending.suggestions?.map((suggestion) => ({ ...suggestion, destination: "session" })) as AgentPermissionUpdate[] | undefined
        : undefined;
      pending.resolve({ behavior: "allow", updatedPermissions });
      return true;
    }
  );
  ipcMain.handle("cowork:run", async (event, opts: {
    taskId: string;
    prompt: string;
    attachments?: Attachment[];
    cwd?: string;
    effort?: string;
    model?: string;
    regenerateMessageId?: string;
  }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    let settings = getSettings();
    const existingMessages = messages.get(opts.taskId) || [];
    const regenerateIndex = opts.regenerateMessageId
      ? existingMessages.findIndex(
          (message) => message.id === opts.regenerateMessageId && message.role === "assistant"
        )
      : -1;
    const replacedAssistant = regenerateIndex >= 0 ? existingMessages[regenerateIndex] : undefined;
    let latestAssistantIndex = -1;
    for (let index = existingMessages.length - 1; index >= 0; index -= 1) {
      if (existingMessages[index].role === "assistant") {
        latestAssistantIndex = index;
        break;
      }
    }
    if (opts.regenerateMessageId && regenerateIndex !== latestAssistantIndex) {
      throw new Error("Only the latest Cowork result can be regenerated.");
    }
    let sourceUser: CoworkMessage | undefined;
    for (let index = regenerateIndex - 1; index >= 0; index -= 1) {
      if (existingMessages[index].role === "user") {
        sourceUser = existingMessages[index];
        break;
      }
    }
    if (opts.regenerateMessageId && !sourceUser) {
      throw new Error("The user task for this Cowork result was not found.");
    }
    if (opts.regenerateMessageId && persistentAgentSessions.get(opts.taskId)?.current) {
      throw new Error("Stop the running Cowork task before regenerating.");
    }
    const isRegeneration = Boolean(sourceUser);
    const attachments = isRegeneration
      ? sourceUser!.attachments || []
      : materializeCoworkAttachments(opts.taskId, opts.attachments || []);
    const prompt = isRegeneration ? sourceUser!.content.trim() : opts.prompt.trim();
    if (!prompt && attachments.length === 0) {
      throw new Error("Cowork prompt cannot be empty.");
    }
    const llamaStatus = await ensureLocalLlama(settings);
    if (!llamaStatus.online) {
      throw new Error("模型服务未就绪，请先按 Settings → Models 的步骤启动 llama-server。");
    }
    if (llamaStatus.managed && llamaStatus.url !== settings.llamaUrl) {
      settings = {
        ...settings,
        llamaUrl: llamaStatus.url,
        llamaPort: llamaStatus.port || settings.llamaPort
      };
    }
    if (
      llamaStatus.runningModelPath &&
      llamaStatus.runningModel &&
      llamaStatus.runningModel !== settings.model
    ) {
      throw new Error(
        llamaStatus.error || `当前服务加载的是 ${llamaStatus.runningModel}，不是所选 ${settings.model}。`
      );
    }

    const resolvedCwd = resolveWorkingDir(opts.cwd || defaultCwd);
    let task = tasks.get(opts.taskId);
    if (!task) {
      const now = Date.now();
      task = {
        id: opts.taskId,
        title: prompt.slice(0, 16) || "新任务",
        cwd: resolvedCwd,
        engine: settings.coworkEngine,
        contextUsed: 0,
        contextTotal: 16384,
        createdAt: now,
        updatedAt: now
      };
      tasks.set(task.id, task);
      messages.set(task.id, []);
    } else {
      task.cwd = resolvedCwd;
      task.engine = settings.coworkEngine;
      task.updatedAt = Date.now();
    }

    const taskMessages = messages.get(task.id) || [];
    if (isRegeneration) {
      const index = taskMessages.findIndex((message) => message.id === opts.regenerateMessageId);
      if (index < 0) throw new Error("Cowork result to regenerate was not found.");
      taskMessages.splice(index, 1);
      deletePersistedCoworkMessage(opts.regenerateMessageId!);
      const staleSession = persistentAgentSessions.get(task.id);
      if (staleSession) {
        staleSession.runtime.abortController.abort();
        staleSession.runtime.close();
        persistentAgentSessions.delete(task.id);
      }
      agentSessions.set(task.id, { started: false });
    }

    const contextTotal = task.contextTotal || DEFAULT_CONTEXT_TOTAL;
    const estimatedContext = estimateCoworkContext(task, taskMessages);
    task.contextUsed = Math.max(task.contextUsed || 0, estimatedContext);
    if (
      (task.contextUsed || 0) >= contextTotal * AUTO_COMPACT_RATIO &&
      (messages.get(task.id) || []).some(
        (message) => message.role !== "system" && message.createdAt > (task.compactedAt || 0)
      )
    ) {
      compactCoworkTask(task, "automatic");
    }

    if (!isRegeneration && !taskMessages.some((message) => message.role === "user") && prompt) {
      const initialTitle = immediateConversationTitle(prompt);
      task.title = initialTitle;
      persistTask(task);
      win?.webContents.send("cowork:event", {
        taskId: task.id,
        type: "renamed",
        title: task.title
      });
    }

    const userMessage: CoworkMessage = sourceUser || {
      id: crypto.randomUUID(),
      taskId: task.id,
      role: "user",
      content: prompt,
      attachments,
      createdAt: Date.now()
    };
    const assistant: CoworkMessage = {
      id: crypto.randomUUID(),
      taskId: task.id,
      role: "assistant",
      content: "",
      runtimeOutput: "",
      toolCalls: [],
      approvals: [],
      status: "streaming",
      activity: "Planning",
      contextUsed: task.contextUsed || 0,
      contextTotal: task.contextTotal || 16384,
      createdAt: Date.now() + 1
    };
    if (!isRegeneration) taskMessages.push(userMessage);
    taskMessages.push(assistant);
    messages.set(task.id, taskMessages);
    if (!isRegeneration) saveCoworkMessage(userMessage);
    saveCoworkMessage(assistant);
    persistTask(task);

    const compactedContext = compactContexts.get(task.id);
    const regenerationHistory = isRegeneration
      ? taskMessages
          .filter((message) => message.id !== sourceUser!.id && message.role !== "system" && message.content.trim())
          .slice(-8)
          .map((message) => `${message.role}: ${message.content.slice(0, 1200)}`)
          .join("\n\n")
      : "";
    const attachmentBlock = attachments.length
      ? `<attachments>\n${attachments
          .map((file) => `- ${file.path || file.name}${file.relativePath ? ` (${file.relativePath})` : ""}`)
          .join("\n")}\nUse these user-selected local files or folders as task inputs. Read them only as needed.\n</attachments>`
      : "";
    const effectivePrompt = [
      settings.coworkInstructions.trim()
        ? `<custom_instructions>\n${settings.coworkInstructions.trim()}\n</custom_instructions>`
        : "",
      task.goal
        ? `<active_goal>\n${task.goal}\nKeep this goal active until it is achieved or explicitly replaced.</active_goal>`
        : "",
      compactedContext
        ? `<compacted_context>\n${compactedContext}\n</compacted_context>`
        : "",
      regenerationHistory
        ? `<recent_task_history>\n${regenerationHistory}\n</recent_task_history>`
        : "",
      "<reasoning_discipline>Use the shortest sufficient reasoning. Never repeat a completed check or restart an established approach. Never call Glob, Grep, Read, or any other tool with the exact same input twice in one turn; reuse the existing result. After the same operation fails twice, stop retrying and report the exact blocker.</reasoning_discipline>",
      "<execution_budget>Keep every model response below 20000 output tokens. For large work, execute in small phases: inspect only what the phase needs, write each completed phase directly to files, verify it, then continue. Never accumulate the entire implementation in one response or dump complete file contents into the final answer. Report concise outcomes and file paths.</execution_budget>",
      "<lumen_agent>Lumen Cowork uses Lumen's native code-agent runtime with local OpenAI-compatible inference. Use Lumen tools directly.</lumen_agent>",
      isRegeneration
        ? "<regeneration>Regenerate the latest result for the same user task. Re-check the current workspace state, use tools whenever the task requires them, and produce a fresh verified result.</regeneration>"
        : "",
      "<web_research>When the user asks for public-web research or current information, use mcp__lumen__web_search. Run distinct precise queries as needed, then use Browser only to inspect selected results. Search queries and results are retained as task Sources.</web_research>",
      attachmentBlock,
      prompt
    ].filter(Boolean).join("\n\n");
    const selectedModel = opts.model || settings.model;
    const session = agentSessions.get(task.id) || { started: false };
    const tools = [
      "Bash",
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "Task",
      "TaskOutput",
      "TaskStop",
      "mcp__lumen__web_search",
      "mcp__lumen__browser_open",
      "mcp__lumen__browser_snapshot",
      "mcp__lumen__browser_click",
      "mcp__lumen__browser_type",
      "mcp__lumen__browser_screenshot",
      "mcp__lumen__browser_console",
      "mcp__lumen__browser_network",
      "mcp__lumen__sites_preview",
      "mcp__lumen__sites_status",
      "mcp__lumen__plugins_list",
      "mcp__lumen__skills_list",
      "mcp__lumen__skills_read",
      "mcp__lumen__chrome_open",
      "mcp__lumen__chrome_snapshot",
      "mcp__lumen__chrome_click",
      "mcp__lumen__chrome_type",
      "mcp__lumen__chrome_screenshot",
      "mcp__lumen__chrome_console",
      "mcp__lumen__chrome_network"
    ].filter((tool) => {
      if (tool.includes("__browser_")) return settings.plugins.browser;
      if (tool.includes("__sites_")) {
        return settings.plugins.sites && settings.computerUseChromeEnabled;
      }
      if (tool.includes("__plugins_")) return settings.plugins.plugins;
      if (tool.includes("__chrome_")) return settings.computerUseChromeEnabled;
      return true;
    });

    try {
      const toolHost = await ensureToolHost();
      if (compactedContext) compactContexts.delete(task.id);
      startPersistentAgentRun({
        win,
        task,
        assistant,
        checkpointId: userMessage.id,
        effectivePrompt,
        cwd: resolvedCwd,
        model: selectedModel,
        effort: opts.effort || settings.defaultEffort,
        settings,
        toolHost,
        permissionMode: settings.coworkPermissionMode,
        tools,
        session
      });
      return {
        ok: true,
        taskId: task.id,
        userMsgId: userMessage.id,
        asstMsgId: assistant.id
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      assistant.status = "error";
      assistant.activity = "Task failed";
      assistant.content = `启动失败: ${reason}`;
      if (isRegeneration && replacedAssistant) {
        const failedIndex = taskMessages.findIndex((message) => message.id === assistant.id);
        if (failedIndex >= 0) taskMessages.splice(failedIndex, 1);
        taskMessages.push(replacedAssistant);
        deletePersistedCoworkMessage(assistant.id);
        saveCoworkMessage(replacedAssistant);
        messages.set(task.id, taskMessages);
      } else {
        saveCoworkMessage(assistant);
      }
      win?.webContents.send("cowork:event", {
        taskId: task.id,
        messageId: assistant.id,
        type: "error",
        error: reason
      });
      return {
        ok: false,
        taskId: task.id,
        userMsgId: userMessage.id,
        asstMsgId: assistant.id,
        error: reason
      };
    }
  });
}
