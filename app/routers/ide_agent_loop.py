"""IDE Agent Loop — Server-side agentic orchestration for DevSwat IDE.

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
import os
import re
import time
import uuid
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..llm_client import call_llm_streaming, fetch_user_byok_keys

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ide", tags=["ide-agent"])

# Code Visualizer (AST analysis) service — accessible via Docker network
CODE_VISUALIZER_URL = os.getenv("CODE_VISUALIZER_URL", "http://rg_ast_analysis:8000")

# LOC tracking service — sends telemetry to ide_service for dashboard stats
LOC_SERVICE_URL = os.getenv("LOC_SERVICE_URL", "http://ide_service:8080")

# Tools that modify files — tracked for LOC stats
_FILE_WRITE_TOOLS = {"file_write", "file_edit", "multi_edit", "notebook_edit"}


async def _track_loc_event(
    user_id: str,
    session_id: str,
    tool_name: str,
    tool_args: dict,
    tool_result: str,
):
    """Fire-and-forget POST LOC event to ide_service after file write/edit."""
    try:
        file_path = tool_args.get("path") or tool_args.get("file_path") or tool_args.get("target_file") or tool_args.get("absolute_path") or ""
        content = tool_args.get("content") or tool_args.get("new_string") or tool_args.get("code_content") or tool_args.get("new_source") or ""
        old_content = tool_args.get("old_string") or ""

        new_lines = content.count("\n") + (1 if content and not content.endswith("\n") else 0) if content else 0
        old_lines = old_content.count("\n") + (1 if old_content and not old_content.endswith("\n") else 0) if old_content else 0

        if tool_name == "file_write":
            lines_written = new_lines
            lines_edited = 0
            lines_deleted = 0
        elif tool_name in ("file_edit", "notebook_edit"):
            lines_written = max(0, new_lines - old_lines)
            lines_edited = min(new_lines, old_lines)
            lines_deleted = max(0, old_lines - new_lines)
        elif tool_name == "multi_edit":
            edits = tool_args.get("edits", [])
            lines_written = 0
            lines_edited = 0
            lines_deleted = 0
            for edit in edits:
                ns = edit.get("new_string", "")
                os_str = edit.get("old_string", "")
                nl = ns.count("\n") + (1 if ns and not ns.endswith("\n") else 0)
                ol = os_str.count("\n") + (1 if os_str and not os_str.endswith("\n") else 0)
                lines_written += max(0, nl - ol)
                lines_edited += min(nl, ol)
                lines_deleted += max(0, ol - nl)
            file_path = tool_args.get("file_path") or file_path
        else:
            return

        if lines_written == 0 and lines_edited == 0 and lines_deleted == 0:
            return

        net_lines = lines_written - lines_deleted

        batch = {
            "user_id": user_id,
            "session_id": session_id,
            "events": [{
                "user_id": user_id,
                "session_id": session_id,
                "tool_name": tool_name,
                "file_path": file_path,
                "lines_written": lines_written,
                "lines_edited": lines_edited,
                "lines_deleted": lines_deleted,
                "net_lines": net_lines,
            }],
        }

        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(f"{LOC_SERVICE_URL}/loc/track", json=batch)
    except Exception as e:
        logger.debug(f"LOC tracking failed (non-critical): {e}")


# ── Session store ──

SESSION_TIMEOUT = 300  # 5 min
MAX_SESSIONS = 100


class AgentSession:
    def __init__(self, user_id: str, workspace_root: str):
        self.id = str(uuid.uuid4())[:12]
        self.user_id = user_id
        self.workspace_root = workspace_root
        self.tool_result_queue: asyncio.Queue = asyncio.Queue()
        self.llm_result_queue: asyncio.Queue = asyncio.Queue()  # LLM proxy for local Ollama
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
    local_llm: Optional[Dict[str, Any]] = None  # {url, model, context_length}
    ide_metadata: Optional[Dict[str, Any]] = None  # {os, cursor_line, active_language, open_files, selection}
    workspace_layout: Optional[str] = None  # file tree snapshot from client


class ToolResultRequest(BaseModel):
    tool_call_id: str
    name: str
    result: str


class LLMResultRequest(BaseModel):
    """Client posts local LLM (Ollama) completion result back to server."""
    content: str = ""
    tool_calls: Optional[List[Dict[str, Any]]] = None  # [{id, type, function: {name, arguments}}]
    usage: Optional[Dict[str, Any]] = None  # {prompt_tokens, completion_tokens, total_tokens}
    model: str = ""
    error: Optional[str] = None


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
        {"type": F, "function": {"name": "browser_preview", "description": "Open a URL in a VS Code webview panel with console log capture. Returns preview_id for reading console logs via read_browser_logs. User can interact with the page normally.", "parameters": {"type": "object", "properties": {"url": {"type": "string"}, "name": {"type": "string"}}, "required": ["url"]}}},
        {"type": F, "function": {"name": "read_browser_logs", "description": "Read console logs from browser preview.", "parameters": {"type": "object", "properties": {"preview_id": {"type": "string"}}, "required": ["preview_id"]}}},
    ])

    # CODE ANALYSIS
    tools.extend([
        {"type": F, "function": {"name": "code_visualizer_scan", "description": "Full AST analysis of a local project. Returns services, functions, classes, endpoints, imports. For GitHub repos use code_visualizer_scan_github instead. Respond with architectural insights, never dump raw JSON.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "code_visualizer_functions", "description": "List all functions and API endpoints.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "code_visualizer_trace", "description": "Trace dependency flow from any node.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "query": {"type": "string"}, "max_depth": {"type": "number"}}, "required": ["path", "query"]}}},
        {"type": F, "function": {"name": "code_visualizer_governance", "description": "Architecture governance: drift, health score.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "drift_threshold": {"type": "number"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "code_visualizer_graph", "description": "Full dependency graph.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "code_visualizer_pipeline", "description": "Auto-detected pipeline flow.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "pipeline_name": {"type": "string"}}, "required": ["path", "pipeline_name"]}}},
        {"type": F, "function": {"name": "code_visualizer_filter", "description": "Filter graph by file, type, keyword.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "file_path": {"type": "string"}, "node_type": {"type": "string"}, "keyword": {"type": "string"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "code_visualizer_by_type", "description": "Get all nodes of a type.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "node_type": {"type": "string"}}, "required": ["path", "node_type"]}}},
        {"type": F, "function": {"name": "code_visualizer_compare", "description": "Compare multiple codebases — detect changes, instability, evolution.", "parameters": {"type": "object", "properties": {"paths": {"type": "string", "description": "Comma-separated paths to compare"}, "labels": {"type": "string", "description": "Comma-separated labels for each path"}}, "required": ["paths"]}}},
        {"type": F, "function": {"name": "code_visualizer_live_nodes", "description": "List live (reachable) nodes in the dependency graph.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "drift_threshold": {"type": "number"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "code_visualizer_invalid_nodes", "description": "List invalid/unreachable nodes (dead code candidates).", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "drift_threshold": {"type": "number"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "code_visualizer_compile", "description": "Graph→Patch Compiler: convert GAL action to auditable code patch.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "gal_action": {"type": "string", "description": "JSON GAL action object"}}, "required": ["path", "gal_action"]}}},
        {"type": F, "function": {"name": "code_visualizer_verify_invariants", "description": "Verify formal safety invariants on the codebase graph.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "code_visualizer_scan_github", "description": "AST-scan a GitHub repo by URL — no local clone needed. Supports branch and private repos with PAT. NEVER use git clone for this. Respond with architectural insights, never dump raw JSON.", "parameters": {"type": "object", "properties": {"repo_url": {"type": "string", "description": "GitHub repository URL (e.g. https://github.com/user/repo)"}, "branch": {"type": "string", "description": "Branch to scan (default: main/master)"}, "token": {"type": "string", "description": "GitHub PAT for private repos (optional)"}}, "required": ["repo_url"]}}},
        {"type": F, "function": {"name": "graph_janitor_scan", "description": "Autonomous Graph Janitor Agent — scans local project for dead code, unreachable nodes, orphan endpoints. Returns health score + ranked proposals. One call does everything (AST scan + governance + reachability + proposals). After results: present summary, use file_read to verify proposals, use ask_user to confirm before changes. Never auto-delete code.", "parameters": {"type": "object", "properties": {"path": {"type": "string", "description": "Absolute path to the project folder to scan"}, "max_proposals": {"type": "number", "description": "Maximum proposals to return (default: 15)"}, "drift_threshold": {"type": "number", "description": "Architecture drift threshold (default: 20.0)"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "graph_janitor_scan_github", "description": "Autonomous Graph Janitor for GitHub repos. Give URL, get health score + cleanup proposals in one step. No pre-scan needed. After results: present summary, verify proposals with file_read, confirm with ask_user before changes.", "parameters": {"type": "object", "properties": {"repo_url": {"type": "string", "description": "GitHub repository URL (e.g. https://github.com/user/repo)"}, "branch": {"type": "string", "description": "Branch to scan (default: main/master)"}, "token": {"type": "string", "description": "GitHub PAT for private repos (optional)"}, "max_proposals": {"type": "number", "description": "Maximum proposals to return (default: 15)"}, "drift_threshold": {"type": "number", "description": "Architecture drift threshold (default: 20.0)"}}, "required": ["repo_url"]}}},
    ])

    # PLANNING & MEMORY
    tools.extend([
        {"type": F, "function": {"name": "todo_list", "description": "Create/update task list.", "parameters": {"type": "object", "properties": {"todos": {"type": "array", "items": {"type": "object", "properties": {"id": {"type": "string"}, "content": {"type": "string"}, "status": {"type": "string"}, "priority": {"type": "string"}}, "required": ["id", "content", "status", "priority"]}}}, "required": ["todos"]}}},
        {"type": F, "function": {"name": "ask_user", "description": "Ask user a question with optional options.", "parameters": {"type": "object", "properties": {"question": {"type": "string"}, "options": {"type": "array", "items": {"type": "object", "properties": {"label": {"type": "string"}, "description": {"type": "string"}}}}, "allow_multiple": {"type": "boolean"}}, "required": ["question"]}}},
        {"type": F, "function": {"name": "save_memory", "description": "Save content to persistent memory with key and optional tags. Syncs to server-backed Hash Sphere when authenticated, with local fallback.", "parameters": {"type": "object", "properties": {"key": {"type": "string"}, "content": {"type": "string"}, "tags": {"type": "array", "items": {"type": "string"}}}, "required": ["key", "content"]}}},
        {"type": F, "function": {"name": "read_memory", "description": "Retrieve memories by key (exact), tag (filter), or query (semantic search via server + keyword search locally). Returns matching memory entries.", "parameters": {"type": "object", "properties": {"key": {"type": "string"}, "tag": {"type": "string"}, "query": {"type": "string"}}, "required": []}}},
        {"type": F, "function": {"name": "create_memory", "description": "Create, update, or delete persistent memories that survive across conversations. Actions: create (title+content+tags), update (id+changes), delete (id). Memories are auto-retrieved in future conversations when relevant.", "parameters": {"type": "object", "properties": {"action": {"type": "string"}, "title": {"type": "string"}, "content": {"type": "string"}, "tags": {"type": "array", "items": {"type": "string"}}, "id": {"type": "string"}}, "required": ["action"]}}},
        {"type": F, "function": {"name": "code_search", "description": "Semantic-like codebase search using multi-pass ripgrep. Extracts key terms from natural language query, finds matching files, then returns context around matches. Ideal for exploring unfamiliar codebases.", "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "path": {"type": "string"}}, "required": ["query"]}}},
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
        {"type": F, "function": {"name": "deploy_web_app", "description": "Build and deploy a web application. Auto-detects framework (Next.js, React, Svelte, Vue, Astro, static). Builds the project, detects output directory, and deploys via platform API or provides manual deploy commands.", "parameters": {"type": "object", "properties": {"project_path": {"type": "string"}, "framework": {"type": "string"}, "subdomain": {"type": "string"}}, "required": ["project_path"]}}},
    ])

    # NOTEBOOKS
    tools.extend([
        {"type": F, "function": {"name": "read_notebook", "description": "Read and parse a Jupyter notebook (.ipynb), returning cells with their types, source code, and outputs in a structured format.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
        {"type": F, "function": {"name": "edit_notebook", "description": "Edit or insert a cell in a Jupyter notebook (.ipynb). Modes: replace (overwrite existing cell) or insert (add new cell at position). Supports code and markdown cell types.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "cell_number": {"type": "number"}, "new_source": {"type": "string"}, "cell_type": {"type": "string"}, "edit_mode": {"type": "string"}}, "required": ["path", "cell_number", "new_source"]}}},
    ])

    # VISUAL
    tools.extend([
        {"type": F, "function": {"name": "visualize", "description": "Generate SVG/Mermaid diagram in chat.", "parameters": {"type": "object", "properties": {"title": {"type": "string"}, "svg": {"type": "string"}, "mermaid": {"type": "string"}, "width": {"type": "number"}, "height": {"type": "number"}}, "required": ["title"]}}},
        {"type": F, "function": {"name": "image_search", "description": "Search web for images.", "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "count": {"type": "number"}}, "required": ["query"]}}},
    ])

    # PLATFORM API
    tools.extend([
        {"type": F, "function": {"name": "platform_api_search", "description": "Search 450+ DevSwat platform API endpoints.", "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "category": {"type": "string"}}, "required": ["query"]}}},
        {"type": F, "function": {"name": "platform_api_call", "description": "Call platform API endpoint.", "parameters": {"type": "object", "properties": {"method": {"type": "string"}, "path": {"type": "string"}, "body": {"type": "object"}}, "required": ["method", "path"]}}},
    ])

    # WORKFLOWS (.resonant/workflows/*.md)
    tools.extend([
        {"type": F, "function": {"name": "list_workflows", "description": "List available workflow definitions from .resonant/workflows/*.md. Workflows are step-by-step guides for common tasks.", "parameters": {"type": "object", "properties": {}, "required": []}}},
        {"type": F, "function": {"name": "run_workflow", "description": "Load and execute a named workflow from .resonant/workflows/{name}.md. Returns the workflow steps to follow.", "parameters": {"type": "object", "properties": {"name": {"type": "string", "description": "Workflow name (without .md extension)"}}, "required": ["name"]}}},
    ])

    # TRAJECTORY / CONVERSATION SEARCH
    tools.extend([
        {"type": F, "function": {"name": "trajectory_search", "description": "Search conversation history and memories for relevant context. Returns matching conversation summaries and memory entries. Use when user references previous work or you need to recall past decisions.", "parameters": {"type": "object", "properties": {"query": {"type": "string", "description": "Search query for finding relevant past context"}, "conversation_id": {"type": "string", "description": "Optional: search within a specific conversation"}}, "required": ["query"]}}},
    ])

    # CHECKPOINTS (session continuity)
    tools.extend([
        {"type": F, "function": {"name": "save_checkpoint", "description": "Save a conversation checkpoint for session continuity. Captures current state so work can be resumed later.", "parameters": {"type": "object", "properties": {"summary": {"type": "string", "description": "Summary of what was done and current state"}, "key_files": {"type": "array", "items": {"type": "string"}, "description": "Important files touched"}, "pending_tasks": {"type": "array", "items": {"type": "string"}, "description": "Tasks remaining"}}, "required": ["summary"]}}},
        {"type": F, "function": {"name": "load_checkpoint", "description": "Load the most recent conversation checkpoint to resume previous work.", "parameters": {"type": "object", "properties": {}, "required": []}}},
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
_VIZ_NAMES = {n for n in _ALL_TOOL_NAMES if n.startswith("code_visualizer_") or n.startswith("graph_janitor_")}
_PLAN_NAMES = {"todo_list", "ask_user", "save_memory", "read_memory", "create_memory", "code_search", "list_workflows", "run_workflow", "trajectory_search", "save_checkpoint", "load_checkpoint"}
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
    if re.search(r'\b(analy[sz]|visuali[sz]|architecture|structure|dependen|scan|overview|governance|dead.?code|pipeline|graph.?janitor|drift|trace.?flow|codebase|ast|github\.com|repo|unused|orphan|unreachable|cleanup|clean.?up|code.?health|health.?check|code.?quality|code.?review|remove.?dead|find.?dead|what.?can.?i.?delete|janitor|reachab)', q) or 'github.com/' in q:
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
        names |= _PLAN_NAMES

    return [t for t in _ALL_TOOLS if t["function"]["name"] in names]


# ── System prompt (protected server-side IP) ──

def _build_system_prompt(
    workspace_root: str,
    active_file: Optional[str] = None,
    ide_metadata: Optional[Dict[str, Any]] = None,
    workspace_layout: Optional[str] = None,
) -> str:
    health_block = ""

    # IDE metadata block (like Cascade's ide_metadata injection)
    ide_block = ""
    if ide_metadata:
        parts = []
        if ide_metadata.get("os"):
            parts.append(f"The USER's OS is {ide_metadata['os']}.")
        if ide_metadata.get("active_file"):
            lang = ide_metadata.get("active_language", "")
            line = ide_metadata.get("cursor_line")
            parts.append(f"Active Document: {ide_metadata['active_file']}" + (f" ({lang})" if lang else "") + (f", cursor at line {line}" if line else ""))
        open_files = ide_metadata.get("open_files") or []
        if open_files:
            others = [f for f in open_files if f != ide_metadata.get("active_file")]
            if others:
                parts.append("Other open files: " + ", ".join(others[:8]))
        if ide_metadata.get("selection"):
            parts.append(f"Selected text:\n```\n{ide_metadata['selection'][:1000]}\n```")
        if parts:
            ide_block = f"""
<ide_state>
NOTE: Open files and cursor position may not be related to the user's request. Verify relevance before assuming connection.
{chr(10).join(parts)}
</ide_state>"""

    # Workspace layout block (like Cascade's workspace_layout)
    layout_block = ""
    if workspace_layout:
        layout_block = f"""
<workspace_layout>
Below is a snapshot of the workspace file structure. This snapshot may be a few minutes out of date.
{workspace_layout}
</workspace_layout>"""

    return f"""You are DevSwat AI, a powerful agentic AI coding assistant.
The USER is interacting with you through a chat panel in their IDE and will send you requests to solve a coding task by pair programming with you.
The task may require modifying or debugging existing code, answering a question about existing code, or writing new code.
Be mindful that you are not the only one working in this computing environment.
Do not overstep your bounds, your goal is to be a pair programmer to the user in completing their task.
For example: Do not create random files which will clutter the users workspace unless it is necessary to the task.
{ide_block}{layout_block}
<communication_style>
Be terse and direct. Deliver fact-based progress updates, briefly summarize after clusters of tool calls when needed, and ask for clarification only when genuinely uncertain about intent or requirements.
<communication_guidelines>
- Be concise and avoid verbose responses. Minimize output tokens as much as possible while maintaining helpfulness, quality, and accuracy. Avoid explanations in huge blocks of text or long/nested lists. Instead, prefer concise bullet points and short paragraphs.
- Refer to the USER in the second person and yourself in the first person.
- You are rigorous and make absolutely no ungrounded assertions, such as referring to non-existent functions or parameters. Your response should be in the context of the current workspace. When feeling uncertain, use tools to gather more information, and clearly state your uncertainty if there's no way to get unstuck.
- You should strive to strike a balance between: (a) doing the right thing when asked, including taking actions and follow-up actions, and (b) not surprising the user by taking actions without asking. Always adhere to the user's preference between proactive vs careful.
For example, if the user asks you how to approach something, answer their question first, and not immediately jump into editing the file; if the user asks you to build something without asking, you should strive to deliver a fully functional solution with all necessary components and dependencies.
- No acknowledgment phrases: Never start responses with phrases like "You're absolutely right!", "Great idea!", "I agree", "Good point", "That makes sense", etc. Jump straight into addressing the request without any preamble or validation of the user's statement.
- By default, implement changes rather than only suggesting them, unless the user is explicit about not writing code. If the user's intent is unclear, infer the most useful likely action and proceed, using tools to discover any missing details instead of guessing.
- When seeing a new user request, do not repeat your initial response. It is okay if you keep working and update the user with more information later but your messages should not be repetitive.
- Direct responses: Begin responses immediately with the substantive content. Do not acknowledge, validate, or express agreement with the user's request before addressing it.
- If you require user assistance, you should communicate this.
- Code style: Do not add or delete ANY comments or documentation unless asked.
- Always end a conversation with a clear and concise summary of the task completion status.
</communication_guidelines>
<markdown_formatting>
Follow the following instructions when formatting your output to the user:
  - IMPORTANT: Format your messages with Markdown.
  - Use single backtick inline code for variable or function names.
  - Use fenced code blocks with language when referencing code snippets.
  - Bold or italicize critical information, if any.
  - Section responses properly with Markdown headings, e.g., '# Recommended Actions', '## Cause of bug', '# Findings'.
  - Use short display lists delimited by endlines, not inline lists. Always bold the title of every list item.
  - Never use unicode bullet points. Use the markdown list syntax to format lists.
  - When explaining, always reference relevant file, directory, function, class or symbol names/paths by backticking them in Markdown to provide accurate citations.
</markdown_formatting>
<citation_guidelines>
- You MUST use the following format when showing the user existing code:
```@<absolute_filepath>:<start_line>-<end_line>
<existing_code>
```
- Valid (multi-line): ```@/path/file.py:1-3
- Valid (single-line): ```@/path/file.py:30
- ALWAYS use citation format when mentioning any file path in your response.
- The file path MUST be an absolute path from the filesystem root. Do NOT use workspace-relative paths.
</citation_guidelines>
</communication_style>

<tool_calling>
Use only the available tools. Never guess parameters. Do not invent or change tool definitions.
Before each tool call, briefly state why you are calling it.
You have the ability to call tools in parallel; prioritize calling independent tools simultaneously whenever possible while following these rules:
- Batch independent actions into parallel tool calls and keep dependent or destructive commands sequential.
- If you intend to call multiple tools and there are no dependencies between the tool calls, make all of the independent tool calls in parallel.
- Keep dependent commands sequential and never invent parameters.
- IMPORTANT: If you need to explore the codebase to gather context, and the task does not involve a single file or function which is provided by name, you should use code_search or grep_search tools first instead of guessing file paths.
- ALWAYS use tools to investigate before responding with text. Read files, search code, or check state FIRST.
- If user mentions a file, URL, port, error, or service — use run_command, file_read, grep_search, or find_by_name to check actual state. NEVER guess or assume.
- NEVER apologize for not checking earlier. Instead, just check now. Action over apology.
- If your first tool call doesn't find the answer, try a different approach (different command, different path, broader search). Don't give up after one attempt.
</tool_calling>

<making_code_changes>
Prefer minimal, focused edits when modifying existing code. Keep changes scoped, follow existing style, and write general-purpose solutions. Avoid helper scripts or hard-coded shortcuts.
When making code changes, NEVER output code to the USER, unless requested. Instead use one of the code edit tools to implement the change.
EXTREMELY IMPORTANT: Your generated code must be immediately runnable. To guarantee this, follow these instructions carefully:
- Add all necessary import statements, dependencies, and endpoints required to run the code.
- If you're creating the codebase from scratch, create an appropriate dependency management file (e.g. requirements.txt, package.json) with package versions and a helpful README.
- If you're building a web app from scratch, give it a beautiful and modern UI, imbued with best UX practices and use modern UI frameworks and libraries (e.g React for the web framework, Lucide for icons, TailwindCSS for styling, shadcn/ui for components, etc.). Make it visually impressive with parallax effects, smooth animations, glass morphism, gradients, and responsive design. Never build ugly or plain UIs.
- If you're building any frontend, always include: proper spacing, modern typography, hover/focus states, transitions, dark mode support, and mobile responsiveness.
- If you're making a very large edit (>300 lines), break it up into multiple smaller edits. Your max output tokens is limited, so each edit MUST stay within that limit.
- Read a file before editing it. Verify edits by reading after.
- Imports must always be at the top of the file. If you are making an edit, do not import libraries in your code block if it is not at the top of the file. Instead, make a second separate edit to add the imports. This is crucial since imports in the middle of a file is extremely poor code style.
</making_code_changes>

<running_commands>
You have the ability to run terminal commands on the user's machine.
You are not running in a dedicated container. Check for existing dev servers before starting new ones, and be careful with write actions that mutate the file system or interfere with processes.
NEVER include `cd` as part of the command. Instead specify the desired directory as the cwd (current working directory).
- For long-running commands (servers, watchers), use run_command with blocking=false.
- Destructive commands (delete, push, deploy, install): require user confirmation first.
- A command is unsafe if it may have some destructive side-effects. Example unsafe side-effects include: deleting files, mutating state, installing system dependencies, making external requests, etc.
</running_commands>

<debugging>
When debugging, only make code changes if you are certain that you can solve the problem.
Otherwise, follow debugging best practices:
1. Address the root cause instead of the symptoms.
2. Add descriptive logging statements and error messages to track variable and code state.
3. Add test functions and statements to isolate the problem.
- Try at least 3 different approaches before giving up. Fix it yourself — never tell the user to fix it.
- FORBIDDEN phrases: "I apologize for not...", "It wasn't until you...", "Please check...", "Try reinstalling...". You are an autonomous agent — investigate and solve, don't defer to the user.
</debugging>

<calling_external_apis>
1. When selecting which version of an API or package to use, choose one that is compatible with the USER's dependency management file. If no such file exists or if the package is not present, use the latest version that is in your training data.
2. If an external API requires an API Key, be sure to point this out to the USER. Adhere to best security practices (e.g. DO NOT hardcode an API key in a place where it can be exposed).
</calling_external_apis>

<task_management>
- For multi-step work, use todo_list to track progress. Limit plans to concise steps, execute one at a time, mark as done when complete, and update when new information arrives.
- For user decisions, use ask_user with structured options.
- Execute end-to-end: if a task needs 10 steps, do all 10. Do not stop halfway and ask the user to continue.
</task_management>

<workflows>
You can use and create workflows — step-by-step guides stored in .resonant/workflows/*.md.
Format: YAML frontmatter (description) + markdown steps.
- Use list_workflows to see available workflows. Use run_workflow to load one.
- If user says /workflow-name, load .resonant/workflows/workflow-name.md.
- Create new workflows when asked.
</workflows>

<memory_system>
You have access to a persistent memory database backed by Hash Sphere (server-side vector store):
- read_memory(query=...): Semantic search across all saved memories. USE THIS at the start of complex tasks to check for prior context, decisions, architecture notes, or user preferences.
- save_memory(key, content, tags): Store important context for future sessions.
- create_memory(action, title, content, tags, id): CRUD operations on memories.
- Before creating a new memory, use read_memory to check if a related memory already exists. Update it instead of creating a duplicate.
- Memories persist across sessions. At the start of significant work, proactively call read_memory with a relevant query to retrieve prior context.
- After completing significant work (architecture decisions, major refactors, debugging sessions), save a memory summarizing what was done and why.
- Memories can be stale or incorrect. Always verify their relevance before relying on them.
</memory_system>

<workspace_context>
- You have code analysis tools (code_visualizer_*, graph_janitor_*) available. Use them ONLY when the user asks for architecture analysis, dead code detection, health checks, or when you genuinely need codebase-wide understanding. Do NOT auto-scan on every interaction.
- For normal coding tasks (fix bug, write feature, read file), use core tools (file_read, grep_search, run_command) — they are faster and cheaper.
</workspace_context>

<workspace_knowledge>
IMPORTANT: Build and maintain a workspace knowledge base using save_memory:
- When you discover key facts about the workspace (folder structure, service connections, tech stack, how things work), save them as memories with tag "workspace-kb".
- Before re-reading folders or files you've read before, check read_memory(query="workspace structure") first.
- After exploring a new repo/folder, save a compact summary: purpose, key files, tech stack, connections to other services.
- Use save_checkpoint at natural stopping points to enable cross-session continuity.
- When the user says "continue", "resume", "go on", "do it", "yes" — check for checkpoint context injected into your prompt and pick up where you left off.
</workspace_knowledge>

You are DevSwat AI by DevSwat.{health_block}"""


# ── Helper: summarize tool result for message history ──

def _summarize_cv_result(name: str, raw: str) -> str:
    """Human-readable summary of code_visualizer results for the LLM.
    The full formatted report is shown to the user by the IDE client.
    This returns compact text so the LLM can discuss findings intelligently."""
    try:
        parsed = json.loads(raw)
    except Exception:
        if len(raw) > 3000:
            return raw[:3000] + "\n... (truncated)"
        return raw

    lines = [f"Code Visualizer ({name}) completed."]

    # Source info
    src = parsed.get("_source", {})
    if src.get("url"):
        lines.append(f"Source: {src['url']}")

    # Stats
    s = parsed.get("stats") or parsed.get("analysis", {}).get("stats", {})
    if s:
        parts = []
        if s.get("total_services"): parts.append(f"{s['total_services']} services")
        if s.get("files_analyzed"): parts.append(f"{s['files_analyzed']} files analyzed")
        if s.get("total_functions"): parts.append(f"{s['total_functions']} functions")
        if s.get("total_endpoints"): parts.append(f"{s['total_endpoints']} endpoints")
        if s.get("total_connections"): parts.append(f"{s['total_connections']} connections")
        if s.get("broken_connections"): parts.append(f"{s['broken_connections']} broken connections")
        if parts:
            lines.append("Stats: " + ", ".join(parts))
        if s.get("truncated"):
            lines.append(f"WARNING: Analysis capped at {s.get('files_analyzed', 500)} files (large repo).")

    # Services
    services = parsed.get("services", {})
    if services:
        svc_parts = [f"{k} ({len(v) if isinstance(v, list) else v} files)" for k, v in list(services.items())[:10]]
        lines.append("Services: " + ", ".join(svc_parts))

    # Top functions from nodes
    func_nodes = [n for n in parsed.get("nodes", []) if n.get("type") == "function"]
    if func_nodes:
        lines.append(f"Functions: {len(func_nodes)} total")
        for fn in func_nodes[:8]:
            loc = f":{fn.get('line_start', '')}" if fn.get("line_start") else ""
            lines.append(f"  - {fn.get('name', '?')} ({fn.get('file_path', '?')}{loc})")
        if len(func_nodes) > 8:
            lines.append(f"  ... and {len(func_nodes) - 8} more")

    # Endpoints from nodes
    ep_nodes = [n for n in parsed.get("nodes", []) if n.get("type") == "api_endpoint"]
    if ep_nodes:
        lines.append(f"API Endpoints: {len(ep_nodes)}")
        for ep in ep_nodes[:8]:
            route = (ep.get("metadata") or {}).get("route") or ep.get("name", "?")
            lines.append(f"  - {route} ({ep.get('file_path', '?')})")
        if len(ep_nodes) > 8:
            lines.append(f"  ... and {len(ep_nodes) - 8} more")

    # Governance scores
    if parsed.get("reachability_score") is not None:
        lines.append(f"Reachability: {parsed['reachability_score']}")
    if parsed.get("drift_score") is not None:
        lines.append(f"Drift: {parsed['drift_score']}")
    if parsed.get("ci_pass") is not None:
        lines.append(f"CI Pass: {parsed['ci_pass']}")
    violations = parsed.get("violations", [])
    if violations:
        lines.append(f"Violations: {len(violations)}")
        for v in violations[:5]:
            lines.append(f"  - {v.get('type', v.get('rule', 'violation'))}: {str(v.get('message', v.get('details', '')))[:120]}")

    # Functions list (from code_visualizer_functions tool)
    funcs_list = parsed.get("functions", [])
    if funcs_list and not func_nodes:
        lines.append(f"Functions listed: {len(funcs_list)}")
        for fn in funcs_list[:10]:
            if isinstance(fn, dict):
                lines.append(f"  - {fn.get('name', '?')} ({fn.get('file', '?')}:{fn.get('line', '?')})")
        if len(funcs_list) > 10:
            lines.append(f"  ... and {len(funcs_list) - 10} more")

    # Pipelines
    pipelines = parsed.get("pipelines", {})
    if pipelines:
        pip_parts = []
        for pname, pdata in list(pipelines.items())[:6]:
            nc = len(pdata.get("nodes", [])) if isinstance(pdata, dict) else 0
            if nc > 0:
                pip_parts.append(f"{pname} ({nc} nodes)")
        if pip_parts:
            lines.append("Pipelines: " + ", ".join(pip_parts))

    lines.append("")
    lines.append("Full formatted report shown to user. Discuss the architecture, patterns, and any issues. Do NOT repeat raw data.")

    return "\n".join(lines)


def _summarize_gja_result(raw: str) -> str:
    """Summarize Graph Janitor Agent scan result for the LLM."""
    try:
        parsed = json.loads(raw)
    except Exception:
        return raw[:3000]
    lines = ["Graph Janitor Agent Scan Results:"]
    health = parsed.get("health_indicators", {})
    if health:
        lines.append(f"Health: {health.get('status_emoji', '')} {health.get('status', 'unknown')} (score: {health.get('health_score', '?')})")
        for rec in health.get("recommendations", []):
            lines.append(f"  → {rec}")
    metrics = parsed.get("metrics", {})
    if metrics:
        lines.append(f"Reachability: {metrics.get('reachability_score', '?')}%")
        lines.append(f"Unreachable nodes: {metrics.get('unreachable_nodes', 0)}")
        lines.append(f"Isolated nodes: {metrics.get('isolated_nodes', 0)}")
        lines.append(f"Orphan endpoints: {metrics.get('orphan_endpoints', 0)}")
    proposals = parsed.get("proposals", [])
    lines.append(f"Proposals: {len(proposals)}")
    for p in proposals[:10]:
        lines.append(f"  [{p.get('proposal', '?')}] {p.get('root', '?')} — {p.get('reason', '')[:120]} (risk: {p.get('risk', '?')})")
    return "\n".join(lines)


def _summarize_tool_result(name: str, raw: str, cap: int = 3000) -> str:
    # Code Visualizer tools get special treatment — much higher cap + smart summarization
    if name.startswith("code_visualizer_"):
        return _summarize_cv_result(name, raw)
    if name in ("graph_janitor_scan", "graph_janitor_scan_github"):
        return _summarize_gja_result(raw)
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


# ── Server-side tool execution (tools that don't run on the client) ──

_SERVER_SIDE_TOOLS = {"code_visualizer_scan_github", "graph_janitor_scan_github"}


async def _execute_server_side_tool(name: str, args: Dict[str, Any]) -> str:
    """Execute a tool server-side and return JSON result string."""
    if name == "code_visualizer_scan_github":
        repo_url = (args.get("repo_url") or "").strip()
        if not repo_url:
            return json.dumps({"error": "Missing repo_url"})
        payload: Dict[str, Any] = {"repo_url": repo_url}
        if args.get("branch"):
            payload["branch"] = args["branch"]
        if args.get("token"):
            payload["token"] = args["token"]
        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                resp = await client.post(
                    f"{CODE_VISUALIZER_URL}/api/v1/scan/github",
                    json=payload,
                )
                if resp.status_code != 200:
                    return json.dumps({"error": f"Code Visualizer returned {resp.status_code}: {resp.text[:500]}"})
                return resp.text
        except httpx.TimeoutException:
            return json.dumps({"error": "GitHub repo scan timed out (180s). The repo may be too large."})
        except Exception as e:
            return json.dumps({"error": f"Failed to call Code Visualizer: {str(e)}"})

    if name == "graph_janitor_scan_github":
        repo_url = (args.get("repo_url") or "").strip()
        if not repo_url:
            return json.dumps({"error": "Missing repo_url"})
        # Step 1: Scan the GitHub repo (autonomous — no pre-scan needed)
        scan_payload: Dict[str, Any] = {"repo_url": repo_url}
        if args.get("branch"):
            scan_payload["branch"] = args["branch"]
        if args.get("token"):
            scan_payload["token"] = args["token"]
        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                scan_resp = await client.post(
                    f"{CODE_VISUALIZER_URL}/api/v1/scan/github",
                    json=scan_payload,
                )
                if scan_resp.status_code != 200:
                    return json.dumps({"error": f"GitHub scan failed ({scan_resp.status_code}): {scan_resp.text[:500]}"})
                scan_data = scan_resp.json()
                analysis_id = scan_data.get("analysis_id")
                if not analysis_id:
                    return json.dumps({"error": "GitHub scan returned no analysis_id"})
                # Step 2: Run Graph Janitor Agent on the scanned analysis
                gja_payload: Dict[str, Any] = {}
                if args.get("max_proposals"):
                    gja_payload["max_proposals"] = int(args["max_proposals"])
                if args.get("drift_threshold"):
                    gja_payload["drift_threshold"] = float(args["drift_threshold"])
                agent_resp = await client.post(
                    f"{CODE_VISUALIZER_URL}/api/analysis/{analysis_id}/agent/scan",
                    json=gja_payload,
                    timeout=120.0,
                )
                if agent_resp.status_code != 200:
                    return json.dumps({"error": f"Graph Janitor Agent failed ({agent_resp.status_code}): {agent_resp.text[:500]}"})
                return agent_resp.text
        except httpx.TimeoutException:
            return json.dumps({"error": "Graph Janitor GitHub scan timed out."})
        except Exception as e:
            return json.dumps({"error": f"Graph Janitor Agent failed: {str(e)}"})

    return json.dumps({"error": f"Unknown server-side tool: {name}"})


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
    provider_key = ""
    model_name = ""
    if request_body.model_id and request_body.model_id.startswith("resonant-"):
        parts = request_body.model_id.replace("resonant-", "", 1).split("-", 1)
        if len(parts) == 2:
            provider_key, model_name = parts[0], parts[1]

    # Model-aware temperature: lower for weaker models to reduce rambling
    _WEAK_PROVIDERS = {"groq", "together", "fireworks"}
    _WEAK_MODELS = {"llama", "mixtral", "gemma", "phi", "qwen", "mistral"}
    is_weak = provider_key in _WEAK_PROVIDERS or any(w in model_name.lower() for w in _WEAK_MODELS)
    agent_temperature = 0.5 if is_weak else 0.7

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
                ide_metadata=request_body.ide_metadata,
                workspace_layout=request_body.workspace_layout,
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

                use_ollama_proxy = (provider_key == "ollama" and request_body.local_llm is not None)
                llm_done = False

                # ── Local Ollama via client-side proxy ──
                # Server can't reach user's localhost — send request to client,
                # client calls Ollama locally, streams text to UI, POSTs result back.
                if use_ollama_proxy:
                    ollama_cfg = request_body.local_llm or {}
                    llm_req = {
                        "session_id": session.id,
                        "messages": messages,
                        "tools": tools,
                        "tool_choice": loop_tool_choice,
                        "temperature": 0.7,
                        "max_tokens": min(16384, ollama_cfg.get("context_length", 32768)),
                        "model": ollama_cfg.get("model", model_name),
                        "url": ollama_cfg.get("url", "http://localhost:11434"),
                    }
                    yield f"event: llm_proxy_request\ndata: {json.dumps(llm_req)}\n\n"
                    try:
                        llm_result = await asyncio.wait_for(
                            session.llm_result_queue.get(), timeout=300,
                        )
                        if llm_result.get("error"):
                            logger.warning(f"Local Ollama proxy failed: {llm_result['error']}, falling back to cloud...")
                            yield f"event: text\ndata: {json.dumps({'content': chr(10) + '> ⚠️ Local LLM failed: ' + str(llm_result['error'])[:100] + ' — falling back to cloud...' + chr(10)})}\n\n"
                        else:
                            content = llm_result.get("content", "")
                            tool_calls = llm_result.get("tool_calls") or []
                            usage = llm_result.get("usage") or {}
                            if usage:
                                total_tokens += usage.get("total_tokens", 0) or (usage.get("prompt_tokens", 0) + usage.get("completion_tokens", 0))
                            last_provider = "ollama"
                            last_model = llm_result.get("model", model_name)
                            llm_done = True
                    except asyncio.TimeoutError:
                        logger.warning("Local Ollama proxy timed out (300s), falling back to cloud...")
                        yield f"event: text\ndata: {json.dumps({'content': chr(10) + '> ⚠️ Local LLM timed out — falling back to cloud...' + chr(10)})}\n\n"

                # ── Cloud provider call (primary or fallback from Ollama) ──
                if not llm_done:
                    cloud_provider = provider_key if provider_key != "ollama" else "openai"
                    cloud_model = model_name if provider_key != "ollama" else "gpt-4o"
                    try:
                        async for chunk in call_llm_streaming(
                            messages=messages,
                            preferred_provider=cloud_provider,
                            preferred_model=cloud_model,
                            user_keys=user_keys,
                            tools=tools,
                            tool_choice=loop_tool_choice,
                            temperature=agent_temperature,
                            max_tokens=16384,
                            local_llm=None,
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
                                last_provider = chunk.provider or cloud_provider
                                last_model = chunk.model or cloud_model
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

                logger.info(f"Loop {loops}: provider={last_provider} content_len={len(content)} tool_calls={len(tool_calls)} tools_in_request={len(tools)} tool_choice={loop_tool_choice}")

                # Anti-lazy: if first loop returned text but NO tool calls, model is being careless
                # Force a retry with explicit instruction to use tools (use system role, not user, to avoid confusing context)
                if loops == 1 and not tool_calls and content and len(content.strip()) > 50:
                    logger.warning(f"Loop 1: model returned {len(content)} chars text but 0 tool calls — injecting tool reminder")
                    messages.append({"role": "assistant", "content": content})
                    messages.append({"role": "system", "content": "[SYSTEM] You responded with text only. You MUST use tools to investigate. Run commands, read files, or search the codebase. Do not describe what you would do — do it now."})
                    content = ""
                    continue

                # If tool_choice was "required" but model returned nothing, retry with "auto"
                if not tool_calls and not content and loop_tool_choice == "required":
                    logger.info(f"Loop {loops}: tool_choice=required returned empty — retrying with auto")
                    content = ""
                    tool_calls = []
                    fallback_attempt = 0
                    loop_fallback_chain = []
                    llm_done = False

                    if use_ollama_proxy:
                        ollama_cfg = request_body.local_llm or {}
                        llm_req = {
                            "session_id": session.id,
                            "messages": messages,
                            "tools": tools,
                            "tool_choice": "auto",
                            "temperature": 0.7,
                            "max_tokens": min(16384, ollama_cfg.get("context_length", 32768)),
                            "model": ollama_cfg.get("model", model_name),
                            "url": ollama_cfg.get("url", "http://localhost:11434"),
                        }
                        yield f"event: llm_proxy_request\ndata: {json.dumps(llm_req)}\n\n"
                        try:
                            llm_result = await asyncio.wait_for(
                                session.llm_result_queue.get(), timeout=300,
                            )
                            if not llm_result.get("error"):
                                content = llm_result.get("content", "")
                                tool_calls = llm_result.get("tool_calls") or []
                                usage = llm_result.get("usage") or {}
                                if usage:
                                    total_tokens += usage.get("total_tokens", 0) or (usage.get("prompt_tokens", 0) + usage.get("completion_tokens", 0))
                                last_provider = "ollama"
                                last_model = llm_result.get("model", model_name)
                                llm_done = True
                        except asyncio.TimeoutError:
                            pass

                    if not llm_done:
                        cloud_provider = provider_key if provider_key != "ollama" else "openai"
                        cloud_model = model_name if provider_key != "ollama" else "gpt-4o"
                        try:
                            async for chunk in call_llm_streaming(
                                messages=messages,
                                preferred_provider=cloud_provider,
                                preferred_model=cloud_model,
                                user_keys=user_keys,
                                tools=tools,
                                tool_choice="auto",
                                temperature=0.7,
                                max_tokens=16384,
                                local_llm=None,
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
                                    last_provider = chunk.provider or cloud_provider
                                    last_model = chunk.model or cloud_model
                                    if loop_fallback_chain:
                                        fallback_chain.extend(loop_fallback_chain)
                                elif chunk.event == "error":
                                    yield f"event: error\ndata: {json.dumps({'error': chunk.error})}\n\n"
                                    return
                        except Exception as e:
                            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
                            return
                    logger.info(f"Loop {loops} (retry auto): content_len={len(content)} tool_calls={len(tool_calls)}")

                if not tool_calls:
                    break

                # ── Execute tools ──
                for tc in tool_calls:
                    tc_name = tc["function"]["name"]
                    tc_id = tc.get("id") or f"call_{loops}_{total_tool_calls}"
                    tc_args_str = tc["function"].get("arguments", "{}")

                    try:
                        tc_args = json.loads(tc_args_str) if isinstance(tc_args_str, str) else tc_args_str
                    except json.JSONDecodeError:
                        tc_args = {}

                    total_tool_calls += 1

                    # Server-side tools: execute directly, don't send to client
                    if tc_name in _SERVER_SIDE_TOOLS:
                        yield f"event: execute_tool\ndata: {json.dumps({'session_id': session.id, 'tool_call_id': tc_id, 'name': tc_name, 'arguments': tc_args, 'server_side': True})}\n\n"
                        logger.info(f"Executing server-side tool: {tc_name} args={json.dumps(tc_args)[:200]}")
                        tool_result = await _execute_server_side_tool(tc_name, tc_args)
                        is_error = '"error"' in tool_result
                        # Stream tool result preview to client so user sees server-side output
                        try:
                            preview = tool_result[:4000] if len(tool_result) > 4000 else tool_result
                            yield f"event: tool_output\ndata: {json.dumps({'tool_call_id': tc_id, 'name': tc_name, 'preview': preview})}\n\n"
                        except Exception:
                            pass
                        yield f"event: tool_done\ndata: {json.dumps({'tool_call_id': tc_id, 'name': tc_name, 'status': 'error' if is_error else 'ok'})}\n\n"
                    else:
                        # Client-side tools: send to client, wait for result
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

                    # Track LOC for file write/edit tools (fire-and-forget)
                    if tc_name in _FILE_WRITE_TOOLS and not is_error:
                        asyncio.ensure_future(_track_loc_event(
                            user_id=user_id,
                            session_id=session.id,
                            tool_name=tc_name,
                            tool_args=tc_args,
                            tool_result=tool_result,
                        ))

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
                    # Always preserve the user's original request (first user message after system + context)
                    user_msg = None
                    for m in messages[1:]:
                        if m.get("role") == "user":
                            user_msg = m
                            break
                    recent = messages[-20:]
                    messages = [system] + recent
                    # Re-inject original user request right after system if it was dropped
                    if user_msg and user_msg not in recent:
                        messages.insert(1, user_msg)
                    _compress_old_messages(messages)

                # Emit loop progress so client sees reasoning between loops
                if loops < max_loops:
                    yield f"event: thinking\ndata: {json.dumps({'message': f'Analyzing results... (loop {loops}, {total_tool_calls} tools used)'})}\n\n"

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


@router.post("/agent-stream/{session_id}/llm-result")
async def submit_llm_result(
    session_id: str,
    request_body: LLMResultRequest,
    request: Request,
):
    """Client submits local LLM (Ollama) completion result. Server resumes agentic loop."""
    auth_header = request.headers.get("authorization", "")
    auth_token = auth_header.replace("Bearer ", "") if auth_header.startswith("Bearer ") else ""
    user_id = request.headers.get("x-user-id") or auth_token[:20] or ""
    if not user_id:
        raise HTTPException(status_code=401, detail="Authentication required")

    session = _get_or_fail(session_id)

    await session.llm_result_queue.put({
        "content": request_body.content,
        "tool_calls": request_body.tool_calls or [],
        "usage": request_body.usage or {},
        "model": request_body.model,
        "error": request_body.error,
    })

    return {"status": "ok", "session_id": session_id}
