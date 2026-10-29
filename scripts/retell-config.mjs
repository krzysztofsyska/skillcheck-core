// SC-011 Retell interview profile helper. Offline only: no API key, no network.
//   node scripts/retell-config.mjs check [profile]
//   node scripts/retell-config.mjs agent <flow_id> <flow_version> <voice_id> [profile]
//   node scripts/retell-config.mjs digest <saved-get-response.json>
// The digest of a saved GET response is what RetellOutboundConfig pins as
// approvedFlowSha256 / approvedAgentSha256 (same JSON.stringify as the gate).
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {checkRetellInterviewConfig, renderRetellAgent} from '../lib/voice/retell-config-profile.ts';

const [command, ...args] = process.argv.slice(2);
const load = path => JSON.parse(readFileSync(path, 'utf8'));
const profileDir = name => 'config/retell/' + (name ?? 'skillcheck-interview-v1') + '/';

if (command === 'check') {
  const dir = profileDir(args[0]);
  const problems = checkRetellInterviewConfig(load(dir + 'conversation-flow.json'), load(dir + 'agent.json'));
  for (const problem of problems) console.error('- ' + problem);
  if (problems.length) process.exit(1);
  console.log('OK ' + dir);
} else if (command === 'agent' && args.length >= 3) {
  const [flowId, flowVersion, voiceId, profile] = args;
  const agent = renderRetellAgent(load(profileDir(profile) + 'agent.json'),
    {flowId, flowVersion: Number(flowVersion), voiceId});
  console.log(JSON.stringify(agent, null, 2));
} else if (command === 'digest' && args.length === 1) {
  console.log(createHash('sha256').update(JSON.stringify(load(args[0]))).digest('hex'));
} else {
  console.error('usage: check [profile] | agent <flow_id> <flow_version> <voice_id> [profile] | digest <file>');
  process.exit(2);
}
