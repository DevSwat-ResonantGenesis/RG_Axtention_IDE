# RG_Axtention_IDE

**Server-side agentic orchestration for Resonant IDE** by Resonant Genesis.

## Overview

This is the **backend brain** for Resonant IDE. It runs the full agentic loop server-side:
LLM calls, tool selection, system prompt, message history, and retry logic.

The IDE extension (in `RG_IDE`) is a thin client that only renders UI and executes
tools locally on the user's machine. All orchestration intelligence stays here on the server.

## Architecture

```
User's Machine (RG_IDE extension)          Server (this service)
┌─────────────────────────┐                ┌──────────────────────────┐
│  Thin client:           │  SSE stream    │  Agentic loop:           │
│  - Renders UI           │◄──────────────│  - System prompt          │
│  - Executes tools       │                │  - Tool definitions       │
│  - POSTs tool results   │───────────────►│  - Tool selection         │
│                         │                │  - LLM calls (multi-prov) │
│  NO orchestration code  │                │  - Message history        │
│  NO tool definitions    │                │  - Retry + rate limit     │
│  NO system prompt       │                │  - BYOK key resolution    │
└─────────────────────────┘                └──────────────────────────┘
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/ide/agent-stream` | Full agentic loop (SSE) |
| POST | `/api/v1/ide/agent-stream/{sid}/tool-results` | Client posts tool results |
| POST | `/api/v1/ide/completions` | Single-turn LLM proxy (SSE) |
| GET  | `/health` | Health check |

## SSE Protocol

1. Client → `POST /api/v1/ide/agent-stream` with prompt + workspace info
2. Server streams SSE events: `thinking`, `text`, `execute_tool`, `tool_done`, `stats`, `done`
3. On `execute_tool` → client runs tool locally → `POST .../tool-results`
4. Server resumes loop with results → calls LLM again → repeat until done

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

## Environment Variables

| Variable | Description | Required |
|----------|------------|----------|
| `GROQ_API_KEY` | Groq API key (primary) | Yes |
| `ANTHROPIC_API_KEY` | Anthropic API key | Optional |
| `OPENAI_API_KEY` | OpenAI API key | Optional |
| `GOOGLE_API_KEY` | Google Gemini API key | Optional |
| `DEEPSEEK_API_KEY` | DeepSeek API key | Optional |
| `MISTRAL_API_KEY` | Mistral API key | Optional |
| `AUTH_URL` | Auth service URL (for BYOK) | Optional |
| `PORT` | Service port | Default: 8000 |

## Related Repos

- **RG_IDE** — Full VS Code fork (open source, thin client)
- **RG_Chat** — Web chat backend (separate system)

## License

Proprietary — Resonant Genesis. See LICENSE.txt.
