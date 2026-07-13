import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Project creation triggers real git ops in the api, so give it a throwaway repo.
export function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'deem-e2e-repo-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'e2e@deem.test']);
  git(['config', 'user.name', 'Deem E2E']);
  writeFileSync(join(dir, 'README.md'), '# e2e fixture repo\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial commit']);
  return dir;
}

export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
