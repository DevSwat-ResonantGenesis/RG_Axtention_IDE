"""IDE Providers — Live provider status endpoint using rg_llm.BUILTIN_PROVIDERS.

Returns the same response shape as RG_Chat's /providers endpoint so the IDE
extension can consume it without changes.  The key difference: this reads
provider availability straight from rg_llm (env-var key checks + optional
latency probes) instead of depending on the Chat service.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Request

from rg_llm.providers import BUILTIN_PROVIDERS, DEFAULT_FALLBACK_ORDER
from ..llm_client import fetch_user_byok_keys

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ide", tags=["ide-providers"])

# Provider display names (override rg_llm's terse names)
_DISPLAY_NAMES: Dict[str, str] = {
    "tokenrouter": "Auto (Smart)",
    "openai": "ChatGPT",
    "anthropic": "Claude",
    "groq": "Groq",
    "google": "Gemini",
    "deepseek": "DeepSeek",
    "mistral": "Mistral",
    "together": "Together AI",
    "perplexity": "Perplexity",
    "fireworks": "Fireworks AI",
    "openrouter": "OpenRouter (100+ models)",
    "cohere": "Cohere",
    "bedrock": "AWS Bedrock",
}

# Capabilities per provider
_CAPABILITIES: Dict[str, List[str]] = {
    "tokenrouter": ["chat", "coding", "vision", "tools"],
    "openai": ["chat", "coding", "vision", "image"],
    "anthropic": ["chat", "coding", "vision"],
    "groq": ["chat", "coding"],
    "google": ["chat", "coding", "vision"],
    "deepseek": ["chat", "coding", "reasoning"],
    "mistral": ["chat", "coding"],
    "together": ["chat", "coding"],
    "perplexity": ["chat", "reasoning"],
    "fireworks": ["chat", "coding"],
    "openrouter": ["chat", "coding", "vision"],
    "cohere": ["chat"],
    "bedrock": ["chat", "coding", "vision"],
}


def _resolve_system_key(provider_id: str) -> Optional[str]:
    """Return the first non-empty system key for a provider (env vars only)."""
    cfg = BUILTIN_PROVIDERS.get(provider_id)
    if not cfg:
        return None
    env_names = []
    if cfg.env_key_name:
        env_names.append(cfg.env_key_name)
    env_names.extend(getattr(cfg, "env_key_aliases", []))
    for name in env_names:
        val = os.getenv(name, "")
        if val:
            key = val.split(",")[0].strip()
            if key:
                return key
    return None


async def _probe_latency(provider_id: str, api_key: str) -> Dict[str, Any]:
    """Quick latency check — makes a tiny chat completion call."""
    cfg = BUILTIN_PROVIDERS.get(provider_id)
    if not cfg:
        return {"available": False, "latency": None, "status": "unknown"}
    try:
        start = time.time()
        headers = {"Content-Type": "application/json"}
        test_model = cfg.default_model

        if cfg.api_type.value == "google":
            url = f"{cfg.base_url}/models/{test_model}:generateContent?key={api_key}"
            payload = {"contents": [{"parts": [{"text": "hi"}]}],
                       "generationConfig": {"maxOutputTokens": 1}}
            async with httpx.AsyncClient() as c:
                r = await c.post(url, headers=headers, json=payload, timeout=6.0)
        elif cfg.api_type.value == "anthropic":
            url = f"{cfg.base_url}/messages"
            headers.update({
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            })
            payload = {"model": "claude-3-haiku-20240307",
                       "messages": [{"role": "user", "content": "hi"}],
                       "max_tokens": 1}
            async with httpx.AsyncClient() as c:
                r = await c.post(url, headers=headers, json=payload, timeout=6.0)
        else:
            url = f"{cfg.base_url}/chat/completions"
            headers["Authorization"] = f"Bearer {api_key}"
            headers.update(cfg.headers)
            payload: dict = {"model": test_model,
                      "messages": [{"role": "user", "content": "hi"}],
                      "max_tokens": 1}
            if provider_id == "tokenrouter":
                payload.pop("max_tokens", None)
            async with httpx.AsyncClient() as c:
                r = await c.post(url, headers=headers, json=payload, timeout=8.0)

        latency = int((time.time() - start) * 1000)
        if r.status_code == 200:
            return {"available": True, "latency": latency, "status": "online"}
        elif r.status_code == 429:
            return {"available": False, "latency": latency, "status": "quota_exceeded"}
        else:
            return {"available": False, "latency": latency, "status": "error",
                    "error": r.text[:100]}
    except Exception as e:
        logger.warning(f"Latency probe {provider_id} failed: {e}")
        return {"available": False, "latency": None, "status": "offline",
                "error": str(e)[:100]}


@router.get("/providers")
async def ide_providers(request: Request):
    """Return live provider status — same shape as RG_Chat /providers."""
    auth_header = request.headers.get("authorization", "")
    auth_token = auth_header.replace("Bearer ", "") if auth_header.startswith("Bearer ") else ""
    user_id = request.headers.get("x-user-id") or ""

    # Fetch BYOK keys
    user_keys: Dict[str, str] = {}
    if user_id or auth_token:
        try:
            user_keys = await fetch_user_byok_keys(user_id or auth_token[:20], auth_token)
        except Exception:
            pass

    # Check system keys + latency for each builtin provider in parallel
    async def _check(pid: str):
        sys_key = _resolve_system_key(pid)
        byok_key = user_keys.get(pid, "")
        key = sys_key or byok_key
        if key:
            status = await _probe_latency(pid, key)
        else:
            status = {"available": False, "latency": None, "status": "byok_only"}
        return pid, sys_key, byok_key, status

    results = await asyncio.gather(*[_check(pid) for pid in BUILTIN_PROVIDERS])

    # Provider key alias map (to match Chat's format)
    key_map = {"openai": "openai", "anthropic": "anthropic", "google": "google",
               "groq": "groq"}

    providers = []
    for pid, sys_key, byok_key, status in results:
        cfg = BUILTIN_PROVIDERS[pid]
        provider_key = key_map.get(pid, pid)
        has_user_key = bool(byok_key)
        is_byok_only = not bool(sys_key)

        providers.append({
            "id": pid,
            "provider_key": provider_key,
            "name": _DISPLAY_NAMES.get(pid, cfg.name),
            "available": status["available"] or has_user_key,
            "has_user_key": has_user_key,
            "uses_credits": not has_user_key and not is_byok_only,
            "model": cfg.default_model,
            "models": list(cfg.models),
            "description": f"{cfg.default_model} - {status['status']}",
            "capabilities": _CAPABILITIES.get(pid, ["chat"]),
            "latency": status.get("latency"),
            "status": status["status"],
            "byok_only": is_byok_only,
        })

    # Sort: follow DEFAULT_FALLBACK_ORDER, online first
    order = {pid: i for i, pid in enumerate(DEFAULT_FALLBACK_ORDER)}
    providers.sort(key=lambda p: (
        0 if p["status"] == "online" else 1,
        order.get(p["id"], 99),
    ))

    return {
        "providers": providers,
        "default": "auto",
        "fallback_chain": [p["id"] for p in providers if p["available"]],
    }
