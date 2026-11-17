// Entry point of the auto-release workflow. Runs from a checkout of `main` (trusted code);
// candidate code is never executed: git only moves the reviewed patch onto a release branch.
import { readFileSync, appendFileSync } from 'node:fs';
import { createGithub } from './github.mjs';
import { createGit } from './git.mjs';
import { createAppTokenProvider } from './app-token.mjs';
import { runPublisher } from './publisher.mjs';
import { runSmoke } from './smoke.mjs';
import { createWorkerDeployer } from './worker-deploy.mjs';
import { readBackups } from './backups.mjs';
import { classify } from '../../agent-pipeline/classify-pr.mjs';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const repository = process.env.GITHUB_REPOSITORY;
const app = createAppTokenProvider({
  appId: process.env.APP_ID, installationId: process.env.APP_INSTALLATION_ID, privateKey: process.env.APP_PRIVATE_KEY,
  onToken: t => console.log(`::add-mask::${t}`), // every minted token is masked in the job log
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

// #491: `executor` job output — the auto-migrate environment holds AUTO_MIGRATE_DATABASE_URL
// (presence only). Without it everything stays as before: MIGRATION_EXECUTOR_UNAVAILABLE.
const migrationExecutor = process.env.AUTO_MIGRATE_EXECUTOR === 'true';
// Backup evidence (Supabase Management API, read only), needed only when migrations could run.
const backups = migrationExecutor ? await readBackups({ token: process.env.SUPABASE_ACCESS_TOKEN }) : null;
// `finish` job: the outcome of the migrate job for the release the `publish` job left waiting.
// Missing or unreadable means the migrate job died: its effect on the database is UNKNOWN.
const finishPhase = process.env.PUBLISHER_PHASE === 'finish';
let migrationOutcome = null;
if (finishPhase) {
  let request = null;
  try { request = JSON.parse(process.env.MIGRATION_REQUEST ?? ''); } catch { /* stays null */ }
  try { migrationOutcome = JSON.parse(process.env.MIGRATION_OUTCOME ?? ''); } catch { /* unknown below */ }
  if (!migrationOutcome || typeof migrationOutcome !== 'object' || migrationOutcome.release_head !== request?.release_head) {
    migrationOutcome = { release_head: request?.release_head ?? null, status: 'unknown', applied: null, code: 'MIGRATION_OUTCOME_UNKNOWN' };
  }
}

const result = await runPublisher({
  config, gh, git, sleep, detectScope,
  now: () => new Date(),
  appBotLogin: `${appSlug}[bot]`,
  beforePush: refreshRemote,
  smoke: () => runSmoke({ baseUrl: config.production_url, checks: config.smoke, sleep }),
  // #461: deploys screening-worker from the exact release SHA. Without SUPABASE_ACCESS_TOKEN in
  // this job it answers `unavailable` and the release fails closed (WORKER_DEPLOY_UNAVAILABLE).
  deployWorker: createWorkerDeployer({ git, log: line => console.log(line) }),
  log: line => console.log(line),
  error: code => console.log(`::error::${code}`),
  migrationExecutor, backups, migrationOutcome,
});

console.log(JSON.stringify(result, null, 2));
// #491: hands the waiting release to the `migrate` job (release PR number and head SHA only).
if (result.status === 'AWAIT_MIGRATIONS' && !finishPhase && process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `migration_request=${JSON.stringify(result.migration_request)}\n`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Auto-release: ${result.status}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`);
}
if (['ROLLED_BACK', 'ROLLBACK_FAILED', 'BLOCKED'].includes(result.status) || (result.status === 'FROZEN' && result.freeze && !Array.isArray(result.freeze))) process.exit(1);
