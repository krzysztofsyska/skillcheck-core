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
