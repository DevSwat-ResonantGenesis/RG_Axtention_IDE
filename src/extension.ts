/*---------------------------------------------------------------------------------------------
 *  Resonant AI Extension
 *  Registers as a Language Model Provider + Chat Participant for the built-in Chat panel.
 *  The participant calls /api/v1/ide/completions DIRECTLY with 46+ local tool definitions.
 *  Tool execution happens locally via toolExecutor. Full agentic loop with SSE flow display.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { ResonantAuthService } from './authService';
import { ResonantAuthenticationProvider } from './authProvider';
import { ResonantLanguageModelProvider } from './languageModelProvider';
import { ProfileWebviewProvider } from './profileWebview';
import { SettingsPanelProvider } from './settingsPanel';
import { ResonantAgentProvider } from './agentProvider';
import { ResonantChatViewProvider } from './chatViewProvider';
import { executeToolCall, setAuthInfo, retrieveRelevantMemories, storeConversationSummary } from './toolExecutor';
import { LOCAL_TOOL_DEFINITIONS, buildSystemPrompt, buildAgenticSystemPrompt, ALL_TOOL_NAMES, TOOL_COUNT, selectToolsForQuery } from './toolDefinitions';
import { initLocTracker, trackToolLOC, flushEvents as flushLocEvents, disposeLocTracker, updateLocAuth, getSessionStats, getSessionDelta } from './locTracker';
import { initUpdateChecker, registerCommands as registerUpdateCommands, updateCheckerAuth, disposeUpdateChecker } from './updateChecker';
import { ResonantInlineCompletionProvider, setInlineCompletionAuth, setInlineCompletionModel, setInlineCompletionEnabled } from './inlineCompletionProvider';
import { callLocalCompletions, testLocalConnection, listLocalModels, LocalLLMConfig } from './localLLMProvider';
import { disposeAllSessions as disposeTerminalSessions } from './interactiveTerminal';

// ── Direct HTTP call to /api/v1/ide/completions with SSE parsing ──

interface IdeCompletionResult {
	content: string;
	tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
	usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
	provider?: string;
	model?: string;
}

function callIdeCompletions(
	apiUrl: string,
	authToken: string,
	body: Record<string, unknown>,
	onChunk?: (text: string) => void,
): Promise<IdeCompletionResult> {
	return new Promise((resolve, reject) => {
		const url = new URL(`${apiUrl}/api/v1/ide/completions`);
		const payload = JSON.stringify(body);
		const isHttps = url.protocol === 'https:';
		const reqModule = isHttps ? https : http;

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Accept': 'text/event-stream',
			'Content-Length': String(Buffer.byteLength(payload)),
		};
		if (authToken.startsWith('RG-')) {
			headers['x-api-key'] = authToken;
		} else {
			headers['Authorization'] = `Bearer ${authToken}`;
			headers['Cookie'] = `rg_access_token=${authToken}`;
		}

		let content = '';
		let toolCalls: IdeCompletionResult['tool_calls'] = [];
		let usage: IdeCompletionResult['usage'] = null;
		let provider = '';
		let model = '';
		let buffer = '';

		const req = reqModule.request({
			hostname: url.hostname,
			port: url.port || (isHttps ? 443 : 80),
			path: url.pathname,
			method: 'POST',
			headers,
		}, (res) => {
			if (res.statusCode !== 200) {
				let errBody = '';
				res.on('data', (c: Buffer) => { errBody += c.toString(); });
				res.on('end', () => reject(new Error(`API ${res.statusCode}: ${errBody.slice(0, 300)}`)));
				return;
			}

			res.on('data', (chunk: Buffer) => {
				buffer += chunk.toString();
				const blocks = buffer.split('\n\n');
				buffer = blocks.pop() || '';

				for (const block of blocks) {
					if (!block.trim()) { continue; }
					let event = '';
					let data = '';
					for (const line of block.split('\n')) {
						if (line.startsWith('event: ')) { event = line.slice(7); }
						else if (line.startsWith('data: ')) { data = line.slice(6); }
					}
					if (!data) { continue; }

					try {
						const p = JSON.parse(data);
						switch (event) {
							case 'chunk':
								if (p.content) {
									content += p.content;
									onChunk?.(p.content);
								}
								break;
							case 'tool_calls':
								toolCalls = p.tool_calls || [];
								break;
							case 'done':
								usage = p.usage || null;
								provider = p.provider || '';
								model = p.model || '';
								break;
							case 'error':
								reject(new Error(p.error || 'Unknown backend error'));
								req.destroy();
								return;
						}
					} catch { /* skip malformed SSE */ }
				}
			});

			res.on('end', () => {
				// Parse any remaining buffer
				if (buffer.trim()) {
					const blocks = (buffer + '\n\n').split('\n\n');
					for (const block of blocks) {
						if (!block.trim()) { continue; }
						let event = '';
						let data = '';
						for (const line of block.split('\n')) {
							if (line.startsWith('event: ')) { event = line.slice(7); }
							else if (line.startsWith('data: ')) { data = line.slice(6); }
						}
						if (!data) { continue; }
						try {
							const p = JSON.parse(data);
							if (event === 'chunk' && p.content) { content += p.content; onChunk?.(p.content); }
							if (event === 'tool_calls') { toolCalls = p.tool_calls || []; }
							if (event === 'done') { usage = p.usage || null; provider = p.provider || ''; model = p.model || ''; }
						} catch { /* skip */ }
					}
				}
				resolve({ content, tool_calls: toolCalls, usage, provider, model });
			});

			res.on('error', reject);
		});

		req.on('error', reject);
		req.write(payload);
		req.end();
	});
}

let authService: ResonantAuthService;

export function activate(context: vscode.ExtensionContext) {
	console.log('[Resonant AI] Extension activating...');

	// Register VS Code authentication provider (powers the Sign In button)
	const authProvider = new ResonantAuthenticationProvider(context);
	context.subscriptions.push(authProvider);

	// Auth service for token management
	authService = new ResonantAuthService(context);
	context.subscriptions.push({ dispose: () => authService.dispose() });

	// Register as Language Model Provider for the built-in Chat panel
	const lmProvider = new ResonantLanguageModelProvider(
		context,
		async () => authService.getToken(),
	);
	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider('resonant', lmProvider),
	);
	console.log('[Resonant AI] Registered language model provider "resonant"');

	// Register inline completion provider (ghost text / Copilot-style completions)
	const inlineProvider = new ResonantInlineCompletionProvider();
	context.subscriptions.push(
		vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, inlineProvider)
	);
	// Wire auth for inline completions when token is available
	const wireInlineAuth = () => {
		const token = authService.getToken();
		const config = vscode.workspace.getConfiguration('resonant');
		const apiUrl = (config.get<string>('apiUrl', '') || authService.getAuthDomain()) + '/api/v1/ide/completions';
		if (token) setInlineCompletionAuth(apiUrl, token);
		setInlineCompletionEnabled(config.get<boolean>('inlineCompletions', true));
	};
	wireInlineAuth();
	// Toggle command
	context.subscriptions.push(
		vscode.commands.registerCommand('resonant.toggleInlineCompletions', () => {
			const config = vscode.workspace.getConfiguration('resonant');
			const current = config.get<boolean>('inlineCompletions', true);
			config.update('inlineCompletions', !current, vscode.ConfigurationTarget.Global);
			setInlineCompletionEnabled(!current);
			vscode.window.showInformationMessage(`Resonant AI inline completions: ${!current ? 'ON' : 'OFF'}`);
		})
	);
	console.log('[Resonant AI] Registered inline completion provider');

	// Register as Chat Participant (agent) — full agentic loop with local tool execution.
	// Calls /api/v1/ide/completions DIRECTLY with LOCAL_TOOL_DEFINITIONS.
	const participant = vscode.chat.createChatParticipant(
		'resonant-genesis.resonant-ai.default',
		async (request, chatContext, response, token) => {
			const config = vscode.workspace.getConfiguration('resonant');
			const configuredUrl = config.get<string>('apiUrl', '');
			const apiUrl = configuredUrl || authService.getAuthDomain();
			const authToken = authService.getToken();
			const configuredLoops = config.get<number>('maxToolLoops', 15);
			const maxLoops = configuredLoops === 0 ? 999999 : configuredLoops; // 0 = unlimited
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			const workspaceRoot = workspaceFolder || require('os').homedir();

			// Determine selected model from VS Code model picker (must be before auth check)
			let providerKey = 'groq';
			let modelName = 'llama-3.3-70b-versatile';
			try {
				// VS Code Chat API: request.model is the user's ACTUAL selection from the picker
				const selectedId: string | undefined = (request as any).model?.id;
				if (selectedId && selectedId.startsWith('resonant-')) {
					const parts = selectedId.replace(/^resonant-/, '').split('-');
					providerKey = parts[0];
					modelName = parts.slice(1).join('-');
				} else {
					// Fallback: selectChatModels returns ALL models — pick first (not ideal)
					const models = await vscode.lm.selectChatModels({ vendor: 'resonant' });
					if (models[0]) {
						const id = models[0].id;
						const parts = id.replace(/^resonant-/, '').split('-');
						providerKey = parts[0];
						modelName = parts.slice(1).join('-');
					}
				}
			} catch { /* use defaults */ }

			// Check if using local LLM — only when user explicitly selected a Local model from the picker
			const localLLMConfig = vscode.workspace.getConfiguration('resonant.localLLM');
			const isLocalLLM = providerKey === 'ollama';

			if (!authToken && !isLocalLLM) {
				response.markdown('⚠️ Please sign in first. Use **Resonant AI: Sign In** from the command palette or click the status bar.\n\nAlternatively, enable **Local LLM** mode to use Ollama without an account:\n1. Open Settings → search "resonant localLLM"\n2. Enable `resonant.localLLM.enabled`\n3. Start Ollama: `ollama serve`');
				return;
			}

			// Wire auth info for server-backed memory (only if authenticated)
			if (authToken) {
				setAuthInfo(authToken, apiUrl);
			}

			// Warn if no workspace folder is open
			if (!workspaceFolder) {
				response.markdown('⚠️ **No folder is open.** Please open a project folder first:\n\n1. **File → Open Folder** (or ⌘O)\n2. Select your project directory\n3. Then ask me to analyze it\n\nI need a workspace folder to read files, search code, and run tools.');
				return;
			}

			// Build messages with appropriate system prompt
			const openFile = vscode.window.activeTextEditor?.document.uri.fsPath;
			let systemPrompt: string;
			if (isLocalLLM) {
				// For local LLMs: compact prompt — tools are passed natively via Ollama API
				systemPrompt = `You are Resonant AI — the autonomous coding agent inside Resonant IDE by Resonant Genesis.
You are pair-programming with the user. Your goal is to take action, not describe what you would do.

## Workspace
- Root: ${workspaceRoot}${openFile ? `\n- Active file: ${openFile}` : ''}

## COMMUNICATION
- Be terse and direct. No filler phrases. Jump straight into the substance.
- Format with Markdown: \`backticks\` for code/paths, fenced blocks with language tags, **bold** for critical info.
- Always end with a concise status summary.

## HOW YOU WORK
1. **USE TOOLS IMMEDIATELY.** Never describe what you plan to do — just DO it.
2. **Execute end-to-end.** If the task needs 10 steps, do all 10.
3. **Batch independent tool calls.** Don't serialize independent operations.
4. **Verify your work.** Read files after editing. Check servers after starting.
5. **Read before editing.** Always read a file before editing it.
6. **Use absolute paths** based on workspace root: ${workspaceRoot}
7. **For long-running commands**, use run_command with blocking=false.
8. **Write COMPLETE code.** Never use placeholders. Include full implementations.

## ERROR RECOVERY — MANDATORY
NEVER tell the user to fix something. YOU fix it yourself.
When a command fails:
- Diagnose the error from the output
- Fix it yourself (npm install, pip install, mkdir -p, etc.)
- Retry the original command
- If it still fails, try a completely different approach
- Keep going until it WORKS

FORBIDDEN: "Please check...", "Try reinstalling...", "The command failed, please..."
You DO the work, you don't REPORT problems.`;
			} else {
				systemPrompt = buildAgenticSystemPrompt(workspaceRoot, openFile);
			}

			// Auto-inject relevant memories from Hash Sphere / local store
			try {
				const memoryContext = await retrieveRelevantMemories(request.prompt);
				if (memoryContext) systemPrompt += memoryContext;
			} catch { /* memory retrieval is non-critical */ }

			const messages: Array<Record<string, unknown>> = [
				{ role: 'system', content: systemPrompt },
			];
			// Add conversation history — last 40 messages (expanded for longer context)
			const historyMsgs: Array<Record<string, unknown>> = [];
			for (const turn of chatContext.history) {
				if (turn instanceof vscode.ChatRequestTurn) {
					historyMsgs.push({ role: 'user', content: turn.prompt });
				} else if (turn instanceof vscode.ChatResponseTurn) {
					let text = '';
					for (const part of turn.response) {
						if (part instanceof vscode.ChatResponseMarkdownPart) {
							text += part.value.value;
						}
					}
					// Strip our own metrics footer from assistant history so the LLM doesn't copy/paste it
					// Footer format:
					// ---
					// *🔧 ...*
					// *✏️ Session LOC: ...*
					if (text) {
						let cleaned = text;
						cleaned = cleaned.replace(/\n\n---\n\*🔧[\s\S]*?\*\n?/g, '\n');
						cleaned = cleaned.replace(/\n\*✏️ Session LOC:[^\n]*\n?/g, '\n');
						cleaned = cleaned.trim();
						if (cleaned) { historyMsgs.push({ role: 'assistant', content: cleaned }); }
					}
				}
			}
			for (const msg of historyMsgs.slice(-40)) {
				messages.push(msg);
			}
			messages.push({ role: 'user', content: request.prompt });

			const locStart = getSessionStats();
			// ── Agentic Loop (native tool calling — tools sent via API parameter) ──
			const startTime = Date.now();
			let totalToolCalls = 0;
			let totalTokens = 0;
			let loops = 0;
			let lastProvider = '';
			let lastModel = '';

			try {
				while (loops < maxLoops && !token.isCancellationRequested) {
					loops++;
					let contentStreamed = false;
					let streamBuffer = '';
					let isJsonStream = false;
					response.progress(`Thinking... (loop ${loops})`);

					// Route through local LLM or server
					let result: IdeCompletionResult;
					if (isLocalLLM) {
						const localUrl = localLLMConfig.get<string>('url', 'http://localhost:11434');
						const localModel = modelName || localLLMConfig.get<string>('model', 'llama3.1:8b');
						const ctxLen = localLLMConfig.get<number>('contextLength', 32768);
						const localResult = await callLocalCompletions(
							{ enabled: true, url: localUrl, model: localModel, contextLength: ctxLen },
							messages as Array<Record<string, unknown>>,
							LOCAL_TOOL_DEFINITIONS as Array<Record<string, unknown>>, // native Ollama tool calling
						);
						result = {
							content: localResult.content,
							tool_calls: localResult.tool_calls,
							usage: localResult.usage,
							provider: 'ollama',
							model: localResult.model,
						};
					} else {
						// Retry with backoff on 429 rate limit errors
						let retries = 0;
						const maxRetries = 3;
						while (true) {
							try {
								result = await callIdeCompletions(apiUrl, authToken, {
									messages,
									tools: selectToolsForQuery(request.prompt),
									model: modelName,
									preferred_provider: providerKey,
									temperature: 0.7,
									max_tokens: 16384,
								}, (text) => {
									streamBuffer += text;
									// Detect JSON early and suppress — check for JSON patterns
									const trimmed = streamBuffer.trimStart();
									if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.includes('"action"')) {
										isJsonStream = true;
										return;
									}
									if (isJsonStream) return;
									// Wait for enough chars to be sure it's not JSON before streaming
									if (streamBuffer.length < 10) return;
									if (!contentStreamed) {
										// First time streaming — flush entire buffer
										response.markdown(streamBuffer);
									} else {
										response.markdown(text);
									}
									contentStreamed = true;
								});
								break; // success
							} catch (err: unknown) {
								const msg = err instanceof Error ? err.message : String(err);
								if (msg.includes('429') && retries < maxRetries) {
									retries++;
									const waitSec = retries * 20; // 20s, 40s, 60s
									response.markdown(`\n> ⏳ Rate limit hit — waiting ${waitSec}s before retry (${retries}/${maxRetries})…\n`);
									await new Promise(r => setTimeout(r, waitSec * 1000));
									continue;
								}
								throw err; // non-429 or max retries exceeded
							}
						}
					}

					// Track tokens and provider info
					if (result.usage) {
						totalTokens += result.usage.total_tokens || (result.usage.prompt_tokens || 0) + (result.usage.completion_tokens || 0);
					}
					if (result.provider) lastProvider = result.provider;
					if (result.model) lastModel = result.model;

					// Helper: resolve paths against workspace root
					const resolvePath = (p: string | undefined): string => {
						if (!p) return workspaceRoot;
						if (require('path').isAbsolute(p)) return p;
						return require('path').join(workspaceRoot, p);
					};

					// Helper: short display path for UI
					const shortPath = (p: string): string => {
						if (!p) return '';
						if (p.startsWith(workspaceRoot + '/')) return p.slice(workspaceRoot.length + 1);
						const parts = p.split('/');
						return parts.length > 3 ? '.../' + parts.slice(-2).join('/') : p;
					};

					// Helper: execute a single tool call and display results
					const executeSingleTool = async (toolName: string, toolArgs: Record<string, any>, callId: string): Promise<{ result: string; charCap: number }> => {
						// Normalize arg names before rendering (same as toolExecutor.ts)
						toolArgs.path = toolArgs.path || toolArgs.file_path || toolArgs.file || toolArgs.filename;
						toolArgs.content = toolArgs.content || toolArgs.text || toolArgs.code || toolArgs.data;
						toolArgs.command = toolArgs.command || toolArgs.cmd || toolArgs.shell_command || toolArgs.CommandLine;
						toolArgs.pattern = toolArgs.pattern || toolArgs.query || toolArgs.search || toolArgs.regex;
						toolArgs.cwd = toolArgs.cwd || toolArgs.working_directory || toolArgs.directory || toolArgs.Cwd;
						toolArgs.input = toolArgs.input || toolArgs.text;

						// Show tool call with rich Cascade-style rendering
						const TERMINAL_TOOLS = ['run_command','command_status','read_terminal','terminal_create','terminal_send','terminal_send_raw','terminal_read','terminal_wait','terminal_list','terminal_close','terminal_clear'];
						const FILE_TOOLS = ['file_read','file_write','file_edit','multi_edit','file_delete','file_move','file_list'];
						const SEARCH_TOOLS = ['grep_search','find_by_name','code_search','search_web','read_url_content'];

						let toolLabel = '';
						let codePreview = '';
						const trunc = (s: string, n: number) => s && s.length > n ? s.slice(0, n) + '…' : (s || '');

						if (toolName === 'run_command') {
							const cmd = (toolArgs.command || '').slice(0, 120);
							const cwd = toolArgs.cwd ? shortPath(toolArgs.cwd) : '';
							toolLabel = `Command${cwd ? ' in `' + cwd + '`' : ''}`;
							codePreview = `\n\`\`\`sh\n${cmd}\n\`\`\`\n`;
						} else if (toolName === 'terminal_create') {
							toolLabel = `Terminal: ${toolArgs.name || 'New Session'} (${toolArgs.shell || 'default'})`;
						} else if (toolName === 'terminal_send') {
							toolLabel = `Terminal →`;
							codePreview = `\n\`\`\`\n${trunc(toolArgs.input || '', 80)}\n\`\`\`\n`;
						} else if (toolName === 'terminal_read' || toolName === 'terminal_wait') {
							toolLabel = `Terminal ← Read output`;
						} else if (toolName === 'file_read') {
							toolLabel = `Read \`${shortPath(toolArgs.path || '')}\`${toolArgs.offset ? ` (lines ${toolArgs.offset}-${toolArgs.offset + (toolArgs.limit || 100)})` : ''}`;
						} else if (toolName === 'file_write') {
							toolLabel = `Write \`${shortPath(toolArgs.path || '')}\``;
							if (toolArgs.content) {
								const ext = (toolArgs.path || '').split('.').pop() || '';
								const lang = ext === 'ts' || ext === 'tsx' ? 'typescript' : ext === 'js' || ext === 'jsx' ? 'javascript' : ext === 'py' ? 'python' : ext === 'md' ? 'markdown' : ext === 'html' ? 'html' : ext === 'css' ? 'css' : ext === 'json' ? 'json' : '';
								codePreview = `\n\`\`\`${lang}\n${trunc(toolArgs.content, 500)}\n\`\`\`\n`;
							}
						} else if (toolName === 'file_edit') {
							const exp = toolArgs.explanation ? ` — ${toolArgs.explanation}` : '';
							toolLabel = `Edit \`${shortPath(toolArgs.path || '')}\`${exp}`;
							if (toolArgs.old_string || toolArgs.new_string) {
								codePreview = '\n\`\`\`diff\n';
								if (toolArgs.old_string) codePreview += toolArgs.old_string.split('\n').slice(0, 8).map((l: string) => '- ' + l).join('\n') + '\n';
								if (toolArgs.new_string) codePreview += toolArgs.new_string.split('\n').slice(0, 8).map((l: string) => '+ ' + l).join('\n') + '\n';
								codePreview += '\`\`\`\n';
							}
						} else if (toolName === 'multi_edit') {
							const n = Array.isArray(toolArgs.edits) ? toolArgs.edits.length : '?';
							const exp = toolArgs.explanation ? ` — ${toolArgs.explanation}` : '';
							toolLabel = `Multi-edit \`${shortPath(toolArgs.path || '')}\` (${n} edits)${exp}`;
							if (Array.isArray(toolArgs.edits) && toolArgs.edits.length > 0) {
								codePreview = '\n\`\`\`diff\n';
								for (const e of toolArgs.edits.slice(0, 3)) {
									if (e.old_string) codePreview += '- ' + trunc(e.old_string, 80) + '\n';
									if (e.new_string) codePreview += '+ ' + trunc(e.new_string, 80) + '\n';
								}
								if (toolArgs.edits.length > 3) codePreview += `... and ${toolArgs.edits.length - 3} more edits\n`;
								codePreview += '\`\`\`\n';
							}
						} else if (toolName === 'grep_search') {
							toolLabel = `Search: \`${trunc(toolArgs.pattern || '', 40)}\` in \`${shortPath(toolArgs.path || '')}\``;
						} else if (toolName === 'find_by_name') {
							toolLabel = `Find: \`${trunc(toolArgs.pattern || '', 40)}\` in \`${shortPath(toolArgs.path || '')}\``;
						} else if (toolName === 'code_search') {
							toolLabel = `Code search: \`${trunc(toolArgs.query || '', 40)}\``;
						} else if (toolName === 'visualize') {
							toolLabel = `Visualize: **${trunc(toolArgs.title || '', 60)}** (${toolArgs.svg ? 'SVG' : 'Mermaid'})`;
						} else if (toolName === 'image_search') {
							toolLabel = `Image search: \`${trunc(toolArgs.query || '', 50)}\``;
						} else if (toolName === 'command_status') {
							toolLabel = `Checking command status`;
						} else if (toolName === 'read_terminal' || toolName === 'terminal_read') {
							toolLabel = `Reading terminal output`;
						} else if (toolName === 'terminal_wait') {
							toolLabel = `Waiting for terminal`;
						} else if (toolName === 'terminal_list') {
							toolLabel = `Listing terminals`;
						} else if (toolName === 'terminal_close' || toolName === 'terminal_clear') {
							toolLabel = `Terminal: ${toolName.replace('terminal_', '')}`;
						} else if (toolName === 'ssh_run') {
							toolLabel = `SSH run`;
							if (toolArgs.host) {
								toolLabel += ` · ${toolArgs.user ? toolArgs.user + '@' : ''}${toolArgs.host}`;
							}
							if (toolArgs.command) {
								codePreview = `\n\`\`\`sh\n${trunc(toolArgs.command || '', 160)}\n\`\`\`\n`;
							}
						} else if (toolName === 'droplet_deploy_frontend') {
							toolLabel = `Droplet deploy: frontend`;
						} else if (toolName === 'browser_check') {
							toolLabel = `Browser check: · \`${trunc(toolArgs.url || '', 60)}\``;
						} else if (toolName === 'search_web') {
							toolLabel = `Web search: \`${trunc(toolArgs.query || '', 50)}\``;
						} else if (toolName === 'read_url_content') {
							toolLabel = `Reading URL: \`${trunc(toolArgs.url || '', 60)}\``;
						} else if (toolName === 'file_list') {
							toolLabel = `List files in \`${shortPath(toolArgs.path || '')}\``;
						} else if (toolName === 'file_delete') {
							toolLabel = `Delete \`${shortPath(toolArgs.path || '')}\``;
						} else if (toolName === 'file_move') {
							toolLabel = `Move \`${shortPath(toolArgs.source || '')}\` → \`${shortPath(toolArgs.destination || '')}\``;
						} else {
							toolLabel = `${toolName.replace(/_/g, ' ')}`;
						}

						response.markdown(`\n\n> ⚡ ${toolLabel}\n`);
						if (codePreview) { response.markdown(codePreview); }

						// Check if tool exists
						if (!ALL_TOOL_NAMES.has(toolName)) {
							const errMsg = `Tool '${toolName}' not found.`;
							response.markdown(`> ❌ **Error:** ${errMsg}\n`);
							return { result: JSON.stringify({ error: errMsg }), charCap: 8000 };
						}

						// Execute tool locally
						const toolStart = Date.now();
						let toolResult: string;
						try {
							const fakeTC = { id: callId, type: 'function' as const, function: { name: toolName, arguments: JSON.stringify(toolArgs) } };
							toolResult = await executeToolCall(fakeTC, workspaceRoot);
						} catch (err: unknown) {
							toolResult = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
						}
						const toolTime = ((Date.now() - toolStart) / 1000).toFixed(1);
						totalToolCalls++;

						// Show result preview with pass/fail indicator
						const cvTool = toolName.startsWith('code_visualizer_');
						const charCap = cvTool ? 4000 : 3000; // Cap tool results to reduce token consumption
						const sentChars = Math.min(toolResult.length, charCap);
						const isError = toolResult.includes('"error"');
						const statusIcon = isError ? '❌' : '✅';
						if (isError) {
							let errDetail = '';
							try { errDetail = JSON.parse(toolResult).error || JSON.parse(toolResult).stderr || ''; } catch { /* skip */ }
							response.markdown(`> ${statusIcon} **${toolTime}s**${errDetail ? ' — ' + trunc(errDetail.replace(/\n/g, ' '), 80) : ''}\n`);
						} else if (toolName === 'run_command') {
							try {
								const cr = JSON.parse(toolResult);
								const stdout = (cr.stdout || '').trim();
								if (stdout) {
									const outLines = stdout.split('\n').slice(0, 6);
									response.markdown(`> ${statusIcon} **${toolTime}s**\n\`\`\`\n${outLines.join('\n')}${stdout.split('\n').length > 6 ? '\n…' : ''}\n\`\`\`\n`);
								} else {
									response.markdown(`> ${statusIcon} **${toolTime}s**\n`);
								}
							} catch { response.markdown(`> ${statusIcon} **${toolTime}s**\n`); }
						} else if (toolName === 'command_status') {
							try {
								const cs = JSON.parse(toolResult);
								const status = cs.status || cs.state || 'done';
								const output = (cs.output || cs.stdout || '').trim();
								if (output) {
									const outLines = output.split('\n').slice(0, 6);
									response.markdown(`> ${statusIcon} **${toolTime}s** — ${status}\n\`\`\`\n${outLines.join('\n')}${output.split('\n').length > 6 ? '\n…' : ''}\n\`\`\`\n`);
								} else {
									response.markdown(`> ${statusIcon} **${toolTime}s** — ${status}\n`);
								}
							} catch { response.markdown(`> ${statusIcon} **${toolTime}s**\n`); }
						} else if (toolName === 'file_read') {
							response.markdown(`> ${statusIcon} **${toolTime}s** — ${sentChars.toLocaleString()} chars\n`);
						} else if (['grep_search', 'find_by_name', 'code_search'].includes(toolName)) {
							try {
								const sr = JSON.parse(toolResult);
								const cnt = sr.matches?.length || sr.results?.length || sr.files?.length || 0;
								response.markdown(`> ${statusIcon} **${toolTime}s** — ${cnt} result${cnt !== 1 ? 's' : ''}\n`);
							} catch { response.markdown(`> ${statusIcon} **${toolTime}s**\n`); }
						} else if (['file_write', 'file_edit', 'multi_edit'].includes(toolName)) {
							try {
								const er = JSON.parse(toolResult);
								response.markdown(`> ${statusIcon} **${toolTime}s** — ${er.edited ? 'saved' : 'done'}\n`);
							} catch { response.markdown(`> ${statusIcon} **${toolTime}s**\n`); }
						} else {
							response.markdown(`> ${statusIcon} **${toolTime}s**\n`);
						}

						// Track LOC for write/edit operations
						if (['file_write', 'file_edit', 'multi_edit'].includes(toolName) && !isError) {
							trackToolLOC(toolName, toolArgs);
						}

						// Render visualizations in a webview panel
						if (toolName === 'visualize' && !isError) {
							try {
								const vizResult = JSON.parse(toolResult);
								const { getVisualization } = require('./toolExecutor');
								const viz = getVisualization(vizResult.visualization_id);
								if (viz) {
									if (viz.mermaid) {
										response.markdown(`\n### ${viz.title}\n\`\`\`mermaid\n${viz.mermaid}\n\`\`\`\n`);
									} else if (viz.svg) {
										const panel = vscode.window.createWebviewPanel('resonantViz', viz.title, vscode.ViewColumn.Beside, { enableScripts: false });
										panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:0;padding:20px;background:#1e1e1e;display:flex;justify-content:center;align-items:center;min-height:100vh}svg{max-width:100%;height:auto}</style></head><body>${viz.svg}</body></html>`;
										response.markdown(`\n> 📊 **${viz.title}** — opened in panel\n`);
									}
								}
							} catch { /* rendering failed, result still sent to LLM */ }
						}

						// Render image search results in a webview panel (VS Code chat blocks external images)
						if (toolName === 'image_search' && !isError) {
							try {
								const imgResult = JSON.parse(toolResult);
								if (imgResult.results && imgResult.results.length > 0) {
									const images = imgResult.results.slice(0, 10);
									const imageCards = images.map((img: any, idx: number) => `
										<div class="card" id="card-${idx}">
											<div class="img-wrap">
												<img src="${img.thumbnail || img.url}" alt="${(img.title || '').replace(/"/g, '&quot;')}" loading="lazy"
													onerror="this.parentElement.innerHTML='<div class=\\'fallback\\'>⚠️ Failed to load</div>'" />
											</div>
											<div class="info">
												<span class="title">${(img.title || 'Untitled').replace(/</g, '&lt;')}</span>
												<span class="meta">${img.source || ''} ${img.width && img.height ? `· ${img.width}×${img.height}` : ''}</span>
												<a class="open-link" href="${img.url}" target="_blank">Open full size ↗</a>
											</div>
										</div>`).join('');
									const panel = vscode.window.createWebviewPanel(
										'resonantImages',
										`Images: ${imgResult.query}`,
										vscode.ViewColumn.Beside,
										{ enableScripts: true, retainContextWhenHidden: true }
									);
									const cspSrc = panel.webview.cspSource;
									panel.webview.html = `<!DOCTYPE html><html><head>
										<meta charset="UTF-8">
										<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data: ${cspSrc}; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
										<style>
											*{box-sizing:border-box}
											body{margin:0;padding:20px;background:#1e1e1e;color:#ccc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
											h2{color:#fff;margin:0 0 16px;font-size:18px;font-weight:600}
											.src-badge{display:inline-block;background:#0e639c;color:#fff;font-size:10px;padding:2px 8px;border-radius:4px;margin-left:8px;vertical-align:middle}
											.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
											.card{background:#2d2d2d;border-radius:10px;overflow:hidden;transition:transform .15s,box-shadow .15s;border:1px solid #3d3d3d}
											.card:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.4);border-color:#0e639c}
											.img-wrap{width:100%;height:200px;background:#252525;position:relative}
											.img-wrap img{width:100%;height:100%;object-fit:cover;display:block}
											.fallback{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#666;font-size:13px;background:#2a2a2a}
											.info{padding:10px 12px}
											.title{display:block;font-size:13px;color:#eee;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
											.meta{display:block;font-size:11px;color:#888;margin-top:4px}
											.open-link{display:inline-block;margin-top:6px;font-size:11px;color:#4fc1ff;text-decoration:none}
											.open-link:hover{text-decoration:underline}
										</style></head><body>
										<h2>🔍 ${imgResult.query} — ${images.length} results <span class="src-badge">${imgResult.source || 'web'}</span></h2>
										<div class="grid">${imageCards}</div>
									</body></html>`;
									response.markdown(`\n> 🖼️ **${images.length} images** for "${imgResult.query}" — opened in panel\n`);
								}
							} catch { /* rendering failed */ }
						}

						// Auto-open files when read/write/edit (resolve path!)
						if (FILE_TOOLS.includes(toolName)) {
							const filePath = resolvePath(toolArgs.path || toolArgs.source);
							if (filePath && filePath !== workspaceRoot) {
								try {
									const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
									await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
								} catch { /* file might not exist yet */ }
							}
						}

						return { result: toolResult, charCap };
					};

					// Helper: smart-summarize tool results for message history (reduce tokens sent to LLM)
					const summarizeForHistory = (toolName: string, raw: string, cap: number): string => {
						if (raw.length <= cap) return raw;
						try {
							const parsed = JSON.parse(raw);
							// file_read: keep first+last lines, drop middle
							if (toolName === 'file_read' && parsed.content) {
								const lines = parsed.content.split('\n');
								if (lines.length > 40) {
									const head = lines.slice(0, 20).join('\n');
									const tail = lines.slice(-10).join('\n');
									return JSON.stringify({ ...parsed, content: `${head}\n\n... (${lines.length - 30} lines omitted) ...\n\n${tail}` }).slice(0, cap);
								}
							}
							// run_command: keep first lines of stdout/stderr
							if ((toolName === 'run_command' || toolName === 'command_status') && (parsed.stdout || parsed.output)) {
								const out = (parsed.stdout || parsed.output || '').slice(0, cap - 200);
								return JSON.stringify({ ...parsed, stdout: out, output: undefined }).slice(0, cap);
							}
							// grep/find: keep only first N matches
							if (parsed.matches && Array.isArray(parsed.matches) && parsed.matches.length > 10) {
								return JSON.stringify({ ...parsed, matches: parsed.matches.slice(0, 10), _truncated: `${parsed.matches.length - 10} more omitted` }).slice(0, cap);
							}
						} catch { /* not JSON, fall through */ }
						// Generic truncation with indicator
						return raw.slice(0, cap - 40) + `\n\n... (truncated, ${raw.length} total chars)`;
					};

					// Helper: compress old messages to save tokens when trimming history
					const compressOldMessages = (msgs: Array<Record<string, unknown>>): void => {
						// Compress tool results older than the last 6 messages to 1-line summaries
						const cutoff = msgs.length - 6;
						for (let i = 1; i < cutoff; i++) {
							const m = msgs[i];
							if (m.role === 'tool' && typeof m.content === 'string' && (m.content as string).length > 200) {
								m.content = `[Tool result for ${m.name || 'unknown'}: ${(m.content as string).length} chars — compressed]`;
							}
							if (m.role === 'user' && typeof m.content === 'string' && (m.content as string).startsWith('Tool result for ') && (m.content as string).length > 200) {
								const firstLine = (m.content as string).split('\n')[0];
								m.content = `${firstLine} [${(m.content as string).length} chars — compressed]`;
							}
						}
					};

					// ── Handle native tool_calls from SSE ──
					// Note: Claude often returns BOTH text content AND tool_calls in the same response.
					// We must process tool_calls regardless of whether content is present.
					if (result.tool_calls && result.tool_calls.length > 0) {
						// Show any reasoning/text the LLM provided alongside the tool calls
						// (skip if already streamed in real-time via onChunk)
						if (result.content?.trim() && !contentStreamed && !isJsonStream) {
							response.markdown(`\n${result.content.trim()}\n`);
						}
						for (const tc of result.tool_calls) {
							const toolName = tc.function?.name || '';
							let toolArgs: Record<string, any> = {};
							try { toolArgs = JSON.parse(tc.function?.arguments || '{}'); } catch { /* skip */ }
							const { result: toolResult, charCap } = await executeSingleTool(toolName, toolArgs, tc.id || `call_${loops}`);
							// Use proper tool message format so backend can convert to Anthropic tool_result blocks
							messages.push({
								role: 'assistant',
								content: result.content || '',
								tool_calls: [tc],
							} as any);
							messages.push({
								role: 'tool',
								tool_call_id: tc.id || `call_${loops}`,
								name: toolName,
								content: summarizeForHistory(toolName, toolResult, charCap),
							} as any);
						}
						if (messages.length > 22) {
							const system = messages[0];
							const recent = messages.slice(-20);
							messages.length = 0;
							messages.push(system, ...recent);
							compressOldMessages(messages);
						}
						continue;
					}

					// ── Parse content: extract clean text, handle JSON fallback ──
					const raw = result.content || '';
					let parsed: any = null;
					try {
						parsed = JSON.parse(raw);
					} catch {
						const m = raw.match(/\{[\s\S]*\}/);
						if (m) { try { parsed = JSON.parse(m[0]); } catch { /* give up */ } }
					}

					if (!parsed) {
						// Plain text response (expected with native tool calling)
						if (raw && !contentStreamed) {
							response.markdown(raw);
						}
						// For local LLMs: nudge to use tools if it just outputs text
						if (isLocalLLM && raw && loops < maxLoops - 1 && totalToolCalls === 0) {
							messages.push({ role: 'assistant', content: raw });
							messages.push({ role: 'user', content: 'You must use your tools to accomplish the task. Do not describe what you plan to do — call the appropriate tool NOW. Use file_read to read files, file_write to create files, run_command to execute commands.' });
							continue;
						}
						break;
					}

					let action = parsed.action || 'respond';

					// ── Normalize non-standard JSON formats into {action, tool, args} ──

					// Format A: OpenAI-style {type:"function", name:"tool", parameters:{...}}
					if (parsed.type === 'function' && parsed.name) {
						action = 'tool_call';
						parsed.tool = parsed.name;
						parsed.args = parsed.parameters || parsed.arguments || parsed.args || {};
					}
					// Format A2: {function:{name:"tool", arguments:"{...}"}}
					else if (parsed.function?.name) {
						action = 'tool_call';
						parsed.tool = parsed.function.name;
						let fnArgs = parsed.function.arguments || parsed.function.parameters || {};
						if (typeof fnArgs === 'string') { try { fnArgs = JSON.parse(fnArgs); } catch { fnArgs = {}; } }
						parsed.args = fnArgs;
					}
					// Format B: Flat {tool:"name", args:{...}} without action field
					else if (!parsed.action && parsed.tool && ALL_TOOL_NAMES.has(parsed.tool)) {
						action = 'tool_call';
					}
					// Format C: LLM puts tool name in action field
					else if (action !== 'tool_call' && action !== 'respond' && action !== 'parallel_tool_calls' && ALL_TOOL_NAMES.has(action)) {
						parsed.tool = action;
						action = 'tool_call';
					}
					// Format D: Array of tool calls [{tool, args}, ...]
					else if (Array.isArray(parsed)) {
						const validCalls = parsed.filter((c: any) => c.tool && ALL_TOOL_NAMES.has(c.tool));
						if (validCalls.length > 0) {
							action = 'parallel_tool_calls';
							parsed = { action: 'parallel_tool_calls', calls: validCalls, reasoning: '' };
						}
					}

					if (action === 'parallel_tool_calls' && Array.isArray(parsed.calls)) {
						// ── Parallel tool execution ──
						const reasoning = parsed.reasoning || '';
						if (reasoning) { response.markdown(`\n*${reasoning}*\n`); }

						const calls: Array<{ tool: string; args: Record<string, any> }> = parsed.calls;
						response.progress(`Executing ${calls.length} tools in parallel...`);

						// Execute all tools concurrently
						const results = await Promise.all(
							calls.map((c, i) => executeSingleTool(c.tool || '', c.args || {}, `call_${loops}_${i}`))
						);

						// Build combined tool results message
						messages.push({ role: 'assistant', content: raw });
						const combinedResults = calls.map((c, i) => {
							const r = results[i];
							return `Tool result for ${c.tool}:\n${summarizeForHistory(c.tool, r.result, r.charCap)}`;
						}).join('\n\n---\n\n');
						messages.push({ role: 'user', content: combinedResults });

						// Keep messages bounded
						if (messages.length > 22) {
							const system = messages[0];
							const recent = messages.slice(-20);
							messages.length = 0;
							messages.push(system, ...recent);
							compressOldMessages(messages);
						}
						continue;

					} else if (action === 'tool_call') {
						const toolName = parsed.tool || '';
						const toolArgs = parsed.args || {};
						const reasoning = parsed.reasoning || '';

						if (reasoning) {
							response.markdown(`\n*${reasoning}*\n`);
						}

						const { result: toolResult, charCap } = await executeSingleTool(toolName, toolArgs, `call_${loops}`);

						// Add messages like backend agentic-chat: assistant JSON + tool result as user message
						messages.push({ role: 'assistant', content: raw });
						messages.push({ role: 'user', content: `Tool result for ${toolName}:\n${summarizeForHistory(toolName, toolResult, charCap)}` });

						// Keep messages bounded — system prompt + last 20 messages
						if (messages.length > 22) {
							const system = messages[0];
							const recent = messages.slice(-20);
							messages.length = 0;
							messages.push(system, ...recent);
							compressOldMessages(messages);
						}

						continue;
					} else {
						// action === 'respond' or unknown — but check for give-up patterns first
						const content = parsed.content || raw;
						const contentLower = (content || '').toLowerCase();
						const GIVE_UP_PATTERNS = [
							'please check', 'please verify', 'please ensure', 'please try',
							'try reinstalling', 'try running', 'you may need to', 'you might need to',
							'you should', 'you\'ll need to', 'you need to', 'you can try',
							'manually', 'on your own', 'yourself',
							'was not successful', 'were issues with', 'could not be', 'unable to',
							'command not found', 'not installed', 'failed to',
						];
						const isGiveUp = totalToolCalls > 0 && loops < maxLoops - 2 &&
							GIVE_UP_PATTERNS.some(p => contentLower.includes(p));

						if (isGiveUp) {
							// Force retry — don't let the LLM give up
							response.markdown(`\n*Attempting to fix automatically...*\n`);
							messages.push({ role: 'assistant', content: raw });
							messages.push({ role: 'user', content: 'Do NOT tell me to fix it. YOU must fix this error yourself. Diagnose what went wrong from the previous tool results, run the necessary fix commands (npm install, mkdir, etc.), and retry. Keep working until the task succeeds.' });
							continue;
						}

						if (content && !contentStreamed) {
							response.markdown(content);
						}
						break;
					}
				}

				// Summary line — always show metrics
				const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
				const tokenStr = totalTokens > 0 ? ` · ${totalTokens.toLocaleString()} tokens` : '';
				const providerStr = lastProvider ? ` · ${lastProvider}${lastModel ? '/' + lastModel : ''}` : '';
				response.markdown(`\n\n---\n*🔧 ${totalToolCalls} tool call${totalToolCalls !== 1 ? 's' : ''} · ${loops} loop${loops > 1 ? 's' : ''}${tokenStr} · ${elapsed}s${providerStr}*\n`);

				if (loops >= maxLoops) {
					response.markdown(`\n\n*⚠️ Reached max loops (${maxLoops})*\n`);
				}

				// Show LOC stats for THIS chat turn (delta)
				const locDelta = getSessionDelta(locStart);
				if (locDelta.calls > 0) {
					response.markdown(`\n*✏️ Session LOC: ${locDelta.written} written, ${locDelta.edited} edited, ${locDelta.net} net*\n`);
				}

				// Flush LOC events after each conversation turn
				flushLocEvents();
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				response.markdown(`\n\n*❌ Error:* ${msg}`);
			}
		},
	);
	participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
	context.subscriptions.push(participant);
	console.log(`[Resonant AI] Registered chat participant with ${TOOL_COUNT} local tools`);

	// Commands
	context.subscriptions.push(
		vscode.commands.registerCommand('resonant.openChat', () => {
			// Open the built-in chat panel
			vscode.commands.executeCommand('workbench.action.chat.open');
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('resonant.newConversation', () => {
			vscode.commands.executeCommand('workbench.action.chat.newChat');
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('resonant.login', () => {
			authService.login();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('resonant.logout', () => {
			authService.logout();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('resonant.setApiKey', async () => {
			const key = await vscode.window.showInputBox({
				prompt: 'Enter your Resonant API key or JWT token',
				password: true,
				placeHolder: 'RG-xxxx or JWT token',
			});
			if (key) {
				await authService.setTokenManually(key);
			}
		}),
	);

	// ── Local LLM Commands ──
	context.subscriptions.push(
		vscode.commands.registerCommand('resonant.localLLM.testConnection', async () => {
			const localConfig = vscode.workspace.getConfiguration('resonant.localLLM');
			const localUrl = localConfig.get<string>('url', 'http://localhost:11434');
			const statusMsg = vscode.window.setStatusBarMessage(`$(loading~spin) Testing connection to ${localUrl}...`);
			try {
				const result = await testLocalConnection(localUrl);
				statusMsg.dispose();
				if (result.ok) {
					const models = await listLocalModels(localUrl);
					const modelList = models.map(m => `${m.name}${m.parameterSize ? ' (' + m.parameterSize + ')' : ''}`).join(', ');
					vscode.window.showInformationMessage(
						`✅ Connected to ${result.server} at ${localUrl}\n${models.length} model${models.length !== 1 ? 's' : ''}: ${modelList || 'none found'}`,
					);
					// Auto-enable if not already
					if (!localConfig.get<boolean>('enabled', false)) {
						const enable = await vscode.window.showInformationMessage(
							'Local LLM is not enabled. Enable it now?', 'Yes', 'No',
						);
						if (enable === 'Yes') {
							await localConfig.update('enabled', true, vscode.ConfigurationTarget.Global);
							lmProvider.refreshModels();
							vscode.window.showInformationMessage('Local LLM mode enabled! Select a local model from the model picker.');
						}
					}
				} else {
					vscode.window.showErrorMessage(`❌ Cannot connect to ${localUrl}: ${result.error}\n\nMake sure Ollama is running: ollama serve`);
				}
			} catch (err) {
				statusMsg.dispose();
				vscode.window.showErrorMessage(`Connection test failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('resonant.localLLM.listModels', async () => {
			const localUrl = vscode.workspace.getConfiguration('resonant.localLLM').get<string>('url', 'http://localhost:11434');
			try {
				const models = await listLocalModels(localUrl);
				if (models.length === 0) {
					vscode.window.showWarningMessage(`No models found at ${localUrl}. Pull a model with: ollama pull llama3.1:8b`);
					return;
				}
				const items = models.map(m => ({
					label: m.name,
					description: [m.parameterSize, m.quantization, m.family].filter(Boolean).join(' · '),
					detail: m.size > 0 ? `${(m.size / 1e9).toFixed(1)} GB` : undefined,
				}));
				const picked = await vscode.window.showQuickPick(items, {
					title: `Local Models (${localUrl})`,
					placeHolder: 'Select a model to set as default',
				});
				if (picked) {
					await vscode.workspace.getConfiguration('resonant.localLLM').update('model', picked.label, vscode.ConfigurationTarget.Global);
					lmProvider.refreshModels();
					vscode.window.showInformationMessage(`Default local model set to: ${picked.label}`);
				}
			} catch (err) {
				vscode.window.showErrorMessage(`Failed to list models: ${err instanceof Error ? err.message : String(err)}\n\nIs Ollama running? Start it with: ollama serve`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('resonant.localLLM.selectModel', async () => {
			// Same as listModels — alias for discoverability
			vscode.commands.executeCommand('resonant.localLLM.listModels');
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('resonant.localLLM.toggle', async () => {
			const localConfig = vscode.workspace.getConfiguration('resonant.localLLM');
			const current = localConfig.get<boolean>('enabled', false);
			await localConfig.update('enabled', !current, vscode.ConfigurationTarget.Global);
			lmProvider.refreshModels();
			vscode.window.showInformationMessage(`Local LLM mode: ${!current ? 'ON ✅' : 'OFF'}`);
		}),
	);

	// Profile / Account Settings webview
	const profileProvider = new ProfileWebviewProvider(context, async () => authService.getToken());
	context.subscriptions.push(
		vscode.commands.registerCommand('resonant.openProfile', () => {
			profileProvider.show();
		}),
	);

	// Status bar settings panel (Windsurf-style)
	const settingsPanel = new SettingsPanelProvider(context, async () => authService.getToken(), () => authService.getAuthDomain());
	context.subscriptions.push(
		vscode.commands.registerCommand('resonant.openSettingsPanel', () => {
			settingsPanel.show();
		}),
		{ dispose: () => settingsPanel.dispose() },
	);
	settingsPanel.updateStatusBar();

	// Agent provider — fetches user agents from backend and registers as chat participants
	const agentProvider = new ResonantAgentProvider(context, async () => authService.getToken());
	context.subscriptions.push({ dispose: () => agentProvider.dispose() });
	agentProvider.activate();

	// Register custom Resonant AI Chat sidebar (shows SSE flow, tool calls, timing)
	const chatViewProvider = new ResonantChatViewProvider(context, authService);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('resonant.chatView', chatViewProvider),
	);
	console.log('[Resonant AI] Registered Resonant AI Chat sidebar view');

	context.subscriptions.push(
		vscode.commands.registerCommand('resonant.toggleChatView', () => {
			vscode.commands.executeCommand('resonant.chatView.focus');
		}),
	);

	// Listen for auth changes — update status bar, re-fetch agents & models
	context.subscriptions.push(
		authService.onDidChangeAuth(async (loggedIn) => {
			console.log(`[Resonant AI] Auth changed: loggedIn=${loggedIn}`);
			await settingsPanel.updateStatusBar();
			chatViewProvider.onAuthChanged(loggedIn);
			if (loggedIn) {
				lmProvider.refreshModels();
				agentProvider.refreshAgents();
			}
		}),
	);

	// Command to refresh providers/agents manually
	context.subscriptions.push(
		vscode.commands.registerCommand('resonant.refreshProviders', () => {
			lmProvider.refreshModels();
			agentProvider.refreshAgents();
			vscode.window.showInformationMessage('Resonant AI: Refreshing providers and agents...');
		}),
	);

	// Initialize LOC tracker + update checker
	const initApiUrl = vscode.workspace.getConfiguration('resonant').get<string>('apiUrl', '') || authService.getAuthDomain();
	const initToken = authService.getToken();
	if (initToken) {
		initLocTracker(initApiUrl, initToken, 'pending', '');
		initUpdateChecker(context, initApiUrl, initToken);
	}
	registerUpdateCommands(context);

	// Update LOC/update auth when user logs in
	context.subscriptions.push(
		authService.onDidChangeAuth(async (loggedIn) => {
			if (loggedIn) {
				const url = vscode.workspace.getConfiguration('resonant').get<string>('apiUrl', '') || authService.getAuthDomain();
				const token = authService.getToken();
				updateLocAuth(url, token);
				updateCheckerAuth(url, token);
				initLocTracker(url, token, 'user', '');
			}
		}),
	);

	console.log('[Resonant AI] Extension activated — integrated into built-in Chat.');
}

export function deactivate() {
	disposeLocTracker();
	disposeUpdateChecker();
	disposeTerminalSessions();
	console.log('[Resonant AI] Extension deactivated.');
}
