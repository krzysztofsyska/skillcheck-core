# SC-014-B3 — isolated HTTP broker handoff

TASK: SC-014-B3. LEVEL: L3. SCOPE: BACKEND.
OWNER: Krzysztof Syska / ChatGPT Orchestrator. BUILDER: ChatGPT (connector-based isolated branch).
REVIEWER: independent Codex (required, not replaced by author's review).
DEPENDS_ON: merged SC-014-A #107, B1 #113, B2 #135, accepted SC-010 baseline.
PRODUCTION_APPROVAL: NO. PROMOTION: NO.
BASE: integration a3612b5fe8eac072b0cf7f0c67c6c672fede80b7.
BRANCH: feat/sc-014-b3-secure-http-broker.
STATUS: CI AND INDEPENDENT REVIEW REQUIRED BEFORE MERGE.

## Scope / contracts

- Owned files: app/api/competency/attempt/route.ts, lib/competency-attempt-broker.ts,
  lib/competency-attempt-broker-runtime.ts, lib/competency-broker-limiter.ts,
  lib/competency-broker-pg.d.ts, lib/competency-broker-role.ts,
  tests/competency-broker-*, tests/helpers/competency-broker-*,
  .github/workflows/sc014-b3.yml and this document.
- No modified B2 SQL or SC-014-A code, no applied migration, no new candidate entity,
  no external candidate contact, no B4 UI. B2 transport maintains transaction
  ownership and returns only after COMMIT; SQL enforces immutable deadline,
  CAS/idempotency/revoke/withdrawal/freeze/erasure.
- POST /api/competency/attempt with a fixed operation discriminator and exact
  parameter allowlist. Methods GET/HEAD/OPTIONS/PUT/PATCH/DELETE return 405.
- Initial POST bootstrap requires pinned HTTPS origin and custom first-party
  header; sets five-minute Secure HttpOnly SameSite=Strict preflight nonce cookie.
  The response contains only a nonce-bound HMAC CSRF value, never the nonce.
  Exchange sends grant secret only inside the POST JSON body and bound CSRF.
  Successful DB commit returns an opaque HTTP-only session cookie; JS sees
  only a new session-bound HMAC CSRF, not the identifier.
- Subsequent inspect/start/save/submit/status accept only the HttpOnly cookie,
  exact CSRF header and Origin. No grant-token-based fallback. Refresh can
  bootstrap an existing cookie without extending DB expiry or resending token.
- Cookie Path is exclusively /api/competency/attempt and has no Domain. Max-Age
  covers B2's start_by plus full 180-minute test and 15-minute receipt window.
  Invalidation authority always resides in PostgreSQL B2 (not cookie expiry).
  Lost Set-Cookie after successful exchange cannot be recreated: B2 has
  unique(grant_id,revision); recovery is only audited issuer rotation.
- Prestart only revision/version/duration/label. In-progress only exact test
  instructions, deadline, own draft and version. Submitted/status only receipt.
  Human scoring/rubric/company/other candidate records are not projected.

## Deployment / privacy

- Feature flag COMPETENCY_BROKER_ENABLED MUST be exactly 'true' and is absent
  by default. Without it the route returns 503 and constructs no DB pool.
  No env values are added in this task. Explicit deployment enablement is
  separate work requiring approvals.
- Activated adapter requires: pinned COMPETENCY_BROKER_ORIGIN (HTTPS),
  COMPETENCY_BROKER_CSRF_KEY and COMPETENCY_BROKER_SOURCE_HMAC_KEY (32-byte hex),
  COMPETENCY_BROKER_LIMITER_REST_URL and _TOKEN (HTTPS shared Redis REST),
  COMPETENCY_BROKER_GATEWAY_DATABASE_URL for dedicated restricted PG LOGIN
  with competency_gateway_* name, TLS certificate validation and membership
  in competency_test_gateway, no direct candidate table DML/SELECT, no extra
  schema privileges or privileged functions, no issuer RPC, no extra member roles.
  Missing dependency fails closed. No service_role, anon Data API RPC or
  production DSN fallback.
- Only verified platform ingress x-forwarded-for on Vercel is trusted.
  No x-real-ip, arbitrary proxy hop, IP sent to Redis or token-based keys.
  Source HMAC uses an hourly rotated domain-separation component;
  Redis carries anonymous HMACs only (never token/digest/tenant/attempt).
  One-minute atomic global+source Redis EVAL; TTL <=75 seconds, cardinality
  <=4096; shared limiter runs before any body read, with bounded concurrent
  admission slots; errors/timeouts block before SQL. No single-instance in-memory
  limiter claimed as multihost protection.
- Resource bounded: max 128 KiB bytes after streaming (even chunked),
  no compression, strict UTF-8/JSON exact keys, cap headers/cookies and
  action inputs before DB; PG max 4 connections per instance, short
  connection/lock/statement/idle timeouts, explicit 7000ms client query_timeout
  including COMMIT, safe idle-pool error listener, no unbounded wait queue.
  SQL errors never sent raw; any uncertain DB transaction destroys lease.
  Responses use no-store/no-referrer and no public CORS.
- Data retention: no new persistent candidate tables, DB session remains
  B2 private.competency_test_sessions, already classified in SC-010 B2
  inventory/freeze/purge/restore. Redis counter/HMAC is ephemeral abuse
  metadata without candidate_id, attempt_id or credential; max TTL 75s.
  CSRF nonce cookie expires after 300s and is not written to DB.
  No application logs/traces contain request body, token, Cookie,
  Set-Cookie, SQL arguments or candidate answers.
- Existing task branches cannot trigger Vercel deploy due to accepted
  vercel.json allowlist. Integration preview remains eligible after merge,
  but B3 is inert there without separately provisioned prerequisites/flag.

## B4 contract (future, NOT implemented)

A public candidate UI must deliver 256-bit grant token exclusively in #grant=
URL fragment. Before hydration, SDK and telemetry, the synchronous first-party
script copies it to memory and synchronously calls history.replaceState
to remove fragment. It then calls POST bootstrap, POST exchange with CSRF and
grant token in body; on result it erases the in-memory token. Subsequent
requests rely on HttpOnly cookie + session CSRF; no localStorage/sessionStorage,
no token in query/path/cookies/logs. No third-party scripts/replay.
The test-only path /__sc014_b3_isolated_harness__ is supplied exclusively
by tests/helpers/competency-broker-harness.mjs via a local HTTPS server,
not by Next/Vercel and not as a candidate product page.

## Isolation and quality gates

- Collision avoidance: did not import/change unmerged #115, #129, #108,
  #111, #112 or voice #96–99. No migration, retention graph or shared
  business logic changes.
- Execute actual Node Route POST/other methods and HTTPS handler against
  PostgreSQL 16 with separate restricted LOGIN; real Redis 7 EVAL.
  Chromium must demonstrate Secure/HttpOnly/SameSite cookie, scrub before
  hydration, refresh, CSRF, draft, submit, receipt, and no browser storage.
- Cover 128 KiB streaming including chunked, JSON, methods, headers, Origin,
  CORS, shared limits, lost COMMIT and SQL rollback/connection destruction,
  two tenants, revoke/rotation/freeze, autosave/submit races and SC-010.
- Repeat SC-014-A and full B2 120 tests with real PostgreSQL 16,
  typecheck, build, required GitHub Checks and Agent Gates.
- Exact HEAD SHA required in test evidence. Any not-run is NOT RUN.
  A separate Codex independent review must verify HEAD/base, security,
  tenant/SC-010, abuse handling and CI. No merge with findings outstanding.
  Routine merge to integration only after proof and protected ruleset;
  main and production remain untouched.

Handoff fields: TASK SC-014-B3; DB/MIGRATIONS NONE; SECURITY L3;
NEXT ACTION execute CI, fix findings, request independent current-SHA
review; if all gates PASS then normal expected-SHA merge to integration.


## Independent Codex R1 findings and remediation evidence (not yet approved)

Original review of e056fd2e: six unresolved findings (2 P1, 4 P2).
Changes on the same feature branch, requiring exact-HEAD CI and a fresh
independent rereview before closing any review thread or merging:

- P1 unrestricted alternative privileges: lib/competency-broker-role.ts audits
  effective privileges on all non-system tables, schemas, sequences,
  SECURITY DEFINER and explicitly granted functions, plus exact role
  memberships, every time a leased session starts. Runtime denies any extra
  privileges; synthetic PostgreSQL16 negative-grant tests cover unexpected
  SELECT, UPDATE, private schema USAGE and public privileged functions.
- P1 bind-parameter logging: require log_statement=none and both
  log_parameter_max_length=0 and log_parameter_max_length_on_error=0
  on restricted login, plus accessible pgaudit/auto_explain guards. Test-only
  PostgreSQL role configuration verifies good/bad login sessions. Runtime
  cannot inspect superuser-only shared_preload_libraries without
  pg_read_all_settings, so a separate DBA attestation of extensions is an
  explicit future activation precondition (no extra runtime privilege).
- P2 abuse: global/source shared Redis limiter and bounded admission happen
  BEFORE streaming/parsing JSON. A zero-read stream regression confirms it.
- P2 production adapter: isolated HTTPS PG16 browser fixture invokes the
  exact createCompetencyGatewayRuntime shared with deployment construct,
  instead of bypassing privileged role, logging, pool, and transport checks.
- P2 idle connection failure: pool error listener consumes error events
  without logging DSNs or SQL details.
- P2 connection blackhole: client query_timeout 7000ms guards statements
  and COMMIT in addition to server-side timeouts and destroyed leases.

There is no claimed independent reviewer PASS for the R1 corrections
until the reviewer explicitly reviews the exact updated SHA. No merge,
no candidate contact, no production activation.


## R2 exact-role boundary and actual production-route regression

The admission audit checks both the dedicated LOGIN and
`competency_test_gateway`, because NOINHERIT makes the latter's privileges
invisible to a session_user-only audit. Each connection must have exactly the
reviewed membership (SET allowed, ADMIN/INHERIT denied), restricted attributes,
no table or column DML/SELECT, no sequence rights, no schema CREATE or grant
options. Ownership dependencies are forbidden for either identity, even after
REVOKE ALL, because an owner can grant itself rights again. Explicit ACLs to
either identity in system schemas are also forbidden, including column rights
and system function EXECUTE. Explicit SET/ALTER SYSTEM privileges on server
parameters are forbidden too, so a role cannot enable parameter logging after
admission. LOGIN has public USAGE and no callable non-system functions; gateway
has public/private USAGE and exactly the six existing B2 function overloads.
PUBLIC invoker functions and extra overloads are not exceptions. Existing
pgcrypto/auth functions without schema USAGE are not callable and do not need
new grants. No database grants are added by this PR.

`competency-broker-role.test.mjs` runs the actual composed SQL in PGlite and
mutates grants, column rights, memberships, ownership and role attributes. This is
supplemental to the real PG16 admission tests, which exercise the HTTP denial
and recovery path for both principals.

`competency-broker-route.test.mjs` launches a test-only HTTPS ingress that invokes
the real exported POST. It does not inject the broker, Pool or limiter. The
production construct validates all environment inputs, creates its actual TLS
pg.Pool, uses the real Redis REST fetch/EVAL adapter, and verifies Vercel XFF.
The workflow provisions a one-day test certificate only on its disposable PG16
container; the child process trusts the fixture CAs. A successful exchange/start
and pg_stat_ssl observation prove that a safe enabled adapter remains usable.
An extra gateway grant must then return generic 503 with no cookie, followed
by recovery after revocation. This harness is never shipped as a product page.

The runtime preserves PostgreSQL's normal PUBLIC access to system catalogs and
built-in functions. It does not certify a cluster whose administrator changes
that global system baseline (for example granting pg_authid SELECT to PUBLIC).
Before any future activation, DBA attestation must additionally verify that
system PUBLIC privileges match the reviewed PostgreSQL/Supabase baseline, as
well as the existing extension logging attestation. This is a deployment gate,
not permission to activate this feature.

All new tests require current-HEAD CI and independent review before merge.
No production configuration, customer activation or provider call is authorized.
