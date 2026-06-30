"""IDE Completions — Streaming LLM proxy for inline completions and single-turn calls.

This is a simpler endpoint than agent-stream: one LLM call, streamed back.
Used for inline code completions and non-agentic chat.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from ..llm_client import call_llm_streaming, fetch_user_byok_keys

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ide", tags=["ide-completions"])


class IDECompletionRequest(BaseModel):
    messages: List[Dict[str, Any]]
    tools: Optional[List[Dict[str, Any]]] = None
    model: str = ""
    preferred_provider: str = ""
    temperature: float = 0.7
    max_tokens: int = 16384
    stream: bool = True


@router.post("/completions")
async def ide_completions(
    request_body: IDECompletionRequest,
    request: Request,
):
    """Single-turn LLM call. Returns SSE (stream=true) or OpenAI-format JSON (stream=false)."""
    auth_header = request.headers.get("authorization", "")
    auth_token = auth_header.replace("Bearer ", "") if auth_header.startswith("Bearer ") else ""
    user_id = request.headers.get("x-user-id") or auth_token[:20] or ""
    if not auth_token and not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")

    user_keys = await fetch_user_byok_keys(user_id, auth_token)

    # ── Non-streaming path: accumulate and return OpenAI-format JSON ──
    if not request_body.stream:
        content = ""
        tool_calls = []
        usage = {}
        provider = ""
        model = ""
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
                    content += chunk.content or ""
                elif chunk.event == "tool_calls":
                    tool_calls = chunk.tool_calls or []
                elif chunk.event == "done":
                    usage = chunk.usage or {}
                    provider = chunk.provider or ""
                    model = chunk.model or ""
                elif chunk.event == "error":
                    return JSONResponse(
                        status_code=500,
                        content={"error": chunk.error},
                    )
        except Exception as e:
            logger.error(f"IDE completions error: {e}", exc_info=True)
            return JSONResponse(
                status_code=500,
                content={"error": str(e)},
            )

        message: Dict[str, Any] = {"role": "assistant", "content": content or None}
        if tool_calls:
            message["tool_calls"] = tool_calls
        return JSONResponse(content={
            "choices": [{"message": message}],
            "usage": usage,
            "provider": provider,
            "model": model,
        })

    # ── Streaming path: SSE events ──
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
