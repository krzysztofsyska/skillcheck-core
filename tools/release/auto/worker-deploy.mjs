// #461 stage 1: deploy the Supabase Edge Function `screening-worker` from one exact commit on
// `main`, as a step of the automatic release (`publisher.mjs` `deployWorkerStep`).
//
// - The code deployed is a detached worktree of that SHA, never the publisher's own checkout and
//   never a PR branch; the SHA must already be on origin/main.
// - Same command and project as `.github/workflows/deploy-screening-worker.yml`.
// - The token comes from the environment only. Empty -> `unavailable` (the release fails closed
//   with WORKER_DEPLOY_UNAVAILABLE). It is passed to the CLI process alone and never printed.
// - Success = exit code 0 AND the CLI's own confirmation line naming the project and function.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const WORKER_PROJECT_REF = 'wsvjawuikxfzjyivxgsu';
export const WORKER_FUNCTION = 'screening-worker';
const SHA = /^[0-9a-f]{40}$/;
// Only what the CLI needs; the App private key and other job secrets stay out of the child.
const PASS_ENV = ['PATH', 'HOME', 'TMPDIR', 'RUNNER_TEMP', 'DOCKER_HOST', 'XDG_CONFIG_HOME'];

export function createWorkerDeployer({ git, env = process.env, spawn = spawnSync, projectRef = WORKER_PROJECT_REF, log = () => {} }) {
  return async function deployWorker({ sha } = {}) {
    if (!SHA.test(sha ?? '')) return { ok: false, code: 'WORKER_DEPLOY_SHA_INVALID' };
    const token = typeof env.SUPABASE_ACCESS_TOKEN === 'string' ? env.SUPABASE_ACCESS_TOKEN.trim() : '';
    if (!token) return { ok: false, unavailable: true, code: 'WORKER_DEPLOY_UNAVAILABLE' };
    if (!git.ok('merge-base', '--is-ancestor', sha, 'origin/main')) return { ok: false, code: 'WORKER_DEPLOY_NOT_ON_MAIN' };
    const dir = mkdtempSync(join(tmpdir(), 'worker-deploy-'));
    try {
      if (!git.ok('worktree', 'add', '--detach', dir, sha)) return { ok: false, code: 'WORKER_DEPLOY_CHECKOUT_FAILED' };
      if (git('-C', dir, 'rev-parse', 'HEAD').trim() !== sha) return { ok: false, code: 'WORKER_DEPLOY_CHECKOUT_MISMATCH' };
      const childEnv = { SUPABASE_ACCESS_TOKEN: token };
      for (const k of PASS_ENV) if (env[k]) childEnv[k] = env[k];
      const r = spawn('supabase', ['functions', 'deploy', WORKER_FUNCTION, '--project-ref', projectRef], {
        cwd: dir, env: childEnv, encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
      });
      const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
      const confirmed = r.status === 0
        && new RegExp(`Deployed Functions on project ${projectRef}:[^\\n]*\\b${WORKER_FUNCTION}\\b`).test(out);
      if (!confirmed) {
        // First line of the CLI's error only, with the token cut out in case the CLI echoed it.
        const first = (r.error?.code ?? (r.stderr || r.stdout || '').split('\n').find(l => l.trim()) ?? '').split(token).join('***');
        log(`WORKER_DEPLOY_FAILED exit=${r.status ?? 'none'} ${String(first).slice(0, 160)}`);
        return { ok: false, code: r.status === 0 ? 'WORKER_DEPLOY_NOT_CONFIRMED' : `WORKER_DEPLOY_EXIT_${r.status ?? 'NONE'}` };
      }
      return { ok: true, sha };
    } finally {
      git.ok('worktree', 'remove', '--force', dir);
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
