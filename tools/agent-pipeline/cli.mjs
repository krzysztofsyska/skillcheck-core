import { runCompleteCycle } from './fixtures/complete-cycle.mjs';
import { flagsFromEnv } from './lib/policy.mjs';

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
  const flags = flagsFromEnv();
  if (!flags.enabled) {
    console.log(JSON.stringify({ mode: 'read-only', status: 'IMPLEMENTED', effects: [], flags }));
    process.exit(0);
  }
  console.log(JSON.stringify({ mode: 'live', status: 'NOT_CONFIGURED', effects: [], flags, reason: 'SC-OPS-002C bootstrap has not confirmed the GitHub App, environments, or branch rulesets' }));
  process.exit(0);
}

console.error('Usage: node tools/agent-pipeline/cli.mjs dry-run --fixture complete-cycle');
process.exit(2);
