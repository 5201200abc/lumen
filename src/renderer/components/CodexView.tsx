import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment, CodexMessage, CodexTask, CodexToolCall, CoworkEngine, Effort, ReasoningControl, WorkspaceInfo } from "@shared/types";
import { MarkdownView, stripMarkdown } from "../lib/markdown";
import { ModelPicker } from "./ModelPicker";
import { ContextRing } from "./ContextRing";
import { toolActivity, toolDescription } from "@shared/cowork-status";
import { AttachmentAddButton, AttachmentList, readDroppedFiles } from "./AttachmentControls";
import { EnvironmentPanel } from "./EnvironmentPanel";
import {
  IconArrowUp,
  IconCheck,
  IconCopy,
  IconBranch,
  IconFileText,
  IconFolder,
  IconLaptop,
  IconPencil,
  IconSearch,
  IconSidebar,
  IconStop,
  IconTerminal
} from "./icons";

type Props = {
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  activeTaskId: string | null;
  tasks: CodexTask[];
  onSelectTask: (taskId: string) => void;
  onNewTask: (cwd?: string, engine?: CoworkEngine) => Promise<string>;
  onDeleteTask: (taskId: string) => void;
  model: string;
  models: string[];
  effort: Effort;
  onModel: (m: string) => void;
  onEffort: (e: Effort) => void;
  reasoningControl: ReasoningControl;
  engine: CoworkEngine;
  onEngine: (engine: CoworkEngine) => void;
};

const COWORK_WELCOME_PROMPTS = [
  "What are we going to do?",
  "What would you like to talk about?"
] as const;

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function getToolIcon(name: string) {
  const n = name.toLowerCase();
  if (n === "write" || n === "edit" || n.includes("write") || n.includes("edit")) {
    return <IconPencil size={13} />;
  }
  if (n === "bash" || n === "sh" || n.includes("command") || n.includes("terminal") || n.includes("shell")) {
    return <IconTerminal size={13} />;
  }
  if (n === "read" || n.includes("file") || n.includes("view")) {
    return <IconFileText size={13} />;
  }
  if (n === "grep" || n === "glob" || n.includes("search") || n.includes("find")) {
    return <IconSearch size={13} />;
  }
  return <IconPencil size={13} />;
}

function ToolCallCard({ tool }: { tool: CodexToolCall }) {
  const desc = toolDescription(tool);

  return (
    <div className={`tool-card ${tool.status}`}>
      <div className="tool-card-header">
        <div className="tool-card-left">
          <span className="tool-badge-icon" title={tool.name}>
            {getToolIcon(tool.name)}
          </span>
          <span className="tool-name">{tool.name}</span>
          <span className="tool-desc" title={desc || tool.name}>
            {desc}
          </span>
        </div>
        <div className="tool-card-right">
          <span className={`tool-status-badge ${tool.status}`} title={tool.status === "completed" ? "Completed" : tool.status === "error" ? "Failed" : "Running"}>
            {tool.status === "running" && (
              <>
                <span className="spin" />
                <span className="tool-status-text">Running</span>
              </>
            )}
            {tool.status === "completed" && <IconCheck size={13} />}
            {tool.status === "error" && (
              <>
                <span className="tool-error-mark">✕</span>
                <span className="tool-status-text">Failed</span>
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

function AssistantCodexTurn({ message }: { message: CodexMessage }) {
  const [seconds, setSeconds] = useState(() =>
    message.status === "streaming"
      ? Math.max(0, Math.floor((Date.now() - message.createdAt) / 1000))
      : 0
  );
  const [finalSeconds, setFinalSeconds] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const copyReset = useRef<number | null>(null);

  useEffect(() => {
    if (message.status !== "streaming") {
      if (finalSeconds === null && seconds > 0) {
        setFinalSeconds(seconds);
      }
      return;
    }
    const t0 = message.createdAt;
    setSeconds(Math.max(0, Math.floor((Date.now() - t0) / 1000)));
    const timer = window.setInterval(() => {
      setSeconds(Math.max(1, Math.floor((Date.now() - t0) / 1000)));
    }, 250);
    return () => window.clearInterval(timer);
  }, [message.status, message.id]);

  useEffect(
    () => () => {
      if (copyReset.current) window.clearTimeout(copyReset.current);
    },
    []
  );

  const copy = async (): Promise<void> => {
    if (!message.content) return;
    const text = stripMarkdown(message.content);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const fallback = document.createElement("textarea");
        fallback.value = text;
        fallback.style.position = "fixed";
        fallback.style.opacity = "0";
        document.body.appendChild(fallback);
        fallback.select();
        const didCopy = document.execCommand("copy");
        fallback.remove();
        if (!didCopy) throw new Error("copy failed");
      }
      setCopied(true);
      if (copyReset.current) window.clearTimeout(copyReset.current);
      copyReset.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  const displaySec = finalSeconds ?? seconds;
  const workedSeconds = message.durationSeconds ?? displaySec;

  return (
    <div className="turn assistant-turn">
      {message.status === "streaming" ? (
        <div className="thought-header streaming">
          <span className="spin" />
          <span>{message.activity || "Planning the task"} · {formatDuration(seconds)}</span>
        </div>
      ) : (
        <div className="thought-header done">
          <span>{workedSeconds > 0 ? `Worked for ${formatDuration(workedSeconds)}` : "Work complete"}</span>
        </div>
      )}

      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="codex-tools-list">
          {message.toolCalls.map((tc) => (
            <ToolCallCard key={tc.id} tool={tc} />
          ))}
        </div>
      )}

      {message.content && <MarkdownView text={message.content} />}

      {message.status !== "streaming" && message.content ? (
        <div className="turn-actions">
          <button
            className="icon-btn ghost-icon message-action"
            type="button"
            title={copied ? "Copied" : "Copy"}
            aria-label={copied ? "Copied" : "Copy"}
            onClick={() => void copy()}
          >
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function CodexView(props: Props) {
  const [messages, setMessages] = useState<CodexMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [running, setRunning] = useState(false);
  const [cwd, setCwd] = useState<string>("");
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [contextTokens, setContextTokens] = useState({ used: 0, total: 16384 });
  const [environmentOpen, setEnvironmentOpen] = useState(true);
  const welcomeIndex = useRef(0);
  const [welcomePrompt, setWelcomePrompt] = useState<(typeof COWORK_WELCOME_PROMPTS)[number]>(
    COWORK_WELCOME_PROMPTS[0]
  );

  const threadRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const creatingTask = useRef(false);
  const startingTask = useRef<string | null>(null);
  const activeTask = props.tasks.find((t) => t.id === props.activeTaskId);

  const nextWelcomePrompt = useCallback(() => {
    welcomeIndex.current = (welcomeIndex.current + 1) % COWORK_WELCOME_PROMPTS.length;
    setWelcomePrompt(COWORK_WELCOME_PROMPTS[welcomeIndex.current]);
  }, []);

  useEffect(() => {
    if (!props.activeTaskId) {
      nextWelcomePrompt();
    }
  }, [props.activeTaskId, nextWelcomePrompt]);

  useEffect(() => {
    if (activeTask?.cwd) {
      setCwd(activeTask.cwd);
    } else {
      void window.lumen.codex.getHome().then((h) => {
        setCwd((prev) => prev || h);
      });
    }
    if (activeTask?.contextUsed) {
      setContextTokens({
        used: activeTask.contextUsed,
        total: activeTask.contextTotal || 16384
      });
    }
  }, [activeTask?.cwd, activeTask?.contextUsed, activeTask?.contextTotal]);

  useEffect(() => {
    if (!cwd) return;
    let current = true;
    const refresh = () => {
      void window.lumen.codex.workspaceInfo(cwd).then((info) => {
        if (current) setWorkspace(info);
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [cwd]);

  const selectWorkspace = async (): Promise<void> => {
    const selected = await window.lumen.codex.selectDirectory();
    if (selected) setCwd(selected);
  };

  const addEnvironmentSources = async (): Promise<void> => {
    const files = await window.lumen.attachments.pickFiles();
    if (files.length) setAttachments((current) => [...current, ...files]);
  };

  const prepareEnvironmentPrompt = (text: string): void => {
    setPrompt(text);
    window.requestAnimationFrame(() => areaRef.current?.focus());
  };

  // Load messages when activeTaskId changes
  useEffect(() => {
    if (!props.activeTaskId) {
      setMessages([]);
      setContextTokens({ used: 0, total: 16384 });
      return;
    }
    if (creatingTask.current || startingTask.current === props.activeTaskId) return;
    void window.lumen.codex.getMessages(props.activeTaskId).then((list) => {
      setMessages(list);
      setRunning(list.some((message) => message.status === "streaming"));
      const lastWithTokens = list.slice().reverse().find((m) => m.contextUsed && m.contextUsed > 0);
      if (lastWithTokens && lastWithTokens.contextUsed) {
        setContextTokens({
          used: lastWithTokens.contextUsed,
          total: lastWithTokens.contextTotal || 16384
        });
      }
    });
  }, [props.activeTaskId]);

  // Listen to streaming events from the agent backend
  useEffect(() => {
    const off = window.lumen.codex.onEvent((event) => {
      if (event.taskId !== props.activeTaskId) return;

      if (event.contextUsed) {
        setContextTokens({
          used: event.contextUsed,
          total: event.contextTotal || 16384
        });
      }

      setMessages((prev) => {
        return prev.map((m) => {
          if (m.id === event.messageId) {
            if (event.type === "text") {
              return { ...m, content: event.content, activity: "Writing the response" };
            }
            if (event.type === "tool_use") {
              const activeTool = event.toolCall || event.toolCalls?.find((tool: CodexToolCall) => tool.status === "running");
              return {
                ...m,
                toolCalls: event.toolCalls,
                activity: activeTool ? toolActivity(activeTool) : "Using a tool"
              };
            }
            if (event.type === "tool_result") {
              return { ...m, toolCalls: event.toolCalls, activity: "Reviewing the tool result" };
            }
            if (event.type === "usage") {
              return {
                ...m,
                contextUsed: event.contextUsed,
                contextTotal: event.contextTotal
              };
            }
            if (event.type === "done") {
              setRunning(false);
              return {
                ...m,
                content: event.content || m.content,
                toolCalls: event.toolCalls || m.toolCalls,
                contextUsed: event.contextUsed || m.contextUsed,
                contextTotal: event.contextTotal || m.contextTotal,
                status: event.exitCode === 0 ? "done" : "error",
                activity: event.exitCode === 0 ? "Completed" : "Task failed",
                durationSeconds:
                  event.durationSeconds ||
                  Math.max(1, Math.round((Date.now() - m.createdAt) / 1000))
              };
            }
            if (event.type === "error") {
              setRunning(false);
              return {
                ...m,
                status: "error",
                activity: "Task failed",
                durationSeconds: Math.max(1, Math.round((Date.now() - m.createdAt) / 1000))
              };
            }
          }
          return m;
        });
      });
    });

    return () => off();
  }, [props.activeTaskId]);

  const userScrolledUp = useRef(false);

  const handleScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUp.current = distanceToBottom > 60;
  };

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    if (!userScrolledUp.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, running]);

  const handleSend = async (textToSend?: string) => {
    const text = (textToSend || prompt).trim() || (attachments.length ? "Review the attached files." : "");
    if (!text || running) return;
    const files = attachments;
    userScrolledUp.current = false;

    let taskId = props.activeTaskId;
    setRunning(true);
    if (!taskId) {
      creatingTask.current = true;
      try {
        taskId = await props.onNewTask(cwd, props.engine);
      } catch {
        creatingTask.current = false;
        setRunning(false);
        return;
      }
      creatingTask.current = false;
      startingTask.current = taskId;
    }

    setPrompt("");
    setAttachments([]);
    const userMsg: CodexMessage = {
      id: "tmp-user-" + Date.now(),
      taskId,
      role: "user",
      content: text,
      attachments: files,
      createdAt: Date.now()
    };

    const asstMsg: CodexMessage = {
      id: "tmp-asst-" + Date.now(),
      taskId,
      role: "assistant",
      content: "",
      toolCalls: [],
      status: "streaming",
      contextUsed: contextTokens.used,
      contextTotal: contextTokens.total,
      activity: "Planning the task",
      createdAt: Date.now() + 1
    };

    setMessages((prev) => [...prev, userMsg, asstMsg]);

    try {
      const res = await window.lumen.codex.run({
        taskId,
        prompt: text,
        attachments: files,
        cwd,
        effort: props.effort,
        model: props.model,
        engine: props.tasks.find((task) => task.id === taskId)?.engine || props.engine
      });

      if (res.ok && res.userMsgId && res.asstMsgId) {
        startingTask.current = null;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id === userMsg.id) return { ...m, id: res.userMsgId! };
            if (m.id === asstMsg.id) return { ...m, id: res.asstMsgId! };
            return m;
          })
        );
      } else if (!res.ok) {
        startingTask.current = null;
        setRunning(false);
        setMessages((prev) =>
          prev.map((m) => (m.id === asstMsg.id ? { ...m, content: `Could not start: ${res.error}`, status: "error", activity: "Task failed" } : m))
        );
      }
    } catch (e: any) {
      creatingTask.current = false;
      startingTask.current = null;
      setRunning(false);
      setMessages((prev) =>
        prev.map((m) => (m.id === asstMsg.id ? { ...m, content: `Execution failed: ${e.message}`, status: "error", activity: "Task failed" } : m))
      );
    }
  };

  const handleStop = async () => {
    if (props.activeTaskId) {
      await window.lumen.codex.stop(props.activeTaskId);
      setRunning(false);
    }
  };

  return (
    <div className={`codex-view ${environmentOpen ? "environment-open" : ""}`}>
      <div className="codex-primary">
      {/* Top Header Bar */}
      <header className="main-top cowork-topbar">
        {!props.sidebarOpen && props.onToggleSidebar && (
          <button
            className="icon-btn ghost-icon sidebar-toggle-btn"
            type="button"
            title="Expand sidebar (⌘B)"
            aria-label="Expand sidebar"
            onClick={props.onToggleSidebar}
          >
            <IconSidebar size={16} />
          </button>
        )}
        <button
          className="icon-btn ghost-icon environment-toggle"
          type="button"
          aria-pressed={environmentOpen}
          title={environmentOpen ? "Hide environment" : "Show environment"}
          aria-label={environmentOpen ? "Hide environment" : "Show environment"}
          onClick={() => setEnvironmentOpen((current) => !current)}
        >
          <IconSidebar size={16} />
        </button>
      </header>

      {/* Main Conversation Thread */}
      <div className="codex-thread" ref={threadRef} onScroll={handleScroll}>
        <div className="codex-thread-inner">
          {messages.length === 0 ? (
            <div className="empty">
              <h1>Lumen Cowork</h1>
              <p>{welcomePrompt}</p>
            </div>
          ) : (
            messages.map((m) => {
              if (m.role === "user") {
                const images = (m.attachments || []).filter(
                  (f) => (f.kind === "image" || f.mime?.startsWith("image/")) && f.dataUrl
                );
                const otherFiles = (m.attachments || []).filter(
                  (f) => !((f.kind === "image" || f.mime?.startsWith("image/")) && f.dataUrl)
                );
                return (
                  <div key={m.id} className="turn user-turn">
                    {images.length > 0 && (
                      <div className="user-attachments">
                        {images.map((file) => (
                          <div key={file.id} className="user-image-card" title={file.name}>
                            <img src={file.dataUrl} alt={file.name} />
                          </div>
                        ))}
                      </div>
                    )}
                    {otherFiles.length > 0 && (
                      <div className="user-attachments">
                        <AttachmentList attachments={otherFiles} />
                      </div>
                    )}
                    {m.content ? (
                      <div className="user-bubble">
                        <div className="user-text">{m.content}</div>
                      </div>
                    ) : null}
                  </div>
                );
              }
              return <AssistantCodexTurn key={m.id} message={m} />;
            })
          )}
        </div>
      </div>

      {/* Bottom Composer Box */}
      <div className="composer-wrap">
        <div
          className="composer"
          onDragOver={(event) => {
            event.preventDefault();
            event.currentTarget.classList.add("drop");
          }}
          onDragLeave={(event) => event.currentTarget.classList.remove("drop")}
          onDrop={async (event) => {
            event.preventDefault();
            event.currentTarget.classList.remove("drop");
            if (event.dataTransfer.files.length) {
              const dropped = await readDroppedFiles(event.dataTransfer.files);
              setAttachments((current) => [...current, ...dropped]);
            }
          }}
        >
          <div className="workspace-meta" aria-label="Current workspace">
            <button type="button" className="workspace-item workspace-directory" onClick={() => void selectWorkspace()} title={workspace?.cwd || cwd}>
              <IconFolder size={14} />
              <span>{workspace?.name || "Workspace"}</span>
            </button>
            <span className="workspace-item" title="This task runs on this computer">
              <IconLaptop size={14} />
              <span>{workspace?.location || "Local"}</span>
            </span>
            <span className="workspace-item" title={workspace?.branch ? `Git branch: ${workspace.branch}` : "Not a Git repository"}>
              <IconBranch size={14} />
              <span>{workspace?.branch || "No Git"}</span>
            </span>
          </div>
          <AttachmentList
            attachments={attachments}
            onRemove={(id) => setAttachments((current) => current.filter((file) => file.id !== id))}
          />
          <textarea
            ref={areaRef}
            rows={2}
            placeholder="Ask Lumen"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              void handleSend();
            }}
          />
          <div className="composer-bar">
            <div className="left-tools">
              <AttachmentAddButton
                attachments={attachments}
                onAdd={(files) => setAttachments((current) => [...current, ...files])}
                onRemove={(id) => setAttachments((current) => current.filter((file) => file.id !== id))}
              />
            </div>
            <div className="right-tools">
              {/* Context Window Usage Gauge Ring */}
              <ContextRing used={contextTokens.used} total={contextTokens.total} />

              {/* Model & Effort Picker */}
              <ModelPicker
                model={props.model}
                models={props.models}
                effort={props.effort}
                onModel={props.onModel}
                onEffort={props.onEffort}
                reasoningControl={props.reasoningControl}
                engine={props.tasks.find((task) => task.id === props.activeTaskId)?.engine || props.engine}
                onEngine={props.onEngine}
              />
              {running ? (
                <button
                  className="send stop"
                  type="button"
                  onClick={() => void handleStop()}
                  aria-label="停止生成"
                  title="停止生成"
                >
                  <IconStop />
                </button>
              ) : (
                <button
                  className="send"
                  type="button"
                  disabled={!prompt.trim() && attachments.length === 0}
                  onClick={() => void handleSend()}
                  aria-label="发送"
                  title="发送"
                >
                  <IconArrowUp />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      </div>
      {environmentOpen && (
        <EnvironmentPanel
          workspace={workspace}
          running={running}
          engine={props.tasks.find((task) => task.id === props.activeTaskId)?.engine || props.engine}
          model={props.model}
          messages={messages}
          attachments={attachments}
          onSelectWorkspace={() => void selectWorkspace()}
          onAddSource={() => void addEnvironmentSources()}
          onPrompt={prepareEnvironmentPrompt}
        />
      )}
    </div>
  );
}
