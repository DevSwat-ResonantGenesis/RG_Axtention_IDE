"""Environment configuration for RG_Axtention_IDE service."""
from __future__ import annotations

import os


# LLM Provider API Keys (from environment)
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
MISTRAL_API_KEY = os.getenv("MISTRAL_API_KEY", "")

# Provider endpoints
PROVIDER_URLS = {
    "openai": "https://api.openai.com/v1/chat/completions",
    "anthropic": "https://api.anthropic.com/v1/messages",
    "groq": "https://api.groq.com/openai/v1/chat/completions",
    "google": "https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent",
    "deepseek": "https://api.deepseek.com/v1/chat/completions",
    "mistral": "https://api.mistral.ai/v1/chat/completions",
}

# Default models per provider
PROVIDER_DEFAULT_MODELS = {
    "openai": "gpt-4o",
    "anthropic": "claude-sonnet-4-20250514",
    "groq": "llama-3.3-70b-versatile",
    "google": "gemini-2.0-flash",
    "deepseek": "deepseek-chat",
    "mistral": "mistral-large-latest",
}

# Platform keys (keyed by provider name)
PLATFORM_KEYS = {
    "openai": OPENAI_API_KEY,
    "anthropic": ANTHROPIC_API_KEY,
    "groq": GROQ_API_KEY,
    "google": GOOGLE_API_KEY,
    "deepseek": DEEPSEEK_API_KEY,
    "mistral": MISTRAL_API_KEY,
}

# Fallback order when a provider's key is missing or errors
FALLBACK_ORDER = ["groq", "anthropic", "openai", "deepseek", "mistral", "google"]

# Auth service URL (for fetching user BYOK keys)
AUTH_URL = os.getenv("AUTH_URL", "http://auth-service:8000")

# Service port
PORT = int(os.getenv("PORT", "8000"))
