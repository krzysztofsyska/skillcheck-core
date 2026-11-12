# SC-AC-SESSION (#276) — sesja Assessment Center

LEVEL L3 · SCOPE FULLSTACK · zależy od #271 / #272 (SC-AC-001, R13). Kontrakt pary arkuszy: [sc-ac-001-contract.md](sc-ac-001-contract.md).

Zakres: sesja AC dla rekrutacji z planem pokrycia kompetencji, finaliści z krótkiej listy (zalecane 5–6, najwyżej 10), wieloetapowe studium przypadku i symulacja z człowiekiem, dwie niezależne oceny na etap, uzgodnienie albo jawna rozbieżność, druga próba z odrębnym dowodem zmiany, raport sesji z notatkami z konsultacji eksperta. Wszystko na istniejącym silniku par z R13 — nie powstał drugi silnik ocen. Nie ma wyniku łącznego, rankingu ani automatycznej decyzji o zatrudnieniu; raport pokazuje dowody dla człowieka.

Nic nie jest włączane na produkcji: migracja trafia do `integration` i na bazę Preview (dane testowe), a interfejs jest widoczny tylko przy `AC_PAIRED_SHEETS_PREVIEW=true` w Preview/development (ta sama flaga co arkusze par).

## Model danych

Migracja `supabase/migrations/20261112120000_sc_ac_session_inventory_r16.sql` jest generowana przez `scripts/sc-ac-session-compose.mjs` z `db/components/sc-ac-session.sql`. Wszystkie tabele są w schemacie `private`, mają RLS bez polityk dla ról API i są dostępne wyłącznie przez RPC.

| Tabela | Rola | Powiązanie z kandydatem |
| --- | --- | --- |
| `private.ac_sessions` | Jedna sesja na rekrutację: tytuł, planowane kompetencje, status `draft → open → closed`. | nie (konfiguracja) |
| `private.ac_session_stages` | Uporządkowane etapy (1–8): `case_study` albo `human_simulation`, każdy przypięty do dokładnej, niezmiennej rewizji ćwiczenia AC. | nie (konfiguracja) |
| `private.ac_session_finalists` | Finalista = zgłoszenie z aktywnej krótkiej listy; `slot` 1–10. | tak |
| `private.ac_reconciliations` | Uzgodnienie jednej pary arkuszy: na kryterium uzgodniona ocena albo jawna rozbieżność; odpowiedź drugiego asesora. | tak |
| `private.ac_session_entries` | Dziennik tylko do dopisywania: pierwsza próba, informacja zwrotna, poprawiona praca, dowód zmiany, notatki eksperta. | tak |

### Decyzje projektowe

- **Rewizja ćwiczenia jest przypięta do etapu, nie do całej sesji.** Para z R13 jest unikalna dla `(zgłoszenie, rewizja)` i waliduje arkusz względem kryteriów tej rewizji. Osobna rewizja na etap daje osobną parę na etap bez zmiany `ac_paired_sheets`. Każdy etap ma więc własną, dokładną i niezmienną rubrykę.
- **Plan pokrycia wynika z rubryk.** Etap pokrywa te kompetencje, które są kryteriami jego ćwiczenia. Sesji nie da się otworzyć, gdy planowana kompetencja nie ma etapu — sprawdza to trigger tabeli `ac_sessions`, więc reguła obowiązuje także poza RPC. Nazwy porównywane są dokładnie po normalizacji NFKC i spacji (bez zmiany wielkości liter, która zależy od ustawień bazy).
- **Limit 10 jest ograniczeniem tabeli**: `slot between 1 and 10` + `unique(session_id, slot)`. Zalecenie 5–6 jest tylko komunikatem (`finalistAdvice` w `lib/assessment-center-session.ts`) i niczego nie blokuje.
- **Reguła R1** (finalista tylko z krótkiej listy) jest sprawdzana w RPC z blokadą wiersza krótkiej listy i drugi raz w triggerze tabeli finalistów. Każdy późniejszy zapis sesji dla finalisty ponownie wymaga aktywnego wpisu na krótkiej liście.
- **Uzgodniona ocena musi być jedną z dwóch oddanych ocen.** Nie da się zapisać wartości „pośrodku” (np. „zgodne” z „poniżej” i „powyżej”) — to byłoby uśrednienie. Przy różnych ocenach można zapisać rozbieżność; baza sama dopisuje obie oceny z arkuszy.
- **Uzgodnienie zapisuje jeden asesor, a drugi odpowiada raz**: potwierdza albo kwestionuje (z uzasadnieniem). Zapis zakwestionowany nigdy nie jest pokazywany jako uzgodnienie — w raporcie zostają obie oceny. Zapis wskazuje, kto go zrobił i kto odpowiedział; nie da się go zmienić ani usunąć.
- **Druga próba to cztery osobne zapisy** w ustalonej kolejności: pierwsza próba → informacja zwrotna (asesor, dopiero po oddaniu obu arkuszy) → poprawiona praca → dowód zmiany (asesor: co się zmieniło, dowód, ocena dowodu). Każdy rodzaj zapisu jest jeden na finalistę i etap; pierwszej próby nie da się nadpisać.
- **Jedna sesja na rekrutację.** Po otwarciu plan i etapy są zamrożone; po zamknięciu raport zostaje, zapisy sesji są odrzucane.
- Kolumna dziennika nazywa się `session_stage_id`, bo wspólny strażnik wierszy rezerwuje klucz `stage_id` dla `public.assessment_stages`.

## RPC

Wszystkie funkcje są `SECURITY DEFINER` z pustym `search_path`, mają `EXECUTE` tylko dla `authenticated` i same sprawdzają firmę oraz rolę.

| RPC | Kto | Kontrakt |
| --- | --- | --- |
| `ac_session_create(recruitment, session_title, competencies)` | właściciel | Szkic sesji; 1–24 różne kompetencje; druga sesja dla tej samej rekrutacji → `PT409`. |
| `ac_session_add_stage(session, kind, stage_title, revision, counterpart)` | właściciel | Tylko w szkicu; rewizja AC tej rekrutacji; opis roli człowieka wymagany dla symulacji. |
| `ac_session_remove_last_stage(session)` | właściciel | Tylko w szkicu: cofa ostatnio dodany etap (etapów nie edytuje się w miejscu). |
| `ac_session_add_finalist(session, application)` | właściciel | Aktywna krótka lista tej rekrutacji; jedenasta osoba → `PT422`. |
| `ac_session_set_status(session, next_status)` | właściciel | `draft → open` (etap, finalista i pełne pokrycie, inaczej `PT422`), `open → closed`. |
| `ac_session_assign_pair(session, stage, application, first_id, second_id)` | właściciel | Para przez `ac_assign_pair` z R13: dwie różne osoby z firmy, jedna para na finalistę i etap. |
| `ac_record_reconciliation(pair_id, decisions)` | asesor pary | Po oddaniu obu arkuszy, raz na parę. |
| `ac_confirm_reconciliation(pair_id, verdict, note)` | drugi asesor pary | Jedna odpowiedź: `confirmed` albo `disputed` z uzasadnieniem. |
| `ac_session_record_entry(session, application, stage, entry_kind, entry)` | właściciel/rekruter; informacja zwrotna i dowód zmiany tylko asesor pary | Dopisanie do dziennika w otwartej sesji. |
| `ac_session_find(recruitment)` | właściciel/rekruter | Identyfikator sesji albo `null`. |
| `ac_session_read(session)` | właściciel/rekruter | Jeden model odczytu dla strony i raportu. |

Arkusze nadal oddaje się przez `ac_submit_sheet` (R13). `ac_session_read` pokazuje arkusze i ich uzgodnienie dopiero po oddaniu obu i tylko dwóm asesorom etapu oraz właścicielowi — rekruter spoza pary dostaje stan `restricted`. Przed oddaniem obu arkuszy nikt nie widzi cudzego arkusza. Kandydat zamrożony do usunięcia znika z odczytu. Rola `viewer`, inna firma i nieznane identyfikatory dostają odmowę.

Zapisy dla finalisty biorą blokady z R13 (`ac_lock_application`): kandydat, konfiguracja restore, zgłoszenie, uprawnienia, status procesu, znaczniki wycofania — do końca transakcji. Zamknięta rekrutacja, wycofane zgłoszenie lub zamrożenie blokują nowe zapisy; historia pozostaje czytelna dla uprawnionych.

## Interfejs i raport

- Strona: `/dashboard/{firma}/recruitments/{rekrutacja}/assessment-center` (link z ekranu rekrutacji, tylko przy fladze Preview). Akcje serwera za każdym razem wyznaczają sesję z rekrutacji w adresie i nie przyjmują identyfikatora sesji z formularza.
- `lib/assessment-center-session.ts`: walidacja całej odpowiedzi RPC (błędny kształt = brak raportu, nie raport częściowy), plan pokrycia, zalecenie liczby finalistów, raport.
- Raport na finalistę: dowody obu asesorów dla każdej kompetencji, pozycje uzgodnione i rozbieżne, pierwsza próba obok poprawionej pracy i dowodu zmiany, notatki z konsultacji eksperta. Brak dowodu jest pokazany wprost jako „brak danych”. Kolejność finalistów to kolejność dodania — nie ranking.
- `lib/assessment-center-session-template.ts`: jeden syntetyczny case HRBP (diagnoza przyczyn → konsekwencje finansowe → plan zmiany + rozmowa z człowiekiem). Firma, liczby i osoby są zmyślone; szablon służy testom i Preview.

## R16, minimalizacja i retencja

R16 wymaga dokładnego R15 (sygnatura `1093b01d…be44`) i niezmienionych źródeł R13/R15; nie zmienia wcześniejszych migracji ani baseline'ów. Sygnatura R16: `8408d01335341053b516a379bb1ed1a5d14e059f69724e19230bba2fe713bd25` (zgodna na PostgreSQL 16 i 17).

- Baseline `private.erasure_inventory_baseline_r16`: znane tabele R15 + pięć nowych tabel + sam baseline.
- Adaptery `erasure_row_candidates` i `erasure_inventory_rows` obsługują trzy tabele powiązane z kandydatem i delegują resztę do zachowanych `*_r15` (dalej `*_r12` …). Kandydat wynika z tego samego `company_id`, `recruitment_id` i `application_id`.
- Cztery czytniki (`preview_candidate_erasure`, `prepare_erasure_purge_manifest`, `authorize_retention_suggestion`, `get_retention_schedule`) zmieniają wyłącznie R15 na R16.
- Silnik purge usuwa po walidacji manifestu kolejno: dziennik, uzgodnienia, finalistów, a potem — jak dotąd — pary arkuszy; liczba usuniętych wierszy musi zgadzać się z manifestem. Rola purge ma tylko `SELECT`/`DELETE` z kontrolą manifestu.
- Trzy tabele mają strażnika wierszy (zakaz zwykłego `DELETE`, `UPDATE` tylko jako jednorazowa odpowiedź drugiego asesora) i trigger zegara retencji.
- Sesja i etapy nie zawierają danych kandydata i zostają po usunięciu finalisty.
- Preflight przerywa migrację przy nieznanym schemacie, zmienionym źródle przypiętych funkcji lub niezgodnym ACL; postflight sprawdza sygnaturę, listę tabel, brak starych odwołań do baseline'ów i brak uprawnień ról API do nowych tabel.
- Minimalizacja: zapisywany jest tylko tekst wpisany przez zespół (limity 2 000–20 000 znaków), bez plików i bez danych spoza sesji. Dane są syntetyczne w testach i na Preview.

Rollback `supabase/rollbacks/20261112120000_sc_ac_session_inventory_r16_down.sql` odbiera dostęp do RPC sesji, zachowując dowody, R16 i możliwość kontrolowanego usunięcia danych; RPC par z R13 pozostają. Ponowne włączenie wymaga sprawdzonej migracji naprzód. Żaden rollback nie usuwa zapisanych ocen.

**Zmiana poza modułem:** trzy rollbacki SC-020 (`20261109190000`, `20261109200000`, `20261109220000`) przypinały sygnaturę R15 i po instalacji R16 odmawiałyby działania. Akceptują teraz obie sprawdzone sygnatury (R15 albo R16); same nie dotykają relacji inwentarza. Testy SC-020 na pełnym łańcuchu oczekują R16.

## Weryfikacja

- `npm run typecheck`, `npm run build`.
- `npm run test:assessments` — w tym `tests/ac-session.test.mjs`: szablon, plan pokrycia, zalecenie 5–6/limit 10, raport, zakwestionowane uzgodnienie, 20 błędnych odpowiedzi odrzuconych w całości.
- `npm run test:ac-session-db` (natywny PostgreSQL 16/17, pełny łańcuch migracji):
  - `tests/ac-session-database.test.mjs` — baseline/ACL, pełna ścieżka (plan → etapy → dwóch asesorów → uzgodnienie → druga próba → raport), brak danych, role, inna firma, brak podglądu arkusza przed oddaniem obu, luka w planie blokuje otwarcie, limit 10, niezmienność zapisów, zegar retencji, zamrożenie, usunięcie finalisty według inwentarza, zamknięcie, ponowne zastosowanie, rollback, dryf źródeł i wrogie uprawnienia domyślne.
  - `tests/ac-session-concurrency.test.mjs` — niezależne połączenia: jedno uzgodnienie i jedna odpowiedź, wyścig o dziesiąte miejsce, krótka lista w obu kolejnościach, otwarcie kontra późny etap.
- `npm run test:ac-session-http` — prawdziwa strona Next od panelu do wyniku na syntetycznej granicy Auth/PostgREST: raport, „brak danych”, brak rankingu, izolacja firmy i rekrutacji z adresu, błędna odpowiedź, flaga wyłączona i środowisko produkcyjne → 404.
- Te same testy bazy są na liście natywnych testów `SC-019 forward migrations` (PostgreSQL 16 i 17), razem z `node scripts/sc-ac-session-compose.mjs --check`.
