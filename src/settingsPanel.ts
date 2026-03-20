/*---------------------------------------------------------------------------------------------
 *  Resonant IDE Settings Panel — Windsurf-style status bar panel
 *  Shows Plan Info, Settings, AI Shortcuts tabs at bottom-right
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as https from 'https';

interface PlanInfo {
	tier: string;
	credits_remaining: number;
	credits_total: number;
	plan_end: string;
	email: string;
	full_name: string;
	role: string;
	unlimited_credits: boolean;
	trial_active: boolean;
	trial_expires_at: string;
	is_superuser: boolean;
}

export class SettingsPanelProvider {

	private panel: vscode.WebviewPanel | undefined;
	private statusBarItem: vscode.StatusBarItem;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly getToken: () => Promise<string | undefined>,
		private readonly getAuthDomain?: () => string,
	) {
		// Create status bar item on the right
		this.statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			-1000, // far right
		);
		this.statusBarItem.text = '$(sign-in) Sign In';
		this.statusBarItem.tooltip = 'Click to sign in to Resonant IDE';
		this.statusBarItem.command = 'resonant.login';
		this.statusBarItem.show();
	}

	async updateStatusBar(): Promise<void> {
		const token = await this.getToken();
		if (token) {
			try {
				const info = await this.fetchPlanInfo(token);
				this.statusBarItem.text = `$(account) ${info.full_name || info.email || 'Resonant IDE'}`;
				this.statusBarItem.tooltip = info.unlimited_credits
					? `${info.tier.charAt(0).toUpperCase() + info.tier.slice(1)} — Unlimited credits`
					: `${info.tier.charAt(0).toUpperCase() + info.tier.slice(1)} — ${info.credits_remaining} credits`;
				this.statusBarItem.command = 'resonant.openSettingsPanel';
			} catch {
				// Plan info failed but token exists — show signed-in state
				this.statusBarItem.text = '$(account) Resonant IDE';
				this.statusBarItem.tooltip = 'Resonant IDE — Settings';
				this.statusBarItem.command = 'resonant.openSettingsPanel';
			}
		} else {
			this.statusBarItem.text = '$(sign-in) Sign In';
			this.statusBarItem.tooltip = 'Click to sign in to Resonant IDE';
			this.statusBarItem.command = 'resonant.login';
		}
	}

	async show(): Promise<void> {
		if (this.panel) {
			this.panel.reveal();
			return;
		}

		this.panel = vscode.window.createWebviewPanel(
			'resonantSettings',
			'Resonant IDE — Settings',
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true },
		);

		this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.svg');
		this.panel.onDidDispose(() => { this.panel = undefined; });

		this.panel.webview.onDidReceiveMessage(async (msg) => {
			switch (msg.command) {
				case 'signIn':
					await vscode.commands.executeCommand('resonant.login');
					setTimeout(() => this.refreshPanel(), 2000);
					break;
				case 'signOut':
					await vscode.commands.executeCommand('resonant.logout');
					setTimeout(() => this.refreshPanel(), 500);
					break;
				case 'openSettings':
					await vscode.commands.executeCommand('workbench.action.openSettings', 'resonant');
					break;
				case 'openDashboard': {
					const dashUrl = vscode.workspace.getConfiguration('resonant').get<string>('apiUrl', 'https://dev-swat.com');
					await vscode.env.openExternal(vscode.Uri.parse(`${dashUrl}/dashboard`));
					break;
				}
			case 'openPricing': {
					const priceUrl = vscode.workspace.getConfiguration('resonant').get<string>('apiUrl', 'https://dev-swat.com');
					await vscode.env.openExternal(vscode.Uri.parse(`${priceUrl}/pricing`));
					break;
				}
				case 'refresh':
					await this.refreshPanel();
					break;
				case 'setSetting':
					if (msg.key && msg.value !== undefined) {
						await vscode.workspace.getConfiguration('resonant').update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
					}
					break;
				case 'addProviderKey': {
					const key = await vscode.window.showInputBox({
						prompt: `Enter your ${msg.provider} API key`,
						password: true,
						placeHolder: `sk-... or API key for ${msg.provider}`,
					});
					if (key) {
						try {
							const tok = await this.getToken();
							if (tok) { await this.saveProviderKey(tok, msg.provider, key); }
							await this.refreshPanel();
							vscode.window.showInformationMessage(`API key saved for ${msg.provider}`);
						} catch (e: any) {
							vscode.window.showErrorMessage(`Failed to save key: ${e.message}`);
						}
					}
					break;
				}
				case 'deleteProviderKey': {
					try {
						const tok = await this.getToken();
						if (tok) { await this.deleteProviderKey(tok, msg.provider); }
						await this.refreshPanel();
						vscode.window.showInformationMessage(`API key removed for ${msg.provider}`);
					} catch (e: any) {
						vscode.window.showErrorMessage(`Failed to delete key: ${e.message}`);
					}
					break;
				}
			}
		});

		await this.refreshPanel();
	}

	private async refreshPanel(): Promise<void> {
		if (!this.panel) { return; }
		const token = await this.getToken();
		if (!token) {
			this.panel.webview.html = this.getSignedOutHtml();
			this.updateStatusBar();
			return;
		}
		try {
			const info = await this.fetchPlanInfo(token);
			const config = vscode.workspace.getConfiguration('resonant');
			let providers: { provider_key: string; name: string; available: boolean; status: string; model: string; has_user_key: boolean }[] = [];
			let userKeys: { provider: string; key_prefix: string; is_valid: boolean }[] = [];
			try { providers = await this.fetchProviders(); } catch { /* non-critical */ }
			try { userKeys = await this.fetchProviderKeys(token); } catch { /* non-critical */ }
			this.panel.webview.html = this.getSettingsHtml(info, config, providers, userKeys);
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			// If 401/403 — token is invalid, show sign-in page
			if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('Unauthorized')) {
				this.panel.webview.html = this.getSignedOutHtml();
				this.updateStatusBar();
			} else {
				this.panel.webview.html = this.getErrorHtml(errMsg);
			}
		}
	}

	private async fetchPlanInfo(token: string): Promise<PlanInfo> {
		const configuredUrl = vscode.workspace.getConfiguration('resonant').get<string>('apiUrl', '');
		const apiUrl = configuredUrl || (this.getAuthDomain ? this.getAuthDomain() : 'https://dev-swat.com');

		// 1) Get user profile from /auth/me
		const meUrl = new URL(`${apiUrl}/auth/me`);
		const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
		if (token.startsWith('RG-')) { authHeaders['x-api-key'] = token; } else { authHeaders['Authorization'] = `Bearer ${token}`; }

		const meBody = await this.httpGet(meUrl, authHeaders);
		const me = JSON.parse(meBody);

		// 2) Get plan/credits from /auth/verify
		const verifyUrl = new URL(`${apiUrl}/auth/verify`);
		const verifyBody = await new Promise<string>((resolve, reject) => {
			const payload = JSON.stringify({ token });
			const req = https.request({ hostname: verifyUrl.hostname, port: 443, path: verifyUrl.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
				let d = '';
				res.on('data', (c: Buffer) => { d += c.toString(); });
				res.on('end', () => {
					if (res.statusCode && res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}`)); }
					else { resolve(d); }
				});
			});
			req.on('error', reject);
			req.write(payload);
			req.end();
		});
		const verify = JSON.parse(verifyBody);

		const tier = verify.plan || 'developer';
		const unlimitedCredits = verify.unlimited_credits || verify.is_superuser || tier === 'unlimited' || tier === 'enterprise' || false;
		const role = verify.role || me.role || 'user';

		return {
			tier,
			credits_remaining: unlimitedCredits ? -1 : (verify.credits_remaining ?? 0),
			credits_total: unlimitedCredits ? -1 : (verify.credits_total ?? 500),
			plan_end: verify.trial_expires_at || '',
			email: me.email || '',
			full_name: me.full_name || me.display_name || me.username || '',
			role,
			unlimited_credits: unlimitedCredits,
			trial_active: verify.trial_active || false,
			trial_expires_at: verify.trial_expires_at || '',
			is_superuser: verify.is_superuser || false,
		};
	}

	private async saveProviderKey(token: string, provider: string, apiKey: string): Promise<void> {
		const apiUrl = vscode.workspace.getConfiguration('resonant').get<string>('apiUrl', 'https://dev-swat.com');
		const url = new URL(`${apiUrl}/user/api-keys`);
		const body = JSON.stringify({ provider, api_key: apiKey, name: `${provider} Key` });
		const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) };
		if (token.startsWith('RG-')) { headers['x-api-key'] = token; } else { headers['Authorization'] = `Bearer ${token}`; }
		await new Promise<string>((resolve, reject) => {
			const req = https.request({ hostname: url.hostname, port: 443, path: url.pathname, method: 'POST', headers }, (res) => {
				let d = '';
				res.on('data', (c: Buffer) => { d += c.toString(); });
				res.on('end', () => { if (res.statusCode && res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}`)); } else { resolve(d); } });
			});
			req.on('error', reject);
			req.write(body);
			req.end();
		});
	}

	private async deleteProviderKey(token: string, provider: string): Promise<void> {
		const apiUrl = vscode.workspace.getConfiguration('resonant').get<string>('apiUrl', 'https://dev-swat.com');
		const url = new URL(`${apiUrl}/user/api-keys/by-provider/${provider}`);
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (token.startsWith('RG-')) { headers['x-api-key'] = token; } else { headers['Authorization'] = `Bearer ${token}`; }
		await new Promise<string>((resolve, reject) => {
			const req = https.request({ hostname: url.hostname, port: 443, path: url.pathname, method: 'DELETE', headers }, (res) => {
				let d = '';
				res.on('data', (c: Buffer) => { d += c.toString(); });
				res.on('end', () => { if (res.statusCode && res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}`)); } else { resolve(d); } });
			});
			req.on('error', reject);
			req.end();
		});
	}

	private async fetchProviderKeys(token: string): Promise<{ provider: string; key_prefix: string; is_valid: boolean }[]> {
		const apiUrl = vscode.workspace.getConfiguration('resonant').get<string>('apiUrl', 'https://dev-swat.com');
		const url = new URL(`${apiUrl}/user/api-keys`);
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (token.startsWith('RG-')) { headers['x-api-key'] = token; } else { headers['Authorization'] = `Bearer ${token}`; }
		const body = await this.httpGet(url, headers);
		const data = JSON.parse(body);
		return data.keys || [];
	}

	private async fetchProviders(): Promise<{ provider_key: string; name: string; available: boolean; status: string; model: string; has_user_key: boolean }[]> {
		const apiUrl = vscode.workspace.getConfiguration('resonant').get<string>('apiUrl', 'https://dev-swat.com');
		const url = new URL(`${apiUrl}/resonant-chat/providers`);
		const token = await this.getToken();
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (token) {
			if (token.startsWith('RG-')) { headers['x-api-key'] = token; } else { headers['Authorization'] = `Bearer ${token}`; }
		}
		const body = await this.httpGet(url, headers);
		const data = JSON.parse(body);
		return data.providers || [];
	}

	private async httpGet(url: URL, headers: Record<string, string>): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const req = https.request({ hostname: url.hostname, port: 443, path: url.pathname, method: 'GET', headers }, (res) => {
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

	private getSignedOutHtml(): string {
		return `<!DOCTYPE html><html><head><style>${this.getStyles()}</style></head>
		<body><div class="container">
			<div class="tabs"><button class="tab active">Plan Info</button><button class="tab">Settings</button><button class="tab">AI Shortcuts</button></div>
			<div class="content">
				<div class="section"><h2>Welcome to Resonant IDE</h2><p class="muted">Sign in to access your AI assistant, credits, and settings.</p>
				<button class="btn primary" onclick="post('signIn')">Sign In</button></div>
			</div>
		</div><script>${this.getScript()}</script></body></html>`;
	}

	private getErrorHtml(error: string): string {
		return `<!DOCTYPE html><html><head><style>${this.getStyles()}</style></head>
		<body><div class="container">
			<div class="tabs"><button class="tab active">Plan Info</button><button class="tab">Settings</button><button class="tab">AI Shortcuts</button></div>
			<div class="content"><div class="section error"><p>Failed to load: ${error}</p>
			<button class="btn" onclick="post('refresh')">Retry</button></div></div>
		</div><script>${this.getScript()}</script></body></html>`;
	}

	private getSettingsHtml(
		info: PlanInfo,
		config: vscode.WorkspaceConfiguration,
		providers: { provider_key: string; name: string; available: boolean; status: string; model: string; has_user_key: boolean }[] = [],
		userKeys: { provider: string; key_prefix: string; is_valid: boolean }[] = [],
	): string {
		const tierLabel = info.tier.charAt(0).toUpperCase() + info.tier.slice(1);
		const creditsPercent = info.credits_total > 0 ? Math.round((info.credits_remaining / info.credits_total) * 100) : 0;
		const planEnd = info.plan_end ? new Date(info.plan_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
		const planEndDays = info.plan_end ? Math.max(0, Math.ceil((new Date(info.plan_end).getTime() - Date.now()) / 86400000)) : 30;

		const maxToolLoops = config.get<number>('maxToolLoops', 15);
		const apiUrl = config.get<string>('apiUrl', 'https://dev-swat.com');
		const userKeyProviders = new Set(userKeys.map(k => k.provider));

		// Build providers HTML
		const allProviders = [
			{ key: 'openai', label: 'OpenAI' }, { key: 'anthropic', label: 'Anthropic' },
			{ key: 'google', label: 'Google AI' }, { key: 'groq', label: 'Groq' },
			{ key: 'mistral', label: 'Mistral' }, { key: 'deepseek', label: 'DeepSeek' },
			{ key: 'cohere', label: 'Cohere' }, { key: 'together', label: 'Together AI' },
			{ key: 'openrouter', label: 'OpenRouter' }, { key: 'perplexity', label: 'Perplexity' },
			{ key: 'fireworks', label: 'Fireworks' },
		];
		const liveProviderMap = new Map(providers.map(p => [p.provider_key, p]));
		const providersHtml = allProviders.map(p => {
			const live = liveProviderMap.get(p.key);
			const hasKey = userKeyProviders.has(p.key);
			const keyInfo = userKeys.find(k => k.provider === p.key);
			const statusDot = live?.available ? '<span class="dot green"></span>' : '<span class="dot gray"></span>';
			const statusText = live ? live.status : 'no key';
			return `<div class="provider-row">
				<div class="provider-info">${statusDot}<strong>${p.label}</strong><span class="provider-status">${statusText}${live?.model ? ' &middot; ' + live.model : ''}</span></div>
				<div class="provider-actions">${hasKey
					? `<span class="key-badge">${keyInfo?.key_prefix || '****'}</span><button class="link-btn danger-link" onclick="post('deleteProviderKey',{provider:'${p.key}'})">Remove</button>`
					: `<button class="link-btn" onclick="post('addProviderKey',{provider:'${p.key}'})">Add Key</button>`
				}</div>
			</div>`;
		}).join('');

		return `<!DOCTYPE html><html><head><style>${this.getStyles()}</style></head>
		<body><div class="container">
			<div class="tabs">
				<button class="tab active" data-tab="plan">Plan Info</button>
				<button class="tab" data-tab="providers">AI Providers</button>
				<button class="tab" data-tab="settings">Settings</button>
				<button class="tab" data-tab="shortcuts">AI Shortcuts</button>
			</div>

			<!-- Plan Info Tab -->
			<div class="content tab-content active" id="tab-plan">
				<div class="section">
					<div class="plan-header">
						<h2>Plan</h2>
						<button class="icon-btn" onclick="post('refresh')" title="Refresh">&#x21bb;</button>
					</div>
					${info.unlimited_credits
						? '<p class="muted">Unlimited credits</p>'
						: '<p class="muted">Credits renew every month</p>'}
					${info.trial_active && info.trial_expires_at ? `<p class="muted">Trial ends in <strong>${planEndDays} days</strong> (${planEnd})</p>` : ''}
				</div>

				<div class="section">
					${info.unlimited_credits
						? '<div class="credits-row"><strong>&#x221E; Unlimited</strong></div><div class="progress-bar"><div class="progress-fill" style="width: 100%"></div></div>'
						: `<div class="credits-row"><strong>${info.credits_remaining} credits left</strong></div><div class="progress-bar"><div class="progress-fill" style="width: ${creditsPercent}%"></div></div>`}
				</div>

				<div class="section">
					<div class="plan-row">
						<div>
							<div class="plan-tier">${tierLabel}${info.is_superuser ? ' (Admin)' : ''}</div>
							<div class="plan-email">${info.email}</div>
						</div>
						<button class="link-btn" onclick="post('openDashboard')">Manage &rarr;</button>
					</div>
				</div>

				${!info.unlimited_credits ? '<div class="section links"><a href="#" onclick="post(\'openPricing\'); return false">Need more credits? Click here &rarr;</a></div>' : ''}
			</div>

			<!-- AI Providers Tab (BYOK) -->
			<div class="content tab-content" id="tab-providers">
				<div class="section">
					<h3>Bring Your Own Key</h3>
					<p class="muted">Add your own API keys to use any provider. Your keys are encrypted and stored securely.</p>
				</div>
				<div class="section">${providersHtml}</div>
				<div class="section links"><p class="muted">Using your own key bypasses platform credits for that provider.</p></div>
			</div>

			<!-- Settings Tab -->
			<div class="content tab-content" id="tab-settings">
				<div class="section">
					<h3>Resonant AI</h3>
					<div class="setting-row">
						<div class="setting-label">API URL</div>
						<div class="setting-value">${apiUrl}</div>
					</div>
					<div class="setting-row">
						<div class="setting-label">Max Tool Loops</div>
						<select class="setting-select" onchange="post('setSetting', {key:'maxToolLoops', value:parseInt(this.value)})">
							<option value="5" ${maxToolLoops === 5 ? 'selected' : ''}>5</option>
							<option value="10" ${maxToolLoops === 10 ? 'selected' : ''}>10</option>
							<option value="15" ${maxToolLoops === 15 ? 'selected' : ''}>15</option>
							<option value="25" ${maxToolLoops === 25 ? 'selected' : ''}>25</option>
							<option value="50" ${maxToolLoops === 50 ? 'selected' : ''}>50</option>
							<option value="75" ${maxToolLoops === 75 ? 'selected' : ''}>75</option>
							<option value="100" ${maxToolLoops === 100 ? 'selected' : ''}>100</option>
							<option value="250" ${maxToolLoops === 250 ? 'selected' : ''}>250</option>
							<option value="500" ${maxToolLoops === 500 ? 'selected' : ''}>500</option>
							<option value="1000" ${maxToolLoops === 1000 ? 'selected' : ''}>1000</option>
							<option value="0" ${maxToolLoops === 0 ? 'selected' : ''}>Unlimited</option>
						</select>
					</div>
				</div>

				<div class="section">
					<h3>Account</h3>
					<div class="setting-row">
						<div class="setting-label">Email</div>
						<div class="setting-value">${info.email}</div>
					</div>
					<div class="setting-row">
						<div class="setting-label">Role</div>
						<div class="setting-value">${info.role}</div>
					</div>
				</div>

				<div class="section">
					<button class="link-btn" onclick="post('openSettings')">Advanced Settings</button>
				</div>
			</div>

			<!-- AI Shortcuts Tab -->
			<div class="content tab-content" id="tab-shortcuts">
				<div class="section">
					<h3>AI Chat Shortcuts</h3>
					<div class="shortcut-row"><kbd>Cmd+Shift+A</kbd><span>Open Resonant AI Chat</span></div>
					<div class="shortcut-row"><kbd>Cmd+L</kbd><span>New Chat</span></div>
					<div class="shortcut-row"><kbd>Cmd+I</kbd><span>Inline Edit</span></div>
					<div class="shortcut-row"><kbd>Cmd+Shift+I</kbd><span>Toggle Chat Panel</span></div>
				</div>

				<div class="section">
					<h3>Editor Shortcuts</h3>
					<div class="shortcut-row"><kbd>Tab</kbd><span>Accept Suggestion</span></div>
					<div class="shortcut-row"><kbd>Esc</kbd><span>Dismiss Suggestion</span></div>
					<div class="shortcut-row"><kbd>Cmd+.</kbd><span>Quick Fix</span></div>
				</div>

				<div class="section">
					<h3>Agent Mode</h3>
					<div class="shortcut-row"><kbd>@workspace</kbd><span>Search workspace</span></div>
					<div class="shortcut-row"><kbd>@terminal</kbd><span>Run terminal commands</span></div>
					<div class="shortcut-row"><kbd>#file</kbd><span>Reference a file</span></div>
				</div>
			</div>

			<div class="footer">
				<button class="btn danger" onclick="post('signOut')">Sign Out</button>
			</div>
		</div><script>${this.getScript()}</script></body></html>`;
	}

	private getScript(): string {
		return `
		const vscode = acquireVsCodeApi();
		function post(cmd, data) {
			vscode.postMessage({ command: cmd, ...data });
		}
		document.querySelectorAll('.tab').forEach(tab => {
			tab.addEventListener('click', () => {
				document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
				document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
				tab.classList.add('active');
				const tabId = tab.dataset.tab;
				if (tabId) document.getElementById('tab-' + tabId)?.classList.add('active');
			});
		});
		`;
	}

	private getStyles(): string {
		return `
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body { font-family: var(--vscode-font-family, -apple-system, sans-serif); color: var(--vscode-foreground, #ccc); background: var(--vscode-editor-background, #1e1e1e); }
		.container { max-width: 700px; margin: 0 auto; }
		.tabs { display: flex; border-bottom: 1px solid rgba(255,255,255,0.1); padding: 0 16px; }
		.tab { background: none; border: none; color: var(--vscode-foreground, #999); padding: 12px 16px; cursor: pointer; font-size: 13px; border-bottom: 2px solid transparent; opacity: 0.6; }
		.tab:hover { opacity: 0.9; }
		.tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder, #007acc); font-weight: 600; }
		.content { padding: 16px; }
		.tab-content { display: none; }
		.tab-content.active { display: block; }
		.section { margin-bottom: 20px; }
		.section.links { margin-top: 16px; }
		.section.links a { color: var(--vscode-textLink-foreground, #3794ff); text-decoration: none; font-size: 13px; display: block; margin-bottom: 6px; }
		.section.error { border: 1px solid var(--vscode-errorForeground, #f44); border-radius: 6px; padding: 12px; }
		h2 { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
		h3 { font-size: 13px; font-weight: 600; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.7; }
		.muted { font-size: 13px; opacity: 0.6; margin-bottom: 4px; }
		.muted strong { opacity: 1; color: var(--vscode-foreground); }
		.plan-header { display: flex; justify-content: space-between; align-items: center; }
		.icon-btn { background: none; border: none; color: var(--vscode-foreground); cursor: pointer; font-size: 14px; opacity: 0.5; padding: 4px; }
		.icon-btn:hover { opacity: 1; }
		.credits-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 14px; }
		.progress-bar { height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; }
		.progress-fill { height: 100%; background: linear-gradient(90deg, #4ade80, #22d3ee); border-radius: 3px; transition: width 0.3s; }
		.plan-row { display: flex; justify-content: space-between; align-items: center; }
		.plan-tier { font-size: 16px; font-weight: 700; }
		.plan-email { font-size: 13px; opacity: 0.6; margin-top: 2px; }
		.link-btn { background: none; border: none; color: var(--vscode-textLink-foreground, #3794ff); cursor: pointer; font-size: 13px; padding: 0; }
		.link-btn:hover { text-decoration: underline; }
		.setting-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
		.setting-row:last-child { border-bottom: none; }
		.setting-label { font-size: 13px; opacity: 0.8; }
		.setting-value { font-size: 13px; opacity: 0.6; }
		.setting-select { background: var(--vscode-dropdown-background, #3c3c3c); color: var(--vscode-dropdown-foreground, #ccc); border: 1px solid var(--vscode-dropdown-border, #555); border-radius: 4px; padding: 4px 8px; font-size: 13px; cursor: pointer; }
		.shortcut-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; }
		.shortcut-row span { font-size: 13px; opacity: 0.7; }
		kbd { background: var(--vscode-keybindingLabel-background, #333); border: 1px solid var(--vscode-keybindingLabel-border, #555); border-radius: 3px; padding: 2px 6px; font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); }
		.btn { padding: 8px 16px; border-radius: 4px; border: none; font-size: 13px; cursor: pointer; }
		.btn.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
		.btn.primary:hover { opacity: 0.9; }
		.btn.danger { background: transparent; border: 1px solid var(--vscode-errorForeground, #f44); color: var(--vscode-errorForeground, #f44); }
		.btn.danger:hover { background: rgba(255,68,68,0.1); }
		.footer { padding: 16px; border-top: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: flex-end; }
		.provider-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
		.provider-row:last-child { border-bottom: none; }
		.provider-info { display: flex; align-items: center; gap: 8px; font-size: 13px; }
		.provider-status { font-size: 11px; opacity: 0.5; margin-left: 4px; }
		.provider-actions { display: flex; align-items: center; gap: 8px; }
		.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
		.dot.green { background: #4ade80; }
		.dot.gray { background: #666; }
		.key-badge { font-size: 10px; background: rgba(74,222,128,0.15); color: #4ade80; padding: 2px 6px; border-radius: 3px; font-family: monospace; }
		.danger-link { color: var(--vscode-errorForeground, #f44) !important; font-size: 11px !important; }
		`;
	}

	dispose(): void {
		this.statusBarItem.dispose();
		this.panel?.dispose();
	}
}
