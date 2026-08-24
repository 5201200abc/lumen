# Lumen local model runtime

These scripts start a user-provided GGUF model with `llama-server`. They contain
no model weights, API keys, usernames, or machine-specific paths.

Lumen passes the selected model and runtime values through environment
variables. If port `18082` already has a healthy llama-server, the scripts leave
that service untouched.

Requirements:

- Install a current `llama-server` from llama.cpp and put it on `PATH`, or set
  `LLAMA_SERVER_BIN`.
- Put one or more `.gguf` files under the models directory selected in Lumen.
- Lumen defaults to a 16,384-token context, one parallel slot, and GPU offload.

`claude-bridge.mjs` is a dependency-free loopback adapter used by Cowork to
translate the locally installed Claude CLI's Anthropic requests to the selected
OpenAI-compatible Llama endpoint. Lumen starts it only when port `18084` does
not already have a healthy bridge.
