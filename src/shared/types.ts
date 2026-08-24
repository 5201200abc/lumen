// Exact values supported by Qwen3.8's chat template.
export type Effort = "low" | "medium" | "xhigh";
export type ReasoningControl = "effort" | "toggle" | "none";
export type LlamaModel = {
  id: string;
  name: string;
  endpointId: string;
  reasoningControl: ReasoningControl;
};
export type Theme = "system" | "light" | "dark";
export type Language = "en" | "zh";
export type FontSize = "small" | "medium" | "large";
export type Role = "user" | "assistant" | "system";
export type ChatPhase = "preparing" | "searching" | "thinking" | "answering" | "done" | "error";

export type Settings = {
  llamaUrl: string;
  llamaApiKey: string;
  model: string;
  tavilyApiKey: string;
  defaultEffort: Effort;
  memoryEnabled: boolean;
  theme: Theme;
  modelsDir: string;
  systemPrompt: string;
  systemPromptPath: string;
  chatInstructions: string;
  coworkInstructions: string;
  language: Language;
  fontSize: FontSize;
  modelCatalog: string[];
  llamaModels: LlamaModel[];
  llamaEndpoints: Array<{
    id: string;
    name: string;
    url: string;
  }>;
};

export type GoogleAccount = {
  configured: boolean;
  connected: boolean;
  name?: string;
  email?: string;
  picture?: string;
  lastSyncedAt?: number;
  error?: string;
};

export type WorkspaceInfo = {
  cwd: string;
  name: string;
  branch: string | null;
  location: "Local";
};

export type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

export type Attachment = {
  id: string;
  mime: string;
  name: string;
  dataUrl?: string;
  path?: string;
  relativePath?: string;
  size?: number;
  kind?: "image" | "text" | "document" | "file";
  text?: string;
};

export type ChatMessage = {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  thinking: string;
  attachments: Attachment[];
  createdAt: number;
  phase?: ChatPhase;
  phaseStartedAt?: number;
  introText?: string;
  statusText?: string;
  durationSeconds?: number;
};

export type MemoryItem = {
  id: string;
  content: string;
  sourceId: string;
  createdAt: number;
};

export type LlamaStatus = {
  online: boolean;
  model: string;
  vision: boolean;
  url: string;
  modelsDir: string;
  ggufs: string[];
  models: string[];
  mmproj: string | null;
  error?: string;
};

export type ChatSendPayload = {
  conversationId: string;
  content: string;
  attachments: Attachment[];
  effort: Effort;
  webSearch: boolean;
};

export type StreamDelta = {
  conversationId: string;
  messageId: string;
  thinking?: string;
  content?: string;
  phase?: ChatPhase;
  statusText?: string;
};

export type StreamDone = {
  conversationId: string;
  messageId: string;
  thinking: string;
  content: string;
  stopped?: boolean;
  durationSeconds?: number;
};

export type CodexToolCall = {
  id: string;
  name: string;
  input: Record<string, any>;
  status: "running" | "completed" | "error";
  output?: string;
};

export type CodexMessage = {
  id: string;
  taskId: string;
  role: "user" | "assistant" | "system";
  content: string;
  attachments?: Attachment[];
  toolCalls?: CodexToolCall[];
  status?: "streaming" | "done" | "error";
  contextUsed?: number;
  contextTotal?: number;
  activity?: string;
  durationSeconds?: number;
  createdAt: number;
};

export type CodexTask = {
  id: string;
  title: string;
  cwd: string;
  contextUsed?: number;
  contextTotal?: number;
  createdAt: number;
  updatedAt: number;
};
