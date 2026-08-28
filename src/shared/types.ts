export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
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
const EFFORT_ORDER: Effort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export function detectReasoningEfforts(modelName: string, chatTemplate = ""): Effort[] | undefined {
  if (/qwen3\.8(?:[-_]?27b)?/i.test(modelName)) return ["low", "medium", "xhigh"];
  const template = chatTemplate.toLowerCase();
  if (template.includes("reasoning_effort")) {
    const declared = [...template.matchAll(/reasoning_effort[\s\S]{0,160}?(?:not\s+in|in)\s*\(([^)]*)\)/gi)]
      .flatMap((match) => [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((value) => value[1]));
    const exact = EFFORT_ORDER.filter((effort) => declared.includes(effort));
    if (exact.length >= 2) return exact;
    const nearby = [...template.matchAll(/reasoning_effort/gi)]
      .map((match) => template.slice(match.index, match.index + 300))
      .join("\n");
    const detected = EFFORT_ORDER.filter((effort) =>
      new RegExp(`(?:['"]${effort}['"]|\\b${effort}\\b)`, "i").test(nearby)
    );
    return detected.length >= 2 ? detected : ["low", "medium", "high", "xhigh"];
  }
  return undefined;
}

export function detectReasoningControl(modelName: string, chatTemplate = ""): ReasoningControl {
  if (!modelName) return "none";
  const name = modelName.trim().toLowerCase();
  const template = chatTemplate.toLowerCase();

  // The GGUF chat template is derived from the model's published tokenizer and
  // is authoritative when it declares a controllable thinking parameter.
  if (template.includes("reasoning_effort")) return "effort";
  if (
    template.includes("enable_thinking") ||
    template.includes("thinking_mode") ||
    template.includes("enable_reasoning")
  ) {
    return "toggle";
  }
  if (/qwen3\.8/i.test(name)) return "effort";

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

export function normalizeReasoningEffort(
  modelName: string,
  effort: Effort,
  supported = detectReasoningEfforts(modelName)
): Effort {
  if (!supported) return effort;
  return supported.includes(effort) ? effort : supported.at(-1) || "medium";
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
      ? { label: "思考强度级别", tag: "Effort", description: "按模型官方模板提供思考强度" }
      : { label: "Reasoning effort levels", tag: "Effort", description: "Uses the effort levels declared by the model template" };
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

export type CoworkEngine = "claude-agent";
export type CoworkPermissionMode = "ask" | "approve" | "full";
export type ResearchExtractor = "tavily" | "firecrawl";
export type ComputerUsePermission = "ask" | "allow" | "block";
export type PluginSettings = {
  browser: boolean;
  sites: boolean;
  plugins: boolean;
};
export type ComputerUsePermissions = {
  approval: ComputerUsePermission;
  history: ComputerUsePermission;
  downloads: ComputerUsePermission;
  uploads: ComputerUsePermission;
};

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
  coworkPermissionMode: CoworkPermissionMode;
  coworkDefaultPermissions: boolean;
  coworkFullAccess: boolean;
  plugins: PluginSettings;
  computerUseChromeEnabled: boolean;
  computerUsePermissions: ComputerUsePermissions;
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

export type CoworkCapabilityId = "browser" | "sites" | "plugins" | "chrome";

export type CoworkToolStatus = {
  online: boolean;
  capabilities: Array<{
    id: CoworkCapabilityId;
    available: boolean;
    detail: string;
  }>;
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
  kind?: "image" | "video" | "audio" | "document" | "text" | "code" | "archive" | "pdf" | "file";
  text?: string;
};

export type ResearchSite = {
  title: string;
  url: string;
  domain: string;
};

export type ResearchStep = {
  id: string;
  kind: "search" | "read" | "verify";
  status: "active" | "done";
  count?: number;
  domains?: string[];
  sites?: ResearchSite[];
  detail?: string;
};

export type ResearchProgress = {
  strategy: string;
  steps: ResearchStep[];
  sources?: ResearchSite[];
  complete?: boolean;
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
  research?: ResearchProgress;
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

export type ModelBenchmarkResult = {
  model: string;
  tokensPerSecond: number;
  tokens: number;
  durationMs: number;
  source: "llama.cpp" | "measured";
};

export type ModelUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  models: ModelUsage[];
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
  research?: ResearchProgress;
};

export type StreamDone = {
  conversationId: string;
  messageId: string;
  thinking: string;
  content: string;
  stopped?: boolean;
  durationSeconds?: number;
  research?: ResearchProgress;
};

export type CoworkToolCall = {
  id: string;
  name: string;
  input: Record<string, any>;
  status: "running" | "completed" | "error";
  output?: string;
};

export type CoworkApprovalStatus = "pending" | "allowed" | "denied";
export type CoworkApprovalDecision = "allow_once" | "allow_session" | "deny";

export type CoworkApproval = {
  id: string;
  taskId: string;
  toolName: string;
  title: string;
  input: Record<string, unknown>;
  blockedPath?: string;
  status: CoworkApprovalStatus;
  createdAt: number;
};

export type CoworkMessage = {
  id: string;
  taskId: string;
  role: "user" | "assistant" | "system";
  content: string;
  runtimeOutput?: string;
  checkpointId?: string;
  rewindAvailable?: boolean;
  approvals?: CoworkApproval[];
  attachments?: Attachment[];
  toolCalls?: CoworkToolCall[];
  status?: "streaming" | "done" | "error";
  contextUsed?: number;
  contextTotal?: number;
  activity?: string;
  durationSeconds?: number;
  createdAt: number;
};

export type CoworkRewindResult = {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
  skippedLinks?: number;
};

export type CoworkTask = {
  id: string;
  title: string;
  cwd: string;
  engine: CoworkEngine;
  goal?: string;
  compactedAt?: number;
  contextUsed?: number;
  contextTotal?: number;
  createdAt: number;
  updatedAt: number;
};
