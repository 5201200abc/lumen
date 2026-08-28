import { useEffect, useRef, useState } from "react";
import type { Attachment, ChatMessage, ResearchProgress, ResearchStep } from "@shared/types";
import { IconCheck, IconCopy, IconPencil, IconRefresh } from "./icons";
import { MarkdownView, stripMarkdown } from "../lib/markdown";
import { AttachmentImage, AttachmentList } from "./AttachmentControls";

type Props = {
  message: ChatMessage;
  streaming?: boolean;
  language?: "zh" | "en";
  onRegenerate?: () => void;
  onEdit?: (messageId: string, content: string, attachments?: Attachment[]) => void;
};

function formatDuration(sec: number, isZh = false): string {
  const wholeSeconds = Math.max(0, Math.floor(sec));
  if (isZh) {
    if (wholeSeconds < 60) return `${wholeSeconds}秒`;
    const minutes = Math.floor(wholeSeconds / 60);
    const rem = wholeSeconds % 60;
    return rem > 0 ? `${minutes}分${rem}秒` : `${minutes}分钟`;
  }
  if (wholeSeconds < 60) return `${wholeSeconds}s`;
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}m ${wholeSeconds % 60}s`;
}

function renderLiveStatusText(text: string) {
  return text.replace(/(\s*[.·…]+)+$/, "").trim();
}

function researchStepLabel(step: ResearchStep, isZh: boolean): string {
  const count = step.count ?? 0;
  if (step.kind === "search") {
    if (step.status === "active") return isZh ? "正在搜索网页" : "Searching websites";
    return isZh ? `已搜索 ${count} 个网站` : `Searched ${count} websites`;
  }
  if (step.kind === "read") {
    if (step.status === "active") return isZh ? `正在读取 ${count} 个来源` : `Reading ${count} sources`;
    return isZh ? `已读取 ${count} 个来源` : `Read ${count} sources`;
  }
  if (step.status === "active") return isZh ? "正在交叉验证证据" : "Cross-checking evidence";
  return step.detail || (isZh ? "已完成交叉验证" : "Cross-check complete");
}

function ResearchTrace({
  progress,
  streaming,
  isZh
}: {
  progress: ResearchProgress;
  streaming: boolean;
  isZh: boolean;
}) {
  return (
    <div className={`research-trace ${streaming ? "is-live" : "is-complete"}`}>
      {progress.steps.map((step) => {
        const domains = step.domains || [];
        const sites = step.sites || [];
        const row = (
          <span className="research-step-heading">
            <span className={`research-step-mark ${step.kind} ${step.status}`}>
              {step.kind === "read" ? "↯" : step.kind === "verify" ? "✓" : null}
            </span>
            <span className={step.status === "active" ? "thinking-shimmer" : undefined}>
              {researchStepLabel(step, isZh)}
            </span>
          </span>
        );
        if (!sites.length && !domains.length) {
          return (
            <div className={`research-step ${step.kind} ${step.status}`} key={step.id} title={step.detail}>
              {row}
            </div>
          );
        }
        return (
          <details
            className={`research-step ${step.kind} ${step.status}`}
            key={step.id}
            open={streaming}
          >
            <summary title={step.detail}>
              {row}
              <span className="research-step-chevron">⌄</span>
            </summary>
            <div className="research-domains">
              {sites.length ? sites.map((site) => (
                <a key={site.url} href={site.url} target="_blank" rel="noreferrer" title={site.title}>
                  {site.domain}
                </a>
              )) : domains.map((domain) => {
                const source = progress.sources?.find((item) => item.domain === domain);
                return source ? (
                  <a key={domain} href={source.url} target="_blank" rel="noreferrer" title={source.title}>
                    {domain}
                  </a>
                ) : <span key={domain}>{domain}</span>;
              })}
            </div>
          </details>
        );
      })}
    </div>
  );
}

export function MessageView({ message, streaming, language, onRegenerate, onEdit }: Props) {
  const isZh = language === "zh" || (typeof document !== "undefined" && document.documentElement.lang?.startsWith("zh"));
  const [seconds, setSeconds] = useState(0);
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draftText, setDraftText] = useState(message.content);
  const copyReset = useRef<number | null>(null);

  useEffect(() => {
    setDraftText(message.content);
  }, [message.content]);

  useEffect(() => {
    if (!streaming || message.phase !== "thinking") return;
    const t0 = message.phaseStartedAt || Date.now();
    setSeconds(Math.max(0, Math.floor((Date.now() - t0) / 1000)));
    const id = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - t0) / 1000));
    }, 200);
    return () => window.clearInterval(id);
  }, [streaming, message.id, message.phase, message.phaseStartedAt]);

  useEffect(
    () => () => {
      if (copyReset.current) window.clearTimeout(copyReset.current);
    },
    []
  );

  const copy = async (textToCopy?: string): Promise<void> => {
    const rawText = textToCopy ?? message.content;
    const text = stripMarkdown(rawText);
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

  if (message.role === "user") {
    const images = (message.attachments || []).filter(
      (f) => (f.kind === "image" || f.mime?.startsWith("image/")) && f.dataUrl
    );
    const otherFiles = (message.attachments || []).filter(
      (f) => !((f.kind === "image" || f.mime?.startsWith("image/")) && f.dataUrl)
    );

    return (
      <div className="turn user-turn">
        {images.length > 0 && (
          <div className="user-attachments">
            {images.map((file) => (
              <AttachmentImage key={file.id} attachment={file} />
            ))}
          </div>
        )}

        {otherFiles.length > 0 && (
          <div className="user-attachments">
            <AttachmentList attachments={otherFiles} language={language} />
          </div>
        )}

        {isEditing ? (
          <div className="user-edit-box">
            <textarea
              className="user-edit-textarea"
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (draftText.trim() || (message.attachments && message.attachments.length > 0)) {
                    setIsEditing(false);
                    onEdit?.(message.id, draftText, message.attachments);
                  }
                } else if (e.key === "Escape") {
                  setIsEditing(false);
                  setDraftText(message.content);
                }
              }}
              autoFocus
            />
            <div className="user-edit-actions">
              <button
                type="button"
                className="user-edit-btn cancel"
                onClick={() => {
                  setDraftText(message.content);
                  setIsEditing(false);
                }}
              >
                {isZh ? "取消" : "Cancel"}
              </button>
              <button
                type="button"
                className="user-edit-btn submit"
                disabled={!draftText.trim() && (!message.attachments || message.attachments.length === 0)}
                onClick={() => {
                  setIsEditing(false);
                  onEdit?.(message.id, draftText, message.attachments);
                }}
              >
                {isZh ? "发送" : "Send"}
              </button>
            </div>
          </div>
        ) : message.content ? (
          <div className="user-bubble">
            <div className="user-text">{message.content}</div>
          </div>
        ) : null}

        {!isEditing && (
          <div className="turn-actions user-turn-actions">
            {message.content ? (
              <button
                className="icon-btn ghost-icon message-action"
                type="button"
                title={copied ? (isZh ? "已复制" : "Copied") : (isZh ? "复制" : "Copy")}
                aria-label={copied ? (isZh ? "已复制" : "Copied") : (isZh ? "复制" : "Copy")}
                onClick={() => void copy(message.content)}
              >
                {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
              </button>
            ) : null}
            {onEdit ? (
              <button
                className="icon-btn ghost-icon message-action"
                type="button"
                title={isZh ? "编辑" : "Edit"}
                aria-label={isZh ? "编辑" : "Edit"}
                onClick={() => {
                  setDraftText(message.content);
                  setIsEditing(true);
                }}
              >
                <IconPencil size={14} />
              </button>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  const thinking = message.thinking.trim();
  const visibleThinking =
    thinking.length > 6000
      ? (isZh
          ? `[已隐藏早期思考过程以提高渲染性能]\n\n${thinking.slice(-6000)}`
          : `[Earlier reasoning hidden to reduce rendering load]\n\n${thinking.slice(-6000)}`)
      : thinking;
  const activelyThinking = Boolean(streaming && message.phase === "thinking");
  const showThought = Boolean(activelyThinking || (thinking && !streaming));
  const showLiveStatus = Boolean(streaming && !activelyThinking && message.statusText);
  const researchIntro = message.research?.strategy ||
    (streaming && message.phase === "searching" ? message.introText : undefined);
  const workedLabel = isZh
    ? `已深度思考 ${formatDuration(message.durationSeconds ?? 0, true)}`
    : `Thought for ${formatDuration(message.durationSeconds ?? 0, false)}`;
  const thinkingLabel = isZh
    ? `正在深度思考 ${formatDuration(seconds, true)}`
    : `Thinking ${formatDuration(seconds, false)}`;
  const thoughtBlock = showThought ? (
    <details className={`thought ${activelyThinking ? "is-thinking" : "is-complete"}`} open={activelyThinking || undefined}>
      <summary>
        <span className={activelyThinking ? "thinking-shimmer" : undefined}>
          {activelyThinking ? thinkingLabel : workedLabel}
        </span>
      </summary>
      {visibleThinking ? <pre>{visibleThinking}</pre> : null}
    </details>
  ) : !streaming && message.durationSeconds ? (
    <div className="worked-status">{workedLabel}</div>
  ) : null;

  if (!streaming && !showThought && !message.content) return null;

  return (
    <div className="turn assistant-turn">
      {!message.research ? thoughtBlock : null}
      {researchIntro || (activelyThinking && message.introText) ? (
        <p className="assistant-intro research-strategy">
          {researchIntro || message.introText}
        </p>
      ) : null}
      {message.research ? (
        <ResearchTrace progress={message.research} streaming={Boolean(streaming)} isZh={isZh} />
      ) : null}
      {message.research ? thoughtBlock : null}
      {showLiveStatus && !message.research ? (
        <div className={`assistant-live-status ${message.phase || "preparing"}`}>
          <span className="thinking-shimmer">{renderLiveStatusText(message.statusText!)}</span>
        </div>
      ) : null}
      <MarkdownView text={message.content} />
      {!streaming && message.content ? (
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
          {onRegenerate ? (
            <button
              className="icon-btn ghost-icon message-action"
              type="button"
              title={isZh ? "重新生成" : "Regenerate"}
              aria-label={isZh ? "重新生成" : "Regenerate"}
              onClick={onRegenerate}
            >
              <IconRefresh size={14} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
