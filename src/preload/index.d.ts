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
  usage: {
    get: () => Promise<TokenUsage>;
    onUpdated: (fn: (usage: TokenUsage) => void) => Unlisten;
  };
  models: {
    status: () => Promise<LlamaStatus>;
    ensure: () => Promise<LlamaStatus>;
    reconnect: () => Promise<LlamaStatus>;
    stop: () => Promise<LlamaStatus>;
    benchmark: (model: string) => Promise<ModelBenchmarkResult>;
    refreshCatalog: (restartRouter?: boolean) => Promise<{ settings: Settings; status: LlamaStatus }>;
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
  cowork: {
    getHome: () => Promise<string>;
    workspaceInfo: (cwd?: string) => Promise<WorkspaceInfo>;
    listTasks: () => Promise<CoworkTask[]>;
    createTask: (opts?: { title?: string; cwd?: string }) => Promise<CoworkTask>;
    getMessages: (taskId: string) => Promise<CoworkMessage[]>;
    deleteTask: (taskId: string) => Promise<boolean>;
    setGoal: (taskId: string, goal: string) => Promise<{ task: CoworkTask; message: CoworkMessage }>;
    compact: (taskId: string) => Promise<{ task: CoworkTask; message: CoworkMessage }>;
    selectDirectory: () => Promise<string | null>;
    stop: (taskId: string) => Promise<boolean>;
    rewind: (taskId: string, messageId: string, dryRun?: boolean) => Promise<CoworkRewindResult>;
    resolveApproval: (requestId: string, decision: CoworkApprovalDecision) => Promise<boolean>;
    run: (opts: { taskId: string; prompt: string; attachments?: Attachment[]; cwd?: string; effort?: Effort; model?: string }) => Promise<{ ok: boolean; taskId: string; userMsgId?: string; asstMsgId?: string; error?: string }>;
    regenerate: (opts: { taskId: string; messageId: string; cwd?: string; effort?: Effort; model?: string }) => Promise<{ ok: boolean; taskId: string; userMsgId?: string; asstMsgId?: string; error?: string }>;
    onEvent: (fn: (event: any) => void) => Unlisten;
  };
  tools: {
    status: () => Promise<CoworkToolStatus>;
    chromeStatus: () => Promise<{
      installed: boolean;
      running: boolean;
      executable: string | null;
      mode: "auto" | "extension" | "isolated";
      controller: "extension" | "isolated" | null;
      extension: {
        id: string;
        available: boolean;
        connected: boolean;
        port: number;
        version: string;
        directory: string;
      };
      window?: {
        visible: boolean;
        bounds: { x: number; y: number; width: number; height: number };
        parentBounds: { x: number; y: number; width: number; height: number } | null;
      };
    }>;
    chromePreview: () => Promise<{
      available: boolean;
      dataUrl?: string;
      title?: string;
      url?: string;
      source?: "window" | "tab";
    }>;
    chromeExtensionInstall: () => Promise<{
      id: string;
      available: boolean;
      connected: boolean;
      port: number;
      version: string;
      features: string[];
      directory: string;
    }>;
    chromeOpen: (url: string) => Promise<unknown>;
    chromeSnapshot: () => Promise<unknown>;
    chromeClick: (ref: string | number) => Promise<unknown>;
    chromeType: (ref: string | number, text: string, submit?: boolean) => Promise<unknown>;
    chromeScreenshot: () => Promise<{ path: string }>;
    chromeConsole: (clear?: boolean) => Promise<unknown>;
    chromeNetwork: (clear?: boolean) => Promise<unknown>;
  };
  ui: {
    toggleMaximize: () => Promise<boolean>;
    onSettings: (fn: () => void) => Unlisten;
    onNewChat: (fn: () => void) => Unlisten;
    onSearch: (fn: () => void) => Unlisten;
    onStop: (fn: () => void) => Unlisten;
    onTheme: (fn: (dark: boolean) => void) => Unlisten;
  };
  attachments: {
    pickFilesAndFolders: () => Promise<Attachment[]>;
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
