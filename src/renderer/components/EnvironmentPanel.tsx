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
  const changes = props.workspace?.changes || { files: 0, additions: 0, deletions: 0 };
  const sources = sourceFiles(props.messages, props.attachments).slice(0, 3);
  const activeTool = props.messages
    .flatMap((message) => message.toolCalls || [])
    .find((tool) => tool.status === "running");
  const branch = props.workspace?.branch || "No Git";

  return (
    <aside className="environment-rail" aria-label="Environment">
      <div className="environment-card">
        <div className="environment-heading">
          <span>Environment</span>
          <button type="button" className="environment-plus" onClick={props.onSelectWorkspace} aria-label="Choose workspace" title="Choose workspace">
            <IconPlus size={18} />
          </button>
        </div>

        <div className="environment-list">
          <button
            type="button"
            className="environment-row"
            onClick={() => props.onPrompt("Review the current working tree changes and summarize the important risks.")}
          >
            <IconChanges size={16} />
            <span className="environment-row-label">Changes</span>
            <span className="environment-change-count">
              <span className="added">+{compactNumber(changes.additions)}</span>
              <span className="deleted">−{compactNumber(changes.deletions)}</span>
            </span>
          </button>
          <button type="button" className="environment-row" onClick={props.onSelectWorkspace}>
            <IconLaptop size={16} />
            <span className="environment-row-label">{props.workspace?.location || "Local"}</span>
            <IconChevronDown size={14} />
          </button>
          <button
            type="button"
            className="environment-row"
            onClick={() => props.onPrompt(`Inspect the current Git branch "${branch}" and report its status.`)}
          >
            <IconBranch size={16} />
            <span className="environment-row-label">{branch}</span>
            <IconChevronDown size={14} />
          </button>
          <button
            type="button"
            className="environment-row"
            disabled={!props.workspace?.branch}
            onClick={() => props.onPrompt("Review the current changes, run the relevant checks, then commit and push when the repository is ready.")}
          >
            <IconChanges size={16} />
            <span className="environment-row-label">Commit or push</span>
          </button>
          <button
            type="button"
            className="environment-row"
            disabled={!props.workspace?.branch || !props.workspace?.hasRemote}
            onClick={() => props.onPrompt("Compare the current branch with its upstream branch and summarize the meaningful differences.")}
          >
            <IconGithub size={16} />
            <span className="environment-row-label">Compare branch</span>
            <IconExternal size={14} />
          </button>
        </div>

        <section className="environment-section">
          <h3>Background processes</h3>
          {props.running ? (
            <div className="environment-process">
              <IconTerminal size={16} />
              <span title={activeTool ? toolDescription(activeTool) : undefined}>
                {activeTool ? toolDescription(activeTool) : `${props.engine === "claude-code" ? "Claude Code" : "Codex"} · ${props.model}`}
              </span>
              <span className="environment-live-dot" aria-label="Running" />
            </div>
          ) : (
            <div className="environment-empty-row">
              <IconTerminal size={16} />
              <span>No active processes</span>
            </div>
          )}
        </section>

        <section className="environment-section environment-sources">
          <div className="environment-section-heading">
            <h3>Sources</h3>
            <button type="button" onClick={props.onAddSource} aria-label="Add source" title="Add source">
              <IconPlus size={17} />
            </button>
          </div>
          {sources.map((file) => (
            <div className="environment-source" key={file.id} title={file.path || file.name}>
              {file.mime.startsWith("image/") && file.dataUrl ? (
                <img src={file.dataUrl} alt="" />
              ) : (
                <span className="environment-source-icon"><IconFileText size={14} /></span>
              )}
              <span>{file.name}</span>
            </div>
          ))}
          <button
            type="button"
            className="environment-source capability"
            onClick={() => props.onPrompt("Use web search or browser control to research the task, then cite the relevant sources.")}
          >
            <span className="environment-source-icon"><IconGlobe size={15} /></span>
            <span>Web search & browser</span>
          </button>
          <button
            type="button"
            className="environment-source capability"
            onClick={() => props.onPrompt("Use Computer Use to inspect and operate the relevant application UI for this task.")}
          >
            <span className="environment-source-icon"><IconLaptop size={15} /></span>
            <span>Computer use</span>
          </button>
        </section>
      </div>
    </aside>
  );
}
