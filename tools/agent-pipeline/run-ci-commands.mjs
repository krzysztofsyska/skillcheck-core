import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildCiEnvelope, commandsFromPolicy } from './lib/ci.mjs';
import { environmentFor } from './lib/credentials.mjs';
import { loadPolicy } from './lib/policy.mjs';

const policy = loadPolicy(process.env.AGENT_POLICY_PATH);
const head = process.env.AGENT_HEAD_DIR;
if (!head) throw new Error('AGENT_HEAD_DIR is required');
const env = environmentFor('ci', process.env);
const commands = commandsFromPolicy(policy);
const executed = [];
let failed = null;
for (const command of commands) {
  const result = spawnSync(command.argv[0], command.argv.slice(1), { cwd: head, env, encoding: 'utf8' });
  executed.push(command.command);
  if (result.status !== 0) {
    failed = command.command;
    console.error(result.stderr || result.stdout);
    break;
  }
}
const envelope = buildCiEnvelope({
  policy,
  policySha: process.env.AGENT_POLICY_SHA,
  headSha: process.env.AGENT_HEAD_SHA,
  baseSha: process.env.AGENT_BASE_SHA,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  commandsExecuted: executed,
  conclusion: failed ? 'failure' : 'success',
});
writeFileSync('ci-result.json', `${JSON.stringify(envelope)}\n`);
console.log(JSON.stringify({ ok: !failed, failed, executed, source: 'policy' }));
if (failed) process.exit(1);
