import {
  query,
  type CanUseTool,
  type Query,
  type SDKMessage,
  type SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";

export type ClaudeAgentRuntimeOptions = {
  prompt: string;
  cwd: string;
  model: string;
  effort?: string;
  resume?: string;
  tools: string[];
  mcpServer: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  env: Record<string, string | undefined>;
  permissionMode: "default" | "auto" | "bypassPermissions";
  canUseTool?: CanUseTool;
  onMessage: (message: SDKMessage) => void;
  onStderr: (data: string) => void;
  persistent?: boolean;
};

export type ClaudeAgentRuntime = {
  abortController: AbortController;
  query: Query;
  done: Promise<void>;
  send: (prompt: string, uuid: string) => void;
  interrupt: () => Promise<void>;
  close: () => void;
};

class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private values: SDKUserMessage[] = [];
  private waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(value: SDKUserMessage): void {
    if (this.closed) throw new Error("Claude Agent session is closed.");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      }
    };
  }
}

function normalizeEffort(effort?: string): "low" | "medium" | "high" | "xhigh" {
  if (effort === "low" || effort === "high" || effort === "xhigh") return effort;
  return "medium";
}

export function startClaudeAgentRuntime(options: ClaudeAgentRuntimeOptions): ClaudeAgentRuntime {
  const abortController = new AbortController();
  const queue = new MessageQueue();
  const agentQuery = query({
    prompt: options.persistent ? queue : options.prompt,
    options: {
      abortController,
      cwd: options.cwd,
      model: options.model,
      effort: normalizeEffort(options.effort),
      resume: options.resume,
      tools: options.tools,
      mcpServers: {
        lumen: {
          command: options.mcpServer.command,
          args: options.mcpServer.args,
          env: options.mcpServer.env
        }
      },
      includePartialMessages: true,
      includeHookEvents: true,
      forwardSubagentText: true,
      enableFileCheckpointing: true,
      settingSources: [],
      permissionMode: options.permissionMode,
      allowDangerouslySkipPermissions: options.permissionMode === "bypassPermissions",
      canUseTool: options.canUseTool,
      env: options.env,
      stderr: options.onStderr
    }
  });
  const done = (async () => {
    for await (const message of agentQuery) {
      options.onMessage(message);
    }
  })();
  const close = () => {
    queue.close();
    agentQuery.close();
  };
  return {
    abortController,
    query: agentQuery,
    done,
    send: (prompt, uuid) => {
      if (!options.persistent) throw new Error("This Claude Agent runtime is not persistent.");
      queue.push({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: prompt }] },
        parent_tool_use_id: null,
        uuid: uuid as SDKUserMessage["uuid"],
        session_id: "",
        shouldQuery: true
      });
    },
    interrupt: async () => {
      await agentQuery.interrupt();
    },
    close
  };
}
