#!/usr/bin/env node

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.LLAMA_URL) throw new Error("LLAMA_URL is required.");
const LLAMA_URL = process.env.LLAMA_URL;
const PORT = parseInt(process.env.CLAUDE_BRIDGE_PORT || "18084", 10);
const HOST = process.env.CLAUDE_BRIDGE_HOST || "127.0.0.1";
const DEFAULT_MODEL = process.env.LLAMA_MODEL_ALIAS || "Qwen3.8-27B";
const LLAMA_API_KEY = process.env.LLAMA_API_KEY || "";
const REASONING_CONTROL = process.env.LLAMA_REASONING_CONTROL || "effort";
const REASONING_EFFORTS = (process.env.LLAMA_REASONING_EFFORTS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const DEFAULT_SYSTEM_PROMPT_PATH = path.join(os.homedir(), ".config", "llama", "LLAMA.md");
const SYSTEM_PROMPT_PATH = process.env.LLAMA_SYSTEM_PROMPT_PATH || DEFAULT_SYSTEM_PROMPT_PATH;
const FALLBACK_SYSTEM_PROMPT = "你是本地助手，接在本机 Llama / OpenAI-compatible 接口上。";

function getModelRuleStyle() {
  try {
    if (process.env.LLAMA_SYSTEM_PROMPT && process.env.LLAMA_SYSTEM_PROMPT.trim()) {
      return process.env.LLAMA_SYSTEM_PROMPT.trim();
    }
    if (fs.existsSync(SYSTEM_PROMPT_PATH)) {
      const text = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8").trim();
      if (text) return text;
    }
  } catch {}
  return FALLBACK_SYSTEM_PROMPT;
}

const MODEL_STYLE_HASH = crypto.createHash("sha256").update(getModelRuleStyle()).digest("hex").slice(0, 16);

function randomId(prefix = "msg_") {
  return `${prefix}${crypto.randomBytes(12).toString("hex")}`;
}

function convertAnthropicToOpenAI(body) {
  const messages = [];
  const systemParts = [];

  const baseSystemPrompt = getModelRuleStyle();
  if (baseSystemPrompt) {
    systemParts.push(`<model_style>\n${baseSystemPrompt}\n</model_style>`);
  }

  // Extract top-level system prompt
  if (body.system) {
    if (typeof body.system === "string") {
      if (body.system.trim()) systemParts.push(body.system.trim());
    } else if (Array.isArray(body.system)) {
      for (const part of body.system) {
        const text = typeof part === "string" ? part : part.text || "";
        if (text.trim()) systemParts.push(text.trim());
      }
    }
  }

  // Convert messages and extract any embedded system messages
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.role === "system") {
        const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        if (text.trim()) systemParts.push(text.trim());
        continue;
      }

      if (typeof msg.content === "string") {
        messages.push({ role: msg.role, content: msg.content });
        continue;
      }

      if (!Array.isArray(msg.content)) {
        messages.push({ role: msg.role, content: String(msg.content || "") });
        continue;
      }

      if (msg.role === "assistant") {
        const textParts = [];
        const toolCalls = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            textParts.push(block.text);
          } else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id || randomId("toolu_"),
              type: "function",
              function: {
                name: block.name,
                arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input || {})
              }
            });
          }
        }
        const openAiMsg = { role: "assistant" };
        if (textParts.length > 0) openAiMsg.content = textParts.join("\n");
        else openAiMsg.content = "";
        if (toolCalls.length > 0) openAiMsg.tool_calls = toolCalls;
        messages.push(openAiMsg);
      } else if (msg.role === "user") {
        const textParts = [];
        const toolResults = [];

        for (const block of msg.content) {
          if (block.type === "text") {
            textParts.push(block.text);
          } else if (block.type === "image") {
            textParts.push({
              type: "image_url",
              image_url: {
                url: `data:${block.source?.media_type || "image/jpeg"};base64,${block.source?.data || ""}`
              }
            });
          } else if (block.type === "tool_result") {
            let resContent = "";
            if (typeof block.content === "string") {
              resContent = block.content;
            } else if (Array.isArray(block.content)) {
              resContent = block.content
                .map((c) => (typeof c === "string" ? c : c.text || JSON.stringify(c)))
                .join("\n");
            } else {
              resContent = JSON.stringify(block.content ?? "");
            }
            toolResults.push({
              role: "tool",
              tool_call_id: block.tool_use_id,
              content: resContent
            });
          }
        }

        // Push any tool results first (matching previous assistant tool_calls)
        for (const tr of toolResults) {
          messages.push(tr);
        }

        // Push user message text if any
        if (textParts.length > 0) {
          if (textParts.every((p) => typeof p === "string")) {
            messages.push({ role: "user", content: textParts.join("\n") });
          } else {
            messages.push({
              role: "user",
              content: textParts.map((p) => (typeof p === "string" ? { type: "text", text: p } : p))
            });
          }
        }
      }
    }
  }

  if (systemParts.length > 0) {
    messages.unshift({ role: "system", content: systemParts.join("\n\n") });
  }

  // Convert tools
  let tools = undefined;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    tools = body.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || { type: "object", properties: {} }
      }
    }));
  }

  let tool_choice = undefined;
  if (body.tool_choice) {
    if (body.tool_choice.type === "auto") tool_choice = "auto";
    else if (body.tool_choice.type === "any") tool_choice = "required";
    else if (body.tool_choice.type === "tool" && body.tool_choice.name) {
      tool_choice = { type: "function", function: { name: body.tool_choice.name } };
    }
  }

  const requestedEffort = (body.effort || process.env.CLAUDE_EFFORT || "medium").toLowerCase();
  const reasoningControl = REASONING_CONTROL;
  const headerEffort = reasoningControl === "effort" &&
    REASONING_EFFORTS.length &&
    !REASONING_EFFORTS.includes(requestedEffort)
    ? REASONING_EFFORTS.at(-1)
    : requestedEffort;
  const enableThinking = !["none", "minimal", "low"].includes(headerEffort);
  const temp = headerEffort === "low" ? 0.3 : headerEffort === "xhigh" ? 0.85 : (body.temperature ?? 0.7);

  const payload = {
    model: process.env.LLAMA_MODEL_ALIAS || DEFAULT_MODEL,
    messages,
    stream: Boolean(body.stream),
    temperature: temp,
    // Claude's advertised model metadata can request 64K output. A single local
    // llama slot must stay bounded so tool turns remain interruptible.
    max_tokens: Math.min(body.max_tokens ?? 1024, 1024)
  };

  if (reasoningControl === "effort") {
    payload.reasoning_effort = headerEffort;
    payload.enable_thinking = enableThinking;
    payload.chat_template_kwargs = {
      enable_thinking: enableThinking,
      preserve_thinking: enableThinking,
      reasoning_effort: headerEffort
    };
  } else if (reasoningControl === "toggle") {
    payload.enable_thinking = enableThinking;
    payload.chat_template_kwargs = { enable_thinking: enableThinking };
  }

  if (tools) payload.tools = tools;
  if (tool_choice) payload.tool_choice = tool_choice;

  return payload;
}

async function handleMessages(req, res, body) {
  const isStream = Boolean(body.stream);
  const openAiPayload = convertAnthropicToOpenAI(body);
  const targetUrl = `${LLAMA_URL.replace(/\/$/, "")}/chat/completions`;

  const llamaRes = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(LLAMA_API_KEY ? { Authorization: `Bearer ${LLAMA_API_KEY}` } : {})
    },
    body: JSON.stringify(openAiPayload)
  });

  if (!llamaRes.ok) {
    const errorText = await llamaRes.text().catch(() => "");
    res.writeHead(llamaRes.status, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: {
          type: "api_error",
          message: `Llama-server returned HTTP ${llamaRes.status}: ${errorText}`
        }
      })
    );
    return;
  }

  if (!isStream) {
    const data = await llamaRes.json();
    const choice = data.choices?.[0];
    const msg = choice?.message;
    const finishReason = choice?.finish_reason;

    const content = [];
    if (msg?.content) {
      content.push({ type: "text", text: msg.content });
    }
    if (Array.isArray(msg?.tool_calls)) {
      for (const tc of msg.tool_calls) {
        let input = {};
        try {
          input = JSON.parse(tc.function?.arguments || "{}");
        } catch {
          input = { raw: tc.function?.arguments || "" };
        }
        content.push({
          type: "tool_use",
          id: tc.id || randomId("toolu_"),
          name: tc.function?.name || "tool",
          input
        });
      }
    }

    let stopReason = "end_turn";
    if (finishReason === "tool_calls" || (msg?.tool_calls && msg.tool_calls.length > 0)) {
      stopReason = "tool_use";
    } else if (finishReason === "length") {
      stopReason = "max_tokens";
    }

    const responseBody = {
      id: randomId("msg_"),
      type: "message",
      role: "assistant",
      model: body.model || DEFAULT_MODEL,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: data.usage?.prompt_tokens || 10,
        output_tokens: data.usage?.completion_tokens || 10
      }
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(responseBody));
    return;
  }

  // Handle SSE streaming
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  const msgId = randomId("msg_");
  const modelName = body.model || DEFAULT_MODEL;

  const sendEvent = (event, eventData) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(eventData)}\n\n`);
  };

  sendEvent("message_start", {
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [],
      model: modelName,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 }
    }
  });

  let currentBlockIndex = -1;
  let currentBlockType = null;
  const toolCallMap = new Map(); // index in openAI -> { anthropicIndex, id, name, args }
  let stopReason = "end_turn";

  const closeCurrentBlock = () => {
    if (currentBlockIndex >= 0 && currentBlockType) {
      sendEvent("content_block_stop", {
        type: "content_block_stop",
        index: currentBlockIndex
      });
      currentBlockType = null;
    }
  };

  const decoder = new TextDecoder();
  const reader = llamaRes.body.getReader();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const raw = trimmed.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;

        let json;
        try {
          json = JSON.parse(raw);
        } catch {
          continue;
        }

        const choice = json.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        const finish = choice.finish_reason;

        if (finish) {
          if (finish === "tool_calls" || toolCallMap.size > 0) stopReason = "tool_use";
          else if (finish === "length") stopReason = "max_tokens";
          else stopReason = toolCallMap.size > 0 ? "tool_use" : "end_turn";
        }

        // Handle text delta
        const textChunk = delta?.content || "";
        if (textChunk) {
          if (currentBlockType !== "text") {
            closeCurrentBlock();
            currentBlockIndex += 1;
            currentBlockType = "text";
            sendEvent("content_block_start", {
              type: "content_block_start",
              index: currentBlockIndex,
              content_block: { type: "text", text: "" }
            });
          }
          sendEvent("content_block_delta", {
            type: "content_block_delta",
            index: currentBlockIndex,
            delta: { type: "text_delta", text: textChunk }
          });
        }

        // Handle tool calls delta
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const tcIdx = tc.index ?? 0;
            if (!toolCallMap.has(tcIdx)) {
              closeCurrentBlock();
              currentBlockIndex += 1;
              currentBlockType = "tool_use";
              const toolId = tc.id || randomId("toolu_");
              const toolName = tc.function?.name || "";
              toolCallMap.set(tcIdx, {
                anthropicIndex: currentBlockIndex,
                id: toolId,
                name: toolName
              });
              sendEvent("content_block_start", {
                type: "content_block_start",
                index: currentBlockIndex,
                content_block: {
                  type: "tool_use",
                  id: toolId,
                  name: toolName,
                  input: {}
                }
              });
            }

            const existing = toolCallMap.get(tcIdx);
            const argChunk = tc.function?.arguments || "";
            if (argChunk) {
              sendEvent("content_block_delta", {
                type: "content_block_delta",
                index: existing.anthropicIndex,
                delta: {
                  type: "input_json_delta",
                  partial_json: argChunk
                }
              });
            }
          }
        }
      }
    }

    closeCurrentBlock();
    if (toolCallMap.size > 0) {
      stopReason = "tool_use";
    }

    sendEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 20 }
    });

    sendEvent("message_stop", {
      type: "message_stop"
    });
  } catch (err) {
    console.error("Stream error:", err);
  } finally {
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      bridge: "lumen-claude",
      backend: LLAMA_URL,
      model: DEFAULT_MODEL,
      reasoningControl: REASONING_CONTROL,
      reasoningEfforts: REASONING_EFFORTS.join(","),
      styleHash: MODEL_STYLE_HASH
    }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data: [
          { id: "claude-3-5-sonnet-20241022", type: "model", display_name: "Claude 3.5 Sonnet" },
          { id: "claude-3-7-sonnet-20250219", type: "model", display_name: "Claude 3.7 Sonnet" },
          { id: "claude-3-opus-20240229", type: "model", display_name: "Claude 3 Opus" },
          { id: DEFAULT_MODEL, type: "model", display_name: `${DEFAULT_MODEL} (Local)` }
        ]
      })
    );
    return;
  }

  if (req.method === "POST" && (url.pathname === "/v1/messages/count_tokens" || url.pathname === "/messages/count_tokens")) {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ input_tokens: Math.max(1, Math.round(raw.length / 4)) }));
    });
    return;
  }

  if (req.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/messages")) {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      try {
        const body = JSON.parse(raw);
        await handleMessages(req, res, body);
      } catch (err) {
        console.error("Request parse error:", err);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(err) } }));
      }
    });
    return;
  }

  // Fallback 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: `Route not found: ${req.method} ${url.pathname}` } }));
});

server.listen(PORT, HOST, () => {
  console.log(`Claude Code Anthropic-to-OpenAI Bridge running on http://${HOST}:${PORT}`);
  console.log(`Forwarding requests to ${LLAMA_URL}`);
});
