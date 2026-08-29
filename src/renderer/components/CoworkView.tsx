import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Attachment, CoworkMessage, CoworkTask, CoworkToolCall, CoworkApproval, CoworkApprovalDecision, CoworkPermissionMode, CoworkToolStatus, Effort, ReasoningControl, WorkspaceInfo } from "@shared/types";
import { MarkdownView, stripMarkdown } from "../lib/markdown";
import { ModelPicker } from "./ModelPicker";
import { ContextRing } from "./ContextRing";
import {
  toolActivity,
  toolPresentation,
  type CoworkToolKind,
  type CoworkToolPresentation
} from "@shared/cowork-status";
import { isCoworkDirectConversation } from "@shared/cowork-routing";
import { AttachmentAddButton, AttachmentImage, AttachmentList, readDroppedFiles } from "./AttachmentControls";
import { EnvironmentPanel } from "./EnvironmentPanel";
import { PermissionPicker } from "./PermissionPicker";
import {
  IconArrowUp,
  IconCheck,
  IconCopy,
  IconBranch,
  IconFileText,
  IconFolder,
  IconGlobe,
  IconLaptop,
  IconPencil,
  IconSearch,
  IconSidebar,
  IconStop,
  IconTerminal
} from "./icons";

type Props = {
  language?: "zh" | "en";
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  activeTaskId: string | null;
  tasks: CoworkTask[];
  onSelectTask: (taskId: string) => void;
  onNewTask: (cwd?: string) => Promise<string>;
  onDeleteTask: (taskId: string) => void;
  model: string;
  models: string[];
  effort: Effort;
  onModel: (m: string) => void;
  onEffort: (e: Effort) => void;
  reasoningControl: ReasoningControl;
  reasoningEfforts?: Effort[];
  capabilityVersion?: string;
  permissionMode: CoworkPermissionMode;
  defaultPermissions: boolean;
  fullAccess: boolean;
  onPermissionMode: (mode: CoworkPermissionMode) => void;
};

const COWORK_WELCOME_PROMPTS = {
  en: ["What are we going to do?", "What would you like to talk about?"],
  zh: ["我们接下来要做什么？", "你想聊些什么？"]
} as const;

const COWORK_COMMANDS = [
  { command: "/goal", title: "Goal" },
  { command: "/compact", title: "Compact" }
] as const;

function formatDuration(sec: number, isZh = false): string {
  const wholeSeconds = Math.max(0, Math.floor(sec));
  if (isZh) {
    if (wholeSeconds < 60) return `${wholeSeconds}秒`;
    const m = Math.floor(wholeSeconds / 60);
    const s = wholeSeconds % 60;
    return s > 0 ? `${m}分${s}秒` : `${m}分钟`;
  }
  if (wholeSeconds < 60) return `${wholeSeconds}s`;
  const m = Math.floor(wholeSeconds / 60);
  const s = wholeSeconds % 60;
  return `${m}m ${s}s`;
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function formatActivity(activity: string | undefined, isZh = false): string {
  const act = activity?.trim();
  if (!act || act === "Planning" || act === "Planning the task") {
    return isZh ? "正在规划" : "Planning";
  }
  if (act === "Reviewing" || act === "Reviewing the tool result") {
    return isZh ? "正在复阅" : "Reviewing";
  }
  if (act === "Writing") {
    return isZh ? "正在编写" : "Writing";
  }
  if (act === "Answering") {
    return isZh ? "正在回答" : "Answering";
  }
  if (act === "Initializing") {
    return isZh ? "正在初始化" : "Initializing";
  }
  if (act === "Running hooks") {
    return isZh ? "正在运行挂钩" : "Running hooks";
  }
  if (act === "Working") {
    return isZh ? "正在处理" : "Working";
  }
  if (act === "Thinking") {
    return isZh ? "正在思考" : "Thinking";
  }
  if (act === "Waiting for approval") {
    return isZh ? "等待批准" : "Waiting for approval";
  }
  if (act === "Using a tool") {
    return isZh ? "正在使用工具" : "Using a tool";
  }
  if (act === "Completed") {
    return isZh ? "已完成" : "Completed";
  }
  if (act === "Task failed") {
    return isZh ? "任务失败" : "Task failed";
  }
  return act;
}

function getToolIcon(kind: CoworkToolKind) {
  if (kind === "terminal") return <IconTerminal size={13} />;
  if (kind === "write" || kind === "edit") return <IconPencil size={13} />;
  if (kind === "read") return <IconFileText size={13} />;
  if (kind === "search") return <IconSearch size={13} />;
  if (kind === "web") return <IconGlobe size={13} />;
  if (kind === "browser") return <IconLaptop size={13} />;
  if (kind === "folder") return <IconFolder size={13} />;
  if (kind === "plugin") return <IconBranch size={13} />;
  return <IconPencil size={13} />;
}

type TimelineTool = {
  tool: CoworkToolCall;
  presentation: CoworkToolPresentation;
  count: number;
};

function mergedTool(first: CoworkToolCall, latest: CoworkToolCall): CoworkToolCall {
  const statuses = [first.status, latest.status];
  const status = statuses.includes("running")
    ? "running"
    : statuses.includes("completed")
      ? "completed"
      : "error";
  return {
    ...first,
    status,
    output: latest.output || first.output,
    startedAt: first.startedAt || latest.startedAt,
    completedAt: latest.completedAt || first.completedAt
  };
}

function timelineTools(
  tools: CoworkToolCall[],
  language: "zh" | "en"
): TimelineTool[] {
  const isZh = language === "zh";
  const entries: TimelineTool[] = [];
  const searchable = new Map<string, number>();
  let browserIndex = -1;
  const browserActions = new Set<string>();
  let browserUrl = "";

  for (const tool of tools) {
    const presentation = toolPresentation(tool, language);
    const name = tool.name.toLowerCase();
    if (presentation.kind === "browser") {
      const action = name.split("_").at(-1) || "use";
      browserActions.add(action);
      if (typeof tool.input?.url === "string" && tool.input.url) browserUrl = tool.input.url;
      if (browserIndex < 0) {
        browserIndex = entries.length;
        entries.push({ tool, presentation, count: 1 });
      } else {
        const current = entries[browserIndex];
        current.tool = mergedTool(current.tool, tool);
        current.count += 1;
      }
      continue;
    }
    if (presentation.kind === "search") {
      const key = `${presentation.label}\n${presentation.detail}`;
      const existing = searchable.get(key);
      if (existing !== undefined) {
        entries[existing].tool = mergedTool(entries[existing].tool, tool);
        entries[existing].count += 1;
        continue;
      }
      searchable.set(key, entries.length);
    }
    entries.push({ tool, presentation, count: 1 });
  }

  if (browserIndex >= 0) {
    const actionLabels: Record<string, [string, string]> = {
      open: ["已打开", "opened"],
      snapshot: ["已检查", "inspected"],
      click: ["已点击", "clicked"],
      type: ["已输入", "typed"],
      screenshot: ["已截图", "captured"]
    };
    const actions = [...browserActions]
      .map((action) => actionLabels[action]?.[isZh ? 0 : 1])
      .filter(Boolean)
      .join(isZh ? "、" : " · ");
    entries[browserIndex].presentation = {
      kind: "browser",
      label: isZh ? "调试网页" : "Tested page",
      detail: [actions, browserUrl].filter(Boolean).join(" · "),
      meta: isZh ? `${entries[browserIndex].count} 个操作` : `${entries[browserIndex].count} actions`
    };
  }

  return entries.map((entry) => {
    if (entry.count === 1 || entry.presentation.kind === "browser") return entry;
    return {
      ...entry,
      presentation: {
        ...entry.presentation,
        meta: [entry.presentation.meta, `×${entry.count}`].filter(Boolean).join(" · ")
      }
    };
  });
}

const ToolCallCard = memo(function ToolCallCard({
  tool,
  presentation,
  language = "en"
}: {
  tool: CoworkToolCall;
  presentation: CoworkToolPresentation;
  language?: "zh" | "en";
}) {
  const isZh = language === "zh";
  const errorDetail = tool.status === "error" && tool.output
    ? (() => {
        try {
          const parsed = JSON.parse(tool.output);
          if (Array.isArray(parsed)) {
            return parsed
              .map((item) => typeof item === "string" ? item : item?.text || item?.message || "")
              .filter(Boolean)
              .join(" ");
          }
          return parsed?.message || parsed?.error?.message || tool.output;
        } catch {
          return tool.output;
        }
      })().replace(/\s+/g, " ").trim()
    : "";
  const duration = tool.startedAt && tool.completedAt
    ? Math.max(0, (tool.completedAt - tool.startedAt) / 1000)
    : null;

  return (
    <div className={`tool-card ${tool.status} kind-${presentation.kind}`}>
      {tool.startedAt && <time className="tool-clock">{formatClock(tool.startedAt)}</time>}
      <span className="tool-timeline-node" aria-hidden />
      <div className="tool-card-header">
        <div className="tool-card-left">
          <span className="tool-badge-icon" title={tool.name}>
            {getToolIcon(presentation.kind)}
          </span>
          <span className="tool-copy">
            <span className="tool-name">{presentation.label}</span>
            <span className="tool-desc" title={presentation.detail}>
              {presentation.detail}
            </span>
          </span>
        </div>
        <div className="tool-card-right">
          {presentation.meta && <span className="tool-meta">{presentation.meta}</span>}
          {duration !== null && <span className="tool-duration">{duration.toFixed(duration < 10 ? 1 : 0)}s</span>}
          <span className={`tool-status-badge ${tool.status}`} title={tool.status === "completed" ? (isZh ? "已完成" : "Completed") : tool.status === "error" ? (isZh ? "执行失败" : "Failed") : (isZh ? "执行中" : "Running")}>
            {tool.status === "running" && (
              <span className="tool-status-text thinking-shimmer">{isZh ? "执行中" : "Running"}</span>
            )}
            {tool.status === "completed" && <IconCheck size={13} />}
            {tool.status === "error" && (
              <>
                <span className="tool-error-mark">✕</span>
                <span className="tool-status-text">{isZh ? "执行失败" : "Failed"}</span>
              </>
            )}
          </span>
        </div>
      </div>
      {errorDetail && (
        <div className="tool-error-detail" title={errorDetail}>
          {errorDetail}
        </div>
      )}
    </div>
  );
});

function ApprovalCard({ approval, language = "en" }: { approval: CoworkApproval; language?: "zh" | "en" }) {
  const isZh = language === "zh";
  const decide = (decision: CoworkApprovalDecision) => {
    void window.lumen.cowork.resolveApproval(approval.id, decision);
  };
  return (
    <div className={`approval-card ${approval.status}`}>
      <div className="approval-card-title">
        <strong>{approval.title}</strong>
        <span>{approval.toolName}</span>
      </div>
      {approval.blockedPath ? <div className="approval-path">{approval.blockedPath}</div> : null}
      <details>
        <summary>{isZh ? "查看操作参数" : "View action input"}</summary>
        <pre>{JSON.stringify(approval.input, null, 2)}</pre>
      </details>
      {approval.status === "pending" ? (
        <div className="approval-actions">
          <button type="button" onClick={() => decide("deny")}>{isZh ? "拒绝" : "Deny"}</button>
          <button type="button" onClick={() => decide("allow_once")}>{isZh ? "允许一次" : "Allow once"}</button>
          <button type="button" className="primary" onClick={() => decide("allow_session")}>
            {isZh ? "本任务始终允许" : "Allow for task"}
          </button>
        </div>
      ) : (
        <div className={`approval-result ${approval.status}`}>
          {approval.status === "allowed" ? (isZh ? "已允许" : "Allowed") : (isZh ? "已拒绝" : "Denied")}
        </div>
      )}
    </div>
  );
}

const AssistantCoworkTurn = memo(function AssistantCoworkTurn({ message, language = "en" }: { message: CoworkMessage; language?: "zh" | "en" }) {
  const [seconds, setSeconds] = useState(() =>
    message.status === "streaming"
      ? Math.max(0, Math.floor((Date.now() - message.createdAt) / 1000))
      : 0
  );
  const [finalSeconds, setFinalSeconds] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [rewindState, setRewindState] = useState<"idle" | "working" | "restored" | "error">("idle");
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
    }, 1000);
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

  const rewind = async (): Promise<void> => {
    setRewindState("working");
    const preview = await window.lumen.cowork.rewind(message.taskId, message.id, true);
    if (!preview.canRewind) {
      setRewindState("error");
      return;
    }
    const confirmed = window.confirm(
      isZh
        ? "将工作区文件恢复到此轮任务开始前的状态？"
        : "Restore workspace files to their state before this turn?"
    );
    if (!confirmed) {
      setRewindState("idle");
      return;
    }
    const result = await window.lumen.cowork.rewind(message.taskId, message.id, false);
    setRewindState(result.canRewind ? "restored" : "error");
  };

  const isZh = language === "zh";
  const displaySec = finalSeconds ?? seconds;
  const workedSeconds = message.durationSeconds ?? displaySec;
  const isDirectAnswer = message.activity === "Answering";
  const displayedTools = useMemo(
    () => timelineTools(message.toolCalls || [], language),
    [message.toolCalls, language]
  );
  const hasExecution = !isDirectAnswer && (
    message.status === "streaming" ||
    Boolean(message.toolCalls?.length) ||
    Boolean(message.approvals?.length)
  );

  return (
    <div className="turn assistant-turn">
      {hasExecution ? (
        <section className={`cowork-run-timeline ${message.status || "done"}`}>
          <div className="run-step run-start">
            <time className="run-step-time">{formatClock(message.createdAt)}</time>
            <span className={`run-step-state ${message.status === "error" ? "error" : "complete"}`}>
              {message.status === "error" ? "!" : <IconCheck size={12} />}
            </span>
            <div className="run-step-copy">
              <strong>{isZh ? "任务已开始" : "Task started"}</strong>
              <span>
                {message.status === "streaming"
                  ? `${formatActivity(message.activity, isZh)} · ${formatDuration(seconds, isZh)}`
                  : (isZh ? "操作过程已记录" : "Actions recorded")}
              </span>
            </div>
          </div>

          <div className="run-step run-thinking">
            <time className="run-step-time">{formatClock(message.createdAt)}</time>
            <span className={`run-step-state ${message.status === "streaming" ? "running" : "complete"}`}>
              {message.status === "streaming" ? <span className="run-pulse" /> : <IconCheck size={12} />}
            </span>
            <div className="run-step-copy">
              <strong>Thinking</strong>
              <div className="run-thinking-content">
                {message.thinking || (
                  message.status === "streaming"
                    ? (isZh ? "正在生成思考过程…" : "Generating reasoning…")
                    : (isZh ? "当前模型未返回独立的思考过程。" : "The current model did not return a separate reasoning trace.")
                )}
              </div>
            </div>
          </div>

          {message.approvals && message.approvals.length > 0 && (
            <div className="approval-list">
              {message.approvals.map((approval) => (
                <ApprovalCard key={approval.id} approval={approval} language={language} />
              ))}
            </div>
          )}

          {displayedTools.length > 0 && (
            <div className="cowork-tools-section">
              <div className="cowork-tools-heading">
                <span>{isZh ? "完成步骤" : "Completed steps"}</span>
                <small>{displayedTools.length}</small>
              </div>
              <div className="cowork-tools-list">
                {displayedTools.map((entry) => (
                  <ToolCallCard
                    key={entry.tool.id}
                    tool={entry.tool}
                    presentation={entry.presentation}
                    language={language}
                  />
                ))}
              </div>
            </div>
          )}

          <div className={`run-step run-finish ${message.status === "streaming" ? "running" : ""}`}>
            <time className="run-step-time">
              {formatClock(message.createdAt + Math.max(0, workedSeconds) * 1000)}
            </time>
            <span className={`run-step-state ${message.status === "streaming" ? "running" : message.status === "error" ? "error" : "complete"}`}>
              {message.status === "streaming"
                ? <span className="run-pulse" />
                : message.status === "error"
                  ? "!"
                  : <IconCheck size={12} />}
            </span>
            <div className="run-step-copy">
              <strong>
                {message.status === "streaming"
                  ? (isZh ? "正在执行" : "Implementing")
                  : message.status === "error"
                    ? (isZh ? "任务未完成" : "Task incomplete")
                    : (isZh ? "任务完成" : "Task complete")}
              </strong>
              <span>
                {message.status === "streaming"
                  ? formatActivity(message.activity, isZh)
                  : workedSeconds > 0
                    ? (isZh ? `耗时 ${formatDuration(workedSeconds, true)}` : `Worked for ${formatDuration(workedSeconds, false)}`)
                    : (isZh ? "已整理所有操作" : "All actions recorded")}
              </span>
            </div>
          </div>
        </section>
      ) : (
        <div className={`thought-header ${message.status === "streaming" ? "streaming" : "done"}`}>
          <span className={message.status === "streaming" ? "thinking-shimmer" : undefined}>
            {message.status === "streaming"
              ? `${formatActivity(message.activity, isZh)} · ${formatDuration(seconds, isZh)}`
              : workedSeconds > 0
                ? (isZh ? `已完成，耗时 ${formatDuration(workedSeconds, true)}` : `Worked for ${formatDuration(workedSeconds, false)}`)
                : (isZh ? "任务已完成" : "Work complete")}
          </span>
        </div>
      )}

      {!hasExecution && (message.status === "streaming" || message.content || message.thinking) ? (
        <section className="cowork-thinking" aria-label="Thinking">
          <div className="cowork-thinking-label">Thinking</div>
          <div className="cowork-thinking-content">
            {message.thinking || (
              message.status === "streaming"
                ? (isZh ? "正在生成思考过程…" : "Generating reasoning…")
                : (isZh ? "当前模型未返回独立的思考过程。" : "The current model did not return a separate reasoning trace.")
            )}
          </div>
        </section>
      ) : null}

      {message.content && <MarkdownView text={message.content} />}

      {message.runtimeOutput && (
        <details className="runtime-output">
          <summary>{isZh ? "运行时输出" : "Runtime output"}</summary>
          <pre>{message.runtimeOutput}</pre>
        </details>
      )}

      {message.status !== "streaming" && message.content ? (
        <div className="turn-actions">
          <button
            className="icon-btn ghost-icon message-action"
            type="button"
            title={copied ? (isZh ? "已复制" : "Copied") : (isZh ? "复制" : "Copy")}
            aria-label={copied ? (isZh ? "已复制" : "Copied") : (isZh ? "复制" : "Copy")}
            onClick={() => void copy()}
          >
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </button>
          {message.rewindAvailable && rewindState !== "restored" ? (
            <button
              className="icon-btn ghost-icon message-action"
              type="button"
              title={isZh ? "恢复此轮修改的文件" : "Restore files changed by this turn"}
              aria-label={isZh ? "恢复文件" : "Restore files"}
              disabled={rewindState === "working"}
              onClick={() => void rewind()}
            >
              <IconBranch size={14} />
            </button>
          ) : null}
          {rewindState === "restored" ? (
            <span className="rewind-result">{isZh ? "文件已恢复" : "Files restored"}</span>
          ) : rewindState === "error" ? (
            <span className="rewind-result error">{isZh ? "无法恢复" : "Restore unavailable"}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

export function CoworkView(props: Props) {
  const isZh = (props.language ?? "en") === "zh";
  const [messages, setMessages] = useState<CoworkMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [running, setRunning] = useState(false);
  const [cwd, setCwd] = useState<string>("");
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [toolStatus, setToolStatus] = useState<CoworkToolStatus | null>(null);
  const [contextTokens, setContextTokens] = useState({ used: 0, total: 16384 });
  const [environmentOpen, setEnvironmentOpen] = useState(true);
  const [slashIndex, setSlashIndex] = useState(0);
  const welcomeIndex = useRef(0);
  const welcomePrompts = isZh ? COWORK_WELCOME_PROMPTS.zh : COWORK_WELCOME_PROMPTS.en;
  const [welcomePrompt, setWelcomePrompt] = useState<string>(
    COWORK_WELCOME_PROMPTS.en[0]
  );

  const threadRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const creatingTask = useRef(false);
  const startingTask = useRef<string | null>(null);
  const activeTask = props.tasks.find((t) => t.id === props.activeTaskId);

  const nextWelcomePrompt = useCallback(() => {
    const list = isZh ? COWORK_WELCOME_PROMPTS.zh : COWORK_WELCOME_PROMPTS.en;
    welcomeIndex.current = (welcomeIndex.current + 1) % list.length;
    setWelcomePrompt(list[welcomeIndex.current]);
  }, [isZh]);

  useEffect(() => {
    const list = isZh ? COWORK_WELCOME_PROMPTS.zh : COWORK_WELCOME_PROMPTS.en;
    setWelcomePrompt(list[welcomeIndex.current % list.length]);
  }, [isZh]);

  useEffect(() => {
    if (!props.activeTaskId) {
      nextWelcomePrompt();
    }
  }, [props.activeTaskId, nextWelcomePrompt]);

  useEffect(() => {
    if (activeTask?.cwd) {
      setCwd(activeTask.cwd);
    } else {
      void window.lumen.cowork.getHome().then((h) => {
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
    if (!cwd || !environmentOpen) return;
    let current = true;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void window.lumen.cowork.workspaceInfo(cwd).then((info) => {
        if (current) setWorkspace(info);
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 12_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [cwd, environmentOpen]);

  useEffect(() => {
    let current = true;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void window.lumen.tools.status().then((status) => {
        if (current) setToolStatus(status);
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [props.capabilityVersion]);

  const selectWorkspace = async (): Promise<void> => {
    const selected = await window.lumen.cowork.selectDirectory();
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
      setPrompt("");
      setAttachments([]);
      setRunning(false);
      setContextTokens({ used: 0, total: 16384 });
      return;
    }
    if (creatingTask.current || startingTask.current === props.activeTaskId) return;
    const taskId = props.activeTaskId;
    let current = true;
    void window.lumen.cowork.getMessages(taskId).then((list) => {
      if (!current || props.activeTaskId !== taskId) return;
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
    return () => {
      current = false;
    };
  }, [props.activeTaskId]);

  // Listen to streaming events from the agent backend
  useEffect(() => {
    const off = window.lumen.cowork.onEvent((event) => {
      if (event.taskId !== props.activeTaskId) return;

      if (event.contextUsed !== undefined) {
        setContextTokens({
          used: event.contextUsed,
          total: event.contextTotal || 16384
        });
      }

      setMessages((prev) => {
        return prev.map((m) => {
          if (m.id === event.messageId) {
            if (event.type === "text") {
              return { ...m, content: event.content, activity: event.activity || "Writing" };
            }
            if (event.type === "activity") {
              return { ...m, activity: event.activity };
            }
            if (event.type === "thinking") {
              return {
                ...m,
                thinking: event.thinking,
                activity: event.activity || "Thinking"
              };
            }
            if (event.type === "tool_use") {
              const activeTool = event.toolCall || event.toolCalls?.find((tool: CoworkToolCall) => tool.status === "running");
              return {
                ...m,
                toolCalls: event.toolCalls,
                activity: activeTool ? toolActivity(activeTool) : "Using a tool"
              };
            }
            if (event.type === "tool_result") {
              return { ...m, toolCalls: event.toolCalls, activity: "Reviewing" };
            }
            if (event.type === "usage") {
              return {
                ...m,
                contextUsed: event.contextUsed,
                contextTotal: event.contextTotal
              };
            }
            if (event.type === "runtime_output") {
              return { ...m, runtimeOutput: event.runtimeOutput };
            }
            if (event.type === "checkpoint") {
              return { ...m, rewindAvailable: event.rewindAvailable === true };
            }
            if (event.type === "permission_request") {
              return {
                ...m,
                approvals: event.approvals,
                activity: event.approval?.status === "pending" ? "Waiting for approval" : "Working"
              };
            }
            if (event.type === "done") {
              setRunning(false);
              return {
                ...m,
                content: event.content || m.content,
                thinking: event.thinking || m.thinking,
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
      const frame = window.requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [messages, running]);

  const handleSend = async (textToSend?: string) => {
    const text = (textToSend || prompt).trim() || (attachments.length ? "Review the attached files." : "");
    if (!text || running) return;
    const goalMatch = text.match(/^\/goal(?:\s+([\s\S]+))?$/i);
    const isCompact = /^\/compact\s*$/i.test(text);
    if (goalMatch || isCompact) {
      if (goalMatch && !goalMatch[1]?.trim()) {
        setPrompt("/goal ");
        window.requestAnimationFrame(() => areaRef.current?.focus());
        return;
      }
      let commandTaskId = props.activeTaskId;
      if (!commandTaskId) {
        creatingTask.current = true;
        try {
          commandTaskId = await props.onNewTask(cwd);
        } finally {
          creatingTask.current = false;
        }
      }
      setPrompt("");
      setAttachments([]);
      const result = goalMatch
        ? await window.lumen.cowork.setGoal(commandTaskId, goalMatch[1]!.trim())
        : await window.lumen.cowork.compact(commandTaskId);
      startingTask.current = null;
      setMessages(await window.lumen.cowork.getMessages(commandTaskId));
      if (isCompact) setContextTokens({ used: 0, total: result.task.contextTotal || 16384 });
      return;
    }
    const files = attachments;
    userScrolledUp.current = false;

    let taskId = props.activeTaskId;
    setRunning(true);
    if (!taskId) {
      creatingTask.current = true;
      try {
        taskId = await props.onNewTask(cwd);
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
    const userMsg: CoworkMessage = {
      id: "tmp-user-" + Date.now(),
      taskId,
      role: "user",
      content: text,
      attachments: files,
      createdAt: Date.now()
    };

    const directAnswer = isCoworkDirectConversation(text, files.length > 0);
    const asstMsg: CoworkMessage = {
      id: "tmp-asst-" + Date.now(),
      taskId,
      role: "assistant",
      content: "",
      toolCalls: [],
      status: "streaming",
      contextUsed: contextTokens.used,
      contextTotal: contextTokens.total,
      activity: directAnswer ? "Answering" : "Planning",
      createdAt: Date.now() + 1
    };

    setMessages((prev) => [...prev, userMsg, asstMsg]);

    try {
      const res = await window.lumen.cowork.run({
        taskId,
        prompt: text,
        attachments: files,
        cwd,
        effort: props.effort,
        model: props.model,
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
      await window.lumen.cowork.stop(props.activeTaskId);
      setRunning(false);
    }
  };

  const slashMatch = prompt.match(/^\/([^\s]*)$/);
  const slashCommands = slashMatch
    ? COWORK_COMMANDS.filter((item) => item.command.slice(1).startsWith(slashMatch[1].toLowerCase()))
    : [];
  useEffect(() => {
    setSlashIndex(0);
  }, [prompt]);
  const selectSlashCommand = (command: typeof COWORK_COMMANDS[number]["command"]): void => {
    setPrompt(command === "/goal" ? "/goal " : command);
    setSlashIndex(0);
    window.requestAnimationFrame(() => areaRef.current?.focus());
  };

  return (
    <div className={`cowork-view ${environmentOpen ? "environment-open" : ""}`}>
      <div className="cowork-primary">
      {/* Top Header Bar */}
      <header className="main-top cowork-topbar">
        {!props.sidebarOpen && props.onToggleSidebar && (
          <button
            className="icon-btn ghost-icon sidebar-toggle-btn"
            type="button"
            title={isZh ? "展开侧边栏 (⌘B)" : "Expand sidebar (⌘B)"}
            aria-label={isZh ? "展开侧边栏" : "Expand sidebar"}
            onClick={props.onToggleSidebar}
          >
            <IconSidebar size={16} />
          </button>
        )}
        <div className="cowork-titlebar-drag" aria-hidden />
        <button
          className="icon-btn ghost-icon environment-toggle"
          type="button"
          aria-pressed={environmentOpen}
          title={environmentOpen ? (isZh ? "隐藏环境面板" : "Hide environment") : (isZh ? "显示环境面板" : "Show environment")}
          aria-label={environmentOpen ? (isZh ? "隐藏环境面板" : "Hide environment") : (isZh ? "显示环境面板" : "Show environment")}
          onClick={() => setEnvironmentOpen((current) => !current)}
        >
          <IconSidebar size={16} />
        </button>
      </header>

      {/* Main Conversation Thread */}
      <div className="cowork-thread" ref={threadRef} onScroll={handleScroll}>
        <div className="cowork-thread-inner">
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
                          <AttachmentImage key={file.id} attachment={file} />
                        ))}
                      </div>
                    )}
                    {otherFiles.length > 0 && (
                      <div className="user-attachments">
                        <AttachmentList attachments={otherFiles} language={props.language} />
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
              return <AssistantCoworkTurn key={m.id} message={m} language={props.language} />;
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
          <div className="workspace-meta" aria-label={isZh ? "当前工作区" : "Current workspace"}>
            <button type="button" className="workspace-item workspace-directory" onClick={() => void selectWorkspace()} title={workspace?.cwd || cwd}>
              <IconFolder size={14} />
              <span>{workspace?.name || (isZh ? "工作区" : "Workspace")}</span>
            </button>
            <span className="workspace-item" title={isZh ? "此任务在此计算机上运行" : "This task runs on this computer"}>
              <IconLaptop size={14} />
              <span>{workspace?.location || (isZh ? "本地" : "Local")}</span>
            </span>
            <span className="workspace-item" title={workspace?.branch ? (isZh ? `Git 分支: ${workspace.branch}` : `Git branch: ${workspace.branch}`) : (isZh ? "非 Git 仓库" : "Not a Git repository")}>
              <IconBranch size={14} />
              <span>{workspace?.branch || (isZh ? "无 Git" : "No Git")}</span>
            </span>
          </div>
          <AttachmentList
            attachments={attachments}
            onRemove={(id) => setAttachments((current) => current.filter((file) => file.id !== id))}
            language={props.language}
          />
          {slashCommands.length ? (
            <div className="slash-command-menu" role="listbox" aria-label={isZh ? "Cowork 命令" : "Cowork commands"}>
              {slashCommands.map((item, index) => (
                <button
                  key={item.command}
                  type="button"
                  role="option"
                  aria-selected={index === slashIndex}
                  className={index === slashIndex ? "active" : ""}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectSlashCommand(item.command)}
                >
                  <strong>{item.command}</strong>
                  <span>
                    {item.command === "/goal"
                      ? (isZh ? "设置当前任务的持续目标" : "Set a persistent goal for this task")
                      : (isZh ? "压缩上下文并开启新会话" : "Compact context and start a fresh session")}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            ref={areaRef}
            rows={2}
            placeholder={isZh ? "询问 Lumen" : "Ask Lumen"}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (slashCommands.length) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const delta = e.key === "ArrowDown" ? 1 : -1;
                  setSlashIndex((current) => (current + delta + slashCommands.length) % slashCommands.length);
                  return;
                }
                if (e.key === "Tab") {
                  e.preventDefault();
                  selectSlashCommand(slashCommands[slashIndex]?.command || slashCommands[0].command);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey && prompt.trim() !== "/compact") {
                  e.preventDefault();
                  selectSlashCommand(slashCommands[slashIndex]?.command || slashCommands[0].command);
                  return;
                }
              }
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
                language={props.language}
                pluginActions={[
                  {
                    id: "sites",
                    label: "Sites",
                    description: isZh ? "本地预览" : "Local preview",
                    available: Boolean(toolStatus?.capabilities.find((item) => item.id === "sites")?.available),
                    onSelect: () => prepareEnvironmentPrompt(isZh ? "检查当前工作区的网站构建产物，使用 Lumen Sites 启动本地预览并在内置浏览器中验证。" : "Inspect the current workspace's built website, start a local preview with Lumen Sites, and verify it in the built-in browser.")
                  },
                  {
                    id: "browser",
                    label: "Browser",
                    description: isZh ? "内置浏览器" : "In-app browser",
                    available: Boolean(toolStatus?.capabilities.find((item) => item.id === "browser")?.available),
                    onSelect: () => prepareEnvironmentPrompt(isZh ? "使用 Lumen 内置浏览器完成这个任务；先打开页面，再读取页面快照并按需要交互。" : "Use Lumen's built-in browser for this task: open the page, inspect a snapshot, and interact as needed.")
                  },
                  {
                    id: "plugins",
                    label: isZh ? "插件" : "Plugins",
                    description: isZh ? "能力管理" : "Capabilities",
                    available: Boolean(toolStatus?.capabilities.find((item) => item.id === "plugins")?.available),
                    onSelect: () => prepareEnvironmentPrompt(isZh ? "使用 Lumen Plugin Management 列出本机已安装插件，并说明与当前任务相关的能力。" : "Use Lumen Plugin Management to list installed plugins and identify capabilities relevant to this task.")
                  }
                ]}
              />
              <PermissionPicker
                language={props.language}
                value={props.permissionMode}
                defaultPermissions={props.defaultPermissions}
                fullAccess={props.fullAccess}
                onChange={props.onPermissionMode}
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
                reasoningEfforts={props.reasoningEfforts}
              />
              {running ? (
                <button
                  className="send stop"
                  type="button"
                  onClick={() => void handleStop()}
                  aria-label={isZh ? "停止生成" : "Stop generating"}
                  title={isZh ? "停止生成" : "Stop generating"}
                >
                  <IconStop />
                </button>
              ) : (
                <button
                  className="send"
                  type="button"
                  disabled={!prompt.trim() && attachments.length === 0}
                  onClick={() => void handleSend()}
                  aria-label={isZh ? "发送" : "Send"}
                  title={isZh ? "发送" : "Send"}
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
          language={props.language}
          workspace={workspace}
          running={running}
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
