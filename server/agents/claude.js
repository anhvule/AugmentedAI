// Drives the Claude Code CLI headless: `claude -p --output-format stream-json`.
// Tool calls, session id and the transcript file feed the debug view.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { parseJsonLoose } from './index.js';

function sessionFileFor(cwd, sessionId) {
  const munged = cwd.replace(/[/.]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', munged, `${sessionId}.jsonl`);
}

export const claudeAgent = {
  name: 'claude-code',
  run(job) {
    const { prompt, cwd, onEvent, registerChild, readOnly } = job;
    return new Promise((resolve) => {
      const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
      if (readOnly) args.push('--allowedTools', 'Read,Grep,Glob,LS');
      else args.push('--dangerously-skip-permissions');

      const child = spawn('claude', args, { cwd: cwd || process.cwd(), env: process.env });
      registerChild?.(child);
      let resultText = '';
      let stderr = '';
      let buf = '';

      child.stdout.on('data', (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.type === 'system' && ev.subtype === 'init') {
            onEvent({
              type: 'session',
              sessionId: ev.session_id,
              sessionFile: sessionFileFor(cwd || process.cwd(), ev.session_id),
            });
          } else if (ev.type === 'assistant') {
            for (const block of ev.message?.content || []) {
              if (block.type === 'tool_use') onEvent({ type: 'tool', name: block.name });
              if (block.type === 'text' && block.text) onEvent({ type: 'log', message: block.text.slice(0, 400) });
            }
          } else if (ev.type === 'result') {
            resultText = ev.result || '';
          }
        }
      });
      child.stderr.on('data', (c) => (stderr += c.toString()));
      child.on('error', (err) => resolve({ ok: false, text: `claude CLI not available: ${err.message}` }));
      child.on('close', (code) => {
        if (code !== 0 && !resultText) {
          resolve({ ok: false, text: stderr.slice(-2000) || `claude exited with code ${code}` });
          return;
        }
        resolve({ ok: true, text: resultText, json: parseJsonLoose(resultText) });
      });
    });
  },
};
