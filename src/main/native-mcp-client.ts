import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { NativeModelTool } from "./native-model-client.js";

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type JsonRpcMessage = {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
};

export type NativeMcpToolResult = {
  content: string;
  isError: boolean;
};

export class NativeMcpClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, PendingRequest>();

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string>,
    private readonly onStderr: (value: string) => void
  ) {}

  private send(message: Record<string, unknown>): void {
    if (!this.process || this.process.stdin.destroyed) {
      throw new Error("MCP process is not running.");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private consume(message: JsonRpcMessage): void {
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(
        `MCP ${message.error.code ?? "error"}: ${message.error.message || "unknown error"}`
      ));
    } else {
      pending.resolve(message.result);
    }
  }

  async start(): Promise<NativeModelTool[]> {
    if (!this.command) throw new Error("MCP command is empty.");
    this.process = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) {
          try {
            this.consume(JSON.parse(line) as JsonRpcMessage);
          } catch {
            this.onStderr(`Invalid MCP JSON: ${line.slice(0, 500)}\n`);
          }
        }
        newline = this.buffer.indexOf("\n");
      }
    });
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk: string) => this.onStderr(chunk));
    this.process.once("exit", (code, signal) => {
      const error = new Error(`MCP process exited (${code ?? signal ?? "unknown"}).`);
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
      this.process = null;
    });

    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "lumen-native-agent", version: "0.7.0" }
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    const listed = await this.request("tools/list") as { tools?: McpTool[] };
    return (listed.tools || []).map((tool) => ({
      type: "function",
      function: {
        name: `mcp__lumen__${tool.name}`,
        description: tool.description,
        parameters: tool.inputSchema || { type: "object", properties: {} }
      }
    }));
  }

  async call(name: string, argumentsValue: Record<string, unknown>): Promise<NativeMcpToolResult> {
    const rawName = name.replace(/^mcp__lumen__/, "");
    const result = await this.request("tools/call", {
      name: rawName,
      arguments: argumentsValue
    }) as {
      isError?: boolean;
      content?: Array<{ type?: string; text?: string }>;
    };
    const content = (result.content || [])
      .filter((item) => item.type === "text")
      .map((item) => item.text || "")
      .join("\n");
    return {
      content: content || "(no MCP output)",
      isError: result.isError === true
    };
  }

  close(): void {
    const process = this.process;
    this.process = null;
    if (!process) return;
    process.stdin.end();
    if (!process.killed) process.kill();
  }
}
