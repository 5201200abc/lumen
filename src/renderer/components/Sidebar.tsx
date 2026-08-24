import { useState, type RefObject } from "react";
import type { Conversation, CodexTask, GoogleAccount } from "@shared/types";
import { IconChatBubble, IconCompose, IconLumen, IconSearch, IconSidebar, IconTrash } from "./icons";
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
  onToggleSidebar?: () => void;
  collapsed?: boolean;
  account: GoogleAccount;
  accountBusy: boolean;
  onGoogleLogin: () => void;
  onGoogleCancelLogin: () => void;
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

function initials(account: GoogleAccount): string {
  const source = account.name || account.email || "Lumen";
  return source.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function time(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function Sidebar(props: Props) {
  const [searchOpen, setSearchOpen] = useState(false);

  if (props.collapsed) {
    return (
      <aside className="sidebar collapsed">
        <div className="drag" />
        <div className="sidebar-collapsed-rail">
          <div className="collapsed-top-icons">
            <button
              type="button"
              className="collapsed-icon-btn logo-btn"
              onClick={props.onToggleSidebar}
              title="Expand sidebar (展开侧边栏 ⌘B)"
              aria-label="Expand sidebar"
            >
              <IconLumen size={20} />
            </button>
            <button
              type="button"
              className="collapsed-icon-btn"
              onClick={props.mode === "code" ? () => props.onNewCodexTask?.() : props.onNew}
              title="New chat (新建会话 ⌘N)"
              aria-label="New chat"
            >
              <IconCompose size={17} />
            </button>
            <button
              type="button"
              className="collapsed-icon-btn"
              onClick={() => {
                props.onToggleSidebar?.();
                setTimeout(() => props.searchRef.current?.focus(), 50);
              }}
              title="Search (搜索会话)"
              aria-label="Search"
            >
              <IconSearch size={16} />
            </button>
            <button
              type="button"
              className={`collapsed-icon-btn ${props.mode === "chat" ? "active" : ""}`}
              onClick={() => {
                if (props.mode !== "chat") props.onModeChange("chat");
                props.onToggleSidebar?.();
              }}
              title="Chat conversations (聊天会话)"
              aria-label="Chat conversations"
            >
              <IconChatBubble size={16} />
            </button>
          </div>
          <div className="collapsed-foot">
            <button
              type="button"
              className="collapsed-icon-btn avatar-btn"
              onClick={props.onToggleSidebar}
              title="Expand sidebar (展开侧边栏 ⌘B)"
              aria-label="Expand sidebar"
            >
              <span className="account-avatar">{initials(props.account)}</span>
            </button>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div className="drag" />
      <div className="side-top-bar">
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

        <div className="side-top-actions">
          {props.mode === "chat" && (
            <button
              className={`icon-btn ghost-icon side-action-btn ${searchOpen ? "active" : ""}`}
              type="button"
              title="Search (搜索对话)"
              aria-label="Search"
              onClick={() => {
                setSearchOpen((prev) => {
                  const next = !prev;
                  if (!next) props.onQuery("");
                  else setTimeout(() => props.searchRef.current?.focus(), 50);
                  return next;
                });
              }}
            >
              <IconSearch size={15} />
            </button>
          )}
          {props.onToggleSidebar && (
            <button
              className="icon-btn ghost-icon side-action-btn"
              type="button"
              title="Collapse sidebar (⌘B)"
              aria-label="Collapse sidebar"
              onClick={props.onToggleSidebar}
            >
              <IconSidebar size={15} />
            </button>
          )}
        </div>
      </div>

      {props.mode === "chat" ? (
        <>
          {searchOpen && (
            <div className="side-search-bar">
              <input
                ref={props.searchRef}
                placeholder="搜索对话..."
                value={props.query}
                onChange={(e) => props.onQuery(e.target.value)}
                autoFocus
              />
              {props.query ? (
                <button
                  type="button"
                  className="side-search-clear"
                  onClick={() => {
                    props.onQuery("");
                    props.searchRef.current?.focus();
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
          )}

          <button className="new-chat-btn" type="button" onClick={props.onNew} title="New chat (⌘N)">
            <IconCompose size={16} />
            <span>New chat</span>
          </button>

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
            {props.chats.length === 0 && (
              <div className="empty-tasks-hint">暂无历史会话</div>
            )}
          </div>
        </>
      ) : (
        <>
          <button
            className="new-chat-btn"
            type="button"
            onClick={() => props.onNewCodexTask && props.onNewCodexTask()}
            title="New chat (⌘N)"
          >
            <IconCompose size={16} />
            <span>New chat</span>
          </button>

          <div className="chats">
            {(props.codexTasks || []).map((t) => (
              <div
                key={t.id}
                className={`chat-item ${t.id === props.activeTaskId ? "active" : ""}`}
                onClick={() => props.onSelectCodexTask && props.onSelectCodexTask(t.id)}
              >
                <div>
                  <div className="title">{t.title || "新会话"}</div>
                  <div className="meta">{time(t.updatedAt)}</div>
                </div>
                <button
                  className="del"
                  type="button"
                  aria-label={`删除会话：${t.title}`}
                  title="删除会话"
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
              <div className="empty-tasks-hint">暂无历史会话</div>
            )}
          </div>
        </>
      )}

      <div className="side-foot">
        <AccountMenu
          account={props.account}
          busy={props.accountBusy}
          onLogin={props.onGoogleLogin}
          onCancelLogin={props.onGoogleCancelLogin}
          onLogout={props.onGoogleLogout}
          onSync={props.onGoogleSync}
          onSettings={props.onSettings}
        />
      </div>
    </aside>
  );
}
