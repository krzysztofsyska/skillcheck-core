import { spawnSync } from 'node:child_process';

const SHA = /^[a-f0-9]{40}$/;
export function historyCoverage(payload, commits) {
  const actual = payload?.reviewed_commits;
  if (payload?.full_diff_reviewed !== true || !Array.isArray(actual) || !actual.length
      || actual.some(x => !SHA.test(x)) || new Set(actual).size !== actual.length) return false;
  return Array.isArray(commits) && commits.length === actual.length
    && commits.every(x => SHA.test(x)) && new Set(commits).size === commits.length
    && commits.every(x => actual.includes(x));
}

export function freezeHistory(cwd, base, head, limit = 40 * 1024 * 1024) {
  if (!SHA.test(base) || !SHA.test(head)) throw new Error('INVALID_HISTORY_REF');
  const git = args => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: limit });
    if (r.status !== 0 || r.error) throw new Error('HISTORY_UNAVAILABLE');
    return r.stdout;
  };
  // Reject shallow histories: a successful rev-list is otherwise incomplete.
  if (git(['rev-parse', '--is-shallow-repository']).trim() !== 'false') throw new Error('HISTORY_SHALLOW');
  const commits = git(['rev-list', '--reverse', '--topo-order', `${base}..${head}`]).trim().split('\n').filter(Boolean);
  if (!commits.length || commits.some(x => !SHA.test(x))) throw new Error('HISTORY_EMPTY');
  const diff = git(['diff', '--no-ext-diff', '--no-textconv', '--binary', '--full-index', base, head, '--']);
  let history = '';
  for (const sha of commits) {
    // -m shows each parent's contribution, including changes introduced only by
    // a merge conflict resolution. Reverted changes remain visible in history.
    history += git(['show', '-m', '--root', '--format=fuller', '--no-ext-diff', '--no-textconv', '--binary', '--full-index', sha, '--']);
    if (Buffer.byteLength(history) + Buffer.byteLength(diff) > limit) throw new Error('HISTORY_TOO_LARGE');
  }
  return { commits, diff, history };
}
