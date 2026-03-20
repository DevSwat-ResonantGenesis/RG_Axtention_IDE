/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as https from 'https';
import { executeToolCall, setAskUserCallback, setGlobalState, setAuthInfo, retrieveRelevantMemories } from './toolExecutor';
import { LOCAL_TOOL_DEFINITIONS, SYSTEM_PROMPT } from './toolDefinitions';
import { ResonantAuthService } from './authService';

interface LLMMessage {
role: string;
content?: string | null;
tool_calls?: any[];
tool_call_id?: string;
name?: string;
}

export class ResonantChatViewProvider implements vscode.WebviewViewProvider {
private _view?: vscode.WebviewView;
private _conversationMessages: LLMMessage[] = [];

constructor(
	private readonly _context: vscode.ExtensionContext,
	private readonly _authService: ResonantAuthService,
) {
	setGlobalState(_context.globalState);
}

public onAuthChanged(loggedIn: boolean) {
	if (this._view) {
	const user = this._authService.getUser();
	this._view.webview.postMessage({
		type: 'authChanged',
		loggedIn,
		user: user ? { email: user.email, name: user.name } : null,
	});
	}
}

public resolveWebviewView(
	webviewView: vscode.WebviewView,
	_context: vscode.WebviewViewResolveContext,
	_token: vscode.CancellationToken,
) {
	this._view = webviewView;
	webviewView.webview.options = { enableScripts: true };
	webviewView.webview.html = this._getHtml();

	// Send initial auth state
	const loggedIn = this._authService.isLoggedIn();
	const user = this._authService.getUser();
	webviewView.webview.postMessage({
	type: 'authChanged',
	loggedIn,
	user: user ? { email: user.email, name: user.name } : null,
	});

	// Register ask_user callback that posts to webview
	setAskUserCallback(async (question: string, options?: Array<{ label: string; description?: string }>) => {
	return new Promise<string>((resolve) => {
		const listener = webviewView.webview.onDidReceiveMessage((msg) => {
		if (msg.type === 'askUserResponse') {
			listener.dispose();
			resolve(msg.response);
		}
		});
		webviewView.webview.postMessage({ type: 'askUser', question, options });
	});
	});

	webviewView.webview.onDidReceiveMessage(async (msg) => {
	switch (msg.type) {
		case 'sendMessage':
		await this._handleUserMessage(msg.text);
		break;
		case 'newConversation':
		this.newConversation();
		break;
		case 'login':
		this._authService.login();
		break;
		case 'logout':
		this._authService.logout();
		break;
		case 'setApiKey':
		vscode.commands.executeCommand('resonant.setApiKey');
		break;
	}
	});
}

public newConversation() {
	this._conversationMessages = [];
	this._view?.webview.postMessage({ type: 'clear' });
}

private async _handleUserMessage(text: string) {
	const config = vscode.workspace.getConfiguration('resonant');
	const apiUrl = config.get<string>('apiUrl', 'https://dev-swat.com');
	const maxLoops = config.get<number>('maxToolLoops', 15);

	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '/tmp';

	// Add user message
	this._conversationMessages.push({ role: 'user', content: text });
	this._postStep('user', { content: text });
	this._postStep('status', { message: 'Thinking...' });

	// Get auth token from auth service
	const token = this._authService.getToken();
	const authDomain = this._authService.getAuthDomain?.() || apiUrl;
	if (token) { setAuthInfo(token, authDomain); }

	const startTime = Date.now();
	let totalToolCalls = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;

	try {
	let loops = 0;
	while (loops < maxLoops) {
		loops++;
		this._postStep('status', { message: `Loop ${loops}/${maxLoops} — calling LLM...` });

		// Build messages for LLM with auto-injected memories
		let systemContent = SYSTEM_PROMPT;
		try {
		const memoryContext = await retrieveRelevantMemories(text);
		if (memoryContext) systemContent += memoryContext;
		} catch { /* memory retrieval is non-critical */ }
		const llmMessages: LLMMessage[] = [
		{ role: 'system', content: systemContent },
		...this._conversationMessages,
		];

		// Call LLM
		const loopStart = Date.now();
		const result = await this._callLLM(apiUrl, llmMessages, token);
		const llmTime = ((Date.now() - loopStart) / 1000).toFixed(1);

		// Track tokens
		if (result.usage) {
		totalInputTokens += result.usage.prompt_tokens || 0;
		totalOutputTokens += result.usage.completion_tokens || 0;
		}

		if (result.error) {
		this._postStep('error', { message: result.error });
		break;
		}

		// Add assistant response to conversation
		const assistantMsg: LLMMessage = { role: 'assistant', content: result.content };
		if (result.tool_calls && result.tool_calls.length > 0) {
		assistantMsg.tool_calls = result.tool_calls;
		assistantMsg.content = result.content || null;
		}
		this._conversationMessages.push(assistantMsg);

		// If thinking content, show it
		if (result.content) {
		this._postStep('thinking', { message: result.content });
		}

		// If no tool calls, we're done
		if (!result.tool_calls || result.tool_calls.length === 0) {
		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		const tokenInfo = (totalInputTokens + totalOutputTokens) > 0
			? ` · ${totalInputTokens + totalOutputTokens} tokens`
			: '';
		this._postStep('status', { message: `✓ ${loops} loop${loops > 1 ? 's' : ''} · ${totalToolCalls} tool call${totalToolCalls !== 1 ? 's' : ''} · ${elapsed}s${tokenInfo}` });
		this._postStep('done', { content: result.content || 'Done.' });
		break;
		}

		// Execute tool calls — parallel when multiple, sequential when single
		const toolCalls = result.tool_calls;
		this._postStep('status', { message: `Loop ${loops} — executing ${toolCalls.length} tool call${toolCalls.length > 1 ? 's in parallel' : ''}...` });

		const executeOne = async (tc: any) => {
			const toolName = tc.function?.name || 'unknown';
			let toolArgs: any = {};
			try { toolArgs = JSON.parse(tc.function?.arguments || '{}'); } catch { /* skip */ }

			totalToolCalls++;
			this._postStep('tool_call', { tool: toolName, args: toolArgs, id: tc.id, loop: loops });

			const toolStart = Date.now();
			const toolResult = await executeToolCall(tc, workspaceRoot);
			const toolTime = ((Date.now() - toolStart) / 1000).toFixed(1);

			this._postStep('tool_result', { tool: toolName, result: toolResult, id: tc.id, time: toolTime });

			// Auto-open files when read/write/edit
			if (['file_read', 'file_write', 'file_edit', 'multi_edit'].includes(toolName)) {
				const filePath = toolArgs.path;
				if (filePath) {
				try {
					const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
					await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
				} catch { /* file might not exist yet */ }
				}
			}

			return { tc, toolResult };
		};

		// Execute all tool calls in parallel
		const results = await Promise.all(toolCalls.map(executeOne));

		// Add all tool results to conversation
		for (const { tc, toolResult } of results) {
			this._conversationMessages.push({
				role: 'tool',
				tool_call_id: tc.id,
				content: toolResult,
			});
		}

		this._postStep('status', { message: `Loop ${loops} done (LLM: ${llmTime}s) — ${totalToolCalls} tool calls so far` });
	}

	if (loops >= maxLoops) {
		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		this._postStep('error', { message: `Reached max tool loops (${maxLoops}) · ${totalToolCalls} tools · ${elapsed}s` });
	}
	} catch (err: any) {
	this._postStep('error', { message: `Error: ${err.message}` });
	}

	this._postStep('streamEnd', {});
}

private async _callLLM(
	apiUrl: string,
	messages: LLMMessage[],
	token: string,
): Promise<{ content?: string; tool_calls?: any[]; error?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }> {
	try {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (token) {
		if (token.startsWith('RG-')) {
		headers['x-api-key'] = token;
		} else {
		headers['Authorization'] = `Bearer ${token}`;
		}
	}

	const body = JSON.stringify({
		messages,
		tools: LOCAL_TOOL_DEFINITIONS,
		stream: false,
	});

	const url = new URL(`${apiUrl}/api/v1/ide/completions`);
	const responseText = await new Promise<string>((resolve, reject) => {
		const req = https.request({
		hostname: url.hostname,
		port: url.port || 443,
		path: url.pathname,
		method: 'POST',
		headers,
		}, (res) => {
		let data = '';
		res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
		res.on('end', () => {
			if (res.statusCode && res.statusCode >= 400) {
			reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
			} else {
			resolve(data);
			}
		});
		});
		req.on('error', reject);
		req.write(body);
		req.end();
	});

	const data = JSON.parse(responseText);
	const choice = data.choices?.[0];
	if (!choice) { return { error: 'No choices in response' }; }

	return {
		content: choice.message?.content || choice.delta?.content || '',
		tool_calls: choice.message?.tool_calls || [],
		usage: data.usage || undefined,
	};
	} catch (err: any) {
	return { error: `LLM call failed: ${err.message}` };
	}
}

private _postStep(type: string, data: any) {
	this._view?.webview.postMessage({ type: 'step', step: { type, data, timestamp: Date.now() } });
}

private _getHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
font-size: var(--vscode-font-size, 13px);
color: var(--vscode-foreground);
background: var(--vscode-sideBar-background);
height: 100vh;
display: flex;
flex-direction: column;
}
#header {
display: flex; justify-content: space-between; align-items: center;
padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border);
}
#header h3 { font-size: 12px; font-weight: 600; opacity: 0.8; }
.header-actions { display: flex; gap: 4px; align-items: center; }
.header-actions button {
background: none; border: none; color: var(--vscode-foreground); cursor: pointer;
font-size: 11px; opacity: 0.7; padding: 2px 6px;
}
.header-actions button:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); border-radius: 4px; }
#authBar {
display: flex; align-items: center; justify-content: space-between;
padding: 4px 10px; border-bottom: 1px solid var(--vscode-panel-border);
font-size: 11px; background: var(--vscode-editor-background);
}
#authBar .user-info { opacity: 0.8; }
#authBar button {
background: none; border: none; color: var(--vscode-textLink-foreground);
cursor: pointer; font-size: 11px; padding: 1px 4px;
}
#authBar button:hover { text-decoration: underline; }
#loginScreen {
flex: 1; display: flex; flex-direction: column; align-items: center;
justify-content: center; gap: 16px; padding: 20px;
}
#loginScreen h2 { font-size: 18px; font-weight: 600; }
#loginScreen p { font-size: 12px; opacity: 0.7; text-align: center; max-width: 280px; line-height: 1.5; }
.login-btn {
padding: 10px 24px; border-radius: 6px; border: none;
background: var(--vscode-button-background);
color: var(--vscode-button-foreground);
cursor: pointer; font-size: 14px; font-weight: 600; width: 240px;
}
.login-btn:hover { background: var(--vscode-button-hoverBackground); }
.login-btn.secondary {
background: var(--vscode-button-secondaryBackground);
color: var(--vscode-button-secondaryForeground);
font-size: 12px; padding: 8px 20px;
}
.login-btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
#chatArea { flex: 1; display: flex; flex-direction: column; }
#messages {
flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px;
}
.msg { padding: 8px 10px; border-radius: 6px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.msg.user { background: var(--vscode-input-background); align-self: flex-end; max-width: 85%; }
.msg.assistant { background: var(--vscode-editor-background); align-self: flex-start; max-width: 95%; }
.msg.error { color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); }
.step { font-size: 11px; padding: 3px 8px; border-radius: 4px; opacity: 0.9; }
.step.thinking { color: var(--vscode-descriptionForeground); font-style: italic; }
.step.status { color: var(--vscode-descriptionForeground); font-style: italic; }
.step.done { color: #81c784; font-weight: 600; }

/* ── Tool Call Blocks ── */
.tool-block { border-radius: 6px; margin: 4px 0; overflow: hidden; font-size: 12px; border: 1px solid var(--vscode-panel-border); }
.tool-block .tool-header {
  display: flex; align-items: center; gap: 6px; padding: 6px 10px;
  font-size: 11px; font-weight: 600; cursor: pointer; user-select: none;
}
.tool-block .tool-header:hover { filter: brightness(1.1); }
.tool-block .tool-header .tool-icon { font-size: 13px; }
.tool-block .tool-header .tool-name { flex: 1; }
.tool-block .tool-header .tool-time { opacity: 0.6; font-weight: 400; font-size: 10px; }
.tool-block .tool-header .tool-chevron { opacity: 0.5; transition: transform 0.15s; }
.tool-block .tool-header .tool-chevron.open { transform: rotate(90deg); }
.tool-block .tool-body { padding: 0 10px 8px; display: none; }
.tool-block .tool-body.open { display: block; }
.tool-block .tool-body pre {
  margin: 0; padding: 6px 8px; border-radius: 4px; font-size: 11px; line-height: 1.4;
  font-family: var(--vscode-editor-font-family, 'Menlo', monospace);
  white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto;
}

/* Terminal command blocks */
.tool-block.terminal { border-color: rgba(79,195,247,0.3); }
.tool-block.terminal .tool-header { background: rgba(79,195,247,0.1); color: #4fc3f7; }
.tool-block.terminal .tool-body pre { background: rgba(0,0,0,0.25); color: #ccc; }
.tool-block.terminal .cmd-line { color: #4fc3f7; }
.tool-block.terminal .cmd-cwd { color: #81c784; font-size: 10px; opacity: 0.7; }
.tool-block.terminal .cmd-output { color: #b0b0b0; margin-top: 4px; }
.tool-block.terminal .exit-ok { color: #81c784; }
.tool-block.terminal .exit-fail { color: #ef5350; }

/* File operation blocks */
.tool-block.file { border-color: rgba(255,183,77,0.3); }
.tool-block.file .tool-header { background: rgba(255,183,77,0.08); color: #ffb74d; }
.tool-block.file .tool-body pre { background: rgba(0,0,0,0.2); color: #ccc; }
.tool-block.file .file-path { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
.tool-block.file .diff-add { color: #81c784; }
.tool-block.file .diff-del { color: #ef5350; text-decoration: line-through; opacity: 0.7; }

/* Search blocks */
.tool-block.search { border-color: rgba(186,104,200,0.3); }
.tool-block.search .tool-header { background: rgba(186,104,200,0.08); color: #ba68c8; }
.tool-block.search .tool-body pre { background: rgba(0,0,0,0.2); color: #ccc; }

/* Generic tool blocks */
.tool-block.generic { border-color: rgba(129,199,132,0.3); }
.tool-block.generic .tool-header { background: rgba(129,199,132,0.08); color: #81c784; }
.tool-block.generic .tool-body pre { background: rgba(0,0,0,0.2); color: #ccc; }

/* Result status badges */
.result-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 9px; font-weight: 600; margin-left: 6px; }
.result-badge.ok { background: rgba(129,199,132,0.2); color: #81c784; }
.result-badge.fail { background: rgba(239,83,80,0.2); color: #ef5350; }
.result-badge.chars { background: rgba(79,195,247,0.15); color: #4fc3f7; font-weight: 400; }

/* Markdown in assistant messages */
.msg.assistant code { background: rgba(255,255,255,0.08); padding: 1px 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
.msg.assistant pre { background: rgba(0,0,0,0.25); padding: 8px; border-radius: 4px; margin: 6px 0; overflow-x: auto; }
.msg.assistant pre code { background: none; padding: 0; }
.msg.assistant h1, .msg.assistant h2, .msg.assistant h3 { margin: 8px 0 4px; }
.msg.assistant ul, .msg.assistant ol { padding-left: 18px; margin: 4px 0; }
.msg.assistant a { color: var(--vscode-textLink-foreground); }
.msg.assistant strong { color: #e0e0e0; }
.msg.assistant blockquote { border-left: 3px solid var(--vscode-panel-border); padding-left: 8px; opacity: 0.8; margin: 4px 0; }
.ask-user { background: var(--vscode-inputValidation-infoBackground); border: 1px solid var(--vscode-inputValidation-infoBorder); border-radius: 6px; padding: 8px; }
.ask-user .question { font-size: 12px; margin-bottom: 6px; }
.ask-user button { padding: 3px 10px; margin: 2px; border-radius: 4px; border: 1px solid var(--vscode-button-border, #555); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; font-size: 11px; }
.ask-user button:hover { background: var(--vscode-button-secondaryHoverBackground); }
.ask-user input { width: 100%; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-size: 12px; outline: none; }
#inputArea {
padding: 8px; border-top: 1px solid var(--vscode-panel-border);
display: flex; gap: 4px;
}
#inputArea textarea {
flex: 1; padding: 6px 8px; border-radius: 6px;
border: 1px solid var(--vscode-input-border);
background: var(--vscode-input-background);
color: var(--vscode-input-foreground);
font-family: inherit; font-size: 13px; resize: none;
min-height: 32px; max-height: 120px; outline: none;
}
#inputArea button {
padding: 6px 12px; border-radius: 6px; border: none;
background: var(--vscode-button-background);
color: var(--vscode-button-foreground);
cursor: pointer; font-size: 13px; font-weight: 600;
}
#inputArea button:hover { background: var(--vscode-button-hoverBackground); }
#inputArea button:disabled { opacity: 0.5; cursor: not-allowed; }
.hidden { display: none !important; }
</style>
</head>
<body>
<div id="header">
<h3>Resonant AI</h3>
<div class="header-actions">
	<button id="newBtn" title="New conversation">+ New</button>
</div>
</div>

<!-- Auth bar (shown when logged in) -->
<div id="authBar" class="hidden">
<span class="user-info" id="userDisplay"></span>
<button id="logoutBtn">Sign out</button>
</div>

<!-- Login screen (shown when NOT logged in) -->
<div id="loginScreen">
<h2>Resonant AI</h2>
<p>Sign in to your Resonant Genesis account to use AI-powered coding assistance with 59 local tools.</p>
<button class="login-btn" id="loginBtn">Sign in with Resonant Genesis</button>
<button class="login-btn secondary" id="apiKeyBtn">Use API Key</button>
<p style="font-size: 10px; opacity: 0.5; margin-top: 8px;">No account? <a href="https://dev-swat.com/signup" style="color: var(--vscode-textLink-foreground);">Sign up free</a></p>
</div>

<!-- Chat area (shown when logged in) -->
<div id="chatArea" class="hidden">
<div id="messages"></div>
<div id="inputArea">
	<textarea id="input" placeholder="Ask anything..." rows="1"></textarea>
	<button id="sendBtn">&#8593;</button>
</div>
</div>

<script>
const vscode = acquireVsCodeApi();
const loginScreen = document.getElementById('loginScreen');
const chatArea = document.getElementById('chatArea');
const authBar = document.getElementById('authBar');
const userDisplay = document.getElementById('userDisplay');
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const newBtn = document.getElementById('newBtn');
const loginBtn = document.getElementById('loginBtn');
const apiKeyBtn = document.getElementById('apiKeyBtn');
const logoutBtn = document.getElementById('logoutBtn');
let streaming = false;
let isLoggedIn = false;

function setAuthState(loggedIn, user) {
isLoggedIn = loggedIn;
if (loggedIn) {
	loginScreen.classList.add('hidden');
	chatArea.classList.remove('hidden');
	authBar.classList.remove('hidden');
	userDisplay.textContent = user ? (user.name || user.email || 'Signed in') : 'Signed in';
	inputEl.focus();
} else {
	loginScreen.classList.remove('hidden');
	chatArea.classList.add('hidden');
	authBar.classList.add('hidden');
}
}

function addElement(className, html) {
const el = document.createElement('div');
el.className = className;
el.innerHTML = html;
messagesEl.appendChild(el);
messagesEl.scrollTop = messagesEl.scrollHeight;
return el;
}

function escHtml(s) {
return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function truncate(s, max) {
if (!s || s.length <= max) return s;
return s.slice(0, max) + '...';
}

loginBtn.addEventListener('click', () => vscode.postMessage({ type: 'login' }));
apiKeyBtn.addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
logoutBtn.addEventListener('click', () => vscode.postMessage({ type: 'logout' }));
sendBtn.addEventListener('click', send);
newBtn.addEventListener('click', () => vscode.postMessage({ type: 'newConversation' }));
inputEl.addEventListener('keydown', (e) => {
if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

function send() {
const text = inputEl.value.trim();
if (!text || streaming) return;
streaming = true;
sendBtn.disabled = true;
inputEl.value = '';
addElement('msg user', escHtml(text));
vscode.postMessage({ type: 'sendMessage', text });
}

// ── Tool category detection ──
const TERMINAL_TOOLS = ['run_command','command_status','read_terminal','terminal_create','terminal_send','terminal_send_raw','terminal_read','terminal_wait','terminal_list','terminal_close','terminal_clear'];
const FILE_TOOLS = ['file_read','file_write','file_edit','multi_edit','file_delete','file_move','file_list'];
const SEARCH_TOOLS = ['grep_search','find_by_name','code_search','search_web','read_url_content'];
const TOOL_ICONS = {
  terminal: '\u25CF', file: '\u25A0', search: '\u26B2', generic: '\u25C6',
  run_command: '\u25B6', terminal_create: '\u25B6', terminal_send: '\u25B7',
  file_read: '\u25A1', file_write: '\u25A0', file_edit: '\u270E', multi_edit: '\u270E',
  grep_search: '\u2315', find_by_name: '\u2315', code_search: '\u2315',
};

function getToolCategory(name) {
  if (TERMINAL_TOOLS.includes(name)) return 'terminal';
  if (FILE_TOOLS.includes(name)) return 'file';
  if (SEARCH_TOOLS.includes(name)) return 'search';
  return 'generic';
}

function getToolIcon(name) {
  return TOOL_ICONS[name] || TOOL_ICONS[getToolCategory(name)] || '\u25C6';
}

function getToolLabel(name, args) {
  switch (name) {
    case 'run_command': return 'Command' + (args.cwd ? ' in ~/' + args.cwd.split('/').slice(-2).join('/') : '');
    case 'terminal_create': return 'Terminal: ' + (args.name || 'New Session');
    case 'terminal_send': return 'Terminal \u2192 ' + truncate(args.input, 40);
    case 'terminal_read': return 'Terminal \u2190 Read output';
    case 'terminal_wait': return 'Terminal \u23F3 Waiting...';
    case 'terminal_list': return 'Terminal: List sessions';
    case 'terminal_close': return 'Terminal: Close';
    case 'file_read': return 'Read ' + shortPath(args.path);
    case 'file_write': return 'Write ' + shortPath(args.path);
    case 'file_edit': return 'Edit ' + shortPath(args.path);
    case 'multi_edit': return 'Multi-edit ' + shortPath(args.path);
    case 'file_delete': return 'Delete ' + shortPath(args.path);
    case 'file_move': return 'Move ' + shortPath(args.source);
    case 'file_list': return 'List ' + shortPath(args.path);
    case 'grep_search': return 'Search: ' + truncate(args.pattern, 30);
    case 'find_by_name': return 'Find: ' + truncate(args.pattern, 30);
    case 'code_search': return 'Code search: ' + truncate(args.query, 30);
    case 'search_web': return 'Web: ' + truncate(args.query, 30);
    default: return name.replace(/_/g, ' ');
  }
}

function shortPath(p) {
  if (!p) return '';
  const parts = p.split('/');
  return parts.length > 3 ? '.../' + parts.slice(-2).join('/') : p;
}

// ── Render tool call block ──
const _pendingToolBlocks = {};

function renderToolCall(data) {
  const cat = getToolCategory(data.tool);
  const icon = getToolIcon(data.tool);
  const label = getToolLabel(data.tool, data.args || {});

  const block = document.createElement('div');
  block.className = 'tool-block ' + cat;
  block.id = 'tb-' + (data.id || Date.now());

  // Build tool-specific body content
  let bodyContent = '';
  const args = data.args || {};

  if (data.tool === 'run_command' || data.tool === 'terminal_send') {
    const cmd = args.command || args.input || '';
    bodyContent = '<pre>';
    if (args.cwd) bodyContent += '<span class="cmd-cwd">' + escHtml(args.cwd) + '</span>\\n';
    bodyContent += '<span class="cmd-line">\u276F ' + escHtml(cmd) + '</span>';
    bodyContent += '\\n<span class="cmd-output" id="output-' + (data.id||'') + '">Running...</span>';
    bodyContent += '</pre>';
  } else if (data.tool === 'file_edit' || data.tool === 'multi_edit') {
    bodyContent = '<pre>';
    if (args.explanation) bodyContent += escHtml(args.explanation) + '\\n\\n';
    if (args.path) bodyContent += '<span class="file-path">' + escHtml(args.path) + '</span>\\n';
    if (data.tool === 'file_edit') {
      if (args.old_string) bodyContent += '<span class="diff-del">- ' + escHtml(truncate(args.old_string, 200)) + '</span>\\n';
      if (args.new_string) bodyContent += '<span class="diff-add">+ ' + escHtml(truncate(args.new_string, 200)) + '</span>';
    } else if (args.edits && Array.isArray(args.edits)) {
      args.edits.forEach(function(e, i) {
        bodyContent += '\\n[Edit ' + (i+1) + ']\\n';
        if (e.old_string) bodyContent += '<span class="diff-del">- ' + escHtml(truncate(e.old_string, 120)) + '</span>\\n';
        if (e.new_string) bodyContent += '<span class="diff-add">+ ' + escHtml(truncate(e.new_string, 120)) + '</span>';
      });
    }
    bodyContent += '</pre>';
  } else if (data.tool === 'file_write') {
    bodyContent = '<pre>';
    if (args.path) bodyContent += '<span class="file-path">' + escHtml(args.path) + '</span>\\n';
    bodyContent += escHtml(truncate(args.content, 300));
    bodyContent += '</pre>';
  } else if (data.tool === 'file_read') {
    bodyContent = '<pre><span class="file-path">' + escHtml(args.path || '') + '</span>';
    if (args.offset) bodyContent += ' (lines ' + args.offset + '-' + (args.offset + (args.limit||100)) + ')';
    bodyContent += '</pre>';
  } else if (data.tool === 'grep_search' || data.tool === 'find_by_name') {
    bodyContent = '<pre>';
    bodyContent += escHtml(args.pattern || args.query || '');
    if (args.path) bodyContent += '  in ' + escHtml(shortPath(args.path));
    if (args.include) bodyContent += '  [' + escHtml(args.include) + ']';
    bodyContent += '</pre>';
  } else if (data.tool === 'terminal_create') {
    bodyContent = '<pre>Shell: ' + escHtml(args.shell || 'default') + '\\nCWD: ' + escHtml(args.cwd || 'workspace') + '</pre>';
  } else {
    const argStr = JSON.stringify(args, null, 2);
    if (argStr && argStr !== '{}') {
      bodyContent = '<pre>' + escHtml(truncate(argStr, 300)) + '</pre>';
    }
  }

  block.innerHTML =
    '<div class="tool-header" onclick="toggleToolBody(this)">' +
      '<span class="tool-icon">' + icon + '</span>' +
      '<span class="tool-name">' + escHtml(label) + '</span>' +
      '<span class="tool-time" id="time-' + (data.id||'') + '"></span>' +
      '<span class="tool-chevron">\u25B8</span>' +
    '</div>' +
    '<div class="tool-body">' + bodyContent + '</div>';

  messagesEl.appendChild(block);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  _pendingToolBlocks[data.id] = block;
}

function toggleToolBody(header) {
  const body = header.nextElementSibling;
  const chevron = header.querySelector('.tool-chevron');
  if (body.classList.contains('open')) {
    body.classList.remove('open');
    chevron.classList.remove('open');
  } else {
    body.classList.add('open');
    chevron.classList.add('open');
  }
}

// ── Update tool result into existing block ──
function updateToolResult(data) {
  const block = _pendingToolBlocks[data.id];
  if (!block) {
    // Fallback: create a simple result element
    addElement('step tool_result', escHtml(data.tool) + (data.time ? ' (' + data.time + 's)' : '') + ': ' + escHtml(truncate(data.result, 150)));
    return;
  }

  // Update time
  const timeEl = block.querySelector('#time-' + data.id);
  if (timeEl) timeEl.textContent = data.time ? data.time + 's' : '';

  // Parse result for status
  let resultObj = {};
  try { resultObj = JSON.parse(data.result || '{}'); } catch { resultObj = { raw: data.result }; }

  const isError = resultObj.error || resultObj.success === false || (resultObj.code && resultObj.code !== 0);
  const resultChars = (data.result || '').length;

  // Add result badge to header
  const nameEl = block.querySelector('.tool-name');
  if (nameEl) {
    const badge = document.createElement('span');
    badge.className = 'result-badge ' + (isError ? 'fail' : 'ok');
    badge.textContent = isError ? '\u2717' : '\u2713';
    nameEl.appendChild(badge);

    const charBadge = document.createElement('span');
    charBadge.className = 'result-badge chars';
    charBadge.textContent = resultChars > 1000 ? (resultChars/1000).toFixed(1) + 'K' : resultChars + ' chars';
    nameEl.appendChild(charBadge);
  }

  // Update output area for terminal commands
  const outputEl = block.querySelector('#output-' + data.id);
  if (outputEl) {
    let outputText = '';
    if (resultObj.stdout) outputText += resultObj.stdout;
    if (resultObj.stderr) outputText += (outputText ? '\\n' : '') + resultObj.stderr;
    if (resultObj.recent_output) outputText = resultObj.recent_output;
    if (resultObj.output) outputText = resultObj.output;
    if (resultObj.new_output) outputText = resultObj.new_output;
    if (!outputText && resultObj.raw) outputText = truncate(resultObj.raw, 500);
    if (!outputText) outputText = truncate(data.result, 500);

    const exitCode = resultObj.code;
    if (exitCode !== undefined && exitCode !== null) {
      outputText += '\\n' + (exitCode === 0 ? '<span class="exit-ok">\u2713 exit 0</span>' : '<span class="exit-fail">\u2717 exit ' + exitCode + '</span>');
    }
    outputEl.innerHTML = escHtml(truncate(outputText, 1000)).replace(/\\\\n/g, '\\n');
  }

  // For file operations, update the body with result info
  const cat = getToolCategory(data.tool);
  if (cat === 'file' && data.tool === 'file_read') {
    const body = block.querySelector('.tool-body');
    if (body && resultObj.raw) {
      body.innerHTML = '<pre>' + escHtml(truncate(resultObj.raw || data.result, 500)) + '</pre>';
    }
  }

  // Auto-expand on error
  if (isError) {
    const body = block.querySelector('.tool-body');
    const chevron = block.querySelector('.tool-chevron');
    if (body) body.classList.add('open');
    if (chevron) chevron.classList.add('open');
  }

  delete _pendingToolBlocks[data.id];
}

// ── Lightweight markdown renderer ──
function renderMarkdown(text) {
  if (!text) return '';
  var bt = String.fromCharCode(96); // backtick
  var html = escHtml(text);
  // Code blocks
  var cbRe = new RegExp(bt+bt+bt+'(\\\\w*)?\\\\n([\\\\s\\\\S]*?)'+bt+bt+bt, 'g');
  html = html.replace(cbRe, function(m, lang, code) {
    return '<pre><code>' + code.trim() + '</code></pre>';
  });
  // Inline code
  var icRe = new RegExp(bt+'([^'+bt+']+)'+bt, 'g');
  html = html.replace(icRe, '<code>$1</code>');
  // Bold
  html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  // Links
  html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
  // Line breaks
  html = html.replace(/\\n/g, '<br>');
  return html;
}

window.addEventListener('message', (event) => {
const msg = event.data;
if (msg.type === 'authChanged') {
	setAuthState(msg.loggedIn, msg.user);
	return;
}
if (msg.type === 'clear') {
	messagesEl.innerHTML = '';
	return;
}
if (msg.type === 'askUser') {
	const div = document.createElement('div');
	div.className = 'ask-user';
	let html = '<div class="question">' + escHtml(msg.question) + '</div>';
	if (msg.options && msg.options.length > 0) {
	html += '<div>' + msg.options.map(o => '<button class="ask-opt">' + escHtml(o) + '</button>').join('') + '</div>';
	} else {
	html += '<input class="ask-input" placeholder="Type your answer..." />';
	}
	div.innerHTML = html;
	messagesEl.appendChild(div);
	messagesEl.scrollTop = messagesEl.scrollHeight;
	div.querySelectorAll('.ask-opt').forEach(btn => {
	btn.addEventListener('click', () => {
		vscode.postMessage({ type: 'askUserResponse', response: btn.textContent });
		div.remove();
	});
	});
	const inp = div.querySelector('.ask-input');
	if (inp) {
	inp.focus();
	inp.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && inp.value.trim()) {
		vscode.postMessage({ type: 'askUserResponse', response: inp.value.trim() });
		div.remove();
		}
	});
	}
	return;
}
if (msg.type === 'step') {
	const s = msg.step;
	switch (s.type) {
	case 'thinking':
		addElement('step thinking', escHtml(truncate(s.data.message, 200)));
		break;
	case 'tool_call':
		renderToolCall(s.data);
		break;
	case 'tool_result':
		updateToolResult(s.data);
		break;
	case 'done':
		addElement('msg assistant', renderMarkdown(s.data.content || ''));
		break;
	case 'error':
		addElement('msg error', escHtml(s.data.message));
		break;
	case 'status':
		addElement('step status', escHtml(s.data.message));
		break;
	case 'streamEnd':
		streaming = false;
		sendBtn.disabled = false;
		break;
	}
}
});
</script>
</body>
</html>`;
}
}
