/**
 * Tool definitions for Resonant AI — organized by CATEGORY for smart filtering.
 * Only relevant tool categories are sent per query to reduce token waste.
 */
type ToolDef = { type: 'function'; function: { name: string; description: string; parameters: Record<string, any> } };
const F = 'function' as const;

// ── CORE: always sent (~12 tools) ──
const TOOLS_CORE: ToolDef[] = [
  { type: F, function: { name: 'file_read', description: 'Read file. Use offset/limit for large files. Returns numbered lines.', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['path'] } } },
  { type: F, function: { name: 'file_write', description: 'Create or overwrite file. Auto-creates parent directories.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: F, function: { name: 'file_edit', description: 'Replace exact unique string in file. Set replace_all=true to replace all occurrences.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' }, explanation: { type: 'string', description: 'Brief description of the change' } }, required: ['path', 'old_string', 'new_string'] } } },
  { type: F, function: { name: 'multi_edit', description: 'Atomic batch edits on one file. All edits succeed or none applied.', parameters: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array', items: { type: 'object', properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['old_string', 'new_string'] } }, explanation: { type: 'string', description: 'Brief description of the change' } }, required: ['path', 'edits'] } } },
  { type: F, function: { name: 'file_list', description: 'List directory contents with type and path.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: F, function: { name: 'grep_search', description: 'Search text pattern in files. Uses ripgrep (fast) with grep fallback.', parameters: { type: 'object', properties: { path: { type: 'string' }, pattern: { type: 'string' }, include: { type: 'string', description: 'Glob filter e.g. "*.py"' }, case_sensitive: { type: 'boolean' }, match_per_line: { type: 'boolean', description: 'Show surrounding context (3 lines) with matches' }, fixed_strings: { type: 'boolean', description: 'Treat pattern as literal string (no regex)' } }, required: ['path', 'pattern'] } } },
  { type: F, function: { name: 'find_by_name', description: 'Find files by name glob. Uses fd (fast) with find fallback.', parameters: { type: 'object', properties: { path: { type: 'string' }, pattern: { type: 'string' }, type: { type: 'string', description: 'file, directory, or any' }, max_depth: { type: 'number' }, extensions: { type: 'array', items: { type: 'string' }, description: 'File extensions without dot e.g. ["py", "ts"]' }, excludes: { type: 'array', items: { type: 'string' }, description: 'Additional directories to exclude' }, full_path: { type: 'boolean', description: 'Match pattern against full absolute path instead of just filename' } }, required: ['path', 'pattern'] } } },
  { type: F, function: { name: 'run_command', description: 'Run shell command. Set blocking=false for long-running processes. Set safe_to_auto_run=false for destructive commands (shows user confirmation).', parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, blocking: { type: 'boolean', description: 'false = async background mode (default: true = blocking)' }, wait_ms_before_async: { type: 'number', description: 'For async mode: ms to wait before going background' }, safe_to_auto_run: { type: 'boolean', description: 'false = show confirmation dialog (for destructive commands like rm, git push, etc.)' } }, required: ['command'] } } },
  { type: F, function: { name: 'command_status', description: 'Check status of background command by ID. Returns output and exit code.', parameters: { type: 'object', properties: { command_id: { type: 'string' }, wait_seconds: { type: 'number', description: 'Wait up to N seconds for completion (max 60)' }, output_character_count: { type: 'number', description: 'Number of output chars to return (default 5000, max 50000)' } }, required: ['command_id'] } } },
  { type: F, function: { name: 'read_terminal', description: 'Read output from a terminal session by process ID or name.', parameters: { type: 'object', properties: { process_id: { type: 'string' }, name: { type: 'string' } }, required: [] } } },
  { type: F, function: { name: 'file_delete', description: 'Delete file or directory recursively.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: F, function: { name: 'file_move', description: 'Move or rename file/directory. Auto-creates parent dirs.', parameters: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' } }, required: ['source', 'destination'] } } },
];

// ── GIT ──
const TOOLS_GIT: ToolDef[] = [
  { type: F, function: { name: 'git_status', description: 'Working tree status.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: F, function: { name: 'git_diff', description: 'Show diff.', parameters: { type: 'object', properties: { path: { type: 'string' }, staged: { type: 'boolean' }, file: { type: 'string' } }, required: ['path'] } } },
  { type: F, function: { name: 'git_log', description: 'Commit log.', parameters: { type: 'object', properties: { path: { type: 'string' }, count: { type: 'number' }, file: { type: 'string' } }, required: ['path'] } } },
  { type: F, function: { name: 'git_commit', description: 'Stage and commit.', parameters: { type: 'object', properties: { path: { type: 'string' }, message: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } }, required: ['path', 'message'] } } },
  { type: F, function: { name: 'git_push', description: 'Push to remote.', parameters: { type: 'object', properties: { path: { type: 'string' }, remote: { type: 'string' }, branch: { type: 'string' } }, required: ['path'] } } },
  { type: F, function: { name: 'git_pull', description: 'Pull from remote.', parameters: { type: 'object', properties: { path: { type: 'string' }, remote: { type: 'string' }, branch: { type: 'string' } }, required: ['path'] } } },
  { type: F, function: { name: 'git_branch', description: 'List/create/switch branches.', parameters: { type: 'object', properties: { path: { type: 'string' }, action: { type: 'string' }, name: { type: 'string' } }, required: ['path'] } } },
];

// ── WEB ──
const TOOLS_WEB: ToolDef[] = [
  { type: F, function: { name: 'search_web', description: 'Web search via DuckDuckGo. Use domain to filter results to a specific site.', parameters: { type: 'object', properties: { query: { type: 'string' }, domain: { type: 'string', description: 'Optional domain filter e.g. "github.com"' } }, required: ['query'] } } },
  { type: F, function: { name: 'read_url_content', description: 'Fetch URL text content. Large pages auto-chunked with document_id for pagination.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: F, function: { name: 'view_content_chunk', description: 'Read a specific chunk of previously fetched URL content by document_id and position.', parameters: { type: 'object', properties: { document_id: { type: 'string' }, position: { type: 'number' } }, required: ['document_id', 'position'] } } },
  { type: F, function: { name: 'browser_check', description: 'Check if a URL is reachable and returning expected content. Returns HTTP status, latency, final URL, and a small content snippet. Use this to verify frontend is actually loaded.', parameters: { type: 'object', properties: { url: { type: 'string' }, expect: { type: 'string', description: 'Optional substring to assert exists in body (e.g. "<div id=\\"root\\"" or app name)' }, timeout_seconds: { type: 'number', description: 'Max seconds to wait (default 15)' } }, required: ['url'] } } },
  { type: F, function: { name: 'browser_preview', description: 'Open URL in VS Code webview panel with console log capture. Returns preview_id for reading logs.', parameters: { type: 'object', properties: { url: { type: 'string' }, name: { type: 'string', description: 'Display name for the preview tab' } }, required: ['url'] } } },
  { type: F, function: { name: 'read_browser_logs', description: 'Read captured console logs from a browser preview by preview_id.', parameters: { type: 'object', properties: { preview_id: { type: 'string' } }, required: ['preview_id'] } } },
];

// ── CODEBASE INTELLIGENCE ENGINE (Code Visualizer) ──
// NOT just a "visualizer" — a full codebase analysis platform that performs:
// AST-based static analysis (Python/JS/TS), microservice discovery, dependency mapping,
// dead code detection, pipeline auto-detection, governance enforcement, architecture drift
// monitoring, multi-repo comparison, and Graph Janitor health scoring.
// Input: local paths, GitHub repos (single/multi), archive uploads.
// Output: full graph (nodes + connections), governance reports, pipeline traces, health scores.
// Persists results to PostgreSQL + Hash Sphere memory. Credit-billed (200/analysis, 50/governance).
const TOOLS_VISUALIZER: ToolDef[] = [
  { type: F, function: { name: 'code_visualizer_scan', description: 'AST-scan project: discovers services, functions, classes, endpoints, imports, pipelines, dead code. Works with local paths or GitHub URLs.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path or GitHub URL' } }, required: ['path'] } } },
  { type: F, function: { name: 'code_visualizer_functions', description: 'List all functions and API endpoints from a scan. Returns names, files, lines, decorators, HTTP routes.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: F, function: { name: 'code_visualizer_trace', description: 'Trace dependency flow from any node (function/service/endpoint). Follows imports, calls, HTTP, DB queries both directions.', parameters: { type: 'object', properties: { path: { type: 'string' }, query: { type: 'string', description: 'Node name e.g. "login", "POST /api/users"' }, max_depth: { type: 'number' } }, required: ['path', 'query'] } } },
  { type: F, function: { name: 'code_visualizer_governance', description: 'Architecture governance: reachability analysis, forbidden deps, drift detection, CI pass/fail, health score 0-100.', parameters: { type: 'object', properties: { path: { type: 'string' }, drift_threshold: { type: 'number' } }, required: ['path'] } } },
  { type: F, function: { name: 'code_visualizer_graph', description: 'Get full dependency graph: all nodes and connections with metadata.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: F, function: { name: 'code_visualizer_pipeline', description: 'Get auto-detected pipeline flow (user_registration, user_login, chat_flow, memory_pipeline, agent_execution, billing_flow).', parameters: { type: 'object', properties: { path: { type: 'string' }, pipeline_name: { type: 'string' } }, required: ['path', 'pipeline_name'] } } },
  { type: F, function: { name: 'code_visualizer_filter', description: 'Filter graph by file path, node type, or keyword.', parameters: { type: 'object', properties: { path: { type: 'string' }, file_path: { type: 'string' }, node_type: { type: 'string', description: 'function, class, api_endpoint, service, file, import, external_service, database' }, keyword: { type: 'string' } }, required: ['path'] } } },
  { type: F, function: { name: 'code_visualizer_by_type', description: 'Get all nodes of a type: function, class, api_endpoint, service, file, import, external_service, database.', parameters: { type: 'object', properties: { path: { type: 'string' }, node_type: { type: 'string', description: 'function, class, api_endpoint, service, file, import, external_service, database' } }, required: ['path', 'node_type'] } } },
];

// ── PLANNING & MEMORY ──
const TOOLS_PLANNING: ToolDef[] = [
  { type: F, function: { name: 'todo_list', description: 'Create/update task list with id, content, status (pending/in_progress/completed), priority (high/medium/low).', parameters: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, content: { type: 'string' }, status: { type: 'string' }, priority: { type: 'string' } }, required: ['id', 'content', 'status', 'priority'] } } }, required: ['todos'] } } },
  { type: F, function: { name: 'ask_user', description: 'Ask user a question with optional structured options (labels + descriptions). Set allow_multiple for multi-select.', parameters: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } } }, description: 'Up to 4 predefined options' }, allow_multiple: { type: 'boolean' } }, required: ['question'] } } },
  { type: F, function: { name: 'save_memory', description: 'Save content to persistent memory (syncs to Hash Sphere server when authenticated, local fallback).', parameters: { type: 'object', properties: { key: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['key', 'content'] } } },
  { type: F, function: { name: 'read_memory', description: 'Read memories by key, tag filter, or semantic query. Query searches server Hash Sphere when available.', parameters: { type: 'object', properties: { key: { type: 'string' }, tag: { type: 'string' }, query: { type: 'string', description: 'Natural language query for semantic retrieval' } }, required: [] } } },
  { type: F, function: { name: 'create_memory', description: 'Create/update/delete persistent memories with CRUD operations.', parameters: { type: 'object', properties: { action: { type: 'string', description: 'create, update, or delete' }, title: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, id: { type: 'string', description: 'Required for update/delete' } }, required: ['action'] } } },
  { type: F, function: { name: 'code_search', description: 'Search codebase with multi-pass strategy. Extracts terms, finds matching files, returns context. Uses ripgrep when available.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Natural language search query' }, path: { type: 'string' } }, required: ['query'] } } },
];

// ── NOTEBOOKS ──
const TOOLS_NOTEBOOKS: ToolDef[] = [
  { type: F, function: { name: 'read_notebook', description: 'Read Jupyter notebook.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: F, function: { name: 'edit_notebook', description: 'Edit notebook cell.', parameters: { type: 'object', properties: { path: { type: 'string' }, cell_number: { type: 'number' }, new_source: { type: 'string' }, cell_type: { type: 'string' }, edit_mode: { type: 'string' } }, required: ['path', 'cell_number', 'new_source'] } } },
];

// ── PLATFORM API ──
const TOOLS_PLATFORM: ToolDef[] = [
  { type: F, function: { name: 'platform_api_search', description: 'Search 450+ Resonant Genesis platform API endpoints by keyword or category. Categories: agents (autonomous AI agents), sessions, teams, workflows (multi-step pipelines), chat (Resonant Chat conversations), billing, memory (Hash Sphere persistent memory), blockchain (on-chain anchoring), notifications, marketplace, autonomy (scheduled tasks), rabbit (social), storage, ide, auth, user, hash_sphere_sim (Invariants SIM — constraint-governed simulation for trust networks, identity graphs, economic systems with 6 conservation laws: mass, energy, identity uniqueness, causality, trust bounds, non-negative value. Models users/agents/services/contracts with DSIDs, trust scores, value transfers. NOT literal physics. Used for fraud detection, anomaly detection, trust propagation, compliance auditing).', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query (e.g. "create agent", "check trust invariants", "simulate universe", "billing usage", "fraud detection")' }, category: { type: 'string', description: 'Filter to specific category (e.g. hash_sphere_sim, agents, billing)' } }, required: ['query'] } } },
  { type: F, function: { name: 'platform_api_call', description: 'Call any platform API endpoint directly. Requires authentication. Admin/internal paths are blocked.', parameters: { type: 'object', properties: { method: { type: 'string', description: 'HTTP method: GET, POST, PUT, DELETE' }, path: { type: 'string', description: 'API path e.g. /api/v1/agents' }, body: { type: 'object', description: 'Request body for POST/PUT' } }, required: ['method', 'path'] } } },
];

// ── DEPLOY ──
const TOOLS_DEPLOY: ToolDef[] = [
  { type: F, function: { name: 'deploy_web_app', description: 'Build and deploy a web app. Auto-detects framework. Deploys via platform API when authenticated, otherwise provides manual deploy instructions.', parameters: { type: 'object', properties: { project_path: { type: 'string' }, framework: { type: 'string', description: 'nextjs, react, svelte, vue, astro, static' }, subdomain: { type: 'string', description: 'Custom subdomain for deployment URL' } }, required: ['project_path'] } } },
  { type: F, function: { name: 'check_deploy_status', description: 'Check status of a deployment by ID.', parameters: { type: 'object', properties: { deployment_id: { type: 'string' } }, required: ['deployment_id'] } } },
  { type: F, function: { name: 'read_deployment_config', description: 'Read project deploy config (package.json, framework detection).', parameters: { type: 'object', properties: { project_path: { type: 'string' } }, required: ['project_path'] } } },
  { type: F, function: { name: 'ssh_run', description: 'Run a non-interactive SSH command on a remote host (uses system ssh). Requires SSH keys already configured on this machine. Use for droplet checks and deploy steps.', parameters: { type: 'object', properties: { host: { type: 'string', description: 'Host or IP (e.g. "134.199.221.149")' }, user: { type: 'string', description: 'SSH user (e.g. "deploy")' }, port: { type: 'number', description: 'SSH port (default 22)' }, command: { type: 'string', description: 'Remote shell command to run' } }, required: ['host', 'user', 'command'] } } },
  { type: F, function: { name: 'droplet_docker_status', description: 'Accurate Docker status on droplet: counts running/stopped containers and lists docker compose projects. Uses server-side counting (not truncated). Requires SSH keys.', parameters: { type: 'object', properties: { host: { type: 'string' }, user: { type: 'string' }, port: { type: 'number' } }, required: [] } } },
  { type: F, function: { name: 'droplet_deploy_frontend', description: 'Deploy frontend on the droplet using the standard build + rsync + nginx reload flow. Assumes deploy@134.199.221.149 and /home/deploy/genesis2026_frontend_production_2 by default. Requires SSH keys.', parameters: { type: 'object', properties: { host: { type: 'string' }, user: { type: 'string' }, repo_dir: { type: 'string', description: 'Repo working directory on droplet' }, web_root: { type: 'string', description: 'Nginx web root to rsync into' }, branch: { type: 'string', description: 'Branch name (default main)' } }, required: [] } } },
];

// ── MCP (Model Context Protocol) ──
const TOOLS_MCP: ToolDef[] = [
  { type: F, function: { name: 'list_mcp_resources', description: 'List resources from registered MCP servers.', parameters: { type: 'object', properties: { server_name: { type: 'string', description: 'Specific server name, or omit for all servers' } }, required: [] } } },
  { type: F, function: { name: 'read_mcp_resource', description: 'Read content from an MCP server resource by URI.', parameters: { type: 'object', properties: { server_name: { type: 'string' }, uri: { type: 'string' } }, required: ['server_name', 'uri'] } } },
];

// ── WORKFLOWS ──
const TOOLS_WORKFLOWS: ToolDef[] = [
  { type: F, function: { name: 'list_workflows', description: 'List available workflows from .resonant/workflows/*.md files.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: F, function: { name: 'run_workflow', description: 'Load and execute a named workflow from .resonant/workflows/.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Workflow name (filename without .md)' } }, required: ['name'] } } },
];

// ── INTERACTIVE TERMINAL ──
// Persistent shell sessions with full I/O capture. The LLM can create terminals,
// send input (text, special keys like Ctrl+C), read output, and interact with
// running programs (REPLs, dev servers, interactive installers, SSH, etc.).
// Unlike run_command (fire-and-forget), these are persistent sessions visible
// in the VS Code terminal panel — both the user and the LLM can interact.
const TOOLS_TERMINAL: ToolDef[] = [
  { type: F, function: { name: 'terminal_create', description: 'Create a new persistent interactive terminal session. Opens a real shell (bash/zsh) in the VS Code terminal panel. Both the user and the AI can interact with it. Use for: dev servers, REPLs (python, node, psql), interactive installers (npm init), SSH sessions, long-running processes you need to monitor and interact with. Returns a session_id for subsequent commands.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Display name for the terminal tab (e.g. "Dev Server", "Python REPL")' }, cwd: { type: 'string', description: 'Working directory (defaults to workspace root)' }, shell: { type: 'string', description: 'Shell to use (defaults to user default shell, e.g. /bin/zsh)' } }, required: [] } } },
  { type: F, function: { name: 'terminal_send', description: 'Send text input to an interactive terminal session. Automatically appends Enter (newline) unless the text already ends with one. For special keys use key names: ctrl+c, ctrl+d, ctrl+z, ctrl+l, enter, tab, escape, up, down, left, right, backspace, delete, home, end. Use for: answering prompts (y/n), typing commands, sending Ctrl+C to stop a process, navigating REPL history.', parameters: { type: 'object', properties: { session_id: { type: 'string' }, input: { type: 'string', description: 'Text to send, or special key name (e.g. "ctrl+c", "y", "npm install")' } }, required: ['session_id', 'input'] } } },
  { type: F, function: { name: 'terminal_send_raw', description: 'Send raw text to a terminal WITHOUT appending newline. Use for partial input, special escape sequences, or when you need precise control over what is sent.', parameters: { type: 'object', properties: { session_id: { type: 'string' }, input: { type: 'string' } }, required: ['session_id', 'input'] } } },
  { type: F, function: { name: 'terminal_read', description: 'Read recent output from an interactive terminal session. Returns clean text (ANSI codes stripped). Use last_n_chars to control how much output to read (default 5000).', parameters: { type: 'object', properties: { session_id: { type: 'string' }, last_n_chars: { type: 'number', description: 'Number of recent characters to return (default 5000, max 50000)' } }, required: ['session_id'] } } },
  { type: F, function: { name: 'terminal_wait', description: 'Wait for new output from a terminal session. Blocks until output appears or timeout. Useful after sending a command — waits for the result to appear. Returns only the NEW output since the call started.', parameters: { type: 'object', properties: { session_id: { type: 'string' }, timeout_ms: { type: 'number', description: 'Max wait time in ms (default 5000, max 30000)' }, stable_ms: { type: 'number', description: 'Consider output stable after this many ms of no new data (default 500)' } }, required: ['session_id'] } } },
  { type: F, function: { name: 'terminal_list', description: 'List all active interactive terminal sessions with IDs, names, alive status, and output buffer sizes.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: F, function: { name: 'terminal_close', description: 'Close an interactive terminal session and kill its process.', parameters: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] } } },
  { type: F, function: { name: 'terminal_clear', description: 'Clear the captured output buffer for a terminal session. Does not affect the visible terminal — only clears the internal buffer the AI reads from.', parameters: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] } } },
];

// ── VISUAL ──
const TOOLS_VISUAL: ToolDef[] = [
  { type: F, function: { name: 'visualize', description: 'Generate an inline SVG diagram, chart, or interactive widget rendered directly in chat. Supports: architecture diagrams, flowcharts, sequence diagrams, bar/pie/line charts, entity-relationship diagrams, tree structures, network graphs. Provide SVG code directly OR use Mermaid syntax (auto-converted). For SVG: provide valid SVG markup. For Mermaid: wrap in ```mermaid block. Title is displayed above the visualization.', parameters: { type: 'object', properties: { title: { type: 'string', description: 'Display title for the visualization' }, svg: { type: 'string', description: 'Raw SVG markup (must be valid <svg>...</svg>)' }, mermaid: { type: 'string', description: 'Mermaid diagram syntax (alternative to SVG). e.g. "graph TD; A-->B; B-->C;"' }, width: { type: 'number', description: 'Width in pixels (default 600)' }, height: { type: 'number', description: 'Height in pixels (default 400)' } }, required: ['title'] } } },
  { type: F, function: { name: 'image_search', description: 'Search the web for images. Returns URLs and metadata for relevant images. Useful when building UIs, finding icons, reference designs, or visual inspiration. Results include thumbnail URLs, source pages, and dimensions.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Image search query (e.g. "modern dashboard UI design", "login page mockup", "blue gradient background")' }, count: { type: 'number', description: 'Number of results (default 5, max 10)' } }, required: ['query'] } } },
];

// ── CHECKPOINTS ──
const TOOLS_CHECKPOINTS: ToolDef[] = [
  { type: F, function: { name: 'save_checkpoint', description: 'Save a conversation checkpoint with summary, key files, and pending tasks for cross-session continuity.', parameters: { type: 'object', properties: { summary: { type: 'string' }, key_files: { type: 'array', items: { type: 'string' } }, pending_tasks: { type: 'array', items: { type: 'string' } } }, required: ['summary'] } } },
  { type: F, function: { name: 'load_checkpoint', description: 'Load the latest conversation checkpoint to resume previous work.', parameters: { type: 'object', properties: {}, required: [] } } },
];

/**
 * Smart tool selection — returns only relevant tool categories based on query.
 * Core tools (~10) always included. Optional categories added by keyword match.
 * Saves ~3K-6K tokens vs sending all 46 tools every request.
 */
export function selectToolsForQuery(query: string): ToolDef[] {
  const q = query.toLowerCase();
  const tools: ToolDef[] = [...TOOLS_CORE];

  // Git
  if (/\b(git|commit|push|pull|branch|merge|diff|stash|rebase|cherry.pick|log|blame)\b/.test(q)) {
    tools.push(...TOOLS_GIT);
  }
  // Web/URL
  if (/\b(http|url|web|search|browse|fetch|download|api|endpoint|curl)\b/.test(q) || q.includes('://')) {
    tools.push(...TOOLS_WEB);
  }
  // Codebase Intelligence Engine (Code Visualizer) — AST analysis, governance, pipelines, dead code, architecture
  if (/\b(analy[sz]|visuali[sz]|architecture|structure|dependen|import|export|caller|symbol|scan|overview|understand|governance|dead.?code|unused|orphan|reachab|drift|pipeline|microservice|endpoint|graph.?janitor|health.?score|ci.?pass|forbidden.?dep|impact.?analy|trace.?flow|codebase|ast)/.test(q)) {
    tools.push(...TOOLS_VISUALIZER);
  }
  // Planning
  if (/\b(plan|todo|task|step|remember|memory|save|note)\b/.test(q)) {
    tools.push(...TOOLS_PLANNING);
  }
  // Notebooks
  if (/\b(notebook|jupyter|ipynb|cell)\b/.test(q)) {
    tools.push(...TOOLS_NOTEBOOKS);
  }
  // Deploy
  if (/\b(deploy|build|production|release|ship|publish)\b/.test(q)) {
    tools.push(...TOOLS_DEPLOY);
  }
  // Platform API
  if (/\b(platform|api|endpoint|agent|team|workflow|billing|memory|blockchain|notification|marketplace|autonomy|rabbit|storage|state.?physics|invariant|simulation|simulate|entropy|universe|hash.?sphere|trust|fraud|identity|conservation|dsid|anomaly|compliance|economic|gini|asymmetry|perturbation|galaxy)\b/.test(q)) {
    tools.push(...TOOLS_PLATFORM);
  }
  // MCP
  if (/\b(mcp|resource|server|protocol|context)\b/.test(q)) {
    tools.push(...TOOLS_MCP);
  }
  // Workflows
  if (/\b(workflow|skill|slash|recipe|runbook|procedure)\b/.test(q)) {
    tools.push(...TOOLS_WORKFLOWS);
  }
  // Interactive Terminal
  if (/\b(terminal|interactive|repl|persistent.?shell|session|ssh|prompt|ctrl.?c|dev.?server|monitor|psql|redis.cli|python.?repl|node.?repl|docker.?exec)\b/.test(q)) {
    tools.push(...TOOLS_TERMINAL);
  }
  // Visual
  if (/\b(visuali[sz]|diagram|chart|svg|mermaid|flowchart|graph|image|icon|ui.?design|mockup|wireframe|screenshot|picture|photo|illustration)/.test(q)) {
    tools.push(...TOOLS_VISUAL);
  }
  // Checkpoints
  if (/\b(checkpoint|resume|continue|session|summary|save.*progress|load.*progress)\b/.test(q)) {
    tools.push(...TOOLS_CHECKPOINTS);
  }

  // For complex multi-step requests, add planning + visualizer
  if (q.length > 200 || /\b(build|create|implement|refactor|fix.*bug|debug)\b/.test(q)) {
    if (!tools.some(t => t.function.name === 'todo_list')) { tools.push(...TOOLS_PLANNING); }
    if (!tools.some(t => t.function.name === 'code_visualizer_scan')) { tools.push(...TOOLS_VISUALIZER); }
  }

  return tools;
}

// Full set for backward compat
export const LOCAL_TOOL_DEFINITIONS = [
  ...TOOLS_CORE, ...TOOLS_GIT, ...TOOLS_WEB, ...TOOLS_VISUALIZER,
  ...TOOLS_PLANNING, ...TOOLS_NOTEBOOKS, ...TOOLS_DEPLOY,
  ...TOOLS_MCP, ...TOOLS_WORKFLOWS, ...TOOLS_TERMINAL, ...TOOLS_CHECKPOINTS,
  ...TOOLS_PLATFORM, ...TOOLS_VISUAL,
];

// Tool count for logging
export const TOOL_COUNT = LOCAL_TOOL_DEFINITIONS.length;

// All tool names for validation
export const ALL_TOOL_NAMES = new Set(LOCAL_TOOL_DEFINITIONS.map(t => t.function.name));

/**
 * Compact text-based tool descriptions for system prompt.
 * ~800 tokens vs ~15K+ tokens for full OpenAI tool schemas.
 */
export function buildToolsPromptText(): string {
  const categories: [string, ToolDef[]][] = [
    ['FILESYSTEM & COMMANDS', TOOLS_CORE],
    ['GIT', TOOLS_GIT],
    ['WEB', TOOLS_WEB],
    ['CODE ANALYSIS', TOOLS_VISUALIZER],
    ['PLANNING & MEMORY', TOOLS_PLANNING],
    ['NOTEBOOKS', TOOLS_NOTEBOOKS],
    ['DEPLOY', TOOLS_DEPLOY],
    ['PLATFORM API (433+ endpoints)', TOOLS_PLATFORM],
    ['MCP (Model Context Protocol)', TOOLS_MCP],
    ['WORKFLOWS', TOOLS_WORKFLOWS],
    ['INTERACTIVE TERMINAL', TOOLS_TERMINAL],
    ['VISUAL (diagrams, charts, image search)', TOOLS_VISUAL],
    ['CHECKPOINTS', TOOLS_CHECKPOINTS],
  ];
  const lines: string[] = [];
  for (const [cat, tools] of categories) {
    lines.push(`\n  [${cat}]`);
    for (const tool of tools) {
      const fn = tool.function;
      const params = fn.parameters?.properties || {};
      const req = new Set(fn.parameters?.required || []);
      const paramStr = Object.entries(params)
        .map(([k, v]: [string, any]) => `${k}: ${v.type}${req.has(k) ? '' : '?'}`)
        .join(', ');
      lines.push(`  - ${fn.name}(${paramStr}): ${fn.description}`);
    }
  }
  return lines.join('\n');
}

export function buildSystemPrompt(workspaceRoot: string, openFile?: string): string {
  return `You are Resonant AI — the coding assistant inside Resonant IDE by Resonant Genesis.
You are pair-programming with the user and have access to real tools to solve their problems.
Your goal is to take action, not describe what you would do.

## Workspace
- Root: ${workspaceRoot}${openFile ? `\n- Active file: ${openFile}` : ''}

## COMMUNICATION
- Be terse and direct. Minimize output while maintaining quality and accuracy.
- Never start with filler like "Great question!", "I'd be happy to help!", "Absolutely!". Jump straight into the substance.
- Refer to the user as "you" and yourself as "I".
- Always end with a concise status summary of what was done or what's needed next.
- Do not repeat information the user already knows.

## MARKDOWN FORMATTING
- Format all responses with Markdown.
- Use \`backticks\` for variable names, function names, file paths, and code references.
- Use fenced code blocks with language tags (\`\`\`python, \`\`\`json, \`\`\`bash).
- Bold **critical information**. Use headings to section longer responses.
- Use short bullet lists. Bold the title of each list item.

## TOOLS & CODE
- Read files before editing. Use file_edit with exact unique strings. Use multi_edit for batch changes.
- After edits, read the file or run tests to verify.
- Implement changes directly — don't just explain them.
- Always use absolute paths based on workspace root: ${workspaceRoot}
- Prefer small focused edits over rewriting entire files.
- Generated code must be immediately runnable — include all imports and dependencies.
- Follow the existing code style. Do not add or remove comments unless asked.

## SAFETY
- Never make destructive changes without reading first.
- For destructive operations (file deletion, git push, deploy), confirm with the user.
- Never expose API keys or credentials in responses.

You are Resonant AI by Resonant Genesis. Not GPT, Claude, or Llama.`;
}

/**
 * Agentic system prompt — works with NATIVE tool calling (no JSON response format).
 * Tools are passed via the API tools parameter, NOT duplicated in the prompt.
 */
export function buildAgenticSystemPrompt(workspaceRoot: string, openFile?: string): string {
  return `You are Resonant AI — the autonomous coding agent inside Resonant IDE by Resonant Genesis.
You are pair-programming with the user. You have full access to their filesystem and can read, write, edit, search, and run commands.
Your tools are provided via the API — use them directly. Your goal is to take action, not describe what you would do.

## Workspace
- Root: ${workspaceRoot}${openFile ? `\n- Active file: ${openFile}` : ''}

## COMMUNICATION
- Be terse and direct. Minimize output tokens while maintaining quality and accuracy.
- Prefer concise bullet points and short paragraphs over long explanations.
- Never start with filler like "Great question!", "I'd be happy to help!", "Absolutely!", "That makes sense!". Jump straight into the substance.
- Refer to the user as "you" and yourself as "I".
- Always end with a concise status summary of what was done or what's needed next.
- Do not repeat information the user already knows. Do not be redundant.

## MARKDOWN FORMATTING
- Format all responses with Markdown.
- Use \`backticks\` for variable names, function names, file paths, and code references.
- Use fenced code blocks with language tags (\`\`\`python, \`\`\`json, \`\`\`bash).
- Bold **critical information**. Use headings to section longer responses.
- Use short bullet lists. Bold the title of each list item: **item** — description.
- Never use unicode bullet points — use standard markdown list syntax.

## HOW YOU WORK
1. **USE TOOLS IMMEDIATELY.** Never describe what you plan to do — just DO it. Call tools right away.
2. **Execute end-to-end.** If the task needs 10 steps, do all 10. Don't stop halfway.
3. **Batch independent tool calls.** If you need a file listing AND a grep search, call both. Don't serialize independent operations.
4. **Verify your work.** After making changes, read the file to confirm. After running a server, check if it's running. After building frontend, verify output exists.
5. **Search for solutions.** When something doesn't work, search the codebase with grep_search/find_by_name, read docs, check package.json/requirements.txt.
6. **Use absolute paths** based on workspace root: ${workspaceRoot}
7. **Read before editing.** Always read a file with file_read before editing with file_edit.
8. **For long-running commands** (dev servers, builds), use run_command with blocking=false, then check status with command_status.
9. **Write COMPLETE code.** Never use placeholders like "// rest of code here". Include full implementations.
10. **Only respond with text when ALL work is 100% done and verified.** If anything remains — keep using tools.

## CODE
- Generated code must be immediately runnable — include all necessary imports and dependencies.
- Follow the existing code style of the project. Do not add or remove comments unless asked.
- Prefer minimal, focused edits over full rewrites.
- When referencing code, use fenced blocks with the language tag.
- Reference files with backticked absolute paths.

## AGENT OPERATING PROTOCOL
- For multi-step work, maintain a TODO list with todo_list (one item in_progress at a time).
- Prefer small, safe changes over large rewrites.
- If you need a human decision, ask with ask_user (structured options).
- Always show the user clean, human-readable results (never dump raw tool JSON).
- When verifying a web app, use browser_check and/or browser_preview to confirm it loads.
- For server work, use terminal_create for interactive sessions or ssh_run for single commands.

## SAFETY
- For destructive operations (file deletion, git push, deploy, rm -rf), confirm with the user first.
- Never expose API keys, credentials, or secrets in responses.
- If uncertain about something, say so clearly rather than guessing.

## DEBUGGING
- Address root causes, not symptoms.
- Add descriptive logging and error messages to track state.
- Make no ungrounded assertions — do not reference non-existent files or functions.

## ERROR RECOVERY — MANDATORY
**NEVER tell the user to fix something. YOU fix it yourself.**

When something fails:
1. Read the error message carefully
2. Search for the cause (check files, configs, logs, dependencies)
3. Fix it yourself (npm install, pip install, mkdir -p, chmod, edit configs, etc.)
4. Retry the original command
5. If it fails again, try a COMPLETELY DIFFERENT approach
6. Keep going until it WORKS — try at least 3 different approaches before giving up

FORBIDDEN phrases — never say these:
- "Please check...", "Try reinstalling...", "You may need to...", "Please ensure..."
- Instead: DO the check yourself, DO the reinstall, DO whatever is needed.

## PROBLEM SOLVING
- **Stuck on an error?** Search the codebase for similar patterns. Read config files. Check environment variables.
- **Missing dependency?** Install it yourself with npm install / pip install / brew install.
- **File not found?** Use find_by_name to locate it. Check if the path is wrong.
- **Command not found?** Search for the correct command name. Check if the tool needs to be installed.
- **Frontend not loading?** Check the build output, look at the dev server logs, verify the HTML/JS files exist.
- **Backend not responding?** Check if the process is running, read the logs, verify the port and URL.

You are Resonant AI by Resonant Genesis. You DO the work, you don't REPORT problems.`;
}

// Legacy export
export const SYSTEM_PROMPT = buildSystemPrompt('/tmp');
