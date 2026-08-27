import { useEffect, useRef, useState } from "react";
import type { Attachment, ChatMessage } from "@shared/types";
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
  const clean = text.replace(/(\s*[.·…]+)+$/, "").trim();
  return (
    <>
      {clean}
      <span className="status-dots">...</span>
    </>
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
            <AttachmentList attachments={otherFiles} />
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
  const workedLabel = isZh
    ? `已深度思考 ${formatDuration(message.durationSeconds ?? 0, true)}`
    : `Thought for ${formatDuration(message.durationSeconds ?? 0, false)}`;
  const thinkingLabel = isZh
    ? `正在深度思考 ${formatDuration(seconds, true)}`
    : `Thinking ${formatDuration(seconds, false)}`;

  if (!streaming && !showThought && !message.content) return null;

  return (
    <div className="turn assistant-turn">
      {showLiveStatus ? (
        <div className={`assistant-live-status ${message.phase || "preparing"}`}>
          <span className="spin" />
          <span>{renderLiveStatusText(message.statusText!)}</span>
        </div>
      ) : null}
      {showThought ? (
        <details className={`thought ${activelyThinking ? "is-thinking" : "is-complete"}`} open={activelyThinking || undefined}>
          <summary>
            {activelyThinking ? <span className="spin" /> : null}
            <span>{activelyThinking ? thinkingLabel : workedLabel}</span>
          </summary>
          {visibleThinking ? <pre>{visibleThinking}</pre> : null}
        </details>
      ) : !streaming && message.durationSeconds ? (
        <div className="worked-status">{workedLabel}</div>
      ) : null}
      {activelyThinking && message.introText ? (
        <p className="assistant-intro">{message.introText}</p>
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
