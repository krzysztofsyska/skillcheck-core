// Thin git wrapper (no shell). `git(...)` throws on failure; `git.ok(...)` returns a boolean.
import { spawnSync } from 'node:child_process';

export function createGit(cwd = process.cwd()) {
  const exec = (args, input) => spawnSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
  function git(...args) {
    const r = exec(args);
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || '').split('\n')[0]}`);
    return r.stdout;
  }
  git.ok = (...args) => exec(args).status === 0;
  git.patchId = diff => {
    const r = exec(['patch-id', '--stable'], diff);
    return r.status === 0 ? (r.stdout.split(' ')[0] || null) : null;
  };
  return git;
}
