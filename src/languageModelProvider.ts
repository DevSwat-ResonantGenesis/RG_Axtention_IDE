/*---------------------------------------------------------------------------------------------
 *  Resonant Genesis Language Model Provider
 *  Fetches real providers from /resonant-chat/providers and registers each
 *  available model in the IDE's built-in Chat model picker.
 *  Routes requests through /api/v1/ide/completions with provider+model params.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { listLocalModels, testLocalConnection, callLocalCompletions } from './localLLMProvider';

interface SSEEvent {
	event: string;
	data: string;
}

interface ProviderInfo {
	id: string;
	provider_key: string;
	name: string;
	available: boolean;
	model: string;
	models: string[];
	description: string;
	capabilities: string[];
	latency?: number;
	status: string;
	has_user_key?: boolean;
}

// Cache for fetched providers
let cachedProviders: ProviderInfo[] | undefined;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

export class ResonantLanguageModelProvider implements vscode.LanguageModelChatProvider {

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly getToken: () => Promise<string | undefined>,
	) {
		// Refresh providers every 2 minutes
		const interval = setInterval(() => {
			cachedProviders = undefined;
			this._onDidChange.fire();
		}, 120_000);
		context.subscriptions.push({ dispose: () => clearInterval(interval) });
	}

	/** Notify the IDE that models have changed (call after provider refresh) */
	refreshModels(): void {
		cachedProviders = undefined;
		cacheTimestamp = 0;
		this._onDidChange.fire();
	}

	/** Static fallback model — always returned immediately if HTTP fails */
	private static readonly FALLBACK_MODEL = {
		id: 'resonant-groq-llama-3.3-70b-versatile',
		name: 'Groq — llama-3.3-70b-versatile',
		family: 'groq',
		version: 'llama-3.3-70b-versatile',
		tooltip: 'Resonant Genesis — Groq',
		maxInputTokens: 128000,
		maxOutputTokens: 32768,
		isDefault: true,
		isUserSelectable: true,
		capabilities: { toolCalling: true, imageInput: false },
	};

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		let providers: ProviderInfo[] = [];
		try {
			providers = await this.fetchProviders();
		} catch {
			console.warn('[Resonant AI] Provider fetch failed, using fallback');
		}

		// Also fetch user BYOK keys to add those providers
		let byokProviders: string[] = [];
		try {
			byokProviders = await this.fetchUserKeyProviders();
		} catch {
			// Non-critical — user may not be logged in yet
		}

		const models: vscode.LanguageModelChatInformation[] = [];
		let isFirst = true;
		const addedProviders = new Set<string>();
		const byokSet = new Set(byokProviders);

		// Also check has_user_key from providers response (DB-backed)
		for (const p of providers) {
			if (p.has_user_key) { byokSet.add(p.provider_key); }
		}

		// Only add providers that are actually usable:
		// 1. Server reports them as online (platform has working key)
		// 2. OR user has their own BYOK key for that provider
		for (const p of providers) {
			const isOnline = p.available && p.status === 'online';
			const hasByok = byokSet.has(p.provider_key);

			// Skip providers that are neither online nor BYOK-backed
			if (!isOnline && !hasByok) { continue; }

			addedProviders.add(p.provider_key);
			const statusHint = isOnline ? '' : ' (BYOK)';

			models.push({
				id: `resonant-${p.provider_key}-${p.model}`,
				name: `${p.name} — ${p.model}${statusHint}`,
				family: p.provider_key,
				version: p.model,
				tooltip: `${p.description || p.name}${p.latency ? ' (' + p.latency + 'ms)' : ''}`,
				maxInputTokens: this.getMaxInputTokens(p.model),
				maxOutputTokens: this.getMaxOutputTokens(p.model),
				isDefault: isFirst,
				isUserSelectable: true,
				capabilities: {
					toolCalling: p.capabilities?.includes('coding') ?? true,
					imageInput: p.capabilities?.includes('vision') ?? false,
				},
			} as any);
			if (isFirst) { isFirst = false; }

			// Add alternate models for this provider
			for (const m of (p.models || [])) {
				if (m === p.model) { continue; }
				models.push({
					id: `resonant-${p.provider_key}-${m}`,
					name: `${p.name} — ${m}${statusHint}`,
					family: p.provider_key,
					version: m,
					tooltip: `${p.name} — ${m}`,
					maxInputTokens: this.getMaxInputTokens(m),
					maxOutputTokens: this.getMaxOutputTokens(m),
					isDefault: false,
					isUserSelectable: true,
					capabilities: {
						toolCalling: p.capabilities?.includes('coding') ?? true,
						imageInput: p.capabilities?.includes('vision') ?? false,
					},
				} as any);
			}
		}

		// BYOK-only providers: if user has a key for a provider not returned by /providers,
		// add it with a sensible default model
		const byokFallbackModels: Record<string, { name: string; model: string }> = {
			anthropic: { name: 'Claude (BYOK)', model: 'claude-sonnet-4-20250514' },
			openai: { name: 'OpenAI (BYOK)', model: 'gpt-4o' },
			groq: { name: 'Groq (BYOK)', model: 'llama-3.3-70b-versatile' },
			google: { name: 'Google AI (BYOK)', model: 'gemini-2.0-flash' },
			deepseek: { name: 'DeepSeek (BYOK)', model: 'deepseek-chat' },
			mistral: { name: 'Mistral (BYOK)', model: 'mistral-large-latest' },
			cohere: { name: 'Cohere (BYOK)', model: 'command-r-plus' },
			openrouter: { name: 'OpenRouter (BYOK)', model: 'openai/gpt-4o' },
			perplexity: { name: 'Perplexity (BYOK)', model: 'llama-3.1-sonar-large-128k-online' },
		};

		for (const provKey of byokProviders) {
			if (addedProviders.has(provKey)) { continue; }
			const def = byokFallbackModels[provKey];
			if (!def) { continue; }
			models.push({
				id: `resonant-${provKey}-${def.model}`,
				name: `${def.name} — ${def.model}`,
				family: provKey,
				version: def.model,
				tooltip: `${def.name} — Your API key`,
				maxInputTokens: this.getMaxInputTokens(def.model),
				maxOutputTokens: this.getMaxOutputTokens(def.model),
				isDefault: isFirst,
				isUserSelectable: true,
				capabilities: { toolCalling: true, imageInput: false },
			} as any);
			if (isFirst) { isFirst = false; }
			addedProviders.add(provKey);
		}

		// ── Local LLM models (Ollama / LM Studio / llama.cpp) ──
		const localConfig = vscode.workspace.getConfiguration('resonant.localLLM');
		const localEnabled = localConfig.get<boolean>('enabled', false);
		if (localEnabled) {
			const localUrl = localConfig.get<string>('url', 'http://localhost:11434');
			const configuredModel = localConfig.get<string>('model', '');
			const ctxLen = localConfig.get<number>('contextLength', 32768);
			try {
				const localModels = await listLocalModels(localUrl);
				for (const lm of localModels) {
					const sizeLabel = lm.parameterSize ? ` (${lm.parameterSize})` : '';
					models.push({
						id: `resonant-ollama-${lm.name}`,
						name: `Local — ${lm.name}${sizeLabel}`,
						family: 'ollama',
						version: lm.name,
						tooltip: `Local model via ${localUrl}${lm.quantization ? ' · ' + lm.quantization : ''}${lm.family ? ' · ' + lm.family : ''}`,
						maxInputTokens: ctxLen,
						maxOutputTokens: Math.min(ctxLen, 8192),
						isDefault: models.length === 0,
						isUserSelectable: true,
						capabilities: { toolCalling: true, imageInput: false },
					} as any);
				}
				// If no models discovered but a model name is configured, add it anyway
				if (localModels.length === 0 && configuredModel) {
					models.push({
						id: `resonant-ollama-${configuredModel}`,
						name: `Local — ${configuredModel}`,
						family: 'ollama',
						version: configuredModel,
						tooltip: `Local model via ${localUrl}`,
						maxInputTokens: ctxLen,
						maxOutputTokens: Math.min(ctxLen, 8192),
						isDefault: models.length === 0,
						isUserSelectable: true,
						capabilities: { toolCalling: true, imageInput: false },
					} as any);
				}
				if (localModels.length > 0) {
					console.log(`[Resonant AI] Discovered ${localModels.length} local models from ${localUrl}`);
				}
			} catch (err) {
				console.warn(`[Resonant AI] Local LLM discovery failed (${localUrl}):`, err);
				// Still add configured model as fallback
				if (configuredModel) {
					models.push({
						id: `resonant-ollama-${configuredModel}`,
						name: `Local — ${configuredModel} (offline?)`,
						family: 'ollama',
						version: configuredModel,
						tooltip: `Local model via ${localUrl} — connection failed`,
						maxInputTokens: ctxLen,
						maxOutputTokens: Math.min(ctxLen, 8192),
						isDefault: false,
						isUserSelectable: true,
						capabilities: { toolCalling: true, imageInput: false },
					} as any);
				}
			}
		}

		// Always return at least the static fallback
		if (models.length === 0) {
			models.push(ResonantLanguageModelProvider.FALLBACK_MODEL as any);
		}

		const localCount = models.filter((m: any) => m.family === 'ollama').length;
		console.log(`[Resonant AI] provideLanguageModelChatInformation returning ${models.length} models (${byokProviders.length} BYOK, ${localCount} local)`);
		return models;
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const apiUrl = vscode.workspace.getConfiguration('resonant').get<string>('apiUrl', 'https://dev-swat.com');
		const authToken = await this.getToken();

		// Parse provider and model from the model ID: "resonant-{provider}-{model}"
		const parts = model.id.replace(/^resonant-/, '').split('-');
		const providerKey = parts[0]; // e.g. "groq", "openai", "ollama"
		const modelName = parts.slice(1).join('-'); // e.g. "llama-3.3-70b-versatile"

		// System prompt — establishes identity and agentic capabilities
		const systemPrompt: Record<string, unknown> = {
			role: 'system',
			content: `You are Resonant AI — a powerful agentic coding assistant inside Resonant IDE by Resonant Genesis.
You are pair-programming with the user. Your goal is to take action, not describe what you would do.

## COMMUNICATION
- Be terse and direct. Minimize output tokens while maintaining quality and accuracy.
- Never start with filler like "Great question!", "I'd be happy to help!", "Absolutely!". Jump straight into the substance.
- Refer to the user as "you" and yourself as "I".
- Always end with a concise status summary of what was done or what's needed next.

## MARKDOWN FORMATTING
- Format all responses with Markdown.
- Use \`backticks\` for variable names, function names, file paths, and code references.
- Use fenced code blocks with language tags (\`\`\`python, \`\`\`json, \`\`\`bash).
- Bold **critical information**. Use headings to section longer responses.
- Use short bullet lists. Bold the title of each list item.

## HOW YOU WORK
1. **USE TOOLS IMMEDIATELY.** Never describe what you plan to do — just DO it.
2. **Execute end-to-end.** If the task needs 10 steps, do all 10.
3. **Batch independent tool calls.** Don't serialize independent operations.
4. **Verify your work.** After changes, read the file to confirm.
5. **Read before editing.** Always read a file before editing it.
6. **Write COMPLETE code.** Never use placeholders. Include full implementations.

## CODE
- Generated code must be immediately runnable — include all imports and dependencies.
- Follow the existing code style. Do not add or remove comments unless asked.
- Prefer minimal, focused edits over full rewrites.

## SAFETY
- For destructive operations (file deletion, git push, deploy), confirm with the user first.
- Never expose API keys or credentials in responses.

You are Resonant AI by Resonant Genesis. Not GPT, Claude, Llama, or any other base model.`,
		};

		// Convert VS Code messages to OpenAI format, prepend system prompt
		const openaiMessages = [systemPrompt, ...messages.map(msg => this.convertMessage(msg))];

		// Convert VS Code tools to OpenAI format
		const openaiTools = options.tools?.map(tool => ({
			type: 'function' as const,
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.inputSchema ?? {},
			},
		}));

		// ── Local LLM route — call Ollama/local server directly ──
		if (providerKey === 'ollama') {
			const localConfig = vscode.workspace.getConfiguration('resonant.localLLM');
			const localUrl = localConfig.get<string>('url', 'http://localhost:11434');
			const ctxLen = localConfig.get<number>('contextLength', 32768);
			try {
				const localResult = await callLocalCompletions(
					{ enabled: true, url: localUrl, model: modelName, contextLength: ctxLen },
					openaiMessages as Array<Record<string, unknown>>,
					openaiTools?.length ? openaiTools : undefined,
					(chunk) => {
						if (!token.isCancellationRequested) {
							progress.report(new vscode.LanguageModelTextPart(chunk));
						}
					},
				);
				// Report tool calls if any
				for (const tc of localResult.tool_calls) {
					let args: Record<string, unknown> = {};
					try { args = JSON.parse(tc.function.arguments); } catch { /* ignore */ }
					progress.report(
						new vscode.LanguageModelToolCallPart(tc.id, tc.function.name, args),
					);
				}
			} catch (err) {
				progress.report(new vscode.LanguageModelTextPart(
					`\n\n⚠️ Local LLM error: ${err instanceof Error ? err.message : String(err)}\n`,
				));
			}
			return;
		}

		// ── Cloud route — call /api/v1/ide/completions ──
		const body = JSON.stringify({
			messages: openaiMessages,
			tools: openaiTools?.length ? openaiTools : undefined,
			model: modelName,
			preferred_provider: providerKey,
			temperature: 0.7,
			max_tokens: 4096,
		});

		return new Promise<void>((resolve, reject) => {
			const url = new URL(`${apiUrl}/api/v1/ide/completions`);
			const isHttps = url.protocol === 'https:';
			const reqModule = isHttps ? https : http;

			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				'Accept': 'text/event-stream',
			};
			if (authToken) {
				headers['Cookie'] = `rg_access_token=${authToken}`;
				headers['Authorization'] = `Bearer ${authToken}`;
			}

			const req = reqModule.request(
				{
					hostname: url.hostname,
					port: url.port || (isHttps ? 443 : 80),
					path: url.pathname,
					method: 'POST',
					headers,
				},
				(res) => {
					if (res.statusCode !== 200) {
						let errBody = '';
						res.on('data', (chunk: Buffer) => { errBody += chunk.toString(); });
						res.on('end', () => {
							reject(new Error(`Resonant API returned ${res.statusCode}: ${errBody.slice(0, 200)}`));
						});
						return;
					}

					let buffer = '';

					res.on('data', (chunk: Buffer) => {
						buffer += chunk.toString();
						const events = this.parseSSE(buffer);
						buffer = events.remaining;

						for (const evt of events.parsed) {
							if (token.isCancellationRequested) {
								req.destroy();
								resolve();
								return;
							}
							this.handleSSEEvent(evt, progress);
						}
					});

					res.on('end', () => {
						if (buffer.trim()) {
							const events = this.parseSSE(buffer + '\n\n');
							for (const evt of events.parsed) {
								this.handleSSEEvent(evt, progress);
							}
						}
						resolve();
					});

					res.on('error', (err) => {
						reject(err);
					});
				},
			);

			req.on('error', (err) => {
				reject(err);
			});

			token.onCancellationRequested(() => {
				req.destroy();
				resolve();
			});

			req.write(body);
			req.end();
		});
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		const str = typeof text === 'string' ? text : JSON.stringify(text);
		return Math.ceil(str.length / 4);
	}

	// --- Provider fetching ---

	private async fetchProviders(): Promise<ProviderInfo[]> {
		if (cachedProviders && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
			return cachedProviders;
		}
		try {
			const apiUrl = vscode.workspace.getConfiguration('resonant').get<string>('apiUrl', 'https://dev-swat.com');
			const url = new URL(`${apiUrl}/resonant-chat/providers`);
			const token = await this.getToken();
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (token) {
				if (token.startsWith('RG-')) { headers['x-api-key'] = token; } else { headers['Authorization'] = `Bearer ${token}`; }
			}
			// 5-second timeout to prevent hanging model resolution
			const body = await Promise.race([
				this.httpGet(url, headers),
				new Promise<string>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000)),
			]);
			const data = JSON.parse(body);
			cachedProviders = data.providers || [];
			cacheTimestamp = Date.now();
			console.log(`[Resonant AI] Fetched ${cachedProviders!.length} providers:`, cachedProviders!.map(p => `${p.provider_key}=${p.status}`).join(', '));
			return cachedProviders!;
		} catch (err) {
			console.error('[Resonant AI] Failed to fetch providers:', err);
			return cachedProviders || [];
		}
	}

	private async fetchUserKeyProviders(): Promise<string[]> {
		const token = await this.getToken();
		if (!token) { return []; }
		const apiUrl = vscode.workspace.getConfiguration('resonant').get<string>('apiUrl', 'https://dev-swat.com');
		// /user/api-keys is on gateway root (not under /api/v1) — proxies to auth service DB
		const url = new URL(`${apiUrl}/user/api-keys`);
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (token.startsWith('RG-')) {
			headers['x-api-key'] = token;
		} else {
			headers['Authorization'] = `Bearer ${token}`;
			headers['Cookie'] = `rg_access_token=${token}`;
		}
		const body = await Promise.race([
			this.httpGet(url, headers),
			new Promise<string>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000)),
		]);
		const data = JSON.parse(body);
		return (data.keys || []).map((k: any) => k.provider).filter(Boolean);
	}

	private getMaxInputTokens(model: string): number {
		if (model.includes('llama-3.3') || model.includes('llama-3.1')) { return 128000; }
		if (model.includes('gpt-4o') || model.includes('gpt-4')) { return 128000; }
		if (model.includes('claude')) { return 200000; }
		if (model.includes('gemini')) { return 1000000; }
		return 32000;
	}

	private getMaxOutputTokens(model: string): number {
		if (model.includes('llama')) { return 32768; }
		if (model.includes('gpt-4o')) { return 16384; }
		if (model.includes('claude')) { return 8192; }
		return 8192;
	}

	// --- HTTP helpers ---

	private httpGet(url: URL, headers?: Record<string, string>): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const isHttps = url.protocol === 'https:';
			const mod = isHttps ? https : http;
			const req = mod.request({ hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname + url.search, method: 'GET', headers: headers || {} }, (res) => {
				let d = '';
				res.on('data', (c: Buffer) => { d += c.toString(); });
				res.on('end', () => {
					if (res.statusCode && res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}`)); }
					else { resolve(d); }
				});
			});
			req.on('error', reject);
			req.end();
		});
	}

	// --- Message conversion ---

	private convertMessage(msg: vscode.LanguageModelChatRequestMessage): Record<string, unknown> {
		const role = msg.role === vscode.LanguageModelChatMessageRole.User ? 'user'
			: msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant'
			: 'system';

		let textContent = '';
		const toolCalls: Array<Record<string, unknown>> = [];
		const toolResults: Array<Record<string, unknown>> = [];

		for (const part of msg.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				textContent += part.value;
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					id: part.callId,
					type: 'function',
					function: {
						name: part.name,
						arguments: JSON.stringify(part.input),
					},
				});
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				toolResults.push({
					tool_call_id: part.callId,
					content: part.content.map((c: unknown) => {
						if (c instanceof vscode.LanguageModelTextPart) {
							return c.value;
						}
						return String(c);
					}).join(''),
				});
			}
		}

		if (toolResults.length > 0) {
			return {
				role: 'tool',
				tool_call_id: toolResults[0].tool_call_id,
				content: toolResults[0].content,
			};
		}

		if (toolCalls.length > 0) {
			return {
				role: 'assistant',
				content: textContent || null,
				tool_calls: toolCalls,
			};
		}

		return { role, content: textContent };
	}

	// --- SSE parsing ---

	private parseSSE(buffer: string): { parsed: SSEEvent[]; remaining: string } {
		const parsed: SSEEvent[] = [];
		const blocks = buffer.split('\n\n');
		const remaining = blocks.pop() || '';

		for (const block of blocks) {
			if (!block.trim()) { continue; }
			let event = '';
			let data = '';
			for (const line of block.split('\n')) {
				if (line.startsWith('event: ')) {
					event = line.slice(7);
				} else if (line.startsWith('data: ')) {
					data = line.slice(6);
				}
			}
			if (event && data) {
				parsed.push({ event, data });
			}
		}

		return { parsed, remaining };
	}

	private handleSSEEvent(
		evt: SSEEvent,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	): void {
		try {
			const payload = JSON.parse(evt.data);

			switch (evt.event) {
				case 'chunk':
					if (payload.content) {
						progress.report(new vscode.LanguageModelTextPart(payload.content));
					}
					break;

				case 'tool_calls':
					if (Array.isArray(payload.tool_calls)) {
						for (const tc of payload.tool_calls) {
							let args: Record<string, unknown> = {};
							try {
								args = JSON.parse(tc.function?.arguments || '{}');
							} catch { /* ignore parse errors */ }

							progress.report(
								new vscode.LanguageModelToolCallPart(
									tc.id || `call_${Date.now()}`,
									tc.function?.name || 'unknown',
									args,
								),
							);
						}
					}
					break;

				case 'error':
					progress.report(new vscode.LanguageModelTextPart(
						`\n\n⚠️ Error from Resonant Genesis: ${payload.error}\n`,
					));
					break;

				case 'done':
					break;
			}
		} catch {
			// Ignore malformed SSE data
		}
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}
