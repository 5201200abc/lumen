import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useState } from "react";
import { IconCheck, IconCopy } from "../components/icons";

function CodeBlock({ lang, children }: { lang: string; children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="codeblock">
      <header>
        <span>{lang || "code"}</span>
        <button
          className="ghost codeblock-copy-btn"
          type="button"
          title={copied ? "已复制" : "复制"}
          aria-label={copied ? "已复制" : "复制"}
          onClick={async () => {
            await navigator.clipboard.writeText(children);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
        </button>
      </header>
      <pre>
        <code>{children}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children).replace(/\n$/, "");
    const lang = /language-(\w+)/.exec(className || "")?.[1] || "";
    const block = className?.includes("language-") || text.includes("\n");
    if (!block) return <code>{text}</code>;
    return <CodeBlock lang={lang}>{text}</CodeBlock>;
  }
};

export function MarkdownView({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  );
}


