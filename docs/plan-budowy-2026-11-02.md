# Plan budowy — test kompetencji, rozszerzony raport, kalkulator wyceny

**Data:** 2026-11-02 · **Podstawa:** [audyt-weryfikacja-2026-11-02.md](audyt-weryfikacja-2026-11-02.md)
**Zakres:** trzy moduły odmrożone decyzją właściciela 2026-11-02: (A) test kompetencji dla
kandydata, (C) rozszerzony raport kandydata, (D) kalkulator wyceny i spięcie z cennikiem na stronie.
Odmrożenie wszystkich trzech jest zapisane w `CLAUDE.md`, sekcja „Scope reopened”.
Moduł (B) chatbot informacyjny został wykreślony decyzją właściciela 2026-11-02 — opis zachowany
na przyszłość w sekcji MODUŁ B.
**Poza zakresem tego planu:** voicebot i analiza rozmowy (SC-011/012/013), Assessment Center, Talent Pool.

---

## Dla właściciela — streszczenie w czterech punktach

1. **Nie zaczynamy od zera.** Test kompetencji ma już zaprojektowaną architekturę (SC-014-B1), gotowy
   walidator i punktację oraz zbudowaną bramkę HTTP (SC-014-B3). Brakuje trzech rzeczy: wdrożenia bazy,
   ekranu dla kandydata i oceny wyniku. To zmniejsza pracę o mniej więcej jedną trzecią w stosunku do
   szacunku z audytu.
2. **Rozszerzony raport jest najtańszy i najbardziej opłacalny** — spina w jedną całość rzeczy,
   które już działają, ale nikt ich nie widzi razem.
3. **Łącznie 32–50 dni roboczych**, czyli realistycznie 2–2,5 miesiąca. Bez voicebota i bez chatbota.
4. **Są dwie decyzje, które musisz podjąć, zanim ruszy budowa** (D1 i D2 na końcu dokumentu),
   obie w formie TAK/NIE z rekomendacją.

### Czego NIE wolno po drodze zrobić

Po zbudowaniu tych modułów **nadal nie będzie można sprzedawać pakietu WERYFIKACJA**
w kształcie reklamowanym na stronie, bo ten pakiet obiecuje 20 rozmów z botem i analizę rozmowy.
Powstanie natomiast inny, mniejszy produkt. Jak go nazwać i wycenić — to decyzja D2 poniżej.

---

## Kolejność i zależności

Raport (C) konsumuje wynik testu (A), więc A musi być wcześniej. Kalkulator (D) nie zależy
od żadnego z nich.

```
SC-014-C1 → C2 → C3 → C4 → C5 → C6 → SC-015-A → B → C → D → [D2: pakiet i cena]

SC-PRICING-W1 → W2 → W3 → W4   (niezależnie, do wstawienia między inne zadania)
```

**Rekomendowana kolejność:** SC-014-C1…C6, potem SC-015-A…D, a kalkulator wtedy, gdy coś innego
czeka na review. A+C dają kompletny, pokazywalny produkt w 19–29 dni.

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
- **OWNER:** Claude (builder) · **REVIEWER:** niezależna sesja Claude
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

### Ustalenie z 2026-11-02 — C1 to NIE jest przeniesienie plików

Pierwsze rozpoznanie pokazało, że prototyp z `db/isolated/` jest napisany pod stan bazy sprzed
miesiąca i nie da się go skopiować:

- `sc014-b2-attempts.sql:5` i `sc014-b2-retention.sql:7` wymagają `erasure_inventory_baseline_r5`.
  Obecny stan to **r10**.
- `sc014-b2-retention.sql:727` zawiera **wpisany na sztywno podpis schematu**
  (`b20053a8e9a9…`) i manifest **99 obiektów**. Manifest nie zna co najmniej pięciu obiektów, które
  powstały od tamtej pory: `private.cv_bulk_items`, `private.cv_bulk_worker_nonces`,
  `private.application_preselection_group_events`, `private.erasure_inventory_baseline_r9`,
  `private.erasure_inventory_baseline_r10`.
- Plik sam sprawdza swój podpis (`Unknown schema dependency`, PT409), więc przeniesiony bez zmian
  **wywróci się na własnym teście**, zamiast cicho przepuścić zły stan. To dobra wiadomość:
  zabezpieczenie działa.

Wniosek: inwentarz usuwania trzeba **wygenerować od nowa względem r10**, a nie portować.
Reszta plików (grants, attempts, sesje, drafty) przenosi się bliżej jeden do jednego.
Szacunek 4–6 dni pozostaje aktualny — ta praca była w nim przewidziana.

### Security / privacy checks
- brak plaintext tokenów w jakiejkolwiek tabeli, logu i komunikacie błędu
- `competency_test_gateway` nie ma `rolcanlogin` poza dedykowanym loginem z osobnym hasłem
- żadna funkcja kandydata nie jest wystawiona przez Supabase Data API
- brak `service_role` w ścieżce kandydata

---

## SC-014-C2 — Runtime brokera w Preview

- **LEVEL:** L3 (secrets handling, trust boundary) · **SCOPE:** BACKEND / OPERATIONS
- **OWNER:** Claude (builder) · **REVIEWER:** niezależna sesja Claude · **DEPENDS ON:** SC-014-C1
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
### Required tests
typecheck, build, test modułu brokera (`lib/competency-attempt-broker.ts`), test limitera
(`lib/competency-broker-limiter.ts`) na współbieżnych żądaniach, test HTTP trasy
`/api/competency/attempt` w wariantach: poprawny Origin, zły Origin, brak CSRF, przekroczony limit.

### Security / privacy checks
Weryfikacja Origin i CSRF po stronie serwera, nie w kliencie; limit liczony na serwerze i odporny
na równoległe żądania; odpowiedź 429 identyczna dla kandydata istniejącego i nieistniejącego;
token wyłącznie w ciasteczku `HttpOnly`, `Secure`, `SameSite`; żaden log nie zawiera tokenu,
treści odpowiedzi ani identyfikatora kandydata; brak `service_role` na tej trasie.

---

## SC-014-C3 — UI rekrutera: wydanie, rotacja i odwołanie dostępu

- **LEVEL:** L3 (autoryzacja, dane kandydata) · **SCOPE:** FULLSTACK
- **OWNER:** Claude (builder) · **REVIEWER:** niezależna sesja Claude · **DEPENDS ON:** SC-014-C1
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
### Required tests
typecheck, build, test akcji serwerowych wydania/rotacji/odwołania, test odmowy dla roli viewer,
test unieważnienia poprzedniej rewizji po rotacji, test blokady odczytu po wycofaniu zgody.

### Security / privacy checks
Uprawnienia sprawdzane ponownie w akcji serwerowej, nie tylko w UI; sekret generowany na serwerze
i nigdy nie zwracany ponownie po wydaniu; brak sekretu w `revalidatePath`, w URL, w logach i w
odpowiedzi HTTP; rotacja i odwołanie zapisują zdarzenie audytowe; zapytania zawsze z `company_id`.

---

## SC-014-C4 — Strona kandydata (B4)

- **LEVEL:** L3 (trust boundary, dane kandydata) · **SCOPE:** FULLSTACK
- **OWNER:** Claude (builder) · **REVIEWER:** niezależna sesja Claude · **DEPENDS ON:** SC-014-C2, SC-014-C3
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
### Required tests
typecheck, build, test HTTP trasy kandydata, test autozapisu i odtworzenia draftu z ciasteczka,
test odrzucenia po deadline, test nagłówków (CSP, `Referrer-Policy`, `Cache-Control`),
test Chromium pełnej ścieżki wymieniony w kryterium 5.

### Security / privacy checks
Token wymieniany na sesję w ciasteczku `HttpOnly` i usuwany z URL przy pierwszym wejściu; brak PII
w tytule strony, w URL i w logach błędów; `robots: noindex`; strona nie ładuje zasobów z obcych
domen; treść odpowiedzi kandydata nie trafia do żadnego dostawcy AI na tym etapie.

---

## SC-014-C5 — Ocena próby przez człowieka

- **LEVEL:** L3 · **SCOPE:** FULLSTACK
- **OWNER:** Claude (builder) · **REVIEWER:** niezależna sesja Claude · **DEPENDS ON:** SC-014-C4
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
### Required tests
typecheck, build, test zapisu oceny na danych syntetycznych, test append-only (próba nadpisania
poprzedniej wersji kończy się nową wersją, nie modyfikacją), test izolacji tenantów, test odmowy
odczytu i eksportu po wycofaniu zgody.

### Security / privacy checks
`reviewer_id` brany z sesji serwerowej, nigdy z formularza; `policy_version`, `coverage` i `score`
wyliczane lub czytane z bazy; brak zapytań bez `company_id`; komunikat błędu nie ujawnia istnienia
rekordu innej firmy; zgodność z guardrailem „brak automatycznej decyzji hire/reject" — ocena
człowieka jest wymagana, nie sugerowana.

---

## SC-014-C6 — AI układa zadanie; rekruter zatwierdza

**Decyzja właściciela 2026-11-02 (rozmowa głosowa).** Do tej pory zadania pisał rekruter ręcznie.
Właściciel: *„przecież to nie miało być inaczej"* — zadanie ma powstawać automatycznie z profilu
firmy, profilu stanowiska, nazwy stanowiska oraz z treści CV.

- **LEVEL:** L3 (kontrakt dostawcy AI, dane z CV, koszt) · **SCOPE:** FULLSTACK
- **OWNER:** Claude (builder) · **REVIEWER:** niezależna sesja Claude
- **DEPENDS ON:** SC-014-C3 · **Szacunek:** 4–6 dni

### Goal
Rekruter dostaje gotową propozycję zadania i tylko ją zatwierdza, zamiast pisać od zera.

### Dlaczego zadanie jest w dwóch częściach

Gdyby całe zadanie układać pod indywidualne CV, każdy kandydat dostałby inne, o innej trudności,
a raport i tak postawiłby ich obok siebie. Wyników nie dałoby się uczciwie porównać. Dlatego:

1. **Część wspólna — identyczna dla wszystkich na danym stanowisku.** AI układa treść zadania
   i kryteria oceny (rubrykę) z profilu firmy, profilu stanowiska i jego nazwy. Powstaje raz
   na stanowisko, nie raz na kandydata. To ona jest podstawą porównania.
2. **Część indywidualna — kilka dodatkowych pytań z własnego CV kandydata.** Dotyczą tego, czego
   w CV brakuje albo co jest niejasne. **Nie są punktowane do wyniku porównywalnego** — stanowią
   osobną sekcję odpowiedzi i osobną sekcję w raporcie.

Właściciel zaakceptował ten podział: *„Dokładnie robimy tak, jak napisałeś."*

### In scope
- Generowanie części wspólnej: wejście = profil firmy, profil stanowiska (`tasks`, `kpis`,
  `required_competencies`, `required_behaviors`, `description`, `autonomy_level`) i nazwa stanowiska.
  Wyjście = propozycja `ExerciseDefinition` zgodna z istniejącym walidatorem
  `lib/exercise-definition.ts`, w tym kryteria z progami below/meets/above.
- Generowanie części indywidualnej: **ponowne użycie tego, co już istnieje.** Analiza CV wypełnia
  `screening_criterion_results.suggested_question` i `missing_info`, a `lib/interview-gaps.ts`
  składa z nich listę luk. Pytania indywidualne biorą się stąd, nie z nowej analizy CV.
  To oszczędza osobne wywołanie modelu na kandydata i daje gotowy ślad pochodzenia.
- Ekran zatwierdzenia dla rekrutera: propozycja obok profilu stanowiska, edycja każdego pola,
  zatwierdzenie lub odrzucenie w całości. **Nic nie trafia do kandydata bez zatwierdzenia.**
- Ślad pochodzenia: dla każdego pytania zapisane, z czego powstało (które kryterium, która wersja
  profilu stanowiska, która wersja analizy CV, fingerprint wejścia, wersja promptu).
- Flaga `EXERCISE_AI_ENABLED`, domyślnie wyłączona. Przy wyłączonej rekruter pisze ręcznie, jak dziś.

### Out of scope
- Ocenianie odpowiedzi przez AI. Ocena pozostaje ludzka (SC-014-C5).
- Automatyczne wysłanie zadania do kandydata po wygenerowaniu.
- Nowa analiza CV. Korzystamy z już istniejącej.

### Existing contracts to preserve
- **CV/provider payload musi pozostać minimalny i zatwierdzony.** Do modelu trafia wyłącznie
  zredagowana (zanonimizowana) treść CV, tak jak w `lib/screening-ai.ts`. Jeśli redakcja zawiedzie
  lub jest wyłączona — nie wysyłamy nic.
- Treść CV i profilu stanowiska są **danymi, nigdy instrukcjami** (prompt injection).
- Wynik wersjonowany i powiązany z fingerprintem wejścia; człowiek widzi dowody.
- Brak automatycznej decyzji o zatrudnieniu.

### Acceptance criteria
1. Dwa zadania wygenerowane dla tego samego stanowiska mają identyczną część wspólną
   (ten sam `definition`), niezależnie od kandydata.
2. Część indywidualna istnieje wyłącznie dla kandydatów, którzy mają sprawdzoną przez człowieka
   analizę CV; bez niej kandydat dostaje samo zadanie wspólne.
3. Propozycja niezatwierdzona przez rekrutera nie jest osiągalna przez żaden grant kandydata.
4. Payload wysłany do modelu nie zawiera imienia, nazwiska ani danych kontaktowych kandydata —
   udowodnione testem na syntetycznym CV zawierającym takie dane.
5. CV zawierające tekst udający instrukcję (np. „zignoruj poprzednie polecenia") nie zmienia
   treści ani struktury wygenerowanego zadania.
6. Przy `EXERCISE_AI_ENABLED=false` ekran działa jak dziś i nie wywołuje modelu.

### Required tests
- `npm run typecheck`, `npm run build`
- testy generatora na syntetycznych profilach i CV (fixture jak `fixtures/screening/sc-005-synthetic.json`)
- test redakcji payloadu i test prompt injection
- test porównywalności: ta sama część wspólna dla dwóch różnych kandydatów

### Security / privacy checks
- brak PII w payloadzie i w logach
- limit kosztu i liczby wywołań per rekrutacja
- ślad pochodzenia każdego pytania zapisany i czytelny dla człowieka

---

## Reguła R1 — test dostaje tylko ktoś z shortlisty

**Decyzja właściciela 2026-11-02 (rozmowa głosowa).** Weryfikacja dotyczy osób, które przeszły
preselekcję. Dziś nic tego nie pilnuje: rekruter mógłby wydać link dowolnemu kandydatowi
w rekrutacji.

Reguła obowiązuje **oba poziomy**, nie tylko interfejs:

- **Baza (SC-014-C1).** Funkcja wydająca grant sprawdza obecność zgłoszenia w
  `public.recruitment_shortlist_entries` dla tej rekrutacji, pod blokadami opisanymi w SC-014-B1
  sekcja 4. Brak wpisu = odmowa. Precedens istnieje: `lib/voice/trusted-source-verifier.ts`
  robi dokładnie taki join dla rozmów głosowych — powtarzamy wzorzec, nie wymyślamy nowego.
- **Interfejs (SC-014-C3).** Przycisk wydania dostępu jest nieaktywny dla kandydata spoza
  shortlisty, z czytelnym wyjaśnieniem dlaczego.

Dodatkowe kryterium akceptacji dla SC-014-C1: próba wydania grantu kandydatowi spoza shortlisty
kończy się odmową na poziomie bazy, również gdy interfejs zostanie ominięty.

---

# MODUŁ B — Chatbot informacyjny — **WYKREŚLONY 2026-11-02**

**Decyzja właściciela 2026-11-02 (rozmowa głosowa): chatbot wypada z planu.**
Powód: żaden klient nie kupi SkillChecka z powodu chatbota — sprzedaje się analiza CV,
test kompetencji i raport. Chatbot odpowiadałby na pytania, które i tak są w ogłoszeniu.
Odkłada to 3–4 dni pracy i comiesięczny koszt modelu AI.

Wykreślony również z tabeli pakietów na stronie (`package-comparison.tsx`) oraz z publicznego
demo kalkulatora (`public/kalkulator-demo.html`, gdzie figurował jako dostępny „✓” we wszystkich
czterech pakietach).

**Wracamy do tematu, gdy pierwszy klient o niego zapyta.** Wtedy punktem wyjścia jest wersja
minimalna opisana niżej, nie pełny rozkład na pięć zadań.

<details>
<summary>Zachowany opis wersji minimalnej (SC-022-B1, 3–4 dni) — na przyszłość</summary>

Czat na trasie publicznej podpięty pod konkretną rekrutację. Odpowiedzi wyłącznie na podstawie
profilu stanowiska, który firma już wpisała (zadania, KPI, kompetencje, wymagania zachowań).
Bez nowego panelu i bez własnej bazy wiedzy.

Wyraźna informacja, że to bot (wymóg AI Act). Bot nie ocenia kandydata, nie obiecuje zatrudnienia,
nie podaje widełek spoza wpisanych, nie zbiera danych osobowych, nie odpowiada na pytania o zdrowie,
wiek, pochodzenie, wyznanie i życie prywatne — lista zakazanych tematów `SC012_PROHIBITED_TOPICS`
z `lib/voice/interview-plan.ts` już istnieje i należy jej użyć ponownie.

Treść wpisana przez firmę i przez kandydata jest danymi, nigdy instrukcją (ochrona przed prompt
injection, ten sam wymóg co przy CV).

Rozmowa nie jest zapisywana — żyje w pamięci przeglądarki. To usuwa cały wątek RODO, retencji
i inwentarza usuwania, czyli największą pozycję kosztową. Twarde limity: długość pytania, liczba
pytań w rozmowie, globalny limit miesięczny kosztu; po przekroczeniu bot grzecznie odmawia.
Flaga `CHATBOT_ENABLED`, domyślnie wyłączona.

Rozszerzenia na później: zapis rozmów z retencją, panel firmy z własną bazą wiedzy, limity per
firma, statystyki pytań. Każde opłacalne tylko wtedy, gdy wersja minimalna okaże się używana.

ID `SC-022` jest zarezerwowane dla tego modułu. Nie używać `SC-021` — to zamrożona praca nad
AI gateway (gałęzie `feat/sc-021-*`).

</details>

---

# MODUŁ C — Rozszerzony raport kandydata

**ID:** SC-015 (istnieje w backlogu jako „Raport WERYFIKACJA łączący CV, voice i test”)
**Łącznie: 6–9 dni** · **Zmiana zakresu wobec backlogu: bez części voice.**

Dziś istnieje wyłącznie raport **rekrutacji** (`app/dashboard/.../report/`) — ranking i shortlista.
Rozszerzony raport to inny obiekt: **jeden kandydat, wszystkie źródła**.

## SC-015-A — Architektura raportu kandydata

- **LEVEL:** L2 · **SCOPE:** FULLSTACK · **OWNER:** Claude (builder) · **REVIEWER:** niezależna sesja Claude
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

**Acceptance criteria:** 1) dokument wskazuje dla każdej sekcji konkretne źródło danych i warunek
dostępu; 2) rozstrzyga, co raport pokazuje po wycofaniu zgody; 3) nie wprowadza nowej migracji
ani nowego wywołania AI.
**Required tests:** typecheck, build (zmiana dokumentacyjna).
**Security / privacy checks:** projekt nie przewiduje ujawnienia danych innych kandydatów ani
surowej treści CV poza zakresem już dostępnym rekruterowi tej rekrutacji.

## SC-015-B — Warstwa odczytu i agregacji

- **LEVEL:** L3 (agregacja danych kandydata, kontrola dostępu) · **SCOPE:** BACKEND
- **OWNER:** Claude (builder) · **REVIEWER:** niezależna sesja Claude · **DEPENDS ON:** SC-015-A · **Szacunek:** 2–3 dni

`lib/candidate-report.ts` na wzór `lib/screening-report-source.ts`: jedno wejście, jawne sprawdzenie
że wszystkie rekordy należą do tej firmy, tej rekrutacji i tego kandydata; brakujący lub nadmiarowy
wiersz blokuje raport, nie jest cicho pomijany. Respektowanie markera wycofania zgody.

**Acceptance criteria:** 1) rekord należący do innej firmy, rekrutacji lub kandydata blokuje raport
zamiast zostać pominięty; 2) po wycofaniu zgody odczyt jest odmawiany na poziomie warstwy, nie
tylko ukrywany w UI; 3) brak którejkolwiek sekcji nie wywraca całego raportu.
**Required tests:** typecheck, build, testy modułu na danych syntetycznych, test izolacji tenantów
(dwie firmy, ten sam identyfikator kandydata), test odmowy po wycofaniu zgody.
**Security / privacy checks:** brak zapytań bez `company_id`; brak `service_role`; komunikaty
błędów nie ujawniają istnienia rekordów innej firmy.

## SC-015-C — Ekran raportu i druk

- **LEVEL:** L2 · **SCOPE:** FRONTEND · **OWNER:** Claude (builder) · **REVIEWER:** niezależna sesja Claude
- **DEPENDS ON:** SC-015-B · **Szacunek:** 2 dni

`app/dashboard/[companyId]/recruitments/[recruitmentId]/applications/[applicationId]/report/`
na wzorze istniejącego raportu rekrutacji, z arkuszem druku i przyciskiem zapisu do PDF przez przeglądarkę.

**Acceptance criteria:** 1) sekcja bez danych pokazuje „Brak danych w tym obszarze”, nie znika;
2) viewer widzi raport, ale nie może go edytować; 3) widok druku mieści się na stronie A4 bez
ucinania dowodów; 4) stopka z zastrzeżeniem o braku decyzji o zatrudnieniu jest zawsze widoczna.
**Required tests:** typecheck, build, test komponentu raportu, test renderu pustych sekcji.
**Security / privacy checks:** brak danych kandydata w tytule strony i w URL; `robots: noindex`;
`Referrer-Policy: no-referrer`; brak PII w logach błędów.

## SC-015-D — Eksport i audyt dostępu

- **LEVEL:** L2 · **SCOPE:** FULLSTACK · **OWNER:** Claude (builder) · **REVIEWER:** niezależna sesja Claude
- **DEPENDS ON:** SC-015-C · **Szacunek:** 1–2 dni

Eksport CSV na wzór `report/export/route.ts`, ponowne sprawdzenie uprawnień przy eksporcie,
zapis zdarzenia dostępu do danych kandydata.

**Acceptance criteria:** 1) eksport sprawdza uprawnienia ponownie, nie ufa sesji z widoku;
2) po wycofaniu zgody eksport jest odmawiany; 3) każdy eksport zostawia wpis audytowy z kim, kiedy
i czego dotyczył; 4) plik zawiera te same oceny i dowody co ekran.
**Required tests:** typecheck, build, test HTTP trasy eksportu, test odmowy po wycofaniu zgody.
**Security / privacy checks:** brak nagłówków cache'ujących plik; nazwa pliku bez nazwiska
kandydata; CSV odporny na wstrzyknięcie formuły (pola zaczynające się od `=`, `+`, `-`, `@`).

---

# MODUŁ D — Kalkulator wyceny i spięcie z cennikiem na stronie

**ID:** SC-PRICING (kontynuacja) · **Łącznie: 6–9 dni** (W1 1 + W2 2–3 + W2b 1–2 + W3 1–2 + W4 1)
**Decyzja właściciela 2026-11-02:** prace nad kalkulatorem mają ruszyć.
Zastępuje wcześniejsze „na razie zostaw, nie spinaj, dopóki nie powiem”.

**Decyzja cenowa właściciela 2026-11-02:** WERYFIKACJA = **615 zł brutto za 60 CV**
(wcześniej strona podawała 899 zł, a demo kalkulatora 615 zł przy 50 CV — rozbieżność usunięta).
ASSESSMENT CENTER = **1 499 zł brutto za 50 CV**, proces dla 5–6 osób, maksymalnie 10 (zastępuje
ilustracyjne 1 799 zł ze strony i 1 845 zł z demo). Wyprowadzenie wszystkich czterech cen:
[docs/cennik-2026-11-02.md](cennik-2026-11-02.md) — jedyne źródło prawdy do czasu wdrożenia
katalogu w SC-PRICING-W2.

**Stan wejściowy:** kalkulator istnieje i działa — `app/operator/pricing/`,
`lib/pricing/internal-calculator.ts`, `lib/pricing/quote-engine.ts`. Zna wszystkie cztery kody
pakietów (`FREE`, `PRESELEKCJA`, `WERYFIKACJA`, `ASSESSMENT_CENTER`), w przeciwieństwie do warstwy
rozliczeniowej, która zna tylko dwa. Dostęp ma wyłącznie właściciel przez `PRICING_OWNER_EMAILS`.
Nie jest połączony z cennikiem publicznym.

## SC-PRICING-W1 — Audyt kalkulatora i katalogu cen

- **LEVEL:** L2 · **SCOPE:** BACKEND · **OWNER:** Claude (builder) · **REVIEWER:** niezależna sesja Claude
- **DEPENDS ON:** — · **Szacunek:** 1 dzień

Zestawienie: co kalkulator dziś liczy, jakie opcje zna, które z nich mają cenę powyżej zera i które
z nich miałyby być konfigurowalne przez klienta. Porównanie z `db/isolated/sc-pricing-catalog.sql`
i z cenami zapisanymi na sztywno w `package-comparison.tsx`. Wynik: jedna tabela rozbieżności.
Bez zmian w cenach.

**Acceptance criteria:** 1) tabela wymienia każdą rozbieżność między kalkulatorem, stroną,
demem i `docs/cennik-2026-11-02.md`; 2) żadna cena nie zostaje zmieniona w tym zadaniu.
**Required tests:** typecheck, build (zmiana dokumentacyjna).
**Security / privacy checks:** dokument nie zawiera adresów właścicieli cennika z `PRICING_OWNER_EMAILS`.

## SC-PRICING-W2 — Katalog cen jako jedno źródło prawdy

- **LEVEL:** L3 (migracja, ceny) · **SCOPE:** BACKEND · **OWNER:** Claude (builder) · **REVIEWER:** niezależna sesja Claude
- **DEPENDS ON:** SC-PRICING-W1 · **Szacunek:** 2–3 dni

Wdrożenie katalogu cen z `db/isolated/sc-pricing-catalog.sql` do `supabase/migrations/`, tak aby
kalkulator i strona czytały te same liczby. Ceny wejściowe = dokładnie te, które są dziś na stronie.
**Migracja nie zmienia żadnej ceny** — przenosi je z kodu do bazy.

**Acceptance criteria:** 1) ceny po migracji są identyczne co do grosza z `docs/cennik-2026-11-02.md`;
2) strona i kalkulator czytają z katalogu, nie z własnych stałych; 3) rollback odtwarza stan sprzed
migracji; 4) brak katalogu lub błąd odczytu nie pokazuje ceny zmyślonej ani `NaN`, tylko komunikat.
**Required tests:** typecheck, build, test migracji, test porównania katalogu z dokumentem cennika.
**Security / privacy checks:** odczyt katalogu publiczny i wyłącznie do odczytu; zapis tylko dla
właściciela cennika; RLS włączone; brak `service_role` po stronie klienta.

## SC-PRICING-W2b — Suwak wolumenu przy każdym pakiecie

**Decyzja właściciela 2026-11-02.** Przy każdym pakiecie klient ma móc zwiększyć pulę CV
suwakiem **co 5**, albo wpisać liczbę ręcznie — też wyłącznie wielokrotność 5.

- **LEVEL:** L2 · **SCOPE:** FRONTEND · **OWNER:** Claude (builder) · **REVIEWER:** niezależna sesja Claude
- **DEPENDS ON:** SC-PRICING-W2 · **Szacunek:** 1–2 dni

### Wzorzec już istnieje — nie piszemy od zera
`public/kalkulator-demo.html` ma dokładnie taki suwak: `#volumeSlider`, `min=35 max=150 step=5`,
z przyciskami minus/plus, opisem dla czytników ekranu (`aria-valuetext`) i paskiem postępu.
Przenosimy ten wzorzec do właściwej strony oferty, zamiast wymyślać nowy.

### In scope
- Suwak przy każdym pakiecie płatnym, krok 5.
- Pole do wpisania liczby ręcznie, z korektą do najbliższej wielokrotności 5 i czytelnym
  komunikatem, co zostało skorygowane (demo ma już ten mechanizm dla pól liczbowych).
- Cena przelicza się na żywo z katalogu z SC-PRICING-W2, nigdy z liczb wpisanych w komponencie.
- Dolna i górna granica puli brane z katalogu, nie z kodu.

### Acceptance criteria
1. Wpisanie 63 ręcznie daje 60 lub 65, z komunikatem o korekcie — nigdy 63.
2. Wpisanie liczby spoza zakresu, tekstu albo pustego pola nie wywraca ceny ani nie pokazuje `NaN`.
3. Suwak i pole ręczne zawsze pokazują tę samą wartość.
4. Obsługa z klawiatury i czytnika ekranu działa (strzałki zmieniają o 5).
### Required tests
typecheck, build, test jednostkowy walidacji puli CV dla **wszystkich trzech pakietów płatnych**
(PRESELEKCJA, WERYFIKACJA, ASSESSMENT CENTER): wielokrotność 5 w zakresie katalogu przyjęta,
wartość spoza kroku skorygowana, wartość spoza zakresu, tekst i puste pole odrzucone bez `NaN`;
test zgodności suwaka i pola ręcznego; test odczytu granic z katalogu, nie ze stałych w kodzie.
Punkt wyjścia: `tests/pricing-cv-pool.test.mjs`, który pokrywa już ten kontrakt w demie.

### Security / privacy checks
Cena nigdy nie pochodzi z pola formularza ani z parametru URL — zawsze z przeliczenia na podstawie
katalogu; walidacja puli CV powtórzona po stronie serwera przy składaniu zapytania ofertowego;
wartość spoza zakresu nie powoduje zapytania do bazy o nieistniejący wariant cennika.

---

## SC-PRICING-W3 — Konfiguracja opcji płatnych przez klienta

- **LEVEL:** L2 · **SCOPE:** FULLSTACK · **OWNER:** Claude (builder) · **REVIEWER:** niezależna sesja Claude
- **DEPENDS ON:** SC-PRICING-W2 · **Szacunek:** 1–2 dni

Opcje wycenione powyżej zera stają się wyborem klienta w ofercie, zgodnie z kierunkiem wskazanym
przez właściciela 2026-11-01. Za flagą, domyślnie wyłączone.

**Acceptance criteria:** 1) przy fladze wyłączonej strona wygląda i liczy dokładnie jak dziś;
2) opcja o cenie zero nie jest pokazywana jako płatna; 3) suma opcji zgadza się z katalogiem.
**Required tests:** typecheck, build, test wyliczenia sumy opcji, test stanu z flagą wyłączoną.
**Security / privacy checks:** wybór opcji przez klienta nie zmienia ceny po stronie serwera bez
ponownego przeliczenia z katalogu — cena nigdy nie pochodzi z pola formularza.

## SC-PRICING-W4 — Spięcie z cennikiem publicznym

- **LEVEL:** L3 (ceny widoczne dla klienta) · **SCOPE:** FULLSTACK
- **OWNER:** Claude (builder) · **REVIEWER:** niezależna sesja Claude
- **DEPENDS ON:** SC-PRICING-W3 · **Szacunek:** 1 dzień

Strona przestaje mieć ceny w kodzie i czyta je z katalogu.

**Acceptance criteria:** 1) w `package-comparison.tsx` i w demie nie ma żadnej ceny wpisanej
na sztywno; 2) zmiana ceny w katalogu zmienia stronę bez wdrożenia kodu; 3) flaga domyślnie
wyłączona, a przy wyłączonej strona pokazuje ceny dotychczasowe.
**Required tests:** typecheck, build, test braku cen w kodzie, test odczytu z katalogu.
**Security / privacy checks:** włączenie flagi zmienia ceny widoczne dla klienta, więc jest
decyzją właściciela, nie merge'em; katalog tylko do odczytu dla ról publicznych.

> **To zadanie kończy się decyzją właściciela, nie merge'em.** Od chwili włączenia każda zmiana
> w kalkulatorze zmienia to, co widzi klient na stronie. Zgodnie z `CLAUDE.md` zmiany cen i pakietów
> są decyzją właściciela, więc W4 wchodzi za flagą wyłączoną, a włączenie flagi to osobne
> pytanie TAK/NIE z pokazaniem dokładnych liczb przed i po.

---

# Podsumowanie pracy

| Moduł | Zadania | Dni |
|---|---|---|
| A — test kompetencji | SC-014-C1…C6 + reguła R1 | 17–26 |
| C — rozszerzony raport | SC-015-A…D | 6–9 |
| D — kalkulator i cennik | SC-PRICING-W1…W4 | 4–7 |
| **Razem** | **14 zadań** | **27–42** |
| Rezerwa na review, poprawki i testy regresji (ok. 20%) | | 5–8 |
| **Suma realistyczna** | | **32–50 dni roboczych** |

Przy dotychczasowym tempie projektu to **2–2,5 miesiąca**.

**Pierwszy kamień milowy (A + C, 23–35 dni):** działający test kompetencji dla kandydata
i rozszerzony raport. To jest moment, w którym jest co pokazać klientowi.

Moduł D nie zależy od A, B ani C i może wejść pomiędzy nie, gdy coś innego czeka na review.

---

# Decyzje właściciela — potrzebne przed startem

Decyzja D3 (koszt modelu AI dla chatbota) odpadła wraz z wykreśleniem modułu B.

## D1 — Limiter brokera: Postgres czy Redis?

Broker testu wymaga ograniczania liczby żądań. Redis REST (Upstash) to nowy, stały koszt
rzędu kilkudziesięciu złotych miesięcznie. Wariant postgresowy nie kosztuje nic, jest wolniejszy,
ale przy braku klientów i przy skali testów to bez znaczenia.

**Rekomendacja: Postgres.** Uzasadnienie: nie ma jeszcze ruchu, który uzasadniałby nowy abonament,
a przejście na Redis później to jedna wymiana adaptera, bo interfejs `SharedRateLimiter` już istnieje.

**TAK = Postgres (rekomendowane) / NIE = Redis Upstash**

## D2 — Jak nazwać i wycenić produkt, który z tego powstanie? — **ROZSTRZYGNIĘTE 2026-11-02**

**Decyzja właściciela (rozmowa głosowa, 2026-11-02): przedefiniowanie WERYFIKACJI.**
Pakiet powstały z A + C (preselekcja CV + test kompetencji + rozszerzony raport) sprzedajemy jako
**WERYFIKACJA za 615 zł brutto za 60 CV, bez rozmów z botem**. Rozmowy zostają na stronie oznaczone
jako „w przygotowaniu” do czasu, aż zaczną działać, i są dopisywane później jako rozszerzenie
pakietu, bez zmiany ceny. Nowy pakiet pośredni nie powstaje.

Pytanie było postawione przy cenie 899 zł i przy założeniu, że WERYFIKACJA obowiązkowo zawiera
rozmowy. Oba założenia są nieaktualne: cena to 615 zł (sekcja „Decyzja cenowa” w MODULE D powyżej),
a właściciel zdecydował, że pakiety ruszają bez rozmów. Przy 615 zł za 60 CV zakres bez rozmów ma
pokrycie w cenie — wyprowadzenie w [docs/cennik-2026-11-02.md](cennik-2026-11-02.md).

**Ta decyzja nie jest już bramką.** Zadanie rozliczeniowe po module C realizuje się wprost na
WERYFIKACJI 615 zł / 60 CV; żadne zadanie nie czeka na D2. Jedyny warunek postawiony przez
właściciela: opis pakietu nie może obiecywać rozmów, dopóki one nie działają.

> D1 jest nadal potrzebna przy SC-014-C2, czyli w drugim tygodniu.

---

# Zasady obowiązujące całą budowę

Powtórzone z `AGENTS.md` i `docs/DEFINITION_OF_DONE.md`, bo dotyczą każdego z 15 zadań:

- Branche zadaniowe wychodzą z `integration`, PR celuje w `integration`. Nigdy w `main`.
- Każde L3 wymaga niezależnego review (osobna sesja Claude z czystym kontekstem) z werdyktem PASS
  dla aktualnego commita przed merge.
- Migracje nie są uruchamiane na produkcji z sesji agenta. Tylko `skillcheck-preview`.
- Żaden z tych modułów nie kontaktuje się z rzeczywistym kandydatem.
- Żadna funkcja AI nie podejmuje decyzji o zatrudnieniu i każda zostawia dowody do wglądu człowieka.
- Nie pokazujemy w interfejsie funkcji, która nie działa.
- Właściciel jest pytany wyłącznie o: production approval, nowe koszty i działania nieodwracalne.

---

*Plan przygotowany 2026-11-02 na podstawie audytu z tego samego dnia. Nie wprowadza zmian w kodzie ani bazie.*
