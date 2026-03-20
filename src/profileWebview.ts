/*---------------------------------------------------------------------------------------------
 *  Resonant Genesis Profile / Account Settings Webview
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as https from 'https';

interface UserProfile {
	email: string;
	full_name: string;
	display_name: string;
	role: string;
	tier: string;
	credits_remaining: number;
	created_at: string;
	avatar_url: string;
}

export class ProfileWebviewProvider {

	private panel: vscode.WebviewPanel | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly getToken: () => Promise<string | undefined>,
	) {}

	async show(): Promise<void> {
		if (this.panel) {
			this.panel.reveal();
			return;
		}

		this.panel = vscode.window.createWebviewPanel(
			'resonantProfile',
			'Resonant Genesis — Profile',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			},
		);

		this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.svg');

		this.panel.onDidDispose(() => { this.panel = undefined; });

		this.panel.webview.onDidReceiveMessage(async (msg) => {
			if (msg.command === 'signOut') {
				await vscode.commands.executeCommand('resonant.logout');
				this.panel?.dispose();
			} else if (msg.command === 'openSettings') {
				await vscode.commands.executeCommand('workbench.action.openSettings', 'resonant');
			} else if (msg.command === 'openPortal') {
				const apiUrl = vscode.workspace.getConfiguration('resonant').get<string>('apiUrl', 'https://dev-swat.com');
				await vscode.env.openExternal(vscode.Uri.parse(`${apiUrl}/settings`));
			} else if (msg.command === 'refresh') {
				await this.loadProfile();
			}
		});

		this.panel.webview.html = this.getLoadingHtml();
		await this.loadProfile();
	}

	private async loadProfile(): Promise<void> {
		if (!this.panel) { return; }

		const token = await this.getToken();
		if (!token) {
			this.panel.webview.html = this.getSignedOutHtml();
			return;
		}

		try {
			const profile = await this.fetchProfile(token);
			this.panel.webview.html = this.getProfileHtml(profile);
		} catch (err) {
			console.error('[Resonant AI] Profile fetch error:', err);
			this.panel.webview.html = this.getErrorHtml(err instanceof Error ? err.message : String(err));
		}
	}

	private async fetchProfile(token: string): Promise<UserProfile> {
		const apiUrl = vscode.workspace.getConfiguration('resonant').get<string>('apiUrl', 'https://dev-swat.com');
		const url = new URL(`${apiUrl}/auth/me`);
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (token.startsWith('RG-')) { headers['x-api-key'] = token; } else { headers['Authorization'] = `Bearer ${token}`; }

		const body = await new Promise<string>((resolve, reject) => {
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

		const data = JSON.parse(body);
		return {
			email: data.email || '',
			full_name: data.full_name || data.display_name || data.name || '',
			display_name: data.display_name || data.full_name || '',
			role: data.role || 'user',
			tier: data.tier || data.subscription_tier || 'free',
			credits_remaining: data.credits_remaining ?? data.credits ?? 0,
			created_at: data.created_at || '',
			avatar_url: data.avatar_url || '',
		};
	}

	private getLoadingHtml(): string {
		return `<!DOCTYPE html><html><head><style>${this.getStyles()}</style></head>
		<body><div class="container"><div class="loading">Loading profile...</div></div></body></html>`;
	}

	private getSignedOutHtml(): string {
		return `<!DOCTYPE html><html><head><style>${this.getStyles()}</style></head>
		<body><div class="container">
			<div class="header"><h1>Resonant Genesis</h1><p class="subtitle">You are not signed in.</p></div>
			<div class="card"><p>Sign in to view your profile and account settings.</p></div>
		</div></body></html>`;
	}

	private getErrorHtml(error: string): string {
		return `<!DOCTYPE html><html><head><style>${this.getStyles()}</style></head>
		<body><div class="container">
			<div class="header"><h1>Resonant Genesis</h1></div>
			<div class="card error"><p>Failed to load profile: ${error}</p>
			<button onclick="postMessage('refresh')">Retry</button></div>
		</div><script>const vscode=acquireVsCodeApi();function postMessage(cmd){vscode.postMessage({command:cmd})}</script></body></html>`;
	}

	private getProfileHtml(p: UserProfile): string {
		const initials = (p.full_name || p.email || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
		const memberSince = p.created_at ? new Date(p.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long' }) : 'Unknown';
		const tierBadge = p.tier === 'pro' ? '<span class="badge pro">PRO</span>' : p.tier === 'enterprise' ? '<span class="badge enterprise">ENTERPRISE</span>' : '<span class="badge free">FREE</span>';

		return `<!DOCTYPE html><html><head><style>${this.getStyles()}</style></head>
		<body>
		<div class="container">
			<div class="header">
				<div class="avatar">${initials}</div>
				<div>
					<h1>${p.full_name || p.email || 'Resonant User'}</h1>
					<p class="subtitle">${p.email}</p>
					<div class="meta">${tierBadge} <span class="role">${p.role}</span></div>
				</div>
			</div>

			<div class="card">
				<h2>Account Details</h2>
				<div class="row"><span class="label">Email</span><span class="value">${p.email}</span></div>
				<div class="row"><span class="label">Name</span><span class="value">${p.full_name || '—'}</span></div>
				<div class="row"><span class="label">Role</span><span class="value">${p.role}</span></div>
				<div class="row"><span class="label">Tier</span><span class="value">${p.tier}</span></div>
				<div class="row"><span class="label">Credits</span><span class="value">${p.credits_remaining}</span></div>
				<div class="row"><span class="label">Member Since</span><span class="value">${memberSince}</span></div>
			</div>

			<div class="card">
				<h2>Actions</h2>
				<div class="actions">
					<button onclick="postMessage('openPortal')">Open Account Portal</button>
					<button onclick="postMessage('openSettings')">Extension Settings</button>
					<button onclick="postMessage('refresh')">Refresh Profile</button>
					<button class="danger" onclick="postMessage('signOut')">Sign Out</button>
				</div>
			</div>
		</div>
		<script>const vscode=acquireVsCodeApi();function postMessage(cmd){vscode.postMessage({command:cmd})}</script>
		</body></html>`;
	}

	private getStyles(): string {
		return `
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body { font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif); color: var(--vscode-foreground, #ccc); background: var(--vscode-editor-background, #1e1e1e); padding: 24px; }
		.container { max-width: 600px; margin: 0 auto; }
		.loading { text-align: center; padding: 60px 0; opacity: 0.6; font-size: 14px; }
		.header { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; }
		.avatar { width: 56px; height: 56px; border-radius: 50%; background: linear-gradient(135deg, #4ade80, #22d3ee); display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 700; color: #1e1e1e; flex-shrink: 0; }
		h1 { font-size: 20px; font-weight: 600; }
		h2 { font-size: 14px; font-weight: 600; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.7; }
		.subtitle { font-size: 13px; opacity: 0.6; margin-top: 2px; }
		.meta { margin-top: 6px; display: flex; gap: 8px; align-items: center; }
		.badge { font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: 700; text-transform: uppercase; }
		.badge.pro { background: linear-gradient(135deg, #f59e0b, #ef4444); color: #fff; }
		.badge.enterprise { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; }
		.badge.free { background: var(--vscode-badge-background, #333); color: var(--vscode-badge-foreground, #ccc); }
		.role { font-size: 12px; opacity: 0.5; }
		.card { background: var(--vscode-editor-inactiveSelectionBackground, #2a2a2a); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
		.card.error { border: 1px solid var(--vscode-errorForeground, #f44); }
		.row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
		.row:last-child { border-bottom: none; }
		.label { font-size: 13px; opacity: 0.6; }
		.value { font-size: 13px; font-weight: 500; }
		.actions { display: flex; flex-direction: column; gap: 8px; }
		button { padding: 8px 16px; border: 1px solid var(--vscode-button-border, rgba(255,255,255,0.1)); border-radius: 6px; background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); font-size: 13px; cursor: pointer; text-align: left; }
		button:hover { opacity: 0.9; }
		button.danger { background: transparent; border-color: var(--vscode-errorForeground, #f44); color: var(--vscode-errorForeground, #f44); }
		`;
	}
}
