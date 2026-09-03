import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Attachment, CoworkMessage, CoworkToolCall, WorkspaceInfo } from "@shared/types";
import { toolDescription } from "@shared/cowork-status";
import {
  IconBranch,
  IconChevronDown,
  IconChanges,
  IconExternal,
  IconFileText,
  IconGithub,
  IconGlobe,
  IconLaptop,
  IconPlus,
  IconTerminal
} from "./icons";

type Props = {
  language?: "zh" | "en";
  workspace: WorkspaceInfo | null;
  running: boolean;
  model: string;
  messages: CoworkMessage[];
  attachments: Attachment[];
  computerUseActive: boolean;
  computerUseHidden: boolean;
  onToggleComputerUse: () => void;
  onSelectWorkspace: () => void;
  onAddSource: () => void;
  onPrompt: (prompt: string) => void;
};

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function sourceFiles(messages: CoworkMessage[], pending: Attachment[]): Attachment[] {
  const files = [...pending, ...messages.flatMap((message) => message.attachments || [])];
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = file.path || file.dataUrl?.slice(0, 96) || `${file.name}:${file.size || 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type WebSearchHit = {
  title: string;
  url: string;
  snippet?: string;
};

type WebSearchRecord = {
  id: string;
  query: string;
  status: CoworkToolCall["status"];
  hits: WebSearchHit[];
};

function decodedToolOutput(output?: string): Record<string, unknown> | null {
  if (!output) return null;
  try {
    let value: unknown = JSON.parse(output);
    if (
      Array.isArray(value) &&
      typeof value[0] === "object" &&
      value[0] !== null &&
      "text" in value[0]
    ) {
      value = JSON.parse(String((value[0] as { text: unknown }).text));
    }
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function webSearches(messages: CoworkMessage[]): WebSearchRecord[] {
  return messages.flatMap((message) => message.toolCalls || [])
    .filter((tool) => tool.name.toLowerCase().endsWith("web_search"))
    .map((tool) => {
      const decoded = decodedToolOutput(tool.output);
      const rawHits = Array.isArray(decoded?.results) ? decoded.results : [];
      const hits = rawHits.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const result = item as Record<string, unknown>;
        const url = typeof result.url === "string" ? result.url : "";
        if (!url) return [];
        return [{
          title: typeof result.title === "string" && result.title.trim() ? result.title : url,
          url,
          snippet: typeof result.snippet === "string" ? result.snippet : undefined
        }];
      });
      return {
        id: tool.id,
        query: typeof tool.input?.query === "string"
          ? tool.input.query
          : typeof decoded?.query === "string" ? decoded.query : "Web search",
        status: tool.status,
        hits
      };
    });
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function EnvironmentPanel(props: Props) {
  const isZh = (props.language ?? "en") === "zh";
  const changes = props.workspace?.changes || { files: 0, additions: 0, deletions: 0 };
  const sources = useMemo(
    () => sourceFiles(props.messages, props.attachments),
    [props.messages, props.attachments]
  );
  const searches = useMemo(() => webSearches(props.messages), [props.messages]);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const pendingIds = useMemo(
    () => new Set(props.attachments.map((attachment) => attachment.id)),
    [props.attachments]
  );
  const activeTool = props.messages
    .flatMap((message) => message.toolCalls || [])
    .find((tool) => tool.status === "running");
  const branch = props.workspace?.branch || (isZh ? "无 Git" : "No Git");

  useEffect(() => {
    if (!sourcesOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSourcesOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [sourcesOpen]);

  return (
    <aside className="environment-rail" aria-label={isZh ? "环境" : "Environment"}>
      <div className="environment-card">
        <div className="environment-heading">
          <span>{isZh ? "环境" : "Environment"}</span>
          <button type="button" className="environment-plus" onClick={props.onSelectWorkspace} aria-label={isZh ? "选择工作区" : "Choose workspace"} title={isZh ? "选择工作区" : "Choose workspace"}>
            <IconPlus size={14} />
          </button>
        </div>

        <div className="environment-list">
          <button
            type="button"
            className="environment-row"
            onClick={() => props.onPrompt(isZh ? "审查当前工作区的代码改动，并总结主要风险。" : "Review the current working tree changes and summarize the important risks.")}
          >
            <IconChanges size={14} />
            <span className="environment-row-label">{isZh ? "改动" : "Changes"}</span>
            <span className="environment-change-count">
              <span className="added">+{compactNumber(changes.additions)}</span>
              <span className="deleted">−{compactNumber(changes.deletions)}</span>
            </span>
          </button>
          <button type="button" className="environment-row" onClick={props.onSelectWorkspace}>
            <IconLaptop size={14} />
            <span className="environment-row-label">{props.workspace?.location || (isZh ? "本地" : "Local")}</span>
            <IconChevronDown size={12} />
          </button>
          <button
            type="button"
            className="environment-row"
            onClick={() => props.onPrompt(isZh ? `检查当前 Git 分支“${branch}”并报告状态。` : `Inspect the current Git branch "${branch}" and report its status.`)}
          >
            <IconBranch size={14} />
            <span className="environment-row-label">{branch}</span>
            <IconChevronDown size={12} />
          </button>
          <button
            type="button"
            className="environment-row"
            disabled={!props.workspace?.branch}
            onClick={() => props.onPrompt(isZh ? "审查当前改动并执行相应检查，确认无误后完成提交与推送。" : "Review the current changes, run the relevant checks, then commit and push when the repository is ready.")}
          >
            <IconChanges size={14} />
            <span className="environment-row-label">{isZh ? "提交或推送" : "Commit or push"}</span>
          </button>
          <button
            type="button"
            className="environment-row"
            disabled={!props.workspace?.branch || !props.workspace?.hasRemote}
            onClick={() => props.onPrompt(isZh ? "对比当前分支与上游分支，总结主要差异。" : "Compare the current branch with its upstream branch and summarize the meaningful differences.")}
          >
            <IconGithub size={14} />
            <span className="environment-row-label">{isZh ? "对比分支" : "Compare branch"}</span>
            <IconExternal size={12} />
          </button>
        </div>

        <section className="environment-section">
          <h3>{isZh ? "后台进程" : "Background processes"}</h3>
          {props.running ? (
            <div className="environment-process">
              <IconTerminal size={14} />
              <span title={activeTool ? toolDescription(activeTool) : undefined}>
                {activeTool ? toolDescription(activeTool) : `Lumen Agent · ${props.model}`}
              </span>
              <span className="environment-live-dot" aria-label={isZh ? "执行中" : "Running"} />
            </div>
          ) : (
            <div className="environment-empty-row">
              <IconTerminal size={14} />
              <span>{isZh ? "无活动进程" : "No active processes"}</span>
            </div>
          )}
        </section>

        {props.computerUseActive && (
          <section className="environment-section environment-computer-use">
            <h3>{isZh ? "计算机使用" : "Computer Use"}</h3>
            <div className="environment-computer-use-row">
              <IconLaptop size={14} />
              <span>{isZh ? "画中画" : "Picture in Picture"}</span>
              <button type="button" onClick={props.onToggleComputerUse}>
                {props.computerUseHidden
                  ? (isZh ? "显示" : "Show")
                  : (isZh ? "隐藏" : "Hide")}
              </button>
            </div>
          </section>
        )}

        <section className="environment-section environment-sources">
          <div className="environment-section-heading">
            <button
              type="button"
              className="environment-sources-title"
              onClick={() => setSourcesOpen(true)}
              aria-label={isZh ? "查看全部来源" : "View all sources"}
            >
              <h3>{isZh ? "来源" : "Sources"}</h3>
              {(sources.length > 0 || searches.length > 0) && (
                <span>{sources.length + searches.length}</span>
              )}
            </button>
            <button type="button" onClick={props.onAddSource} aria-label={isZh ? "添加来源" : "Add source"} title={isZh ? "添加来源" : "Add source"}>
              <IconPlus size={14} />
            </button>
          </div>
          {sources.slice(0, 3).map((file) => (
            <button
              type="button"
              className="environment-source"
              key={file.id}
              title={file.path || file.name}
              onClick={() => setSourcesOpen(true)}
            >
              {file.mime.startsWith("image/") && file.dataUrl ? (
                <img src={file.dataUrl} alt="" />
              ) : (
                <span className="environment-source-icon"><IconFileText size={13} /></span>
              )}
              <span>{file.name}</span>
            </button>
          ))}
          {sources.length > 3 && (
            <button type="button" className="environment-source-more" onClick={() => setSourcesOpen(true)}>
              {isZh ? `另外 ${sources.length - 3} 个附件` : `${sources.length - 3} more attachments`}
            </button>
          )}
          {searches.length > 0 && (
            <button
              type="button"
              className="environment-source web-search"
              onClick={() => setSourcesOpen(true)}
            >
              <span className="environment-source-icon"><IconGlobe size={13} /></span>
              <span>{isZh ? "全网搜索" : "Web search"}</span>
              <span className="environment-source-count">{searches.length}</span>
            </button>
          )}
          {!sources.length && !searches.length ? (
            <div className="environment-empty-row">
              <IconFileText size={14} />
              <span>{isZh ? "当前任务暂无相关资源" : "No task resources yet"}</span>
            </div>
          ) : null}
        </section>
      </div>
      {sourcesOpen && createPortal(
        <div className="sources-dialog-backdrop" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setSourcesOpen(false);
        }}>
          <section
            className="sources-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={isZh ? "任务来源" : "Task sources"}
          >
            <header className="sources-dialog-header">
              <div className="sources-dialog-title">
                <span className="sources-dialog-mark">⌁</span>
                <strong>{isZh ? "来源" : "Sources"}</strong>
                <span>{sources.length + searches.length}</span>
              </div>
              <div className="sources-dialog-actions">
                <button type="button" onClick={props.onAddSource} aria-label={isZh ? "添加来源" : "Add source"}>
                  <IconPlus size={17} />
                </button>
                <button type="button" onClick={() => setSourcesOpen(false)} aria-label={isZh ? "关闭" : "Close"}>×</button>
              </div>
            </header>

            <div className="sources-dialog-body">
              {sources.length > 0 && (
                <section className="sources-group">
                  <h4>{isZh ? `对话附件 · ${sources.length}` : `Conversation attachments · ${sources.length}`}</h4>
                  <div className="sources-file-list">
                    {sources.map((file) => (
                      <article className="sources-file" key={file.id}>
                        {file.mime.startsWith("image/") && file.dataUrl ? (
                          <img src={file.dataUrl} alt="" />
                        ) : (
                          <span className="sources-file-icon"><IconFileText size={18} /></span>
                        )}
                        <div>
                          <strong>{file.name}</strong>
                          <span title={file.path || file.name}>{file.path || file.relativePath || file.name}</span>
                          <small>
                            {pendingIds.has(file.id)
                              ? (isZh ? "等待附加到对话" : "Ready to attach")
                              : (isZh ? "已附加到当前对话" : "Attached to the conversation")}
                          </small>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {searches.length > 0 && (
                <section className="sources-group sources-web-group">
                  <div className="sources-web-heading">
                    <span className="sources-web-icon"><IconGlobe size={16} /></span>
                    <div>
                      <h4>{isZh ? "全网搜索" : "Web search"}</h4>
                      <span>{isZh ? `已搜索 ${searches.length} 次` : `Searched ${searches.length} ${searches.length === 1 ? "time" : "times"}`}</span>
                    </div>
                  </div>
                  <div className="sources-search-list">
                    {searches.map((search) => (
                      <details className="sources-search" key={search.id} open={searches.length === 1}>
                        <summary>
                          <span>{search.query}</span>
                          <small>
                            {search.status === "running"
                              ? (isZh ? "搜索中" : "Searching")
                              : search.status === "error"
                                ? (isZh ? "搜索失败" : "Search failed")
                              : isZh ? `${search.hits.length} 个结果` : `${search.hits.length} results`}
                          </small>
                        </summary>
                        {search.hits.length > 0 ? (
                          <div className="sources-search-results">
                            {search.hits.map((hit) => (
                              <div className="sources-search-result" key={`${search.id}:${hit.url}`}>
                                <span className="sources-result-domain">{domainOf(hit.url)}</span>
                                <strong>{hit.title}</strong>
                                {hit.snippet && <p>{hit.snippet}</p>}
                                <small title={hit.url}>{hit.url}</small>
                              </div>
                            ))}
                          </div>
                        ) : search.status !== "running" ? (
                          <div className="sources-search-empty">
                            {search.status === "error"
                              ? (isZh ? "本次搜索失败；可在对话中的工具输出查看错误。" : "This search failed; see its tool output in the conversation.")
                              : (isZh ? "本次搜索没有返回可展示的网页。" : "This search returned no displayable pages.")}
                          </div>
                        ) : null}
                      </details>
                    ))}
                  </div>
                </section>
              )}

              {!sources.length && !searches.length && (
                <div className="sources-dialog-empty">
                  <IconFileText size={20} />
                  <strong>{isZh ? "当前任务暂无来源" : "No sources for this task"}</strong>
                  <span>{isZh ? "上传图片或文件，或让 Cowork 进行全网搜索。" : "Upload an image or file, or ask Cowork to search the web."}</span>
                  <button type="button" onClick={props.onAddSource}>
                    <IconPlus size={14} />
                    {isZh ? "添加文件" : "Add files"}
                  </button>
                </div>
              )}
            </div>
          </section>
        </div>,
        document.body
      )}
    </aside>
  );
}
