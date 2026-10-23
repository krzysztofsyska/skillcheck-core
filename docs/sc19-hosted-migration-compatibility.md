# SC-019 hosted migration compatibility — PR #160

Task #159, L3. Base: `afbe86278627b0cc0d411158c710743617a3c134`.
Architecture reviewed independently by `/root/migration_review` before implementation.

The 2026-10-23 read-only migration inventory of project `wsvjawuikxfzjyivxgsu`
contains the same 19 entries as `tests/fixtures/sc19-production-history.json`.
The five migration files changed here are pending, not remotely applied. This
change does not authorize remote execution or production promotion.

## Permitted compatibility path

PostgreSQL 16/17 records an automatic creator membership when the non-superuser
`postgres` creates a role. Observed bootstrap grantor `supabase_admin` has OID 10
and SUPERUSER; the creator edge is ADMIN true, INHERIT false, SET false. That
exact edge grants role administration but no inherited or SET ROLE execution.
The guard continues to reject other members, reverse edges, unsafe options and
unsafe protected-role attributes. The existing screening worker operational
edge must retain grantor postgres, ADMIN false, INHERIT false, SET true.

Purge function ownership requires temporary SET membership and schema CREATE.
These are confined to the migration transaction, revoked before COMMIT, and
checked against the original memberships and exact private schema ACL. Ownership
transfers happen after routine ACL setup, avoiding implicit grant authority.
The later R4 replacement executes only its unchanged purge function definition
under the explicitly selected owner, then immediately restores migration identity. The role must not already possess
schema CREATE. The migration's intended persistent schema USAGE remains.
Tests force rollback after the ownership transfers and compare exact original
membership and schema ACL, then verify successful cleanup.

The source-schema fingerprints, six approved profiles and final R6 inventory
remain immutable. Hosted ACL differences may be normalized only with literal
reviewed object/grantee/grantor/privilege/grant-option rules; no arbitrary source
hash or unknown grant is accepted. The reproduced difference is 55 named function EXECUTE grants to service_role
from postgres without grant option (54 public functions and one function moved
to private), plus four explicit public-schema USAGE grants from
pg_database_owner to anon/authenticated/postgres/service_role. The literal list
is in `tests/fixtures/sc19-hosted-acl-differences.json`; all other source catalog
categories match the original r4_legacy profile. Only these matching tuples
are revoked in the hosted creator configuration. The original complete source
fingerprints then decide acceptance; failure rolls every revocation back.
No baseline hashes, stored routine definitions or final R6 fingerprints change.

## Verification contract

Run native PostgreSQL 16 and 17 with actual pg_cron, the non-superuser hosted
creator, all observed historical statements, pending SQL and synthetic existing
data. Test dangerous role edges, unknown schema/function/column ACL and grant
options, failure rollback, successful privilege restoration and all six original
profiles. Existing composed FREE/FAKE settlement tests remain required. No
external providers, commercial values or real candidate data are used.

## Development evidence and limitations

The rehearsal now includes six unsafe-role mutations for each initial guard,
six hosted ACL/schema/membership mutations before SC019, rollback injected
while ownership privileges are active in both ownership migrations, and exact
membership/schema ACL restoration. Indirect SET ROLE migration entry is refused
atomically; successful execution and rollback retain direct postgres identity.
The separate reference database diagnostic was removed: roles are cluster-wide,
so replaying applied guards in a second DB did not create an independent
baseline. The immutable original six-profile manifest remains authoritative.

Local native development uses PostgreSQL 16.15/17.11 and actual pg_cron. The
scratch runner bypasses only the executable startup UID check because the
sandbox maps only UID 0; SQL identities/privileges are unchanged. These runs are
development evidence, not a substitute for unmodified GitHub CI. No runner or
startup shim is committed. Final acceptance requires both native CI versions.
