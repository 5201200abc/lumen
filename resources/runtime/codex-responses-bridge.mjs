#!/usr/bin/env node

import crypto from "node:crypto";
import http from "node:http";

const HOST = process.env.CODEX_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.CODEX_BRIDGE_PORT || 18085);
const LLAMA_URL = (process.env.LLAMA_URL || "http://127.0.0.1:18082/v1").replace(/\/+$/, "");
const MODEL = process.env.LLAMA_MODEL_ALIAS || "Qwen3.8-27B";
const API_KEY = process.env.LLAMA_API_KEY || "";
const REASONING_CONTROL = process.env.LLAMA_REASONING_CONTROL || "effort";

const id = (prefix) => `${prefix}${crypto.randomBytes(12).toString("hex")}`;

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => ["input_text", "output_text", "text"].includes(part?.type))
    .map((part) => part.text || "")
    .join("");
}

function toChat(body) {
  const messages = [];
  const systemParts = body.instructions ? [body.instructions] : [];
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (item.type === "message" || item.role) {
      const role = item.role || "user";
      const content = messageText(item.content);
      if (role === "system" || role === "developer") systemParts.push(content);
      else messages.push({ role, content });
    } else if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [{
          id: item.call_id,
          type: "function",
          function: { name: item.name, arguments: item.arguments || "{}" }
        }]
      });
    } else if (item.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: String(item.output || "") });
    }
  }
  if (systemParts.length) messages.unshift({ role: "system", content: systemParts.filter(Boolean).join("\n\n") });
  const effort = body.reasoning?.effort || "medium";
  const payload = {
    model: process.env.LLAMA_MODEL_ALIAS || MODEL,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    // Cowork targets a single local slot; cap runaway agent turns to keep the Mac responsive.
    max_tokens: Math.min(body.max_output_tokens || 1024, 1024),
    temperature: effort === "low" ? 0.3 : effort === "xhigh" ? 0.85 : 0.7
  };
  if (REASONING_CONTROL === "effort") payload.reasoning_effort = effort;
  if (REASONING_CONTROL === "toggle") {
    payload.enable_thinking = effort !== "low";
    payload.chat_template_kwargs = { enable_thinking: effort !== "low" };
  }
  if (Array.isArray(body.tools)) {
    payload.tools = body.tools
      .filter((tool) => tool.type === "function")
      .map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.parameters || { type: "object", properties: {} }
        }
      }));
  }
  if (body.tool_choice) payload.tool_choice = body.tool_choice;
  return payload;
}

async function responses(res, body) {
  const responseId = id("resp_");
  const created = Math.floor(Date.now() / 1000);
  const backend = await fetch(`${LLAMA_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {})
    },
    body: JSON.stringify(toChat(body))
  });
  if (!backend.ok || !backend.body) {
    const detail = await backend.text().catch(() => "");
    console.error(`llama-server ${backend.status}: ${detail}`);
    res.writeHead(backend.status || 502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `llama-server ${backend.status}: ${detail}` } }));
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const base = { id: responseId, object: "response", created_at: created, model: body.model || MODEL };
  send("response.created", { response: { ...base, status: "in_progress", output: [] } });

  let textItem = null;
  const toolItems = new Map();
  let sequence = 0;
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const decoder = new TextDecoder();
  const reader = backend.body.getReader();
  let buffer = "";

  const ensureText = () => {
    if (textItem) return textItem;
    textItem = { id: id("msg_"), type: "message", status: "in_progress", role: "assistant", content: [] };
    send("response.output_item.added", { output_index: 0, item: textItem, sequence_number: sequence++ });
    send("response.content_part.added", {
      item_id: textItem.id, output_index: 0, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] }, sequence_number: sequence++
    });
    return textItem;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const raw = line.trim().replace(/^data:\s*/, "");
      if (!raw || raw === "[DONE]" || line.trim() === raw) continue;
      let chunk;
      try { chunk = JSON.parse(raw); } catch { continue; }
      if (chunk.usage) {
        usage = {
          input_tokens: chunk.usage.prompt_tokens || 0,
          output_tokens: chunk.usage.completion_tokens || 0,
          total_tokens: chunk.usage.total_tokens || 0
        };
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        const item = ensureText();
        item.content[0] ||= { type: "output_text", text: "", annotations: [] };
        item.content[0].text += delta.content;
        send("response.output_text.delta", {
          item_id: item.id, output_index: 0, content_index: 0,
          delta: delta.content, sequence_number: sequence++
        });
      }
      for (const call of delta.tool_calls || []) {
        const index = call.index || 0;
        let item = toolItems.get(index);
        if (!item) {
          item = {
            id: id("fc_"), type: "function_call", status: "in_progress",
            call_id: call.id || id("call_"), name: call.function?.name || "", arguments: ""
          };
          toolItems.set(index, item);
          send("response.output_item.added", {
            output_index: (textItem ? 1 : 0) + index, item, sequence_number: sequence++
          });
        }
        if (call.function?.name) item.name = call.function.name;
        if (call.function?.arguments) {
          item.arguments += call.function.arguments;
          send("response.function_call_arguments.delta", {
            item_id: item.id, output_index: (textItem ? 1 : 0) + index,
            delta: call.function.arguments, sequence_number: sequence++
          });
        }
      }
    }
  }

  const output = [];
  if (textItem) {
    const text = textItem.content[0]?.text || "";
    send("response.output_text.done", {
      item_id: textItem.id, output_index: 0, content_index: 0, text, sequence_number: sequence++
    });
    send("response.content_part.done", {
      item_id: textItem.id, output_index: 0, content_index: 0,
      part: { type: "output_text", text, annotations: [] }, sequence_number: sequence++
    });
    textItem.status = "completed";
    send("response.output_item.done", { output_index: 0, item: textItem, sequence_number: sequence++ });
    output.push(textItem);
  }
  for (const [index, item] of toolItems) {
    const outputIndex = (textItem ? 1 : 0) + index;
    send("response.function_call_arguments.done", {
      item_id: item.id, output_index: outputIndex, arguments: item.arguments, sequence_number: sequence++
    });
    item.status = "completed";
    send("response.output_item.done", { output_index: outputIndex, item, sequence_number: sequence++ });
    output.push(item);
  }
  send("response.completed", {
    response: { ...base, status: "completed", output, usage }, sequence_number: sequence++
  });
  res.end();
}

const server = http.createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      bridge: "lumen-codex",
      backend: LLAMA_URL,
      model: MODEL,
      reasoningControl: REASONING_CONTROL
    }));
    return;
  }
  if (req.method === "POST" && req.url?.replace(/\/+$/, "") === "/v1/responses") {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", async () => {
      try { await responses(res, JSON.parse(raw)); }
      catch (error) {
        console.error("Responses bridge error:", error);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(error) } }));
      }
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: `${req.method} ${req.url} not found` } }));
});

server.listen(PORT, HOST);
