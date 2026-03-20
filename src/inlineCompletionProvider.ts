/*---------------------------------------------------------------------------------------------
 *  Resonant AI Inline Completion Provider — Ghost text (Copilot-style) completions.
 *  Uses the same /api/v1/ide/completions backend endpoint with a FIM (fill-in-middle) prompt.
 *  Debounced to avoid excessive requests while typing.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

let _apiUrl = '';
let _authToken = '';
let _modelName = 'llama-3.3-70b-versatile';
let _providerKey = 'groq';
let _enabled = true;

export function setInlineCompletionAuth(apiUrl: string, authToken: string) {
  _apiUrl = apiUrl;
  _authToken = authToken;
}

export function setInlineCompletionModel(provider: string, model: string) {
  _providerKey = provider;
  _modelName = model;
}

export function setInlineCompletionEnabled(enabled: boolean) {
  _enabled = enabled;
}

// Debounce tracking
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 400;

// Cache to avoid re-requesting same context
const _cache = new Map<string, string>();
const MAX_CACHE_SIZE = 50;

function getCacheKey(prefix: string, suffix: string): string {
  return `${prefix.slice(-200)}|||${suffix.slice(0, 100)}`;
}

export class ResonantInlineCompletionProvider implements vscode.InlineCompletionItemProvider {

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | null> {
    if (!_enabled || !_apiUrl || !_authToken) return null;

    // Skip non-code files
    const lang = document.languageId;
    const supportedLangs = new Set([
      'typescript', 'typescriptreact', 'javascript', 'javascriptreact',
      'python', 'go', 'rust', 'java', 'c', 'cpp', 'csharp',
      'ruby', 'php', 'swift', 'kotlin', 'scala', 'dart',
      'html', 'css', 'scss', 'less', 'vue', 'svelte',
      'json', 'yaml', 'toml', 'markdown', 'sql', 'shell', 'bash',
      'dockerfile', 'makefile',
    ]);
    if (!supportedLangs.has(lang)) return null;

    // Don't trigger on empty lines at start of file
    if (position.line === 0 && position.character === 0) return null;

    // Build prefix (before cursor) and suffix (after cursor)
    const prefixRange = new vscode.Range(
      new vscode.Position(Math.max(0, position.line - 50), 0),
      position
    );
    const suffixRange = new vscode.Range(
      position,
      new vscode.Position(Math.min(document.lineCount - 1, position.line + 20), 10000)
    );
    const prefix = document.getText(prefixRange);
    const suffix = document.getText(suffixRange);

    // Skip if prefix is too short
    if (prefix.trim().length < 5) return null;

    // Check cache
    const cacheKey = getCacheKey(prefix, suffix);
    const cached = _cache.get(cacheKey);
    if (cached) {
      return [new vscode.InlineCompletionItem(cached, new vscode.Range(position, position))];
    }

    // Debounce — wait for user to stop typing
    if (_debounceTimer) clearTimeout(_debounceTimer);

    return new Promise<vscode.InlineCompletionItem[] | null>((resolve) => {
      _debounceTimer = setTimeout(async () => {
        if (token.isCancellationRequested) { resolve(null); return; }

        try {
          const completion = await requestCompletion(prefix, suffix, lang, document.fileName);
          if (token.isCancellationRequested || !completion) { resolve(null); return; }

          // Cache result
          _cache.set(cacheKey, completion);
          if (_cache.size > MAX_CACHE_SIZE) {
            const firstKey = _cache.keys().next().value;
            if (firstKey) _cache.delete(firstKey);
          }

          resolve([new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))]);
        } catch {
          resolve(null);
        }
      }, DEBOUNCE_MS);
    });
  }
}

async function requestCompletion(prefix: string, suffix: string, language: string, fileName: string): Promise<string | null> {
  // Build FIM prompt
  const prompt = `You are an expert ${language} code completion engine. Complete the code at the cursor position.
Only output the completion text — no explanation, no markdown, no code fences.
Output ONLY the code that should be inserted at the cursor. Be concise (1-3 lines max).
If no meaningful completion, output exactly: <NONE>

File: ${fileName}
Language: ${language}

=== CODE BEFORE CURSOR ===
${prefix.slice(-1500)}
=== CURSOR HERE ===
${suffix.slice(0, 500) ? `=== CODE AFTER CURSOR ===\n${suffix.slice(0, 500)}` : ''}`;

  return new Promise((resolve) => {
    const url = new URL(_apiUrl);
    const body = JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      model: _modelName,
      preferred_provider: _providerKey,
      temperature: 0.2,
      max_tokens: 150,
      stream: false,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body).toString(),
    };
    if (_authToken.startsWith('RG-')) headers['x-api-key'] = _authToken;
    else headers['Authorization'] = `Bearer ${_authToken}`;

    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers,
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          // Try to parse SSE or direct JSON
          let content = '';
          if (data.includes('event:') || data.includes('data:')) {
            // SSE — extract content from chunks
            for (const line of data.split('\n')) {
              if (line.startsWith('data: ')) {
                try {
                  const parsed = JSON.parse(line.slice(6));
                  if (parsed.content) content += parsed.content;
                  if (parsed.choices?.[0]?.message?.content) content += parsed.choices[0].message.content;
                } catch { /* skip */ }
              }
            }
          } else {
            const parsed = JSON.parse(data);
            content = parsed.choices?.[0]?.message?.content || parsed.content || '';
          }

          content = content.trim();
          if (!content || content === '<NONE>' || content.includes('```')) {
            resolve(null);
            return;
          }
          // Limit to reasonable length
          const lines = content.split('\n').slice(0, 5);
          resolve(lines.join('\n'));
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}
