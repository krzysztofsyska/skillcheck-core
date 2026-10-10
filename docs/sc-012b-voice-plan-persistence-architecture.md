# SC-012-B — kontrakt trwałego scenariusza i przeglądu rekrutera (L3)

TASK: SC-012-B; SCOPE: FULLSTACK; OWNER: Cursor builder; REVIEWER: independent Codex; STATUS: ARCHITECTURE_REVIEW.
DEPENDS ON: #80, merged SC-012-A #76, SC-006, SC-008, SC-010 B1/B2. Production approval NO.

## Zweryfikowany baseline (10 października 2026)
- `integration` zawiera `lib/voice/interview-plan.ts`, cztery wspólne pytania i maksymalnie dwa dopytania `task:n|kpi:n|competency:n`.
- Rzeczywista historia produkcyjnych migracji Supabase `wsvjawuikxfzjyivxgsu` kończy się na `20261009091318 screening_ranking_shortlist`; **brak tabel voice i komunikacji**. Migracje SC-010 B1 `20261009105025` i B2 `20261009141836` są tylko w `integration`, bez produkcyjnego zastosowania. Nigdy nie stosować ich ponownie bez kontrolowanego runbooka.
- Repo ma `applications(company_id,recruitment_id,id)`, `screening_analysis_versions`, `screening_result_reviews` oraz `recruitment_shortlist_entries`; B2 w repo ma `candidate_communication_approvals`, lecz nie autoryzuje wykonania połączeń.
- To dokument i kontrakt dla implementacji; **nie tworzy migracji**.

## Granice: source-of-truth i prywatność
Generowanie opiera się wyłącznie na `position` powiązanym z rekrutacją, aktualnym ukończonym screening analysis, **ostatnim zatwierdzonym human review**, jego rzeczywistych kryteriach i aktualnej shortliście zatwierdzonej przez człowieka. Serwer wyprowadza `company_id`, `application_id`, `position_id`, `analysis_id`, `review_id` z chronionych relacji. Przeglądarka nie może przesłać `screeningCurrent=true`, `screeningReviewed=true`, dowolnych luk ani `reviewerId` jako uprawnień. Dopytania są wyliczane z zatwierdzonych wyników kryteriów; kod ma whitelistę ID i ograniczenie 0–2. Brak możliwości wczytania prawdziwej analizy w produkcji nie jest pozornym PASS.

Snapshot wejścia: `position_updated_at`, `application_updated_at`, `recruitment_updated_at`, `analysis_id`, `review_id`, `shortlist_entry_id`, `input_fingerprint`, `analysis_contract_hash`, `template_version`, `prompt_version`. Snapshot nie zawiera nazwiska, numeru telefonu, oryginalnego CV ani nieograniczonych instrukcji. Wersje zatwierdzeń i hash kanonicznej projekcji wejścia zamraża się przed zapisem; zmiana któregokolwiek źródła oznacza stale i konflikt, bez cichego ponowienia.

## Proponowana baza (tylko po zaakceptowanym review i wygenerowaniu migracji CLI)
1. `public.voice_plan_versions`: `id uuid`, `company_id`, `recruitment_id`, `application_id`, `position_id`, `analysis_id`, `review_id`, `shortlist_entry_id`, `plan_version bigint`, `status generated|reviewed|released|stale`, `source_hash char(64)`, `contract_version`, `questions jsonb`, `created_at`, `created_by`. Unikalne `(company_id,application_id,plan_version)` i `(company_id,id)`; pełne tenant-safe composite FKs, w tym identyczna aplikacja dla shortlisty.
2. `public.voice_plan_review_entries`: immutable append-only `(company_id,plan_id,review_version,decision,reviewer_id,reviewed_at,expected_source_hash,reason)`; decyzja `approved|requires_changes`. Jeden reviewer zapisuje przez kontrolowane RPC; brak bezpośredniego DML.
3. `public.voice_plan_release_entries`: immutable `(company_id,plan_id,review_id,release_version,released_by,released_at,source_hash)`. Złożony FK review–plan, tylko review o decyzji approved, weryfikacja fresh. Każde release ma niepowtarzalną wersję i idempotency request hash; **release nie jest pozwoleniem na kontakt**.
4. `private.voice_plan_request_keys`: unique `(company_id,actor_id,operation,request_key)` z `payload_hash`, `result_id`, bez treści pytań.

**Krytyczne**: historycznych planów nie aktualizujemy w miejscu. Wariant `stale` wylicza odczyt `freshness_reason` z bieżących danych, nie mutuje immutable payloadów. Konflikt HTTP/RPC PT409 po zmianie źródeł. Kolumny status i przejścia wymagają jednej niezmiennej interpretacji — preferowany `plan version` immutable + `review/release` append-only, status pochodny, nie pole mutowane.

## Uprawnienia i atomowość
SELECT tylko do własnej firmy (RLS, viewer read-only); mutacje przez wąskie RPC dla owner/recruiter, anon i obca firma deny, screening_worker i contact_verifier nie mają dostępu. Nie dawać bezpośredniego INSERT/UPDATE/DELETE do żadnej tabeli planów. `SECURITY DEFINER` tylko wąskie funkcje z `search_path=''`, jawny `auth.uid()`, RLS, tenant binding, ograniczone EXECUTE po REVOKE PUBLIC. Nie ufać `user_metadata` ani klientowym UUID.

`create_voice_plan(target_application, expected_analysis, expected_review, expected_shortlist, request_key)`: lock/access, sprawdź wszystkie aktualne snapshoty, wylicz zamrożony plan na serwerze, utrwal dokładną treść. Żadne CV raw, kontakty i output od modelu nie trafiają do JSON scenariusza.

`review_voice_plan(target_plan,expected_version,decision,request_key)`: porównaj hash i snapshot, uprawnienia, brak starszego lub konfliktowego review, append-only review; nie przyjmuj obiektu zatwierdzonego po stronie klienta. `release_voice_plan(target_plan,review_id,expected_source_hash,request_key)`: aktualny zatwierdzony review, atomowe zużycie wersji, czas `released_at >= reviewed_at`, nie pozwala na drugi release ani stale. Żaden RPC nie wywołuje provider API.

Dla lock order zastosować utrwalony porządek istniejących SC-006/008 i SC-010 (autoryzacja przed blokadami, NOWAIT i kontrolowane PT409). Przed SQL należy spisać dokładną kolejność `analysis/source -> application -> recruitment -> position -> document` oraz `candidate -> communication` i wykazać dwukierunkowe testy wyścigów; nie wymuszać nowego sprzecznego porządku.

## Interfejs v1
Panel `recruitments/[id]/applications/[applicationId]/voice-plan`: cztery porównywalne pytania, maksymalnie dwa dopasowane dopytania, karta wersji źródeł, identyfikatory kryteriów, status świeżości, historyczne wersje, zatwierdź/zażądaj zmiany/wydaj plan. Nie udawać kompletnego voicebota. Użytkownik z rolą viewer tylko czyta. Po konflikcie należy zachować widoczny scenariusz i pokazać przyczynę stale; nie wolno automatycznie wydawać planu po zmianie CV.

## Odbiór
- RLS/role: 2 firmy, owner/recruiter/viewer/anon, dokumenty i inny tenant zabronione.
- Źródła: niesprawdzony CV, zmiana shortlisty, nowy review, nowe CV, zmiana stanowiska, zamknięta rekrutacja — blokada.
- Idempotency: replay identycznego requestu zwraca jeden wynik, inny payload przy tym samym kluczu PT409.
- Two concurrent reviews/releases i source change vs release na rzeczywistym PostgreSQL; nie tylko PGlite.
- Snapshot nie zawiera PII. 5–7 min target, 10 min cap, recording disabled; brak outbound i provider API.
- `npm run typecheck`, `npm run build`, test generatora i regresje SC-006/008/009/010, testy UI/HTTP.
- Nie istnieje automatyczna decyzja hire/reject.

## Handoff
TASK SC-012-B | STATUS ARCHITECTURE_REVIEW | BRANCH docs/sc-012b-persistence-architecture | DB/MIGRATIONS NONE | DEPLOY NONE | NEXT ACTION niezależny Codex review i poprawki architektury; potem osobna gałąź implementacji B1 (schema/RPC/testy), następnie B2 UI/integracja bez produkcji.

## V2 binding corrections after independent Codex review (supersedes conflicting V1)

1. Repository versus database: SC-010 B1/B2 migration files are present in BOTH main and integration Git branches. Live Supabase migration history from 10 October 2026 did NOT include either migration. Do not confuse repo files with production database state.

2. Deterministic screening gaps: latest human review must be approved or approved_with_changes. Effective rating is most recent override from that review, otherwise stored AI criterion rating. Only effective insufficient_data generates reason=missing_evidence; current schema has no machine-verified contradiction or scope_unverified reason, so other reasons are BLOCKED. Exact ID must belong to approved criteria snapshot. Select at most two in task, kpi, competency sequence and increasing numeric index; no ranking based on explanation text, no user-supplied reasons.

3. Source composite relationships: require UNIQUE(company_id,recruitment_id,application_id,position_id,id) for screening_analysis_versions; UNIQUE(company_id,analysis_id,id) for screening_result_reviews; UNIQUE(company_id,recruitment_id,application_id,analysis_id,review_id,id) for recruitment_shortlist_entries. voice_plan_versions stores all seven IDs including position, analysis, screening_review, shortlist and binds via full composite FKs to each parent, plus applications, recruitments and positions. Check current status in server RPC even with valid FK.

4. Voice review keys: voice_plan_review_entries includes id UUID, company_id, plan_id, review_version, decision, reviewed_at, reviewer_id; UNIQUE(company_id,plan_id,id) and UNIQUE(company_id,plan_id,review_version). voice_plan_release_entries references (company_id,plan_id,voice_review_entry_id) to the voice review, not screening review; one effective release per plan.

5. Plan status is DERIVED ONLY. Remove mutable voice_plan_versions.status. A security-invoker read derives stale on changed source, else released if release references latest approved review, else reviewed if review exists, otherwise generated. Plan/review/release history append-only; no contradictory status caches.

6. Global locking: B1 must not lock candidate or communication because it must not dispatch calls. Authorization and role read before locks; acquire SC-006 per-application screening advisory lock FIRST, then existing SC-006/008 order: analysis -> application -> recruitment -> position -> document, then latest review -> shortlist -> voice_plan -> voice_review -> voice_release -> idempotency. SC-010 contact lock chain is intentionally NEVER taken by B1. Test review_screening_result/retry_screening_analysis vs plan create/review/release, shortlist removal vs release, two concurrent release, owner role revocation, and stale profile edits in real two-session PostgreSQL; never silently reorder locks. SC-010-C must independently design any cross-domain transaction.

7. Retention and deletion: all plan rows, question envelopes, review reasons, releases, idempotency and source snapshots have retention_policy_version and retention_deadline. All source/parent FKs RESTRICT. Pre-activation operator-authorized purge/redaction must cover descendants, keys and minimal lawful audit, and UI must explain blocked parent deletion. Retention schedule awaits separate policy approval; never deploy with indefinite PII.

8. Immutable provenance: persist source_snapshot JSONB containing bound analysis_id, screening_review_id, shortlist_entry_id, application/recruitment/position updated_at, input_fingerprint, analysis_contract_hash, template_version, prompt_version and source_contract_version. Compute source hash over this exact canonical snapshot plus identity bindings. Hash alone is insufficient for audit.

9. Immutable complete envelope: plan_envelope JSONB contains schemaVersion=1, language=pl-PL, templateVersion, durationTargetSeconds=420, durationMaxSeconds=600, recordingDefault=false, noticeRequired=true and full ordered questions with criterion mapping/follow-ups/maxSeconds. Hash/SQL validation cover all fields; never regenerate historical plan from current generator.

10. Scope and owner: Issue #80 product is FULLSTACK, Cursor builder, Codex reviewer; docs-only PR #82 is OPERATIONS and ChatGPT orchestrator. Next implementation B1 is BACKEND L3, B2 presentation FULLSTACK according to changes, each separately reviewed.

11. Handoff: TASK SC-012-B/ARCH; STATUS V2_REVIEW; BRANCH docs/sc-012b-persistence-architecture; COMMIT read from exact GitHub PR head; CHANGED FILES docs/sc-012b-voice-plan-persistence-architecture.md; DB/MIGRATIONS NONE; TESTS planned PGlite/RLS + 2-session PostgreSQL concurrency + build/typecheck; SECURITY CHECKS composite FK, no PII, immutable snapshots, lock ordering and retention; KNOWN ISSUES migration/purge flow and unimplemented SQL/RPC; BLOCKERS Codex PASS and SQL via Supabase CLI/test database; NEXT ACTION review fixes then implement offline schema/RPC.

No production changes, SQL, secrets or calls authorized by this document.

## V3 — four second-review decisions (supersedes conflicting V2 points)

1. Role revocation TOCTOU: authorization preflight is not sufficient. For every mutating plan RPC the transaction obtains the existing per-application screening advisory lock, and locks company owner or company_members matching the current actor with FOR SHARE NOWAIT in the same order as already reviewed SC-006/010 access guards. It rechecks that actor membership still grants owner/recruiter write rights AFTER those locks and BEFORE source locking and write. A concurrent membership revoke either completes before this recheck (deny), or waits until the transaction completes. This condition must be tested both ways on real PostgreSQL, not only with mocked auth.
2. Release validity: latest review **overall** determines status. A release is displayed valid only when its voice_review_entry_id equals the exact latest review and that review is approved. A newer requires_changes review immediately invalidates any older release. Versioned status is computed, not stored. Future release after changes requires a NEW approved review and NEW plan version, never resurrection of old approval.
3. Executable generation boundary: TypeScript server worker (Node) is the authoritative generator. On generation, a trusted server action loads verified source snapshot via tenant-authenticated RLS read, calls buildInterviewPlan and creates the entire canonical envelope plus source fingerprint. A narrow DB RPC accepts the proposed envelope, caller expected source IDs/revisions and source hash, NEVER a client-claimed reviewed flag. In ONE SERIALIZABLE database transaction the RPC locks the actor, checks SC-006 advisory/source/review/shortlist chain, independently re-reads current frozen source snapshot and **recomputes its own canonical fingerprint and validates the submitted envelope against a versioned allowlist/template catalog that is installed as trusted DB configuration**. It must not blindly trust TS-generated text: compare question IDs/criteria and question content against immutable approved template entries stored and versioned in DB. If DB cannot reproduce/verify the exact plan using this catalog, fail closed with PT409/422. Store snapshot+envelope atomically only after validation, with idempotent request hash; on source change during TypeScript generation, reject and regenerate after re-read. Do not reimplement an unspecified AI model in SQL.
4. Review reason: review_voice_plan requires bounded reason text 1..1000 non-whitespace chars when decision=requires_changes; approved may have NULL/short optional rationale. Reason is persisted immutably with the review entry and included in idempotency request hash. UI must present and submit this reason, not discard the text field. Require consistent source and owner/recruiter session.
Status of all decisions: architecture proposed pending independent Codex PASS; no migration/production. In particular, template catalog and lock proof are prerequisites to implementing the write RPC.

## V4 — decision gates for change requests, release and serializable revocation (normative)

This section takes precedence over V1–V3 for conflicting state transitions.

1. **No no-op replacement after requires_changes.** A review with requires_changes is an immutable terminal decision for the exact plan version. A replacement requires a material server-verified approved source or template revision, or a bounded recruiter plan-edit request accepted into the next trusted source snapshot. Regenerating with the same fingerprint and unchanged deterministic generator cannot satisfy the request. Without an approved edit API, display a clear non-actionable explanation instead of a broken regenerate button.
2. **Release closes that plan version to further review.** review_voice_plan must lock and check for an existing voice_plan_release_entries row for the same company and plan BEFORE append. Once released, reject every later review, including approved. A new decision requires a new plan version. Test both concurrent review-versus-release interleavings.
3. **Serializable SQLSTATE 40001 revocation behavior.** A SERIALIZABLE transaction can establish its snapshot before taking the actor membership row FOR SHARE NOWAIT. Concurrent revocation can produce SQLSTATE 40001, not an immediate unauthorized result. Treat 40001 as a safe conflict; retry the entire transaction at the authenticated server boundary with a fresh snapshot, identical idempotency request key, a bounded count, and no provider side effects. Revalidate current membership after acquiring actor lock; deny if revoked. Exhausted attempts return safe HTTP 409. SQLSTATE 55P03 NOWAIT contention also maps to a safe conflict, without PII. Never retry inside the same failed SQL transaction.
4. **Required tests.** Requires_changes + identical input, release->review rejection, concurrent release/review, actor revoked before lock, revoke during transaction causing 40001, successful fresh-snapshot retry, exhausted retries. Green CI does not alone establish architecture PASS.

STATUS: Review fixes committed on PR #82, independent PASS and owner acceptance still pending. No migrations, production or candidate contact.

## V5 — replacement must change actual reviewed plan payload (normative)

A changed position title, source timestamp, review ID or fingerprint is **insufficient** to replace a plan rejected with requires_changes when the generated questions and release envelope remain byte-identical. The server must compare the canonical plan envelope (ordered question IDs, text, follow-ups, rubric and duration/recording/notice fields) against the rejected plan. Allow a replacement only when that envelope differs meaningfully, OR when a newly reviewed explicit edit command is attached to and addresses the prior immutable review reason, and becomes part of the new source provenance hash. A source revision alone never bypasses this gate. If the current deterministic generator cannot create a corrected envelope and no reviewed edit command exists, return a stable non-actionable requires_changes status rather than regenerate blindly. Test title-only edits, timestamp-only edits, legitimate changed selected behavior/questions, edited plan with matching review reference, and two concurrent replacements.

STATUS: PR #82 still requires fresh Codex review and integration owner acceptance. No migration or runtime activation.

## V6 — FINALIZED invariants addressing PR review (overrides V1–V5)

**Generation after requires_changes**: *every* replacement must differ from the rejected plan's canonical, order-preserving envelope hash: questions, rubric, follow-ups, duration, recording default and notices. A change of revision/timestamps, position title or even an approved edit command WITHOUT resulting material envelope change is INSUFFICIENT. Store rejected envelope hash in immutable review lineage; atomically check candidate replacement hash differs and the changed material is linked to the approved change request. Equal hash => conflict. Current deterministic generator must fail closed when it cannot address review reasons; do not mint artificial revisions.

**Transaction contract compatible with PostgREST**: a `.rpc()` call runs in a transaction opened by PostgREST; PL/pgSQL cannot upgrade it to SERIALIZABLE. Therefore the *public PostgREST RPC path* uses READ COMMITTED with rigorously acquired application advisory lock, actor membership row lock, relevant source/shortlist/plan rows in proven consistent order, plus explicit version/CAS and current-state validation immediately before each write. Every mutable source change must participate in the same advisory/lock protocol or the RPC must be blocked; no correctness claim from snapshots alone. Do not rely on SERIALIZABLE or catch/retry SQLSTATE 40001 through PostgREST. If a later separate trusted PG connection deliberately opens a SERIALIZABLE transaction **before invoking SQL**, its retry policy must be specified and tested independently. `55P03` maps to a safe 409 after an independent freshness check. PostgREST retry settings on mutating POST must be verified and operation idempotency mandatory.

**One effective released plan per application**: release is application-scoped, not merely unique per plan version. Provide a single `(company_id,application_id)` current_release pointer with CAS and one immutable release history; advancing the pointer revokes previous release's *current* designation atomically (the older immutable record stays historical). Only a later generated, human-approved non-identical envelope may be promoted; dispatch must use the exact current approved plan release ID, not any historically released row. Concurrent releases lock the application pointer and recheck expected generation/hash; stale attempts return conflict. A source revision invalidates current pointer visibility synchronously. Do not mutate historical release rows.

**Implementation gate**: before writing any SQL RPC, prove the above lock protocol against existing SC-006/008/010 functions and add real two-session PostgreSQL cases: concurrent source change vs generation/review/release, membership revoke, current pointer double release, requires_changes equal-envelope rejection, approved non-identical replacement. No Production migration or contacts. STATUS: architecture awaiting independent code/security review; approval to program in isolated branches is not production approval.

## V7 — source-only refresh versus rejected-plan correction (normative)

Two distinct replacement paths have different acceptance rules, preventing the source-only deadlock identified in the latest independent review.

**A. Replacement after human `requires_changes`.** Rejected plan P must never be replaced by a byte-identical reviewed envelope. This remains true after a source revision, changed timestamps, a newer template version that produces identical content, or an approved edit command whose result is identical. The next generated plan must have a *meaningfully different* canonical interview envelope AND the change must be traceable to the review reason via an approved revision/edit. Equal reviewed-envelope digest => PT409; do not silently satisfy the request.

**B. Source-only freshness refresh after a previously released/approved plan (without a `requires_changes` review).** Changing the verified source snapshot, application timestamp, position metadata, or later approved screening review can invalidate the old release even if the interview questions would remain identical. A replacement with an identical canonical envelope is permitted *only if the source fingerprint has genuinely changed and the new plan has been independently reviewed and approved with the new source*. Its release replaces the application-scoped effective-current pointer atomically via versioned CAS, without modifying immutable old release records. Equal source fingerprint + equal envelope is a duplicate/no-op and must not mint a replacement release.

The release RPC MUST distinguish the source refresh from human corrective rework using verified preceding review decision and original source/release provenance, not a browser flag. Source invalidation immediately hides old pointer; no stale historic plan can be used for dispatch. Re-read owner/recruiter membership and source under audited locks.

Acceptance cases: identical-envelope + changed source + new human approval -> one new current release; identical-envelope + unchanged source -> reject duplicate; requires_changes + identical-envelope even with changed source -> reject; requires_changes + corrected-envelope -> accept after review; concurrent old/new release -> one pointer.
STATUS: architecture review required; no database/provider production changes.
