/*---------------------------------------------------------------------------------------------
 *  Interactive Terminal Manager — persistent shell sessions with I/O capture.
 *
 *  Uses NATIVE VS Code terminals (real PTY) so sudo, Homebrew, interactive
 *  prompts, REPLs all work. Output capture via macOS `script` command which
 *  logs all terminal output to a temp file the AI can read.
 *
 *  Architecture:
 *  - shellPath = /usr/bin/script (creates a PTY + logs output)
 *  - shellArgs = [-q, <logFile>, <userShell>]
 *  - VS Code provides the outer PTY (display + user input)
 *  - script provides the inner PTY (for child process) + output logging
 *  - terminal.sendText() sends input (including control chars)
 *  - fs.readFile(logFile) reads captured output
 *
 *  Supports:
 *  - Real TTY — sudo, Homebrew, npm init, SSH all work
 *  - Persistent sessions across agentic loop iterations
 *  - Send text input and special keys (Ctrl+C, Tab, arrows)
 *  - Read captured output (ANSI stripped)
 *  - Multiple concurrent sessions
 *  - User and AI can both interact with the same terminal
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Types ──

export interface TerminalSession {
	id: string;
	name: string;
	cwd: string;
	shell: string;
	createdAt: number;
	logFile: string;
	lastReadPos: number;
	isAlive: boolean;
	terminal: vscode.Terminal;
}

interface TerminalInfo {
	id: string;
	name: string;
	cwd: string;
	shell: string;
	alive: boolean;
	output_length: number;
	created_at: string;
}

// ── Special key codes (ANSI escape sequences) ──
const SPECIAL_KEYS: Record<string, string> = {
	'ctrl+c': '\x03',
	'ctrl+d': '\x04',
	'ctrl+z': '\x1a',
	'ctrl+l': '\x0c',
	'ctrl+a': '\x01',
	'ctrl+e': '\x05',
	'ctrl+k': '\x0b',
	'ctrl+u': '\x15',
	'ctrl+w': '\x17',
	'ctrl+r': '\x12',
	'enter': '\r',
	'tab': '\t',
	'escape': '\x1b',
	'backspace': '\x7f',
	'up': '\x1b[A',
	'down': '\x1b[B',
	'right': '\x1b[C',
	'left': '\x1b[D',
	'home': '\x1b[H',
	'end': '\x1b[F',
	'delete': '\x1b[3~',
	'page_up': '\x1b[5~',
	'page_down': '\x1b[6~',
};

// ── Session Manager ──

const sessions: Map<string, TerminalSession> = new Map();
let sessionCounter = 0;

// Track terminal close events
let _closeListener: vscode.Disposable | null = null;

function ensureCloseListener() {
	if (_closeListener) return;
	_closeListener = vscode.window.onDidCloseTerminal((closedTerminal) => {
		for (const [id, session] of sessions) {
			if (session.terminal === closedTerminal) {
				session.isAlive = false;
				break;
			}
		}
	});
}

/** Detect the user's default shell */
function getDefaultShell(): string {
	const envShell = process.env.SHELL;
	if (envShell) return envShell;
	if (os.platform() === 'win32') return 'powershell.exe';
	return '/bin/zsh';
}

/** Create a new interactive terminal session */
export function createSession(
	name?: string,
	cwd?: string,
	shell?: string,
	env?: Record<string, string>,
): TerminalSession {
	ensureCloseListener();
	sessionCounter++;
	const id = `term_${Date.now()}_${sessionCounter}`;
	const sessionName = name || `Agent Terminal ${sessionCounter}`;
	const sessionCwd = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
	const sessionShell = shell || getDefaultShell();
	const sessionEnv = env || {};

	// Create a temp log file for output capture
	const logFile = path.join(os.tmpdir(), `resonant_term_${id}.log`);
	// Ensure the log file exists
	fs.writeFileSync(logFile, '', { encoding: 'utf-8' });

	// Create a native VS Code terminal with `script` as the shell wrapper.
	// On macOS: script -q <logFile> <shell>
	// This gives us: real PTY (sudo works) + output logging to file.
	let shellPath: string;
	let shellArgs: string[];
	if (os.platform() === 'darwin') {
		shellPath = '/usr/bin/script';
		shellArgs = ['-q', logFile, sessionShell];
	} else if (os.platform() === 'linux') {
		shellPath = '/usr/bin/script';
		shellArgs = ['-q', '-c', sessionShell, logFile];
	} else {
		// Windows/fallback: direct shell (no output capture)
		shellPath = sessionShell;
		shellArgs = [];
	}

	const terminal = vscode.window.createTerminal({
		name: sessionName,
		shellPath,
		shellArgs,
		cwd: vscode.Uri.file(sessionCwd),
		env: { ...sessionEnv, TERM: 'xterm-256color' },
	});

	const session: TerminalSession = {
		id,
		name: sessionName,
		cwd: sessionCwd,
		shell: sessionShell,
		createdAt: Date.now(),
		logFile,
		lastReadPos: 0,
		isAlive: true,
		terminal,
	};

	sessions.set(id, session);

	// Show the terminal in the panel (preserveFocus=true so chat stays focused)
	terminal.show(true);

	return session;
}

/** Send text/input to a terminal session */
export function sendInput(sessionId: string, input: string): { success: boolean; error?: string } {
	const session = sessions.get(sessionId);
	if (!session) {
		return { success: false, error: `No session with ID: ${sessionId}` };
	}
	if (!session.isAlive) {
		return { success: false, error: `Session '${session.name}' is no longer running` };
	}

	// Check for special key names
	const lowerInput = input.toLowerCase().trim();
	if (SPECIAL_KEYS[lowerInput]) {
		// Send control character without adding newline
		session.terminal.sendText(SPECIAL_KEYS[lowerInput], false);
		return { success: true };
	}

	// Regular text — sendText auto-appends newline by default (2nd arg = true)
	const addNewline = !(input.endsWith('\n') || input.endsWith('\r'));
	session.terminal.sendText(input, addNewline);
	return { success: true };
}

/** Send raw text without appending newline */
export function sendRawInput(sessionId: string, input: string): { success: boolean; error?: string } {
	const session = sessions.get(sessionId);
	if (!session) {
		return { success: false, error: `No session with ID: ${sessionId}` };
	}
	if (!session.isAlive) {
		return { success: false, error: `Session '${session.name}' is no longer running` };
	}
	session.terminal.sendText(input, false);
	return { success: true };
}

/** Read recent output from a terminal session (from log file) */
export function readOutput(sessionId: string, lastNChars?: number): { output: string; total_chars: number; alive: boolean; error?: string } {
	const session = sessions.get(sessionId);
	if (!session) {
		return { output: '', total_chars: 0, alive: false, error: `No session with ID: ${sessionId}` };
	}

	try {
		const raw = fs.readFileSync(session.logFile, 'utf-8');
		const chars = lastNChars || 5000;
		const output = raw.slice(-chars);
		return {
			output: stripAnsiCodes(output),
			total_chars: raw.length,
			alive: session.isAlive,
		};
	} catch (err: any) {
		return {
			output: '',
			total_chars: 0,
			alive: session.isAlive,
			error: `Failed to read log: ${err.message}`,
		};
	}
}

/** Wait for new output (polls log file until it grows or timeout) */
export async function waitForOutput(
	sessionId: string,
	timeoutMs: number = 5000,
	stableMs: number = 500,
): Promise<{ output: string; total_chars: number; alive: boolean; timed_out: boolean }> {
	const session = sessions.get(sessionId);
	if (!session) {
		return { output: '', total_chars: 0, alive: false, timed_out: false };
	}

	let startSize = 0;
	try { startSize = fs.statSync(session.logFile).size; } catch { /* file may not exist yet */ }

	const deadline = Date.now() + timeoutMs;
	let lastChangeTime = Date.now();
	let lastSize = startSize;

	while (Date.now() < deadline) {
		await new Promise(r => setTimeout(r, 100));
		let currentSize = 0;
		try { currentSize = fs.statSync(session.logFile).size; } catch { break; }

		if (currentSize !== lastSize) {
			lastSize = currentSize;
			lastChangeTime = Date.now();
		}
		// Output is stable if no change for stableMs
		if (currentSize > startSize && Date.now() - lastChangeTime >= stableMs) {
			break;
		}
	}

	// Read new content since we started waiting
	try {
		const raw = fs.readFileSync(session.logFile, 'utf-8');
		const newOutput = raw.slice(startSize);
		return {
			output: stripAnsiCodes(newOutput.slice(-5000)),
			total_chars: raw.length,
			alive: session.isAlive,
			timed_out: Date.now() >= deadline && raw.length === startSize,
		};
	} catch {
		return { output: '', total_chars: 0, alive: session.isAlive, timed_out: true };
	}
}

/** Clear the output log file for a session */
export function clearOutput(sessionId: string): { success: boolean; error?: string } {
	const session = sessions.get(sessionId);
	if (!session) {
		return { success: false, error: `No session with ID: ${sessionId}` };
	}
	try {
		fs.writeFileSync(session.logFile, '', 'utf-8');
		session.lastReadPos = 0;
	} catch { /* ignore */ }
	return { success: true };
}

/** List all active terminal sessions */
export function listSessions(): TerminalInfo[] {
	// Refresh alive status by checking VS Code terminals
	const openTerminals = vscode.window.terminals;
	for (const session of sessions.values()) {
		if (!openTerminals.includes(session.terminal)) {
			session.isAlive = false;
		}
	}

	return Array.from(sessions.values()).map(s => {
		let outputLen = 0;
		try { outputLen = fs.statSync(s.logFile).size; } catch { /* ignore */ }
		return {
			id: s.id,
			name: s.name,
			cwd: s.cwd,
			shell: s.shell,
			alive: s.isAlive,
			output_length: outputLen,
			created_at: new Date(s.createdAt).toISOString(),
		};
	});
}

/** Close a terminal session */
export function closeSession(sessionId: string): { success: boolean; error?: string } {
	const session = sessions.get(sessionId);
	if (!session) {
		return { success: false, error: `No session with ID: ${sessionId}` };
	}
	session.terminal.dispose();
	session.isAlive = false;
	// Clean up log file
	try { fs.unlinkSync(session.logFile); } catch { /* ignore */ }
	sessions.delete(sessionId);
	return { success: true };
}

/** Get a session by ID */
export function getSession(sessionId: string): TerminalSession | undefined {
	return sessions.get(sessionId);
}

/** Dispose all sessions (called on extension deactivate) */
export function disposeAllSessions(): void {
	for (const session of sessions.values()) {
		try { session.terminal.dispose(); } catch { /* ignore */ }
		try { fs.unlinkSync(session.logFile); } catch { /* ignore */ }
	}
	sessions.clear();
	if (_closeListener) {
		_closeListener.dispose();
		_closeListener = null;
	}
}

// ── Helper: strip ANSI escape codes for clean LLM output ──

function stripAnsiCodes(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')   // CSI sequences
		.replace(/\x1b\][^\x07]*\x07/g, '')        // OSC sequences
		.replace(/\x1b[()][0-9A-B]/g, '')           // Character set
		.replace(/\x1b[=>]/g, '')                    // Keypad modes
		.replace(/[\x00-\x08\x0e-\x1f]/g, '')       // Control chars (keep \t \n \r)
		.replace(/\r\n/g, '\n')                      // Normalize line endings
		.replace(/\r/g, '\n');
}
