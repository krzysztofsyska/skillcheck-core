# SC-010-C — bezpieczne wykonanie komunikacji z kandydatem (architektura L3)

TASK: SC-010-C | ISSUE: #78 | SCOPE: OPERATIONS / documentation | IMPLEMENTATION: BACKEND L3
OWNER: SkillCheck | BUILDER: Cursor/Codex | INDEPENDENT REVIEW: required | STATUS: REVIEW_PENDING
BASE: integration (SC-010 B1/B2, SC-008; R1 retention architecture)
PRODUCTION_APPROVAL: NO | PROVIDER SEND: NO | DDL: NO | MIGRATION: NO

## 1. Zakres i niezmienne zasady

Cel: zamienić *aktualny* immutable human-approved candidate-communication draft w pojedynczą, autoryzowaną próbę kontaktu, a następnie w audytowalny wynik. B1/B2 pozwalają zbierać/zweryfikować dowody oraz zatwierdzenia offline. **Zatwierdzenie samo nie pozwala wysłać wiadomości/uruchomić rozmowy.** SC-011-B dostarczy signed provider adapter i webhook. SC-012-B wyda zatwierdzony scenariusz. Wywołania zewnętrzne są poza SQL transaction.

Żaden kod lub test tej fazy nie może dzwonić do rzeczywistych kandydatów, uruchamiać produkcyjnej migracji, zapisywać sekretów do repo, podmieniać service_role w przeglądarce ani aktywować flagi produkcyjnej. Najpierw architecture PASS, osobno implementacja syntetyczna i PASS, osobno owner acceptance integracji, w końcu odrębna zgoda produkcyjna.

## 2. Zaufane wejście i autoryzacja

Serwer nie przyjmuje tenant_id/actor_id, approval-status, consent-status, phone, URL callback ani payloadu providera jako przeglądarkowego dowodu autoryzacji. Z uwierzytelnionej sesji odczytuje tenant i rolę aktora, uprawnienia firmy i rekrutacji. Aktualne trusted contact verification z SC-010 B2, explicit permission revision, deny/opt-out, notice/purpose, godzinę kontaktu, current SC-006 human reviewed analysis i SC-008 *human* shortlist musi odczytać z DB.

Kandydat może mieć wiele aplikacji; zatwierdzenie przypisane do innej aplikacji/firmy/kanału, wcześniejszej wersji kontaktu albo przestarzałej shortlisty jest nieważne. Kontakt e-mail, SMS i voice mają odrębne dozwolone kanały/purpose; przejście na inny kanał wymaga świeżej decyzji człowieka. Revoke/deny zawsze ma pierwszeństwo. Brak informacji lub polityki oznacza odmowę.

Każda autoryzacja jest powtarzana **bezpośrednio przy dispatch** pod spójną blokadą/transakcją; wcześniejsza pozytywna kontrola nie jest uprawnieniem do późniejszej wysyłki. Po zamknięciu rekrutacji, wycofaniu pozwolenia, zmianie numeru lub źródła — zatrzymaj próbę.

## 3. Model danych do rozważenia w osobnej migracji

- private.communication_dispatch_attempts: attempt_id, company_id, recruitment_id, application_id, candidate_id, approved_communication_id, approval_id, verified_contact_revision, approved_plan_version_id (dla voice), channel, purpose, state, lease_generation, lease_expires_at, scheduling_policy_version, permitted_window_snapshot, provider_idempotency_key_digest, request_contract_hash, provider_account_id, provider_call_id nullable, reserved_cost_minor, usage_policy_version, source_fingerprint, retention_policy_version, created_at, created_by, latest_outcome_at. PII i numery kontaktowe poza tą tabelą w minimalnym encrypted/controlled store.
- private.communication_provider_receipts: scoped provider account, immutable external event ID, verified timestamp, raw-body signature result, source attempt, status transition, payload digest, received_at. No raw payload or transcripts.
- private.communication_dispatch_events: append-only state transitions with actor or worker capability, reason enum, fencing generation and timestamps. No CV text or contact details.
- private.communication_budget_reservations: unique logical attempt, company/channel/day, units/cost cap, reserved/settled/released; unknown retains reservation pending reconciliation.
- private.communication_request_keys: (company, caller/principal, operation, request_key) unique with canonical payload hash, logical result and expiration policy.
- Restricted keys + tenant-safe composite FKs tying approval, contact version, shortlist, application and voice plan; design references confirmed actual integration SQL, not guessed parent unique constraints. No operational table in public Data API by default; RLS defense-in-depth on all tables.

Never introduce an FK that blocks lawful erasure without the accepted R1 retention/manifest/purge behavior and a safe redaction/deletion test.

## 4. Minimal execution protocol

States: approved_draft -> eligible -> reserved -> dispatching -> (accepted | delivered | completed | failed | unknown | cancelled). Initial state progression is a proposal, not existing DB code. A provider's accepted response means only acceptance of a request, not actual contact/delivery. signed subsequent events determine delivered/completed.

1. Request/queue: validate immutable human approval, channel, source fingerprint, verified contact, per-tenant cost cap and scheduling policy. Reserve exactly one logical attempt + stable random provider key. Duplicate same idempotency key/payload returns the original attempt; same key/different payload conflicts.
2. Worker lease: dedicated restricted NOLOGIN role with no superuser, bypass RLS, membership inheritance or direct general-table read; narrow SECURITY DEFINER private RPC (EXECUTE revoked from PUBLIC) claim/authorize/record-result with exact purpose, account, expected state and fencing token. Never expose a service key to browser.
3. Dispatch: *immediately before* irreversible provider call, in a DB transaction validate all live permissions, source freshness, retention, recruiter/owner approval, schedule, budgets and lease. Persist DISPATCHING, provider idempotency key and authorization audit, COMMIT. Make the provider call only after commit; avoid DB locks during network activity.
4. Reconcile: on timeout/crash/no provider correlation, mark UNKNOWN (never assume FAILED), persist reservation and block automatic resend. Query-by-key and signed provider events may resolve outcome; if provider lacks reliable query/idempotency semantics, require human reconciliation rather than blind redial.
5. Late or duplicate events: verify raw bytes signed by the correct provider account, timestamp/replay windows, event ID and bound attempt + provider ID before applying monotonic allowable transitions with a version check. Duplicate is idempotent; cancelled and revoked never resurrect through a late success callback.
6. Cancel/revoke: mark pending attempts ineligible, refuse new reservation, issue cancel to vendor when supported, reconcile unknown in-flight activity; never assert cancellation proves external phone call did not occur.

**Critical race**: permission can be revoked between authorization transaction commit and provider call. Vendor side effects cannot be made atomically with PostgreSQL. Protocol must document conservative maximum race exposure (e.g. just-in-time recheck, worker one-attempt fencing, cancellation/reconciliation) and must not promise mathematically impossible zero post-commit window. No unchecked automatic retry.

## 5. Global lock order is a blocking review gate

Existing SC-006 takes application-scoped screening advisory lock before analysis. Existing SC-008 uses analysis -> application -> recruitment -> position -> document. SC-010 permission/contact operations take candidate and owner/member rows in their existing audited order. DO NOT invent a cross-scope order or attempt nested locks around a provider request.

Before runtime SQL, derive exact lock graph and FK graph from current migration functions, including permission revoke, source review, shortlist, approved communication and dispatch. Define a single compatible acquisition sequence and demonstrate two-session real PostgreSQL race tests: revoke vs claim, revoke vs authorize, shortlist removal vs authorize, SC-006 review mutation vs dispatch, duplicate lease, dispatch vs cancel, approved-plan version update vs voice dispatch. If graph has a cycle, split operations into separately committed steps with freshness fences or redesign; do not suppress deadlocks with blanket retry.

SQLSTATE 55P03/40001: bounded safe conflict/whole-transaction retry after fresh authorization and same idempotency key, never repeat network side effect.

## 6. Scheduling, costs, provider contracts

- Scheduling: tenant and contact timezone validated via IANA name; DST ambiguous/nonexistent local times must be explicitly resolved; time windows checked at reservation *and* dispatch, never assumed solely from queue timestamp.
- Budget: atomic pre-dispatch reservation for tenant/day/recruitment/channel; cap attempts, daily spend and pending UNKNOWN holds; on settlement use verified provider costs and release remainder; no fictional SC-021 dependency.
- Provider: strict channel-specific request schema, signed raw-body webhooks, pinned provider account, bounded payload and allowed status enum. Real adapter SC-011-B depends on vendor selection and DPA/region/recording retention approval. Default voice recording OFF, notices independent of contact permission.
- PII: encrypted verified contact only when truly needed, never contact/CV in logs, telemetry or idempotency digests; identifiable transcript remains SC-013 private lifecycle. Retention and erasure R1 remains gate before production activation.

## 7. Synthetic acceptance matrix

A) Tenant isolation owner/recruiter/viewer/anon + worker capability, deny cross-tenant and direct SQL mutations.
B) Exactly one attempt for duplicate requests; independent requests limited by approval/contact policy and budgets; conflicting payload same key rejected.
C) Revocation/opt-out and stale shortlist/analysis/source prevent claim/dispatch; test both transaction interleavings.
D) Two concurrent worker claims and expired lease fencing; late worker cannot record success.
E) Timeout after commit -> UNKNOWN, no redial; provider query-by-key eventual reconciliation, duplicate/out-of-order signed events.
F) IANA/DST invalid hours and per-tenant quota exhaustion blocked; cancellations and retention freezes.
G) Real PostgreSQL lock/deadlock tests plus typecheck, build and regressions SC-006/008/009/010/011/012.
H) No actual provider calls, secrets, external candidates or production data in test runs.

## 8. Delivery sequence and handoff

C0 (this PR): architecture and independent security/SQL review. C1: restricted synthetic no-network worker, state machine and tests. C2: reviewed RLS/composite-FK migration generated by Supabase CLI and executed **only in disposable test DB**, including all lock races. C3: adapter and signed webhook after SC-011-B decision. C4: controlled staging E2E on synthetic recipient, explicit production approval separately.

TASK SC-010-C | BRANCH docs/sc-010c-dispatch-architecture | STATUS ARCHITECTURE_REVIEW | CHANGED FILES docs/sc-010c-dispatch-architecture.md | DB/MIGRATIONS NONE | TESTS PLANNED ONLY | SECURITY CHECKS pending independent reviewer | KNOWN ISSUES global lock graph, vendor choice, retention and R1, signed-issuer onboarding | BLOCKERS independent PASS and owner acceptance before backend writes | DEPLOY NONE.
