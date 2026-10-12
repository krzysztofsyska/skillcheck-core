# SC-014-B1 — architektura prób testu kompetencji (bez wdrożenia)

**TASK** SC-014 · **LEVEL** L3 · **SCOPE** BACKEND / bezpieczeństwo danych · **STATUS** ARCHITECTURE_REVIEW  
**BASE** latest integration (2026-10-12) · **DEPENDS ON** SC-014-A (PR #107), SC-008, SC-010 R3/R4/R5  
**Autor komponentu** ChatGPT/Orchestrator → Cursor/Builder; **niezależny reviewer** Codex

## 1. Cel i stan istniejący

Kandydat ma zobaczyć *konkretną, niezmienną* wersję testu, rozpocząć próbę i przesłać jedną odpowiedź. Firma może ocenić odpowiedź na podstawie zachowań w niezmiennej rubryce z dowodami i udziałem człowieka. SC-014-A definiuje czysty walidator i ocenę (PR #107). W `integration` istnieją tabele `exercise_definition_entries`, `exercise_observation_entries`, `applications`, `recruitments`, `positions`, `candidates`. Nie zmieniać znaczenia istniejących `exercise_observation_entries`: są to wpisy **rekrutera**, nie potwierdzone próby wprowadzane przez kandydata.

**Nie implementować przypadkiem**: publicznego otwartego formularza bez autoryzacji, zaproszeń e-mail/SMS, kontaktu z rzeczywistymi kandydatami, AI scoringu, automatycznych decyzji hire/reject ani migracji na docelowej bazie.

## 2. Model danych do review (nie migracja)

Wszystkie nowe obiekty wymagają **nowej** migracji. Nie edytować zastosowanych wcześniej migracji. Każdy rekord kandydata zawiera company_id, candidate_id, recruitment_id, application_id oraz immutable definition_entry_id, ze złożonymi FK gwarantującymi spójność tenantów.

### `private.competency_test_grants`
- id UUID PK; company_id, candidate_id, recruitment_id, application_id, definition_entry_id UUID NOT NULL; token_digest bytea UNIQUE NOT NULL (SHA-256 tokena z 256 bitów CSPRNG); secret nigdy nie trafia do trwałego zapisu/logów.
- start_by_at timestamptz NOT NULL oznacza **ostatni moment uruchomienia**, nie ostateczny deadline już rozpoczętej próby. created_by/created_at, revoked_by/revoked_at, revision bigint oraz purpose-scoped issuance_request_key/audit.
- Złożony FK `(company_id,recruitment_id,candidate_id,application_id)` → applications; FK `(company_id,recruitment_id,definition_entry_id)` → exercise_definition_entries. Najwyżej jeden aktywny grant per application/revision, serializowany candidate → application → grant, nie wyłącznie read-then-write.
- **Utracony sekret**: retry z tym samym issuance_request_key zwraca stabilny grant_id + status `secret_unavailable_rotate_required`, nigdy nie zgaduje i nie odtwarza sekretu. `rotate_grant_secret(grant_id,expected_revision,new_request_key)` transakcyjnie zastępuje digest świeżym losowym tokenem, natychmiast unieważnia stary token i zwraca **nowy token raz**. Ponowienie po utraconej odpowiedzi rotacji odbywa się przez kolejną jawnie wersjonowaną rotację po sprawdzeniu statusu, bez przechowywania plaintext. Zawsze co najwyżej jeden aktualnie ważny sekret; pełna historia rotation/revocation audytowana (bez secretu). Jeśli pierwszy token już dotarł do kandydata, rotacja go unieważnia — doręczenie nowego wymaga świadomego działania rekrutera.
- Rozważyć `private.competency_test_grant_events`: grant/rotation/revocation, actor, revision, timestamps, bez sekretów lub IP; pełna retencja SC-010.

### `public.competency_test_attempts`
- id UUID PK; grant_id UUID UNIQUE NOT NULL; company_id, candidate_id, recruitment_id, application_id, definition_entry_id zgodne z grantem i aplikacją.
- state = in_progress | submitted; started_at, deadline_at, submitted_at generowane w DB; work_sample <=20 000 znaków tylko po submit; immutable submission_digest; unikalność grant_id.
- `deadline_at = started_at + durationMinutes z niezmiennej rubryki` — pełny czas niezależnie od upływu start_by_at. Nie wolno rozpoczynać po start_by_at. Nie wydłużać deadline po rozpoczęciu.
- `competency_test_review_entries`: osobna append-only tabela recenzenta (attempt_id, company_id, candidate_id, definition_entry_id, reviewer_id, policy_version, observations, coverage, nullable score, version, created_at). Brak automatycznego hire/reject i brak zmiany historycznych odpowiedzi.

Dokładne FK, funkcje, unikalne indeksy, typy i RLS są przedmiotem dalszej fazy **izolowanego PostgreSQL prototype** po security review; samo niniejsze opracowanie nie uruchamia żadnego SQL.

## 3. Model autoryzacji i ochrony przeciw nadużyciom

1. **Firmowy issuer / reviewer**: tylko owner/recruiter aktualnej firmy przez auth user RLS i jawne funkcje z access check, wyłącznie dla zgodnego aktywnego zgłoszenia i immutable rubryki `competency_test`; viewer/outsider nie mogą wydawać, rotować, cofać ani oceniać. Żadnych pól actor/company z requestu jako source of truth.
2. **Gateway kandydata NIE jest publicznym anon RPC**. Funkcje tokenowe wyłącznie w schemacie niewystawionym przez Supabase Data API, bez `EXECUTE` dla `anon` i `authenticated`. Dostęp tylko dla nowej dedykowanej roli Postgres `competency_test_gateway` o minimalnych uprawnieniach, przez serwerowy broker Next/Edge z tajnym oddzielnym poświadczeniem, **nie service_role**. W B2 zbadać istniejący model puli połączeń, rotację sekretów i granty roli. Jeśli bezpieczna rola/transport nie mogą powstać bez dodatkowego kosztu albo konfiguracji — STOP; nie wystawiać anon fallback.
3. **Rate limit przy jedynym osiągalnym wejściu**: POST-only broker, restrykcja request body 128 KiB, limit token length/form/headers przed DB, ograniczenie ilości prób (IP/network + token digest bucket), generic errors, backpressure i budżet połączeń. DB dodatkowo waliduje długości i stan/grant; żaden zewnętrzny klient nie może ominąć brokera wywołując RPC Supabase z publishable key. Bez logowania tokena, body ani danych kandydata.
4. **Bootstrap linku**: kandydat otrzymuje sekret w `#fragment` URL, ale fragment jest obecny w pasku/historii i JS. Przed hydracją, telemetry i jakimkolwiek SDK, minimalny first-party script odczytuje token do pamięci i natychmiast wywołuje `history.replaceState(null, '', location.pathname)`. Strona bez third-party scripts/analytics; CSP restrykcyjne, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, brak localStorage, sessionStorage, cookies zawierających sekret, session replay i crash reporting payload. Linki skopiowane przed scrub nadal ujawnią token; to nie jest kryptograficzna gwarancja poufności, a jego rotacja/revoke musi być dostępna.
5. **Czas i status**: `inspect` przed startem sprawdza start_by_at i revoked; po rozpoczęciu pozwala kontynuować do deadline_at (nawet gdy start_by_at minął), ale nie po revoke lub freeze SC-010. `start` uruchamia timer tylko po jawnym działaniu kandydata. `submit` wymaga poprawnej bieżącej próby, deadline i braku revoke/freeze. `status` po submit może zwrócić **tylko** potwierdzenie atomowego zapisu (id próby i stan bez odpowiedzi, kryteriów lub PII), także po deadline/start_by_at przez krótki, ograniczony czas recovery; po revoke albo usunięciu danych zawsze deny. Maksymalny okres recovery podlega konfiguracji i osobnemu review.
6. **Workflow**: `issue` i `start` sprawdzają application new/in_progress, recruitment draft/open, position nonarchived. Po `start` zwykłe zmiany stanowiska lub zamknięcie rekrutacji nie anulują milcząco rozpoczętej próby. Wycofanie zgody/kandydata i freeze SC-010 muszą mieć **jawny transakcyjny revoke/cancel** z audytem; każdy brak możliwości zagwarantowania atomowego revoke jest blokadą B2. Nie utożsamiać odrzucenia technicznego requestu z odrzuceniem kandydata.
7. Kandydat nie ma tabelowego SELECT/INSERT/UPDATE/DELETE na grants/attempts/reviews/definitions. Dostęp posiadacza capability jest dokładnie ograniczony do jednego grant/attempt, odczyt kandydata nie może ujawniać rubryki, tenantu i danych innych osób.

## 4. Transakcje, kolejność blokad i idempotencja

- **SC-010 first**: odczytaj candidate_id z nieblokującego powiązania application; najpierw `private.erasure_lock_candidate` i blokada kandydata, następnie re-read + lock `application`, następnie grant/attempt. Przy każdej mutacji sprawdź, że candidate/company/recruitment nadal odpowiadają otrzymanej parze. RLS, freeze check i guard triggers obowiązują również grant/attempt/review/events. Nie odwracać kolejności względem usuwania kandydata.
- Czas `clock_timestamp()` pozyskiwany po blokadach. Warunek startu: `now < start_by_at`; deadline startu to `now + exact durationMinutes`, bez obcinania przez start_by_at. Warunek submit: `now < deadline_at`, jednak idempotentny odczyt **już zatwierdzonego** submit i status receipt ma pierwszeństwo przed sprawdzeniem przekroczonego deadline, aby utrata odpowiedzi sieciowej nie ukryła sukcesu.
- Wystawienie grantu: `issuance_request_key` dotyczy niezmiennego payload/actor i daje stabilną tożsamość grant_id, **nie daje odzyskiwalnego plaintext**. Utracony sekret obsługiwany jest przez odrębne CAS rotation (expected_revision) i nowe audytowane doręczenie. Żadnego trwałego zapisu czystego tokena, żadnych dwóch aktywnych digestów, brak ponownego otwarcia submitted attempt.
- `submit`: porównanie `submission_digest` z kanonicznym inputem pod blokadą, powtórny identyczny request → ten sam receipt, różny request → PT409; tekst odpowiedzi niezmienny po submit. Retry po deadline może uzyskać wyłącznie poprzedni receipt, nigdy nowy zapis.
- `revoke` oraz SC-010 freeze serializują się z `inspect/start/submit/status`. Revoke jest trwały i blokuje dalsze operacje tokenem, również status. Ustalenie konfliktu przy równoczesnym submit i revoke odbywa się przez serializację, testować na dwóch połączeniach.

## 5. Kontrakty RPC / API (projekt, bez funkcji)

| Operacja | Uprawnienie | Output / semantyka |
|---|---|---|
| `create_competency_test_grant(application,definition,start_by,request_key)` | owner/recruiter | grant_id + pierwszy token tylko przy pierwszym sukcesie; retry tej samej operacji → grant_id + rotation_required |
| `get_competency_test_grant_status(grant_id)` | owner/recruiter | aktualna revision/state, bez tokena |
| `rotate_competency_test_grant(grant_id,expected_revision,new_request_key)` | owner/recruiter | CAS revokes old digest, returns fresh token once, audit |
| `revoke_competency_test_grant(grant,request_key)` | owner/recruiter | audytowany nieodwracalny revoke |
| `inspect_candidate_competency_test(token)` | *gateway role*, nie anon | tylko candidateTestView + restricted attempt state |
| `start_candidate_competency_test(token,request_key)` | *gateway role* | rozpoczęcie, deadline z server clock |
| `submit_candidate_competency_test(token,answer,request_key)` | *gateway role* | immutable submit + receipt idempotency |
| `status_candidate_competency_test(token)` | *gateway role* | wyłącznie wcześniejsze potwierdzenie submitted w ograniczonym recovery window, bez PII; revoke/freeze deny |
| `save_competency_test_review(attempt,expected_version,observations)` | owner/recruiter | append-only human review po autoryzacji tenant |

Tokenowe RPC muszą być w niewystawionym schemacie, bez EXECUTE dla anon/authenticated, a broker wymaga oddzielnego kredencjału niskiego przywileju. Architektura wymaga jeszcze dowodu konfiguracji i testów przed zatwierdzeniem B2. Żadna funkcja nie została utworzona.

## 6. Bezpieczeństwo danych a SC-010 (bramka bez obejścia)

SC-010 R3/R4/R5 używa stałego podpisu schematu oraz jawnego inwentarza i grafu fizycznego kasowania. Nowe `grants`/`attempts`/`reviews` są danymi rekrutacyjnymi przypiętymi do kandydata (nawet pseudonimizowane identyfikatory, digest tokenu i audit). Ich dodanie **bez** uwzględnienia SC-010 spowoduje drift/blocked erasure — nie wolno wyłączać tego zabezpieczenia.

Przed merge migracji SC-014-B wymagane są: nowa wersja reviewed schema inventory/signature, jawny adapter preview/erasure/purge dla wszystkich trzech tabel i associated events, prawidłowa kolejność FK/triggers, test usunięcia kandydata bez wycieku/grant reuse, poprawne hold/backup/ledger checks. Nie edytować istniejących zastosowanych migracji, nie przepisywać starego podpisu w miejscu. Do czasu kompletnego kontraktu **brak produkcyjnej migracji i brak aktywacji linków**.

## 7. Kryteria akceptacji i testy wymagane

- T1: anonimowy klient Supabase **nie może** wykonać żadnego gateway RPC bezpośrednio; tylko gateway rola ma execute; nietrusted caller nie zna DB cred. Broker ogranicza rozmiar, liczbę prób i nie loguje tokenu.
- T2: owner/recruiter może wystawić/rotować/cofać i oceniać; viewer/outsider/inna firma nie; dwie firmy oraz pomieszane FK muszą zawieść bez ujawnienia danych.
- T3: utracona odpowiedź na issuance daje stabilny grant_id z rotation_required, a recovery CAS rotation przywraca możliwość nowego dostarczenia bez plaintext w DB; w żadnym momencie dwa tokeny nie działają. Test utraconej odpowiedzi na rotację i ponowna jawna rotacja.
- T4: link zawiera `#fragment` wyłącznie przed bootstrap; test natychmiastowego replaceState, braku analytics/third-party scripts, no-store, no-referrer i niewycieknięcia tokenu do historii/logów/referer/cookies/storage.
- T5: dokładny czas trwania 60 minut nawet przy start na minutę przed start_by; po start_by, ale przed deadline, submit dozwolony; dokładnie na deadline nowy submit odrzucony; idempotentny receipt po deadline i w ograniczonym recovery window.
- T6: candidate → application → grant order przeciw SC-010 freeze i purge; dwie konkurencyjne sesje, równoczesne revoke/submit/freeze, brak deadlock/cross-tenant; audit zdarzeń/guard triggers i wersjonowany inventory.
- T7: status po expiry zwraca wyłącznie potwierdzenie już dokonanego submit; po revoked lub SC-010 erasure freeze odmawia; brak możliwości dopisania danych po wygaśnięciu.
- T8: zwykłe przesunięcie application/close recruitment po starcie nie kasuje próby; explicit withdraw/consent revoke/freeze atomowo odwołuje; nie ma automatycznego hire/reject.
- T9: testy real PostgreSQL + PGlite + Auth/RLS/Next HTTP + build/typecheck + SC-010 preview/hold/inventory/erasure/purge/ledger; tylko syntetyczne osoby, bez remote Supabase, bez kontaktów i bez Production.

## 8. Kolejność bramek

1. Zamknąć SC-014-A: exact-head CI i niezależny Codex PASS → OWNER ACCEPTANCE → merge do integration.
2. SC-014-B1: niezależny review architektury po usunięciu uwag P1/P2; wymagane potwierdzenie wyboru dedykowanej gateway role, planu recovery secret/receipt i SC-010 erasure adapter.
3. B2: dopiero po review przygotować izolowaną bazę/nowe migracje i test-only prototype zgodny z obecnymi migracjami SC-010; zero remote `db push`. Odrębne review RLS i grantów przed scaleniem.
4. B3/B4: serwerowy broker i UI testu (zabezpieczona izolacja), testy end-to-end z fikcyjnymi danymi, bez wysyłki zaproszeń.
5. Wdrożenie lub dodatkowe koszty infrastruktury wymagają odrębnej jawnej PRODUCTION APPROVAL; do tego czasu brak zmian na Production.

Otwarte parametry konfigurowalne i **wyłączone do decyzji**: TTL start_by, czas recovery receipt, limit requestów i dystrybucja tokenu. Brak zgody na domyślny publiczny RPC albo automatyczny contact flow.
