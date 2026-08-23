import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@shared/types";
import { IconCheck, IconCopy, IconRefresh } from "./icons";
import { MarkdownView } from "../lib/markdown";

type Props = {
  message: ChatMessage;
  streaming?: boolean;
  onRegenerate?: () => void;
};

export function MessageView({ message, streaming, onRegenerate }: Props) {
  const [seconds, setSeconds] = useState(0);
  const [copied, setCopied] = useState(false);
  const copyReset = useRef<number | null>(null);

  useEffect(() => {
    if (!streaming) return;
    const t0 = Date.now();
    setSeconds(0);
    const id = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - t0) / 1000));
    }, 200);
    return () => window.clearInterval(id);
  }, [streaming, message.id]);

  useEffect(
    () => () => {
      if (copyReset.current) window.clearTimeout(copyReset.current);
    },
    []
  );

  if (message.role === "user") {
    return (
      <div className="turn user-turn">
        <div className="user-bubble">
          {message.attachments.length > 0 && (
            <div className="thumbs">
              {message.attachments.map((a) => (
                <img key={a.id} src={a.dataUrl} alt={a.name} />
              ))}
            </div>
          )}
          {message.content ? <div className="user-text">{message.content}</div> : null}
        </div>
      </div>
    );
  }

  const thinking = message.thinking.trim();
  const showThought = Boolean(thinking || streaming);

  if (!streaming && !showThought && !message.content) return null;

  const copy = async (): Promise<void> => {
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

  return (
    <div className="turn assistant-turn">
      {showThought ? (
        <details className="thought" open={Boolean(streaming)}>
          <summary>
            {streaming ? <span className="spin" /> : null}
            <span>{streaming ? `Thinking ${seconds}s` : `Thought for ${seconds || 1}s`}</span>
          </summary>
          <pre>{thinking || (streaming ? "" : "")}</pre>
        </details>
      ) : null}
      <MarkdownView text={message.content} />
      {!streaming && message.content ? (
        <div className="turn-actions">
          <button className="icon-btn ghost-icon message-action" type="button" title={copied ? "已复制" : "复制"} aria-label={copied ? "已复制" : "复制"} onClick={() => void copy()}>
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </button>
          {onRegenerate ? (
            <button className="icon-btn ghost-icon message-action" type="button" title="重新生成" aria-label="重新生成" onClick={onRegenerate}>
              <IconRefresh size={14} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
