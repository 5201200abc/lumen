import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  Attachment,
  ChatMessage,
  ChatSendPayload,
  Conversation,
  Effort,
  LlamaStatus,
  MemoryItem,
  Settings,
  StreamDelta,
  StreamDone,
  CodexMessage,
  CodexTask,
  GoogleAccount,
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
    logout: (): Promise<GoogleAccount> => ipcRenderer.invoke("google:logout"),
    sync: (): Promise<GoogleAccount> => ipcRenderer.invoke("google:sync")
  },
  models: {
    status: (): Promise<LlamaStatus> => ipcRenderer.invoke("models:status"),
    ensure: (): Promise<LlamaStatus> => ipcRenderer.invoke("models:ensure"),
    reconnect: (): Promise<LlamaStatus> => ipcRenderer.invoke("models:reconnect")
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
  codex: {
    getHome: (): Promise<string> => ipcRenderer.invoke("codex:getHome"),
    workspaceInfo: (cwd?: string): Promise<WorkspaceInfo> => ipcRenderer.invoke("codex:workspaceInfo", cwd),
    listTasks: (): Promise<CodexTask[]> => ipcRenderer.invoke("codex:listTasks"),
    createTask: (opts?: { title?: string; cwd?: string }): Promise<CodexTask> => ipcRenderer.invoke("codex:createTask", opts || {}),
    getMessages: (taskId: string): Promise<CodexMessage[]> => ipcRenderer.invoke("codex:getMessages", taskId),
    deleteTask: (taskId: string): Promise<boolean> => ipcRenderer.invoke("codex:deleteTask", taskId),
    selectDirectory: (): Promise<string | null> => ipcRenderer.invoke("codex:selectDirectory"),
    stop: (taskId: string): Promise<boolean> => ipcRenderer.invoke("codex:stop", taskId),
    run: (opts: { taskId: string; prompt: string; cwd?: string; effort?: Effort; model?: string }): Promise<{ ok: boolean; taskId: string; userMsgId?: string; asstMsgId?: string; error?: string }> =>
      ipcRenderer.invoke("codex:run", opts),
    onEvent: (fn: (event: any) => void): Unlisten => on("codex:event", fn)
  },
  ui: {
    onSettings: (fn: () => void): Unlisten => on("ui:settings", fn),
    onNewChat: (fn: () => void): Unlisten => on("ui:new-chat", fn),
    onSearch: (fn: () => void): Unlisten => on("ui:search", fn),
    onStop: (fn: () => void): Unlisten => on("ui:stop", fn),
    onTheme: (fn: (dark: boolean) => void): Unlisten => on("ui:theme", fn)
  }
};

contextBridge.exposeInMainWorld("lumen", api);

export type LumenAPI = typeof api;
