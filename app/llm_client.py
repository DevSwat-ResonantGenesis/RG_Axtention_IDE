"""LLM client — thin wrapper around rg_llm.UnifiedLLMClient.

Uses the shared RG_UnifiedLLMClient module for all LLM calls, BYOK key
resolution, provider fallback, and streaming. This is the same module used
by chat_service, agent_engine_service, and rg_agentic_chat.
"""
from __future__ import annotations

import logging
import os
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

from rg_llm import (
    LLMRequest,
    LLMStreamEvent,
    ProviderConfig,
    ProviderType,
    UnifiedLLMClient,
)
from rg_llm.models import StreamEventType

logger = logging.getLogger(__name__)

AUTH_URL = os.getenv("AUTH_URL", "http://auth_service:8000")

# ── Shared client instance ──

_client: Optional[UnifiedLLMClient] = None


def _get_client() -> UnifiedLLMClient:
    """Lazy-init the shared UnifiedLLMClient."""
    global _client
    if _client is None:
        _client = UnifiedLLMClient()
    return _client


# ── BYOK key fetching ──

async def fetch_user_byok_keys(user_id: str, auth_token: str = "") -> Dict[str, str]:
    """Fetch user's Bring-Your-Own-Key keys from auth service."""
    if not user_id:
        return {}
    try:
        headers = {"Authorization": f"Bearer {auth_token}"} if auth_token else {}
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"{AUTH_URL}/auth/user/api-keys",
                headers={**headers, "x-user-id": user_id},
            )
            if resp.status_code == 200:
                data = resp.json()
                keys = {}
                for item in data if isinstance(data, list) else data.get("keys", []):
                    provider = item.get("provider", "").lower()
                    key = item.get("api_key") or item.get("key") or ""
                    if provider and key:
                        keys[provider] = key
                return keys
    except Exception as e:
        logger.warning(f"BYOK key lookup failed: {e}")
    return {}


# ── Compatibility shim ──

class LLMStreamChunk:
    """A chunk from the LLM stream — compatibility wrapper around rg_llm events."""
    def __init__(
        self,
        event: str,  # "chunk", "tool_calls", "done", "error"
        content: str = "",
        tool_calls: Optional[List[Dict[str, Any]]] = None,
        usage: Optional[Dict[str, Any]] = None,
        provider: str = "",
        model: str = "",
        error: str = "",
    ):
        self.event = event
        self.content = content
        self.tool_calls = tool_calls
        self.usage = usage
        self.provider = provider
        self.model = model
        self.error = error


def _toolcall_to_openai_dict(tc) -> Dict[str, Any]:
    """Convert rg_llm.ToolCall to OpenAI-format dict for the agent loop."""
    return {
        "id": tc.id,
        "type": "function",
        "function": {
            "name": tc.name,
            "arguments": tc.arguments,
        },
    }


def _event_to_chunk(event: LLMStreamEvent) -> LLMStreamChunk:
    """Convert rg_llm.LLMStreamEvent → LLMStreamChunk for backward compat."""
    if event.event == StreamEventType.CHUNK:
        return LLMStreamChunk(event="chunk", content=event.content)
    elif event.event == StreamEventType.TOOL_CALLS:
        return LLMStreamChunk(
            event="tool_calls",
            tool_calls=[_toolcall_to_openai_dict(tc) for tc in event.tool_calls],
        )
    elif event.event == StreamEventType.DONE:
        return LLMStreamChunk(
            event="done",
            usage=event.usage or {},
            provider=event.provider,
            model=event.model,
        )
    elif event.event == StreamEventType.ERROR:
        return LLMStreamChunk(event="error", error=event.error)
    elif event.event == StreamEventType.PROVIDER:
        # Provider announcement — skip, not used by agent loop
        return None
    return None


# ── Main streaming call ──

async def call_llm_streaming(
    messages: List[Dict[str, Any]],
    preferred_provider: str,
    preferred_model: str,
    user_keys: Dict[str, str],
    tools: Optional[List[Dict[str, Any]]] = None,
    temperature: float = 0.7,
    max_tokens: int = 16384,
    local_llm: Optional[Dict[str, Any]] = None,
) -> AsyncIterator[LLMStreamChunk]:
    """Call LLM with automatic fallback through provider chain.

    Delegates to rg_llm.UnifiedLLMClient.stream() which handles BYOK
    dual-key resolution, provider fallback, and streaming for all providers.

    For Ollama (local LLM): registers a temporary provider and tries it
    first. If unreachable, falls back to cloud providers.
    """
    client = _get_client()

    # Handle local Ollama provider — register as temporary provider
    if preferred_provider == "ollama" and local_llm:
        ollama_url = local_llm.get("url", "http://localhost:11434")
        ollama_model = local_llm.get("model", preferred_model)
        ollama_ctx = local_llm.get("context_length", 32768)
        api_url = f"{ollama_url.rstrip('/')}/v1"
        logger.info(f"Registering local Ollama provider: {api_url} model={ollama_model}")
        client.add_provider(ProviderConfig(
            id="ollama",
            name="Local Ollama",
            api_type=ProviderType.OPENAI_COMPATIBLE,
            base_url=api_url,
            default_model=ollama_model,
            models=[ollama_model],
            supports_tools=True,
            supports_json_mode=False,
            max_tokens=ollama_ctx,
        ))
        # Try Ollama first, then fall back to preferred cloud provider
        request = LLMRequest(
            messages=messages,
            provider="ollama",
            model=ollama_model,
            temperature=temperature,
            max_tokens=min(max_tokens, ollama_ctx),
            tools=tools,
            stream=True,
        )
        try:
            async for event in client.stream(request, user_keys=user_keys):
                chunk = _event_to_chunk(event)
                if chunk is None:
                    continue
                if chunk.event == "error":
                    logger.warning(f"Local Ollama failed: {chunk.error}, falling back to cloud...")
                    break
                yield chunk
                if chunk.event == "done":
                    return
        except Exception as e:
            logger.warning(f"Local Ollama exception: {e}, falling back to cloud...")

    # Cloud provider call via rg_llm
    request = LLMRequest(
        messages=messages,
        provider=preferred_provider,
        model=preferred_model,
        temperature=temperature,
        max_tokens=max_tokens,
        tools=tools,
        stream=True,
    )

    async for event in client.stream(request, user_keys=user_keys):
        chunk = _event_to_chunk(event)
        if chunk is not None:
            yield chunk
            if chunk.event in ("done", "error"):
                return
