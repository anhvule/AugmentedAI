// Append-only audit trail (JSONL). Answers "who did what, when" — the first
// question asked after anything touches a production repository.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_FILE = path.join(__dirname, '..', 'data', 'audit.log');

export function audit(actor, action, detail = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), actor: actor || 'system', action, ...detail });
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_FILE, line + '\n', { mode: 0o600 });
  } catch (err) {
    console.error('[audit] write failed:', err.message);
  }
}

export function auditTail(lines = 200) {
  try {
    const content = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n');
    return content.slice(-lines).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: l };
      }
    });
  } catch {
    return [];
  }
}
