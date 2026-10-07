# SC-SALES-006B — handoff

TASK: SC-SALES-006B
STATUS: REVIEW
LEVEL: L3
SCOPE: BACKEND
BRANCH: feat/sc-sales-006b-sales-leads
BASE_COMMIT: 6495162b2c04ef39843d86070cd0ce71f7f84233 (integration)
COMMIT: head PR zawierający ten handoff; pełne SHA zostanie zapisane w komentarzu PR po publikacji.
ISSUE: #45

## Zmiany

- Migracja `20261007000200_sales_leads.sql`: tabele publiczne i prywatne, brak CRUD dla API, RLS, pięć RPC, walidacja HMAC i danych, idempotencja, ograniczony dziennik, limity, operatorzy, odczepienie autora, sprzątanie, rotacja/retire pod wspólną blokadą ustawień.
- Czysty helper `lib/sales-lead-signature.ts`, bez env i sieci.
- Typy i zamrożony kontrakt DB; Insert/Update nowych tabel są `never`.
- Testy PGlite oraz skrypt niezależnych sesji PostgreSQL z barierami 6190/6191 i obserwacją pg_locks.
- CI dodaje wyłącznie `test:sales-leads` zaraz po `test:db`.
- Dokumentacja bazy, backlog i minimalna korekta metadanych starego projektu/promptu.

CHANGED FILES:
- .github/workflows/checks.yml
- docs/BACKLOG.md
- docs/database.md
- docs/sc-sales-006a-lead-architecture.md
- docs/sc-sales-006b-cursor-prompt.md
- docs/sc-sales-006b-handoff.md
- lib/sales-lead-signature.ts
- lib/supabase/database.types.ts
- package.json
- supabase/migrations/20261007000200_sales_leads.sql
- tests/database-types.contract.ts
- tests/database-types.test.mjs
- tests/sales-leads-concurrency.mjs
- tests/sales-leads-database.test.mjs

DB / MIGRATIONS: dodano plik; wykonano wyłącznie na lokalnych, efemerycznych bazach PGlite. Niewykonany na zdalnej bazie.

## Wykonane kontrole

Node v24.19.0:
- npm ci: exit 0.
- npm run typecheck: exit 0.
- npm run test:db: 13 pass, 0 fail.
- npm run test:sales-leads: 11 grup pass, 0 fail.
- npm run build: exit 0.
- npm run test:sales-leads-concurrency: SKIP bez SALES_LEADS_TEST_DATABASE_URL, nie PASS.
- git diff --check: bez błędów.

PGlite sprawdza pełny łańcuch migracji, oba schematy pgcrypto i brak przeciążenia HMAC, UTF-8/Unicode normalizację, podpis i kontekst auth, trwałość odmów, obie ścieżki flagi, limit prób i trzy limity przyjęć, replay capped 20, konflikt, tenant-role denial, operator lifecycle, niezmienność, usunięcie autora, sprzątanie i historię odcisku 59/61 minut. Testy są offline. CI dla opublikowanego SHA należy ocenić osobno.

## Bezpieczeństwo i ograniczenia

Nie dodano rzeczywistych sekretów ani operatora. Ciągi testowe są wyłącznie fiksturami testów. Domyślne leads_enabled=false. Nie zmieniono flag automatyzacji, produkcji, sekretów usług ani zdalnego Supabase. Nie ma formularza, operator UI, service_role ani test:live.

Nie wykonano testu prawdziwej współbieżności. PGlite nie jest takim dowodem. Dostarczony skrypt wymaga jednorazowej bazy i potwierdzenia SALES_LEADS_TEST_DISPOSABLE=YES. Domyślny przebieg nie obejmuje retire i nie deklaruje pełnego PASS. Każdy wariant retire wymaga zwykłej rotacji --prepare-retire na osobnej jednorazowej bazie, a po co najmniej 60 minutach --retire-current, --retire-previous lub --retire-after. Bez backdating i wyłączania triggerów. Wszystkie warianty oraz wynik domyślnego przebiegu są wymagane przed publicznym włączeniem.

## Odchylenia od historycznych metadanych

Issue #45: nowsza migracja SC-007 zajęła chronologię. Po poleceniu właściciela „Ponów”, następującym po przedstawieniu korekty, numer zmieniono z 20261006000100 na 20261007000200, bazę/target PR na integration zgodnie z AGENTS.md. Dwa dokumenty projektu/promptu zmieniono tylko w tym zakresie i liście plików. Kontrakt bezpieczeństwa pozostaje bez zmian. pg jest już zależnością po SC-007, więc package-lock.json nie wymaga zmiany.

NEXT ACTION: niezależne review aktualnego SHA w draft PR; bez merge, deploy ani 006C/006D. Publiczne włączenie pozostaje zablokowane do pełnego testu współbieżności i pozostałych warunków projektu. Następny prompt review zostaje zapisany w PR i Issue, bez kopiowania przez właściciela.

## Poprawka R1 i ponowne review — 2026-10-07

Na polecenie właściciela Codex poprawił normalizację i wykonał ponowny przegląd.
- Wspólna, zamrożona mapa Unicode 17.0: 1487 zamian pojedynczych znaków oraz rozwinięcie U+0130. Bez zależności od locale, wersji runtime i kontekstu słowa.
- Jawne doprecyzowanie algorytmu w projekcie i prompcie: `ΟΣ` -> `οσ`, `İ` -> `i` + U+0307. Unicode nadal dozwolone; brak NFC/NFKC/casefold. Publiczne RPC, autoryzacja, limity i blokady bez zmian.
- Nowy helper SQL jest prywatny, immutable/strict, z pustym search_path i bez EXECUTE dla ról API. Nie wymaga SECURITY DEFINER.
- Regresje dziewięciu adresów obejmują accepted, wartość zapisaną i replay z tym samym ID; pełny zestaw znaków zmieniających wielkość jest porównany między JS i SQL wraz z idempotencją.
- Zmieniono sześć plików: helper TS, istniejącą niewdrożoną migrację, testy sales-leads, projekt 006A, prompt 006B i ten handoff.

Node 24.19.0: npm ci, typecheck, test:db (13/13), test:sales-leads (13/13), build i diff --check — PASS. CI dla nowego SHA oceniane po publikacji. R1 domknięte; ponowne review poprawki: PASS. Przegląd tego samego wykonawcy, nie niezależny audyt drugiego agenta. Wcześniejsze ograniczenie pozostaje: rzeczywista współbieżność PostgreSQL NOT RUN, wymagane przed publicznym włączeniem.

Bez zdalnej migracji, sekretów, merge, deploy oraz 006C/006D. NEXT ACTION: po zielonym CI akceptacja właściciela do integration; osobna zgoda przed produkcją. Pełne SHA i następny prompt zostaną zapisane w PR #46.
