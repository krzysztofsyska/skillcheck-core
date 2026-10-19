# SC-014-B2 — isolated candidate attempt backend

TASK: SC-014-B2. SCOPE: BACKEND. LEVEL: L3. OWNER: Krzysztof Syska / ChatGPT Orchestrator.
BUILDER: Codex (local takeover; no available Cursor dispatch). REVIEWER: separate Codex agent.
PRODUCTION_APPROVAL: NO. STATUS: IN_PROGRESS.
BASE: integration `bd0d1d51edd2590f590172989c7f7681d4d61b62` (verified 2026-10-19).
BRANCH: feat/sc-014-b2-isolated-attempts. Parent: Issue #15.

## Contract

Implement B1's grant/session/attempt/draft/human-review protocol and withdrawal
in an isolated PostgreSQL composition. Reuse SC-014-A, immutable SC-008 definitions,
and accepted SC-010 freeze/purge/restore. No active migration, remote database,
public broker/UI, contact, production, provider or billing activation.

Owned paths: `db/isolated/sc014-b2-*.sql`, `scripts/sc014-b2-*.mjs`,
`tests/competency-*.test.mjs` (new files only),
`tests/helpers/competency-attempt-fixture.mjs`, `lib/competency-attempt-transport.ts`,
`.github/workflows/sc014-b2.yml`, this handoff.
Dependencies: merged #107 and #113; accepted voice retention and SC-019 billing
prototype at the base SHA. B1's late metadata-only OWNER finding is accounted for
by explicit ownership here; no assertion of a new B1 review.

Collision check: open #115 edits billing prototype/checks, #129 checkout,
#108/#111/#112 AI-cost SQL and shared package/workflows; #96–99 edit voice RPCs.
B2 owns separate files, composes only accepted base files, and does not import
their unmerged code. No package.json, common checks, applied migration or roadmap edits.

Tests: B1 T1–T11 applicable backend surfaces; real PostgreSQL16 independent
connections for races and least-privilege transport; supplementary PGlite contract
tests; JS/SQL Unicode/scoring parity; existing SC-014-A and retention regressions;
typecheck/build, exact-SHA CI and independent review. Broker/HTTP/browser tests
are NOT RUN (B3/B4). All fixtures synthetic. Local PostgreSQL package installation
failed because this execution environment denies UID/group changes; real PG tests
must run on the existing GitHub Actions PostgreSQL service, not a mock substitute.

Completion: complete B2, all required tests/CI PASS, independent exact-HEAD/base
review, no unresolved material findings, current branch protection satisfied,
normal expected-SHA merge to integration. Production remains a separate task.

Push effects: task branch deployments disabled by accepted vercel.json;
integration allows its existing preview deployment. No external provider workflow
is required by this task; inspect actual workflow triggers again before publication.

## Test mapping and independent findings

| B1 | Executable B2 coverage |
| --- | --- |
| T1 | Direct RPC/DML denial; actual restricted LOGIN; transport commits before returning |
| T2 | Two tenants/composite FK; owner/recruiter/viewer; membership and owner transaction races |
| T3 | Issue/rotation lost responses, hashes only, immutable audit, lifetime uniqueness |
| T4 | Prestart allowlist, commit rollback, session/draft recovery; browser/cookies NOT RUN (B3/B4) |
| T5 | Full 180-minute SQL duration; real one-minute clock boundary and recovery receipt |
| T6 | Submit/autosave/revoke/freeze on independent PostgreSQL connections; retention graph |
| T7 | Receipt after deadline; denial after revoke/freeze; late submission cannot mutate draft |
| T8 | Application/person withdrawal versus read/review; ordinary rejected/closed review |
| T9 | PostgreSQL16 service, PGlite supplementary runs, SC-010 suite, typecheck/build; HTTP N/A |
| T10 | SC-014-A JS/SQL Unicode and rating parity; invalid submit leaves state unchanged |
| T11 | Confirmed duplicates, transitive groups, later links, stale/shrink revisions and guarded status |

Independent review of local snapshot `78dfdfecfa8b33147c4ffef4e89cd38495b08883`
against the base found P1 incomplete transitive withdrawal propagation and P2
missing SC-014-A rubric validation before issue/start. Both were reproduced by
an independent reviewer in a separate immutable checkout. Corrections and dedicated
regressions are required before a new exact-HEAD review. This preliminary review
was FAIL; it is not merge approval. Final CI/review evidence belongs in the PR.
