# RG_Axtention_IDE — Resonant AI Agentic Coding Extension

Standalone VS Code extension for AI-powered agentic coding. Like Cascade (Windsurf) — but built for the Resonant Genesis platform and sellable as a separate product.

## What It Does

A full agentic coding assistant that lives inside VS Code's sidebar:

- **59+ local tools**: file read/write/edit, grep search, terminal execution, code analysis, git operations, and more
- **Agentic loop**: LLM calls tools → extension executes locally → results fed back → LLM decides next step
- **Multi-provider**: Groq, OpenAI, Anthropic, Google, DeepSeek, Mistral (via BYOK or platform keys)
- **Local LLM support**: Connect to Ollama, LM Studio, llama.cpp — fully offline mode
- **Cloud + Local modes**: Server-side tools (cloud) or client-side execution (local)
- **Memory integration**: Stores conversation context to Resonant Genesis Hash Sphere
- **LOC tracking**: Tracks lines of code written by AI in real-time
- **Auto-updates**: Checks for new IDE versions automatically
- **Auth**: Sign in with Resonant Genesis account or API key

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

## Source Files

| File | Size | Purpose |
|------|------|---------|
| `extension.ts` | 54KB | Main entry — registers chat participant, agentic loop, SSE streaming |
| `toolExecutor.ts` | 90KB | Executes 59+ tools locally (file ops, terminal, git, search, etc.) |
| `toolDefinitions.ts` | 40KB | Tool schemas (OpenAI function-calling format) + system prompts |
| `chatViewProvider.ts` | 34KB | Webview-based chat panel UI with markdown rendering |
| `settingsPanel.ts` | 27KB | Settings webview (providers, models, API keys, preferences) |
| `languageModelProvider.ts` | 23KB | Multi-provider LLM client (cloud + BYOK key management) |
| `localLLMProvider.ts` | 11KB | Local LLM support (Ollama, LM Studio, llama.cpp) |
| `interactiveTerminal.ts` | 11KB | PTY terminal session management |
| `authService.ts` | 10KB | Auth flow (JWT, API key, session management) |
| `profileWebview.ts` | 9KB | User profile & account settings panel |
| `inlineCompletionProvider.ts` | 7KB | Inline code completions (ghost text) |
| `agentProvider.ts` | 7KB | Agent mode provider (multi-step task execution) |
| `authProvider.ts` | 7KB | VS Code AuthenticationProvider integration |
| `locTracker.ts` | 6KB | LOC tracking — counts lines written by AI tools |
| `updateChecker.ts` | 6KB | Auto-update checker for IDE releases |

## Backend Endpoints Used

| Endpoint | Service | Mode |
|----------|---------|------|
| `/api/v1/ide/completions` | `chat_service` | Local — LLM proxy only, tools run in extension |
| `/api/v1/agentic-chat/stream` | `rg_agentic_chat` | Cloud — full agentic loop on server |
| `/api/v1/ide/loc/track` | `ide_platform_service` | Both — LOC tracking |
| `/api/v1/ide/updates/check` | `ide_platform_service` | Both — auto-update checks |
| `/api/v1/auth/*` | `auth_service` | Both — authentication |
| `/api/v1/memory/*` | `memory_service` | Both — conversation memory |

## Quick Start

```bash
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

- **API URL**: `https://dev-swat.com` (or your self-hosted instance)
- **Chat Mode**: `local` (tools in extension) or `cloud` (tools on server)
- **Max Tool Loops**: Default 15 loops per message
- **Local LLM**: Enable for offline mode with Ollama/LM Studio

## Development

```bash
# Watch mode (auto-recompile on save)
npm run watch

# Press F5 in VS Code to launch Extension Development Host
```

## Selling as Separate Product

This extension is designed to be sold independently, like how Windsurf sells Cascade:

1. **Marketplace**: Package as `.vsix` and publish to VS Code Marketplace or Open VSX
2. **Direct download**: Host `.vsix` on your website
3. **Bundled with RG_IDE**: Pre-installed in the Resonant IDE fork
4. **Enterprise licensing**: API key gating via `resonant.apiUrl` configuration

The extension connects to the Resonant Genesis backend for:
- LLM calls (via `/api/v1/ide/completions` using user's BYOK keys)
- Memory storage (conversation context)
- LOC tracking (usage metrics)
- Authentication (platform account)

All tool execution happens **locally** in the extension — no server-side tool execution needed in local mode.
