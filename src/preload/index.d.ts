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
  CodexTask, CoworkEngine,
  GoogleAccount,
  WorkspaceInfo
} from "@shared/types";

type Unlisten = () => void;

interface LumenAPI {
  settings: {
    get: () => Promise<Settings>;
    set: (patch: Partial<Settings>) => Promise<Settings>;
  };
  google: {
    status: () => Promise<GoogleAccount>;
    login: () => Promise<GoogleAccount>;
    cancelLogin: () => Promise<boolean>;
    logout: () => Promise<GoogleAccount>;
    sync: () => Promise<GoogleAccount>;
  };
  models: {
    status: () => Promise<LlamaStatus>;
    ensure: () => Promise<LlamaStatus>;
    reconnect: () => Promise<LlamaStatus>;
  };
  chats: {
    list: () => Promise<Conversation[]>;
    search: (q: string) => Promise<Conversation[]>;
    create: () => Promise<Conversation>;
    rename: (id: string, title: string) => Promise<boolean>;
    delete: (id: string) => Promise<boolean>;
    clear: () => Promise<boolean>;
    messages: (id: string) => Promise<ChatMessage[]>;
    autoSummarize: () => Promise<Conversation[]>;
    onRenamed: (fn: (d: { conversationId: string; title: string }) => void) => Unlisten;
  };
  memory: {
    list: () => Promise<MemoryItem[]>;
    clear: () => Promise<boolean>;
  };
  chat: {
    send: (payload: ChatSendPayload) => Promise<{ userId: string; assistantId: string }>;
    stop: (conversationId: string) => Promise<boolean>;
    regenerate: (
      conversationId: string,
      effort: Effort,
      webSearch: boolean
    ) => Promise<{ ok: boolean; assistantId?: string }>;
    onDelta: (fn: (d: StreamDelta) => void) => Unlisten;
    onDone: (fn: (d: StreamDone) => void) => Unlisten;
    onError: (fn: (d: { conversationId: string; messageId: string; error: string }) => void) => Unlisten;
  };
  screenshot: {
    capture: () => Promise<boolean>;
    ack: (dataUrl: string) => Promise<boolean>;
    onAdded: (fn: (file: { name: string; dataUrl: string }) => void) => Unlisten;
  };
  terminal: {
    init: (opts?: { cols?: number; rows?: number; cwd?: string }) => Promise<{ ok: boolean; cwd?: string; error?: string }>;
    write: (data: string) => Promise<boolean>;
    resize: (cols: number, rows: number) => Promise<boolean>;
    restart: (opts?: { cols?: number; rows?: number; cwd?: string }) => Promise<{ ok: boolean; cwd?: string; error?: string }>;
    selectFolder: () => Promise<string | null>;
    onData: (fn: (data: string) => void) => Unlisten;
    onExit: (fn: (exitCode: number) => void) => Unlisten;
  };
  codex: {
    getHome: () => Promise<string>;
    workspaceInfo: (cwd?: string) => Promise<WorkspaceInfo>;
    listTasks: () => Promise<CodexTask[]>;
    createTask: (opts?: { title?: string; cwd?: string; engine?: CoworkEngine }) => Promise<CodexTask>;
    getMessages: (taskId: string) => Promise<CodexMessage[]>;
    deleteTask: (taskId: string) => Promise<boolean>;
    selectDirectory: () => Promise<string | null>;
    stop: (taskId: string) => Promise<boolean>;
    run: (opts: { taskId: string; prompt: string; attachments?: Attachment[]; cwd?: string; effort?: Effort; model?: string; engine?: CoworkEngine }) => Promise<{ ok: boolean; taskId: string; userMsgId?: string; asstMsgId?: string; error?: string }>;
    onEvent: (fn: (event: any) => void) => Unlisten;
  };
  ui: {
    onSettings: (fn: () => void) => Unlisten;
    onNewChat: (fn: () => void) => Unlisten;
    onSearch: (fn: () => void) => Unlisten;
    onStop: (fn: () => void) => Unlisten;
    onTheme: (fn: (dark: boolean) => void) => Unlisten;
  };
  attachments: {
    pickFiles: () => Promise<Attachment[]>;
    pickFolder: () => Promise<Attachment[]>;
  };
}

declare global {
  interface Window {
    lumen: LumenAPI;
  }
}

export {};
