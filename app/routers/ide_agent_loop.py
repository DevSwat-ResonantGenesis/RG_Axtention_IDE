"""IDE Agent Loop — Server-side agentic orchestration for Resonant IDE.

The agentic loop (LLM calls, tool selection, message history, retries) runs HERE
on the server. The client extension is a thin renderer + local tool executor.

Protocol:
1. Client POSTs to /ide/agent-stream with prompt + workspace info
2. Server returns SSE stream
3. Server calls LLM, streams text chunks to client
4. When LLM returns tool_calls → server sends `execute_tool` SSE events
5. Server pauses SSE and waits for client to POST tool results
6. Client executes tools locally, POSTs results to /ide/agent-stream/{sid}/tool-results
7. Server resumes loop with tool results → calls LLM again
8. Repeat until done (LLM returns text with no tool_calls)
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..llm_client import call_llm_streaming, fetch_user_byok_keys

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ide", tags=["ide-agent"])


# ── Session store ──

SESSION_TIMEOUT = 300  # 5 min
MAX_SESSIONS = 100


class AgentSession:
    def __init__(self, user_id: str, workspace_root: str):
        self.id = str(uuid.uuid4())[:12]
        self.user_id = user_id
        self.workspace_root = workspace_root
        self.tool_result_queue: asyncio.Queue = asyncio.Queue()
        self.created_at = time.time()
        self.last_activity = time.time()
        self.active = True

    def touch(self):
        self.last_activity = time.time()

    @property
    def expired(self):
        return time.time() - self.last_activity > SESSION_TIMEOUT


_sessions: Dict[str, AgentSession] = {}


def _cleanup_sessions():
    expired = [sid for sid, s in _sessions.items() if s.expired]
    for sid in expired:
        _sessions.pop(sid, None)


def _get_or_fail(session_id: str) -> AgentSession:
    _cleanup_sessions()
    session = _sessions.get(session_id)
    if not session or not session.active:
        raise HTTPException(status_code=404, detail="Session not found or expired")
    session.touch()
    return session


# ── Request / Response models ──

class AgentStreamRequest(BaseModel):
    prompt: str
    workspace_root: str
    active_file: Optional[str] = None
    model_id: Optional[str] = None  # e.g. "resonant-anthropic-claude-sonnet-4-20250514"
    context: Optional[List[Dict[str, Any]]] = None
    max_loops: int = 25
    local_llm: Optional[Dict[str, Any]] = None  # {url, model, context_length} — for Ollama


class ToolResultRequest(BaseModel):
    tool_call_id: str
    name: str
    result: str


# ── Tool definitions (protected server-side IP) ──

def _build_tool_definitions() -> List[Dict[str, Any]]:
    """All tool definitions — these never leave the server."""
    F = "function"
    tools = []

    # CORE (always sent)
    tools.extend([
        {"type": F, "function": {"name": "file_read", "description": "Read file. Use offset/limit for large files. Returns numbered lines.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "offset": {"type": "number"}, "limit": {"type": "number"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "file_write", "description": "Create or overwrite file. Auto-creates parent directories.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}},
        {"type": F, "function": {"name": "file_edit", "description": "Replace exact unique string in file. Set replace_all=true to replace all occurrences.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"}, "replace_all": {"type": "boolean"}, "explanation": {"type": "string"}}, "required": ["path", "old_string", "new_string"]}}},
        {"type": F, "function": {"name": "multi_edit", "description": "Atomic batch edits on one file. All edits succeed or none applied.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "edits": {"type": "array", "items": {"type": "object", "properties": {"old_string": {"type": "string"}, "new_string": {"type": "string"}, "replace_all": {"type": "boolean"}}, "required": ["old_string", "new_string"]}}, "explanation": {"type": "string"}}, "required": ["path", "edits"]}}},
        {"type": F, "function": {"name": "file_list", "description": "List directory contents with type and path.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "grep_search", "description": "Search text pattern in files. Uses ripgrep (fast) with grep fallback.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "pattern": {"type": "string"}, "include": {"type": "string"}, "case_sensitive": {"type": "boolean"}, "match_per_line": {"type": "boolean"}, "fixed_strings": {"type": "boolean"}}, "required": ["path", "pattern"]}}},
        {"type": F, "function": {"name": "find_by_name", "description": "Find files by name glob. Uses fd (fast) with find fallback.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "pattern": {"type": "string"}, "type": {"type": "string"}, "max_depth": {"type": "number"}, "extensions": {"type": "array", "items": {"type": "string"}}, "excludes": {"type": "array", "items": {"type": "string"}}, "full_path": {"type": "boolean"}}, "required": ["path", "pattern"]}}},
        {"type": F, "function": {"name": "run_command", "description": "Run shell command. Set blocking=false for long-running processes.", "parameters": {"type": "object", "properties": {"command": {"type": "string"}, "cwd": {"type": "string"}, "blocking": {"type": "boolean"}, "wait_ms_before_async": {"type": "number"}, "safe_to_auto_run": {"type": "boolean"}}, "required": ["command"]}}},
        {"type": F, "function": {"name": "command_status", "description": "Check status of background command by ID.", "parameters": {"type": "object", "properties": {"command_id": {"type": "string"}, "wait_seconds": {"type": "number"}, "output_character_count": {"type": "number"}}, "required": ["command_id"]}}},
        {"type": F, "function": {"name": "read_terminal", "description": "Read output from a terminal session.", "parameters": {"type": "object", "properties": {"process_id": {"type": "string"}, "name": {"type": "string"}}, "required": []}}},
        {"type": F, "function": {"name": "file_delete", "description": "Delete file or directory recursively.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "file_move", "description": "Move or rename file/directory.", "parameters": {"type": "object", "properties": {"source": {"type": "string"}, "destination": {"type": "string"}}, "required": ["source", "destination"]}}},
    ])

    # GIT
    tools.extend([
        {"type": F, "function": {"name": "git_status", "description": "Working tree status.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "git_diff", "description": "Show diff.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "staged": {"type": "boolean"}, "file": {"type": "string"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "git_log", "description": "Commit log.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "count": {"type": "number"}, "file": {"type": "string"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "git_commit", "description": "Stage and commit.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "message": {"type": "string"}, "files": {"type": "array", "items": {"type": "string"}}}, "required": ["path", "message"]}}},
        {"type": F, "function": {"name": "git_push", "description": "Push to remote.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "remote": {"type": "string"}, "branch": {"type": "string"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "git_pull", "description": "Pull from remote.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "remote": {"type": "string"}, "branch": {"type": "string"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "git_branch", "description": "List/create/switch branches.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "action": {"type": "string"}, "name": {"type": "string"}}, "required": ["path"]}}},
    ])

    # WEB
    tools.extend([
        {"type": F, "function": {"name": "search_web", "description": "Web search. Use domain to filter.", "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "domain": {"type": "string"}}, "required": ["query"]}}},
        {"type": F, "function": {"name": "read_url_content", "description": "Fetch URL text content.", "parameters": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}}},
        {"type": F, "function": {"name": "view_content_chunk", "description": "Read chunk of previously fetched URL.", "parameters": {"type": "object", "properties": {"document_id": {"type": "string"}, "position": {"type": "number"}}, "required": ["document_id", "position"]}}},
        {"type": F, "function": {"name": "browser_check", "description": "Check URL reachability and content.", "parameters": {"type": "object", "properties": {"url": {"type": "string"}, "expect": {"type": "string"}, "timeout_seconds": {"type": "number"}}, "required": ["url"]}}},
        {"type": F, "function": {"name": "browser_preview", "description": "Open URL in VS Code webview.", "parameters": {"type": "object", "properties": {"url": {"type": "string"}, "name": {"type": "string"}}, "required": ["url"]}}},
        {"type": F, "function": {"name": "read_browser_logs", "description": "Read console logs from browser preview.", "parameters": {"type": "object", "properties": {"preview_id": {"type": "string"}}, "required": ["preview_id"]}}},
    ])

    # CODE ANALYSIS
    tools.extend([
        {"type": F, "function": {"name": "code_visualizer_scan", "description": "AST-scan project: services, functions, classes, endpoints, imports.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "code_visualizer_functions", "description": "List all functions and API endpoints.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "code_visualizer_trace", "description": "Trace dependency flow from any node.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "query": {"type": "string"}, "max_depth": {"type": "number"}}, "required": ["path", "query"]}}},
        {"type": F, "function": {"name": "code_visualizer_governance", "description": "Architecture governance: drift, health score.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "drift_threshold": {"type": "number"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "code_visualizer_graph", "description": "Full dependency graph.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "code_visualizer_pipeline", "description": "Auto-detected pipeline flow.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "pipeline_name": {"type": "string"}}, "required": ["path", "pipeline_name"]}}},
        {"type": F, "function": {"name": "code_visualizer_filter", "description": "Filter graph by file, type, keyword.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "file_path": {"type": "string"}, "node_type": {"type": "string"}, "keyword": {"type": "string"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "code_visualizer_by_type", "description": "Get all nodes of a type.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "node_type": {"type": "string"}}, "required": ["path", "node_type"]}}},
    ])

    # PLANNING & MEMORY
    tools.extend([
        {"type": F, "function": {"name": "todo_list", "description": "Create/update task list.", "parameters": {"type": "object", "properties": {"todos": {"type": "array", "items": {"type": "object", "properties": {"id": {"type": "string"}, "content": {"type": "string"}, "status": {"type": "string"}, "priority": {"type": "string"}}, "required": ["id", "content", "status", "priority"]}}}, "required": ["todos"]}}},
        {"type": F, "function": {"name": "ask_user", "description": "Ask user a question with optional options.", "parameters": {"type": "object", "properties": {"question": {"type": "string"}, "options": {"type": "array", "items": {"type": "object", "properties": {"label": {"type": "string"}, "description": {"type": "string"}}}}, "allow_multiple": {"type": "boolean"}}, "required": ["question"]}}},
        {"type": F, "function": {"name": "save_memory", "description": "Save to persistent memory.", "parameters": {"type": "object", "properties": {"key": {"type": "string"}, "content": {"type": "string"}, "tags": {"type": "array", "items": {"type": "string"}}}, "required": ["key", "content"]}}},
        {"type": F, "function": {"name": "read_memory", "description": "Read memories by key, tag, or query.", "parameters": {"type": "object", "properties": {"key": {"type": "string"}, "tag": {"type": "string"}, "query": {"type": "string"}}, "required": []}}},
        {"type": F, "function": {"name": "create_memory", "description": "CRUD persistent memories.", "parameters": {"type": "object", "properties": {"action": {"type": "string"}, "title": {"type": "string"}, "content": {"type": "string"}, "tags": {"type": "array", "items": {"type": "string"}}, "id": {"type": "string"}}, "required": ["action"]}}},
        {"type": F, "function": {"name": "code_search", "description": "Multi-pass codebase search.", "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "path": {"type": "string"}}, "required": ["query"]}}},
    ])

    # INTERACTIVE TERMINAL
    tools.extend([
        {"type": F, "function": {"name": "terminal_create", "description": "Create persistent interactive terminal.", "parameters": {"type": "object", "properties": {"name": {"type": "string"}, "cwd": {"type": "string"}, "shell": {"type": "string"}}, "required": []}}},
        {"type": F, "function": {"name": "terminal_send", "description": "Send input to terminal (auto-appends Enter).", "parameters": {"type": "object", "properties": {"session_id": {"type": "string"}, "input": {"type": "string"}}, "required": ["session_id", "input"]}}},
        {"type": F, "function": {"name": "terminal_read", "description": "Read recent output from terminal.", "parameters": {"type": "object", "properties": {"session_id": {"type": "string"}, "last_n_chars": {"type": "number"}}, "required": ["session_id"]}}},
        {"type": F, "function": {"name": "terminal_wait", "description": "Wait for new terminal output.", "parameters": {"type": "object", "properties": {"session_id": {"type": "string"}, "timeout_ms": {"type": "number"}, "stable_ms": {"type": "number"}}, "required": ["session_id"]}}},
        {"type": F, "function": {"name": "terminal_list", "description": "List active terminals.", "parameters": {"type": "object", "properties": {}, "required": []}}},
        {"type": F, "function": {"name": "terminal_close", "description": "Close terminal session.", "parameters": {"type": "object", "properties": {"session_id": {"type": "string"}}, "required": ["session_id"]}}},
    ])

    # DEPLOY
    tools.extend([
        {"type": F, "function": {"name": "ssh_run", "description": "Run SSH command on remote host.", "parameters": {"type": "object", "properties": {"host": {"type": "string"}, "user": {"type": "string"}, "port": {"type": "number"}, "command": {"type": "string"}}, "required": ["host", "user", "command"]}}},
        {"type": F, "function": {"name": "deploy_web_app", "description": "Build and deploy web app.", "parameters": {"type": "object", "properties": {"project_path": {"type": "string"}, "framework": {"type": "string"}, "subdomain": {"type": "string"}}, "required": ["project_path"]}}},
    ])

    # NOTEBOOKS
    tools.extend([
        {"type": F, "function": {"name": "read_notebook", "description": "Read Jupyter notebook.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "edit_notebook", "description": "Edit notebook cell.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "cell_number": {"type": "number"}, "new_source": {"type": "string"}, "cell_type": {"type": "string"}, "edit_mode": {"type": "string"}}, "required": ["path", "cell_number", "new_source"]}}},
    ])

    # VISUAL
    tools.extend([
        {"type": F, "function": {"name": "visualize", "description": "Generate SVG/Mermaid diagram in chat.", "parameters": {"type": "object", "properties": {"title": {"type": "string"}, "svg": {"type": "string"}, "mermaid": {"type": "string"}, "width": {"type": "number"}, "height": {"type": "number"}}, "required": ["title"]}}},
        {"type": F, "function": {"name": "image_search", "description": "Search web for images.", "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "count": {"type": "number"}}, "required": ["query"]}}},
    ])

    # PLATFORM API
    tools.extend([
        {"type": F, "function": {"name": "platform_api_search", "description": "Search 450+ Resonant Genesis platform API endpoints.", "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "category": {"type": "string"}}, "required": ["query"]}}},
        {"type": F, "function": {"name": "platform_api_call", "description": "Call platform API endpoint.", "parameters": {"type": "object", "properties": {"method": {"type": "string"}, "path": {"type": "string"}, "body": {"type": "object"}}, "required": ["method", "path"]}}},
    ])

    return tools


# Cache tool definitions
_ALL_TOOLS = _build_tool_definitions()
_ALL_TOOL_NAMES = {t["function"]["name"] for t in _ALL_TOOLS}

# Tool categories for smart selection
_CORE_NAMES = {"file_read", "file_write", "file_edit", "multi_edit", "file_list",
               "grep_search", "find_by_name", "run_command", "command_status",
               "read_terminal", "file_delete", "file_move"}
_GIT_NAMES = {"git_status", "git_diff", "git_log", "git_commit", "git_push", "git_pull", "git_branch"}
_WEB_NAMES = {"search_web", "read_url_content", "view_content_chunk", "browser_check", "browser_preview", "read_browser_logs"}
_VIZ_NAMES = {n for n in _ALL_TOOL_NAMES if n.startswith("code_visualizer_")}
_PLAN_NAMES = {"todo_list", "ask_user", "save_memory", "read_memory", "create_memory", "code_search"}
_TERM_NAMES = {n for n in _ALL_TOOL_NAMES if n.startswith("terminal_")}
_DEPLOY_NAMES = {"ssh_run", "deploy_web_app"}
_NB_NAMES = {"read_notebook", "edit_notebook"}
_VIS_NAMES = {"visualize", "image_search"}
_PLAT_NAMES = {"platform_api_search", "platform_api_call"}


def _select_tools(query: str) -> List[Dict[str, Any]]:
    """Smart tool selection — only send relevant categories to LLM."""
    q = query.lower()
    names = set(_CORE_NAMES)

    if re.search(r'\b(git|commit|push|pull|branch|merge|diff|stash|rebase|log|blame)\b', q):
        names |= _GIT_NAMES
    if re.search(r'\b(http|url|web|search|browse|fetch|download|api|endpoint|curl)\b', q) or '://' in q:
        names |= _WEB_NAMES
    if re.search(r'\b(analy[sz]|visuali[sz]|architecture|structure|dependen|scan|overview|governance|dead.?code|pipeline|graph.?janitor|drift|trace.?flow|codebase|ast)', q):
        names |= _VIZ_NAMES
    if re.search(r'\b(plan|todo|task|step|remember|memory|save|note)\b', q):
        names |= _PLAN_NAMES
    if re.search(r'\b(terminal|interactive|repl|session|ssh|prompt|dev.?server|monitor)\b', q):
        names |= _TERM_NAMES
    if re.search(r'\b(deploy|build|production|release|ship|publish)\b', q):
        names |= _DEPLOY_NAMES
    if re.search(r'\b(notebook|jupyter|ipynb|cell)\b', q):
        names |= _NB_NAMES
    if re.search(r'\b(visuali[sz]|diagram|chart|svg|mermaid|image|icon|mockup)\b', q):
        names |= _VIS_NAMES
    if re.search(r'\b(platform|api|endpoint|agent|team|workflow|billing|blockchain|marketplace|invariant|simulation|hash.?sphere)\b', q):
        names |= _PLAT_NAMES
    if len(q) > 200 or re.search(r'\b(build|create|implement|refactor|fix.*bug|debug)\b', q):
        names |= _PLAN_NAMES | _VIZ_NAMES

    return [t for t in _ALL_TOOLS if t["function"]["name"] in names]


# ── System prompt (protected server-side IP) ──

def _build_system_prompt(workspace_root: str, active_file: Optional[str] = None) -> str:
    return f"""You are Resonant AI — the autonomous coding agent inside Resonant IDE by Resonant Genesis.
You are pair-programming with the user. You have full access to their filesystem and can read, write, edit, search, and run commands.
Your tools are provided via the API — use them directly. Your goal is to take action, not describe what you would do.

## Workspace
- Root: {workspace_root}{f'''
- Active file: {active_file}''' if active_file else ''}

## COMMUNICATION
- Be terse and direct. Minimize output tokens while maintaining quality and accuracy.
- Prefer concise bullet points and short paragraphs over long explanations.
- Never start with filler like "Great question!", "I'd be happy to help!". Jump straight into the substance.
- Refer to the user as "you" and yourself as "I".
- Always end with a concise status summary of what was done or what's needed next.

## MARKDOWN FORMATTING
- Format all responses with Markdown.
- Use `backticks` for variable names, function names, file paths, and code references.
- Use fenced code blocks with language tags.
- Bold **critical information**. Use headings to section longer responses.

## MANDATORY TOOL USE — CRITICAL
**You MUST use tools for EVERY request.** Even if the user asks a question, you investigate with tools first.
- If the user mentions a file, URL, error, or UI issue → use file_read, grep_search, file_list, or run_command to investigate BEFORE responding.
- If the user says something isn't working → use tools to check the actual state (read files, run commands, check processes).
- If the user asks "what about X" → use tools to look at X, don't just describe it.
- **NEVER respond with only text.** Always call at least one tool first to gather real information.
- Text-only responses are a FAILURE MODE. The user chose an agentic IDE, not a chatbot.

## HOW YOU WORK
1. **USE TOOLS FIRST, ALWAYS.** Before writing ANY text, call tools to read files, search code, or check state.
2. **Execute end-to-end.** If the task needs 10 steps, do all 10. Don't stop halfway.
3. **Batch independent tool calls.** Don't serialize independent operations.
4. **Verify your work.** After changes, read the file to confirm. After running a server, check it's running.
5. **Read before editing.** Always read a file before editing it.
6. **Use absolute paths** based on workspace root: {workspace_root}
7. **For long-running commands**, use run_command with blocking=false.
8. **Write COMPLETE code.** Never use placeholders. Include full implementations.
9. **Only respond with text AFTER you have used tools to investigate and/or fix the issue.**

## CODE
- Generated code must be immediately runnable — include all imports and dependencies.
- Follow existing code style. Do not add/remove comments unless asked.
- Prefer minimal, focused edits over full rewrites.

## AGENT PROTOCOL
- For multi-step work, maintain a TODO list with todo_list.
- If you need a human decision, ask with ask_user (structured options).
- Always show clean, human-readable results.

## SAFETY
- For destructive operations (file deletion, git push, deploy), confirm with user first.
- Never expose API keys or credentials.

## ERROR RECOVERY — MANDATORY
**NEVER tell the user to fix something. YOU fix it yourself.**
When something fails: read the error, search for cause, fix it yourself, retry.
Keep going until it WORKS — try at least 3 different approaches before giving up.

FORBIDDEN: "Please check...", "Try reinstalling...", "You may need to..."
You DO the work, you don't REPORT problems.

You are Resonant AI by Resonant Genesis. Not GPT, Claude, or Llama."""


# ── Helper: summarize tool result for message history ──

def _summarize_cv_result(name: str, raw: str) -> str:
    """Smart summarizer for code_visualizer_* tool results.
    Preserves stats, governance scores, and a meaningful subset of nodes."""
    CV_CAP = 12000
    if len(raw) <= CV_CAP:
        return raw
    try:
        parsed = json.loads(raw)
    except Exception:
        return raw[:CV_CAP - 60] + f"\n\n... (truncated, {len(raw)} total chars)"

    summary = {}

    # Always preserve stats and top-level metadata
    for key in ("stats", "report", "ci_pass", "total", "endpoints", "type",
                "start", "outgoing_count", "incoming_count", "pipeline",
                "node_status", "live_nodes", "invalid_nodes"):
        if key in parsed:
            summary[key] = parsed[key]

    # Preserve pipelines summary (names + node counts, not full data)
    if "pipelines" in parsed:
        summary["pipelines"] = {}
        for pname, pdata in parsed["pipelines"].items():
            if isinstance(pdata, dict):
                summary["pipelines"][pname] = {
                    "name": pdata.get("name", pname),
                    "node_count": len(pdata.get("nodes", [])),
                    "connection_count": len(pdata.get("connections", [])),
                }
            else:
                summary["pipelines"][pname] = pdata

    # Preserve services
    if "services" in parsed:
        summary["services"] = {k: len(v) if isinstance(v, list) else v for k, v in parsed["services"].items()}

    # Preserve a subset of nodes (prioritize endpoints and functions, cap at 60)
    if "nodes" in parsed and isinstance(parsed["nodes"], list):
        nodes = parsed["nodes"]
        endpoints = [n for n in nodes if n.get("type") == "api_endpoint"]
        functions = [n for n in nodes if n.get("type") == "function"]
        classes = [n for n in nodes if n.get("type") == "class"]
        others = [n for n in nodes if n.get("type") not in ("api_endpoint", "function", "class")]
        kept = (endpoints[:20] + classes[:10] + functions[:20] + others[:10])[:60]
        summary["nodes"] = kept
        summary["_nodes_shown"] = len(kept)
        summary["_nodes_total"] = len(nodes)

    # Preserve a subset of connections (cap at 40)
    if "connections" in parsed and isinstance(parsed["connections"], list):
        conns = parsed["connections"]
        summary["connections"] = conns[:40]
        summary["_connections_shown"] = min(40, len(conns))
        summary["_connections_total"] = len(conns)

    # Preserve functions list if present
    if "functions" in parsed and isinstance(parsed["functions"], list):
        funcs = parsed["functions"]
        summary["functions"] = funcs[:40]
        summary["_functions_shown"] = min(40, len(funcs))
        summary["_functions_total"] = len(funcs)

    result = json.dumps(summary)
    if len(result) > CV_CAP:
        return result[:CV_CAP - 60] + f"\n... (truncated, {len(result)} chars)"
    return result


def _summarize_tool_result(name: str, raw: str, cap: int = 3000) -> str:
    # Code Visualizer tools get special treatment — much higher cap + smart summarization
    if name.startswith("code_visualizer_"):
        return _summarize_cv_result(name, raw)
    if len(raw) <= cap:
        return raw
    try:
        parsed = json.loads(raw)
        if "content" in parsed and isinstance(parsed["content"], str):
            parsed["content"] = parsed["content"][:cap - 200] + f"\n... (truncated, {len(parsed['content'])} total chars)"
            return json.dumps(parsed)
        if "items" in parsed and isinstance(parsed["items"], list) and len(parsed["items"]) > 20:
            parsed["items"] = parsed["items"][:20]
            parsed["truncated"] = True
            return json.dumps(parsed)
    except Exception:
        pass
    return raw[:cap - 40] + f"\n\n... (truncated, {len(raw)} total chars)"


def _compress_old_messages(msgs: List[Dict[str, Any]]) -> None:
    cutoff = len(msgs) - 6
    for i in range(1, cutoff):
        m = msgs[i]
        if m.get("role") == "tool" and isinstance(m.get("content"), str) and len(m["content"]) > 200:
            # Preserve code_visualizer results better — keep 2000 chars instead of wiping
            if m.get("name", "").startswith("code_visualizer_"):
                if len(m["content"]) > 2000:
                    m["content"] = m["content"][:2000] + f"\n... (compressed from {len(m['content'])} chars)"
            else:
                m["content"] = f"[Tool result for {m.get('name', 'unknown')}: {len(m['content'])} chars — compressed]"


# ── Main agent stream endpoint ──

@router.post("/agent-stream")
async def agent_stream(
    request_body: AgentStreamRequest,
    request: Request,
):
    """Start server-side agentic loop. Returns SSE stream.

    SSE Events:
    - thinking: {"message": "Thinking... (loop N)"}
    - text: {"content": "markdown text..."}
    - execute_tool: {"session_id": "...", "tool_call_id": "...", "name": "...", "arguments": {...}}
    - tool_done: {"tool_call_id": "...", "status": "ok|error"}
    - fallback: {"provider": "...", "model": "...", "attempt": N}
    - stats: {"loops": N, "tool_calls": N, "tokens": N, "provider": "...", "model": "...", "fallback_chain": [...]}
    - done: {}
    - error: {"error": "..."}
    """
    # Auth: accept bearer token or x-user-id header
    auth_header = request.headers.get("authorization", "")
    auth_token = auth_header.replace("Bearer ", "") if auth_header.startswith("Bearer ") else ""
    user_id = request.headers.get("x-user-id") or auth_token[:20] or "anonymous"
    if not auth_token and not request.headers.get("x-user-id"):
        raise HTTPException(status_code=401, detail="Authentication required")

    _cleanup_sessions()
    if len(_sessions) >= MAX_SESSIONS:
        raise HTTPException(status_code=429, detail="Too many active sessions")

    session = AgentSession(user_id, request_body.workspace_root)
    _sessions[session.id] = session

    # Fetch user's BYOK keys
    user_keys = await fetch_user_byok_keys(user_id, auth_token)

    # Parse model selection from "resonant-{provider}-{model}"
    provider_key = "groq"
    model_name = "llama-3.3-70b-versatile"
    if request_body.model_id and request_body.model_id.startswith("resonant-"):
        parts = request_body.model_id.replace("resonant-", "", 1).split("-", 1)
        if len(parts) == 2:
            provider_key, model_name = parts[0], parts[1]

    logger.info(
        f"Agent stream: session={session.id} user={user_id} "
        f"provider={provider_key} model={model_name} "
        f"workspace={request_body.workspace_root}"
    )

    async def generate():
        try:
            system_prompt = _build_system_prompt(
                request_body.workspace_root,
                request_body.active_file,
            )
            messages: List[Dict[str, Any]] = [{"role": "system", "content": system_prompt}]

            if request_body.context:
                for ctx in request_body.context:
                    if ctx.get("role") in ("user", "assistant"):
                        messages.append({"role": ctx["role"], "content": ctx.get("content", "")})

            messages.append({"role": "user", "content": request_body.prompt})

            tools = _select_tools(request_body.prompt)
            tool_names = [t["function"]["name"] for t in tools]
            logger.info(f"Tools selected ({len(tools)}): {tool_names}")
            logger.info(f"Prompt ({len(request_body.prompt)} chars): {request_body.prompt[:200]}")
            max_loops = min(request_body.max_loops, 50)
            total_tool_calls = 0
            total_tokens = 0
            loops = 0
            last_provider = ""
            last_model = ""
            fallback_chain = []

            while loops < max_loops:
                loops += 1
                session.touch()

                yield f"event: thinking\ndata: {json.dumps({'message': f'Thinking... (loop {loops})'})}\n\n"

                # Call LLM via direct provider calls with fallback
                content = ""
                tool_calls = []
                fallback_attempt = 0
                loop_fallback_chain = []

                # Force tool use on first loop so agent investigates before talking
                loop_tool_choice = "required" if loops == 1 and tools else "auto"

                try:
                    async for chunk in call_llm_streaming(
                        messages=messages,
                        preferred_provider=provider_key,
                        preferred_model=model_name,
                        user_keys=user_keys,
                        tools=tools,
                        tool_choice=loop_tool_choice,
                        temperature=0.7,
                        max_tokens=16384,
                        local_llm=request_body.local_llm,
                    ):
                        if chunk.event == "chunk":
                            if chunk.content:
                                content += chunk.content
                                yield f"event: text\ndata: {json.dumps({'content': chunk.content})}\n\n"

                        elif chunk.event == "fallback":
                            fallback_attempt += 1
                            fb_info = {'provider': chunk.provider, 'model': chunk.model, 'attempt': fallback_attempt}
                            loop_fallback_chain.append(fb_info)
                            yield f"event: fallback\ndata: {json.dumps(fb_info)}\n\n"

                        elif chunk.event == "tool_calls":
                            tool_calls = chunk.tool_calls or []

                        elif chunk.event == "done":
                            if chunk.usage:
                                u = chunk.usage
                                total_tokens += u.get("total_tokens", 0) or (u.get("prompt_tokens", 0) + u.get("completion_tokens", 0))
                            last_provider = chunk.provider or provider_key
                            last_model = chunk.model or model_name
                            if loop_fallback_chain:
                                fallback_chain.extend(loop_fallback_chain)

                        elif chunk.event == "error":
                            yield f"event: error\ndata: {json.dumps({'error': chunk.error})}\n\n"
                            return

                except Exception as e:
                    err_msg = str(e)
                    if "429" in err_msg and loops < max_loops:
                        wait = min(loops * 20, 60)
                        rate_msg = "\n> ⏳ Rate limit hit — waiting " + str(wait) + "s...\n"
                        yield f"event: text\ndata: {json.dumps({'content': rate_msg})}\n\n"
                        await asyncio.sleep(wait)
                        continue
                    yield f"event: error\ndata: {json.dumps({'error': err_msg})}\n\n"
                    return

                logger.info(f"Loop {loops}: provider={last_provider} content_len={len(content)} tool_calls={len(tool_calls)} tools_in_request={len(tools)}")
                if not tool_calls:
                    break

                # ── Execute tools via client ──
                for tc in tool_calls:
                    tc_name = tc["function"]["name"]
                    tc_id = tc.get("id") or f"call_{loops}_{total_tool_calls}"
                    tc_args_str = tc["function"].get("arguments", "{}")

                    try:
                        tc_args = json.loads(tc_args_str) if isinstance(tc_args_str, str) else tc_args_str
                    except json.JSONDecodeError:
                        tc_args = {}

                    total_tool_calls += 1

                    yield f"event: execute_tool\ndata: {json.dumps({'session_id': session.id, 'tool_call_id': tc_id, 'name': tc_name, 'arguments': tc_args})}\n\n"

                    try:
                        tool_result_data = await asyncio.wait_for(
                            session.tool_result_queue.get(),
                            timeout=120,
                        )
                    except asyncio.TimeoutError:
                        tool_result_data = {
                            "tool_call_id": tc_id,
                            "name": tc_name,
                            "result": json.dumps({"error": "Tool execution timed out (120s)"}),
                        }

                    tool_result = tool_result_data.get("result", "{}")
                    is_error = '"error"' in tool_result
                    yield f"event: tool_done\ndata: {json.dumps({'tool_call_id': tc_id, 'name': tc_name, 'status': 'error' if is_error else 'ok'})}\n\n"

                    messages.append({
                        "role": "assistant",
                        "content": content or None,
                        "tool_calls": [tc],
                    })
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc_id,
                        "name": tc_name,
                        "content": _summarize_tool_result(tc_name, tool_result),
                    })
                    content = ""

                if len(messages) > 22:
                    system = messages[0]
                    recent = messages[-20:]
                    messages = [system] + recent
                    _compress_old_messages(messages)

            # ── Done ──
            yield f"event: stats\ndata: {json.dumps({'loops': loops, 'tool_calls': total_tool_calls, 'tokens': total_tokens, 'provider': last_provider, 'model': last_model, 'fallback_chain': fallback_chain})}\n\n"
            yield f"event: done\ndata: {json.dumps({})}\n\n"

        except Exception as e:
            logger.error(f"Agent loop error: {e}", exc_info=True)
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
        finally:
            session.active = False
            _sessions.pop(session.id, None)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/agent-stream/{session_id}/tool-results")
async def submit_tool_results(
    session_id: str,
    request_body: ToolResultRequest,
    request: Request,
):
    """Client submits local tool execution result. Server resumes agentic loop."""
    auth_header = request.headers.get("authorization", "")
    auth_token = auth_header.replace("Bearer ", "") if auth_header.startswith("Bearer ") else ""
    user_id = request.headers.get("x-user-id") or auth_token[:20] or ""
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")

    session = _get_or_fail(session_id)

    await session.tool_result_queue.put({
        "tool_call_id": request_body.tool_call_id,
        "name": request_body.name,
        "result": request_body.result,
    })

    return {"status": "ok", "session_id": session_id}
