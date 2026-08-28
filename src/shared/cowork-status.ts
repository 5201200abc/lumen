import type { CoworkToolCall } from "./types";

function compact(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const line = value.trim().split(/\r?\n/, 1)[0];
  return line.length > 88 ? `${line.slice(0, 85)}…` : line;
}

function fileName(value: unknown): string {
  const path = compact(value, "file");
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

export function toolDescription(tool: CoworkToolCall): string {
  const name = tool.name.toLowerCase();
  if (name === "bash" || name === "sh" || name.includes("command") || name.includes("shell")) {
    return compact(tool.input?.command, "command");
  }
  if (name.includes("write") || name.includes("edit") || name === "read" || name.includes("file")) {
    return compact(tool.input?.file_path || tool.input?.path || tool.input?.filename, "file");
  }
  if (name === "grep" || name === "glob" || name.includes("search") || name.includes("find")) {
    return compact(tool.input?.pattern || tool.input?.query, "workspace");
  }
  return "";
}

export function toolActivity(tool: CoworkToolCall): string {
  const name = tool.name.toLowerCase();
  if (name === "bash" || name === "sh" || name.includes("command") || name.includes("shell")) {
    return `Running ${compact(tool.input?.command, "a command")}`;
  }
  if (name.includes("write")) {
    return `Writing ${fileName(tool.input?.file_path || tool.input?.path || tool.input?.filename)}`;
  }
  if (name.includes("edit")) {
    return `Editing ${fileName(tool.input?.file_path || tool.input?.path || tool.input?.filename)}`;
  }
  if (name === "read" || name.includes("file") || name.includes("view")) {
    return `Reading ${fileName(tool.input?.file_path || tool.input?.path || tool.input?.filename)}`;
  }
  if (name === "grep" || name === "glob" || name.includes("search") || name.includes("find")) {
    return `Searching ${compact(tool.input?.pattern || tool.input?.query, "the workspace")}`;
  }
  return `Using ${tool.name}`;
}
