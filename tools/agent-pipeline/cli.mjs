import { runCompleteCycle } from './fixtures/complete-cycle.mjs';
import { reconcileFromEnv } from './lib/reconcile.mjs';

const [command, ...args] = process.argv.slice(2);

if (command === 'dry-run') {
  const fixtureFlag = args.indexOf('--fixture');
  const fixture = fixtureFlag === -1 ? 'complete-cycle' : args[fixtureFlag + 1];
  if (fixture !== 'complete-cycle') {
    console.error(`Unknown fixture: ${fixture}`);
    process.exit(2);
  }
  const result = await runCompleteCycle();
  const summary = {
    fixture,
    ok: result.ok,
    external_calls: result.network.length,
    merge_calls: result.calls.filter(call => call === 'github.merge').length,
    repair_round: result.record?.repair_round ?? null,
    task_state: result.record?.state ?? null,
    approval_gate_a: result.record?.binding?.approval?.gate ?? null,
    promotion_state: result.promotion?.state ?? null,
    approval_gate_b: result.promotion?.binding?.approval?.gate ?? null,
    flags: result.flags,
    calls: result.calls,
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (command === 'reconcile') {
  const result = await reconcileFromEnv();
  const summary = {
    mode: result.mode,
    status: result.status,
    effects: result.effects,
    controllerInvoked: result.controllerInvoked,
    reads: result.reads,
    missing: result.missing ?? [],
    flags: result.flags,
    preflight: result.preflight ? { ok: result.preflight.ok, reason: result.preflight.reason ?? null } : null,
    items: result.work?.items?.length ?? 0,
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(result.status === 'NOT_CONFIGURED' ? 1 : 0);
}

console.error('Usage: node tools/agent-pipeline/cli.mjs <dry-run|reconcile>');
process.exit(2);
