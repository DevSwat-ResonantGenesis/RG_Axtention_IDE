# RG_Axtention_IDE

**Server-side agentic orchestration for Resonant IDE** by [Resonant Genesis](https://dev-swat.com).

## Overview

This is the **backend brain** for Resonant IDE. It runs the full agentic loop server-side:
LLM calls, tool selection, system prompt, message history, and retry logic.

The IDE extension ([`RG_IDE`](https://github.com/DevSwat-ResonantGenesis/RG_IDE)) is a thin client that only renders UI and executes tools locally on the user's machine. All orchestration intelligence stays here on the server — system prompts, tool definitions, tool selection algorithm, and LLM provider routing never leave this service.

## Architecture

```
User's Machine (RG_IDE extension)          Server (this service)
┌─────────────────────────┐                ┌──────────────────────────┐
│  Thin client:           │  SSE stream    │  Agentic loop:           │
│  - Renders UI           │◄──────────────│  - System prompt          │
│  - Executes tools       │                │  - 59 tool definitions    │
│  - POSTs tool results   │───────────────►│  - Smart tool selection   │
│  - Auth (JWT/DSID)      │                │  - LLM calls (6 provs)   │
│  - LLM discovery        │                │  - Message history mgmt   │
│                         │                │  - Retry + rate limit     │
│  NO orchestration code  │                │  - BYOK key resolution    │
│  NO tool definitions    │                │  - Local LLM proxy        │
│  NO system prompt       │                │    (Ollama via client URL)│
└─────────────────────────┘                └──────────────────────────┘
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/ide/agent-stream` | Full agentic loop (SSE) |
| POST | `/api/v1/ide/agent-stream/{sid}/tool-results` | Client posts tool results |
| POST | `/api/v1/ide/completions` | Single-turn LLM proxy (SSE) |
| GET  | `/health` | Health check |

## Request Body (`/api/v1/ide/agent-stream`)

```json
{
  "prompt": "Create a React component for user profiles",
  "workspace_root": "/Users/dev/myproject",
  "active_file": "/Users/dev/myproject/src/App.tsx",
  "model_id": "resonant-anthropic-claude-sonnet-4-20250514",
  "context": [{"role": "user", "content": "previous message"}],
  "max_loops": 25,
  "local_llm": {
    "url": "http://localhost:11434",
    "model": "qwen2.5-coder:32b",
    "context_length": 32768
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | string | User's message (required) |
| `workspace_root` | string | Absolute path to workspace (required) |
| `active_file` | string? | Currently open file path |
| `model_id` | string? | Model in `resonant-{provider}-{model}` format |
| `context` | array? | Previous conversation messages |
| `max_loops` | int | Max agentic iterations (default: 25, cap: 50) |
| `local_llm` | object? | Ollama config — `{url, model, context_length}` |

## SSE Protocol

1. Client → `POST /api/v1/ide/agent-stream` with prompt + workspace info
2. Server streams SSE events:
   - `thinking` — `{"message": "Thinking... (loop N)"}`
   - `fallback` — `{"provider": "anthropic", "model": "claude-...", "attempt": 1}` (emitted each time a provider is tried)
   - `text` — `{"content": "markdown text..."}`
   - `execute_tool` — `{"session_id": "...", "tool_call_id": "...", "name": "...", "arguments": {...}}`
   - `tool_done` — `{"tool_call_id": "...", "status": "ok|error"}`
   - `stats` — `{"loops": N, "tool_calls": N, "tokens": N, "provider": "...", "model": "...", "fallback_chain": [...]}`
   - `done` — `{}`
   - `error` — `{"error": "..."}`
3. On `execute_tool` → client runs tool locally → `POST .../tool-results`
4. Server resumes loop with results → calls LLM again → repeat until done

## LLM Provider Chain (`rg_llm`)

All LLM calls go through the shared **`RG_UnifiedLLMClient`** (`rg_llm`) module — the same client used by `chat_service`, `agent_engine_service`, and `rg_agentic_chat`. This ensures consistent provider support, BYOK key resolution, and fallback behavior across the platform.

**Resolution order** (via `rg_llm.build_provider_chain()`):

1. **User's preferred provider** (from `model_id`) — BYOK key first, then platform key
2. **Fallback chain**: OpenAI → Anthropic → Groq → Google → DeepSeek → Mistral (each with BYOK → platform dual-key)
3. **Local Ollama** (when `local_llm` is provided): registered as a temporary `ProviderConfig`, tried first. Falls back to cloud if unreachable.

**BYOK key fetch**: `GET /api-keys/user/{user_id}` on `auth_service` — returns `decrypted_key` for each provider. Non-LLM keys (github, figma, etc.) are filtered by provider name.

**Live fallback visualization**: Each provider attempt emits a `fallback` SSE event so the client can show the chain in real-time.

## 59 Tool Definitions (11 Categories)

All tool definitions are protected server-side and never sent to the client:

- **Core** (12) — file_read, file_write, file_edit, multi_edit, file_list, file_delete, file_move, grep_search, find_by_name, run_command, command_status, read_terminal
- **Git** (7) — git_status, git_diff, git_log, git_commit, git_push, git_pull, git_branch
- **Web** (6) — search_web, read_url_content, view_content_chunk, browser_check, browser_preview, read_browser_logs
- **Code Analysis** (8) — code_visualizer_scan, functions, trace, governance, graph, pipeline, filter, by_type
- **Interactive Terminal** (6) — terminal_create, send, read, wait, list, close
- **Planning & Memory** (6) — todo_list, ask_user, save_memory, read_memory, create_memory, code_search
- **Notebooks** (2) — read_notebook, edit_notebook
- **Visual** (2) — visualize, image_search
- **Deploy** (2) — ssh_run, deploy_web_app
- **Platform API** (2) — platform_api_search, platform_api_call (433 backend endpoints)

Smart tool selection sends only relevant categories to the LLM based on query analysis.

## Development

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

## Docker

```bash
docker build -t rg-axtention-ide .
docker run -p 8000:8000 \
  -e GROQ_API_KEY=... \
  -e ANTHROPIC_API_KEY=... \
  -e OPENAI_API_KEY=... \
  rg-axtention-ide
```

### Production (via docker-compose)

Runs as `ide_agent_service` in the unified docker-compose:

```bash
# On production server
cd /home/deploy/genesis2026_production_backend
sudo docker compose -f docker-compose.unified.yml build ide_agent_service
sudo docker compose -f docker-compose.unified.yml up -d ide_agent_service
```

Gateway routes `/api/v1/ide/*` → `ide_agent_service:8000`.

## Environment Variables

API keys are read by `rg_llm` via `ProviderConfig.env_key_name` — see `rg_llm/providers.py` for the canonical list.

| Variable | Description | Required |
|----------|------------|----------|
| `GROQ_API_KEY` | Groq platform key (comma-separated OK) | Optional |
| `ANTHROPIC_API_KEY` | Anthropic platform key | Optional |
| `OPENAI_API_KEY` | OpenAI platform key | Optional |
| `GEMINI_API_KEY` | Google Gemini platform key | Optional |
| `DEEPSEEK_API_KEY` | DeepSeek platform key | Optional |
| `MISTRAL_API_KEY` | Mistral platform key | Optional |
| `AUTH_URL` | Auth service URL (for BYOK key lookup) | Default: `http://auth_service:8000` |
| `PORT` | Service port | Default: `8000` |

> **Note**: Platform keys are fallbacks. Users with BYOK keys stored in `auth_service` get their own keys tried first (dual-key resolution per provider).

## Project Structure

```
app/
├── main.py              # FastAPI app, CORS, router mounting
├── config.py            # Service-level settings (PORT only)
├── llm_client.py        # Thin wrapper around rg_llm.UnifiedLLMClient + BYOK fetch
└── routers/
    ├── __init__.py
    ├── ide_agent_loop.py  # Agentic loop, tool defs, system prompt, smart selection
    └── ide_completions.py # Single-turn LLM proxy

# Volume-mounted at runtime:
/app/rg_llm/             # RG_UnifiedLLMClient — shared LLM module
```

## Related Repos

| Repo | Role |
|------|------|
| [`RG_IDE`](https://github.com/DevSwat-ResonantGenesis/RG_IDE) | VS Code fork — thin client (public) |
| [`RG_IDE_Platform`](https://github.com/DevSwat-ResonantGenesis/RG_IDE_Platform) | LOC tracking, updates, analytics |
| [`RG_DevOps_Runbook`](https://github.com/DevSwat-ResonantGenesis/RG_DevOps_Runbook) | Infrastructure documentation |

## License

Proprietary — Resonant Genesis / DevSwat. See LICENSE.txt.
