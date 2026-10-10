# SC-013 — Architektura analizy rozmowy Voice AI z dowodami

TASK: SC-013 | LEVEL: L3 | SCOPE: BACKEND (przyszła implementacja)  
OWNER: ChatGPT / orchestrator | REVIEWER: niezależny Codex | STATUS: ARCHITECTURE_REVIEW / CODEX_FIXES_V2  
SOURCE OF TRUTH: GitHub Issue #14; powiązania: SC-006 / SC-008 / SC-010 / SC-011 / SC-012.  
PRODUCTION_APPROVAL: NO. Ten dokument nie tworzy tabel, migracji, endpointów, nagrań ani połączeń.

## 1. Cel i granice

Cel: z zakończonej, autoryzowanej rozmowy Voice AI przygotować audytowalne **dowody zachowań i kompetencji**, ocenę per kryterium oraz raport dla człowieka. Nie oceniać głosu, akcentu, emocji, tempa mówienia, domniemanej osobowości ani cech chronionych. Nie podejmować automatycznych decyzji zatrudnij/odrzuć. Nie używać tego modułu jako platformy telefonicznej.

### Przepływ

SC-006 reviewed screening + SC-008 current human shortlist
→ SC-010 verified contact/approval + przyszłe SC-010-C single-use dispatch
→ SC-012 approved/versioned interview plan
→ SC-011 provider events + SC-012 conversation execution
→ SC-013 private transcript ingestion and integrity checking
→ evidence extraction/criterion ratings (AI worker)
→ human review and immutable overrides
→ SC-015 consolidated WERYFIKACJA report (osobny task).

Dane zagregowane w raportach nie mogą zastąpić kontroli dowodów oraz ostatecznej decyzji człowieka.

## 2. Prerequisites (fail closed)

Nie wolno uruchamiać analizy tylko na podstawie providerCallId. Serwer musi sprawdzić:
- tenant, recruitment, application, candidate i rozmowę należące do jednej firmy; composite FKs i RLS;
- rozmowę rzeczywiście **ukończoną**, powiązaną z dokładną aktywną/archiwalną wersją zatwierdzonego planu i zaufanym zdarzeniem providera;
- brak wycofania praw i brak blokady retencji, legalną podstawę przetwarzania transkryptu, wersję notice i obowiązującą politykę; osobna zgoda na nagrywanie tam, gdzie wymagana;
- spójność wersji wejścia; źródło nieaktualne może być historycznie audytowalne, ale nie może udawać bieżącego wyniku;
- transkrypt dostarczony zweryfikowanym kanałem i powiązany z wywołaniem, a nie przyjęty bezpośrednio od przeglądarki.

Bieżące SC-010 B1/B2 nie posiada production dispatch; architektura pozostaje nieaktywna do czasu review i osobnej akceptacji.

## 3. Rozdzielenie zaufania, danych i providerów

1. Provider transport (SC-011) zwraca tylko podpisane callbacki/identyfikatory rozmów. Zewnętrzny provider nie może pisać wyników do tabel rekrutacji.
2. Signed webhook intake: autoryzacja dostawcy, raw-byte signature, timestamp/replay, account and tenant binding, body-size limit, idempotent provider event ID. Niedopasowany callback -> brak zapisów; brak pewnego zakończenia -> reconciliation, nie fikcyjne completed.
3. Transcript ingestion worker: minimalny transkrypt, bez nagrania o ile opcjonalna osobna polityka go nie dopuszcza. Dane kontaktowe oraz oryginalne CV nie są przekazywane do modelu analizującego.
4. Analysis worker (oddzielna minimalna capability NOLOGIN, bez `service_role` w przeglądarce), claim/lease/complete/fail, niskie uprawnienia do jednego zakresu. API user-facing nie posiada claim/complete/fail.
5. Review rekrutera: tylko przez tenant-checked RPC z wersjonowaniem i compare-and-swap. Reviewer nie przepisuje wyniku AI; dopisuje immutable override.

Treść transkryptu to niezaufane dane wejściowe: prompt injection wypowiedziany przez kandydata nie może zmienić instrukcji analizy, schematu, polityki ani zakresu narzędzi. Analiza bez tool calling i bez otwartego dostępu do internetu.

## 4. Proponowane obiekty danych — NIE migrować na tym etapie

| Obiekt (proposed) | Zadanie | Dostęp |
| --- | --- | --- |
| `public.voice_interviews` | company/recruitment/application, approved plan version, status, provider account/id, context_fingerprint, timestamps, flags | Tenant read-only RLS; narrow RPC |
| `private.voice_transcript_versions` | hash wejścia, encrypted/limited transcript, source version, language, segmentation, retention deadline, redaction state | Trusted worker; recruiter via narrow redacted projection, no raw Data API |
| `public.voice_analysis_versions` | version, provider/model/prompt/schema hashes, analysis status, transcript/plan fingerprint, stale reason | Tenant read-only |
| `public.voice_criterion_results` | immutable criterion ID, kind, rating, evidence offsets, rationale, confidence nullable | Tenant read-only |
| `public.voice_result_reviews` | immutable reviewer/version/decision/time and source version | Tenant read-only; write via RPC |
| `public.voice_criterion_overrides` | immutable new rating and verified evidence replacing previous at read-time | Tenant read-only |
| `private.voice_analysis_attempts` | lease hash/generation, idempotency, error safe_code and token/cost telemetry | Worker-only |
| `private.voice_provider_event_receipts` | signed event replay protection and reconciliation status, no raw payload | Webhook worker |

Use existing table names only if they are absent at migration time. No parallel source of truth for status. Confirm actual `integration` schema before any implementation: this is a logical proposal, not a claim of existing tables.

Every operational record includes `company_id`; composite FK includes company/recruitment/application/plan references. No direct insert/update/delete to AI results from `authenticated` or `anon`; explicit RLS and revokes. Private sensitive data should remain outside exposed schemas, with RLS as defense in depth.

## 5. Transcript contract, evidence and rating

Versioned transcript input:
- `schema_version`, `voice_interview_id`, `provider_event_id`, `language`, `source_type`, `transcript_segments`, `transcript_sha256`, source plan version.
- Segments have immutable `segment_id`, `speaker = interviewer|candidate`, `start_ms`, `end_ms`, `text`. Timecodes optional ONLY if provider cannot supply them; ordered monotonic transcript positions always required. Exclude entire system/provider payload and other media.
- A canonical normalized transcript text and UTF-16 index offsets must be snapshotted and protected by fingerprint. Model receives only **candidate lines**, criterion definitions and consent-minimized approved plan context. No raw phone/email, CV text, unrelated prior interviews or employer secrets.
- Evidence for each rating: `{segment_id, start_utf16, end_utf16, quote}`, exact substring validation and speaker=candidate. Max 5 short snippets per criterion; no invented quotes and no model-authored citations lacking offsets.
- Rating enum shared with existing screening: `insufficient_data | below | meets | above`. `insufficient_data` remains NULL in numeric scoring; no forced zero. Meaning of below/meets/above anchored to **approved version of criterion rubric**, not a probabilistic impression.
- Store what the candidate actually said separately from AI interpretation. Silence, unintelligible audio, disconnect, lack of opportunity to answer and model/provider errors mean unknown/insufficient_data, never an automatic negative rating.

Versioned policies: `voice-analysis-v1` (schema/prompt/criterion mapping) and `voice-review-v1` (human-review semantics). Changes to policy/model generate new analysis version, never mutate previous results.

## 6. Machine of states and concurrency

Interview: `planned -> authorized -> provider_pending -> in_progress -> completed | incomplete | cancelled | failed | unknown`.

Analysis: `pending -> processing -> completed | failed | cancelled`; independent `stale_at/stale_reason` and `review_version`. Running a new attempt never overwrites previously completed results; only completed, reviewed, current analysis may appear as current in reports.

One logical analysis per source fingerprint + contract hash; multiple provider attempts remain nested attempts, each has lease generation and idempotency key. A lost/expired lease cannot finalize; old webhook cannot roll terminal status backwards. Accept completed recording/transcript only from trusted event + correlation; missing callback -> reconciliation, no retry dial.

Lock order and optimistic versions must be checked against SC-006, SC-008, SC-010. Concurrency tests must cover review vs new transcript, review vs new plan, source change vs finalize, cancellation vs callback, old lease vs retry and cross-tenant concurrent access. Use controlled conflict (409), not implicit last-write-wins.

## 7. Human review and report

Recruiter sees: expected criterion/rubric, approved question, transcribed answer, evidence quote and offsets, AI rating + rationale, contradiction needing clarification, current/stale state.

Review statuses: `approved | approved_with_changes | requires_follow_up | rejected_result`. These refer to **validity of the AI assessment**, not rejection of the candidate. Each correction must include reviewer, timestamp, evidence/justification and source version. Reviewer may set `insufficient_data` where unsupported. Preserve all history and source snapshot.

Reports must distinguish evidence of professional skill from motivation opinions, separate screening/voice/test data, show missing evidence, and forbid single opaque total score without clearly defined weights and human policy. No automatic hire/reject or auto-shortlist change.

## 8. Retention and privacy

Do not record calls by default. If user/operator lawfully enables recording, track separate recording permission and explicit version. Retention for voice recordings, raw transcript, redacted evidence and auditing is separate, policy-driven and configurable. Restricted deletion procedure must redact personal data while retaining only minimal non-identifying audit where lawful. Retention/deletion must be approved before production activation.

Transcripts may contain sensitive data voluntarily disclosed by a candidate; strip irrelevant sensitive details from AI prompts and reports. Never infer health, religion, family status, age, ethnicity, sex, emotion, accent, personality or other protected traits. GDPR/AI legal review required before production voice decisions. Restrict model/vendor subprocessors by documented DPA and region agreements.

## 9. Logical API contract (for next implementation PR)

- `create_voice_analysis(interview_id, expected_plan_version, expected_transcript_hash, request_key)`: authenticated owner/recruiter; only completed authorized interview, no provider side effects.
- `review_voice_analysis(analysis_id, expected_analysis_version, expected_review_version, corrected_ratings, rationale, request_key)`: optimistic human review with immutable entries; evidence references must match exact current text.
- `list_voice_analyses(application_id, cursor, limit)`: authenticated tenant member; bounded metadata plus redacted evidence, not contact details/recording URL.
- Internal worker RPC: `claim_voice_analysis`, `complete_voice_analysis`, `fail_voice_analysis`: scoped NOLOGIN only; strict schema + lease, not public. These signatures are **proposals**, not implemented endpoints.
- Internal event handler: verifies signed callback and binds provider call/account to tenant/attempt; no direct client callback mutations.

Errors: 401 unauthenticated; 403 owner/recruiter restriction; 404 missing or inaccessible; 409 stale/conflict; 422 invalid transcript/policy; 429 limits; 503 provider/feature disabled. Do not include PII in errors.

## 10. Minimum acceptance test matrix

| Test class | Criteria |
| --- | --- |
| Tenant/RLS | 2 companies, owner/recruiter/viewer/anon, candidate/app cross-binding blocked, no direct insert |
| Source integrity | exact source version, plan+transcript fingerprint, changed profile/CV/shortlist -> stale not silent reuse |
| Provider callbacks | signature, wrong account, replay, out of order, unknown/timeout and reconciliation, no call retry |
| Transcript integrity | speaker-only evidence, UTF-16 offsets incl. emoji, fragmented/sparse/malformed segments, length/time limits, prompt injection ignored |
| Human review | required rationale, mutable source conflict, immutable history, insufficient_data not numeric zero |
| Concurrency | two finalize/claim/review, expiry, lost lease, revocation, error codes not deadlocks |
| Retention/security | no unwanted recording, redaction and purge, no logs/raw PII, secrets never in client |
| Product | no automatic reject/hire, no mandatory one-number score, no voice inference of protected traits |

Gates: full `npm run typecheck`, `npm run build`, module tests, real PostgreSQL concurrency tests and existing SC-006/008/009/010 regressions. Synthetic transcripts only in CI; no real candidate calls, recording, billing or AI charges in tests.

## 11. Implementation handoff / next steps

Phase A (this PR): independent architecture review, no schema mutations, no app calls.
Phase B: SQL/RLS/migrations and server-side normalized transcript interface, separate branch and owner acceptance.
Phase C: provider callback ingestion and analysis worker, behind disabled flag, synthetic fixture only.
Phase D: human review UI, integrated read-only report and independent end-to-end smoke checks.
Phase E: separate production approval + legal/retention/provider validation.

Blockers: SC-010-C dispatch not finished, actual SC-011 provider not selected, SC-012 versioned plan persistence and human review not finished, consent/retention/redaction legal contract not approved. Phases may be developed offline but never promoted as production-ready until blockers close.

Never run `supabase db push` or reapply existing migrations. No code changes or remote migrations from this architecture task.

TASK: SC-013 | STATUS: ARCHITECTURE_REVIEW | BRANCH: docs/sc-013-voice-analysis-architecture | DB/MIGRATIONS: NONE | PROVIDER/CONTACTS: NONE | NEXT ACTION: independent review and owner acceptance prior to SC-013-B.


## 12. REVIEW FIXES V2 — wiążące doprecyzowania kontraktu (10.10.2026)

**Ta sekcja ma pierwszeństwo nad sprzecznymi fragmentami wcześniejszych sekcji; przed implementacją wcześniejszą treść należy uzgodnić z poniższym kontraktem.** Każdy poniższy punkt odpowiada problemowi wskazanemu w niezależnym Code Review PR #77.

1. **Approval/dispatch binding — P1.** `voice_interviews` wymaga FK tenant-safe do *konkretnego* `candidate_communication_approvals` (SC-010 B2), `communication_id` i `dispatch_attempt_id` z SC-010-C, a także `approved_plan_version_id`. Złożona unikalność `(company_id,recruitment_id,application_id,communication_id,approval_id,dispatch_attempt_id)`; zatwierdzony snapshot źródeł musi zgadzać się ze źródłem połączenia. Callback provider-call ID sam w sobie nie upoważnia do utworzenia rekordu interview. Brak próby SC-010-C -> brak interview production.
2. **Cytaty prywatne — P1.** Zmiana logiczna: `private.voice_criterion_evidence` zawiera dosłowne cytaty i lokalizacje; brak bezpośredniego SELECT dla authenticated, viewer, anon, workerów niezwiązanych z analizą. `public.voice_criterion_results` przechowuje wyłącznie identyfikator kryterium, rating i niezawierające PII metadane. Rekruter odczytuje redagowane fragmenty poprzez wąskie RPC z kontrolą roli, retencji i uprawnień; viewer nie otrzymuje transkryptów ani cytatów.
3. **Jedna przestrzeń offsetów — P1.** `transcript-canonical-v1`: input to uporządkowana lista segmentów z przypisanym `segment_id` i dosłowną treścią Unicode (bez normalizacji, trimowania, zamiany końców linii). Canonical representation = UTF-8 bytes of stable-key-order JSON `{schema_version:1,segments:[{segment_id,speaker,start_ms,end_ms,text},...]}` (brak pól undefined; timestamp null gdy brak). SHA-256 liczymy z tych bajtów. Evidence `start_utf16` i `end_utf16` są **lokalne dla dokładnie jednego segmentu**, odnoszą się do jednostek UTF-16 pierwotnego `segments[n].text`, `quote === text.slice(start_utf16,end_utf16)`; niedozwolone przejścia przez granicę segmentu. Rewizja lub redakcja transkryptu tworzy nową wersję i nowy hash; nie edytuje snapshotu. Segmenty dopasowuje się wyłącznie do tej samej wersji.
4. **Obowiązkowy dowód — P1.** `below|meets|above` wymaga 1–5 niepustych cytatów przypisanych do segmentów kandydata, ze sprawdzeniem hash, speaker, offset i dokładnej treści podczas `complete_voice_analysis` **w transakcji DB**. `insufficient_data` wymaga 0 cytatów (brak udowodnionego wyniku) i nie może być mapowane na 0 punktów.
5. **Retencja providera — P1.** Blokada analizy bez jawnie zatwierdzonego DPA, regionu/przesyłania danych, subprocessors, okresu przechowywania, umownej procedury usuwania, zdolności egzekwowania `store:false` / braku persistent conversations oraz udokumentowanego rozróżnienia od ZDR. Żaden model ani dostawca nie może samodzielnie utrzymywać kopii transkryptów poza zaakceptowaną polityką. Lokalny purge musi mieć mapę zasobów providera i potwierdzenie provider-side deletion, jeżeli dane są tam przechowywane.
6. **Provenance ASR — P2.** Podpis webhooka i hash potwierdzają pochodzenie i niezmienność **transkrypcji dostawcy**, nie prawdziwość rozpoznania mowy. Raport mówi „Według transkrypcji dostawcy…”, z wersją, językiem i statusem wiarygodności. Procedura contest/correction tworzy nowy snapshot oraz review (bez nadpisywania starego); brak nagrania oznacza niemożność niezależnej weryfikacji audio.
7. **Rola workera — P1.** Oddzielna `voice_analysis_worker`: `NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`; brak członkostwa `authenticated`, `anon`, `screening_worker`, `contact_verifier` i odwrotnie. `REVOKE ALL` od tabel publicznych i prywatnych, wyłącznie wąskie `claim/complete/fail` capability. Testy `pg_auth_members`, `pg_roles`, `has_table_privilege` i `has_function_privilege` przed przyznaniem runtime identity. `SET LOCAL ROLE` tylko na serwerze z kontrolowanym connection pool.
8. **Review wersji źródła — P1.** RPC review wyprowadza `transcript_version_id` i canonical hash wyłącznie z `analysis_id`; cytaty sprawdzane na zamrożonej wersji tej analizy, **nigdy** na najnowszej transkrypcji. Przy zmianie bieżącego wejścia wynik może być historycznie reviewed, ale nie current.
9. **Effective current review — P1.** Bieżący wynik wymaga `completed AND stale_at IS NULL AND latest_review IN ('approved','approved_with_changes')`. `requires_follow_up` i `rejected_result` nie kwalifikują do bieżących wyników, rankingu ani agregacji; żaden automatyczny reject kandydata.
10. **Usunięcie wszystkich artefaktów — P1.** Każdy transcript version, criterion evidence, rationale, override, review i source snapshot ma `retention_policy_id`, `retention_deadline`, `sensitive_payload_key_version` i odwołanie lineage do interview/transcript; sensytywne JSON/teksty szyfrowane poza jawnymi tabelami. Dedykowana autoryzowana procedura purge/redaction (retries, audyt, dry run, FK restrict, klucze envelope) objęta testami obejmuje wszystkie pochodne oraz kopie zewnętrzne. Immutable oznacza niezmienność oceny, **nie** wieczną retencję danych osobowych; po purge pozostaje tylko dopuszczalny, nieidentyfikujący audyt.
11. **Rzeczywiste pytanie — P2.** Analityk i reviewer widzą zatwierdzone pytanie oraz faktyczny segment interviewera bezpośrednio poprzedzający wypowiedź; model może użyć minimalnego faktycznego kontekstu rozmowy wyłącznie jako niezaufanych danych, nie instrukcji. Identyfikator planowanego i faktycznego pytania oraz kolejność turnów są utrwalone.
12. **Budżet przed modelem — P2.** `voice_analysis_attempts` zawiera atomowo zarezerwowany maksymalny koszt, `usage_policy_version`, `company_id`, `attempt_id`, provider/model i reconciliation. Sprawdź limity tenant/day/recruitment przed claim i sieciowym side effectem pod blokadą; unknown rezerwuje koszt aż do uzgodnienia. Finalize księguje rzeczywiste zużycie bez podwójnego liczenia. Integracja z centralnym SC-021 metering, bez uruchamiania billingu w tej fazie.
13. **Override binding — P1.** Złożone FK `(company_id,analysis_id,review_id)` → review i `(company_id,analysis_id,criterion_result_id)` → kryterium; `criterion_id` musi należeć do zatwierdzonej listy tego samego analysis. Jedyny zapisujący RPC sprawdza, że review, transcript i wynik kryterium to ta sama analiza.
14. **Lock order — P1.** Zabronione ukryte, odwrotne blokowanie SC-008/010. Dla operacji dotykających screeningu: zachować istniejący lock order SC-008 `analysis -> application -> recruitment -> position -> document`; dla zgód SC-010 najpierw uprawnienia/rola, następnie candidate NOWAIT i komunikacja. Zanim nowa transakcja będzie blokowała oba zakresy, potrzebny osobny zweryfikowany kontrakt wspólnej kolejności i testy równoległych sesji (nie wydłużać locków podczas sieciowego providera). Po autoryzacji i claim, lokalne locki modułu voice w stałym porządku `voice_interview -> voice_transcript_version -> voice_analysis_version -> voice_analysis_attempt -> voice_review`. Operacje provider callback/reconcile obejmują wyłącznie voice scope i nie sięgają po locki źródeł; świeżość źródła walidowana osobnym kontrolowanym wywołaniem zgodnie z SC-008. Gdy atomowa blokada między modułami jest wymagana, implementacja SC-013-B jest **zablokowana** do czasu potwierdzonego diagramu kolejności obejmującego SC-010-C. Testy NOWAIT/PT409 i deadlocki w obu porządkach są warunkiem akceptacji.
15. **Unknown reconciliation — P1.** `unknown` nie jest nieodwracalnym terminalnym stanem. Dozwolone `unknown -> completed|incomplete|failed` wyłącznie poprzez podpisaną i sprawdzoną reconciliation dla tego samego provider account/call/attempt; append-only event, expected version i brak wznowienia call/retry. Late webhook nie może przywrócić cancelled.
16. **Prompt injection dla wszystkich pól — P2.** `transcript`, `interviewer_turn`, `rubric`, `position`, `question`, `plan` i nawet reviewed CV są niezaufanymi, ograniczonymi polami danych, nigdy instrukcjami; server-only system/developer policy, strict schema, bez tools, wersjonowane prompty, walidator cytatów i limit outputu. Nie uznajemy samego JSON Schema za gwarancję odporności.
17. **Idempotency request-key — P2.** `(company_id,actor_id,operation,request_key)` unikalny z kanonicznym `request_payload_hash` i `result_id`. Ten sam klucz i ten sam payload → ten sam logiczny wynik, inny payload → PT409 bez mutacji. Wersje planu, transcript hash i analysis contract są częścią hasha; nie używać `max(created_at)` jako ochrony przed wyścigiem.

**Otwarte blokady wdrożeniowe:** review architektury PASS, zatwierdzony SC-010-C execution protocol, SC-012-B plan persistence, polityka retencji, provider DPA, wyraźna akceptacja owner dla migracji, real DB concurrency i security tests. PR #77 pozostaje ARCHITECTURE_REVIEW, bez DDL i production.

## V3 corrections after second Codex review — normative, supersedes conflicting passages

1. LOCKS / SC-006: screening review and retry acquire application-scoped pg_advisory_xact_lock on key 'screening:' + application_id BEFORE any analysis row. The SC-013 architecture must not start an overlapping transaction with analysis row before this advisory lock. SC-010 acquires candidate row with NOWAIT, then owner/member and communication/shortlist/analysis in its audited sequence. These are two existing partial orders that cannot safely be merged by assumption. SC-013-B is **BLOCKED** from any cross-scope locking until SC-010-C delivers one verified global graph and real simultaneous sessions exercising both orders. For standalone voice analysis, use separate transactions that operate only on voice_interview -> transcript -> analysis -> attempt -> review and re-check source freshness through non-mutating controlled checks. Never hold DB row locks during provider API call.

2. PROVIDER RETENTION PROOF: voice_analysis_versions and every voice_analysis_attempt MUST include immutable vendor_retention_approval_id, approval_version, permitted_region, DPA_reference, storage_mode, data_retention_until, effective_from/to and request_configuration_digest. Before each call verify policy is currently approved; after completion persist provider request/correlation ID and deletion receipt status. A later provider policy change never retroactively alters the snapshot. No approved DPA/policy or no deletion capabilities = fail closed.

3. NO CV: Voice analysis external AI payload may contain ONLY privacy-minimized candidate/interviewer transcript segments, rubric/criterion identifiers and minimal fixed reviewed-plan context. The original CV, approved redacted CV, candidate name/phone, screening citation text, recruitment rankings and unrelated candidates are strictly prohibited; do not weaken this rule by calling CV 'untrusted data'.

4. TRANSCRIPT CANONICAL BYTES: adopt RFC 8785 JSON Canonicalization Scheme (JCS) for schema_version and ordered segment array objects, with UTF-8 bytes (no BOM) and SHA-256; forbid unpaired UTF-16 surrogates, NaN/Infinity and duplicate JSON keys. Preserve each original segment text unmodified. Timecodes are integers or explicit null; canonical key ordering and numeric serialization must be RFC8785-compliant. Version canonicalization_algorithm='rfc8785-transcript-v1'; include hash of EXACT JCS bytes plus test vectors for combining marks, emoji, quotes, slash and newline in both TS and DB/worker. DB must compare a recorded trusted worker digest plus exact source version, not use arbitrary PostgreSQL jsonb::text serialization as if byte-identical JCS.

5. TRANSCRIPT PROCESSING AUTHORIZATION: interview, transcript and each analysis attempt store processing_basis_id, notice_version, permission_revision and source policy hash as immutable lineage. Verify the current legal processing basis/notice and revocation before transcript ingress, immediately before external model call and in complete_voice_analysis under controlled concurrency. Revocation blocks completion and initiates lawful purge/redaction, without re-authorizing by mere contact permission.

6. OVERRIDE UNIQUENESS: composite FK review/criterion pairs share (company_id,analysis_id); additionally UNIQUE(company_id,review_id,criterion_result_id) with payload duplicate detection before write.

7. SINGLE CURRENT RESULT: assign monotonically increasing analysis_version per company/interview/transcript+plan lineage; at most one completed nonstale analysis is current per (company_id,voice_interview_id). Create partial unique index on that scope. New pending/processing does not hide prior completed current. On *successful finalization only*, atomically mark earlier completed analysis superseded/stale and record superseded_by. Latest human review for the successor must be approved/approved_with_changes before showing it as current. No double-current results.

8. LOCAL COST POLICY (not imaginary SC-021): SC-021 remains a proposed cross-application gateway without accepted repository implementation. For SC-013-B either implement complete local immutable usage_policy_version with tenant/day/recruitment allowance, atomic cost reservation before provider call, unknown reservation reconciliation and exact final settlement, OR block SC-013-B until SC-021 is reviewed and implemented. This architecture chooses **local offline cost cap contract required before implementation**; do not depend on unbuilt SC-021. No provider call if budget unknown or exhausted.

9. CRITERIA COMPLETENESS: complete_voice_analysis must validate exactly one rating for every criterion in frozen criterion snapshot, no unknown IDs or duplicates, and 1–5 exact candidate evidence citations for substantive ratings, zero for insufficient_data. Required DB transaction checks equality of sorted sets, source hash and all speaker/segment UTF-16 offsets. Strict JSON alone does not guarantee this; add synthetic negative tests.

STATUS: SC-013 V3 architecture still needs independent Codex PASS. No migration, DB change, provider call or production activation. SC-010-C execution and cross-domain lock graph remain external blockers.

## V4 — closing provider idempotency and immediate-source-stale cases (binding)

A. Provider call has an irrevocable dispatch reservation BEFORE sending any transcript. For each logical voice_analysis_attempt generate one unpredictable but stable provider_idempotency_key bound to tenant/interview/analysis/model/prompt and source version, and write dispatch_state=dispatching, source snapshot, policy snapshot, max-cost reserved and lease_generation within a committed database transaction. Then perform network request outside DB. On timeout or crash after dispatch (even before a provider correlation ID is known), status becomes unknown/needs_reconciliation; do not retry provider invocation on lease recovery. Query provider by the SAME idempotency key to resolve outcome. If vendor has no reliable idempotency/query-by-key, manual reconciliation is mandatory, never a second charge-generating call. Persist provider response identifiers and deletion/retention trace when known. Same key with different request contract is PT409.
B. Distinguish source invalidation from same-source re-analysis. Editing/replacing transcript version, plan release, criterion rubric or processing permission makes previous analysis stale IMMEDIATELY as part of the source-change transaction (or via a synchronous version check used by every report read). Never display old completed reviewed results while reanalysis is pending/failed. When running a newer model on the exact identical frozen source, previous completed reviewed result remains current until successor successfully completes; at that point mark previous as superseded atomically. Uniqueness of current completed per interview, transcript source revision and policy remains, and report checks current source hash plus latest review.
STATUS: ARCHITECTURE_REVIEW; no SQL, secrets, provider calls or migrations. Reconciliation and immediate stale checks require explicit real-Postgres race testing before implementation acceptance.

## V5 — reviewed-successor promotion and explicit review decision RPC (normative)

This section supersedes V3.7 and V4.B to the extent those sections imply replacing a same-source approved analysis when a successor merely completes.

1. **Same-source successor only becomes current after human approval.** A new analysis of the identical frozen transcript, approved plan, rubric and permission source may become completed while the predecessor remains the sole effective current human-approved analysis. A completed successor without review, requiring follow-up or rejected is NOT current. Do not supersede predecessor upon completion alone. In one tenant-scoped transaction on new approved or approved_with_changes decision, lock the interview current-pointer, compare expected version, revalidate unchanged source and authorization, promote newly reviewed successor and mark predecessor superseded. If source/permission changed, do not promote; source invalidation independently makes the predecessor stale immediately. Require a unique (company_id,interview_id) current pointer or equivalent DB guarantee. Test two concurrent approvals, rejected successor, delayed human review and stale inputs.
2. **Decision is mandatory in review RPC.** Contract: review_voice_analysis(analysis_id, expected_analysis_version, expected_source_hash, expected_review_version, decision, corrected_ratings, evidence_references, rationale, request_key). Decision enum: approved | approved_with_changes | requires_follow_up | rejected_result. approved has no correction rows, approved_with_changes contains one or more audited corrections; follow-up/rejected decisions must never become current even with high ratings. Require a bounded rationale for adverse/follow-up decisions. Evidence always binds the frozen transcript, criterion ID, source version and validated exact offsets. Append review and corrections atomically with server-derived tenant/actor and CAS, including decision in canonical request payload hash; same request key with changed decision conflicts.
3. **Report guard.** A report may expose the effective result ONLY if interview current-pointer, source hash, latest immutable human review and allowed approval decision all match. Neither completed nor mere review presence is authorization.

STATUS: PR #77 remains architecture review, not independent PASS. No migrations, DB mutation, provider/API call, or deployment.

## V6 — exact CAS of effective-current pointer (normative)

A row lock serializes concurrent approvals but does not by itself prevent an older same-source analysis from replacing a more recent approved successor. Extend review_voice_analysis with expected_current_pointer_version and expected_current_analysis_id (nullable only when no current exists). These values are *expectations*, never authority; the RPC reads the current pointer for the same tenant and interview under lock, compares both fields, and fails closed with conflict if either changed. Additionally, require monotonic increasing analysis_version at promotion: no analysis may replace another effective-current analysis with a greater or equal version even when caller refreshes its pointer expectation. The source fingerprint must match exact frozen transcript, approved plan, rubric and permission revision. Promote successor and supersede predecessor in the same transaction after human approval only. A fresh read, re-review or explicit resolution is required after conflict; never automatically retry stale promotion with a newer pointer expectation.

Tests: two differently versioned successors approved in both transaction orders, stale expected_current_pointer_version/ID, higher-version first then older approval, same-version duplicate and source invalidation. Exactly one effective current result, no resurrection of superseded analysis.

STATUS: ARCHITECTURE_REVIEW awaiting independent PASS, no SQL/production change.
