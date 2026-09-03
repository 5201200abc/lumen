# Lumen Native Code Agent

Status: implemented and cut over.

## Decision

Cowork uses a Lumen-owned code-agent runtime that talks directly to the
configured OpenAI-compatible local model endpoint. The former compatibility
runtime and protocol adapter were removed after parity validation.

The recovered Claude Code repositories are research inputs only. Their license
retains Anthropic ownership, the runnable tree replaces unavailable private
packages with stubs, and its package manifest has no consolidated test command.
No recovered source may be copied into Lumen.

## Boundary

The renderer and Cowork task manager consume `AgentRuntimeEvent`; they do not
consume Anthropic, OpenAI, llama.cpp, or MCP wire messages.

The runtime owns:

- model streaming and output-limit detection;
- the model/tool state machine;
- permission requests and tool results;
- token accounting, context compaction, interruption, and retry transitions;
- session persistence, regeneration, checkpoints, and recovery.

Existing Lumen components remain authoritative for:

- Electron UI and task presentation;
- local model lifecycle and settings;
- tool-host implementations;
- Chrome extension control, Sites, Plugins, and web research;
- SQLite storage and usage reporting.

## Required invariants

1. Every tool call has exactly one terminal result before the next model call.
2. A denied tool is recorded as a result and cannot remain pending.
3. Interrupt closes active model and tool work without completing the turn.
4. Context overflow compacts once and retries from preserved state.
5. Output truncation resumes from the unfinished boundary at most three times.
6. Regeneration replaces only the latest assistant result and retains one user
   task message.
7. Rewind previews before modifying files and refuses unsafe links.
8. Chrome automation uses the user's authorized extension session; isolated
   browser control is a separate fallback.

## Cutover gate

The native runtime became the only Cowork runtime after build, contract,
recovery, permissions, checkpoint, context, long-output, Cowork,
Chrome-extension, and real Gemma parity tests passed.
