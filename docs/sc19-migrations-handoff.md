# SC-019 forward migrations — implementation and isolated verification

Date: 2026-10-21. TASK: SC-019-MVP-A2-FORWARD-MIGRATIONS. Contract: [#93](https://github.com/krzysztofsyska/skillcheck-core/issues/93), parent [#91](https://github.com/krzysztofsyska/skillcheck-core/issues/91). LEVEL: L3. SCOPE: BACKEND. PRODUCTION_APPROVAL: NO.

Branch: `feat/sc19-forward-migrations-20261021`. Base: `bcc9a200a8a082c13fa3796e9375b37e4b520c8d` on `integration`. Exact final HEAD, CI and independent code-review receipts belong in the PR; the architecture receipts below are separate.

## Delivery and activation boundary

`supabase/migrations/20261021084732_sc019_credits_payments_inventory.sql` is a real forward migration generated with Supabase CLI 2.121.0 using `migration new sc019_credits_payments_inventory`. Its single transaction installs or adopts the accepted six credit tables, four payment tables and immutable SC-010 R6. It uses the existing balances, journal, FREE-claim and analysis reserve/refund logic; there is no second credit ledger.

The migration was exercised only in disposable local PostgreSQL databases. It has not been applied to Supabase, Preview or Production. The payment runtime resolver still returns `null`; no application flag, secret, provider, account or commercial offer is configured. Fresh installs leave **all ten accounting tables empty**, including `sc19_package_policy`. Existing reviewed policy and accounting data are preserved. Functional fixtures seed their own clearly synthetic values after checking the unconfigured state.

PR #152 is already in `integration` as merge `bcc9a200a8a082c13fa3796e9375b37e4b520c8d`; its fixes came from HEAD `60d82361cf8599923be51d1aae6429d82d11667c`. Its three old #129 review threads were resolved by the preceding session. The owner's recorded consent to #152's automatic integration Preview is specific to that PR and does not authorize merging this migration PR. Task-branch publication is permitted by the existing deployment policy; merging into integration needs a separate decision covering its automatic Preview. Production and remote migrations remain unapproved.

## Supported installation and upgrade paths

Every source file is identified by commit, path and SHA256 in `tests/fixtures/sc19-migration-manifest.json`. Tests reconstruct those exact sources, verify their hashes and execute the actual new migration file without removing any guard. These are synthetic source fixtures, not fresh observations of a deployed database.

| Source key | Exact supported starting point | Result |
| --- | --- | --- |
| `r4_legacy` | Complete historical migration chain through `20261012031039_retention_scheduler_inventory.sql` | R6 legacy, fresh empty credit/payment storage |
| `r4_voice` | The same chain plus the seven pinned isolated voice modules and R4-VOICE retention | R6 voice; existing voice adapters preserved; fresh accounting storage empty |
| `r5_legacy` | Historical legacy chain plus the reviewed credit prototype at `bcc9a200…` | Existing policy, balances and credit history adopted; payment storage added |
| `r5_voice` | R4-VOICE plus that same reviewed credit prototype | Same adoption, with voice adapters and quota behavior preserved |
| `orders129_legacy` | Reviewed credit prototype and three-table payment storage at `d34200d2e14302dda9685b79f4e2c59e9049d9b1`, installed before the historical SC-010 chain | Existing orders preserved; unresolved-order uniqueness and request aliases added |
| `orders152_legacy` | Reviewed credit prototype and four-table payment storage at `bcc9a200…`, installed before the historical SC-010 chain | Existing orders/aliases preserved; missing original aliases backfilled |

The order-bearing fixtures respect the payment prototype's historical install guard. They are known blocked precursor states whose old R4 catalog no longer describes the extra storage. Only their exact pinned catalog is accepted, and normalization to R5/R6 is atomic. No product RPC is called during that transition. This does not imply that either precursor exists in Production.

The normal fresh-install test also replays **all current checked-in migrations**, rather than merely loading a selected prototype. Historical prototype tests use the explicit R4 fixture boundary; the new full-chain test passes `throughMigration: null`.

### Final immutable inventory

| Variant | Known tables | SC-010 R6 signature on PG16 and PG17 |
| --- | ---: | --- |
| Legacy | 82 | `e99342b97cf10c9f19c5351f423d30ff4dadaa18294465ff976d926d2cc6a07b` |
| R4-VOICE | 96 | `6fd4900f85f0a1b6f4aad11a9246722cf79e857ea6bc999f7249151f20871061` |

`known_tables` retains SC-010's table-list semantics. Views are also protected by the complete catalog signature and relation fingerprint. R6 is an immutable literal recorded in source, never a signature learned from an arbitrary target. The four preview/manifest/authorization/schedule functions use statically reviewed R6 bodies and preserve the voice adapter refusal. Historical R4/R4-VOICE/R5 records remain unchanged.

## Failure conditions and data integrity

The migration accepts PostgreSQL major 16 or 17 only. It checks a source-derived catalog signature plus routine bodies/owners, indexes and predicates, trigger state, relation owner/RLS, policies and non-owned ACL. PostgreSQL 17's owner `MAINTAIN` privilege has an explicitly pinned ACL fingerprint; it is not silently discarded. Unexpected objects, partial schemas or privilege changes fail closed.

Additional checks cover historical baseline **row data**, validated/enabled internal FK enforcement including referenced relations outside `public`/`private`, safe worker/browser role attributes and memberships, and the absence of active analyses without credit reservations. Owned accounting ACLs are reset by enumerating actual table, column and function grantees, including grant options and hostile default grants. Only the accepted public catalog and authenticated claim/balance RPC grants are restored. Unrelated privileges and global defaults are preserved.

Existing order upgrades refuse multiple `awaiting_payment` orders for a company, an original request alias targeting a different order, or inconsistent paid order/grant/journal evidence. Legitimate extra recovery aliases remain. Missing original aliases inherit the original order time. Paid economics and settlement references are validated without changing price, credits, status, terms, balances or journal entries.

Execution requires a drained application/worker window. A transaction advisory lock and deterministic relation locks stabilize the source; lock timeout is 5 seconds and statement timeout 120 seconds. Any refusal or timeout rolls the entire migration back. Diagnose the cause before retrying; do not remove guards, clear orders or rewrite signatures to make it pass.

### Existing SC-010 signed history is a separate transition

Version 1 refuses existing erasure executions, verified ledger events, receipts, retired candidate IDs, restore checkpoints, requests/freezes, purge context/manifest and retention authorizations. This includes **terminal executions** with retained recovery obligations. The older restore protocol checks its signed schema before deciding whether an event is a no-op; such history cannot safely be ignored or relabeled R6.

The migration neither deletes that history nor changes its signatures. A real source containing it needs a separately reviewed signed-history transition before rollout. Unsigned preview tickets may remain; their stale authorization fails and must be reissued. The native restore evidence below concerns snapshots produced **after R6**, not arbitrary historical snapshots.

## Verification

The dedicated workflow `.github/workflows/sc19-migrations.yml` runs real PostgreSQL 16 and 17 services. Missing database configuration or native dump/restore tools causes failure, not a skipped acceptance test. The fixtures reject remote database addresses.

Run with a disposable loopback PostgreSQL service and matching native client binaries:

```sh
SC19_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
SCREENING_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
SC19_TEST_PG_MAJOR=17 \
PG_DUMP_BIN=/usr/lib/postgresql/17/bin/pg_dump \
PG_RESTORE_BIN=/usr/lib/postgresql/17/bin/pg_restore \
node --experimental-strip-types --test --test-concurrency=1 \
  tests/sc-019-migrations.test.mjs tests/sc-019-migrations-retention.test.mjs
```

Use major/client 16 for the other matrix case. Tests create and drop their own random databases, with independent backend connections and synthetic identities/providers only.

Coverage includes six exact source states and complete-chain installation; fresh missing-policy refusals; unchanged adopted data; unknown schema/ACL/index/function/trigger refusal; original-alias backfill and conflict refusal; tenant and role isolation; single-use FREE, debit and refund; eight parallel distinct-request checkouts and eight parallel webhooks; exactly one grant; immutable purchased economics; rollback after balance increment; lost response/recovery and settlement with checkout disabled.

Legacy recovery uses real `pg_dump` → a new database → `pg_restore`, proves the restored candidate is present, then replays the independently signed ledger to erase the candidate again. It verifies accounting, the second company and repeat replay. The voice case verifies signed purge/replay, unknown voice-adapter refusal and exactly-once release of the existing voice reservation. A separate real terminal R4 purge proves that unsupported old signed history is refused and retained.

Local receipts and final exact-HEAD GitHub evidence are recorded in the PR. Required additional checks are `npm run typecheck`, `npm run build`, existing SC-019 PostgreSQL16/core/HTTP/component regressions and built Next route tests. No production/provider E2E is claimed.

## Independent architecture review

- Original design: `docs/sc19-migrations-design.md`, SHA256 `9f4b1241485bda7f5f195a39e960518f23f1e41989a11bd9fdf51b77a412381c`, independent reviewer `/root/pr152_audit`: PASS before CLI/SQL implementation; [Issue receipt](https://github.com/krzysztofsyska/skillcheck-core/issues/93#issuecomment-6311910014).
- Fresh-policy addendum: `docs/sc19-migrations-addendum.md`, SHA256 `b7ae99a4e8045e0b3c9cde320dfd30994a26260787c7a22c9572dd0169b2cb53`, same independent reviewer: PASS before the correction; [reconciliation receipt](https://github.com/krzysztofsyska/skillcheck-core/issues/93#issuecomment-6312236824).
- Final code review is separate and must name the actual HEAD and integration BASE, inspect the migration/tests and use native database evidence. Any fix invalidates the prior exact-HEAD verdict until re-reviewed.

## Parallel PR #154 and rollout sequencing

[PR #154](https://github.com/krzysztofsyska/skillcheck-core/pull/154) at `1d96da6c8993031c3d04c7b8fa4b7e2bc6df5b4f` is a separate service-role ACL task. Its migration `20261021084245_explicit_data_api_table_acl.sql` sorts before this SC-019 migration. No file or branch of that PR is changed here.

A disposable combined-chain rehearsal on PG16/17 confirmed the canonical profile in which `service_role` is absent: #154 is a no-op, and R4 → #154 → R6 retains the expected output and empty fresh policy. This proves neither a real Supabase ACL profile nor general compatibility with every platform grant. Additional schema/function/private grants still correctly fail the strict source contract.

If #154 lands first, refresh/rebase before merging this PR and rerun combined checks on the real integration base. Its two tests labeled full replay currently use `setupRankingDatabase(db)` without a boundary; integration must explicitly reconcile them with this helper's historical default (`throughMigration: null` for the intended full chain). Do not call an R4-only fixture a full replay. No merge may rely on the earlier BASE receipt after it changes.

## Next bounded stage

After this PR's final CI/review and the specific integration Preview decision, reconcile the intended remote migration history and exact ACL/schema profile with these supported source contracts **read-only**. Resolve any signed-history transition and #154 ordering before preparing a separately approved first Preview application, backup/restore and drain runbook. Do not run a remote migration under this preparation task.

Issue #93 then requires trusted operator company/NIP verification and immutable attestation, followed by the approved payment-provider/auth composition and sandbox end-to-end evidence. Operator/account, final quantities, prices, terms and legal conditions remain owner decisions. Existing pricing work #137/#149–151 must be reused; this PR does not implement another pricing panel, voicebot, AC or full onboarding/KYB system.
