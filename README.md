# RG Axtention IDE

> **Part of the [ResonantGenesis](https://dev-swat.com) platform** — standalone VS Code extension for AI-powered agentic coding.

[![Status: Production](https://img.shields.io/badge/Status-Production-brightgreen.svg)]()
[![Type: VS Code Extension](https://img.shields.io/badge/Type-VS%20Code%20Extension-007ACC.svg)]()
[![Tools: 59+](https://img.shields.io/badge/Tools-59%2B-green.svg)]()
[![Providers: 6+](https://img.shields.io/badge/Providers-6%2B-purple.svg)]()
[![License: RG Source Available](https://img.shields.io/badge/License-RG%20Source%20Available-blue.svg)](LICENSE.txt)

AI-powered agentic coding assistant for VS Code — like Cascade (Windsurf) but built for the Resonant Genesis platform. 59+ local tools with full agentic loop, multi-provider LLM support (including offline via Ollama), and sellable as a standalone product. Extracted from `RG_IDE/extensions/resonant-ai/`.

## Architecture

```
┌─────────────────────────────────────┐
│  VS Code / RG_IDE                   │
│  ┌───────────────────────────────┐  │
│  │  RG_Axtention_IDE Extension   │  │
│  │  ┌─────────────────────────┐  │  │
│  │  │  Chat Panel (webview)   │  │  │
│  │  │  Tool Definitions (59+) │  │  │
│  │  │  Tool Executor (local)  │  │  │
│  │  │  Language Model Provider│  │  │
│  │  │  Auth Service           │  │  │
│  │  │  LOC Tracker            │  │  │
│  │  │  Update Checker         │  │  │
│  │  └─────────────────────────┘  │  │
│  └───────────────────────────────┘  │
└───────────────┬─────────────────────┘
                │
    ┌───────────┴───────────────┐
    │                           │
    ▼                           ▼
LOCAL MODE                  CLOUD MODE
/api/v1/ide/completions     /api/v1/agentic-chat/stream
→ chat_service (LLM only)   → rg_agentic_chat (full)
Tools run in extension       Tools run on server
```

## Features

- **59+ local tools** — file read/write/edit, grep search, terminal execution, code analysis, git operations, and more
- **Agentic loop** — LLM calls tools → extension executes locally → results fed back → LLM decides next step
- **Multi-provider** — Groq, OpenAI, Anthropic, Google, DeepSeek, Mistral (via BYOK or platform keys)
- **Local LLM support** — Connect to Ollama, LM Studio, llama.cpp — fully offline mode
- **Cloud + Local modes** — Server-side tools (cloud) or client-side execution (local)
- **Memory integration** — Stores conversation context to Resonant Genesis Hash Sphere
- **LOC tracking** — Tracks lines of code written by AI in real-time
- **Inline completions** — Ghost text suggestions as you type
- **Auto-updates** — Checks for new IDE versions automatically
- **Auth** — Sign in with Resonant Genesis account or API key

## Source Files

| File | Size | Purpose |
|------|------|---------|
| `src/extension.ts` | 54KB | Main entry — registers chat participant, agentic loop, SSE streaming |
| `src/toolExecutor.ts` | 90KB | Executes 59+ tools locally (file ops, terminal, git, search, etc.) |
| `src/toolDefinitions.ts` | 40KB | Tool schemas (OpenAI function-calling format) + system prompts |
| `src/chatViewProvider.ts` | 34KB | Webview-based chat panel UI with markdown rendering |
| `src/settingsPanel.ts` | 27KB | Settings webview (providers, models, API keys, preferences) |
| `src/languageModelProvider.ts` | 23KB | Multi-provider LLM client (cloud + BYOK key management) |
| `src/localLLMProvider.ts` | 11KB | Local LLM support (Ollama, LM Studio, llama.cpp) |
| `src/interactiveTerminal.ts` | 11KB | PTY terminal session management |
| `src/authService.ts` | 10KB | Auth flow (JWT, API key, session management) |
| `src/profileWebview.ts` | 9KB | User profile & account settings panel |
| `src/inlineCompletionProvider.ts` | 7KB | Inline code completions (ghost text) |
| `src/agentProvider.ts` | 7KB | Agent mode provider (multi-step task execution) |
| `src/authProvider.ts` | 7KB | VS Code AuthenticationProvider integration |
| `src/locTracker.ts` | 6KB | LOC tracking — counts lines written by AI tools |
| `src/updateChecker.ts` | 6KB | Auto-update checker for IDE releases |

## Backend Endpoints Used

| Endpoint | Service | Mode |
|----------|---------|------|
| `/api/v1/ide/completions` | `chat_service` | Local — LLM proxy only, tools run in extension |
| `/api/v1/agentic-chat/stream` | `rg_agentic_chat` | Cloud — full agentic loop on server |
| `/api/v1/ide/loc/track` | [`RG_IDE_Platform`](https://github.com/DevSwat-ResonantGenesis/RG_IDE_Platform) | Both — LOC tracking |
| `/api/v1/ide/updates/check` | [`RG_IDE_Platform`](https://github.com/DevSwat-ResonantGenesis/RG_IDE_Platform) | Both — auto-update checks |
| `/api/v1/auth/*` | `auth_service` | Both — authentication |
| `/api/v1/memory/*` | `memory_service` | Both — conversation memory |

## Quick Start

```bash
# Clone
git clone git@github-devswat:DevSwat-ResonantGenesis/RG_Axtention_IDE.git
cd RG_Axtention_IDE

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Package as .vsix
npm run package

# Install in VS Code
code --install-extension rg-axtention-ide-1.0.0.vsix
```

## Configuration

After installing, open VS Code Settings and search for "Resonant AI":

- **API URL** — `https://dev-swat.com` (or your self-hosted instance)
- **Chat Mode** — `local` (tools in extension) or `cloud` (tools on server)
- **Max Tool Loops** — Default 15 loops per message
- **Local LLM** — Enable for offline mode with Ollama/LM Studio

## Development

```bash
# Watch mode (auto-recompile on save)
npm run watch

# Press F5 in VS Code to launch Extension Development Host
```

## Distribution (Sell as Separate Product)

This extension is designed to be sold independently, like how Windsurf sells Cascade:

1. **Marketplace** — Package as `.vsix` and publish to VS Code Marketplace or Open VSX
2. **Direct download** — Host `.vsix` on your website
3. **Bundled with RG_IDE** — Pre-installed in the Resonant IDE fork
4. **Enterprise licensing** — API key gating via `resonant.apiUrl` configuration

The extension connects to the Resonant Genesis backend for LLM calls, memory storage, LOC tracking, and authentication. All tool execution happens **locally** in the extension — no server-side tool execution needed in local mode.

## Related Modules

| Module | Repo | Relationship |
|--------|------|-------------|
| IDE Platform | [`RG_IDE_Platform`](https://github.com/DevSwat-ResonantGenesis/RG_IDE_Platform) | Backend service for LOC tracking + auto-updates |
| Resonant IDE | [`RG_IDE`](https://github.com/DevSwat-ResonantGenesis/RG_IDE) | VS Code fork — this extension is pre-bundled inside it |
| Registered Users Agentic Chat | [`RG_Registered_Users_Agentic_Chat`](https://github.com/DevSwat-ResonantGenesis/RG_Registered_Users_Agentic_Chat) | Cloud mode routes to this service |
| Unified LLM Client | [`RG_UnifiedLLMClient`](https://github.com/DevSwat-ResonantGenesis/RG_UnifiedLLMClient) | Backend LLM abstraction (used by chat_service, not directly by extension) |

## Deployment Status

- **Status**: ✅ **Production** — bundled inside RG_IDE, also installable standalone as `.vsix`
- **Extracted from**: `RG_IDE/extensions/resonant-ai/` (source of truth now in this repo)
- **Type**: VS Code Extension (TypeScript, client-side)
- **Zero compile errors** on standalone build

---

**Organization**: [DevSwat-ResonantGenesis](https://github.com/DevSwat-ResonantGenesis)
**Platform**: [dev-swat.com](https://dev-swat.com)
