// Entry point of the auto-release workflow. Runs from a checkout of `main` (trusted code);
// candidate code is never executed: git only moves the reviewed patch onto a release branch.
import { readFileSync, appendFileSync } from 'node:fs';
import { createGithub } from './github.mjs';
import { createGit } from './git.mjs';
import { createAppTokenProvider } from './app-token.mjs';
import { runPublisher } from './publisher.mjs';
import { runSmoke } from './smoke.mjs';
import { classify } from '../../agent-pipeline/classify-pr.mjs';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const repository = process.env.GITHUB_REPOSITORY;
const app = createAppTokenProvider({
  appId: process.env.APP_ID, installationId: process.env.APP_INSTALLATION_ID, privateKey: process.env.APP_PRIVATE_KEY,
});
const gh = createGithub({ token: app.token, repository });
const appSlug = await app.slug();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const git = createGit();
git('config', 'user.name', `${appSlug}[bot]`);
git('config', 'user.email', `${appSlug}[bot]@users.noreply.github.com`);
// The token lives only in the local remote URL of this ephemeral checkout, refreshed before every
// fetch/push (C5: installation tokens expire after 1 hour). Never printed.
const refreshRemote = async () => { git('remote', 'set-url', 'origin', `https://x-access-token:${await app.token()}@github.com/${repository}.git`); };
await refreshRemote();
git('fetch', '--no-tags', 'origin', 'main', 'integration');

function detectScope(files) {
  const body = ['TASK: x', 'SCOPE: OPERATIONS', 'LEVEL: L3', 'OWNER_APPROVAL: x', 'PRODUCTION_APPROVAL: x', 'REVIEW_VERDICT: x', 'PROMOTION: YES'].join('\n');
  return classify({ files, body, base: 'integration', headRef: '' }).detected ?? 'OPERATIONS';
}

const result = await runPublisher({
  config, gh, git, sleep, detectScope,
  now: () => new Date(),
  appBotLogin: `${appSlug}[bot]`,
  beforePush: refreshRemote,
  smoke: () => runSmoke({ baseUrl: config.production_url, checks: config.smoke, sleep }),
  log: line => console.log(line),
  error: code => console.log(`::error::${code}`),
});

console.log(JSON.stringify(result, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Auto-release: ${result.status}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`);
}
if (['ROLLED_BACK', 'ROLLBACK_FAILED', 'BLOCKED'].includes(result.status) || (result.status === 'FROZEN' && result.freeze && !Array.isArray(result.freeze))) process.exit(1);
