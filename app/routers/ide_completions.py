"""IDE Completions — Streaming LLM proxy for inline completions and single-turn calls.

This is a simpler endpoint than agent-stream: one LLM call, streamed back.
Used for inline code completions and non-agentic chat.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..llm_client import call_llm_streaming, fetch_user_byok_keys

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ide", tags=["ide-completions"])


class IDECompletionRequest(BaseModel):
    messages: List[Dict[str, Any]]
    tools: Optional[List[Dict[str, Any]]] = None
    model: str = "llama-3.3-70b-versatile"
    preferred_provider: str = "groq"
    temperature: float = 0.7
    max_tokens: int = 16384


@router.post("/completions")
async def ide_completions(
    request_body: IDECompletionRequest,
    request: Request,
):
    """Single-turn streaming LLM call. Returns SSE with chunk/tool_calls/done/error events."""
    auth_header = request.headers.get("authorization", "")
    auth_token = auth_header.replace("Bearer ", "") if auth_header.startswith("Bearer ") else ""
    user_id = request.headers.get("x-user-id") or auth_token[:20] or ""
    if not auth_token and not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")

    user_keys = await fetch_user_byok_keys(user_id, auth_token)

    async def generate():
        try:
            async for chunk in call_llm_streaming(
                messages=request_body.messages,
                preferred_provider=request_body.preferred_provider,
                preferred_model=request_body.model,
                user_keys=user_keys,
                tools=request_body.tools,
                temperature=request_body.temperature,
                max_tokens=request_body.max_tokens,
            ):
                if chunk.event == "chunk":
                    yield f"event: chunk\ndata: {json.dumps({'content': chunk.content})}\n\n"

                elif chunk.event == "tool_calls":
                    yield f"event: tool_calls\ndata: {json.dumps({'tool_calls': chunk.tool_calls})}\n\n"

                elif chunk.event == "done":
                    yield f"event: done\ndata: {json.dumps({'usage': chunk.usage, 'provider': chunk.provider, 'model': chunk.model})}\n\n"

                elif chunk.event == "error":
                    yield f"event: error\ndata: {json.dumps({'error': chunk.error})}\n\n"

        except Exception as e:
            logger.error(f"IDE completions error: {e}", exc_info=True)
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
