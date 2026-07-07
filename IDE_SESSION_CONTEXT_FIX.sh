#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# IDE SESSION CONTEXT FIX — Persistent Conversation State
# ═══════════════════════════════════════════════════════════════════
# Status: IMPLEMENTED — Pending deploy
# Date: 2026-05-01
#
# PROBLEM:
# IDE extension lost ALL tool context between user messages. Every new
# message triggered fresh file reads, searches, and analysis because:
#
# 1. Server created fresh AgentSession per request — deleted on completion
#    → file_read results, grep outputs, command results all vanished
#
# 2. Client stripped tool context from history sent to server:
#    - Tool call labels (> ⚡ Read file.py) → STRIPPED
#    - Code blocks (file contents, grep results) → STRIPPED
#    - Assistant text → truncated to 800 chars
#
# 3. chatViewProvider.ts called /completions with stream:false but server
#    ALWAYS returned SSE → JSON.parse crashed → sidebar chat 100% broken
#
# ROOT CAUSE: No conversation persistence across requests.
# In Windsurf/Cascade, the FULL conversation (including all tool calls
# and results) is maintained across messages. Our server created fresh
# messages[] on every request.
#
# ═══════════════════════════════════════════════════════════════════
# FIXES APPLIED:
# ═══════════════════════════════════════════════════════════════════
#
# FIX 1: Server-side conversation persistence (ide_agent_loop.py)
# ---------------------------------------------------------------
# - Added ConversationState class: stores full messages[] array
#   including system prompt, user messages, assistant responses,
#   tool calls, and tool results across requests
# - Added _conversations dict (keyed by conversation_id)
# - 1 hour timeout, max 200 conversations, LRU eviction
# - Persisted to /tmp/ide_conversations.pkl for restart recovery
# - On request: if conversation_id exists, load previous messages
#   instead of building from thin client context
# - After loop: save updated messages back to conversation
# - conversation_id returned in stats SSE event
#
# FIX 2: Non-streaming /completions path (ide_completions.py)
# -----------------------------------------------------------
# - Added stream:bool=True to IDECompletionRequest
# - When stream=false: accumulate LLM chunks and return
#   OpenAI-format JSON {choices: [{message: {content, tool_calls}}]}
# - chatViewProvider.ts sends stream:false → now gets proper JSON
#   instead of unparseable SSE text
#
# FIX 3: Client conversation tracking (extension.ts)
# ---------------------------------------------------
# - Added currentConversationId module variable
# - Reset to undefined on new chat (chatContext.history.length === 0)
# - Sent in request body as conversation_id
# - Parsed from stats event response
# - New conversation command clears it
#
# FIX 4: Better context extraction (extension.ts)
# ------------------------------------------------
# - KEPT tool call labels (> ⚡ Read file.py) — they contain file
#   paths, search queries, useful for fallback context
# - Code blocks: kept but truncated to 400 chars instead of stripped
# - Assistant text truncation: 800 → 3000 chars
# - Only strip pure UI noise (LOC stats, provider chain)
# - This is FALLBACK only — server-side persistence is primary
#
# ═══════════════════════════════════════════════════════════════════
# FILES CHANGED:
# ═══════════════════════════════════════════════════════════════════
#
# RG_Axtention_IDE/app/routers/ide_agent_loop.py
#   + ConversationState class (~40 lines)
#   + _conversations dict, cleanup, save/load disk functions
#   + conversation_id field on AgentStreamRequest
#   + generate(): load/save conversation state
#   + stats event includes conversation_id
#
# RG_Axtention_IDE/app/routers/ide_completions.py
#   + stream:bool field on IDECompletionRequest
#   + Non-streaming path returning OpenAI JSON format
#   + JSONResponse import
#
# RG_IDE/extensions/resonant-ai/src/extension.ts
#   + currentConversationId variable
#   + Reset on new chat, send in request, parse from stats
#   + Better context extraction (keep tool labels, bigger limit)
#   + Clear conversation_id on newConversation command
#
# ═══════════════════════════════════════════════════════════════════
# HOW IT WORKS NOW (Cascade-like):
# ═══════════════════════════════════════════════════════════════════
#
# Message 1: User asks "analyze src/main.py"
#   → Server creates new conversation (id=abc123)
#   → Agent reads file, greps imports, runs command
#   → All messages saved to _conversations["abc123"]
#   → Stats event returns conversation_id="abc123"
#   → Client stores currentConversationId = "abc123"
#
# Message 2: User asks "now fix the bug in that function"
#   → Client sends conversation_id="abc123"
#   → Server loads _conversations["abc123"].messages
#     (includes ALL previous tool calls + file contents!)
#   → Agent already knows file contents, no re-reading needed
#   → Updates conversation with new tool calls
#   → Saves back to _conversations["abc123"]
#
# ═══════════════════════════════════════════════════════════════════
# DEPLOY:
# rsync -avz RG_Axtention_IDE/ deploy@resonant.dev-swat.com:/home/deploy/RG_Axtention_IDE/
# ssh deploy@resonant.dev-swat.com "cd /home/deploy && docker-compose -f docker-compose.unified.yml up -d --build ide_service"
# ═══════════════════════════════════════════════════════════════════
