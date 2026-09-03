import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { NativeModelTool } from "./native-model-client.js";

const execFileAsync = promisify(execFile);
const MAX_TOOL_OUTPUT = 128_000;

export type NativeToolExecutionResult = {
  content: string;
  isError: boolean;
};

export const NATIVE_CORE_TOOLS: NativeModelTool[] = [
  {
    type: "function",
    function: {
      name: "Bash",
      description: "Run a shell command in the active workspace.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout: { type: "number", minimum: 100, maximum: 600_000 }
        },
        required: ["command"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "Read",
      description: "Read a UTF-8 file. Use offset and limit for bounded reads.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          offset: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1, maximum: 2_000 }
        },
        required: ["file_path"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "Write",
      description: "Create or replace a UTF-8 file.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          content: { type: "string" }
        },
        required: ["file_path", "content"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "Edit",
      description: "Replace an exact string in a UTF-8 file.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" }
        },
        required: ["file_path", "old_string", "new_string"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "Glob",
      description: "List workspace files matching a glob pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" }
        },
        required: ["pattern"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "Grep",
      description: "Search workspace file contents with ripgrep.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          glob: { type: "string" },
          head_limit: { type: "integer", minimum: 1, maximum: 2_000 }
        },
        required: ["pattern"],
        additionalProperties: false
      }
    }
  }
];

export const NATIVE_AGENT_TOOLS: NativeModelTool[] = [
  {
    type: "function",
    function: {
      name: "Task",
      description: "Delegate one bounded coding or research subtask to a native Lumen subagent.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          description: { type: "string" },
          run_in_background: { type: "boolean" },
          isolation: { type: "string", enum: ["workspace", "worktree"] }
        },
        required: ["prompt"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "TaskOutput",
      description: "Read a background subtask's current status and output, optionally waiting briefly.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          block: { type: "boolean" },
          timeout_ms: { type: "integer", minimum: 0, maximum: 60_000 }
        },
        required: ["task_id"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "TaskStop",
      description: "Stop a running background subtask.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string" } },
        required: ["task_id"],
        additionalProperties: false
      }
    }
  }
];

function stringArg(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value) throw new Error(`${key} is required.`);
  return value;
}

function workspacePath(cwd: string, raw: string): string {
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw);
}

function bounded(value: string): string {
  if (value.length <= MAX_TOOL_OUTPUT) return value;
  return `${value.slice(0, MAX_TOOL_OUTPUT)}\n[tool output truncated at ${MAX_TOOL_OUTPUT} characters]`;
}

async function command(
  file: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeout = 120_000
): Promise<NativeToolExecutionResult> {
  try {
    const result = await execFileAsync(file, args, {
      cwd,
      signal,
      timeout,
      maxBuffer: MAX_TOOL_OUTPUT * 4,
      encoding: "utf8"
    });
    return { content: bounded(`${result.stdout}${result.stderr}`) || "(no output)", isError: false };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: string | number };
    const detail = `${failure.stdout || ""}${failure.stderr || ""}`.trim();
    return {
      content: bounded(detail || `${failure.message}${failure.code !== undefined ? ` (exit ${failure.code})` : ""}`),
      isError: true
    };
  }
}

export function nativeCoreToolDefinitions(enabled: string[]): NativeModelTool[] {
  const allow = new Set(enabled);
  return NATIVE_CORE_TOOLS.filter((tool) => allow.has(tool.function.name));
}

export function nativeAgentToolDefinitions(enabled: string[]): NativeModelTool[] {
  const allow = new Set(enabled);
  return NATIVE_AGENT_TOOLS.filter((tool) => allow.has(tool.function.name));
}

export async function executeNativeCoreTool(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
  signal: AbortSignal
): Promise<NativeToolExecutionResult> {
  if (name === "Bash") {
    const timeout = Math.min(600_000, Math.max(100, Number(input.timeout || 120_000)));
    return command("/bin/zsh", ["-lc", stringArg(input, "command")], cwd, signal, timeout);
  }
  if (name === "Read") {
    const file = workspacePath(cwd, stringArg(input, "file_path"));
    const text = await fs.readFile(file, "utf8");
    const lines = text.split("\n");
    const offset = Math.max(1, Number(input.offset || 1));
    const limit = Math.min(2_000, Math.max(1, Number(input.limit || 200)));
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    return {
      content: bounded(selected.map((line, index) => `${offset + index}\t${line}`).join("\n")),
      isError: false
    };
  }
  if (name === "Write") {
    const file = workspacePath(cwd, stringArg(input, "file_path"));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, stringArg(input, "content"), "utf8");
    return { content: `Wrote ${file}`, isError: false };
  }
  if (name === "Edit") {
    const file = workspacePath(cwd, stringArg(input, "file_path"));
    const oldString = stringArg(input, "old_string");
    const newString = typeof input.new_string === "string" ? input.new_string : "";
    const original = await fs.readFile(file, "utf8");
    const occurrences = original.split(oldString).length - 1;
    if (!occurrences) return { content: `String not found in ${file}`, isError: true };
    if (occurrences > 1 && input.replace_all !== true) {
      return { content: `String occurs ${occurrences} times in ${file}; set replace_all or provide more context.`, isError: true };
    }
    const updated = input.replace_all === true
      ? original.split(oldString).join(newString)
      : original.replace(oldString, newString);
    await fs.writeFile(file, updated, "utf8");
    return { content: `Edited ${file}`, isError: false };
  }
  if (name === "Glob") {
    const root = workspacePath(cwd, typeof input.path === "string" ? input.path : ".");
    return command("rg", ["--files", "-g", stringArg(input, "pattern")], root, signal, 30_000);
  }
  if (name === "Grep") {
    const root = workspacePath(cwd, typeof input.path === "string" ? input.path : ".");
    const args = ["-n", "--no-heading", "--color", "never"];
    if (typeof input.glob === "string" && input.glob) args.push("-g", input.glob);
    args.push(stringArg(input, "pattern"), ".");
    const result = await command("rg", args, root, signal, 30_000);
    const limit = Math.min(2_000, Math.max(1, Number(input.head_limit || 200)));
    result.content = result.content.split("\n").slice(0, limit).join("\n");
    return result;
  }
  return { content: `Unknown native tool: ${name}`, isError: true };
}
