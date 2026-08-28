import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  Attachment,
  ChatMessage,
  ChatSendPayload,
  Conversation,
  Effort,
  LlamaStatus,
  ModelBenchmarkResult,
  MemoryItem,
  Settings,
  StreamDelta,
  StreamDone,
  CoworkMessage,
  CoworkTask, CoworkApprovalDecision, CoworkRewindResult,
  CoworkToolStatus,
  GoogleAccount,
  TokenUsage,
  WorkspaceInfo
} from "@shared/types";

type Unlisten = () => void;

function on<T>(channel: string, fn: (payload: T) => void): Unlisten {
  const listener = (_e: IpcRendererEvent, payload: T) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke("settings:get"),
    set: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke("settings:set", patch)
  },
  google: {
    status: (): Promise<GoogleAccount> => ipcRenderer.invoke("google:status"),
    login: (): Promise<GoogleAccount> => ipcRenderer.invoke("google:login"),
    cancelLogin: (): Promise<boolean> => ipcRenderer.invoke("google:cancelLogin"),
    logout: (): Promise<GoogleAccount> => ipcRenderer.invoke("google:logout"),
    sync: (): Promise<GoogleAccount> => ipcRenderer.invoke("google:sync")
  },
  usage: {
    get: (): Promise<TokenUsage> => ipcRenderer.invoke("usage:get"),
    onUpdated: (fn: (usage: TokenUsage) => void): Unlisten => on("usage:updated", fn)
  },
  models: {
    status: (): Promise<LlamaStatus> => ipcRenderer.invoke("models:status"),
    ensure: (): Promise<LlamaStatus> => ipcRenderer.invoke("models:ensure"),
    reconnect: (): Promise<LlamaStatus> => ipcRenderer.invoke("models:reconnect"),
    stop: (): Promise<LlamaStatus> => ipcRenderer.invoke("models:stop"),
    benchmark: (model: string): Promise<ModelBenchmarkResult> => ipcRenderer.invoke("models:benchmark", model),
    refreshCatalog: (restartRouter = false): Promise<{ settings: Settings; status: LlamaStatus }> =>
      ipcRenderer.invoke("models:refreshCatalog", restartRouter)
  },
  chats: {
    list: (): Promise<Conversation[]> => ipcRenderer.invoke("chats:list"),
    search: (q: string): Promise<Conversation[]> => ipcRenderer.invoke("chats:search", q),
    create: (): Promise<Conversation> => ipcRenderer.invoke("chats:create"),
    rename: (id: string, title: string): Promise<boolean> => ipcRenderer.invoke("chats:rename", id, title),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke("chats:delete", id),
    clear: (): Promise<boolean> => ipcRenderer.invoke("chats:clear"),
    messages: (id: string): Promise<ChatMessage[]> => ipcRenderer.invoke("chats:messages", id),
    autoSummarize: (): Promise<Conversation[]> => ipcRenderer.invoke("chats:autoSummarize"),
    onRenamed: (fn: (d: { conversationId: string; title: string }) => void): Unlisten =>
      on("chats:renamed", fn)
  },
  memory: {
    list: (): Promise<MemoryItem[]> => ipcRenderer.invoke("memory:list"),
    clear: (): Promise<boolean> => ipcRenderer.invoke("memory:clear")
  },
  chat: {
    send: (payload: ChatSendPayload) => ipcRenderer.invoke("chat:send", payload) as Promise<{ userId: string; assistantId: string }>,
    stop: (conversationId: string): Promise<boolean> => ipcRenderer.invoke("chat:stop", conversationId),
    regenerate: (conversationId: string, effort: Effort, webSearch: boolean) =>
      ipcRenderer.invoke("chat:regenerate", conversationId, effort, webSearch) as Promise<{
        ok: boolean;
        assistantId?: string;
      }>,
    onDelta: (fn: (d: StreamDelta) => void): Unlisten => on("chat:delta", fn),
    onDone: (fn: (d: StreamDone) => void): Unlisten => on("chat:done", fn),
    onError: (fn: (d: { conversationId: string; messageId: string; error: string }) => void): Unlisten =>
      on("chat:error", fn)
  },
  screenshot: {
    capture: (): Promise<boolean> => ipcRenderer.invoke("screenshot:capture"),
    ack: (dataUrl: string): Promise<boolean> => ipcRenderer.invoke("clipboard:ack", dataUrl),
    onAdded: (fn: (file: { name: string; dataUrl: string }) => void): Unlisten => on("screenshot:added", fn)
  },
  terminal: {
    init: (opts?: { cols?: number; rows?: number; cwd?: string }): Promise<{ ok: boolean; cwd?: string; error?: string }> =>
      ipcRenderer.invoke("terminal:init", opts),
    write: (data: string): Promise<boolean> => ipcRenderer.invoke("terminal:write", data),
    resize: (cols: number, rows: number): Promise<boolean> => ipcRenderer.invoke("terminal:resize", { cols, rows }),
    restart: (opts?: { cols?: number; rows?: number; cwd?: string }): Promise<{ ok: boolean; cwd?: string; error?: string }> =>
      ipcRenderer.invoke("terminal:restart", opts),
    selectFolder: (): Promise<string | null> => ipcRenderer.invoke("terminal:select-folder"),
    onData: (fn: (data: string) => void): Unlisten => on("terminal:data", fn),
    onExit: (fn: (exitCode: number) => void): Unlisten => on("terminal:exit", fn)
  },
  cowork: {
    getHome: (): Promise<string> => ipcRenderer.invoke("cowork:getHome"),
    workspaceInfo: (cwd?: string): Promise<WorkspaceInfo> => ipcRenderer.invoke("cowork:workspaceInfo", cwd),
    listTasks: (): Promise<CoworkTask[]> => ipcRenderer.invoke("cowork:listTasks"),
    createTask: (opts?: { title?: string; cwd?: string }): Promise<CoworkTask> => ipcRenderer.invoke("cowork:createTask", opts || {}),
    getMessages: (taskId: string): Promise<CoworkMessage[]> => ipcRenderer.invoke("cowork:getMessages", taskId),
    deleteTask: (taskId: string): Promise<boolean> => ipcRenderer.invoke("cowork:deleteTask", taskId),
    setGoal: (taskId: string, goal: string): Promise<{ task: CoworkTask; message: CoworkMessage }> =>
      ipcRenderer.invoke("cowork:setGoal", taskId, goal),
    compact: (taskId: string): Promise<{ task: CoworkTask; message: CoworkMessage }> =>
      ipcRenderer.invoke("cowork:compact", taskId),
    selectDirectory: (): Promise<string | null> => ipcRenderer.invoke("cowork:selectDirectory"),
    stop: (taskId: string): Promise<boolean> => ipcRenderer.invoke("cowork:stop", taskId),
    rewind: (taskId: string, messageId: string, dryRun = false): Promise<CoworkRewindResult> =>
      ipcRenderer.invoke("cowork:rewind", taskId, messageId, dryRun),
    resolveApproval: (requestId: string, decision: CoworkApprovalDecision): Promise<boolean> =>
      ipcRenderer.invoke("cowork:resolveApproval", requestId, decision),
    run: (opts: { taskId: string; prompt: string; attachments?: Attachment[]; cwd?: string; effort?: Effort; model?: string }): Promise<{ ok: boolean; taskId: string; userMsgId?: string; asstMsgId?: string; error?: string }> =>
      ipcRenderer.invoke("cowork:run", opts),
    onEvent: (fn: (event: any) => void): Unlisten => on("cowork:event", fn)
  },
  tools: {
    status: (): Promise<CoworkToolStatus> => ipcRenderer.invoke("tools:status"),
    chromeStatus: (): Promise<{ installed: boolean; running: boolean; executable: string | null }> => ipcRenderer.invoke("tools:chromeStatus"),
    chromeOpen: (url: string): Promise<unknown> => ipcRenderer.invoke("tools:chromeOpen", url),
    chromeSnapshot: (): Promise<unknown> => ipcRenderer.invoke("tools:chromeSnapshot"),
    chromeClick: (ref: string | number): Promise<unknown> => ipcRenderer.invoke("tools:chromeClick", ref),
    chromeType: (ref: string | number, text: string, submit = false): Promise<unknown> => ipcRenderer.invoke("tools:chromeType", ref, text, submit),
    chromeScreenshot: (): Promise<{ path: string }> => ipcRenderer.invoke("tools:chromeScreenshot")
  },
  ui: {
    onSettings: (fn: () => void): Unlisten => on("ui:settings", fn),
    onNewChat: (fn: () => void): Unlisten => on("ui:new-chat", fn),
    onSearch: (fn: () => void): Unlisten => on("ui:search", fn),
    onStop: (fn: () => void): Unlisten => on("ui:stop", fn),
    onTheme: (fn: (dark: boolean) => void): Unlisten => on("ui:theme", fn)
  },
  attachments: {
    pickFilesAndFolders: (): Promise<Attachment[]> => ipcRenderer.invoke("attachments:pickFilesAndFolders"),
    pickFiles: (): Promise<Attachment[]> => ipcRenderer.invoke("attachments:pickFiles"),
    pickFolder: (): Promise<Attachment[]> => ipcRenderer.invoke("attachments:pickFolder")
  }
};

contextBridge.exposeInMainWorld("lumen", api);

export type LumenAPI = typeof api;
