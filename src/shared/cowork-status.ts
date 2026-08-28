import type { CoworkToolCall } from "./types";

export type CoworkToolKind =
  | "terminal"
  | "write"
  | "edit"
  | "read"
  | "search"
  | "web"
  | "browser"
  | "folder"
  | "plugin"
  | "generic";

export type CoworkToolPresentation = {
  kind: CoworkToolKind;
  label: string;
  detail: string;
  meta?: string;
};

function compact(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const line = value.trim().split(/\r?\n/, 1)[0];
  return line.length > 88 ? `${line.slice(0, 85)}…` : line;
}

function fileName(value: unknown): string {
  const path = compact(value, "file");
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function lineCount(value: unknown): number {
  if (typeof value !== "string" || !value) return 0;
  return value.split(/\r?\n/).length;
}

function decodedOutput(output?: string): unknown {
  if (!output) return null;
  try {
    let value: unknown = JSON.parse(output);
    if (Array.isArray(value) && value.length === 1 && value[0]?.type === "text" && value[0]?.text) {
      value = JSON.parse(value[0].text);
    }
    return value;
  } catch {
    return null;
  }
}

export function toolPresentation(
  tool: CoworkToolCall,
  language: "zh" | "en" = "en"
): CoworkToolPresentation {
  const isZh = language === "zh";
  const name = tool.name.toLowerCase();
  const input = tool.input || {};
  const path = input.file_path || input.path || input.filename;

  if (name.endsWith("web_search")) {
    const decoded = decodedOutput(tool.output) as { count?: number; results?: unknown[] } | null;
    const count = Number(decoded?.count ?? decoded?.results?.length ?? 0);
    return {
      kind: "web",
      label: isZh ? "全网检索" : "Web search",
      detail: compact(input.query, isZh ? "检索公开网络" : "Search the public web"),
      meta: count > 0 ? (isZh ? `${count} 条结果` : `${count} results`) : undefined
    };
  }
  if (name.includes("__browser_") || name.includes("__chrome_")) {
    const action = name.split("_").at(-1);
    const labels: Record<string, [string, string]> = {
      open: ["打开网页", "Open page"],
      snapshot: ["读取页面", "Inspect page"],
      click: ["点击页面", "Click page"],
      type: ["输入内容", "Type on page"],
      screenshot: ["网页截图", "Capture page"]
    };
    return {
      kind: "browser",
      label: labels[action || ""]?.[isZh ? 0 : 1] || (isZh ? "操作浏览器" : "Use browser"),
      detail: compact(input.url || input.ref || input.selector || input.text, isZh ? "浏览器" : "Browser")
    };
  }
  if (name.includes("__sites_")) {
    return {
      kind: "folder",
      label: isZh ? "更新站点" : "Update site",
      detail: compact(input.path || input.project_id || input.site_id, isZh ? "站点项目" : "Site project")
    };
  }
  if (name.includes("__plugins_")) {
    return {
      kind: "plugin",
      label: isZh ? "检查插件" : "Inspect plugins",
      detail: compact(input.plugin || input.query, isZh ? "插件能力" : "Plugin capability")
    };
  }
  if (name === "bash" || name === "sh" || name.includes("command") || name.includes("shell")) {
    return {
      kind: "terminal",
      label: isZh ? "执行命令" : "Run command",
      detail: compact(input.command, isZh ? "终端命令" : "Terminal command")
    };
  }
  if (name.includes("write")) {
    const added = lineCount(input.content);
    return {
      kind: "write",
      label: isZh ? "写入文件" : "Write file",
      detail: compact(path, isZh ? "文件" : "File"),
      meta: added > 0 ? `+${added}` : undefined
    };
  }
  if (name.includes("edit")) {
    const added = lineCount(input.new_string);
    const removed = lineCount(input.old_string);
    return {
      kind: "edit",
      label: isZh ? "编辑文件" : "Edit file",
      detail: compact(path, isZh ? "文件" : "File"),
      meta: added || removed ? `+${added} −${removed}` : undefined
    };
  }
  if (name === "read" || name.includes("file") || name.includes("view")) {
    return {
      kind: "read",
      label: isZh ? "查看文件" : "Read file",
      detail: compact(path, isZh ? "文件" : "File")
    };
  }
  if (name === "grep" || name === "glob" || name.includes("search") || name.includes("find")) {
    return {
      kind: "search",
      label: isZh ? "检索代码" : "Search code",
      detail: compact(input.pattern || input.query || input.glob, isZh ? "工作区" : "Workspace")
    };
  }
  return {
    kind: "generic",
    label: isZh ? "执行操作" : "Run action",
    detail: tool.name
  };
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
