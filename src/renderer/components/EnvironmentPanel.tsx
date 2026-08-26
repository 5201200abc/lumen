import type { Attachment, CodexMessage, CoworkEngine, WorkspaceInfo } from "@shared/types";
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
  engine: CoworkEngine;
  model: string;
  messages: CodexMessage[];
  attachments: Attachment[];
  onSelectWorkspace: () => void;
  onAddSource: () => void;
  onPrompt: (prompt: string) => void;
};

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function sourceFiles(messages: CodexMessage[], pending: Attachment[]): Attachment[] {
  const files = [...pending, ...messages.flatMap((message) => message.attachments || [])];
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = file.path || file.dataUrl?.slice(0, 96) || `${file.name}:${file.size || 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function EnvironmentPanel(props: Props) {
  const isZh = (props.language ?? "en") === "zh";
  const changes = props.workspace?.changes || { files: 0, additions: 0, deletions: 0 };
  const sources = sourceFiles(props.messages, props.attachments).slice(0, 3);
  const activeTool = props.messages
    .flatMap((message) => message.toolCalls || [])
    .find((tool) => tool.status === "running");
  const branch = props.workspace?.branch || (isZh ? "无 Git" : "No Git");

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
                {activeTool ? toolDescription(activeTool) : `${props.engine === "claude-code" ? "Claude Code" : "Codex"} · ${props.model}`}
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

        <section className="environment-section environment-sources">
          <div className="environment-section-heading">
            <h3>{isZh ? "来源" : "Sources"}</h3>
            <button type="button" onClick={props.onAddSource} aria-label={isZh ? "添加来源" : "Add source"} title={isZh ? "添加来源" : "Add source"}>
              <IconPlus size={14} />
            </button>
          </div>
          {sources.map((file) => (
            <div className="environment-source" key={file.id} title={file.path || file.name}>
              {file.mime.startsWith("image/") && file.dataUrl ? (
                <img src={file.dataUrl} alt="" />
              ) : (
                <span className="environment-source-icon"><IconFileText size={13} /></span>
              )}
              <span>{file.name}</span>
            </div>
          ))}
          <button
            type="button"
            className="environment-source capability"
            onClick={() => props.onPrompt(isZh ? "使用联网搜索或浏览器检索此任务的相关信息，并给出参考来源。" : "Use web search or browser control to research the task, then cite the relevant sources.")}
          >
            <span className="environment-source-icon"><IconGlobe size={13} /></span>
            <span>{isZh ? "联网检索与浏览器" : "Web search & browser"}</span>
          </button>
          <button
            type="button"
            className="environment-source capability"
            onClick={() => props.onPrompt(isZh ? "使用电脑操作功能检查并操作该任务相关的应用程序界面。" : "Use Computer Use to inspect and operate the relevant application UI for this task.")}
          >
            <span className="environment-source-icon"><IconLaptop size={13} /></span>
            <span>{isZh ? "电脑操作" : "Computer use"}</span>
          </button>
        </section>
      </div>
    </aside>
  );
}
