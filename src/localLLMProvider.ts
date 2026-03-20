/*---------------------------------------------------------------------------------------------
 *  Local LLM Provider — Direct connection to Ollama or any OpenAI-compatible local server.
 *  Since Resonant IDE is a desktop Electron app, it can call localhost directly.
 *  No WebSocket tunnel needed (unlike the web platform).
 *
 *  Supports:
 *  - Ollama (default: http://localhost:11434)
 *  - LM Studio (http://localhost:1234)
 *  - llama.cpp server (http://localhost:8080)
 *  - Any OpenAI-compatible API (LocalAI, vLLM, text-generation-webui, etc.)
 *
 *  Uses OpenAI-compatible /v1/chat/completions for inference.
 *  Uses Ollama /api/tags for model discovery (falls back to configured model list).
 *--------------------------------------------------------------------------------------------*/
import * as http from 'http';
import { URL } from 'url';

// ── Types ──

export interface LocalModel {
	name: string;
	size: number; // bytes
	parameterSize: string; // e.g. "7B", "13B", "70B"
	quantization: string; // e.g. "Q4_0", "Q5_K_M"
	family: string; // e.g. "llama", "mistral", "codellama"
	modifiedAt: string;
}

export interface LocalLLMConfig {
	enabled: boolean;
	url: string; // e.g. "http://localhost:11434"
	model: string; // e.g. "llama3.1:8b"
	contextLength: number;
}

interface OllamaTagsResponse {
	models: Array<{
		name: string;
		size: number;
		details: {
			parameter_size: string;
			quantization_level: string;
			family: string;
		};
		modified_at: string;
	}>;
}

interface ChatCompletionChunk {
	choices: Array<{
		delta: {
			content?: string;
			tool_calls?: Array<{
				index: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason: string | null;
	}>;
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

interface ChatCompletionResponse {
	choices: Array<{
		message: {
			content: string | null;
			tool_calls?: Array<{
				id: string;
				type: string;
				function: { name: string; arguments: string };
			}>;
		};
		finish_reason: string;
	}>;
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
	model: string;
}

export interface LocalCompletionResult {
	content: string;
	tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
	usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
	model: string;
}

// ── Connection Test ──

export async function testLocalConnection(baseUrl: string): Promise<{ ok: boolean; server: string; error?: string }> {
	try {
		// Try Ollama /api/tags first
		const resp = await httpGet(`${baseUrl}/api/tags`, 3000);
		if (resp.statusCode === 200) {
			return { ok: true, server: 'ollama' };
		}
	} catch { /* not Ollama */ }

	try {
		// Try OpenAI-compatible /v1/models
		const resp = await httpGet(`${baseUrl}/v1/models`, 3000);
		if (resp.statusCode === 200) {
			return { ok: true, server: 'openai-compatible' };
		}
	} catch { /* not OpenAI-compatible */ }

	try {
		// Try root health check
		const resp = await httpGet(baseUrl, 3000);
		if (resp.statusCode === 200) {
			return { ok: true, server: 'unknown' };
		}
		return { ok: false, server: 'none', error: `HTTP ${resp.statusCode}` };
	} catch (err) {
		return { ok: false, server: 'none', error: err instanceof Error ? err.message : String(err) };
	}
}

// ── Model Discovery ──

export async function listLocalModels(baseUrl: string): Promise<LocalModel[]> {
	const models: LocalModel[] = [];

	// Try Ollama /api/tags
	try {
		const resp = await httpGet(`${baseUrl}/api/tags`, 5000);
		if (resp.statusCode === 200) {
			const data: OllamaTagsResponse = JSON.parse(resp.body);
			for (const m of data.models || []) {
				models.push({
					name: m.name,
					size: m.size || 0,
					parameterSize: m.details?.parameter_size || '',
					quantization: m.details?.quantization_level || '',
					family: m.details?.family || '',
					modifiedAt: m.modified_at || '',
				});
			}
			return models;
		}
	} catch { /* not Ollama */ }

	// Try OpenAI-compatible /v1/models
	try {
		const resp = await httpGet(`${baseUrl}/v1/models`, 5000);
		if (resp.statusCode === 200) {
			const data = JSON.parse(resp.body);
			for (const m of data.data || []) {
				models.push({
					name: m.id,
					size: 0,
					parameterSize: '',
					quantization: '',
					family: m.owned_by || '',
					modifiedAt: '',
				});
			}
			return models;
		}
	} catch { /* fallback */ }

	return models;
}

// ── Completions (Streaming) ──

export async function callLocalCompletions(
	config: LocalLLMConfig,
	messages: Array<Record<string, unknown>>,
	tools?: Array<Record<string, unknown>>,
	onChunk?: (text: string) => void,
): Promise<LocalCompletionResult> {
	const baseUrl = config.url.replace(/\/+$/, '');
	const url = `${baseUrl}/v1/chat/completions`;

	const body: Record<string, unknown> = {
		model: config.model,
		messages,
		stream: true,
		temperature: 0.7,
		max_tokens: 16384,
	};

	// Only include tools if the model supports them and we have some
	if (tools && tools.length > 0) {
		body.tools = tools;
	}

	let content = '';
	const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
	let usage: LocalCompletionResult['usage'] = null;

	return new Promise<LocalCompletionResult>((resolve, reject) => {
		const parsed = new URL(url);

		const reqOptions: http.RequestOptions = {
			hostname: parsed.hostname,
			port: parsed.port || 80,
			path: parsed.pathname,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'text/event-stream',
			},
		};

		const payload = JSON.stringify(body);

		const req = http.request(reqOptions, (res) => {
			if (res.statusCode !== 200) {
				let errBody = '';
				res.on('data', (c: Buffer) => { errBody += c.toString(); });
				res.on('end', () => {
					reject(new Error(`Local LLM returned ${res.statusCode}: ${errBody.slice(0, 300)}`));
				});
				return;
			}

			let buffer = '';

			res.on('data', (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || trimmed === 'data: [DONE]') { continue; }
					if (!trimmed.startsWith('data: ')) { continue; }

					try {
						const data: ChatCompletionChunk = JSON.parse(trimmed.slice(6));
						const choice = data.choices?.[0];
						if (!choice) { continue; }

						// Text content
						if (choice.delta?.content) {
							content += choice.delta.content;
							onChunk?.(choice.delta.content);
						}

						// Tool calls (streamed incrementally)
						if (choice.delta?.tool_calls) {
							for (const tc of choice.delta.tool_calls) {
								const idx = tc.index ?? 0;
								if (!toolCalls.has(idx)) {
									toolCalls.set(idx, {
										id: tc.id || `local_call_${Date.now()}_${idx}`,
										name: tc.function?.name || '',
										arguments: tc.function?.arguments || '',
									});
								} else {
									const existing = toolCalls.get(idx)!;
									if (tc.function?.name) { existing.name = tc.function.name; }
									if (tc.function?.arguments) { existing.arguments += tc.function.arguments; }
								}
							}
						}

						// Usage (usually in last chunk)
						if (data.usage) {
							usage = data.usage;
						}
					} catch { /* skip malformed SSE lines */ }
				}
			});

			res.on('end', () => {
				// Parse any remaining buffer
				if (buffer.trim() && buffer.trim() !== 'data: [DONE]' && buffer.trim().startsWith('data: ')) {
					try {
						const data: ChatCompletionChunk = JSON.parse(buffer.trim().slice(6));
						if (data.choices?.[0]?.delta?.content) {
							content += data.choices[0].delta.content;
							onChunk?.(data.choices[0].delta.content);
						}
						if (data.usage) { usage = data.usage; }
					} catch { /* skip */ }
				}

				const resultToolCalls = Array.from(toolCalls.values()).map(tc => ({
					id: tc.id,
					type: 'function' as const,
					function: { name: tc.name, arguments: tc.arguments },
				}));

				resolve({
					content,
					tool_calls: resultToolCalls,
					usage,
					model: config.model,
				});
			});

			res.on('error', reject);
		});

		req.on('error', (err) => {
			if ((err as any).code === 'ECONNREFUSED') {
				reject(new Error(`Cannot connect to local LLM at ${baseUrl}. Is Ollama running? Start it with: ollama serve`));
			} else {
				reject(err);
			}
		});

		// 5 minute timeout for slow local models
		req.setTimeout(300_000, () => {
			req.destroy();
			reject(new Error('Local LLM request timed out (5 minutes)'));
		});

		req.write(payload);
		req.end();
	});
}

// ── Non-streaming fallback (for models that don't support streaming well) ──

export async function callLocalCompletionsSync(
	config: LocalLLMConfig,
	messages: Array<Record<string, unknown>>,
	tools?: Array<Record<string, unknown>>,
): Promise<LocalCompletionResult> {
	const baseUrl = config.url.replace(/\/+$/, '');
	const url = `${baseUrl}/v1/chat/completions`;

	const body: Record<string, unknown> = {
		model: config.model,
		messages,
		stream: false,
		temperature: 0.7,
		max_tokens: 16384,
	};

	if (tools && tools.length > 0) {
		body.tools = tools;
	}

	const resp = await httpPost(url, JSON.stringify(body), 300_000);
	const data: ChatCompletionResponse = JSON.parse(resp.body);
	const choice = data.choices?.[0];

	return {
		content: choice?.message?.content || '',
		tool_calls: (choice?.message?.tool_calls || []).map(tc => ({
			id: tc.id,
			type: tc.type,
			function: tc.function,
		})),
		usage: data.usage || null,
		model: data.model || config.model,
	};
}

// ── HTTP helpers ──

interface HttpResponse {
	statusCode: number;
	body: string;
}

function httpGet(url: string, timeoutMs = 5000): Promise<HttpResponse> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const req = http.request({
			hostname: parsed.hostname,
			port: parsed.port || 80,
			path: parsed.pathname + parsed.search,
			method: 'GET',
		}, (res) => {
			let body = '';
			res.on('data', (c: Buffer) => { body += c.toString(); });
			res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
		});
		req.on('error', reject);
		req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
		req.end();
	});
}

function httpPost(url: string, payload: string, timeoutMs = 60000): Promise<HttpResponse> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const req = http.request({
			hostname: parsed.hostname,
			port: parsed.port || 80,
			path: parsed.pathname,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': String(Buffer.byteLength(payload)),
			},
		}, (res) => {
			let body = '';
			res.on('data', (c: Buffer) => { body += c.toString(); });
			res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
		});
		req.on('error', reject);
		req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
		req.write(payload);
		req.end();
	});
}
