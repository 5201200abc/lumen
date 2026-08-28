# Lumen local model runtime

These scripts start a permanent multi-model GGUF router with `llama-server`. They contain
no model weights, API keys, usernames, or machine-specific paths.

Lumen discovers a running `llama-server` from its actual loopback listener and
persists that port. If none exists, it uses the configured port or reserves a
free one. An obsolete single-model server on the selected port is replaced.
General settings provides persistent start, restart, stop, port, and auto-start
controls; logs and PID state live in the app data directory, never `~/models`.

Requirements:

- Install a current `llama-server` from llama.cpp and put it on `PATH`, or set
  `LLAMA_SERVER_BIN`.
- Put one or more `.gguf` files under the models directory selected in Lumen.
  Put a model-specific `mmproj*.gguf` in the same directory as its model.
- Lumen defaults to a 16,384-token context, one parallel slot, and GPU offload.
- `--models-max 1` limits simultaneous memory residency, not catalog size; all
discovered models remain switchable through the router.

`firecrawl-self-host.sh` and `firecrawl-self-host.ps1` manage an optional
official Firecrawl self-host checkout (`install`, `start`, `stop`, `restart`,
`status`). The default is the pinned official `v2.11.0` release and may be
overridden with `FIRECRAWL_VERSION`. Tavily Search + Extract remains the default
cloud research path.

`claude-bridge.mjs` is a dependency-free loopback adapter used by Cowork to
translate the locally installed Claude CLI's Anthropic requests to the selected
OpenAI-compatible Llama endpoint. Lumen starts it only when its dedicated port `18086` does
not already have a healthy bridge.

Cowork runs one agent loop through Claude Agent SDK. Lumen does not launch or
delegate to a second coding agent.
