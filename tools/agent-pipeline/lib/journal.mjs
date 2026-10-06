import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, sha256 } from './canonical.mjs';

function git(repo, args, { input } = {}) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', input });
  if (result.status !== 0) {
    const error = new Error((result.stderr || result.stdout || 'git failed').trim());
    error.code = 'GIT';
    throw error;
  }
  return (result.stdout || '').trim();
}

export function initStateRepo(dir) {
  git(dir, ['init', '-b', 'agent-state']);
  git(dir, ['config', 'user.email', 'controller@skillcheck.local']);
  git(dir, ['config', 'user.name', 'skillcheck-controller']);
  mkdirSync(join(dir, 'state', 'tasks'), { recursive: true });
  mkdirSync(join(dir, 'journal'), { recursive: true });
  mkdirSync(join(dir, 'outbox'), { recursive: true });
  mkdirSync(join(dir, 'locks'), { recursive: true });
  writeFileSync(join(dir, 'state', 'index.json'), `${canonicalJson({ schema_version: 1, tasks: {} })}\n`);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init agent-state']);
  return git(dir, ['rev-parse', 'HEAD']);
}

function show(dir, spec) {
  const result = spawnSync('git', ['show', spec], { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout;
}

export function readProjection(dir) {
  const head = git(dir, ['rev-parse', 'HEAD']);
  const index = JSON.parse(show(dir, `${head}:state/index.json`));
  const tasks = {};
  for (const taskId of Object.keys(index.tasks)) {
    tasks[taskId] = JSON.parse(show(dir, `${head}:state/tasks/${safe(taskId)}.json`));
  }
  const lockText = show(dir, `${head}:locks/merge.json`);
  return { index, tasks, mergeLock: lockText ? JSON.parse(lockText) : null, head };
}

export function commitProjection(dir, { tasks, mergeLock = null, outbox = [], journalEntries = [], expectedHead }) {
  const parent = expectedHead ?? git(dir, ['rev-parse', 'HEAD']);
  const work = mkdtempSync(join(tmpdir(), 'agent-state-'));
  try {
    git(dir, ['worktree', 'add', '--detach', work, parent]);
    const index = { schema_version: 1, tasks: {} };
    mkdirSync(join(work, 'state', 'tasks'), { recursive: true });
    mkdirSync(join(work, 'journal'), { recursive: true });
    mkdirSync(join(work, 'outbox'), { recursive: true });
    mkdirSync(join(work, 'locks'), { recursive: true });
    for (const [taskId, record] of Object.entries(tasks)) {
      index.tasks[taskId] = { revision: record.state_revision };
      writeFileSync(join(work, 'state', 'tasks', `${safe(taskId)}.json`), `${canonicalJson(record)}\n`);
    }
    writeFileSync(join(work, 'state', 'index.json'), `${canonicalJson(index)}\n`);
    if (mergeLock) writeFileSync(join(work, 'locks', 'merge.json'), `${canonicalJson(mergeLock)}\n`);
    for (const entry of outbox) writeFileSync(join(work, 'outbox', `${entry.notification_id}.json`), `${canonicalJson(entry)}\n`);
    let previousHash = null;
    for (const entry of journalEntries) {
      const taskDir = join(work, 'journal', safe(entry.task_id));
      mkdirSync(taskDir, { recursive: true });
      const stored = { ...entry, previous_hash: previousHash ?? entry.previous_hash ?? null };
      stored.entry_hash = sha256(stored);
      previousHash = stored.entry_hash;
      writeFileSync(join(taskDir, `${String(stored.state_revision).padStart(6, '0')}.json`), `${canonicalJson(stored)}\n`);
    }
    git(work, ['add', '-A']);
    const status = git(work, ['status', '--porcelain']);
    if (!status) return { ok: true, sha: parent, unchanged: true };
    git(work, ['commit', '-m', 'agent-state transition']);
    const next = git(work, ['rev-parse', 'HEAD']);
    if (process.env.AGENT_STATE_RACE_DELAY_MS) {
      spawnSync('sleep', [String(Number(process.env.AGENT_STATE_RACE_DELAY_MS) / 1000)]);
    }
    const update = spawnSync('git', ['update-ref', 'refs/heads/agent-state', next, parent], { cwd: dir, encoding: 'utf8' });
    if (update.status !== 0) return { ok: false, conflict: true, expected: parent, stderr: update.stderr };
    return { ok: true, sha: next, previous: parent };
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', work], { cwd: dir, encoding: 'utf8' });
    rmSync(work, { recursive: true, force: true });
  }
}

export function updateState(dir, mutator) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = readProjection(dir);
    const draft = mutator(structuredClone(current));
    const result = commitProjection(dir, { ...draft, expectedHead: current.head });
    if (result.ok) return { ...result, projection: readProjection(dir) };
  }
  const error = new Error('AGENT_STATE_CONFLICT');
  error.code = 'AGENT_STATE_CONFLICT';
  throw error;
}

function safe(taskId) {
  return String(taskId).replace(/[^A-Za-z0-9._-]/g, '_');
}
