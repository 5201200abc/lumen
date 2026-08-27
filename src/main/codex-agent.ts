import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { execFile, spawn, type ChildProcess } from "child_process";
import crypto from "node:crypto";
import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import type { Attachment, CodexMessage, CodexTask, CodexToolCall, CoworkEngine, Settings, WorkspaceInfo } from "@shared/types";
import { detectReasoningControl } from "@shared/types";
import { toolActivity } from "@shared/cowork-status";
import { generateConversationTitle } from "./title";
import { getSettings, SYSTEM_PROMPT_PATH } from "./store";
import { probeLlama } from "./models";
import { ensureToolHost } from "./tool-host";
import { recordTokenUsage } from "./usage";

const tasks = new Map<string, CodexTask>();
const messages = new Map<string, CodexMessage[]>();
const activeProcesses = new Map<string, ChildProcess>();
const codexSessions = new Map<string, string>();
type ClaudeSessionState = { id: string; started: boolean };
const claudeSessions = new Map<string, ClaudeSessionState>();
const compactContexts = new Map<string, string>();
let bridgeProcess: ChildProcess | null = null;
let bridgeStartup: Promise<void> | null = null;
let bridgeConfig = "";
let codexBridgeProcess: ChildProcess | null = null;
let codexBridgeStartup: Promise<void> | null = null;
let codexBridgeConfig = "";
const CLAUDE_BRIDGE_URL = "http://127.0.0.1:18086";
const CODEX_BRIDGE_URL = "http://127.0.0.1:18085";

function compactTaskContext(taskMessages: CodexMessage[]): string {
  return taskMessages
    .filter((message) => message.role !== "system" && message.content.trim())
    .slice(-16)
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content.trim().slice(0, 1600)}`)
    .join("\n\n")
    .slice(-12000);
}

function modelStyleHash(style: string): string {
  return crypto.createHash("sha256").update(style.trim() || "你是本地助手，接在本机 Llama / OpenAI-compatible 接口上。").digest("hex").slice(0, 16);
}

function reasoningCapability(settings: Settings): {
  control: ReturnType<typeof detectReasoningControl>;
  efforts: string;
} {
  const model = settings.llamaModels.find((item) => item.name === settings.model);
  return {
    control: model?.reasoningControl ?? detectReasoningControl(settings.model),
    efforts: (model?.reasoningEfforts || []).join(",")
  };
}

function bridgeFingerprint(settings: Settings): string {
  const capability = reasoningCapability(settings);
  return `${settings.llamaUrl}\n${settings.model}\n${capability.control}\n${capability.efforts}\n${modelStyleHash(settings.systemPrompt)}`;
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

export function shutdownCodexRuntime(): void {
  for (const child of activeProcesses.values()) {
    child.kill("SIGTERM");
  }
  activeProcesses.clear();
  bridgeProcess?.kill("SIGTERM");
  codexBridgeProcess?.kill("SIGTERM");
  bridgeProcess = null;
  codexBridgeProcess = null;
  bridgeStartup = null;
  codexBridgeStartup = null;
  bridgeConfig = "";
  codexBridgeConfig = "";
}

function getClaudeBin(): string {
  const binary = `${homeDir}/.local/bin/claude`;
  if (fs.existsSync(binary)) return binary;
  return "claude";
}

function getCodexBin(): string {
  const candidates = [
    process.env.CODEX_BIN,
    path.join(homeDir, ".nvm", "versions", "node", "v20.19.4", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex"
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "codex";
}

function codexProviderConfig(baseUrl: string): string {
  return `{ name = "Lumen Llama", base_url = ${JSON.stringify(baseUrl.replace(/\/+$/, ""))}, wire_api = "responses", requires_openai_auth = false }`;
}

function runtimeResource(name: string): string | null {
  const candidates = [
    path.join(process.resourcesPath, "runtime", name),
    path.join(app.getAppPath(), "resources", "runtime", name)
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function bridgeReady(settings?: Settings): Promise<boolean> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 800);
  try {
    const response = await fetch(`${CLAUDE_BRIDGE_URL}/health`, { signal: abort.signal });
    if (!response.ok) return false;
    if (!settings) return true;
    const status = await response.json() as Record<string, string>;
    const capability = reasoningCapability(settings);
    return status.bridge === "lumen-claude" &&
      status.backend?.replace(/\/+$/, "") === settings.llamaUrl.replace(/\/+$/, "") &&
      status.model === settings.model &&
      status.reasoningControl === capability.control &&
      status.reasoningEfforts === capability.efforts &&
      status.styleHash === modelStyleHash(settings.systemPrompt);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function startClaudeBridge(settings = getSettings()): Promise<void> {
  // A user's existing bridge may serve active Cowork sessions. Never replace it.
  if (await bridgeReady(settings)) return;
  const script = runtimeResource("claude-bridge.mjs");
  if (!script) throw new Error("The bundled Cowork bridge is missing from this installation.");
  const capability = reasoningCapability(settings);
  bridgeProcess = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      LLAMA_URL: settings.llamaUrl,
      LLAMA_API_KEY: settings.llamaApiKey,
      LLAMA_MODEL_ALIAS: settings.model,
      LLAMA_REASONING_CONTROL: capability.control,
      LLAMA_REASONING_EFFORTS: capability.efforts,
      LLAMA_SYSTEM_PROMPT_PATH: SYSTEM_PROMPT_PATH,
      LLAMA_SYSTEM_PROMPT: settings.systemPrompt,
      CLAUDE_BRIDGE_HOST: "127.0.0.1",
      CLAUDE_BRIDGE_PORT: "18086"
    },
    detached: false,
    stdio: "ignore"
  });
  bridgeProcess.once("exit", () => {
    bridgeProcess = null;
    bridgeConfig = "";
  });
  bridgeConfig = bridgeFingerprint(settings);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (await bridgeReady(settings)) return;
  }
  bridgeProcess?.kill();
  bridgeProcess = null;
  throw new Error("The bundled Cowork bridge could not start on port 18086.");
}

async function ensureClaudeBridge(): Promise<void> {
  const settings = getSettings();
  const wantedConfig = bridgeFingerprint(settings);
  if (bridgeProcess && bridgeConfig !== wantedConfig) {
    bridgeProcess.kill();
    for (let attempt = 0; attempt < 20 && await bridgeReady(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    bridgeProcess = null;
    bridgeConfig = "";
  }
  if (await bridgeReady(settings)) return;
  if (!bridgeStartup) {
    bridgeStartup = startClaudeBridge(settings).finally(() => {
      bridgeStartup = null;
    });
  }
  await bridgeStartup;
}

async function codexBridgeReady(settings?: Settings): Promise<boolean> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 800);
  try {
    const response = await fetch(`${CODEX_BRIDGE_URL}/health`, { signal: abort.signal });
    if (!response.ok) return false;
    if (!settings) return true;
    const status = await response.json() as Record<string, string>;
    const capability = reasoningCapability(settings);
    return status.bridge === "lumen-codex" &&
      status.backend?.replace(/\/+$/, "") === settings.llamaUrl.replace(/\/+$/, "") &&
      status.model === settings.model &&
      status.reasoningControl === capability.control &&
      status.reasoningEfforts === capability.efforts &&
      status.styleHash === modelStyleHash(settings.systemPrompt);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function startCodexBridge(settings = getSettings()): Promise<void> {
  if (await codexBridgeReady(settings)) return;
  const script = runtimeResource("codex-responses-bridge.mjs");
  if (!script) throw new Error("The bundled Codex Responses bridge is missing.");
  const capability = reasoningCapability(settings);
  codexBridgeProcess = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      LLAMA_URL: settings.llamaUrl,
      LLAMA_API_KEY: settings.llamaApiKey,
      LLAMA_MODEL_ALIAS: settings.model,
      LLAMA_REASONING_CONTROL: capability.control,
      LLAMA_REASONING_EFFORTS: capability.efforts,
      LLAMA_SYSTEM_PROMPT_PATH: SYSTEM_PROMPT_PATH,
      LLAMA_SYSTEM_PROMPT: settings.systemPrompt,
      CODEX_BRIDGE_PORT: "18085"
    },
    stdio: "ignore"
  });
  codexBridgeConfig = bridgeFingerprint(settings);
  codexBridgeProcess.once("exit", () => {
    codexBridgeProcess = null;
    codexBridgeConfig = "";
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (await codexBridgeReady(settings)) return;
  }
  throw new Error("The Codex Responses bridge could not start on port 18085.");
}

async function ensureCodexBridge(): Promise<void> {
  const settings = getSettings();
  const wanted = bridgeFingerprint(settings);
  if (codexBridgeProcess && codexBridgeConfig !== wanted) {
    codexBridgeProcess.kill();
    for (let attempt = 0; attempt < 20 && await codexBridgeReady(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    codexBridgeProcess = null;
    codexBridgeConfig = "";
  }
  if (await codexBridgeReady(settings)) return;
  if (!codexBridgeStartup) {
    codexBridgeStartup = startCodexBridge(settings).finally(() => { codexBridgeStartup = null; });
  }
  await codexBridgeStartup;
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

export function registerCodexIpc(): void {
  ipcMain.handle("codex:getHome", () => defaultCwd);
  ipcMain.handle("codex:workspaceInfo", (_event, cwd?: string) => workspaceInfo(cwd));

  ipcMain.handle("codex:listTasks", () => {
    return Array.from(tasks.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  });

  ipcMain.handle("codex:createTask", (_e, { title, cwd, engine = getSettings().coworkEngine }: { title?: string; cwd?: string; engine?: CoworkEngine }) => {
    const id = crypto.randomUUID();
    const task: CodexTask = {
      id,
      title: title || "新编程任务",
      cwd: resolveWorkingDir(cwd),
      engine,
      contextUsed: 0,
      contextTotal: 16384,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    tasks.set(id, task);
    messages.set(id, []);
    return task;
  });

  ipcMain.handle("codex:getMessages", (_e, taskId: string) => {
    return messages.get(taskId) || [];
  });

  ipcMain.handle("codex:deleteTask", (_e, taskId: string) => {
    const p = activeProcesses.get(taskId);
    if (p) {
      p.kill("SIGTERM");
      activeProcesses.delete(taskId);
    }
    tasks.delete(taskId);
    messages.delete(taskId);
    codexSessions.delete(taskId);
    claudeSessions.delete(taskId);
    compactContexts.delete(taskId);
    return true;
  });

  ipcMain.handle("codex:setGoal", (_e, taskId: string, rawGoal: string) => {
    const task = tasks.get(taskId);
    if (!task) throw new Error("Cowork task not found.");
    const goal = rawGoal.trim().slice(0, 4000);
    if (!goal) throw new Error("Goal cannot be empty.");
    task.goal = goal;
    task.updatedAt = Date.now();
    const message: CodexMessage = {
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
    return { task, message };
  });

  ipcMain.handle("codex:compact", (_e, taskId: string) => {
    const task = tasks.get(taskId);
    if (!task) throw new Error("Cowork task not found.");
    compactContexts.set(taskId, compactTaskContext(messages.get(taskId) || []));
    codexSessions.delete(taskId);
    claudeSessions.set(taskId, { id: crypto.randomUUID(), started: false });
    task.contextUsed = 0;
    task.compactedAt = Date.now();
    task.updatedAt = Date.now();
    const message: CodexMessage = {
      id: crypto.randomUUID(),
      taskId,
      role: "system",
      content: "Context compacted. The next turn will continue from a bounded summary.",
      status: "done",
      activity: "Context compacted",
      createdAt: Date.now()
    };
    const taskMessages = messages.get(taskId) || [];
    taskMessages.push(message);
    messages.set(taskId, taskMessages);
    return { task, message };
  });

  ipcMain.handle("codex:selectDirectory", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
      title: "选择工程目录 (Working Directory)"
    });
    if (!res.canceled && res.filePaths[0]) {
      defaultCwd = res.filePaths[0];
      return res.filePaths[0];
    }
    return null;
  });

  ipcMain.handle("codex:stop", (_e, taskId: string) => {
    const p = activeProcesses.get(taskId);
    if (p) {
      p.kill("SIGTERM");
      activeProcesses.delete(taskId);
      return true;
    }
    return false;
  });

  ipcMain.handle("codex:run", async (event, { taskId, prompt, attachments = [], cwd, effort, model, engine }: { taskId: string; prompt: string; attachments?: Attachment[]; cwd?: string; effort?: string; model?: string; engine?: CoworkEngine }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const settings = getSettings();
    const selectedEngine = tasks.get(taskId)?.engine || engine || settings.coworkEngine;
    const llamaStatus = await probeLlama(settings);
    if (!llamaStatus.online) {
      throw new Error("模型服务未就绪，请先按 Settings → Models 的步骤启动 llama-server。");
    }
    if (llamaStatus.runningModelPath && llamaStatus.runningModel && llamaStatus.runningModel !== settings.model) {
      throw new Error(llamaStatus.error || `当前服务加载的是 ${llamaStatus.runningModel}，不是所选 ${settings.model}。`);
    }
    await Promise.all([ensureClaudeBridge(), ensureCodexBridge()]);
    const resolvedCwd = resolveWorkingDir(cwd || defaultCwd);
    const toolHost = await ensureToolHost();
    const codexRuntimeHome = path.join(app.getPath("userData"), "codex-runtime");
    fs.mkdirSync(codexRuntimeHome, { recursive: true });
    const coworkInstructions = getSettings().coworkInstructions.trim();
    const existingTask = tasks.get(taskId);
    const compactedContext = compactContexts.get(taskId);
    const reasoningDiscipline =
      "<reasoning_discipline>Use the shortest sufficient reasoning. Never repeat a completed check or restart an established approach.</reasoning_discipline>";
    const attachmentBlock = attachments.length
      ? `<attachments>\n${attachments
          .map((file) => `- ${file.path || file.name}${file.relativePath ? ` (${file.relativePath})` : ""}`)
          .join("\n")}\nUse these user-selected local files or folders as task inputs. Read them only as needed.\n</attachments>`
      : "";
    const effectivePrompt = [
      coworkInstructions
        ? `<custom_instructions>\n${coworkInstructions}\n</custom_instructions>`
        : "",
      existingTask?.goal
        ? `<active_goal>\n${existingTask.goal}\nKeep this goal active until it is achieved or explicitly replaced.</active_goal>`
        : "",
      compactedContext
        ? `<compacted_context>\n${compactedContext}\n</compacted_context>`
        : "",
      reasoningDiscipline,
      selectedEngine === "claude-code"
        ? `<peer_agent>Claude Code is the lead agent. For a bounded subtask that needs Codex Computer Use, browser control, web research, or GitHub automation, call: node ${JSON.stringify(runtimeResource("lumen-codex.mjs") || "lumen-codex.mjs")} "TASK". The peer uses the same selected model and endpoint. Call one peer at a time and incorporate its result.</peer_agent>`
        : `<peer_agent>Codex is the lead agent. For a bounded subtask that benefits from Claude Code's repository analysis or implementation workflow, call: node ${JSON.stringify(runtimeResource("lumen-claude.mjs") || "lumen-claude.mjs")} "TASK". The peer uses the same selected model and endpoint. Call one peer at a time and incorporate its result.</peer_agent>`,
      selectedEngine === "codex"
        ? "<lumen_tool_guidance>Lumen Browser, Sites, and Plugin Management are MCP tools, not MCP resources. If a requested Lumen tool is deferred, use tool_search with its exact name. Never use list_mcp_resources to invoke a tool.</lumen_tool_guidance>"
        : "",
      attachmentBlock,
      prompt
    ]
      .filter(Boolean)
      .join("\n\n");

    let task = tasks.get(taskId);
    if (!task) {
      task = {
        id: taskId,
        title: prompt.slice(0, 16) || "编程任务",
        cwd: resolvedCwd,
        engine: selectedEngine,
        contextUsed: 0,
        contextTotal: 16384,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      tasks.set(taskId, task);
      messages.set(taskId, []);
    } else {
      task.cwd = resolvedCwd;
      task.engine ||= selectedEngine;
      task.updatedAt = Date.now();
    }

    const taskMessages = messages.get(taskId) || [];
    const previousCompletedTurns = taskMessages.filter((m) => m.role === "assistant" && m.status === "done").length;

    if (taskMessages.length === 0 && prompt.trim()) {
      task.title = prompt.trim().slice(0, 16);
    }

    // Insert user message
    const userMsgId = crypto.randomUUID();
    const userMsg: CodexMessage = {
      id: userMsgId,
      taskId,
      role: "user",
      content: prompt,
      attachments,
      createdAt: Date.now()
    };
    taskMessages.push(userMsg);

    // Insert initial assistant message
    const asstMsgId = crypto.randomUUID();
    const asstMsg: CodexMessage = {
      id: asstMsgId,
      taskId,
      role: "assistant",
      content: "",
      toolCalls: [],
      status: "streaming",
      activity: "Planning",
      contextUsed: task.contextUsed || 0,
      contextTotal: 16384,
      createdAt: Date.now() + 1
    };
    taskMessages.push(asstMsg);
    messages.set(taskId, taskMessages);

    const permissionMode = settings.coworkPermissionMode;
    const claudePermissionMode =
      permissionMode === "full" ? "bypassPermissions"
        : permissionMode === "approve" ? "auto"
          : "acceptEdits";
    const codexPermissionArgs =
      permissionMode === "full"
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : permissionMode === "approve"
          ? ["--approve-for-me"]
          : ["--sandbox", "workspace-write"];
    const agentEnv = {
      ...process.env,
      ANTHROPIC_BASE_URL: CLAUDE_BRIDGE_URL,
      ANTHROPIC_API_KEY: "sk-local-llama",
      PATH: `${homeDir}/.local/bin:${process.env.PATH || ""}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`,
      HOME: homeDir,
      LANG: "en_US.UTF-8",
      CLAUDE_EFFORT: effort || "medium",
      LLAMA_MODEL_ALIAS: model || "Qwen3.8-27B",
      LLAMA_SYSTEM_PROMPT_PATH: SYSTEM_PROMPT_PATH,
      LLAMA_SYSTEM_PROMPT: settings.systemPrompt,
      ELECTRON_RUN_AS_NODE: "1",
      LUMEN_TOOL_HOST_URL: toolHost.url,
      LUMEN_TOOL_HOST_TOKEN: toolHost.token,
      LUMEN_TOOL_WORKSPACE: resolvedCwd,
      LUMEN_PLUGIN_BROWSER: settings.plugins.browser ? "1" : "0",
      LUMEN_PLUGIN_SITES: settings.plugins.sites ? "1" : "0",
      LUMEN_PLUGIN_MANAGEMENT: settings.plugins.plugins ? "1" : "0",
      LUMEN_COMPUTER_USE_CHROME: settings.computerUseChromeEnabled ? "1" : "0",
      LUMEN_COWORK_PERMISSION_MODE: permissionMode,
      ...(selectedEngine === "codex" ? { CODEX_HOME: codexRuntimeHome } : {})
    };

    const selectedModel = model || settings.model;
    const codexSession = codexSessions.get(taskId);
    const claudeSession = claudeSessions.get(taskId) || { id: taskId, started: previousCompletedTurns > 0 };
    const executable = selectedEngine === "codex" ? getCodexBin() : getClaudeBin();
    const sharedCodexArgs = [
      "--json",
      "--ignore-user-config",
      "--disable", "apps",
      "--disable", "plugins",
      "--disable", "plugin_sharing",
      "--disable", "remote_plugin",
      "--disable", "in_app_browser",
      "--disable", "computer_use",
      "--disable", "image_generation",
      "--disable", "skill_search",
      "--disable", "skill_mcp_dependency_install",
      "--skip-git-repo-check",
      ...codexPermissionArgs,
      "-m", selectedModel,
      "-c", 'model_provider="lumen_local"',
      "-c", `model_providers.lumen_local=${codexProviderConfig(`${CODEX_BRIDGE_URL}/v1`)}`,
      "-c", `model_reasoning_effort=${JSON.stringify(effort || settings.defaultEffort)}`,
      "-c", "model_context_window=16384",
      "-c", `mcp_servers.lumen.command=${JSON.stringify(process.execPath)}`,
      "-c", `mcp_servers.lumen.args=${JSON.stringify([toolHost.script])}`,
      "-c", "mcp_servers.lumen.startup_timeout_sec=10"
    ];
    const args = selectedEngine === "codex"
      ? codexSession
        ? ["exec", "resume", ...sharedCodexArgs, codexSession, effectivePrompt]
        : ["exec", ...sharedCodexArgs, "-C", resolvedCwd, effectivePrompt]
      : [
          claudeSession.started ? "--resume" : "--session-id",
          claudeSession.id,
          "--tools",
          [
            "Bash",
            "Read",
            "Edit",
            "Write",
            "Glob",
            "Grep",
            "mcp__lumen__browser_open",
            "mcp__lumen__browser_snapshot",
            "mcp__lumen__browser_click",
            "mcp__lumen__browser_type",
            "mcp__lumen__browser_screenshot",
            "mcp__lumen__sites_preview",
            "mcp__lumen__sites_status",
            "mcp__lumen__plugins_list",
            "mcp__lumen__chrome_open",
            "mcp__lumen__chrome_snapshot",
            "mcp__lumen__chrome_click",
            "mcp__lumen__chrome_type",
            "mcp__lumen__chrome_screenshot"
          ].filter((tool) => {
            if (tool.includes("__browser_")) return settings.plugins.browser;
            if (tool.includes("__sites_")) return settings.plugins.sites;
            if (tool.includes("__plugins_")) return settings.plugins.plugins;
            if (tool.includes("__chrome_")) return settings.computerUseChromeEnabled;
            return true;
          }).join(","),
          "--mcp-config",
          JSON.stringify({
            mcpServers: {
              lumen: {
                command: process.execPath,
                args: [toolHost.script],
                env: {
                  ELECTRON_RUN_AS_NODE: "1",
                  LUMEN_TOOL_HOST_URL: toolHost.url,
                  LUMEN_TOOL_HOST_TOKEN: toolHost.token,
                  LUMEN_TOOL_WORKSPACE: resolvedCwd,
                  LUMEN_PLUGIN_BROWSER: settings.plugins.browser ? "1" : "0",
                  LUMEN_PLUGIN_SITES: settings.plugins.sites ? "1" : "0",
                  LUMEN_PLUGIN_MANAGEMENT: settings.plugins.plugins ? "1" : "0",
                  LUMEN_COMPUTER_USE_CHROME: settings.computerUseChromeEnabled ? "1" : "0"
                }
              }
            }
          }),
          "--verbose",
          "--permission-mode",
          claudePermissionMode,
          "--output-format",
          "stream-json",
          "-p",
          effectivePrompt
        ];

    try {
      const child = spawn(executable, args, {
        cwd: resolvedCwd,
        env: agentEnv,
        stdio: ["ignore", "pipe", "pipe"]
      });

      activeProcesses.set(taskId, child);
      if (selectedEngine === "claude-code") {
        claudeSessions.set(taskId, { id: claudeSession.id, started: true });
      }
      if (compactedContext) compactContexts.delete(taskId);

      const rl = readline.createInterface({
        input: child.stdout,
        crlfDelay: Infinity
      });

      const toolCallsMap = new Map<string, CodexToolCall>();
      let turnInputTokens = 0;
      let turnOutputTokens = 0;

      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const json = JSON.parse(line);

          if (selectedEngine === "codex") {
            if (json.type === "thread.started" && json.thread_id) {
              codexSessions.set(taskId, json.thread_id);
            }
            if (json.type === "turn.failed" || json.type === "error") {
              const message =
                json.error?.message ||
                json.message ||
                "Codex turn failed before producing a final answer.";
              asstMsg.content = [asstMsg.content, message].filter(Boolean).join("\n\n");
              asstMsg.activity = "Task failed";
              win?.webContents.send("codex:event", {
                taskId, messageId: asstMsgId, type: "text", content: asstMsg.content
              });
            }
            const item = json.item;
            if ((json.type === "item.started" || json.type === "item.completed") && item) {
              if (item.type === "agent_message" && item.text) {
                asstMsg.content = item.text;
                asstMsg.activity = "Writing";
                win?.webContents.send("codex:event", {
                  taskId, messageId: asstMsgId, type: "text", content: asstMsg.content
                });
              } else if (item.type === "error") {
                const message = item.message || item.error?.message || item.text || "Codex reported an error.";
                asstMsg.content = [asstMsg.content, message].filter(Boolean).join("\n\n");
                asstMsg.activity = "Task failed";
                win?.webContents.send("codex:event", {
                  taskId, messageId: asstMsgId, type: "text", content: asstMsg.content
                });
              } else if (item.type !== "reasoning") {
                const id = item.id || crypto.randomUUID();
                const mcpName = item.type === "mcp_tool_call"
                  ? item.tool || item.name || `mcp:${item.server || "unknown"}`
                  : item.type || "Tool";
                const itemInput = item.arguments && typeof item.arguments === "object"
                  ? {
                      ...(item.server ? { server: item.server } : {}),
                      ...item.arguments
                    }
                  : item.command
                    ? { command: item.command }
                    : {
                        ...(item.server ? { server: item.server } : {}),
                        ...(item.tool ? { tool: item.tool } : {})
                      };
                const tc: CodexToolCall = toolCallsMap.get(id) || {
                  id,
                  name: mcpName,
                  input: itemInput,
                  status: "running"
                };
                tc.status = json.type === "item.completed"
                  ? (item.status === "failed" ? "error" : "completed")
                  : "running";
                tc.output = item.aggregated_output || item.result || item.output;
                toolCallsMap.set(id, tc);
                asstMsg.toolCalls = Array.from(toolCallsMap.values());
                asstMsg.activity = toolActivity(tc);
                win?.webContents.send("codex:event", {
                  taskId,
                  messageId: asstMsgId,
                  type: json.type === "item.completed" ? "tool_result" : "tool_use",
                  toolCall: tc,
                  toolCalls: asstMsg.toolCalls
                });
              }
            }
            if (json.type === "turn.completed" && json.usage) {
              turnInputTokens = json.usage.input_tokens || 0;
              turnOutputTokens = json.usage.output_tokens || 0;
              const used = turnInputTokens + turnOutputTokens;
              task.contextUsed = used;
              asstMsg.contextUsed = used;
              win?.webContents.send("codex:event", {
                taskId, messageId: asstMsgId, type: "usage", contextUsed: used, contextTotal: 16384
              });
            }
            return;
          }

          // Handle Assistant messages & tool uses
          if (json.type === "assistant" && json.message?.content) {
            // Check for usage in assistant message
            if (json.message.usage) {
              const inTok = json.message.usage.input_tokens || 0;
              const outTok = json.message.usage.output_tokens || 0;
              turnInputTokens = Math.max(turnInputTokens, inTok);
              turnOutputTokens = Math.max(turnOutputTokens, outTok);
              const used = inTok + outTok;
              if (used > 0) {
                task.contextUsed = used;
                task.contextTotal = 16384;
                asstMsg.contextUsed = used;
                asstMsg.contextTotal = 16384;
                if (win && !win.isDestroyed()) {
                  win.webContents.send("codex:event", {
                    taskId,
                    messageId: asstMsgId,
                    type: "usage",
                    contextUsed: used,
                    contextTotal: 16384
                  });
                }
              }
            }

            for (const block of json.message.content) {
              if (block.type === "text" && block.text) {
                asstMsg.content += (asstMsg.content ? "\n\n" : "") + block.text;
                asstMsg.activity = "Writing";
                if (win && !win.isDestroyed()) {
                  win.webContents.send("codex:event", {
                    taskId,
                    messageId: asstMsgId,
                    type: "text",
                    content: asstMsg.content
                  });
                }
              } else if (block.type === "tool_use") {
                const tc: CodexToolCall = {
                  id: block.id || crypto.randomUUID(),
                  name: block.name || "Tool",
                  input: block.input || {},
                  status: "running"
                };
                toolCallsMap.set(tc.id, tc);
                asstMsg.toolCalls = Array.from(toolCallsMap.values());
                asstMsg.activity = toolActivity(tc);
                if (win && !win.isDestroyed()) {
                  win.webContents.send("codex:event", {
                    taskId,
                    messageId: asstMsgId,
                    type: "tool_use",
                    toolCall: tc,
                    toolCalls: asstMsg.toolCalls
                  });
                }
              }
            }
          }

          // Handle Tool results
          if (json.type === "user" && json.message?.content) {
            for (const block of json.message.content) {
              if (block.type === "tool_result" && block.tool_use_id) {
                const tc = toolCallsMap.get(block.tool_use_id);
                if (tc) {
                  tc.status = block.is_error ? "error" : "completed";
                  tc.output = typeof block.content === "string" ? block.content : JSON.stringify(block.content, null, 2);
                  asstMsg.toolCalls = Array.from(toolCallsMap.values());
                  asstMsg.activity = "Reviewing";
                  if (win && !win.isDestroyed()) {
                    win.webContents.send("codex:event", {
                      taskId,
                      messageId: asstMsgId,
                      type: "tool_result",
                      toolCall: tc,
                      toolCalls: asstMsg.toolCalls
                    });
                  }
                }
              }
            }
          }

          // Handle Result finish & Usage
          if (json.type === "result") {
            if (!asstMsg.content && json.result) {
              asstMsg.content = json.result;
            }
            const inTok = json.usage?.input_tokens ?? 0;
            const outTok = json.usage?.output_tokens ?? 0;
            turnInputTokens = inTok || turnInputTokens;
            turnOutputTokens = outTok || turnOutputTokens;
            const used = inTok + outTok;
            if (used > 0) {
              task.contextUsed = used;
              task.contextTotal = 16384;
              asstMsg.contextUsed = used;
              asstMsg.contextTotal = 16384;
              if (win && !win.isDestroyed()) {
                win.webContents.send("codex:event", {
                  taskId,
                  messageId: asstMsgId,
                  type: "usage",
                  contextUsed: used,
                  contextTotal: 16384
                });
              }
            }
          }
        } catch (e) {
          // ignore non-json log lines
        }
      });

      let stderr = "";
      child.stderr.on("data", (data) => {
        const text = data.toString();
        stderr = `${stderr}${text}`.slice(-6000);
        console.error(`${selectedEngine} stderr:`, text);
      });

      child.on("close", (code) => {
        activeProcesses.delete(taskId);
        if (turnInputTokens || turnOutputTokens) {
          recordTokenUsage(turnInputTokens, turnOutputTokens);
        }
        if (code !== 0 && stderr.trim()) {
          asstMsg.content = [asstMsg.content, stderr.trim()].filter(Boolean).join("\n\n");
        }
        asstMsg.status = code === 0 ? "done" : "error";
        asstMsg.durationSeconds = Math.max(1, Math.round((Date.now() - asstMsg.createdAt) / 1000));
        asstMsg.activity = code === 0 ? "Completed" : "Task failed";
        if (win && !win.isDestroyed()) {
          win.webContents.send("codex:event", {
            taskId,
            messageId: asstMsgId,
            type: "done",
            content: asstMsg.content,
            toolCalls: asstMsg.toolCalls,
            contextUsed: task.contextUsed,
            contextTotal: task.contextTotal || 16384,
            durationSeconds: asstMsg.durationSeconds,
            exitCode: code
          });
        }

        // Auto summarize task title if first turn finished
        if (code === 0 && previousCompletedTurns === 0 && (asstMsg.content.trim() || asstMsg.toolCalls?.length)) {
          void generateConversationTitle(prompt, asstMsg.content).then((newTitle) => {
            if (newTitle && newTitle.trim()) {
              task.title = newTitle.trim();
              if (win && !win.isDestroyed()) {
                win.webContents.send("codex:event", {
                  taskId,
                  messageId: asstMsgId,
                  type: "renamed",
                  title: newTitle.trim()
                });
              }
            }
          });
        }
      });

      child.on("error", (err) => {
        activeProcesses.delete(taskId);
        asstMsg.status = "error";
        asstMsg.durationSeconds = Math.max(1, Math.round((Date.now() - asstMsg.createdAt) / 1000));
        asstMsg.activity = "Task failed";
        asstMsg.content += `\n\n执行出错: ${err.message}`;
        if (win && !win.isDestroyed()) {
          win.webContents.send("codex:event", {
            taskId,
            messageId: asstMsgId,
            type: "error",
            error: err.message
          });
        }
      });

      return { ok: true, taskId, userMsgId, asstMsgId };
    } catch (err: any) {
      activeProcesses.delete(taskId);
      asstMsg.status = "error";
      asstMsg.content = `启动失败: ${err.message}`;
      return { ok: false, error: err.message };
    }
  });
}
