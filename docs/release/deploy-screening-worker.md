# Deploy `screening-worker` to production

Workflow: `.github/workflows/deploy-screening-worker.yml` (manual, `main` only).

## How it is safe
- Runs only on `workflow_dispatch` from `main`; the job refuses any other ref.
- Job environment `production-approval`: it waits until the owner approves this exact run.
- `SUPABASE_ACCESS_TOKEN` is a secret of the `production-approval` environment, so it is available only after that approval.
- Deploys only `screening-worker` to project `wsvjawuikxfzjyivxgsu`. No migrations, no secrets changes. `verify_jwt = false` comes from `supabase/config.toml`; the worker verifies HMAC itself.
- Actions are pinned to commit SHAs and the Supabase CLI to an exact version.

## One-time setup (owner)
1. Create a Supabase access token: Supabase dashboard → Account → Access Tokens → "Generate new token" (name: `github-deploy-screening-worker`).
2. In GitHub: Settings → Environments → `production-approval` → Environment secrets → "Add environment secret", name `SUPABASE_ACCESS_TOKEN`, value: the token.

## Each deployment (owner)
1. Actions → "Deploy screening-worker" → "Run workflow" (branch `main`).
2. Open the run → "Review deployments" → `production-approval` → "Approve and deploy".
3. The run summary shows the deployed `main` revision. The agent then checks the function version read-only and runs the smoke test.

## Automatic path (#461, stage 1 — not active yet)
The automatic publisher (`.github/workflows/auto-release.yml`, environment `agent-control`) has a
worker deploy step: after a release that touches the worker or a module it shares with the app is
merged into `main` and Vercel has confirmed the app, it runs the same
`supabase functions deploy screening-worker --project-ref wsvjawuikxfzjyivxgsu` from a worktree
of that exact merge SHA, before the smoke test. A failed, unconfirmed or impossible deploy (no
token) rolls the release back and freezes automatic releases. Code:
`tools/release/auto/worker-deploy.mjs`; rules: `docs/continuous-release-policy.md`
(`WORKER_DEPLOY_REQUIRED`).

It does not run yet, for two reasons:
- `SUPABASE_ACCESS_TOKEN` is a secret of `production-approval` only. Adding it as an environment
  secret of `agent-control` is a one-time owner step (secrets are never set by agents).
- The release gate `WORKER_DEPLOY_REQUIRED` still holds every release touching the worker, until
  one real automatic deploy has been verified (stage 2, separate review).

Until then the manual workflow above remains the way to deploy the worker.
