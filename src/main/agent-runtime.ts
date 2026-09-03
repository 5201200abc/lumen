export type AgentRuntimeKind = "native";
export type AgentRuntimePermissionMode = "default" | "auto" | "bypassPermissions";
export type AgentPermissionRuleMode =
  | AgentRuntimePermissionMode
  | "acceptEdits"
  | "plan"
  | "dontAsk";

export type AgentPermissionUpdateDestination =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "session"
  | "cliArg";

export type AgentPermissionUpdate =
  | {
      type: "addRules" | "replaceRules" | "removeRules";
      rules: Array<{ toolName: string; ruleContent?: string }>;
      behavior: "allow" | "deny" | "ask";
      destination: AgentPermissionUpdateDestination;
    }
  | {
      type: "setMode";
      mode: AgentPermissionRuleMode;
      destination: AgentPermissionUpdateDestination;
    }
  | {
      type: "addDirectories" | "removeDirectories";
      directories: string[];
      destination: AgentPermissionUpdateDestination;
    };

export type AgentPermissionResult =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: AgentPermissionUpdate[];
      toolUseID?: string;
      decisionClassification?: string;
    }
  | {
      behavior: "deny";
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
      decisionClassification?: string;
    };

export type AgentCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: AgentPermissionUpdate[];
    blockedPath?: string;
    decisionReason?: string;
    title?: string;
    displayName?: string;
    description?: string;
    toolUseID: string;
    agentID?: string;
    requestId: string;
    matchedAskRule?: {
      source: string;
      toolName: string;
      ruleContent?: string;
    };
  }
) => Promise<AgentPermissionResult>;

export type AgentRuntimeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [key: string]: unknown;
};

export type AgentRuntimeContentBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    };

export type AgentRuntimeDelta =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_input"; partialJson: string };

export type AgentRuntimeStatus =
  | "initializing"
  | "hooks"
  | "retrying"
  | "compacting"
  | "subtask_start"
  | "subtask_progress"
  | "working";

export type AgentRuntimeEvent =
  | { type: "session"; sessionId: string }
  | { type: "status"; status: AgentRuntimeStatus; error?: string }
  | { type: "message_start" }
  | { type: "content_start"; index: number; block: AgentRuntimeContentBlock }
  | { type: "content_delta"; index: number; delta: AgentRuntimeDelta }
  | { type: "content_stop"; index: number }
  | {
      type: "assistant";
      content: AgentRuntimeContentBlock[];
      usage?: AgentRuntimeUsage;
      parentToolUseId?: string;
    }
  | {
      type: "tool_result";
      toolUseId: string;
      content: unknown;
      isError: boolean;
    }
  | {
      type: "result";
      success: boolean;
      subtype?: string;
      output?: string;
      error?: unknown;
      errors?: unknown[];
      usage?: AgentRuntimeUsage;
    };

export type AgentRuntimeOptions = {
  prompt: string;
  cwd: string;
  model: string;
  modelEndpoint?: {
    baseUrl: string;
    apiKey?: string;
  };
  effort?: string;
  resume?: string;
  tools: string[];
  mcpServer: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  env: Record<string, string | undefined>;
  permissionMode: AgentRuntimePermissionMode;
  canUseTool?: AgentCanUseTool;
  onEvent: (event: AgentRuntimeEvent) => void;
  onStderr: (data: string) => void;
  persistent?: boolean;
};

export type AgentRewindResult = {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
  skippedLinks?: number;
};

export type AgentRuntime = {
  kind: AgentRuntimeKind;
  abortController: AbortController;
  done: Promise<void>;
  send: (prompt: string, uuid: string) => void;
  interrupt: () => Promise<void>;
  close: () => void;
  rewindFiles: (
    userMessageId: string,
    options?: { dryRun?: boolean }
  ) => Promise<AgentRewindResult>;
};
