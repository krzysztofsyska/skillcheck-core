import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emptyLedger, LIVE_EFFECTS_ENABLED, step } from './lib/handoff-loop.mjs';

const ACTIVATION_EXIT = 2;

export function runHandoffCli(argv = process.argv.slice(2), env = process.env, io = { log: console.log, error: console.error }) {
  const sandboxAt = argv.indexOf('--sandbox');
  if (sandboxAt !== -1) return runSandbox(argv[sandboxAt + 1], io);
  if (env.CODEX_CURSOR_HANDOFF_ENABLED !== 'true') {
    io.log('STATUS: INACTIVE');
    return 0;
  }
  if (LIVE_EFFECTS_ENABLED) {
    io.error('STATUS: REFUSED_LIVE_EFFECTS_FLAG');
    return 1;
  }
  io.error('STATUS: BLOCKED_ACTIVATION');
  return ACTIVATION_EXIT;
}

function runSandbox(file, io) {
  if (!file || !sandboxPathAllowed(file)) {
    io.error('STATUS: BLOCKED_SANDBOX_PATH');
    return 1;
  }
  const scenario = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(scenario)) {
    io.error('STATUS: BLOCKED_SANDBOX_FIXTURE');
    return 1;
  }
  let ledger = emptyLedger();
  const statuses = [];
  for (const snapshot of scenario) {
    const result = step(ledger, snapshot);
    if (result.outcome.executed.length !== 0 || result.outcome.plan.paid_calls !== false || result.outcome.plan.merge != null || result.outcome.plan.deploy != null || result.outcome.live_effects !== 'blocked') {
      io.error('STATUS: BLOCKED_LIVE_EFFECT');
      return 1;
    }
    ledger = result.ledger;
    statuses.push(result.outcome.status);
  }
  io.log(JSON.stringify({ statuses, attempts: ledger.attempts, executed: 0, live_effects: false }));
  return 0;
}

function sandboxPathAllowed(file) {
  const root = resolve(tmpdir());
  const target = resolve(file);
  const fromRoot = relative(root, target);
  return fromRoot.length > 0 && !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runHandoffCli());
}
