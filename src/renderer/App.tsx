import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Composer } from "./components/Composer";
import { MessageView } from "./components/Message";
import { SettingsPanel } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { CodexView } from "./components/CodexView";
import { IconSidebar } from "./components/icons";
import type { Attachment, ChatMessage, Conversation, CodexTask, CoworkEngine, Effort, GoogleAccount, LlamaStatus, Settings } from "@shared/types";
import { detectReasoningControl } from "@shared/types";
import { planChatRequest } from "@shared/chat-plan";

const WELCOME_PROMPTS = {
  en: ["What are we going to do?", "What would you like to talk about?"],
  zh: ["我们接下来要做什么？", "你想聊些什么？"]
} as const;

function applyTheme(theme: Settings["theme"]): void {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

function applyPreferences(settings: Pick<Settings, "theme" | "language" | "fontSize">): void {
  applyTheme(settings.theme);
  document.documentElement.lang = settings.language === "zh" ? "zh-CN" : "en";
  const rawSize = settings.fontSize || 13;
  const numSize = rawSize === "small" ? 13 : rawSize === "medium" ? 15 : rawSize === "large" ? 16 : parseInt(String(rawSize), 10) || 13;
  document.documentElement.dataset.fontSize = String(numSize);
  document.documentElement.style.setProperty("--base-font-size", `${numSize}px`);
}

function modelsFromStatus(settings: Settings, status: LlamaStatus): Settings["llamaModels"] {
  const activeEndpoint =
    settings.llamaEndpoints.find((endpoint) => endpoint.url === settings.llamaUrl) ||
    settings.llamaEndpoints[0];
  const localEndpoint = settings.llamaEndpoints.find((endpoint) =>
    /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/v1\/?$/i.test(endpoint.url)
  );
  if (!activeEndpoint || !localEndpoint) return settings.llamaModels;
  const replacedEndpointIds = new Set(
    settings.llamaEndpoints
      .filter((endpoint) => /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/v1\/?$/i.test(endpoint.url))
      .map((endpoint) => endpoint.id)
  );
  const preserved = settings.llamaModels.filter((model) => !replacedEndpointIds.has(model.endpointId));
  const localModels = status.localModels.map((model) => ({
    id: `local:${model.name}`,
    name: model.name,
    endpointId: localEndpoint.id,
    reasoningControl: model.reasoningControl,
    reasoningEfforts: model.reasoningEfforts,
    source: "local" as const
  }));
  const remoteModels = activeEndpoint.id === localEndpoint.id
    ? []
    : status.models.map((name) => ({
        id: `${activeEndpoint.id}:${name}`,
        name,
        endpointId: activeEndpoint.id,
        reasoningControl: detectReasoningControl(name),
        source: "remote" as const
      }));
  return [...preserved, ...localModels, ...remoteModels].slice(0, 5);
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [mode, setMode] = useState<"chat" | "code">("chat");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [chats, setChats] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [effort, setEffort] = useState<Effort>("xhigh");
  const [webSearch, setWebSearch] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<"general" | "models">("general");
  const [status, setStatus] = useState<LlamaStatus | null>(null);
  const [account, setAccount] = useState<GoogleAccount>({ configured: false, connected: false });
  const [accountBusy, setAccountBusy] = useState(false);
  const [welcomePrompt, setWelcomePrompt] = useState<string>(WELCOME_PROMPTS.en[0]);

  // Codex state
  const [codexTasks, setCodexTasks] = useState<CodexTask[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const seenShot = useRef<Set<string>>(new Set());
  const booted = useRef(false);
  const chatLoad = useRef(0);
  const welcomeIndex = useRef(0);
  const settingsWrite = useRef<Promise<void>>(Promise.resolve());
  const accountAction = useRef<"login" | "logout" | "sync" | null>(null);
  const loginStartedAt = useRef(0);

  const refreshDetectedModels = useCallback(async (restartRouter = false) => {
    let current = await window.lumen.settings.get();
    const nextStatus = restartRouter
      ? await window.lumen.models.reconnect()
      : await window.lumen.models.status();
    const detectedModels = modelsFromStatus(current, nextStatus);
    const selectedExists = detectedModels.some((model) => model.name === current.model);
    const nextModel = selectedExists ? current.model : detectedModels[0]?.name || "";
    if (
      JSON.stringify(detectedModels) !== JSON.stringify(current.llamaModels) ||
      nextModel !== current.model
    ) {
      current = await window.lumen.settings.set({
        llamaModels: detectedModels,
        modelCatalog: detectedModels.map((model) => model.name),
        model: nextModel
      });
    }
    setSettings(current);
    setStatus(nextStatus);
    return { settings: current, status: nextStatus };
  }, []);

  const refreshLocalModels = useCallback(async () => {
    await refreshDetectedModels(true);
  }, [refreshDetectedModels]);

  const nextWelcomePrompt = useCallback(() => {
    const isZh = settings?.language === "zh";
    const list = isZh ? WELCOME_PROMPTS.zh : WELCOME_PROMPTS.en;
    setWelcomePrompt(list[welcomeIndex.current % list.length]);
    welcomeIndex.current += 1;
  }, [settings?.language]);

  useEffect(() => {
    const isZh = settings?.language === "zh";
    const list = isZh ? WELCOME_PROMPTS.zh : WELCOME_PROMPTS.en;
    setWelcomePrompt(list[welcomeIndex.current % list.length]);
  }, [settings?.language]);

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
    setQuery("");
    setChats(await window.lumen.chats.list());
    chatLoad.current += 1;
    setActiveId(null);
    setMessages([]);
    setDraft("");
    setAttachments([]);
    nextWelcomePrompt();
  }, [activeId, nextWelcomePrompt, streaming]);

  const handleNewCodexTask = useCallback(async (cwd?: string, engine?: CoworkEngine): Promise<string> => {
    const t = await window.lumen.codex.createTask({ cwd, engine: engine || settings?.coworkEngine || "claude-code" });
    setCodexTasks(await window.lumen.codex.listTasks());
    setActiveTaskId(t.id);
    return t.id;
  }, [settings?.coworkEngine]);

  const cleanCodexTask = useCallback(async () => {
    if (activeTaskId) await window.lumen.codex.stop(activeTaskId);
    setActiveTaskId(null);
  }, [activeTaskId]);

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
      const refreshed = await refreshDetectedModels();
      const s = refreshed.settings;
      applyPreferences(s);
      setAccount(await window.lumen.google.status());
      const initialModel = s.llamaModels.find((model) => model.name === s.model);
      setEffort(initialModel?.reasoningEfforts?.includes(s.defaultEffort)
        ? s.defaultEffort
        : initialModel?.reasoningEfforts?.at(-1) || s.defaultEffort);
      setSettings(s);
      void window.lumen.models.ensure().then(setStatus);
      const list = await refreshChats("");
      if (list[0]) await openChat(list[0].id);
      else {
        setActiveId(null);
        setMessages([]);
        nextWelcomePrompt();
      }

      // Auto summarize existing long titles in background
      void window.lumen.chats.autoSummarize?.().then((updated) => {
        if (updated) setChats(updated);
      });

      const cTasks = await refreshCodexTasks();
      if (cTasks[0]) setActiveTaskId(cTasks[0].id);
    })();
  }, [refreshDetectedModels]);

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
            m.id === d.messageId || (m.id === "tmp-asst" && m.role === "assistant")
              ? {
                  ...m,
                  content: d.content ?? m.content,
                  thinking: d.thinking ?? m.thinking,
                  phase: d.phase ?? m.phase,
                  statusText: d.statusText ?? m.statusText,
                  phaseStartedAt:
                    d.phase === "thinking" && m.phase !== "thinking"
                      ? Date.now()
                      : m.phaseStartedAt
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
            m.id === d.messageId || (m.id === "tmp-asst" && m.role === "assistant")
              ? {
                  ...m,
                  id: d.messageId,
                  content: d.content,
                  thinking: d.thinking,
                  phase: "done",
                  statusText: "",
                  durationSeconds: d.durationSeconds
                }
              : m
          )
        );
      }),
      window.lumen.chat.onError((d) => {
        void refreshChats();
        if (d.conversationId !== activeId) return;
        setStreaming(false);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === d.messageId || (m.id === "tmp-asst" && m.role === "assistant")
              ? { ...m, id: d.messageId, content: `Generation failed: ${d.error}`, phase: "error", statusText: "" }
              : m
          )
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
      window.lumen.ui.onNewChat(() => {
        if (mode === "code") void cleanCodexTask();
        else void newChat();
      }),
      window.lumen.ui.onSearch(() => searchRef.current?.focus()),
      window.lumen.ui.onStop(() => {
        if (activeId) void window.lumen.chat.stop(activeId);
      })
    ];
    return () => off.forEach((fn) => fn());
  }, [activeId, cleanCodexTask, mode, newChat, refreshChats]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === "b" || e.key === "\\")) {
        e.preventDefault();
        setSidebarOpen((prev) => !prev);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
      if (e.key === "Escape" && settingsOpen) {
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

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
    let createdConversation = false;
    if (!conversationId) {
      const created = await window.lumen.chats.create();
      conversationId = created.id;
      createdConversation = true;
      chatLoad.current += 1;
      setQuery("");
      setChats(await window.lumen.chats.list());
      setActiveId(created.id);
    }
    const content = draft;
    const files = attachments;
    const isZh = (settings?.language ?? "en") === "zh";
    const plan = planChatRequest(content, webSearch, settings?.language ?? "en");
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
      createdAt: Date.now() + 1,
      phase: "preparing",
      introText: plan.action,
      statusText: plan.useWeb
        ? (isZh ? "正在准备深度研究" : "Preparing Deep Research")
        : (isZh ? "正在生成回答" : "Generating response")
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
      if (createdConversation) {
        const persisted = await window.lumen.chats.messages(conversationId);
        if (persisted.length === 0) {
          await window.lumen.chats.delete(conversationId);
          setActiveId(null);
          setChats(await window.lumen.chats.list());
        }
      }
      if (message === "生成已停止") {
        setMessages((prev) => prev.filter((m) => m.id !== "tmp-user" && m.id !== "tmp-asst"));
        return;
      }
      setMessages((prev) =>
        prev.map((m) =>
          m.id === "tmp-asst"
            ? { ...m, content: `Generation failed: ${message}` }
            : m
        )
      );
    }
  };

  const handleEditMessage = async (
    _messageId: string,
    content: string,
    files: Attachment[] = []
  ): Promise<void> => {
    if (streaming) return;
    if (!content.trim() && files.length === 0) return;
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
    const isZh = (settings?.language ?? "en") === "zh";
    const plan = planChatRequest(content, webSearch, settings?.language ?? "en");
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
      createdAt: Date.now() + 1,
      phase: "preparing",
      introText: plan.action,
      statusText: plan.useWeb
        ? (isZh ? "正在准备深度研究" : "Preparing Deep Research")
        : (isZh ? "正在生成回答" : "Generating response")
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
            ? { ...m, content: `Generation failed: ${message}` }
            : m
        )
      );
    }
  };

  const regenerate = async (): Promise<void> => {
    if (!activeId || streaming) return;
    const original = [...messages].reverse().find((m) => m.role === "assistant");
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const isZh = (settings?.language ?? "en") === "zh";
    const plan = planChatRequest(lastUser?.content || "", webSearch, settings?.language ?? "en");
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
          createdAt: Date.now(),
          phase: "preparing",
          introText: plan.action,
          statusText: plan.useWeb
            ? (isZh ? "正在准备深度研究" : "Preparing Deep Research")
            : (isZh ? "正在生成回答" : "Generating response")
        }
      ];
    });
    try {
      const res = await window.lumen.chat.regenerate(activeId, effort, webSearch);
      if (!res.ok || !res.assistantId) throw new Error("Could not regenerate because the previous user message was not found.");
      setMessages((prev) => prev.map((m) => (m.id === "tmp-asst" ? { ...m, id: res.assistantId! } : m)));
    } catch (err) {
      setStreaming(false);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === "tmp-asst"
            ? original || { ...m, content: `Generation failed: ${err instanceof Error ? err.message : String(err)}` }
            : m
        )
      );
    }
  };

  const patchSettings = async (patch: Partial<Settings>): Promise<void> => {
    setSettings((current) => (current ? { ...current, ...patch } : current));
    if (patch.theme !== undefined || patch.language !== undefined || patch.fontSize !== undefined) {
      const next = { ...settings!, ...patch };
      applyPreferences(next);
    }
    if (patch.defaultEffort !== undefined) setEffort(patch.defaultEffort);

    const write = settingsWrite.current.then(async () => {
      await window.lumen.settings.set(patch);
    });
    settingsWrite.current = write.catch(() => undefined);
    await write;
  };

  const runAccountAction = async (action: "login" | "logout" | "sync"): Promise<void> => {
    accountAction.current = action;
    if (action === "login") loginStartedAt.current = Date.now();
    setAccountBusy(true);
    try {
      setAccount(await window.lumen.google[action]());
    } catch (error) {
      setAccount((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error)
      }));
    } finally {
      accountAction.current = null;
      setAccountBusy(false);
    }
  };

  useEffect(() => {
    const cancelAbandonedLogin = () => {
      if (accountAction.current !== "login" || Date.now() - loginStartedAt.current < 1500) return;
      void window.lumen.google.cancelLogin();
    };
    window.addEventListener("focus", cancelAbandonedLogin);
    return () => window.removeEventListener("focus", cancelAbandonedLogin);
  }, []);

  const deleteAllChats = async (): Promise<boolean> => {
    if (!window.confirm("Delete all chat? This cannot be undone.")) return false;
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
    return true;
  };

  const visible = useMemo(() => messages, [messages]);

  if (!settings) return null;
  const activeEndpoint = settings.llamaEndpoints.find((endpoint) => endpoint.url === settings.llamaUrl);
  const configuredModels = settings.llamaModels.filter((model) => !activeEndpoint || model.endpointId === activeEndpoint.id);
  const activeModel = settings.llamaModels.find((model) => model.name === settings.model && (!activeEndpoint || model.endpointId === activeEndpoint.id));
  const reasoningControl = activeModel?.reasoningControl ?? detectReasoningControl(settings.model);
  const reasoningEfforts = activeModel?.reasoningEfforts;
  const selectModel = async (model: string) => {
    const configured = settings.llamaModels.find((item) => item.name === model && (!activeEndpoint || item.endpointId === activeEndpoint.id));
    const supported = configured?.reasoningEfforts;
    const nextEffort = supported?.includes(effort) ? effort : (supported?.includes(settings.defaultEffort) ? settings.defaultEffort : supported?.[supported.length - 1]);
    if (nextEffort) setEffort(nextEffort);
    await patchSettings({ model });
    setStatus(await window.lumen.models.status());
  };

  return (
    <>
      <div className={`app ${!sidebarOpen ? "sidebar-collapsed" : ""}`}>
        <Sidebar
          language={settings.language}
          mode={mode}
          onModeChange={setMode}
          chats={chats}
          activeId={activeId}
          query={query}
          searchRef={searchRef}
          collapsed={!sidebarOpen}
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
            const isZh = settings.language === "zh";
            if (!window.confirm(isZh ? "确定删除此对话吗？此操作无法撤销。" : "Delete this chat? This cannot be undone.")) return;
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
          onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
          account={account}
          accountBusy={accountBusy}
          onGoogleLogin={() => void runAccountAction("login")}
          onGoogleCancelLogin={() => void window.lumen.google.cancelLogin()}
          onGoogleLogout={() => void runAccountAction("logout")}
          onGoogleSync={() => void runAccountAction("sync")}
          codexTasks={codexTasks}
          activeTaskId={activeTaskId}
          onSelectCodexTask={setActiveTaskId}
          onNewCodexTask={() => void cleanCodexTask()}
          onDeleteCodexTask={(id) => void handleDeleteCodexTask(id)}
        />
        <div className="v-line" />
        <section className="main">
          <div className="mode-pane" hidden={mode !== "code"}>
            <CodexView
              language={settings.language}
              sidebarOpen={sidebarOpen}
              onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
              activeTaskId={activeTaskId}
              tasks={codexTasks}
              onSelectTask={setActiveTaskId}
              onNewTask={handleNewCodexTask}
              onDeleteTask={handleDeleteCodexTask}
              model={settings.model}
              models={[...new Set(configuredModels.map((model) => model.name))]}
              effort={effort}
              onModel={(m) => void selectModel(m)}
              onEffort={setEffort}
              reasoningControl={reasoningControl}
              reasoningEfforts={reasoningEfforts}
              engine={settings.coworkEngine}
              capabilityVersion={`${Number(settings.plugins.browser)}${Number(settings.plugins.sites)}${Number(settings.plugins.plugins)}${Number(settings.computerUseChromeEnabled)}`}
              permissionMode={settings.coworkPermissionMode}
              defaultPermissions={settings.coworkDefaultPermissions}
              fullAccess={settings.coworkFullAccess}
              onPermissionMode={(coworkPermissionMode) => void patchSettings({ coworkPermissionMode })}
              onEngine={(engine) => {
                void patchSettings({ coworkEngine: engine });
                setActiveTaskId(null);
              }}
            />
          </div>
          <div className="mode-pane" hidden={mode !== "chat"}>
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
                        language={settings?.language ?? "en"}
                        streaming={streaming && i === visible.length - 1 && m.role === "assistant"}
                        onRegenerate={m.role === "assistant" && i === visible.length - 1 ? regenerate : undefined}
                        onEdit={m.role === "user" ? (id, text, atts) => void handleEditMessage(id, text, atts) : undefined}
                      />
                    ))
                  )}
                </div>
              </div>
              <Composer
                value={draft}
                model={settings.model}
                models={[...new Set([...configuredModels.map((model) => model.name), ...(status?.models || []), settings.model])]}
                effort={effort}
                webSearch={webSearch}
                streaming={streaming}
                attachments={attachments}
                onChange={setDraft}
                onModel={(m) => void selectModel(m)}
                onEffort={setEffort}
                reasoningControl={reasoningControl}
                reasoningEfforts={reasoningEfforts}
                onWebSearch={setWebSearch}
                onSend={() => void send()}
                onStop={() => activeId && void window.lumen.chat.stop(activeId)}
                onAttach={(files) => setAttachments((prev) => [...prev, ...files])}
                onRemove={(id) => setAttachments((prev) => prev.filter((a) => a.id !== id))}
              />
          </div>
        </section>
      </div>
      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          initialPage={settingsPage}
          onChange={patchSettings}
          onRefreshModels={refreshLocalModels}
          onClose={() => { setSettingsOpen(false); setSettingsPage("general"); }}
          onDeleteAllMemories={async () => {
            await window.lumen.memory.clear();
          }}
          onDeleteAllChats={deleteAllChats}
        />
      )}
    </>
  );
}
