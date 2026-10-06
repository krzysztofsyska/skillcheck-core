import { spawnSync } from 'node:child_process';

export const OPS_002B_ALLOWLIST = [
  /^tools\/agent-pipeline\//,
  /^tests\/agent-pipeline\//,
  /^\.github\/agent-pipeline\//,
  /^\.github\/workflows\/agent-reconcile\.yml$/,
  /^\.github\/workflows\/agent-verify\.yml$/,
  /^\.github\/workflows\/agent-review\.yml$/,
  /^\.github\/workflows\/agent-accept\.yml$/,
  /^\.github\/workflows\/agent-promote\.yml$/,
  /^\.github\/workflows\/agent-gates\.yml$/,
  /^\.github\/workflows\/checks\.yml$/,
  /^package\.json$/,
  /^AGENTS\.md$/,
  /^\.cursor\/rules\/skillcheck-agent-pipeline\.mdc$/,
  /^docs\/AGENT_PIPELINE\.md$/,
  /^docs\/AGENT_WORKFLOW\.md$/,
  /^docs\/sc-ops-002a-agent-orchestration\.md$/,
  /^docs\/sc-ops-002b-cursor-prompt\.md$/,
  /^docs\/sc-ops-002b-handoff\.md$/,
  /^docs\/sc-ops-002c-bootstrap-runbook\.md$/,
  /^docs\/BACKLOG\.md$/,
];

export const OPS_002B_BASE = '579da382f976971392bc15239fded5417945c0f0';

export function outsideAllowlist(files, patterns) {
  return (files ?? []).filter(file => !patterns.some(pattern => pattern.test(file)));
}

export function taskIdFromBody(body) {
  const match = /^TASK:\s*(\S+)/m.exec(String(body ?? ''));
  return match ? match[1].trim() : null;
}

export function scopeTarget({ event, branch = '', env = {} } = {}) {
  const head = branch || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || '';
  const task = taskIdFromBody(event?.pull_request?.body);
  const applies = task === 'SC-OPS-002B' || head.includes('sc-ops-002b-agent-orchestration');
  if (!applies) return { applicable: false, task, branch: head };
  return {
    applicable: true,
    task: 'SC-OPS-002B',
    branch: head,
    base: event?.pull_request?.base?.sha || OPS_002B_BASE,
    patterns: OPS_002B_ALLOWLIST,
  };
}

export function ensureGitObject(object, run = defaultGit) {
  const exists = run('git', ['cat-file', '-e', `${object}^{commit}`]);
  if (exists.status === 0) return { ok: true, object };
  const fetched = run('git', ['fetch', '--no-tags', '--depth=1', 'origin', object]);
  if (fetched.status !== 0) {
    return { ok: false, error: (fetched.stderr || fetched.stdout || 'git fetch failed').trim() };
  }
  const again = run('git', ['cat-file', '-e', `${object}^{commit}`]);
  if (again.status !== 0) return { ok: false, error: (again.stderr || again.stdout || 'comparison base is still missing').trim() };
  return { ok: true, object, fetched: true };
}

export function changedFiles(base, run = defaultGit) {
  const diff = run('git', ['diff', '--name-only', base, 'HEAD']);
  if (diff.status !== 0) return { ok: false, error: (diff.stderr || diff.stdout || 'git diff failed').trim() };
  return { ok: true, files: diff.stdout.split('\n').filter(Boolean) };
}

export function checkScope(context, run = defaultGit) {
  const target = scopeTarget(context);
  if (!target.applicable) return { applicable: false, checked: false, ok: true, task: target.task ?? null };
  const base = ensureGitObject(target.base, run);
  if (!base.ok) return { applicable: true, checked: false, ok: false, error: base.error };
  const diff = changedFiles(base.object, run);
  if (!diff.ok) return { applicable: true, checked: false, ok: false, error: diff.error };
  const outside = outsideAllowlist(diff.files, target.patterns);
  return { applicable: true, checked: true, ok: outside.length === 0, outside, files: diff.files, base: base.object };
}

function defaultGit(command, args) {
  return spawnSync(command, args, { encoding: 'utf8' });
}
