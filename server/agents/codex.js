// Drives the OpenAI Codex CLI headless: `codex exec --json`.
import { spawn } from 'node:child_process';
import { parseJsonLoose } from './index.js';

export const codexAgent = {
  name: 'codex',
  run(job) {
    const { prompt, cwd, onEvent, registerChild } = job;
    return new Promise((resolve) => {
      const args = ['exec', '--json', '--skip-git-repo-check', prompt];
      const child = spawn('codex', args, { cwd: cwd || process.cwd(), env: process.env });
      registerChild?.(child);
      let lastMessage = '';
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
          const item = ev.item || ev.msg || ev;
          const t = item?.type || ev.type || '';
          if (t === 'token_count') {
            const u = item.info?.total_token_usage || item.info?.last_token_usage || {};
            onEvent({ type: 'usage', input: u.input_tokens || 0, output: u.output_tokens || 0, costUsd: 0, absolute: true });
          }
          if (/session|thread/.test(t) && (item.session_id || item.thread_id)) {
            onEvent({ type: 'session', sessionId: item.session_id || item.thread_id, sessionFile: null });
          } else if (/command|tool|exec/.test(t)) {
            onEvent({ type: 'tool', name: item.name || 'exec_command' });
          } else if (/message|agent_message/.test(t)) {
            const text = item.text || item.message || '';
            if (text) {
              lastMessage = text;
              onEvent({ type: 'log', message: String(text).slice(0, 400) });
            }
          }
        }
      });
      child.stderr.on('data', (c) => (stderr += c.toString()));
      child.on('error', (err) => resolve({ ok: false, text: `codex CLI not available: ${err.message}` }));
      child.on('close', (code) => {
        if (code !== 0 && !lastMessage) {
          resolve({ ok: false, text: stderr.slice(-2000) || `codex exited with code ${code}` });
          return;
        }
        resolve({ ok: true, text: lastMessage, json: parseJsonLoose(lastMessage) });
      });
    });
  },
};
