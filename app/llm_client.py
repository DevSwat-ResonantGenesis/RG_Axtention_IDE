"""Direct LLM provider calls — zero internal dependencies.

Supports OpenAI-compatible (OpenAI, Groq, DeepSeek, Mistral), Anthropic, and Google.
Handles streaming with tool calls for the agentic loop.
"""
from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

import httpx

from .config import (
    AUTH_URL,
    FALLBACK_ORDER,
    PLATFORM_KEYS,
    PROVIDER_DEFAULT_MODELS,
    PROVIDER_URLS,
)

logger = logging.getLogger(__name__)


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


def resolve_api_key(provider: str, user_keys: Dict[str, str]) -> str:
    """Resolve API key: user BYOK → platform key → empty."""
    return user_keys.get(provider, "") or PLATFORM_KEYS.get(provider, "")


def resolve_provider_chain(
    preferred: str,
    user_keys: Dict[str, str],
) -> List[Tuple[str, str]]:
    """Return ordered list of (provider, api_key) to try."""
    chain: List[Tuple[str, str]] = []
    # Preferred provider first
    key = resolve_api_key(preferred, user_keys)
    if key:
        chain.append((preferred, key))
    # Then fallback order
    for p in FALLBACK_ORDER:
        if p == preferred:
            continue
        k = resolve_api_key(p, user_keys)
        if k:
            chain.append((p, k))
    return chain


# ── Streaming LLM call ──

class LLMStreamChunk:
    """A chunk from the LLM stream."""
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


async def stream_llm(
    messages: List[Dict[str, Any]],
    provider: str,
    model: str,
    api_key: str,
    tools: Optional[List[Dict[str, Any]]] = None,
    temperature: float = 0.7,
    max_tokens: int = 16384,
) -> AsyncIterator[LLMStreamChunk]:
    """Stream LLM response from any supported provider."""

    if provider == "anthropic":
        async for chunk in _stream_anthropic(messages, model, api_key, tools, temperature, max_tokens):
            yield chunk
    else:
        # OpenAI-compatible: openai, groq, deepseek, mistral
        url = PROVIDER_URLS.get(provider, PROVIDER_URLS["openai"])
        async for chunk in _stream_openai_compatible(url, messages, model, api_key, tools, temperature, max_tokens, provider):
            yield chunk


async def _stream_openai_compatible(
    url: str,
    messages: List[Dict[str, Any]],
    model: str,
    api_key: str,
    tools: Optional[List[Dict[str, Any]]],
    temperature: float,
    max_tokens: int,
    provider: str,
) -> AsyncIterator[LLMStreamChunk]:
    """Stream from OpenAI-compatible API (OpenAI, Groq, DeepSeek, Mistral)."""
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    body: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"

    accumulated_tool_calls: Dict[int, Dict[str, Any]] = {}
    content = ""
    usage = None

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
            async with client.stream("POST", url, headers=headers, json=body) as resp:
                if resp.status_code != 200:
                    error_body = await resp.aread()
                    yield LLMStreamChunk(event="error", error=f"{resp.status_code}: {error_body.decode()[:500]}")
                    return

                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue

                    if "usage" in chunk:
                        usage = chunk["usage"]

                    choices = chunk.get("choices", [])
                    if not choices:
                        continue

                    delta = choices[0].get("delta", {})

                    # Text content
                    if delta.get("content"):
                        content += delta["content"]
                        yield LLMStreamChunk(event="chunk", content=delta["content"])

                    # Tool calls (streamed incrementally)
                    if delta.get("tool_calls"):
                        for tc_delta in delta["tool_calls"]:
                            idx = tc_delta.get("index", 0)
                            if idx not in accumulated_tool_calls:
                                accumulated_tool_calls[idx] = {
                                    "id": tc_delta.get("id", f"call_{idx}"),
                                    "type": "function",
                                    "function": {"name": "", "arguments": ""},
                                }
                            tc = accumulated_tool_calls[idx]
                            if tc_delta.get("id"):
                                tc["id"] = tc_delta["id"]
                            fn = tc_delta.get("function", {})
                            if fn.get("name"):
                                tc["function"]["name"] = fn["name"]
                            if fn.get("arguments"):
                                tc["function"]["arguments"] += fn["arguments"]

        # Emit accumulated tool calls
        if accumulated_tool_calls:
            tool_calls_list = [accumulated_tool_calls[i] for i in sorted(accumulated_tool_calls.keys())]
            yield LLMStreamChunk(event="tool_calls", tool_calls=tool_calls_list)

        yield LLMStreamChunk(event="done", usage=usage, provider=provider, model=model)

    except Exception as e:
        yield LLMStreamChunk(event="error", error=str(e))


async def _stream_anthropic(
    messages: List[Dict[str, Any]],
    model: str,
    api_key: str,
    tools: Optional[List[Dict[str, Any]]],
    temperature: float,
    max_tokens: int,
) -> AsyncIterator[LLMStreamChunk]:
    """Stream from Anthropic Messages API (Claude)."""
    url = PROVIDER_URLS["anthropic"]
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }

    # Convert OpenAI-format messages to Anthropic format
    system_text = ""
    anthropic_messages = []
    for m in messages:
        if m["role"] == "system":
            system_text = m.get("content", "")
        elif m["role"] == "assistant":
            # Handle tool_calls in assistant messages
            if m.get("tool_calls"):
                content_blocks = []
                if m.get("content"):
                    content_blocks.append({"type": "text", "text": m["content"]})
                for tc in m["tool_calls"]:
                    fn = tc.get("function", {})
                    args_str = fn.get("arguments", "{}")
                    try:
                        args = json.loads(args_str) if isinstance(args_str, str) else args_str
                    except json.JSONDecodeError:
                        args = {}
                    content_blocks.append({
                        "type": "tool_use",
                        "id": tc.get("id", ""),
                        "name": fn.get("name", ""),
                        "input": args,
                    })
                anthropic_messages.append({"role": "assistant", "content": content_blocks})
            else:
                anthropic_messages.append({"role": "assistant", "content": m.get("content", "")})
        elif m["role"] == "tool":
            anthropic_messages.append({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": m.get("tool_call_id", ""),
                    "content": m.get("content", ""),
                }],
            })
        elif m["role"] == "user":
            anthropic_messages.append({"role": "user", "content": m.get("content", "")})

    body: Dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": anthropic_messages,
        "stream": True,
    }
    if system_text:
        body["system"] = system_text

    # Convert OpenAI tool format to Anthropic tool format
    if tools:
        anthropic_tools = []
        for t in tools:
            fn = t.get("function", {})
            anthropic_tools.append({
                "name": fn.get("name", ""),
                "description": fn.get("description", ""),
                "input_schema": fn.get("parameters", {"type": "object", "properties": {}}),
            })
        body["tools"] = anthropic_tools

    content = ""
    current_tool_use: Optional[Dict[str, Any]] = None
    tool_calls: List[Dict[str, Any]] = []
    usage = None

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
            async with client.stream("POST", url, headers=headers, json=body) as resp:
                if resp.status_code != 200:
                    error_body = await resp.aread()
                    yield LLMStreamChunk(event="error", error=f"{resp.status_code}: {error_body.decode()[:500]}")
                    return

                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    try:
                        event_data = json.loads(line[6:])
                    except json.JSONDecodeError:
                        continue

                    event_type = event_data.get("type", "")

                    if event_type == "content_block_start":
                        block = event_data.get("content_block", {})
                        if block.get("type") == "tool_use":
                            current_tool_use = {
                                "id": block.get("id", ""),
                                "type": "function",
                                "function": {
                                    "name": block.get("name", ""),
                                    "arguments": "",
                                },
                            }

                    elif event_type == "content_block_delta":
                        delta = event_data.get("delta", {})
                        if delta.get("type") == "text_delta":
                            text = delta.get("text", "")
                            content += text
                            yield LLMStreamChunk(event="chunk", content=text)
                        elif delta.get("type") == "input_json_delta" and current_tool_use:
                            current_tool_use["function"]["arguments"] += delta.get("partial_json", "")

                    elif event_type == "content_block_stop":
                        if current_tool_use:
                            tool_calls.append(current_tool_use)
                            current_tool_use = None

                    elif event_type == "message_delta":
                        u = event_data.get("usage", {})
                        if u:
                            usage = u

                    elif event_type == "message_start":
                        u = event_data.get("message", {}).get("usage", {})
                        if u:
                            usage = u

        if tool_calls:
            yield LLMStreamChunk(event="tool_calls", tool_calls=tool_calls)

        yield LLMStreamChunk(event="done", usage=usage, provider="anthropic", model=model)

    except Exception as e:
        yield LLMStreamChunk(event="error", error=str(e))


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

    For Ollama (local LLM): uses the URL from local_llm config to call the
    user's local Ollama instance (OpenAI-compatible API). If unreachable,
    falls back to cloud providers.
    """
    # Handle local Ollama provider
    if preferred_provider == "ollama" and local_llm:
        ollama_url = local_llm.get("url", "http://localhost:11434")
        ollama_model = local_llm.get("model", preferred_model)
        ollama_ctx = local_llm.get("context_length", 32768)
        api_url = f"{ollama_url.rstrip('/')}/v1/chat/completions"
        logger.info(f"Calling local Ollama: {api_url} model={ollama_model}")
        try:
            async for chunk in _stream_openai_compatible(
                api_url, messages, ollama_model, "ollama",
                tools, temperature, min(max_tokens, ollama_ctx), "ollama",
            ):
                if chunk.event == "error":
                    logger.warning(f"Local Ollama failed: {chunk.error}, falling back to cloud...")
                    break
                yield chunk
                if chunk.event == "done":
                    return
        except Exception as e:
            logger.warning(f"Local Ollama exception: {e}, falling back to cloud...")

    chain = resolve_provider_chain(preferred_provider, user_keys)
    if not chain:
        yield LLMStreamChunk(event="error", error="No API keys configured for any provider")
        return

    last_error = ""
    for provider, api_key in chain:
        model = preferred_model if provider == preferred_provider else PROVIDER_DEFAULT_MODELS.get(provider, preferred_model)
        try:
            async for chunk in stream_llm(messages, provider, model, api_key, tools, temperature, max_tokens):
                if chunk.event == "error" and provider != chain[-1][0]:
                    last_error = chunk.error
                    logger.warning(f"Provider {provider} failed: {chunk.error}, trying next...")
                    break
                yield chunk
                if chunk.event in ("done", "error"):
                    return
        except Exception as e:
            last_error = str(e)
            logger.warning(f"Provider {provider} exception: {e}, trying next...")
            continue

    yield LLMStreamChunk(event="error", error=f"All providers failed. Last error: {last_error}")
