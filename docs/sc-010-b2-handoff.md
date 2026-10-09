# SC-010 B2 implementation handoff

- TASK: SC-010 B2; LEVEL: L3; SCOPE: BACKEND.
- STATUS: PR_REVIEW; real PostgreSQL CI and final owner acceptance pending.
- OWNER: Codex orchestrator. REVIEWER: independent Codex architecture/implementation reviewer.
- DEPENDS ON: accepted SC-010 B1 (#69), SC-006 and SC-008.
- BRANCH: feat/sc-010-b2-verification -> integration.
- BASE COMMIT: 5f8036e5eae1ba501d5a8f085d56f124f60d810b. Published head and CI evidence are recorded in the PR.

## Outcome and acceptance

Ed25519 verification binds the exact destination, purpose, tenant, candidate,
recruitment, notice/policy/template, expected revisions and expiry. Only a trusted
server configuration supplies issuer keys. Successful verification writes bounded
metadata plus an AES-256-GCM encrypted snapshot through the dedicated NOLOGIN
verifier capability; ordinary users cannot mint verification evidence. Keyed HMAC
and generation-bound encryption keep plaintext outside persisted B2 data.

Human approval is immutable, scoped to the existing draft and current SC-008
selection. Validity is recalculated after changes to permissions, preferences,
contact, CV/review/shortlist, recruitment/application and trusted registry status.
Denials win. Replay does not renew evidence or restore cancelled drafts. Manual
shortlists with NULL score remain supported. B1 states remain draft/cancelled.

## Changed files and migration

- New lib/contact-verification.ts and cryptographic tests.
- New 20261009141836_candidate_communication_verification.sql; never applied to production.
- New private issuer/policy registries, encrypted contact points and receipt history.
- New public immutable candidate_communication_approvals and approval/status RPCs.
- Database types, exhaustive type contract, fixtures, SQL lifecycle and real PostgreSQL concurrency tests.
- npm scripts, CI steps and B2 architecture/handoff documents.

## Verification

Local: cryptography 23/23; actual full-migration SQL lifecycle 11/11; B1 17/17;
joint SC-006/008/009 9/9; ranking 20/20; report 13/13; database 13/13;
screening 50 PASS with one existing Deno-only skip; typecheck and build PASS.
Real PostgreSQL CI must execute 15 B2 concurrency scenarios plus parent. It is not
represented by PGlite; the local single-UID environment cannot run native PostgreSQL.
CI also runs the existing B1, screening and ranking concurrency suites.

Independent review found and verified fixes for PostgreSQL regex repetition limits
and ordering the latest approval by communication version rather than timestamp.
Final review and CI verdict belong in the PR at the exact published head.

## Security checks, known issues and blockers

Checked signature tampering, wrong tenant/issuer/purpose/version, expiry, AES AAD,
replay, role grants, direct DML denial, private storage, public RLS, immutable history,
source freshness and deny precedence. Test keys and attestations are synthetic;
these tests are not evidence of any real candidate's consent.

No route, provider, worker, schedule, send, callback, production migration or secret
was activated. Registries are empty and verifier has no login or granted membership.
Real issuer onboarding and provisioning are separate reviewed work. Existing B1
retention/redaction/purge and deletion UI remain prerequisites for production.
This completes only B2's offline verification/approval scope, not all SC-010 delivery.

## Next action and continuation prompt

After exact-head CI and independent review PASS: OWNER ACCEPTANCE for integration,
using repository approval rules; never merge to main or apply migrations here.

Executor: ChatGPT/Codex, this same conversation, krzysztofsyska/skillcheck-core.

> SC-010 B2 integration acceptance follow-up. Read Issue #11, the B2 PR, AGENTS.md
> and this handoff. Revalidate the reviewed head, CI including all real PostgreSQL
> concurrency tests, and required owner-acceptance gate. After owner acceptance,
> merge only the unchanged reviewed PR into integration using the required gate.
> Report PR, head, merge SHA and checks; update Issue #11. Do not deploy, apply DB
> migrations, provision issuer keys or contact candidates. Then prepare the next
> bounded architecture proposal from SC-010 dependencies, explicitly addressing
> retention/purge and deletion UI before production; do not implement it without
> authorization. Handoff must include TASK, STATUS, BRANCH, COMMIT, CHANGED FILES,
> DB/MIGRATIONS, TESTS, SECURITY CHECKS, KNOWN ISSUES, BLOCKERS and NEXT ACTION.
