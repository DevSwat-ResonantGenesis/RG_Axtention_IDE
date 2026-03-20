/*---------------------------------------------------------------------------------------------
 *  Resonant Genesis Agent Provider
 *  Fetches user agents from /api/v1/agents and registers each as a
 *  VS Code chat participant so they appear in the @ mention list.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

interface AgentInfo {
	id: string;
	name: string;
	description: string | null;
	provider: string | null;
	model: string;
	tool_mode: string;
	tools: string[] | null;
	mode: string | null;
	is_active: boolean;
}

export class ResonantAgentProvider {

	private participants: vscode.Disposable[] = [];
	private registeredIds: Set<string> = new Set();
	private refreshTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly getToken: () => Promise<string | undefined>,
	) {}

	async activate(): Promise<void> {
		await this.refreshAgents();
		// Refresh agents every 5 minutes
		this.refreshTimer = setInterval(() => this.refreshAgents(), 300_000);
	}

	async refreshAgents(): Promise<void> {
		// Dispose previous participants
		for (const p of this.participants) {
			p.dispose();
		}
		this.participants = [];

		const token = await this.getToken();
		if (!token) { return; }

		try {
			const agents = await this.fetchAgents(token);
			console.log(`[Resonant AI] Fetched ${agents.length} user agents`);

			for (const agent of agents) {
				if (!agent.is_active) { continue; }
				this.registerAgent(agent, token);
			}
		} catch (err) {
			console.error('[Resonant AI] Failed to fetch agents:', err);
		}
	}

	private registerAgent(agent: AgentInfo, token: string): void {
		// Create a sanitized participant ID from agent name
		const safeId = agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
		const participantId = `resonant-genesis.agent-${safeId}`;

		// Skip if already registered (prevents "Agent already has implementation" errors)
		if (this.registeredIds.has(participantId)) {
			console.log(`[Resonant AI] Agent "${agent.name}" already registered, skipping`);
			return;
		}

		try {
			const participant = vscode.chat.createChatParticipant(
				participantId,
				async (request, _chatContext, response, cancelToken) => {
					try {
						const currentToken = await this.getToken();
						if (!currentToken) {
							response.markdown('⚠️ Please sign in to use this agent.');
							return;
						}
						await this.streamAgentResponse(agent, request.prompt, currentToken, response, cancelToken);
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						response.markdown(`⚠️ Agent error: ${msg}`);
					}
				},
			);

			participant.iconPath = new vscode.ThemeIcon('hubot');
			if (agent.description) {
				(participant as any).description = agent.description;
			}
			(participant as any).fullName = agent.name;

			this.participants.push(participant);
			this.registeredIds.add(participantId);
			this.context.subscriptions.push(participant);
		} catch (err) {
			console.warn(`[Resonant AI] Failed to register agent "${agent.name}":`, err);
		}
	}

	private async streamAgentResponse(
		agent: AgentInfo,
		prompt: string,
		token: string,
		response: vscode.ChatResponseStream,
		cancelToken: vscode.CancellationToken,
	): Promise<void> {
		const apiUrl = vscode.workspace.getConfiguration('resonant').get<string>('apiUrl', 'https://dev-swat.com');
		const url = new URL(`${apiUrl}/api/v1/agents/${agent.id}/chat`);
		const isHttps = url.protocol === 'https:';
		const reqModule = isHttps ? https : http;

		const body = JSON.stringify({
			message: prompt,
			stream: true,
		});

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Accept': 'text/event-stream',
			'Authorization': `Bearer ${token}`,
		};

		return new Promise<void>((resolve, reject) => {
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
							reject(new Error(`Agent API returned ${res.statusCode}: ${errBody.slice(0, 200)}`));
						});
						return;
					}

					let buffer = '';

					res.on('data', (chunk: Buffer) => {
						if (cancelToken.isCancellationRequested) {
							req.destroy();
							resolve();
							return;
						}

						buffer += chunk.toString();

						// Parse SSE events
						const blocks = buffer.split('\n\n');
						buffer = blocks.pop() || '';

						for (const block of blocks) {
							if (!block.trim()) { continue; }
							let data = '';
							for (const line of block.split('\n')) {
								if (line.startsWith('data: ')) {
									data = line.slice(6);
								}
							}
							if (!data || data === '[DONE]') { continue; }

							try {
								const parsed = JSON.parse(data);
								if (parsed.content) {
									response.markdown(parsed.content);
								} else if (parsed.choices?.[0]?.delta?.content) {
									response.markdown(parsed.choices[0].delta.content);
								}
							} catch {
								// If it's plain text, output directly
								if (data && data !== '[DONE]') {
									response.markdown(data);
								}
							}
						}
					});

					res.on('end', () => resolve());
					res.on('error', reject);
				},
			);

			req.on('error', reject);
			cancelToken.onCancellationRequested(() => {
				req.destroy();
				resolve();
			});
			req.write(body);
			req.end();
		});
	}

	private async fetchAgents(token: string): Promise<AgentInfo[]> {
		const apiUrl = vscode.workspace.getConfiguration('resonant').get<string>('apiUrl', 'https://dev-swat.com');
		const url = new URL(`${apiUrl}/api/v1/agents`);
		const isHttps = url.protocol === 'https:';
		const mod = isHttps ? https : http;

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${token}`,
		};

		const body = await new Promise<string>((resolve, reject) => {
			const req = mod.request(
				{ hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname, method: 'GET', headers },
				(res) => {
					let d = '';
					res.on('data', (c: Buffer) => { d += c.toString(); });
					res.on('end', () => {
						if (res.statusCode && res.statusCode >= 400) {
							reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 200)}`));
						} else {
							resolve(d);
						}
					});
				},
			);
			req.on('error', reject);
			req.end();
		});

		const data = JSON.parse(body);
		return Array.isArray(data) ? data : (data.agents || []);
	}

	dispose(): void {
		if (this.refreshTimer) { clearInterval(this.refreshTimer); }
		for (const p of this.participants) {
			p.dispose();
		}
		this.participants = [];
	}
}
