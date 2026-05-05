"""RG_Axtention_IDE — Standalone server-side orchestration for Resonant IDE.

This service runs the agentic loop (LLM calls, tool selection, system prompt,
message history, retries) server-side. The IDE extension is a thin client that
only renders UI and executes tools locally on the user's machine.

Endpoints:
  POST /api/v1/ide/agent-stream           — Full agentic loop (SSE)
  POST /api/v1/ide/agent-stream/{sid}/tool-results — Client posts tool results
  POST /api/v1/ide/completions            — Single-turn LLM proxy (SSE)
  GET  /api/v1/ide/providers              — Live provider status (rg_llm)
  GET  /health                            — Health check
"""
from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routers import ide_agent_loop_router, ide_completions_router, ide_providers_router
from .pty_stream import router as pty_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)

app = FastAPI(
    title="RG_Axtention_IDE",
    description="Server-side agentic orchestration for Resonant IDE",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount routers under /api/v1
app.include_router(ide_agent_loop_router, prefix="/api/v1")
app.include_router(ide_completions_router, prefix="/api/v1")
app.include_router(ide_providers_router, prefix="/api/v1")
app.include_router(pty_router, prefix="/api/v1")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "rg-axtention-ide"}


if __name__ == "__main__":
    import uvicorn
    from .config import PORT
    uvicorn.run("app.main:app", host="0.0.0.0", port=PORT, reload=True)
