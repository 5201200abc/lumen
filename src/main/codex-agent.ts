import { BrowserWindow, dialog, ipcMain } from "electron";
import { execFile, spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import type { Attachment, CodexMessage, CodexTask, CodexToolCall, WorkspaceInfo } from "@shared/types";
import { toolActivity } from "@shared/cowork-status";
import { generateConversationTitle } from "./title";
import { getSettings } from "./store";

const tasks = new Map<string, CodexTask>();
const messages = new Map<string, CodexMessage[]>();
const activeProcesses = new Map<string, ChildProcess>();

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

function getClaudeBin(): string {
  const binary = `${homeDir}/.local/bin/claude`;
  if (fs.existsSync(binary)) return binary;
  return "claude";
}

async function workspaceInfo(rawPath?: string): Promise<WorkspaceInfo> {
  const cwd = resolveWorkingDir(rawPath);
  const branch = await new Promise<string | null>((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "symbolic-ref", "--quiet", "--short", "HEAD"],
      { timeout: 2500, encoding: "utf8" },
      (error, stdout) => resolve(error ? null : stdout.trim() || null)
    );
  });
  return {
    cwd,
    name: path.basename(cwd) || cwd,
    branch,
    location: "Local"
  };
}

export function registerCodexIpc(): void {
  ipcMain.handle("codex:getHome", () => defaultCwd);
  ipcMain.handle("codex:workspaceInfo", (_event, cwd?: string) => workspaceInfo(cwd));

  ipcMain.handle("codex:listTasks", () => {
    return Array.from(tasks.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  });

  ipcMain.handle("codex:createTask", (_e, { title, cwd }: { title?: string; cwd?: string }) => {
    const id = crypto.randomUUID();
    const task: CodexTask = {
      id,
      title: title || "新编程任务",
      cwd: resolveWorkingDir(cwd),
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
    return true;
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

  ipcMain.handle("codex:run", async (event, { taskId, prompt, attachments = [], cwd, effort, model }: { taskId: string; prompt: string; attachments?: Attachment[]; cwd?: string; effort?: string; model?: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const resolvedCwd = resolveWorkingDir(cwd || defaultCwd);
    const coworkInstructions = getSettings().coworkInstructions.trim();
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
      reasoningDiscipline,
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
        contextUsed: 0,
        contextTotal: 16384,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      tasks.set(taskId, task);
      messages.set(taskId, []);
    } else {
      task.cwd = resolvedCwd;
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
      activity: "Planning the task",
      contextUsed: task.contextUsed || 0,
      contextTotal: 16384,
      createdAt: Date.now() + 1
    };
    taskMessages.push(asstMsg);
    messages.set(taskId, taskMessages);

    const claudeBin = getClaudeBin();
    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: "http://127.0.0.1:18084",
      ANTHROPIC_API_KEY: "sk-local-llama",
      PATH: `${homeDir}/.local/bin:${process.env.PATH || ""}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`,
      HOME: homeDir,
      LANG: "en_US.UTF-8",
      CLAUDE_EFFORT: effort || "medium",
      LLAMA_MODEL_ALIAS: model || "Qwen3.8-27B"
    };

    const sessionFlag = previousCompletedTurns > 0 ? "--resume" : "--session-id";
    const args = [
      sessionFlag,
      taskId,
      "--tools",
      "Bash,Read,Edit,Write,Glob,Grep",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "stream-json",
      "-p",
      effectivePrompt
    ];

    try {
      const child = spawn(claudeBin, args, {
        cwd: resolvedCwd,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });

      activeProcesses.set(taskId, child);

      const rl = readline.createInterface({
        input: child.stdout,
        crlfDelay: Infinity
      });

      const toolCallsMap = new Map<string, CodexToolCall>();

      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const json = JSON.parse(line);

          // Handle Assistant messages & tool uses
          if (json.type === "assistant" && json.message?.content) {
            // Check for usage in assistant message
            if (json.message.usage) {
              const inTok = json.message.usage.input_tokens || 0;
              const outTok = json.message.usage.output_tokens || 0;
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
                asstMsg.activity = "Writing the response";
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
                  asstMsg.activity = "Reviewing the tool result";
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

      child.stderr.on("data", (data) => {
        const text = data.toString();
        console.error("Claude stderr:", text);
      });

      child.on("close", (code) => {
        activeProcesses.delete(taskId);
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
