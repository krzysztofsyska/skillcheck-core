import { spawnSync } from 'node:child_process';
import { commandsFromPolicy } from './lib/ci.mjs';
import { environmentFor } from './lib/credentials.mjs';
import { loadPolicy } from './lib/policy.mjs';

const policy = loadPolicy(process.env.AGENT_POLICY_PATH);
const head = process.env.AGENT_HEAD_DIR;
if (!head) throw new Error('AGENT_HEAD_DIR is required');
const env = environmentFor('ci', process.env);
const commands = commandsFromPolicy(policy);
const executed = [];
for (const command of commands) {
  const result = spawnSync(command.argv[0], command.argv.slice(1), { cwd: head, env, encoding: 'utf8' });
  executed.push(command.command);
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    console.log(JSON.stringify({ ok: false, failed: command.command, executed }));
    process.exit(result.status ?? 1);
  }
}
console.log(JSON.stringify({ ok: true, executed, source: 'policy' }));
