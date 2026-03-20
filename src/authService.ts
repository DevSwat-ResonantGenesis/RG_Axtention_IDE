/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';

const AUTH_TOKEN_KEY = 'resonant_auth_token';
const AUTH_USER_KEY = 'resonant_auth_user';
const AUTH_DOMAIN_KEY = 'resonant_auth_domain';

// Both production domains — try dev-swat first (resonantgenesis.xyz can be flagged by Google)
const AUTH_DOMAINS = ['https://dev-swat.com', 'https://resonantgenesis.xyz'];

interface UserInfo {
	email: string;
	name: string;
	avatar_url?: string;
}

/**
* Auth service — dual-domain auth with automatic fallback:
* 1. Start local HTTP server on random port
* 2. Health-check both domains, pick the first reachable one
* 3. Open browser to {domain}/auth/desktop-callback?port=PORT
* 4. Backend reads HttpOnly cookie → redirects to localhost:PORT/auth-callback?token=JWT
* 5. Local server receives token, stores it
*/
export class ResonantAuthService {
	private _onDidChangeAuth = new vscode.EventEmitter<boolean>();
	public readonly onDidChangeAuth = this._onDidChangeAuth.event;

	private _localServer: http.Server | null = null;

	constructor(private readonly _context: vscode.ExtensionContext) {}

	public isLoggedIn(): boolean {
		const token = this._context.globalState.get<string>(AUTH_TOKEN_KEY, '');
		return token.length > 0;
	}

	public getToken(): string {
		return this._context.globalState.get<string>(AUTH_TOKEN_KEY, '');
	}

	public getUser(): UserInfo | null {
		return this._context.globalState.get<UserInfo | null>(AUTH_USER_KEY, null);
	}

	/** Get the last working auth domain */
	public getAuthDomain(): string {
		return this._context.globalState.get<string>(AUTH_DOMAIN_KEY, AUTH_DOMAINS[0]);
	}

	public async login(): Promise<void> {
		if (this._localServer) {
			vscode.window.showWarningMessage('Login already in progress');
			return;
		}

		const config = vscode.workspace.getConfiguration('resonant');
		const configuredUrl = config.get<string>('apiUrl', '');
		const port = 19200 + Math.floor(Math.random() * 800);

		try {
			await this._startLocalCallbackServer(port);

			// Build domain priority list: configured URL first, then both fallbacks
			const candidates = configuredUrl ? [configuredUrl, ...AUTH_DOMAINS] : AUTH_DOMAINS;
			const uniqueDomains = [...new Set(candidates.map(d => d.replace(/\/$/, '')))];

			// Find first reachable domain
			let authDomain = uniqueDomains[0];
			for (const domain of uniqueDomains) {
				if (await this._isDomainReachable(domain)) {
					authDomain = domain;
					break;
				}
			}

			// Store working domain for future API calls
			await this._context.globalState.update(AUTH_DOMAIN_KEY, authDomain);

			const authUrl = `${authDomain}/auth/desktop-callback?port=${port}`;
			console.log(`[Resonant Auth] Opening auth: ${authDomain} (port ${port})`);
			await vscode.env.openExternal(vscode.Uri.parse(authUrl));

			// When user is not logged in, browser redirects to login page and the
			// port parameter is lost. After they sign in, they land on the dashboard
			// instead of the callback. Workaround: poll for token, and if not received
			// after a delay, re-open the desktop-callback URL (cookie is now set).
			this._pollForTokenAndRetry(authUrl, port);
		} catch (err: any) {
			this._closeLocalServer();
			vscode.window.showErrorMessage(`Sign in failed: ${err.message}`);
		}
	}

	/** Quick health check — 3 second timeout */
	private _isDomainReachable(domain: string): Promise<boolean> {
		return new Promise((resolve) => {
			try {
				const url = new URL(domain);
				const req = https.request({
					hostname: url.hostname,
					port: 443,
					path: '/api/v1/health',
					method: 'HEAD',
					timeout: 3000,
				}, (res) => {
					resolve(res.statusCode !== undefined && res.statusCode < 500);
				});
				req.on('error', () => resolve(false));
				req.on('timeout', () => { req.destroy(); resolve(false); });
				req.end();
			} catch {
				resolve(false);
			}
		});
	}

	public async logout(): Promise<void> {
		await this._context.globalState.update(AUTH_TOKEN_KEY, undefined);
		await this._context.globalState.update(AUTH_USER_KEY, undefined);
		await this._context.globalState.update('resonant_auth_sessions', []);
		this._onDidChangeAuth.fire(false);
		vscode.window.showInformationMessage('Resonant IDE: Signed out.');
	}

	public async setTokenManually(token: string): Promise<void> {
		await this._storeAuth(token, { email: 'api-key-user', name: 'API Key' });
	}

	private async _storeAuth(token: string, user: UserInfo): Promise<void> {
		await this._context.globalState.update(AUTH_TOKEN_KEY, token);
		await this._context.globalState.update(AUTH_USER_KEY, user);

		// Sync to VS Code authentication sessions so the built-in Sign In button updates
		const sessionId = `resonant-${Date.now()}`;
		await this._context.globalState.update('resonant_auth_sessions', [{
			id: sessionId,
			accessToken: token,
			account: { id: user.email || 'user', label: user.name || user.email || 'Resonant User' },
			scopes: ['profile'],
		}]);

		this._onDidChangeAuth.fire(true);

		// Try to fetch real user info from backend
		let displayName = user.name || user.email || 'User';
		try {
			const realUser = await this._fetchUserInfo(token);
			if (realUser) {
				await this._context.globalState.update(AUTH_USER_KEY, realUser);
				// Update session with real user info
				await this._context.globalState.update('resonant_auth_sessions', [{
					id: sessionId,
					accessToken: token,
					account: { id: realUser.email || 'user', label: realUser.name || realUser.email || 'Resonant User' },
					scopes: ['profile'],
				}]);
				displayName = realUser.name || realUser.email || displayName;
				this._onDidChangeAuth.fire(true);
			}
		} catch { /* use provided info */ }

		vscode.window.showInformationMessage(`Resonant IDE: Signed in as ${displayName}`);
	}

	private async _fetchUserInfo(token: string): Promise<UserInfo | null> {
		// Use the last working auth domain (set during login)
		const authDomain = this.getAuthDomain();

		try {
			const url = new URL(`${authDomain}/api/v1/auth/verify`);
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (token.startsWith('RG-')) {
				headers['x-api-key'] = token;
			} else {
				headers['Authorization'] = `Bearer ${token}`;
			}

			const responseText = await new Promise<string>((resolve, reject) => {
				const req = https.request({
					hostname: url.hostname,
					port: url.port || 443,
					path: url.pathname,
					method: 'GET',
					headers,
				}, (res) => {
					let data = '';
					res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
					res.on('end', () => {
						if (res.statusCode && res.statusCode >= 400) {
							reject(new Error(`HTTP ${res.statusCode}`));
						} else {
							resolve(data);
						}
					});
				});
				req.on('error', reject);
				req.end();
			});

			const data = JSON.parse(responseText);
			return {
				email: data.email || '',
				name: data.full_name || data.name || data.email || '',
				avatar_url: data.avatar_url,
			};
		} catch {
			return null;
		}
	}

	private _startLocalCallbackServer(port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			this._localServer = http.createServer(async (req, res) => {
				const url = new URL(req.url || '/', `http://localhost:${port}`);

				if (url.pathname === '/auth-callback') {
					const token = url.searchParams.get('token');
					if (token) {
						res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
						res.end([
							'<!DOCTYPE html><html><head><meta charset="utf-8"><title>Resonant IDE</title>',
							'<style>',
							'*{margin:0;padding:0;box-sizing:border-box}',
							'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0a0a0f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;overflow:hidden}',
							'.watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);font-size:120px;font-weight:800;letter-spacing:12px;color:rgba(255,255,255,0.03);pointer-events:none;white-space:nowrap;user-select:none}',
							'.card{position:relative;z-index:1;text-align:center;padding:48px 64px;border-radius:16px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);backdrop-filter:blur(12px)}',
							'.check{width:64px;height:64px;border-radius:50%;background:rgba(74,222,128,0.15);margin:0 auto 24px;display:flex;align-items:center;justify-content:center}',
							'.check svg{width:32px;height:32px}',
							'h2{font-size:28px;font-weight:600;color:#fff;margin-bottom:12px;letter-spacing:-0.02em}',
							'p{font-size:15px;color:rgba(255,255,255,0.6);font-weight:400;line-height:1.5}',
							'.sub{margin-top:16px;font-size:13px;color:rgba(255,255,255,0.3);transition:opacity 0.3s}',
							'</style></head><body>',
							'<div class="watermark">RESONANT</div>',
							'<div class="card">',
							'<div class="check"><svg viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>',
							'<h2>Signed In</h2>',
							'<p>You are signed in!</p>',
							'<p class="sub">You can close this tab and return to Resonant IDE.</p>',
							'</div>',
							'<script>setTimeout(function(){try{window.close()}catch(e){}},2000)</script>',
							'</body></html>',
						].join('\n'));

						await this._storeAuth(token, { email: '', name: '' });
						console.log('[Resonant Auth] Token stored successfully');

						// Keep server alive 5s so the HTML response fully sends
						setTimeout(() => this._closeLocalServer(), 5000);
					} else {
						res.writeHead(400, { 'Content-Type': 'text/plain' });
						res.end('Missing token');
					}
				} else {
					res.writeHead(404, { 'Content-Type': 'text/plain' });
					res.end('Not found');
				}
			});

			this._localServer.listen(port, '127.0.0.1', () => {
				resolve();
			});

			this._localServer.on('error', (err: any) => {
				this._localServer = null;
				reject(err);
			});

			// Timeout after 10 minutes (user may need time if domain is flagged)
			setTimeout(() => this._closeLocalServer(), 10 * 60 * 1000);
		});
	}

	/**
	 * Poll for token arrival. If not received within ~15s, the user likely
	 * had to sign in on the browser first (losing the port param). Show a
	 * notification that re-opens the desktop-callback URL — now the cookie
	 * is set so the redirect succeeds immediately.
	 */
	private _pollForTokenAndRetry(authUrl: string, _port: number): void {
		const POLL_INTERVAL_MS = 3000;
		const FIRST_RETRY_AFTER_MS = 15000;
		const MAX_RETRIES = 4;
		let elapsed = 0;
		let retryCount = 0;

		const timer = setInterval(async () => {
			elapsed += POLL_INTERVAL_MS;

			// Token received — done
			if (this.isLoggedIn()) {
				clearInterval(timer);
				return;
			}

			// Server closed (timeout or error) — done
			if (!this._localServer) {
				clearInterval(timer);
				return;
			}

			// After initial delay, offer retry
			if (elapsed >= FIRST_RETRY_AFTER_MS && retryCount < MAX_RETRIES) {
				retryCount++;
				console.log(`[Resonant Auth] No token after ${elapsed / 1000}s — retry #${retryCount}, re-opening callback URL`);

				if (retryCount === 1) {
					// First retry: silently re-open (user just finished signing in)
					await vscode.env.openExternal(vscode.Uri.parse(authUrl));
				} else {
					// Subsequent retries: show notification with button
					const action = await vscode.window.showInformationMessage(
						'Resonant IDE: If you\'ve signed in, click below to complete login.',
						'Complete Sign In'
					);
					if (action === 'Complete Sign In') {
						await vscode.env.openExternal(vscode.Uri.parse(authUrl));
					}
				}

				// Reset elapsed to wait another interval before next retry
				elapsed = FIRST_RETRY_AFTER_MS - POLL_INTERVAL_MS;
			}
		}, POLL_INTERVAL_MS);

		// Clean up timer when server closes
		const origClose = this._closeLocalServer.bind(this);
		this._closeLocalServer = () => {
			clearInterval(timer);
			origClose();
		};
	}

	/** Safely close the local callback server */
	private _closeLocalServer(): void {
		const srv = this._localServer;
		if (srv) { srv.close(); this._localServer = null; }
	}

	public dispose(): void {
		this._closeLocalServer();
		this._onDidChangeAuth.dispose();
	}
}
