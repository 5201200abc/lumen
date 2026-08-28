#!/usr/bin/env node

const hostUrl = process.env.LUMEN_TOOL_HOST_URL || "";
const hostToken = process.env.LUMEN_TOOL_HOST_TOKEN || "";
const workspace = process.env.LUMEN_TOOL_WORKSPACE || process.cwd();

const tools = [
  {
    name: "browser_open",
    description: "Open an http/https URL in Lumen's visible built-in browser.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "URL or hostname to open." } },
      required: ["url"],
      additionalProperties: false
    }
  },
  {
    name: "browser_snapshot",
    description: "Read the current built-in browser page and return visible text plus numbered interactive controls.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "browser_click",
    description: "Click a numbered control from the latest browser_snapshot.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: ["string", "number"], description: "Control ref from browser_snapshot." } },
      required: ["ref"],
      additionalProperties: false
    }
  },
  {
    name: "browser_type",
    description: "Type into a numbered input from browser_snapshot, optionally submitting its form.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: ["string", "number"] },
        text: { type: "string" },
        submit: { type: "boolean", default: false }
      },
      required: ["ref", "text"],
      additionalProperties: false
    }
  },
  {
    name: "browser_screenshot",
    description: "Capture the visible built-in browser page and return the local PNG path.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "sites_preview",
    description: "Serve a built static site from the active workspace and open it in Lumen's built-in browser. Looks for index.html in dist, build, public, or the selected directory.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Workspace-relative site directory. Defaults to the workspace root." }
      },
      additionalProperties: false
    }
  },
  {
    name: "sites_status",
    description: "Return the current Lumen Sites local preview URL and root.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "plugins_list",
    description: "List valid locally installed Claude Agent or Lumen plugin manifests.",
    inputSchema: {
      type: "object",
      properties: {
        details: { type: "boolean", default: false, description: "Include descriptions and manifest paths." }
      },
      additionalProperties: false
    }
  },
  {
    name: "chrome_open",
    description: "Open an http/https URL in the user's dedicated Lumen Google Chrome Computer use profile.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "URL or hostname to open." } },
      required: ["url"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_snapshot",
    description: "Read the active Google Chrome page and return visible text plus numbered interactive controls.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "chrome_click",
    description: "Click a numbered control from the latest chrome_snapshot.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: ["string", "number"] } },
      required: ["ref"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_type",
    description: "Type into a numbered Google Chrome control, optionally submitting its form.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: ["string", "number"] },
        text: { type: "string" },
        submit: { type: "boolean", default: false }
      },
      required: ["ref", "text"],
      additionalProperties: false
    }
  },
  {
    name: "chrome_screenshot",
    description: "Capture the visible Google Chrome page and return the local PNG path.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
].filter((tool) => {
  if (tool.name.startsWith("browser_")) return process.env.LUMEN_PLUGIN_BROWSER !== "0";
  if (tool.name.startsWith("sites_")) return process.env.LUMEN_PLUGIN_SITES !== "0";
  if (tool.name.startsWith("plugins_")) return process.env.LUMEN_PLUGIN_MANAGEMENT !== "0";
  if (tool.name.startsWith("chrome_")) return process.env.LUMEN_COMPUTER_USE_CHROME !== "0";
  return true;
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function callTool(name, args) {
  if (!hostUrl || !hostToken) throw new Error("Lumen Tool Host connection is unavailable.");
  const response = await fetch(`${hostUrl}/call`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${hostToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ name, arguments: args || {}, workspace })
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || `Lumen tool failed with HTTP ${response.status}.`);
  return payload.content;
}

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.method === "notifications/initialized" || message.method?.startsWith("notifications/")) return;
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion || "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "lumen-tools", version: "1.0.0" }
      }
    });
    return;
  }
  if (message.method === "ping") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
    return;
  }
  if (message.method === "resources/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { resources: [] } });
    return;
  }
  if (message.method === "prompts/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { prompts: [] } });
    return;
  }
  if (message.method === "tools/call") {
    try {
      const content = await callTool(message.params?.name, message.params?.arguments);
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: JSON.stringify(content, null, 2) }] }
      });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }]
        }
      });
    }
    return;
  }
  if (message.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` }
    });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch (error) {
      process.stderr.write(`Invalid MCP message: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
});
