"""Environment configuration for RG_Axtention_IDE service.

All LLM provider config (keys, URLs, models, fallback) now comes from
the shared rg_llm module (RG_UnifiedLLMClient). This file only keeps
service-level settings.
"""
from __future__ import annotations

import os

# Service port
PORT = int(os.getenv("PORT", "8000"))
