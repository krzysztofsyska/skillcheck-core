# Plan budowy — test kompetencji, chatbot informacyjny, rozszerzony raport

**Data:** 2026-11-02 · **Podstawa:** [audyt-weryfikacja-2026-11-02.md](audyt-weryfikacja-2026-11-02.md)
**Zakres:** trzy moduły wskazane przez właściciela, w kolejności: (A) test kompetencji dla kandydata,
(B) chatbot informacyjny, (C) rozszerzony raport kandydata.
**Poza zakresem tego planu:** voicebot i analiza rozmowy (SC-011/012/013), Assessment Center, Talent Pool.

---

## Dla właściciela — streszczenie w pięciu punktach

1. **Nie zaczynamy od zera.** Test kompetencji ma już zaprojektowaną architekturę (SC-014-B1), gotowy
   walidator i punktację oraz zbudowaną bramkę HTTP (SC-014-B3). Brakuje trzech rzeczy: wdrożenia bazy,
   ekranu dla kandydata i oceny wyniku. To zmniejsza pracę o mniej więcej jedną trzecią w stosunku do
   szacunku z audytu.
2. **Chatbot to jedyny moduł budowany od zera** i jedyny, który wymaga nowej decyzji o koszcie
   (model AI, limity miesięczne).
3. **Rozszerzony raport jest najtańszy i najbardziej opłacalny** — spina w jedną całość rzeczy,
   które już działają, ale nikt ich nie widzi razem.
4. **Łącznie 34–52 dni robocze**, czyli realistycznie 2–3 miesiące. Bez voicebota.
5. **Są dwie decyzje, które musisz podjąć, zanim ruszy budowa.** Obie są na końcu dokumentu, obie
   w formie TAK/NIE z rekomendacją.

### Czego NIE wolno po drodze zrobić

Po zbudowaniu tych trzech modułów **nadal nie będzie można sprzedawać pakietu WERYFIKACJA**
w kształcie reklamowanym na stronie, bo ten pakiet obiecuje 20 rozmów z botem i analizę rozmowy.
Powstanie natomiast inny, mniejszy produkt. Jak go nazwać i wycenić — to decyzja D2 poniżej.

---

## Kolejność i zależności

Moduły nie są niezależne. Raport (C) konsumuje wynik testu (A), więc A musi być wcześniej.
Chatbot (B) nie zależy od niczego i może iść równolegle, ale konkuruje o ten sam czas budowniczego.

```
A1 → A2 → A3 → A4 → A5 ─┐
                         ├→ C1 → C2 → C3 → C4 → [D2: pakiet i cena]
B1 → B2 → B3 → B4 → B5 ─┘
```

**Rekomendowana kolejność wykonania:** A1–A5, potem C1–C4, potem B1–B5.
Uzasadnienie: A+C dają kompletny, pokazywalny produkt (test + raport) w 19–29 dni. Chatbot jest
miły, ale sam niczego nie sprzedaje i wymaga nowego kosztu stałego. Lepiej, żeby był finansowany
z pierwszej sprzedaży, nie przed nią.

---

# MODUŁ A — Test kompetencji wykonywany przez kandydata

**Bazowe ID:** SC-014 (kontynuacja) · **Łącznie: 13–20 dni**
**Stan wejściowy:** B1 architektura (ARCHITECTURE_REVIEW), B2 prototyp SQL w `db/isolated/`,
B3 broker HTTP w `lib/competency-attempt-broker*.ts` + `app/api/competency/attempt/route.ts`.

Architektura B1 jest szczegółowa i zaakceptowana w zakresie projektu. **Nie projektować jej ponownie.**
Każdy task poniżej realizuje część tej architektury, nie zmienia jej założeń. Zmiana założenia
B1 wymaga osobnej decyzji, nie jest dopuszczalna w ramach implementacji.

## SC-014-C1 — Migracja produkcyjna schematu testu

- **LEVEL:** L3 (migracje, RLS, grants, role, trust boundary — automatyczna eskalacja)
- **SCOPE:** BACKEND
- **OWNER:** Cursor · **REVIEWER:** Codex
- **DEPENDS ON:** SC-014-B2 (prototyp izolowany), SC-010 R10 (ostatni inventory)
- **Szacunek:** 4–6 dni

### Goal
Przenieść schemat testu kompetencji z `db/isolated/` do aktywnego łańcucha `supabase/migrations/`,
tak aby tabele istniały w `skillcheck-preview` i były objęte inwentarzem usuwania danych.

### In scope
- Nowa migracja (jedna lub kilka, w kolejności) obejmująca treść `db/isolated/sc014-b2-attempts.sql`,
  `sc014-b2-validation.sql`, `sc014-b2-withdrawal.sql`, `sc014-b2-retention.sql`.
- Role `competency_test_gateway` i `competency_test_marker_writer` z minimalnymi uprawnieniami.
- Nowy baseline inwentarza usuwania (`private.erasure_inventory_baseline_r11`) obejmujący
  wszystkie nowe tabele i nowe kolumny na `candidates` / `applications`.
- Plik rollback w `supabase/rollbacks/` zgodnie z konwencją repo.
- Wpięcie ścieżki `withdrawn` przez kontrolowane RPC zgodnie z B1 sekcja 2.

### Out of scope
- Uruchomienie migracji na produkcji (`wsvjawuikxfzjyivxgsu`). Tylko Preview.
- Jakikolwiek UI.
- Włączenie brokera.

### Existing contracts to preserve
- tenant isolation / `company_id` na każdym nowym wierszu
- RLS włączone na wszystkich nowych tabelach, bez `EXECUTE` dla `anon` i `authenticated`
  na funkcjach bramki kandydata
- nie modyfikować już wykonanych migracji
- nie zmieniać znaczenia `exercise_observation_entries` (to wpisy rekrutera, nie próby kandydata)

### Acceptance criteria
1. `npx supabase db push` na gałęzi testowej `skillcheck-preview` przechodzi; tabele
   `private.competency_test_grants`, `private.competency_test_grant_events`,
   `public.competency_test_attempts`, `public.competency_test_review_entries`,
   `private.competency_test_sessions`, `private.competency_test_drafts` istnieją.
2. `mcp__Supabase__get_advisors` nie zgłasza nowych ostrzeżeń `rls_disabled` ani `security_definer`.
3. Inventory R11 pokrywa 100% nowych obiektów; test inwentarza PASS.
4. Rollback odtwarza stan sprzed migracji na czystej bazie testowej.
5. Wycofanie zgody (marker kandydata LUB aplikacji) blokuje odczyt grantu, próby, draftu i oceny —
   udowodnione testem na izolowanym PostgreSQL.

### Required tests
- `npm run typecheck`, `npm run build`
- nowy `tests/sc-014-c1-migrations.test.mjs` na wzorze `tests/sc-019-migrations.test.mjs`
- test inwentarza usuwania na wzorze `tests/sc-step3-erasure-r7.test.mjs`
- test kolizji blokad z `confirm_erasure_subject` (B1 sekcja 4)

### Security / privacy checks
- brak plaintext tokenów w jakiejkolwiek tabeli, logu i komunikacie błędu
- `competency_test_gateway` nie ma `rolcanlogin` poza dedykowanym loginem z osobnym hasłem
- żadna funkcja kandydata nie jest wystawiona przez Supabase Data API
- brak `service_role` w ścieżce kandydata

---

## SC-014-C2 — Runtime brokera w Preview

- **LEVEL:** L3 (secrets handling, trust boundary) · **SCOPE:** BACKEND / OPERATIONS
- **OWNER:** Cursor · **REVIEWER:** Codex · **DEPENDS ON:** SC-014-C1
- **Szacunek:** 2–3 dni

### Goal
Uruchomić istniejący broker `app/api/competency/attempt` w środowisku Preview, tak aby zwracał
realne odpowiedzi zamiast 503.

### In scope
- Dedykowany login bazodanowy `competency_gateway_*` na `skillcheck-preview`.
- Zmienne Preview w Vercel: `COMPETENCY_BROKER_ENABLED`, `COMPETENCY_BROKER_ORIGIN`,
  `COMPETENCY_BROKER_CSRF_KEY`, `COMPETENCY_BROKER_SOURCE_HMAC_KEY`,
  `COMPETENCY_BROKER_GATEWAY_DATABASE_URL`, `COMPETENCY_BROKER_LIMITER_REST_URL`,
  `COMPETENCY_BROKER_LIMITER_REST_TOKEN`.
- Uzupełnienie `.env.example` o nazwy (bez wartości).
- Smoke test end-to-end przez prawdziwą trasę Next.

### Out of scope
- Jakakolwiek zmienna w środowisku Production. Zgodnie z AGENTS.md agent nie zmienia Production.
- Kontakt z rzeczywistym kandydatem.

### Blocker do zgłoszenia właścicielowi
Limiter wymaga Redis REST (np. Upstash). Jeśli projekt go nie ma — **to jest nowy koszt**
i wymaga decyzji właściciela. Alternatywa bez nowego kosztu: limiter oparty o tabelę w Postgresie,
wolniejszy, ale wystarczający przy skali Preview. **Rekomendacja: zacząć od wariantu
postgresowego**, Redis dopiero przy realnym ruchu.

### Acceptance criteria
1. POST na `/api/competency/attempt` w Preview zwraca kod inny niż 503 dla poprawnego żądania.
2. Żądanie bez poprawnego Origin / CSRF / ciasteczka jest odrzucane z generycznym błędem.
3. Przekroczenie limitu zwraca 429 bez ujawnienia tożsamości kandydata.
4. W logach nie występuje token, treść odpowiedzi ani dane kandydata.

---

## SC-014-C3 — UI rekrutera: wydanie, rotacja i odwołanie dostępu

- **LEVEL:** L3 (autoryzacja, dane kandydata) · **SCOPE:** FULLSTACK
- **OWNER:** Cursor · **REVIEWER:** Codex · **DEPENDS ON:** SC-014-C1
- **Szacunek:** 3–4 dni

### Goal
Rekruter może wydać kandydatowi dostęp do konkretnej, niezmiennej wersji testu, zobaczyć status
próby, zrotować link i cofnąć dostęp.

### In scope
- Nowa sekcja na `app/dashboard/[companyId]/recruitments/[recruitmentId]/applications/[applicationId]/exercises/`.
- Server actions: `issueCompetencyGrant`, `rotateCompetencyGrant`, `revokeCompetencyGrant`.
- Jednorazowe pokazanie linku z sekretem w interfejsie, z jasnym ostrzeżeniem, że nie zostanie
  pokazany drugi raz.
- Widok statusu: nie rozpoczęty / w trakcie (z deadline) / przesłany / odwołany / wycofany.

### Out of scope
- Wysyłka linku e-mailem lub SMS-em. Rekruter przekazuje link sam. Kanały komunikacji to SC-010,
  osobny moduł, a `COMMUNICATION_ENABLED` jest wyłączone.
- Ponowne podejście (retake) — poza MVP zgodnie z B1.

### Acceptance criteria
1. Viewer nie widzi żadnego z tych działań; próba wywołania akcji kończy się odmową po stronie serwera.
2. Rotacja unieważnia poprzedni link i wszystkie sesje z poprzedniej rewizji.
3. Po wycofaniu zgody przyciski znikają, a odczyt odpowiedzi jest zablokowany.
4. Sekret nie trafia do `revalidatePath`, logów ani historii przeglądarki po odświeżeniu.

---

## SC-014-C4 — Strona kandydata (B4)

- **LEVEL:** L3 (trust boundary, dane kandydata) · **SCOPE:** FULLSTACK
- **OWNER:** Cursor · **REVIEWER:** Codex · **DEPENDS ON:** SC-014-C2, SC-014-C3
- **Szacunek:** 4–5 dni

### Goal
Kandydat otwiera link, widzi zadanie, pisze odpowiedź z autozapisem i przesyła ją raz.

### In scope
- Nowa trasa publiczna (bez logowania), np. `app/test/[...]/page.tsx`, poza panelem firmy.
- Bootstrap tokenu z `#fragment` zgodnie z B1 sekcja 3 punkt 4: minimalny skrypt first-party przed
  hydracją, natychmiastowy `history.replaceState`, wymiana na ciasteczko
  `Secure; HttpOnly; SameSite=Strict`, wyczyszczenie tokenu z pamięci.
- Ekran przed startem (`inspect`): kto zleca, ile czasu, do kiedy można zacząć — **bez treści zadania**.
- Ekran testu po jawnym starcie: treść, licznik czasu, pole odpowiedzi, autozapis draftu na serwerze.
- Przesłanie z potwierdzeniem; po przesłaniu brak możliwości edycji.
- Informacja RODO i link do aneksu.

### Out of scope
- Jakikolwiek skrypt zewnętrzny, analityka, session replay, crash reporting.
- `localStorage` / `sessionStorage` na sekret lub treść odpowiedzi.
- AI oceniające odpowiedź.

### Acceptance criteria
1. Po odświeżeniu strony token nie występuje w URL, historii ani pamięci; sesja odtwarza się z ciasteczka.
2. Draft przetrwa zamknięcie i ponowne otwarcie karty przed deadline.
3. Po deadline przesłanie jest odrzucone, a już przesłana odpowiedź nadal zwraca potwierdzenie.
4. CSP, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` obecne na tej trasie.
5. Test Chromium przechodzi pełną ścieżkę: otwarcie → start → autozapis → przesłanie → odświeżenie.

---

## SC-014-C5 — Ocena próby przez człowieka

- **LEVEL:** L3 · **SCOPE:** FULLSTACK
- **OWNER:** Cursor · **REVIEWER:** Codex · **DEPENDS ON:** SC-014-C4
- **Szacunek:** 2–3 dni

### Goal
Rekruter ocenia przesłaną odpowiedź w niezmiennej rubryce, z dowodami, a wynik jest policzony
i zapisany wersjonowanie.

### In scope
- Widok odpowiedzi kandydata obok kryteriów rubryki.
- Formularz oceny per kryterium (below / meets / above / insufficient_data) z uzasadnieniem.
- Wywołanie `lib/competency-test.ts` do policzenia pokrycia i punktów; zapis do
  `competency_test_review_entries`.
- Widoczny komunikat, gdy pokrycie < 0.6 — wynik nie jest wtedy miarodajny.

### Out of scope
- Automatyczna decyzja hire/reject. Zabronione przez guardrails.
- Ocena przez AI.

### Acceptance criteria
1. `reviewer_id`, `policy_version`, `coverage` i `score` pochodzą z bazy, nie z formularza.
2. Historia ocen jest append-only; poprzednie wersje pozostają widoczne.
3. Po wycofaniu zgody ocena nie jest dostępna do odczytu ani eksportu.

---

# MODUŁ B — Chatbot informacyjny

**Nowe ID:** SC-021 (wolne; `candidate chatbot` figuruje w BACKLOG.md jako pozycja poza pierwszą dwudziestką)
**Łącznie: 10–15 dni** · **Stan wejściowy: nic nie istnieje.**

> **Uwaga sprzedażowa, do załatwienia natychmiast, niezależnie od budowy.**
> `app/components/marketing/package-comparison.tsx` deklaruje chatbota jako dostępnego („Tak”)
> także w FREE i PRESELEKCJI — czyli w pakietach już oferowanych. To obietnica bez pokrycia.
> Osobny, półgodzinny task SC-021-A0 poniżej.

## SC-021-A0 — Korekta obietnicy na stronie

- **LEVEL:** L1 · **SCOPE:** FRONTEND · **OWNER:** Cursor · **REVIEWER:** Codex
- **DEPENDS ON:** — · **Szacunek:** 0,5 dnia

Zmienić w tabeli porównawczej wiersz „Chatbot informacyjny” z „Tak/Tak/Tak/Tak” na „Planowany”
we wszystkich czterech kolumnach i usunąć go z list funkcji FREE i PRESELEKCJI. Zgodne z
Definition of Done: „brak fałszywego UI sugerującego działającą funkcję, jeśli integracja nie istnieje”.
**Ten task wykonać przed wszystkimi innymi.**

## SC-021-A — Architektura chatbota

- **LEVEL:** L3 (kontrakt dostawcy AI, dane kandydata, koszt) · **SCOPE:** BACKEND
- **OWNER:** Codex · **REVIEWER:** Codex · **DEPENDS ON:** SC-021-A0 · **Szacunek:** 2–3 dni

### Goal
Dokument architektury na wzór `docs/sc-005-openai-screening-worker-architecture.md`, rozstrzygający:
zakres wiedzy bota, granice tematyczne, model danych rozmowy, retencję, limity kosztu
i ochronę przed prompt injection.

### Rozstrzygnięcia wymagane w dokumencie
1. **Źródło wiedzy.** Rekomendacja: wyłącznie profil stanowiska i opis procesu wprowadzone przez
   firmę dla danej rekrutacji. Bez dostępu do CV, bez danych innych kandydatów, bez wiedzy ogólnej
   o firmie spoza tego, co firma wpisała.
2. **Granice tematyczne.** Bot nie ocenia kandydata, nie obiecuje zatrudnienia, nie podaje widełek
   płacowych poza wpisanymi, nie zbiera danych osobowych, nie odpowiada na pytania o zdrowie,
   wiek, pochodzenie, wyznanie i życie prywatne. Lista zakazanych tematów na wzór
   `SC012_PROHIBITED_TOPICS` z `lib/voice/interview-plan.ts` — ten rejestr już istnieje i należy
   go ponownie użyć, nie pisać od nowa.
3. **Prompt injection.** Treść wpisana przez firmę i treść wpisana przez kandydata są danymi,
   nigdy instrukcjami. Ten sam wymóg co w guardrails dla CV.
4. **Koszt.** Limit tokenów na rozmowę, limit rozmów na rekrutację, twardy limit miesięczny
   na firmę, zachowanie po przekroczeniu (grzeczna odmowa, nie błąd).
5. **Retencja.** Czy transkrypt rozmowy jest w ogóle przechowywany. Rekomendacja: tak, ale
   z automatycznym usunięciem po 30 dniach i pełnym wpięciem w inwentarz SC-010.

## SC-021-B — Migracja: rozmowy, limity, retencja

- **LEVEL:** L3 · **SCOPE:** BACKEND · **OWNER:** Cursor · **REVIEWER:** Codex
- **DEPENDS ON:** SC-021-A · **Szacunek:** 2–3 dni

Tabele rozmów i wiadomości z `company_id`, RLS, licznik zużycia, inwentarz usuwania R12,
rollback. Bez wystawienia funkcji przez Data API dla roli kandydata.

## SC-021-C — Endpoint i integracja z modelem

- **LEVEL:** L3 (AI provider contract, secrets, koszt) · **SCOPE:** BACKEND
- **OWNER:** Cursor · **REVIEWER:** Codex · **DEPENDS ON:** SC-021-B · **Szacunek:** 3–4 dni

Edge Function na wzór `supabase/functions/screening-worker/`, flaga `CHATBOT_ENABLED=false`
domyślnie, limity, wersjonowanie promptu, fingerprint wejścia, czytelne dowody dla człowieka.

## SC-021-D — Panel firmy: baza wiedzy rekrutacji

- **LEVEL:** L2 · **SCOPE:** FULLSTACK · **OWNER:** Cursor · **REVIEWER:** Codex
- **DEPENDS ON:** SC-021-B · **Szacunek:** 2 dni

Ekran, na którym firma wpisuje, co bot może powiedzieć o tej rekrutacji, oraz podgląd rozmów.

## SC-021-E — Widget czatu dla kandydata

- **LEVEL:** L2 · **SCOPE:** FRONTEND · **OWNER:** Cursor · **REVIEWER:** Codex
- **DEPENDS ON:** SC-021-C, SC-021-D · **Szacunek:** 2–3 dni

Interfejs rozmowy na trasie publicznej, informacja że rozmawia z botem (wymóg AI Act i
`docs/legal/v1.0/05_AI_i_nadzor_czlowieka.md`), limit długości, brak zbierania danych kontaktowych.

---

# MODUŁ C — Rozszerzony raport kandydata

**ID:** SC-015 (istnieje w backlogu jako „Raport WERYFIKACJA łączący CV, voice i test”)
**Łącznie: 6–9 dni** · **Zmiana zakresu wobec backlogu: bez części voice.**

Dziś istnieje wyłącznie raport **rekrutacji** (`app/dashboard/.../report/`) — ranking i shortlista.
Rozszerzony raport to inny obiekt: **jeden kandydat, wszystkie źródła**.

## SC-015-A — Architektura raportu kandydata

- **LEVEL:** L2 · **SCOPE:** FULLSTACK · **OWNER:** Codex · **REVIEWER:** Codex
- **DEPENDS ON:** SC-014-C5 · **Szacunek:** 1–2 dni

### Zawartość raportu — proponowany układ
1. Nagłówek: kandydat, stanowisko, rekrutacja, data wygenerowania, kto generował.
2. Dopasowanie do wymagań z analizy CV — oceny i cytaty z `screening_criterion_results`,
   po review człowieka.
3. Wynik testu kompetencji — punkty, pokrycie, oceny per kryterium z dowodami
   (`competency_test_review_entries`).
4. Obserwacje z ćwiczeń — `exercise_observation_entries`.
5. Ocena zachowań w 8 obszarach — `behavior_assessment_entries`, najnowsza wersja każdego obszaru.
6. Przebieg etapów i decyzja człowieka — `application_stage_events`, `application_decision_events`.
7. Stopka: zastrzeżenie, że raport nie jest decyzją o zatrudnieniu, i podstawa prawna.

**Zasada pustych sekcji:** sekcja bez danych wyświetla „Brak danych w tym obszarze”, nie znika.
Rekruter ma widzieć, czego nie sprawdzono — to jest część wartości raportu.

## SC-015-B — Warstwa odczytu i agregacji

- **LEVEL:** L3 (agregacja danych kandydata, kontrola dostępu) · **SCOPE:** BACKEND
- **OWNER:** Cursor · **REVIEWER:** Codex · **DEPENDS ON:** SC-015-A · **Szacunek:** 2–3 dni

`lib/candidate-report.ts` na wzór `lib/screening-report-source.ts`: jedno wejście, jawne sprawdzenie
że wszystkie rekordy należą do tej firmy, tej rekrutacji i tego kandydata; brakujący lub nadmiarowy
wiersz blokuje raport, nie jest cicho pomijany. Respektowanie markera wycofania zgody.

## SC-015-C — Ekran raportu i druk

- **LEVEL:** L2 · **SCOPE:** FRONTEND · **OWNER:** Cursor · **REVIEWER:** Codex
- **DEPENDS ON:** SC-015-B · **Szacunek:** 2 dni

`app/dashboard/[companyId]/recruitments/[recruitmentId]/applications/[applicationId]/report/`
na wzorze istniejącego raportu rekrutacji, z arkuszem druku i przyciskiem zapisu do PDF przez przeglądarkę.

## SC-015-D — Eksport i audyt dostępu

- **LEVEL:** L2 · **SCOPE:** FULLSTACK · **OWNER:** Cursor · **REVIEWER:** Codex
- **DEPENDS ON:** SC-015-C · **Szacunek:** 1–2 dni

Eksport CSV na wzór `report/export/route.ts`, ponowne sprawdzenie uprawnień przy eksporcie,
zapis zdarzenia dostępu do danych kandydata.

---

# Podsumowanie pracy

| Moduł | Zadania | Dni |
|---|---|---|
| A — test kompetencji | SC-014-C1…C5 | 13–20 |
| C — rozszerzony raport | SC-015-A…D | 6–9 |
| B — chatbot | SC-021-A0…E | 10–15 |
| **Razem** | **15 zadań** | **29–44** |
| Rezerwa na review, poprawki i testy regresji (ok. 20%) | | 5–8 |
| **Suma realistyczna** | | **34–52 dni robocze** |

Przy dotychczasowym tempie projektu to **2–3 miesiące**.

**Pierwszy kamień milowy (A + C, 19–29 dni):** działający test kompetencji dla kandydata
i rozszerzony raport. To jest moment, w którym jest co pokazać klientowi.

---

# Decyzje właściciela — potrzebne przed startem

## D1 — Limiter brokera: Postgres czy Redis?

Broker testu wymaga ograniczania liczby żądań. Redis REST (Upstash) to nowy, stały koszt
rzędu kilkudziesięciu złotych miesięcznie. Wariant postgresowy nie kosztuje nic, jest wolniejszy,
ale przy braku klientów i przy skali testów to bez znaczenia.

**Rekomendacja: Postgres.** Uzasadnienie: nie ma jeszcze ruchu, który uzasadniałby nowy abonament,
a przejście na Redis później to jedna wymiana adaptera, bo interfejs `SharedRateLimiter` już istnieje.

**TAK = Postgres (rekomendowane) / NIE = Redis Upstash**

## D2 — Jak nazwać i wycenić produkt, który z tego powstanie?

Po zbudowaniu A + C powstanie pakiet: preselekcja CV + test kompetencji + rozszerzony raport.
To **nie jest** reklamowana WERYFIKACJA, bo nie ma rozmów z botem. Sprzedawanie tego jako
WERYFIKACJA za 899 zł byłoby obietnicą bez pokrycia.

Dwa warianty:
- **Nowy pakiet pośredni** między PRESELEKCJĄ a WERYFIKACJĄ, np. „PRESELEKCJA+” albo „TEST”,
  wyceniony między 300 a 899 zł. WERYFIKACJA zostaje na stronie jako planowana.
- **Przedefiniowanie WERYFIKACJI**: usunięcie rozmów z jej opisu, obniżenie ceny, dopisanie
  rozmów jako późniejszego rozszerzenia.

**Rekomendacja: nowy pakiet pośredni.** Uzasadnienie: zostawia nazwę WERYFIKACJA dla produktu
z rozmowami, który docelowo ma powstać, i nie wymaga tłumaczenia klientom, dlaczego pakiet
„stracił” funkcje.

**TAK = nowy pakiet pośredni (rekomendowane) / NIE = przedefiniować WERYFIKACJĘ**

> Decyzja D2 nie blokuje startu budowy — jest potrzebna dopiero przy zadaniu rozliczeniowym,
> czyli po module C. Można ją podjąć za miesiąc. D1 jest potrzebna przy SC-014-C2, czyli w drugim tygodniu.

---

# Zasady obowiązujące całą budowę

Powtórzone z `AGENTS.md` i `docs/DEFINITION_OF_DONE.md`, bo dotyczą każdego z 15 zadań:

- Branche zadaniowe wychodzą z `integration`, PR celuje w `integration`. Nigdy w `main`.
- Każde L3 wymaga niezależnego review Codex z werdyktem PASS przed merge.
- Migracje nie są uruchamiane na produkcji z sesji agenta. Tylko `skillcheck-preview`.
- Żaden z tych modułów nie kontaktuje się z rzeczywistym kandydatem.
- Żadna funkcja AI nie podejmuje decyzji o zatrudnieniu i każda zostawia dowody do wglądu człowieka.
- Nie pokazujemy w interfejsie funkcji, która nie działa.
- Właściciel jest pytany wyłącznie o: production approval, nowe koszty i działania nieodwracalne.

---

*Plan przygotowany 2026-11-02 na podstawie audytu z tego samego dnia. Nie wprowadza zmian w kodzie ani bazie.*
