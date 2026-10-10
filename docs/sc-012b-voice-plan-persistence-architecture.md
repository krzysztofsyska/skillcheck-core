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
