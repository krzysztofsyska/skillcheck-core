# SC-014-B2 — isolated candidate attempt backend

TASK: SC-014-B2. SCOPE: BACKEND. LEVEL: L3. OWNER: Krzysztof Syska / ChatGPT Orchestrator.
BUILDER: Codex (local takeover; no available Cursor dispatch). REVIEWER: separate Codex agent.
PRODUCTION_APPROVAL: NO. STATUS: IMPLEMENTED; exact-HEAD acceptance tracked in PR #135.
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
an independent reviewer in a separate immutable checkout, fixed and covered by
dedicated regressions. The reviewer independently repeated attempts, withdrawal
and retention (26/26 supplementary PGlite PASS) and closed both findings. This is
not a substitute for real PostgreSQL concurrency evidence. Final exact-HEAD
CI/review results and integration merge evidence belong in PR #135.


## Accepted SC-019 policy composition update (2026-10-20)

PR #115 was independently reviewed and merged as integration
`fbc75c79530fa81ddb8e94e71fcc5f1293f5553e` (PR head
`5701b16e3dcbfe4f79fb27a315c1db4614d93811`). The composer now pins that exact
billing source, SHA-256
`219ba643a0dff4dcee342065544e375fa549aa30f35c0e525414949a46aec240`.
The reviewed delta adds global package policy, its timestamp trigger and the
restricted public catalog RPC. The policy belongs in the known table inventory;
it has no candidate relationship and is not a candidate erasure adapter.

The predecessor R5-VOICE signature is the literal accepted by #115:
`c989b84b9eec51fc48c361b8ad9e7404b4044268d56d106b6788fe56f3f1857d`.
The isolated B2 composition signature is
`b20053a8e9a9990fbf3a031026940947ed091b65a1643a5e070768801e6a40b7`.
It was derived only by booting a fresh synthetic PGlite database from the full
checked-in accepted chain: retaining the old B2 literal caused the existing
SC014_B2_SCHEMA_MISMATCH guard to abort and report this digest. No deployed
schema was queried; no guard was removed; no installed baseline was updated.
PostgreSQL 16 CI must independently confirm this same literal.

The fixture compares all prior R4/R4-VOICE/R5 signature rows before and after
B2 composition. Retention tests assert that package policy is known, excluded
from candidate manifests and unchanged after a signed purge. Existing unknown
schema and immutable baseline rejection tests remain enabled. The source hash
check still rejects even a synthetic comment appended to a copied input.
Both B2 and B3 workflows now run when either manifest source changes, catching
this dependency on the source PR before integration merge.
