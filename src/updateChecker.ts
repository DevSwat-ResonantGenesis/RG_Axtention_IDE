/**
 * Update Checker — checks for IDE updates on startup and periodically.
 * Shows notification with release notes when a new version is available.
 */

import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

const CURRENT_VERSION = '1.0.0';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // Check every 4 hours

let _apiUrl = '';
let _authToken = '';
let _checkTimer: NodeJS.Timeout | null = null;

export function initUpdateChecker(context: vscode.ExtensionContext, apiUrl: string, authToken: string) {
	_apiUrl = apiUrl;
	_authToken = authToken;

	// Check on startup (after 10 second delay)
	setTimeout(() => checkForUpdates(context), 10000);

	// Periodic check
	_checkTimer = setInterval(() => checkForUpdates(context), CHECK_INTERVAL_MS);
}

export function updateCheckerAuth(apiUrl: string, authToken: string) {
	_apiUrl = apiUrl;
	_authToken = authToken;
}

export function disposeUpdateChecker() {
	if (_checkTimer) {
		clearInterval(_checkTimer);
		_checkTimer = null;
	}
}

async function checkForUpdates(context: vscode.ExtensionContext) {
	if (!_apiUrl) { return; }

	const platform = `${process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;

	try {
		const data = await httpGet(`${_apiUrl}/api/v1/ide/updates/check?version=${CURRENT_VERSION}&platform=${platform}&channel=stable`);
		const result = JSON.parse(data);

		if (!result.update_available) { return; }

		// Don't show the same update notification twice in this session
		const lastDismissed = context.globalState.get<string>('resonant.lastDismissedUpdate');
		if (lastDismissed === result.latest_version) { return; }

		// Show notification
		const action = result.mandatory ? 'Download Now' : 'Download';
		const remind = result.mandatory ? undefined : 'Remind Later';
		const changelog = 'View Changes';

		const items = [action, changelog];
		if (remind) { items.push(remind); }

		const choice = await vscode.window.showInformationMessage(
			`Resonant IDE ${result.latest_version} is available! (current: ${CURRENT_VERSION})`,
			...items,
		);

		if (choice === action && result.download_url) {
			vscode.env.openExternal(vscode.Uri.parse(result.download_url));
		} else if (choice === changelog) {
			// Show release notes in a new editor tab
			showReleaseNotes(result.release_notes || '', result.latest_version, result.changes || []);
		} else if (choice === remind) {
			// Don't show again this session
			await context.globalState.update('resonant.lastDismissedUpdate', result.latest_version);
		}
	} catch {
		// Silent fail — don't bother user if update check fails
	}
}

function showReleaseNotes(notes: string, version: string, changes: Array<{ type: string; description: string }>) {
	let content = notes || `# Resonant IDE ${version}\n\n`;
	if (changes.length > 0 && !notes) {
		content += '## Changes\n\n';
		for (const c of changes) {
			const icon = c.type === 'feature' ? '✨' : c.type === 'fix' ? '🐛' : c.type === 'breaking' ? '⚠️' : '📝';
			content += `- ${icon} **${c.type}**: ${c.description}\n`;
		}
	}

	const panel = vscode.window.createWebviewPanel(
		'resonantReleaseNotes',
		`What's New in ${version}`,
		vscode.ViewColumn.One,
		{ enableScripts: false },
	);

	panel.webview.html = `<!DOCTYPE html>
<html>
<head>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; max-width: 700px; margin: 0 auto; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
h1 { color: var(--vscode-textLink-foreground); border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 12px; }
h2 { margin-top: 24px; color: var(--vscode-descriptionForeground); }
li { margin: 8px 0; line-height: 1.6; }
code { background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 3px; }
</style>
</head>
<body>
${markdownToHtml(content)}
</body>
</html>`;
}

/** Register "View Release Notes" command */
export function registerCommands(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('resonant.viewReleaseNotes', async () => {
			if (!_apiUrl) {
				vscode.window.showWarningMessage('Not connected to server.');
				return;
			}
			try {
				const data = await httpGet(`${_apiUrl}/api/v1/ide/updates/releases?limit=5`);
				const result = JSON.parse(data);
				const releases = result.releases || [];
				if (releases.length === 0) {
					vscode.window.showInformationMessage('No release notes available.');
					return;
				}
				// Show latest release
				const r = releases[0];
				showReleaseNotes(r.release_notes || '', r.version, r.changes || []);
			} catch {
				vscode.window.showErrorMessage('Failed to fetch release notes.');
			}
		}),
	);
}

// ── Helpers ──

function httpGet(urlStr: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const url = new URL(urlStr);
		const isHttps = url.protocol === 'https:';
		const reqModule = isHttps ? https : http;

		const headers: Record<string, string> = {};
		if (_authToken) {
			if (_authToken.startsWith('RG-')) {
				headers['x-api-key'] = _authToken;
			} else {
				headers['Authorization'] = `Bearer ${_authToken}`;
			}
		}

		const req = reqModule.get({
			hostname: url.hostname,
			port: url.port || (isHttps ? 443 : 80),
			path: `${url.pathname}${url.search}`,
			headers,
			rejectUnauthorized: false,
		}, (res) => {
			let body = '';
			res.on('data', (d) => { body += d; });
			res.on('end', () => resolve(body));
		});
		req.on('error', reject);
		req.end();
	});
}

function markdownToHtml(md: string): string {
	return md
		.replace(/^### (.*$)/gm, '<h3>$1</h3>')
		.replace(/^## (.*$)/gm, '<h2>$1</h2>')
		.replace(/^# (.*$)/gm, '<h1>$1</h1>')
		.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
		.replace(/\*(.*?)\*/g, '<em>$1</em>')
		.replace(/`(.*?)`/g, '<code>$1</code>')
		.replace(/^- (.*$)/gm, '<li>$1</li>')
		.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
		.replace(/\n\n/g, '<br><br>')
		.replace(/\n/g, '\n');
}
