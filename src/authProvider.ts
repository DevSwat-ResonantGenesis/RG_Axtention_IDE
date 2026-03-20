/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';

const AUTH_TOKEN_KEY = 'resonant_auth_token';
const AUTH_USER_KEY = 'resonant_auth_user';
const SESSIONS_KEY = 'resonant_auth_sessions';

interface StoredSession {
	id: string;
	accessToken: string;
	account: { id: string; label: string };
	scopes: string[];
}

/**
* Minimal VS Code authentication provider for Resonant Genesis.
* When user clicks "Continue with Resonant Genesis" in the sign-in dialog,
* opens browser to resonantgenesis.xyz, receives token via local HTTP callback.
*/
export class ResonantAuthenticationProvider implements vscode.AuthenticationProvider, vscode.Disposable {

	static readonly id = 'resonant-genesis';

	private _sessionChangeEmitter = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this._sessionChangeEmitter.event;

	private _disposables: vscode.Disposable[] = [];
	private _localServer: http.Server | null = null;

	constructor(private readonly _context: vscode.ExtensionContext) {
		this._disposables.push(
			vscode.authentication.registerAuthenticationProvider(
				ResonantAuthenticationProvider.id,
				'Resonant Genesis',
				this,
				{ supportsMultipleAccounts: false }
			)
		);
	}

	async getSessions(_scopes?: readonly string[]): Promise<vscode.AuthenticationSession[]> {
		const stored = this._context.globalState.get<StoredSession[]>(SESSIONS_KEY, []);
		return stored.map(s => ({
			id: s.id,
			accessToken: s.accessToken,
			account: s.account,
			scopes: s.scopes,
		}));
	}

	async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
		const config = vscode.workspace.getConfiguration('resonant');
		const apiUrl = config.get<string>('apiUrl', 'https://dev-swat.com');
		const port = 19200 + Math.floor(Math.random() * 800);

		// Open browser → backend → local callback with token
		const token = await this._doLogin(apiUrl, port);
		const userInfo = await this._fetchUser(apiUrl, token);

		const session: vscode.AuthenticationSession = {
			id: `resonant-${Date.now()}`,
			accessToken: token,
			account: { id: userInfo.email || 'user', label: userInfo.name || userInfo.email || 'Resonant User' },
			scopes: [...scopes],
		};

		// Persist
		await this._context.globalState.update(SESSIONS_KEY, [{ id: session.id, accessToken: session.accessToken, account: session.account, scopes: session.scopes }]);
		await this._context.globalState.update(AUTH_TOKEN_KEY, token);
		await this._context.globalState.update(AUTH_USER_KEY, userInfo);

		this._sessionChangeEmitter.fire({ added: [session], removed: [], changed: [] });
		vscode.window.showInformationMessage(`Signed in as ${session.account.label}`);
		return session;
	}

	async removeSession(sessionId: string): Promise<void> {
		const stored = this._context.globalState.get<StoredSession[]>(SESSIONS_KEY, []);
		const removed = stored.filter(s => s.id === sessionId);
		await this._context.globalState.update(SESSIONS_KEY, []);
		await this._context.globalState.update(AUTH_TOKEN_KEY, undefined);
		await this._context.globalState.update(AUTH_USER_KEY, undefined);

		if (removed.length > 0) {
			this._sessionChangeEmitter.fire({
				added: [], changed: [],
				removed: removed.map(s => ({ id: s.id, accessToken: s.accessToken, account: s.account, scopes: s.scopes })),
			});
		}
		vscode.window.showInformationMessage('Resonant IDE: Signed out.');
	}

	private _doLogin(apiUrl: string, port: number): Promise<string> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this._localServer) { this._localServer.close(); this._localServer = null; }
				reject(new Error('Login timed out'));
			}, 5 * 60 * 1000);

			this._localServer = http.createServer((req, res) => {
				const url = new URL(req.url || '/', `http://localhost:${port}`);
				if (url.pathname === '/auth-callback') {
					const token = url.searchParams.get('token');
					if (token) {
						res.writeHead(200, { 'Content-Type': 'text/html' });
						res.end('<html><body style="font-family:sans-serif;background:#1e1e1e;color:#ccc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#4ade80">Signed In!</h2><p>Return to Resonant IDE.</p></div></body></html>');
						clearTimeout(timer);
						setTimeout(() => { if (this._localServer) { this._localServer.close(); this._localServer = null; } }, 500);
						resolve(token);
					} else {
						res.writeHead(400); res.end('Missing token');
					}
				} else {
					res.writeHead(404); res.end('Not found');
				}
			});

			this._localServer.listen(port, '127.0.0.1', () => {
				vscode.env.openExternal(vscode.Uri.parse(`${apiUrl}/auth/desktop-callback?port=${port}`));
			});

			this._localServer.on('error', (err) => {
				this._localServer = null;
				clearTimeout(timer);
				reject(err);
			});
		});
	}

	private async _fetchUser(apiUrl: string, token: string): Promise<{ email: string; name: string }> {
		try {
			const url = new URL(`${apiUrl}/auth/me`);
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (token.startsWith('RG-')) { headers['x-api-key'] = token; } else { headers['Authorization'] = `Bearer ${token}`; }

			const body = await new Promise<string>((resolve, reject) => {
				const req = https.request({ hostname: url.hostname, port: 443, path: url.pathname, method: 'GET', headers }, (res) => {
					let d = ''; res.on('data', (c: Buffer) => { d += c.toString(); }); res.on('end', () => res.statusCode && res.statusCode >= 400 ? reject(new Error(`HTTP ${res.statusCode}`)) : resolve(d));
				});
				req.on('error', reject); req.end();
			});
			const data = JSON.parse(body);
			return { email: data.email || '', name: data.full_name || data.display_name || data.name || data.email || '' };
		} catch (err) {
			console.error('[Resonant AI] Failed to fetch user profile:', err);
			return { email: '', name: '' };
		}
	}

	dispose(): void {
		if (this._localServer) { this._localServer.close(); this._localServer = null; }
		this._sessionChangeEmitter.dispose();
		this._disposables.forEach(d => d.dispose());
	}
}
