# Krok 3 — audyt istniejącego kodu (2026-10-26)

## Rzeczywiste źródła danych (branch `integration`)
- Wymagania: `positions.tasks`, `positions.kpis`, `positions.required_competencies`, powiązane przez `recruitments.position_id`. `prepareScreening` w `lib/screening.ts` zamienia je na klucze `task:1`, `kpi:1`, `competency:1`.
- Kandydat: `candidates`; relacja do rekrutacji przez `applications` (`company_id`, `candidate_id`, `recruitment_id`).
- Zatwierdzony tekst: `candidate_documents.redacted_text` wyłącznie gdy `status='reviewed'`, `reviewed_by` i `reviewed_at` istnieją. Najnowszy dokument; nowszy szkic blokuje analizę.
- Istniejące odpowiedniki wymaganych tabel: `screening_analysis_versions` (immutable snapshot zatwierdzonego CV, kryteria, fingerprint, provider/model, status, tenant i wersjonowanie); `screening_criterion_results` (kryterium, rating, dosłowne cytaty z offsetami i explanation); `screening_result_reviews` + `screening_criterion_review_overrides` (historyczny przegląd i edycja człowieka); `screening_analysis_attempts` (retry).
- W projekcie konsekwentnie obowiązuje **`company_id`**, a nie `organization_id`. Równoległe tabele `evidence_analysis` i `evidence_item` dublowałyby działające rekordy i mogłyby rozjechać audyt, RLS i rozliczanie analiz.

## Auth / RLS
- Sesja użytkownika: `lib/company-access.ts`, Supabase `auth.getUser()`, sprawdzenie `company_members` i właściciela firmy.
- Granice: `private.has_company_access(company_id)` w RLS; role właściciel/rekruter mogą pisać, viewer czyta. Mutacje wyników wyłącznie przez sprawdzające uprawnienia RPC; żadnych zapisów bezpośrednio z klienta do tabel wynikowych.
- Worker: dedykowana rola DB `screening_worker`, nie `service_role` aplikacji.

## Integracja LLM już istnieje
- `lib/screening-ai.ts`: OpenAI Responses API, strict JSON schema, blokada decyzji zatrudnij/odrzuć i wnioskowania o chronionych cechach, limit 4000 tokenów wyjścia, timeout 60 s, 2 retry.
- Cytaty są obecnie sprawdzane dokładnym `indexOf` wobec zatwierdzonego snapshotu CV; brak dopasowania powoduje błąd wyniku. Żądany nowy kontrakt zakłada usuwanie fałszywych cytatów, normalizację białych znaków i degradację do `missing`; wymaga **osobnej, wersjonowanej** zmiany kontraktu workera.
- `lib/screening-flow.ts` + `app/dashboard/[companyId]/recruitments/[recruitmentId]/applications/[applicationId]/screening/` już mają: uruchomienie, retry, polling, historię, status failed, wynik i korekty człowieka. Włączenie zależy od `SCREENING_AI_ENABLED`.
- Obecne ratingi `insufficient_data/below/meets/above` nie są równoważne wymaganym `supported/partial/missing/contradicted`. Nie wolno ich bezrefleksyjnie przekodować; konieczna wersja nowego kontraktu i migracja kompatybilna ze starymi analizami.

## Braki do zamknięcia w tym PR
1. Nowy, odrębnie wersjonowany kontrakt evidence (Zod) i bezpieczne przejście istniejącego workera; cytaty wraz ze źródłem i zakresem, wycięcie niezweryfikowanych.
2. Przechowywanie sugerowanych pytań, missing_info oraz `human_status` i notatek per kryterium, z ochroną RLS i zapisem audytowym.
3. Macierz w istniejącym ekranie krok 3, łącznie z akceptacją/odrzuceniem/edycją wiersza i dostępem do źródła.
4. Testy kontraktu, RLS A/B, e2e z mockiem LLM i zdjęcia UI.
5. Dopiero po PASS wszystkich bramek edycja `app/components/marketing/content.ts` z „W przygotowaniu” na „Dostępne”.

## Bezpieczeństwo wydania
- Żadnych zmian `main`, migracji produkcyjnych, aktywowania `SCREENING_AI_ENABLED` ani płatnych wywołań OpenAI bez osobnego zatwierdzenia.
- Istniejące analizy i review pozostają nietknięte. Funkcja publiczna nadal uczciwie mówi „W przygotowaniu”.
