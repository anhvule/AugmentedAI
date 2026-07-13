import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Project creation points the agent at a local git repository. Tests must never
// touch a real repo, so we spin up a throwaway one with a single commit.
export function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deem-e2e-repo-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'e2e@deem.test']);
  git(['config', 'user.name', 'Deem E2E']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# e2e fixture repo\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial commit']);
  return dir;
}

export function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
