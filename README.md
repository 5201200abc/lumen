# Lumen

Local open-source model chat and Cowork agent for the desktop.

[中文](README.zh.md) · [Usage guide](https://5201200abc.github.io/lumen/guide.html)

## 1. Run Lumen

1. Install Node.js 22.12 or newer.
2. Clone this repository, run `npm ci`, then `npm run dev`.
3. Lumen does not ship model weights.

## 2. Install llama-server

1. Install current [`llama-server`](https://github.com/ggml-org/llama.cpp) and put it on `PATH`.
2. Put `.gguf` files in `~/models` (Windows: `%USERPROFILE%\models`). One model per folder. Put `mmproj*.gguf` next to a vision model.
3. Open Lumen (auto-start is on). Or Settings → General → Start.
4. After adding files: Settings → Models → Model Refresh.

Lumen runs a directory router (`--models-max 1`): every GGUF stays registered; only one is in RAM.

## 3. Chat

1. Sidebar: Chat.
2. Pick a model. Enter sends. Shift+Enter newline.
3. Attach with +. Screenshot: `⌘⇧S` / `Ctrl+Shift+S`.

## 4. Web research

1. Settings → API Key → Tavily key.
2. Ask for public-web or current information; Lumen enables research automatically. The globe forces research for any prompt.
3. Flow: Tavily Search → pick 3–5 URLs → Extract → cross-check → report.
4. Optional extractor: Settings → Web Research → Firecrawl (self-hosted only, `http://127.0.0.1:3002`).

## 5. Cowork

1. Sidebar → Cowork. Pick a folder. Send a task.
2. Cowork uses the platform-native runtime bundled by Claude Agent SDK; no separate Claude CLI is required.
3. First run starts the local-model bridge at `127.0.0.1:18086`; a healthy matching bridge is not replaced.
4. The optional raw Claude Code terminal requires `claude` on `PATH`.

## 6. Optional

- Google (sidebar): Drive app-data backup of `lumen.sqlite`.
- Settings → Plugins / Computer use: in-app browser, site preview, Chrome CDP.
- Model style: `~/.config/llama/LLAMA.md`.

## 7. Develop

```bash
npm ci
npm run dev
```
