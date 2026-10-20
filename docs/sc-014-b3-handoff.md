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
  lib/competency-broker-pg.d.ts, tests/competency-broker-*, tests/helpers/competency-broker-*,
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
  in competency_test_gateway, no table SELECT, no issuer RPC, no privileged role.
  Missing dependency fails closed. No service_role, anon Data API RPC or
  production DSN fallback.
- Only verified platform ingress x-forwarded-for on Vercel is trusted.
  No x-real-ip, arbitrary proxy hop, IP sent to Redis or token-based keys.
  Source HMAC uses an hourly rotated domain-separation component;
  Redis carries anonymous HMACs only (never token/digest/tenant/attempt).
  One-minute atomic global+source Redis EVAL; TTL <=75 seconds, cardinality
  <=4096; error/timeout blocks before SQL. No single-instance in-memory
  limiter claimed as multihost protection.
- Resource bounded: max 128 KiB bytes after streaming (even chunked),
  no compression, strict UTF-8/JSON exact keys, cap headers/cookies and
  action inputs before DB; PG max 4 connections per instance, short
  connection/lock/statement/idle timeouts, no unbounded wait queue.
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
