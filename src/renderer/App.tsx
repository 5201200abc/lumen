import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Composer } from "./components/Composer";
import { MessageView } from "./components/Message";
import { SettingsPanel } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { CodexView } from "./components/CodexView";
import type { Attachment, ChatMessage, Conversation, CodexTask, Effort, LlamaStatus, Settings } from "@shared/types";

const WELCOME_PROMPTS = ["What are we going to do?", "What would you like to talk about?"] as const;

function applyTheme(theme: Settings["theme"]): void {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [mode, setMode] = useState<"chat" | "code">("chat");
  const [chats, setChats] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [effort, setEffort] = useState<Effort>("medium");
  const [webSearch, setWebSearch] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [status, setStatus] = useState<LlamaStatus | null>(null);
  const [welcomePrompt, setWelcomePrompt] = useState<(typeof WELCOME_PROMPTS)[number]>(WELCOME_PROMPTS[0]);

  // Codex state
  const [codexTasks, setCodexTasks] = useState<CodexTask[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const seenShot = useRef<Set<string>>(new Set());
  const booted = useRef(false);
  const chatLoad = useRef(0);
  const welcomeIndex = useRef(0);

  const nextWelcomePrompt = useCallback(() => {
    setWelcomePrompt(WELCOME_PROMPTS[welcomeIndex.current % WELCOME_PROMPTS.length]);
    welcomeIndex.current += 1;
  }, []);

  const refreshChats = useCallback(async (q = query) => {
    const list = q.trim() ? await window.lumen.chats.search(q) : await window.lumen.chats.list();
    setChats(list);
    return list;
  }, [query]);

  const refreshCodexTasks = useCallback(async () => {
    const tasks = await window.lumen.codex.listTasks();
    setCodexTasks(tasks);
    return tasks;
  }, []);

  const openChat = useCallback(async (id: string) => {
    const request = ++chatLoad.current;
    setActiveId(id);
    const next = await window.lumen.chats.messages(id);
    if (request === chatLoad.current) {
      setMessages(next);
      if (next.length === 0) nextWelcomePrompt();
    }
  }, [nextWelcomePrompt]);

  const newChat = useCallback(async () => {
    if (streaming && activeId) {
      await window.lumen.chat.stop(activeId);
      setStreaming(false);
    }
    const c = await window.lumen.chats.create();
    setQuery("");
    setChats(await window.lumen.chats.list());
    chatLoad.current += 1;
    setActiveId(c.id);
    setMessages([]);
    setDraft("");
    setAttachments([]);
    nextWelcomePrompt();
  }, [activeId, nextWelcomePrompt, streaming]);

  const handleNewCodexTask = useCallback(async (cwd?: string): Promise<string> => {
    const t = await window.lumen.codex.createTask({ cwd });
    setCodexTasks(await window.lumen.codex.listTasks());
    setActiveTaskId(t.id);
    return t.id;
  }, []);

  const handleDeleteCodexTask = useCallback(async (id: string) => {
    await window.lumen.codex.deleteTask(id);
    const tasks = await window.lumen.codex.listTasks();
    setCodexTasks(tasks);
    if (activeTaskId === id) {
      setActiveTaskId(tasks[0]?.id || null);
    }
  }, [activeTaskId]);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void (async () => {
      const s = await window.lumen.settings.get();
      setSettings(s);
      setEffort(s.defaultEffort);
      applyTheme(s.theme);
      const st = await window.lumen.models.status();
      setStatus(st);
      if (st.model && st.model !== s.model) {
        const next = await window.lumen.settings.set({ model: st.model });
        setSettings(next);
      }
      void window.lumen.models.ensure().then(setStatus);
      const list = await refreshChats("");
      if (list[0]) await openChat(list[0].id);
      else await newChat();

      // Auto summarize existing long titles in background
      void window.lumen.chats.autoSummarize?.().then((updated) => {
        if (updated) setChats(updated);
      });

      const cTasks = await refreshCodexTasks();
      if (cTasks[0]) setActiveTaskId(cTasks[0].id);
    })();
  }, []);

  useEffect(() => {
    const off = [
      window.lumen.chats.onRenamed?.((d) => {
        setChats((prev) =>
          prev.map((c) => (c.id === d.conversationId ? { ...c, title: d.title } : c))
        );
      }),
      window.lumen.codex.onEvent((event) => {
        if (event.type === "renamed" && event.title) {
          setCodexTasks((prev) =>
            prev.map((t) => (t.id === event.taskId ? { ...t, title: event.title } : t))
          );
        }
      }),
      window.lumen.chat.onDelta((d) => {
        if (d.conversationId !== activeId) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === d.messageId
              ? {
                  ...m,
                  content: d.content ?? m.content,
                  thinking: d.thinking ?? m.thinking
                }
              : m
          )
        );
      }),
      window.lumen.chat.onDone((d) => {
        void refreshChats();
        if (d.conversationId !== activeId) return;
        setStreaming(false);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === d.messageId ? { ...m, content: d.content, thinking: d.thinking } : m
          )
        );
      }),
      window.lumen.chat.onError((d) => {
        void refreshChats();
        if (d.conversationId !== activeId) return;
        setStreaming(false);
        setMessages((prev) =>
          prev.map((m) => (m.id === d.messageId ? { ...m, content: `生成失败：${d.error}` } : m))
        );
      }),
      window.lumen.screenshot.onAdded((file) => {
        const key = file.dataUrl.slice(0, 120);
        if (seenShot.current.has(key)) return;
        seenShot.current.add(key);
        void window.lumen.screenshot.ack(file.dataUrl);
        setAttachments((prev) => [
          ...prev,
          { id: crypto.randomUUID(), mime: "image/png", name: file.name, dataUrl: file.dataUrl }
        ]);
      }),
      window.lumen.ui.onSettings(() => setSettingsOpen(true)),
      window.lumen.ui.onNewChat(() => void newChat()),
      window.lumen.ui.onSearch(() => searchRef.current?.focus()),
      window.lumen.ui.onStop(() => {
        if (activeId) void window.lumen.chat.stop(activeId);
      })
    ];
    return () => off.forEach((fn) => fn());
  }, [activeId, newChat, refreshChats]);

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
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, streaming]);

  const send = async (): Promise<void> => {
    if (streaming) return;
    if (!draft.trim() && attachments.length === 0) return;
    userScrolledUp.current = false;
    let conversationId = activeId;
    if (!conversationId) {
      const created = await window.lumen.chats.create();
      conversationId = created.id;
      chatLoad.current += 1;
      setQuery("");
      setChats(await window.lumen.chats.list());
      setActiveId(created.id);
    }
    const content = draft;
    const files = attachments;
    setDraft("");
    setAttachments([]);
    setStreaming(true);
    const user: ChatMessage = {
      id: "tmp-user",
      conversationId,
      role: "user",
      content,
      thinking: "",
      attachments: files,
      createdAt: Date.now()
    };
    const assistant: ChatMessage = {
      id: "tmp-asst",
      conversationId,
      role: "assistant",
      content: "",
      thinking: "",
      attachments: [],
      createdAt: Date.now() + 1
    };
    setMessages((prev) => [...prev, user, assistant]);
    try {
      const ids = await window.lumen.chat.send({
        conversationId,
        content,
        attachments: files,
        effort,
        webSearch
      });
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id === "tmp-user") return { ...m, id: ids.userId };
          if (m.id === "tmp-asst") return { ...m, id: ids.assistantId };
          return m;
        })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStreaming(false);
      if (message === "生成已停止") {
        setMessages((prev) => prev.filter((m) => m.id !== "tmp-user" && m.id !== "tmp-asst"));
        return;
      }
      setMessages((prev) =>
        prev.map((m) =>
          m.id === "tmp-asst"
            ? { ...m, content: `生成失败：${message}` }
            : m
        )
      );
    }
  };

  const regenerate = async (): Promise<void> => {
    if (!activeId || streaming) return;
    const original = [...messages].reverse().find((m) => m.role === "assistant");
    setStreaming(true);
    setMessages((prev) => {
      const next = [...prev];
      const i = [...next].reverse().findIndex((m) => m.role === "assistant");
      if (i >= 0) next.splice(next.length - 1 - i, 1);
      return [
        ...next,
        {
          id: "tmp-asst",
          conversationId: activeId,
          role: "assistant",
          content: "",
          thinking: "",
          attachments: [],
          createdAt: Date.now()
        }
      ];
    });
    try {
      const res = await window.lumen.chat.regenerate(activeId, effort, webSearch);
      if (!res.ok || !res.assistantId) throw new Error("无法重新生成：未找到上一条用户消息");
      setMessages((prev) => prev.map((m) => (m.id === "tmp-asst" ? { ...m, id: res.assistantId! } : m)));
    } catch (err) {
      setStreaming(false);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === "tmp-asst"
            ? original || { ...m, content: `生成失败：${err instanceof Error ? err.message : String(err)}` }
            : m
        )
      );
    }
  };

  const patchSettings = async (patch: Partial<Settings>): Promise<void> => {
    const next = await window.lumen.settings.set(patch);
    setSettings(next);
    applyTheme(next.theme);
  };

  const deleteAllChats = async (): Promise<void> => {
    if (!window.confirm("Delete all chat? This cannot be undone.")) return;
    if (streaming && activeId) await window.lumen.chat.stop(activeId);
    await window.lumen.chats.clear();
    chatLoad.current += 1;
    setStreaming(false);
    setQuery("");
    setChats([]);
    setActiveId(null);
    setMessages([]);
    setDraft("");
    setAttachments([]);
    nextWelcomePrompt();
  };

  const visible = useMemo(() => messages, [messages]);

  if (!settings) return null;

  return (
    <div className="app">
      <Sidebar
        mode={mode}
        onModeChange={setMode}
        chats={chats}
        activeId={activeId}
        query={query}
        searchRef={searchRef}
        onQuery={(q) => {
          setQuery(q);
          void refreshChats(q);
        }}
        onSelect={(id) => {
          if (streaming && activeId && id !== activeId) {
            void window.lumen.chat.stop(activeId);
            setStreaming(false);
          }
          void openChat(id);
        }}
        onNew={() => void newChat()}
        onDelete={async (id) => {
          if (!window.confirm("Delete this chat? This cannot be undone.")) return;
          await window.lumen.chats.delete(id);
          const list = query.trim() ? await window.lumen.chats.search(query) : await window.lumen.chats.list();
          setChats(list);
          if (id === activeId) {
            setStreaming(false);
            if (list[0]) await openChat(list[0].id);
            else {
              chatLoad.current += 1;
              setActiveId(null);
              setMessages([]);
              nextWelcomePrompt();
            }
          }
        }}
        onSettings={() => setSettingsOpen(true)}
        codexTasks={codexTasks}
        activeTaskId={activeTaskId}
        onSelectCodexTask={setActiveTaskId}
        onNewCodexTask={() => void handleNewCodexTask()}
        onDeleteCodexTask={(id) => void handleDeleteCodexTask(id)}
      />
      <div className="v-line" />
      <section className="main">
        {mode === "code" ? (
          <CodexView
            activeTaskId={activeTaskId}
            tasks={codexTasks}
            onSelectTask={setActiveTaskId}
            onNewTask={handleNewCodexTask}
            onDeleteTask={handleDeleteCodexTask}
            model={settings.model}
            models={status?.models?.length ? status.models : [settings.model]}
            effort={effort}
            onModel={(m) => void patchSettings({ model: m })}
            onEffort={setEffort}
          />
        ) : (
          <>
            <header className="main-top" />
            <div className="thread" ref={threadRef} onScroll={handleScroll}>
              <div className="thread-inner">
                {visible.length === 0 ? (
                  <div className="empty">
                    <h1>Lumen</h1>
                    <p>{welcomePrompt}</p>
                  </div>
                ) : (
                  visible.map((m, i) => (
                    <MessageView
                      key={m.id}
                      message={m}
                      streaming={streaming && i === visible.length - 1 && m.role === "assistant"}
                      onRegenerate={m.role === "assistant" && i === visible.length - 1 ? regenerate : undefined}
                    />
                  ))
                )}
              </div>
            </div>
            <Composer
              value={draft}
              model={settings.model}
              models={status?.models?.length ? status.models : [settings.model]}
              effort={effort}
              webSearch={webSearch}
              streaming={streaming}
              attachments={attachments}
              onChange={setDraft}
              onModel={(m) => void patchSettings({ model: m })}
              onEffort={setEffort}
              onWebSearch={setWebSearch}
              onSend={() => void send()}
              onStop={() => activeId && void window.lumen.chat.stop(activeId)}
              onAttach={(files) => setAttachments((prev) => [...prev, ...files])}
              onRemove={(id) => setAttachments((prev) => prev.filter((a) => a.id !== id))}
            />
          </>
        )}
      </section>
      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onChange={(p) => void patchSettings(p)}
          onClose={() => setSettingsOpen(false)}
          onDeleteAllMemories={() => void window.lumen.memory.clear()}
          onDeleteAllChats={() => void deleteAllChats()}
        />
      )}
    </div>
  );
}
