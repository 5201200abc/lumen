# Usage

English is the default. Follow the steps in order.

## 1. Run Lumen

### From source

Install Node.js 22.12 or newer, clone this repository, then run `npm ci` and `npm run dev`.

### Open

Launch the app. Lumen does not ship model weights.

## 2. Install llama-server

### PATH

Install a current [`llama-server`](https://github.com/ggml-org/llama.cpp) and put it on `PATH`.

### GGUF files

Place `.gguf` files under `~/models` (Windows: `%USERPROFILE%\models`). One model per folder.

### Vision

Put `mmproj*.gguf` in the same folder as a vision model.

## 3. Start the local router

### Auto-start

Open Lumen. Auto-start is on by default.

### Manual

Settings → General → Start / Restart / Stop.

### Refresh models

After adding files: Settings → Models → Model Refresh.

### How it works

Directory router (`--models-max 1`): all GGUFs stay registered; only one sits in RAM.

## 4. Chat

### Tab

Stay on Chat in the sidebar.

### Send

Pick a model. Enter sends. Shift+Enter is a newline.

### Attachments

Attach with +. Screenshot: `⌘⇧S` / `Ctrl+Shift+S`.

## 5. Web research

### Tavily key

Settings → API Key → add a Tavily key.

### Globe

Click the globe in the composer, then send.

### Pipeline

Search → pick 3–5 sources → extract → cross-check → report.

### Firecrawl

Optional: Settings → Web Research → Firecrawl (self-hosted only, default `http://127.0.0.1:3002`).

## 6. Cowork

### CLI

Install Claude CLI (`~/.local/bin/claude`).

### Code tab

Sidebar → Code. Pick a workspace folder. Send a task.

### Agent runtime

Cowork runs through Claude Agent SDK with Lumen's local-model bridge.

### Bridges

First run starts the bridge at `127.0.0.1:18086`. A healthy matching bridge is left alone.

## 7. Optional

### Google

Sidebar account menu. Backs up `lumen.sqlite` to Drive app data.

### Plugins

Settings → Plugins / Computer use: in-app browser, local site preview, Chrome CDP.

### Instructions

Settings → Instructions. Model style lives in `~/.config/llama/LLAMA.md`.

## 8. Develop

### Run

```bash
npm ci
npm run dev
```
