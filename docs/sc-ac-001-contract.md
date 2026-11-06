# SC-AC-001 — minimalny przepływ oceny

Zakres #271 / PR #272: istniejąca definicja ćwiczenia AC i jej niezmienna rewizja → kryteria i opisowe skale → zapis oceny obserwatora → raport pokazujący dowody. Nie powstaje odrębny silnik WERYFIKACJA ani automatyczna decyzja o zatrudnieniu. Pełne sesje wielu asesorów z #276 pozostają poza zakresem.

## Interfejs użytkownika i danych

Istniejący formularz pojedynczej obserwacji zapisuje wersje w `public.exercise_observation_entries`; projekcja raportu wiąże je z dokładną firmą, rekrutacją, zgłoszeniem i `exercise_definition_entries.id`. Starszy dowód jest prezentowany jako notatka obserwatora. Nie dorabiamy mu osobnego kontekstu, którego wcześniej nie zapisano.

Kontrakt dwóch niezależnych arkuszy z pierwotnego PR został przeniesiony z izolowanego prototypu do aktywnej, atomowej migracji `20261106120000_sc_ac_inventory_r13.sql`. Źródło domeny: `db/components/sc-ac-paired-sheets.sql`; kompozycja i piny poprzedniego łańcucha: `scripts/sc-ac-compose.mjs`. Historyczny test izolowany zastępują testy pełnego aktualnego łańcucha.

| RPC | Kontrakt |
| --- | --- |
| `ac_assign_pair(application, revision, first_id, second_id)` | Właściciel przypisuje dwie różne osoby: bieżącego właściciela lub rekruterów tej firmy. Jedna para na zgłoszenie i dokładną rewizję AC. |
| `ac_find_pair(application, revision)` | Identyfikator pary tylko dla aktualnie uprawnionego właściciela lub przypisanego asesora; w pozostałych przypadkach `null`. |
| `ac_submit_sheet(pair_id, sheet)` | Jednorazowy zapis własnego arkusza: dokładna liczba i kolejność kryteriów, ocena, dowód i osobny kontekst. Czas i autor po stronie bazy. |
| `ac_read_pair(pair_id)` | Przed dwoma zapisami wyłącznie `pending` i stan własnego zapisu. Po obu: dokładna rewizja, dwa odrębne arkusze z autorem i datą; bez uśredniania i decyzji kadrowej. |

Każda rzeczywista ocena wymaga minimum 10 znaków dowodu i 5 znaków kontekstu (maksymalnie 4000/2000). `insufficient_data` wymaga pustego dowodu i nigdy nie jest wynikiem zero. Odmienna ocena dwóch osób jest zaznaczona do przeglądu człowieka. Formularz wyświetla skale, zachowuje wpisaną treść po błędzie i po niepewnym zapisie kieruje do sprawdzenia wyniku. Server action ponownie pobiera dokładną rewizję i wiąże parę ze zgłoszeniem; SQL waliduje samodzielnie.

Interfejs par jest dostępny tylko przy `AC_PAIRED_SHEETS_PREVIEW=true` w Preview/development. Domyślnie jest wyłączony; PR nie zmienia środowisk, nie włącza usług i nie wdraża migracji.

## Uprawnienia i cykl życia

`private.ac_paired_sheets` ma RLS, nie ma bezpośredniego dostępu `anon`/`authenticated`, a cztery RPC są `SECURITY DEFINER` z pustym `search_path`. Wszystkie nowe obiekty czyszczą nadmiarowe uprawnienia domyślne. Właściciel nie może zobaczyć pierwszego arkusza przed oddaniem drugiego. Utrata członkostwa lub roli odcina dostęp do odczytu i zapisu.

Zapis blokuje bieżącego kandydata, konfigurację restore, zgłoszenie, bieżące uprawnienia i status procesu do końca transakcji. Trwałe wycofanie całego podmiotu (`candidate_withdrawn` lub `consent_withdrawn`, marker na kandydacie lub zgłoszeniu), wycofanie/odrzucenie zgłoszenia, zamknięcie/wstrzymanie rekrutacji lub archiwizacja stanowiska wyklucza przypisanie i zapis. Historyczny raport pozostaje czytelny dla obecnie uprawnionych osób po zamknięciu lub wycofaniu procesu, jak dotychczasowe obserwacje. Freeze/restore ukrywa również historyczny odczyt. Samo cofnięcie pojedynczego grantu testu kompetencyjnego nie wycofuje dostępu AC. Arkuszy nie można przepisać, przenieść, przypisać ponownie ani zwyczajnie usunąć.

## R13 i retencja

R13 wymaga dokładnego R12 z C1, nie zmienia wcześniejszych migracji ani baseline'ów. Sygnatura R13: `de6b8172a272c6933ea39da4374a1206cb857ecabae218714c1d90d50d7d2889`. Dane AC należą do kandydata przez ten sam `company_id`, `recruitment_id` i `application_id`; definicja ćwiczenia pozostaje wspólną konfiguracją rekrutacji.

Nowe adaptery delegują do zachowanych R12 (`*_r12`), które nadal prowadzą przez R11/R9, R8 i R7. Cztery czytniki baseline'u zmieniają wyłącznie R12 na R13. Jawny DELETE tabeli AC jest dopisany dopiero po walidacji manifestu i przejściu kontekstu purge do `delete`; wymagana jest zgodność liczby usuniętych wierszy. Nadanie roli purge pozostaje ograniczone do SELECT/DELETE z istniejącymi kontrolami manifestu. Trigger obserwacji przesuwa zegary retencji po zapisie. Nieznany schemat, nieznany adapter, zmiana przypiętych funkcji lub niezgodny ACL przerywa migrację/wykonanie.

Rollback `20261106120000_sc_ac_inventory_r13_down.sql` wyłącza RPC, zachowując dowody, R13 oraz możliwość kontrolowanego usunięcia danych. Ponowne uruchomienie wymaga sprawdzonej migracji naprzód. Operacyjne wyłączenie UI to zdjęcie flagi Preview. Żaden rollback nie usuwa zapisanych ocen.

## Weryfikacja

- `npm run typecheck`, `npm run build`, `npm run test:assessments`.
- `tests/assessment-center-active-database.test.mjs`: pełny replay, dokładny baseline/allowlist, tenant i role, brak wczesnego ujawnienia, walidacja, niezmienność, revocation, statusy procesu, freeze/cancel/restore, zegary, wspólny purge AC + B2, zachowanie innych kandydatów/firm/definicji, unknown-schema/source drift, wrogie default ACL, rollback i reapply.
- `tests/assessment-center-active-concurrency.test.mjs`: niezależne połączenia natywnego PostgreSQL, powtórny zapis oraz obie kolejności zapisu względem odebrania członkostwa, freeze i kontrolowanego wycofania.
- Natywne PG16/17 są obowiązkowe w istniejącym workflow `SC-019 forward migrations`. Lokalny PGlite17 służy tylko szybkiej weryfikacji SQL i nie zastępuje testu współbieżności ani hosted rehearsal.
