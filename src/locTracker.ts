/**
 * LOC Tracker — counts lines of code written by Resonant AI and sends telemetry.
 * Tracks file_write, file_edit, multi_edit tool calls.
 * Batches events and sends to /api/v1/ide/loc/track every 30 seconds.
 */

import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

interface LOCEvent {
	tool_name: string;
	file_path: string;
	lines_written: number;
	lines_edited: number;
	lines_deleted: number;
	net_lines: number;
	language?: string;
	timestamp: string;
}

// ── State ──
let _userId = '';
let _userEmail = '';
let _sessionId = '';
let _apiUrl = '';
let _authToken = '';
let _eventQueue: LOCEvent[] = [];
let _flushTimer: NodeJS.Timeout | null = null;
let _totalSession = { written: 0, edited: 0, deleted: 0, net: 0, calls: 0 };

const IDE_VERSION = '1.0.0';

export function initLocTracker(apiUrl: string, authToken: string, userId: string, email?: string) {
	_apiUrl = apiUrl;
	_authToken = authToken;
	_userId = userId;
	_userEmail = email || '';
	_sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

	// Flush every 30 seconds
	if (_flushTimer) { clearInterval(_flushTimer); }
	_flushTimer = setInterval(() => flushEvents(), 30000);
}

export function updateLocAuth(apiUrl: string, authToken: string) {
	_apiUrl = apiUrl;
	_authToken = authToken;
}

export function getSessionStats() {
	return { ..._totalSession, queued: _eventQueue.length };
}

export function resetSessionStats() {
	_totalSession = { written: 0, edited: 0, deleted: 0, net: 0, calls: 0 };
}

export function getSessionDelta(since: { written: number; edited: number; deleted: number; net: number; calls: number }) {
	return {
		written: _totalSession.written - (since?.written || 0),
		edited: _totalSession.edited - (since?.edited || 0),
		deleted: _totalSession.deleted - (since?.deleted || 0),
		net: _totalSession.net - (since?.net || 0),
		calls: _totalSession.calls - (since?.calls || 0),
	};
}

/**
 * Count LOC from a tool call and queue the event.
 * Call this after file_write, file_edit, or multi_edit succeeds.
 */
export function trackToolLOC(toolName: string, toolArgs: Record<string, any>) {
	let linesWritten = 0;
	let linesEdited = 0;
	let linesDeleted = 0;
	let filePath = toolArgs.path || '';

	if (toolName === 'file_write') {
		// Entire file content written
		const content = toolArgs.content || '';
		linesWritten = content.split('\n').length;

	} else if (toolName === 'file_edit') {
		const oldStr = toolArgs.old_string || '';
		const newStr = toolArgs.new_string || '';
		const oldLines = oldStr.split('\n').length;
		const newLines = newStr.split('\n').length;
		if (newLines > oldLines) {
			linesWritten = newLines - oldLines;
			linesEdited = oldLines;
		} else if (newLines < oldLines) {
			linesDeleted = oldLines - newLines;
			linesEdited = newLines;
		} else {
			linesEdited = newLines;
		}

	} else if (toolName === 'multi_edit') {
		const edits: Array<{ old_string?: string; new_string?: string }> = toolArgs.edits || [];
		for (const edit of edits) {
			const oldStr = edit.old_string || '';
			const newStr = edit.new_string || '';
			const oldLines = oldStr.split('\n').length;
			const newLines = newStr.split('\n').length;
			if (newLines > oldLines) {
				linesWritten += newLines - oldLines;
				linesEdited += oldLines;
			} else if (newLines < oldLines) {
				linesDeleted += oldLines - newLines;
				linesEdited += newLines;
			} else {
				linesEdited += newLines;
			}
		}
	} else {
		return; // Not a tracked tool
	}

	const netLines = linesWritten - linesDeleted;

	const evt: LOCEvent = {
		tool_name: toolName,
		file_path: filePath,
		lines_written: linesWritten,
		lines_edited: linesEdited,
		lines_deleted: linesDeleted,
		net_lines: netLines,
		language: detectLanguage(filePath),
		timestamp: new Date().toISOString(),
	};

	_eventQueue.push(evt);
	_totalSession.written += linesWritten;
	_totalSession.edited += linesEdited;
	_totalSession.deleted += linesDeleted;
	_totalSession.net += netLines;
	_totalSession.calls++;
}

/**
 * Flush queued events to backend.
 */
export async function flushEvents(): Promise<void> {
	if (_eventQueue.length === 0 || !_apiUrl || !_authToken || !_userId) { return; }

	const batch = _eventQueue.splice(0);
	const payload = JSON.stringify({
		user_id: _userId,
		user_email: _userEmail,
		session_id: _sessionId,
		ide_version: IDE_VERSION,
		events: batch.map(e => ({ ...e, user_id: _userId })),
	});

	try {
		const url = new URL(`${_apiUrl}/api/v1/ide/loc/track`);
		const isHttps = url.protocol === 'https:';
		const reqModule = isHttps ? https : http;

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Content-Length': String(Buffer.byteLength(payload)),
		};
		if (_authToken.startsWith('RG-')) {
			headers['x-api-key'] = _authToken;
		} else {
			headers['Authorization'] = `Bearer ${_authToken}`;
		}

		await new Promise<void>((resolve) => {
			const req = reqModule.request({
				hostname: url.hostname,
				port: url.port || (isHttps ? 443 : 80),
				path: url.pathname,
				method: 'POST',
				headers,
				rejectUnauthorized: false,
			}, (res) => {
				res.resume();
				resolve();
			});
			req.on('error', () => {
				// Re-queue events on failure (up to 500)
				_eventQueue.unshift(...batch.slice(0, 500 - _eventQueue.length));
				resolve();
			});
			req.write(payload);
			req.end();
		});
	} catch {
		// Re-queue on failure
		_eventQueue.unshift(...batch.slice(0, 500 - _eventQueue.length));
	}
}

export function disposeLocTracker() {
	if (_flushTimer) {
		clearInterval(_flushTimer);
		_flushTimer = null;
	}
	// Final flush
	flushEvents();
}

function detectLanguage(filePath: string): string {
	const ext = filePath.split('.').pop()?.toLowerCase() || '';
	const map: Record<string, string> = {
		py: 'Python', js: 'JavaScript', ts: 'TypeScript',
		tsx: 'TypeScript', jsx: 'JavaScript', go: 'Go',
		rs: 'Rust', java: 'Java', rb: 'Ruby', vue: 'Vue',
		svelte: 'Svelte', css: 'CSS', html: 'HTML',
		sh: 'Shell', yaml: 'YAML', yml: 'YAML',
		json: 'JSON', md: 'Markdown', sql: 'SQL',
	};
	return map[ext] || ext.toUpperCase() || 'Unknown';
}
