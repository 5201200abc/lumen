import { useCallback, useEffect, useRef, useState } from "react";
import type { CodexMessage, CodexTask, CodexToolCall, Effort, WorkspaceInfo } from "@shared/types";
import { MarkdownView } from "../lib/markdown";
import { ModelPicker } from "./ModelPicker";
import { ContextRing } from "./ContextRing";
import {
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconCopy,
  IconBranch,
  IconFileText,
  IconFolder,
  IconLaptop,
  IconPencil,
  IconPlus,
  IconSearch,
  IconStop,
  IconTerminal
} from "./icons";

type Props = {
  activeTaskId: string | null;
  tasks: CodexTask[];
  onSelectTask: (taskId: string) => void;
  onNewTask: (cwd?: string) => Promise<string>;
  onDeleteTask: (taskId: string) => void;
  model: string;
  models: string[];
  effort: Effort;
  onModel: (m: string) => void;
  onEffort: (e: Effort) => void;
};

const COWORK_WELCOME_PROMPTS = [
  "What tasks do you want to complete today?",
  "What plans do you have for today?"
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
  const [expanded, setExpanded] = useState(false);

  const getToolDesc = () => {
    const n = tool.name.toLowerCase();
    if (n === "bash" || n === "sh" || n.includes("command")) {
      return tool.input?.command || "执行 Shell 命令";
    }
    if (n === "edit" || n === "write" || n === "read" || n.includes("write") || n.includes("edit") || n.includes("read")) {
      return tool.input?.file_path || tool.input?.path || tool.input?.filename || "";
    }
    if (n === "grep" || n === "glob" || n.includes("search") || n.includes("find")) {
      return tool.input?.pattern || tool.input?.query || "";
    }
    return tool.input && Object.keys(tool.input).length > 0 ? JSON.stringify(tool.input) : "";
  };

  const desc = getToolDesc();

  return (
    <div className={`tool-card ${tool.status}`}>
      <div className="tool-card-header" onClick={() => setExpanded(!expanded)}>
        <div className="tool-card-left">
          <span className="tool-badge-icon" title={tool.name}>
            {getToolIcon(tool.name)}
          </span>
          <span className="tool-desc" title={desc || tool.name}>
            {desc || tool.name}
          </span>
        </div>
        <div className="tool-card-right">
          <span className={`tool-status-badge ${tool.status}`} title={tool.status === "completed" ? "已完成" : tool.status === "error" ? "失败" : "执行中"}>
            {tool.status === "running" && (
              <>
                <span className="spin" />
                <span className="tool-status-text">执行中</span>
              </>
            )}
            {tool.status === "completed" && <IconCheck size={13} />}
            {tool.status === "error" && (
              <>
                <span className="tool-error-mark">✕</span>
                <span className="tool-status-text">失败</span>
              </>
            )}
          </span>
          <span className="tool-arrow" title={expanded ? "收起" : "展开"} aria-label={expanded ? "收起" : "展开"}>
            {expanded ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
          </span>
        </div>
      </div>
      {expanded && (
        <div className="tool-card-body">
          {tool.input && Object.keys(tool.input).length > 0 && (
            <div className="tool-section">
              <div className="tool-sub-label">输入参数</div>
              <pre className="tool-pre">{JSON.stringify(tool.input, null, 2)}</pre>
            </div>
          )}
          {tool.output && (
            <div className="tool-section">
              <div className="tool-sub-label">执行输出</div>
              <pre className="tool-pre">{tool.output}</pre>
            </div>
          )}
        </div>
      )}
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
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(message.content);
      } else {
        const fallback = document.createElement("textarea");
        fallback.value = message.content;
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

  return (
    <div className="turn assistant-turn">
      {/* Thought Duration Header */}
      {message.status === "streaming" ? (
        <div className="thought-header streaming">
          <span className="spin" />
          <span>Thinking {formatDuration(seconds)}</span>
        </div>
      ) : (
        <div className="thought-header done">
          <span>{displaySec > 0 ? `Thought for ${formatDuration(displaySec)}` : "Thought complete"}</span>
        </div>
      )}

      {/* Render Tool Calls as Interactive Cards */}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="codex-tools-list">
          {message.toolCalls.map((tc) => (
            <ToolCallCard key={tc.id} tool={tc} />
          ))}
        </div>
      )}

      {/* Render Assistant Markdown Response */}
      {message.content && <MarkdownView text={message.content} />}

      {message.status !== "streaming" && message.content ? (
        <div className="turn-actions">
          <button
            className="icon-btn ghost-icon message-action"
            type="button"
            title={copied ? "已复制" : "复制"}
            aria-label={copied ? "已复制" : "复制"}
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
  const [running, setRunning] = useState(false);
  const [cwd, setCwd] = useState<string>("");
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [contextTokens, setContextTokens] = useState({ used: 0, total: 16384 });
  const welcomeIndex = useRef(0);
  const [welcomePrompt, setWelcomePrompt] = useState<(typeof COWORK_WELCOME_PROMPTS)[number]>(
    COWORK_WELCOME_PROMPTS[0]
  );

  const threadRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
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

  // Load messages when activeTaskId changes
  useEffect(() => {
    if (!props.activeTaskId) {
      setMessages([]);
      setContextTokens({ used: 0, total: 16384 });
      return;
    }
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
              return { ...m, content: event.content };
            }
            if (event.type === "tool_use" || event.type === "tool_result") {
              return { ...m, toolCalls: event.toolCalls };
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
                status: "done"
              };
            }
            if (event.type === "error") {
              setRunning(false);
              return { ...m, status: "error" };
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
    const text = textToSend || prompt;
    if (!text.trim() || running) return;
    userScrolledUp.current = false;

    let taskId = props.activeTaskId;
    if (!taskId) {
      taskId = await props.onNewTask(cwd);
    }

    setPrompt("");
    setRunning(true);

    const userMsg: CodexMessage = {
      id: "tmp-user-" + Date.now(),
      taskId,
      role: "user",
      content: text,
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
      createdAt: Date.now() + 1
    };

    setMessages((prev) => [...prev, userMsg, asstMsg]);

    try {
      const res = await window.lumen.codex.run({
        taskId,
        prompt: text,
        cwd,
        effort: props.effort,
        model: props.model
      });

      if (res.ok && res.userMsgId && res.asstMsgId) {
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id === userMsg.id) return { ...m, id: res.userMsgId! };
            if (m.id === asstMsg.id) return { ...m, id: res.asstMsgId! };
            return m;
          })
        );
      } else if (!res.ok) {
        setRunning(false);
        setMessages((prev) =>
          prev.map((m) => (m.id === asstMsg.id ? { ...m, content: `启动失败: ${res.error}`, status: "error" } : m))
        );
      }
    } catch (e: any) {
      setRunning(false);
      setMessages((prev) =>
        prev.map((m) => (m.id === asstMsg.id ? { ...m, content: `执行出错: ${e.message}`, status: "error" } : m))
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
    <div className="codex-view">
      {/* Top Header Bar */}
      <header className="main-top" />

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
                return (
                  <div key={m.id} className="turn user-turn">
                    <div className="user-bubble">
                      <div className="user-text">{m.content}</div>
                    </div>
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
        <div className="composer">
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
              <button
                className="icon-chip"
                type="button"
                onClick={() => void props.onNewTask()}
                title="新建任务"
                aria-label="新建任务"
              >
                <IconPlus />
              </button>
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
                  disabled={!prompt.trim()}
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
  );
}
