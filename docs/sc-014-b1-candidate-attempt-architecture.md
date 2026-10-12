# SC-014-B1 — architektura prób testu kompetencji (bez wdrożenia)

**TASK** SC-014 · **LEVEL** L3 · **SCOPE** BACKEND / bezpieczeństwo danych · **STATUS** ARCHITECTURE_REVIEW  
**BASE** latest integration (2026-10-12) · **DEPENDS ON** SC-014-A (PR #107), SC-008, SC-010 R3/R4/R5  
**Autor komponentu** ChatGPT/Orchestrator → Cursor/Builder; **niezależny reviewer** Codex

## 1. Cel i stan istniejący

Kandydat ma zobaczyć *konkretną, niezmienną* wersję testu, rozpocząć próbę i przesłać jedną odpowiedź. Firma może ocenić odpowiedź na podstawie zachowań w niezmiennej rubryce z dowodami i udziałem człowieka. SC-014-A definiuje czysty walidator i ocenę (PR #107). W \`integration\` istnieją tabele \`exercise_definition_entries\`, \`exercise_observation_entries\`, \`applications\`, \`recruitments\`, \`positions\`, \`candidates\`. Nie zmieniać znaczenia istniejących \`exercise_observation_entries\`: są to wpisy **rekrutera**, nie potwierdzone próby wprowadzane przez kandydata.

**Nie implementować przypadkiem**: publicznego otwartego formularza bez autoryzacji, zaproszeń e-mail/SMS, kontaktu z rzeczywistymi kandydatami, AI scoringu, automatycznych decyzji hire/reject ani migracji na docelowej bazie.

## 2. Kontrakt danych — propozycja do zatwierdzenia

Nowe, **wersjonowane**, nigdy nieedytujące istniejących migracji obiekty (nazwy robocze):

### \`private.competency_test_grants\`

- \`id uuid PK\`; \`company_id\`, \`recruitment_id\`, \`application_id\`, \`definition_entry_id\` (wszystkie NOT NULL).
- \`token_digest bytea\` UNIQUE (SHA-256 z kryptograficznie losowych 256 bitów tokena; pełny token nigdy nie trafia do bazy ani logów). Indeks UNIQUE.
- \`created_by uuid\`, \`created_at timestamptz\`, \`expires_at timestamptz\`, \`revoked_at timestamptz NULL\`, \`revoked_by uuid NULL\`.
- Przydział tylko jednej ważnej próby danej wersji per application (uwzględnić historyczne odwołane/wygasłe granty). Konflikty rozwiązywać transakcyjnie przez blokadę application + zdefiniowaną regułę aktywności, nie przez skąpe zapytanie read-then-write.
- Composite FK \`(company_id,recruitment_id,application_id)\` → \`public.applications\`; \`(company_id,recruitment_id,definition_entry_id)\` → \`public.exercise_definition_entries\`; \`created_by\` → \`auth.users\`. Unieważnianie tokena nie może usuwać dowodów historii.

### \`public.competency_test_attempts\`

- \`id uuid PK\`, \`grant_id uuid UNIQUE NOT NULL\`, \`company_id\`, \`recruitment_id\`, \`application_id\`, \`definition_entry_id\`.
- \`state\`: \`in_progress | submitted\`; brak mutable \`expired\` jako zapisanej prawdy (wygaśnięcie wyliczane z czasu serwera, uprawnienia i grant status).
- \`started_at\`, \`deadline_at\`, \`submitted_at NULL\` — wyłącznie ustawiane w bazie; \`work_sample text NULL\` maks. 20 000 znaków, niepuste wyłącznie po submit.
- \`submission_digest bytea NULL\` w celu idempotencji i dowodu niezmienności; po \`submitted\` nie wolno aktualizować tekstu ani wersji rubryki.
- \`UNIQUE(grant_id)\`; złożone FK i kontrola zgodności grant/application/definition, nie polegać na UUID jako autoryzacji.
- W przyszłym review oddzielna append-only tabela \`competency_test_review_entries\` zawierająca \`attempt_id\`, \`company_id\`, \`definition_entry_id\`, \`reviewer_id\`, \`policy_version\`, \`observations\`, \`coverage\`, \`score nullable\`, \`review_version\`, \`created_at\`. Oceny z aktualnej rubryki zawsze związane z niezmienną odpowiedzią i wersją kryteriów; brak automatycznego zapisu wyniku przy samym submit.

**Weryfikacja przed implementacją**: sprawdzić istniejące unikalne klucze FK, rolę auth, zależności \`private.has_company_access\` i obecny diagram kasowania SC-010. Dokładne DDL jest przedmiotem review, nie skuteczną migracją.

## 3. Granica autoryzacji

1. Firma: tylko owner/recruiter z bieżącą rolą i aktywnym zgłoszeniem może wydać/odwołać grant; viewer nie może. Tenant ID i autor pochodzą z serwera. Brak \`service_role\` w kodzie aplikacji.
2. Kandydat: na stronie link zawiera token wyłącznie w **URL fragment** (\`#token\`), aby nie trafiał do request path, query, Referer, analityki, CDN ani logów. JavaScript przekazuje go żądaniem POST przez ograniczony endpoint. Brak automatycznych kontaktów; wydanie tokena i doręczenie to osobne operacje ze zgodami.
3. Token: 32 bajty z kryptograficznego generatora, Base64url; wyłącznie digest w DB. Nie zdradzać szczegółów przy błędnym/wygasłym tokenie; rate limiting na Next/backend, maks. rozmiar body 128 KiB, bez zapisów tokena w logach. Dla tokena 256-bit brute-force jest niepraktyczny, ale nadużycia/DoS nadal wymagają limitowania.
4. Operacje \`inspect\`, \`start\`, \`submit\` są oddzielne. Tylko \`start\` uruchamia odliczanie; nie rozpoczynać próby przy otwarciu wiadomości lub podglądzie. \`inspect\` zwraca jedynie \`candidateTestView\` bez anchorów rubryki, danych firmy, ocen innych kandydatów i PII.
5. Kandydat nie ma dostępu przez SELECT do grantów, attemptów ani definicji: dla anon oraz roli klienta deny-by-default / brak bezpośredniego GRANT. Precyzyjnie audytowane RPC z \`SECURITY DEFINER SET search_path=''\`, minimalnym \`EXECUTE\` i ręcznym token check są jedyną drogą. Użytkownik firmowy czyta próbę tylko przez company RLS. Przed wyborem \`anon\` lub \`authenticated\` execute dokładnie zbadać zagrożenia mechanizmu token auth.
6. Sprawdzić przy **każdej** operacji czy grant nadal ważny, nie odwołany, przypisany do tej wersji i zgłoszenia; czy zgłoszenie \`new\`/\`in_progress\`, rekrutacja \`draft\`/\`open\`, stanowisko nie \`archived\`, definicja \`competency_test\`. Nie sugerować automatycznego odrzucenia kandydata przy odmowie dostępu.

## 4. Transakcje i współbieżność

- Wszystkie zapisy serializować na parze application + grant w ustalonej kolejności blokad (\`FOR UPDATE\` / transakcyjna blokada); testować dwa niezależne połączenia w rzeczywistym PostgreSQL.
- Serwer po pozyskaniu blokady pobiera \`clock_timestamp()\` (nie \`Date.now()\`/czas z klienta). Limit sesji = \`min(grant.expires_at, started_at + definition.durationMinutes)\`. Granice \`now < deadline\` jednoznaczne; wysłanie dokładnie w \`deadline\` odrzucone.
- \`submit\` waliduje tekst 1–20 000, fingerprint odpowiedzi i zapis atomowy. Powtórny identyczny submit z tym samym grantem zwraca tę samą odpowiedź bez modyfikacji; powtórny *różny* submit = PT409. Po \`submitted\` brak aktualizacji \`work_sample\`.
- \`revoke\` blokuje kolejne \`inspect/start/submit\` w tej samej transakcji. Nie można ponownie wykorzystać dawnego tokena do nowego assignment. Zmiana profilu stanowiska/nowa definicja nie przelicza historii próby.
- Dla awarii sieci wynik może być niejednoznaczny; wymagany read-only status umożliwiający bezpieczne sprawdzenie, czy serwer zatwierdził submit.

## 5. Minimalne RPC (projekt, nie utworzone funkcje)

| Wywołanie | Kto | Zwraca | Zapisy |
|---|---|---|---|
| \`create_competency_test_grant(application,definition,ttl,request_key)\` | owner/recruiter | jednorazowy sekret + grant ID | grant, audit |
| \`revoke_competency_test_grant(grant,request_key)\` | owner/recruiter | stan i wersja | revoke, audit |
| \`inspect_candidate_competency_test(secret)\` | uprawniony posiadacz tokena | bezpieczny DTO + status | brak |
| \`start_candidate_competency_test(secret,request_key)\` | uprawniony posiadacz tokena | attempt ID + deadline | start raz |
| \`submit_candidate_competency_test(secret,answer,request_key)\` | uprawniony posiadacz tokena | attempt ID + status | atomowy submit |
| \`save_competency_test_review(attempt,expected_version,observations)\` | owner/recruiter | nowy review ID | append-only review |

**Istotne**: kontrakt zwracania jednorazowego sekretu i czy ratelimit działa przed RPC musi przejść niezależny security review. Nie wystawiać na Production przed ukończeniem testów realnego Auth, rotacji/cancellation i retencji.

## 6. Bezpieczeństwo danych a SC-010 (bramka bez obejścia)

SC-010 R3/R4/R5 używa stałego podpisu schematu oraz jawnego inwentarza i grafu fizycznego kasowania. Nowe \`grants\`/\`attempts\`/\`reviews\` są danymi rekrutacyjnymi przypiętymi do kandydata (nawet pseudonimizowane identyfikatory, digest tokenu i audit). Ich dodanie **bez** uwzględnienia SC-010 spowoduje drift/blocked erasure — nie wolno wyłączać tego zabezpieczenia.

Przed merge migracji SC-014-B wymagane są: nowa wersja reviewed schema inventory/signature, jawny adapter preview/erasure/purge dla wszystkich trzech tabel i associated events, prawidłowa kolejność FK/triggers, test usunięcia kandydata bez wycieku/grant reuse, poprawne hold/backup/ledger checks. Nie edytować istniejących zastosowanych migracji, nie przepisywać starego podpisu w miejscu. Do czasu kompletnego kontraktu **brak produkcyjnej migracji i brak aktuwacji linków**.

## 7. Kryteria odbioru i plan testów

- T1: kandydat widzi tylko DTO właściwej immutable revision, bez rubryki/PII; token drugiej firmy nie dostaje niczego.
- T2: owner/recruiter prawidłowa rola; viewer/outsider/anon próba utworzenia lub oceny grant = denied; bez direct DML/grants; dwie firmy.
- T3: token zły/powtórzony/cofnięty/wygasły; idempotentny wydawca; brak tokena w DB/logach; POST limit; bez dostępu z URL query.
- T4: start dokładnie raz i *po kliknięciu*, timeout serwerowy, koniec czasu przy równości, synchronizacja dwóch połączeń, replay tej samej próby i różnej odpowiedzi, brak oceny po starym modelu.
- T5: odpowiedź spełnia poprawki SC-014-A; scoring only evidence, \`insufficient_data\` != zero; ocena zawsze z człowiekiem; immutable history.
- T6: pełne testy Postgres/PGlite, typy, Next build, HTTP/authorization, CI, review L3.
- T7: SC-010 erasure inventory, preview, graph, dynamic schema drift, retention + request/hold/ledger; test przy rzeczywistym nowym wierszu.
- T8: brak kontaktu z prawdziwym kandydatem; bez Production/remote Supabase; smoke Preview dopiero po zatwierdzeniu architektury, kodu i odrębnej aktywacji.

## 8. Kolejność i open questions

1. Zamknąć SC-014-A: CI PASS + niezależny Codex Review PASS + OWNER ACCEPTANCE → merge do \`integration\`.
2. Ten PR B1: niezależny **architecture/security review** i wybór finalnej topologii token/RPC oraz reguły ponowienia próby.
3. B2: wyłącznie w izolowanym testowym Postgres utworzyć kompletne DDL i testy (bez remote \`db push\`), razem ze zaktualizowaną kontrolą SC-010.
4. B3: warstwa backend, bez publicznego zapraszania; B4: UI + testy e2e syntetyczne; osobny akceptacyjny merge.
5. Odrębna PRODUCTION APPROVAL dopiero po przeglądzie, gdy dostępne są wymagane infrastruktura/retencja.

Otwarte decyzje do rozstrzygnięcia review (bez arbitralnej aktywacji): maksymalny TTL/ponowienie próby, sposób doręczenia jednorazowego sekretu, audyt wypadków utraty tokena, czy \`inspect\` ma pokazywać instrukcję przed startem, maksymalny limit żądań. Wszystkie bezpiecznie domyślnie zablokowane do rozstrzygnięcia.
