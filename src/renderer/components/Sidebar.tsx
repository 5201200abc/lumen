import type { RefObject } from "react";
import type { Conversation, CodexTask, GoogleAccount } from "@shared/types";
import { IconPlus, IconTrash } from "./icons";
import { AccountMenu } from "./AccountMenu";

type Props = {
  mode: "chat" | "code";
  onModeChange: (m: "chat" | "code") => void;
  chats: Conversation[];
  activeId: string | null;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onSettings: () => void;
  account: GoogleAccount;
  accountBusy: boolean;
  onGoogleLogin: () => void;
  onGoogleLogout: () => void;
  onGoogleSync: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
  // Codex task props
  codexTasks?: CodexTask[];
  activeTaskId?: string | null;
  onSelectCodexTask?: (id: string) => void;
  onNewCodexTask?: () => void;
  onDeleteCodexTask?: (id: string) => void;
};

function time(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function Sidebar(props: Props) {
  return (
    <aside className="sidebar">
      <div className="drag" />
      <div className="side-top-bar">
        <div className="brand">Lumen</div>
        <div className="segmented-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={props.mode === "chat"}
            className={`tab-item ${props.mode === "chat" ? "active" : ""}`}
            onClick={() => props.onModeChange("chat")}
          >
            Chat
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={props.mode === "code"}
            className={`tab-item ${props.mode === "code" ? "active" : ""}`}
            onClick={() => props.onModeChange("code")}
          >
            Cowork
          </button>
        </div>
      </div>
      {props.mode === "chat" ? (
        <>
          <div className="side-tools">
            <input
              ref={props.searchRef}
              placeholder="搜索对话"
              value={props.query}
              onChange={(e) => props.onQuery(e.target.value)}
            />
            <button className="icon-btn plus" type="button" onClick={props.onNew} title="新对话 ⌘N">
              <IconPlus />
            </button>
          </div>
          <div className="chats">
            {props.chats.map((c) => (
              <div
                key={c.id}
                className={`chat-item ${c.id === props.activeId ? "active" : ""}`}
                onClick={() => props.onSelect(c.id)}
              >
                <div>
                  <div className="title">{c.title || "新对话"}</div>
                  <div className="meta">{time(c.updatedAt)}</div>
                </div>
                <button
                  className="del"
                  type="button"
                  aria-label={`删除对话：${c.title || "新对话"}`}
                  title="删除对话"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onDelete(c.id);
                  }}
                >
                  <IconTrash size={15} />
                </button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="side-tools">
            <div className="codex-side-header-title">任务列表</div>
          </div>
          <div className="chats">
            {(props.codexTasks || []).map((t) => (
              <div
                key={t.id}
                className={`chat-item ${t.id === props.activeTaskId ? "active" : ""}`}
                onClick={() => props.onSelectCodexTask && props.onSelectCodexTask(t.id)}
              >
                <div>
                  <div className="title">{t.title || "编程任务"}</div>
                  <div className="meta">{time(t.updatedAt)}</div>
                </div>
                <button
                  className="del"
                  type="button"
                  aria-label={`删除任务：${t.title}`}
                  title="删除任务"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onDeleteCodexTask && props.onDeleteCodexTask(t.id);
                  }}
                >
                  <IconTrash size={15} />
                </button>
              </div>
            ))}
            {(!props.codexTasks || props.codexTasks.length === 0) && (
              <div className="empty-tasks-hint">暂无历史</div>
            )}
          </div>
        </>
      )}
      <div className="side-foot">
        <AccountMenu
          account={props.account}
          busy={props.accountBusy}
          onLogin={props.onGoogleLogin}
          onLogout={props.onGoogleLogout}
          onSync={props.onGoogleSync}
          onSettings={props.onSettings}
        />
      </div>
    </aside>
  );
}
