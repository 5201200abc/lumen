export type Effort = "low" | "medium" | "high" | "xhigh";
export type ReasoningControl = "effort" | "toggle" | "none";
export type LlamaModel = {
  id: string;
  name: string;
  endpointId: string;
  reasoningControl: ReasoningControl;
  reasoningEfforts?: Effort[];
  source?: "local" | "remote";
};

export type LocalModel = {
  name: string;
  path: string;
  mmproj: string | null;
  vision: boolean;
  reasoningControl: ReasoningControl;
  reasoningEfforts?: Effort[];
};

/**
 * Automatically detects the reasoning/thinking control mode of a model based on
 * its name, family, and standard capability conventions.
 */
export function detectReasoningControl(modelName: string): ReasoningControl {
  if (!modelName) return "none";
  const name = modelName.trim().toLowerCase();

  // Models whose public API exposes multiple reasoning-effort levels.
  if (
    /(^|[/_-])(o1|o3|o4)([/_.-]|$)/i.test(name) ||
    /(^|[/_-])gpt-5([/_.-]|$)/i.test(name) ||
    /claude-(opus|sonnet)-4[._-]6/i.test(name) ||
    /qwen3\.8/i.test(name) ||
    /reasoning[-_]?effort/i.test(name) ||
    /effort[-_]?levels?/i.test(name)
  ) {
    return "effort";
  }

  // Models that expose thinking as a mode/switch, but not low/medium/high effort.
  if (
    /gemma[-_]?4/i.test(name) ||
    /ornith/i.test(name) ||
    /(-thinking|-think|_thinking|_think|\bthinking\b|\bthink\b)/i.test(name) ||
    /(^|[/_-])(deepseek-r1|deepseek-reasoner|r1|qwq)([/_.-]|$)/i.test(name) ||
    /qwen[-_]?3/i.test(name) ||
    /claude-3[._-]7/i.test(name) ||
    /kimi.*k1\.5/i.test(name) ||
    /glm-4.*thinking/i.test(name) ||
    /qwen2\.5.*thinking/i.test(name)
  ) {
    return "toggle";
  }

  // 3. Models with NO Reasoning / Thinking Control:
  // - Standard Llama 2 / 3 / 3.1 / 3.2 / 3.3
  // - Mistral, Mixtral, Gemma, Gemma-2, Phi-2, Phi-3, Phi-4, Vicuna, Command-R
  // - Standard GPT-4o, GPT-4o-mini, GPT-4, GPT-3.5
  // - Claude 3.5 Sonnet / Haiku / Opus, Claude 3
  if (
    /\b(llama-?[23]|mistral|mixtral|gemma|phi-?[234]|vicuna|command-r|chatglm|baichuan|gpt-4o|gpt-4|gpt-3\.5|claude-3-5|claude-3)\b/i.test(name)
  ) {
    return "none";
  }

  if (/(reasoner|reasoning)/i.test(name)) return "toggle";
  return "none";
}

export function detectReasoningEfforts(modelName: string): Effort[] | undefined {
  if (/qwen3\.8/i.test(modelName)) return ["low", "medium", "xhigh"];
  return detectReasoningControl(modelName) === "effort"
    ? ["low", "medium", "high", "xhigh"]
    : undefined;
}

/**
 * Returns human-readable label for a reasoning control mode.
 */
export function reasoningControlLabel(
  control: ReasoningControl,
  lang: "zh" | "en" = "zh"
): { label: string; tag: string; description: string } {
  if (control === "effort") {
    return lang === "zh"
      ? { label: "思考强度级别", tag: "Effort", description: "支持低/中/高分级思考强度" }
      : { label: "Reasoning effort levels", tag: "Effort", description: "Supports low / medium / high / xhigh effort levels" };
  }
  if (control === "toggle") {
    return lang === "zh"
      ? { label: "思考开关", tag: "Toggle", description: "支持开启/关闭思考" }
      : { label: "Thinking toggle", tag: "Toggle", description: "Supports thinking on / off toggle" };
  }
  return lang === "zh"
    ? { label: "标准模型", tag: "No thinking", description: "无深度思考控制" }
    : { label: "Standard model", tag: "No thinking", description: "No thinking control" };
}

export type Theme = "system" | "light" | "dark";
export type Language = "en" | "zh";
export type FontSize = 13 | 14 | 15 | 16 | "small" | "medium" | "large";
export type Role = "user" | "assistant" | "system";
export type ChatPhase = "preparing" | "searching" | "thinking" | "answering" | "done" | "error";

export type ApiKeyItem = {
  id: string;
  name: string;
  key: string;
};

export type CoworkEngine = "claude-code" | "codex";
export type ResearchExtractor = "tavily" | "firecrawl";

export type Settings = {
  llamaUrl: string;
  llamaPort: number;
  llamaAutoStart: boolean;
  llamaApiKey: string;
  model: string;
  tavilyApiKey: string;
  firecrawlUrl: string;
  firecrawlApiKey: string;
  researchExtractor: ResearchExtractor;
  tavilyExtractDepth: "basic" | "advanced";
  defaultEffort: Effort;
  memoryEnabled: boolean;
  theme: Theme;
  modelsDir: string;
  systemPrompt: string;
  systemPromptPath: string;
  chatInstructions: string;
  coworkInstructions: string;
  coworkEngine: CoworkEngine;
  language: Language;
  fontSize: FontSize;
  modelCatalog: string[];
  llamaModels: LlamaModel[];
  llamaEndpoints: Array<{
    id: string;
    name: string;
    url: string;
  }>;
  tavilyApiKeys: ApiKeyItem[];
  llamaApiKeys: ApiKeyItem[];
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
  changes: {
    files: number;
    additions: number;
    deletions: number;
  };
  hasRemote: boolean;
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
  port: number | null;
  pid: number | null;
  managed: boolean;
  model: string;
  vision: boolean;
  url: string;
  modelsDir: string;
  ggufs: string[];
  models: string[];
  localModels: LocalModel[];
  router: boolean;
  runningModel: string | null;
  runningModelPath: string | null;
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
  engine: CoworkEngine;
  contextUsed?: number;
  contextTotal?: number;
  createdAt: number;
  updatedAt: number;
};
