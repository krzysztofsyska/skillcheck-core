# SC-PROCESS (#277) — diagnostyka rekrutacji i wskaźniki procesu

LEVEL L3 · SCOPE FULLSTACK · powiązane: #18 (Quality of Hire), #19 (pula talentów), `docs/sc-method-275.md`.

Zlecenie właściciela z 2026-11-12. Praca jest podzielona na dwie części. **Ten dokument opisuje część A**
i mówi wprost, co dojdzie w części B.

| | Część A (ten PR) | Część B (osobny PR) |
| --- | --- | --- |
| Diagnostyka małego napływu CV | tak | — |
| Wskaźniki czasu rekrutacji z definicją i zakresem danych | tak | — |
| Przejście próby, retencja | zdefiniowane, zawsze „brak pomiaru” | pomiar |
| Obserwacje po zatrudnieniu 30/90/180 dni | nie | tak |
| Ocena wewnętrzna / awans jako osobny cel z własnymi uprawnieniami | nie | tak |
| Tabele powiązane z kandydatem | **żadnej** | tak — wymaga nowej rewizji inwentarza usuwania danych |

## Po co

Gdy do rekrutacji wpływa mało CV, pierwszym odruchem jest „dołóżmy budżetu na ogłoszenia”. Zwykle przyczyna
leży gdzie indziej: ogłoszenia nikt nie widzi, nazwa stanowiska jest niezrozumiała, nie wiadomo, co się będzie
robić, albo warunki odbiegają od rynku. Część A daje rekruterowi stałą listę pięciu rzeczy do sprawdzenia
**przed** zmianą budżetu, pokazuje liczby napływu i zapisuje, co zostało sprawdzone.

System niczego nie zmienia sam, nie ocenia kandydatów i nie podejmuje żadnej decyzji kadrowej. Zapis diagnozy to
notatka zespołu; zalecenie wpisuje człowiek.

## Dane

Migracja `supabase/migrations/20261112140000_sc_process_diagnostics.sql`, rollback
`supabase/rollbacks/20261112140000_sc_process_diagnostics_down.sql`. Osobny schemat `process`, **jedna** tabela:

| Tabela | Co trzyma |
| --- | --- |
| `process.diagnostic_records` | Kolejne, niezmienne wpisy diagnozy rekrutacji. |

Kolumny: `company_id`, `recruitment_id`, `record_no` (1, 2, 3… w ramach rekrutacji), `content`,
`recommendation_kind`, `recommendation`, `inflow_snapshot`, `created_by`, `created_at`. Nie ma kolumny wskazującej
kandydata ani zgłoszenie.

Treść wpisu (`content`, JSON w postaci kanonicznej):

| Pole | Znaczenie | Limit |
| --- | --- | --- |
| `areas.channels` | kanały: gdzie ogłoszenie jest opublikowane | — |
| `areas.role_name` | nazwa roli: czy kandydaci jej szukają | — |
| `areas.tasks` | zadania: czy są opisane konkretnie | — |
| `areas.job_ad` | ogłoszenie: czy jest czytelne i mówi, co firma oferuje | — |
| `areas.market` | warunki rynkowe: wynagrodzenie i benefity wobec rynku, miejsce pracy (biuro / hybryda / zdalnie) | — |
| `areas.<obszar>.status` | `ok` / `problem` / `not_checked` | — |
| `areas.<obszar>.note` | krótka notatka; wymagana przy `problem` | 500 znaków |
| `channelsUsed[]` | `job_board`, `company_site`, `social_media`, `referrals`, `agency`, `employment_office`, `other` | bez powtórzeń |

Zalecenie: `recommendation_kind` to `fix_areas` (popraw wskazane obszary), `keep_watching` (obserwuj dalej) albo
`change_budget` (zmień budżet); `recommendation` to uzasadnienie, 1–1000 znaków.

`inflow_snapshot` to cztery liczby z chwili zapisu: `total`, `last_14_days`, `last_30_days`, `days_open`.
Bez identyfikatorów i bez dat zgłoszeń.

### Reguły zapisu (egzekwowane w bazie)

1. **Budżet na końcu.** Zalecenia `change_budget` nie da się zapisać, dopóki którykolwiek z pięciu obszarów ma
   status `not_checked`. Funkcja zwraca `process_budget_requires_full_check:<obszary>` (22023), a tabela ma
   dodatkowo więz `budget_requires_full_check`, niezależny od funkcji. Obszar sprawdzony z wynikiem `problem`
   liczy się jako sprawdzony.
2. Status `problem` wymaga notatki (`process_diagnostic_incomplete:<obszar>.note`).
3. Zalecenie `fix_areas` wymaga co najmniej jednego obszaru ze statusem `problem`.
4. Uzasadnienie zalecenia jest obowiązkowe.
5. **Historia jest tylko dopisywana.** Wpisu nie da się zmienić ani usunąć, także jako właściciel tabeli
   (wyzwalacz `process.guard_record`). Kolejna diagnoza to kolejny wpis.
6. `expected_record_no` — numer ostatniego wpisu, który rekruter widział (0, gdy nie ma żadnego). Niezgodność to
   PT409 bez zapisu, żeby dwie karty nie dopisały po cichu dwóch sprzecznych diagnoz.

Te same reguły ma panel (`lib/process-diagnostics.ts`), ale ostateczną granicą jest baza.

## Napływ CV

`process_diagnostics_state` liczy przy każdym odczycie, z `public.applications` tej rekrutacji: liczbę wszystkich
zgłoszeń, zgłoszenia z ostatnich 7 / 14 / 30 dni, osiem kolejnych okresów po 7 dni wstecz, datę pierwszego
i ostatniego zgłoszenia oraz liczbę dni trwania rekrutacji. Początek rekrutacji to `opened_at`, a gdy go nie ma —
`created_at`; odpowiedź zawsze mówi, które z nich zostało użyte (`start_source`).

To odczyt istniejących danych. Nic nie jest kopiowane poza migawką czterech liczb w zapisie diagnozy.

### Podpowiedzi „od czego zacząć”

`proposeDiagnosticAreas()` w `lib/process-diagnostics.ts` — czysta, deterministyczna funkcja, bez AI i bez sieci.
Z prostych faktów wskazuje obszary w kolejności sprawdzania:

| Fakt | Wskazany obszar |
| --- | --- |
| zero CV po co najmniej 7 dniach; napływ ustał; mniej niż 5 CV w 14 dni | kanały |
| żargon lub wewnętrzne oznaczenie w nazwie; nazwa dłuższa niż 60 znaków lub 6 słów | nazwa roli |
| brak zadań w profilu stanowiska albo mniej niż 3 | zadania |
| brak opisu stanowiska albo opis krótszy niż 200 znaków | ogłoszenie |
| w opisie nie widać wynagrodzenia lub miejsca pracy | warunki rynkowe |

Progi są umowne i jawne (`INFLOW_RULES`). To wskazówka, nie diagnoza i nie decyzja. Rekrutacja krótsza niż 7 dni
albo będąca szkicem ma poziom napływu „brak pomiaru”, a nie „brak zgłoszeń”.

## Wskaźniki

`process_recruitment_metrics` zwraca cały katalog. Każdy wskaźnik ma: `state`, `value`, `unit`, `reason`
i `scope` (źródło, liczba wierszy, okres). Słowna definicja i opis zakresu danych są w `lib/process-metrics.ts`
(`metricCatalogue`), wersja katalogu `process-metrics-v1`.

**Brak pomiaru to nie zero.** `state = not_measured` ma zawsze `value = null` i powód. `state = measured` ma
liczbę — także gdy jest to 0 albo wartość ujemna (np. zgłoszenie starsze niż data otwarcia).

| Wskaźnik | Definicja | Zakres danych | Dziś |
| --- | --- | --- | --- |
| `days_to_first_application` | dni od początku rekrutacji do pierwszego zgłoszenia | wszystkie zgłoszenia rekrutacji | liczony |
| `days_to_first_shortlist` | dni od początku do pierwszego wpisu krótkiej listy | wszystkie wpisy krótkiej listy, także wycofane | liczony |
| `days_to_first_next_stage_decision` | dni od początku do pierwszej decyzji rekrutera „kolejny etap” | zapisane decyzje `next_stage` | liczony |
| `median_days_application_to_decision` | mediana dni od zgłoszenia do pierwszej decyzji rekrutera | zgłoszenia z co najmniej jedną decyzją; minimum 3 | liczony |
| `recruitment_duration_days` | dni od początku do zamknięcia rekrutacji | daty rekrutacji; tylko gdy jest `closed_at` | liczony |
| `days_to_hire` | dni od początku do dnia zatrudnienia | wymaga daty zatrudnienia | brak pomiaru (`requires_hire_date`) |
| `probation_pass_rate` | odsetek zatrudnionych, którzy przeszli okres próbny | wymaga obserwacji po zatrudnieniu | brak pomiaru (`requires_post_hire_observations`) |
| `retention_rate` | odsetek zatrudnionych, którzy pracują po 90 i 180 dniach | wymaga obserwacji po zatrudnieniu | brak pomiaru (`requires_post_hire_observations`) |

Powody braku pomiaru: `no_data`, `too_few_rows`, `recruitment_not_closed`, `requires_hire_date`,
`requires_post_hire_observations`. Panel ma jeszcze `unavailable` — gdy odpowiedzi nie da się odczytać
(błąd, inna wersja katalogu, zły kształt), wskaźnik staje się brakiem pomiaru, nigdy zerem.

Trzy ostatnie wskaźniki są brakiem pomiaru niezależnie od odpowiedzi bazy: `describeMetrics()` nie przyjmie dla
nich liczby, dopóki katalog nie oznaczy ich jako dostępnych. Nie są udawane.

Wskaźniki mierzą czas i przebieg rekrutacji, nie ludzi. Decyzje „kolejny etap” podejmuje rekruter; wskaźnik
liczy tylko, kiedy została zapisana.

## Dostęp

Schemat `process` nie jest widoczny dla `anon` ani `authenticated`. RLS jest włączone bez polityk, więc każdy
bezpośredni odczyt i zapis jest odmawiany. Jedyna droga to trzy funkcje `security definer` z `search_path = ''`:

| Funkcja | Kto |
| --- | --- |
| `public.process_diagnostics_state(firma, rekrutacja)` | każdy członek firmy |
| `public.process_recruitment_metrics(firma, rekrutacja)` | każdy członek firmy |
| `public.process_record_diagnostic(firma, rekrutacja, diagnoza, rodzaj, uzasadnienie, numer)` | właściciel lub rekruter |

Każda sprawdza `auth.uid()`, członkostwo przez `private.has_company_access` i to, że rekrutacja należy do tej
firmy. Czytelnik (viewer) czyta, ale nie zapisuje. Osoba spoza firmy, inna firma i `anon` dostają 42501.
Uprawnienia wykonania są odebrane `public`, `anon`, `service_role` i `screening_worker`.

## Inwentarz usuwania danych (SC-010)

Część A nie tworzy żadnej tabeli powiązanej z kandydatem i nie dodaje kluczy obcych do `public` ani `private`,
więc `private.erasure_schema_signature()` się nie zmienia.

Migracja **nie przypina konkretnej wartości sygnatury**. Równolegle inny PR przenosi inwentarz z R15 na R16;
wartość wpisana na stałe przestałaby działać po jego scaleniu. Zamiast tego:

- preflight zapisuje sygnaturę w ustawieniu `sc_process.signature_before`, widocznym tylko w tej transakcji;
- postflight wymaga, żeby sygnatura była identyczna, i dodatkowo sprawdza, że żaden więz ze schematu `process`
  nie wskazuje poza ten schemat;
- rollback robi to samo;
- test bazy porównuje sygnaturę przed i po: z migracją, po rollbacku i po ponownej instalacji.

Usunięcie zgłoszenia na żądanie kandydata zmienia liczby napływu i wskaźniki, bo są liczone na bieżąco. Migawka
w starym wpisie diagnozy zostaje — to cztery liczby, z których nie da się odtworzyć osoby.

## Minimalizacja i retencja

- Zapisywane są wyłącznie dane firmy o rekrutacji. Notatki są wolnym tekstem rekrutera; formularz prosi, żeby
  nie wpisywać danych kandydatów.
- `created_by` to identyfikator użytkownika firmy, który zapisał wpis. Nie jest zwracany do panelu.
- Wpisy żyją tak długo jak firma. Usuwa je wyłącznie przyszła, uprzywilejowana procedura usuwania firmy, która
  w tej samej transakcji ustawi `set_config('process.purge_company', '<uuid firmy>', true)`. Nic w tej migracji
  tego nie robi.

## Panel

`/dashboard/<firma>/recruitments/<rekrutacja>/diagnostyka`, link ze strony rekrutacji. Jedna strona: napływ CV,
podpowiedzi, formularz listy pięciu obszarów, historia diagnoz i tabela wskaźników z definicjami. Formularz
zaczyna od ostatniej diagnozy, ale zawsze zapisuje nowy wpis.

## Testy

| Wymaganie z #277 | Gdzie |
| --- | --- |
| przypadek pozytywny | `tests/process-diagnostics-database.test.mjs` — „positive path”, „measured metrics” |
| brak danych → brak pomiaru, nie zero | tamże — „missing data is not_measured”; `tests/process-diagnostics.test.mjs` |
| zalecenie budżetu odrzucone przy niesprawdzonych obszarach | oba pliki — „budget rule” |
| nieuprawniona rola | baza — „unauthorised role” |
| dostęp między firmami | baza — „cross-company” |
| od panelu do zapisanego wyniku | baza: formularz → `parseDiagnosticForm` → RPC → odczyt; jednostkowe: akcja serwera |
| różne podpowiedzi dla różnych danych | jednostkowe — „hints are deterministic…” |

Uruchomienie: `npm run test:process`, `npm run test:process-db` (natywny PostgreSQL 16/17, zmienne jak dla
`test:method-db`). Oba są w `checks.yml`; test bazy jest też na liście „Real migration…” w `sc19-migrations.yml`.

## Znane ograniczenia

- **Usunięta rekrutacja.** Tabela nie ma klucza obcego do `public.recruitments`, więc po usunięciu rekrutacji jej
  wpisy zostają w bazie, ale są nieosiągalne (każda funkcja wymaga istniejącej rekrutacji tej firmy). Posprząta
  je procedura usuwania firmy.
- **Brak daty otwarcia.** Panel nie ustawia dziś `opened_at`, więc początek rekrutacji to zwykle data jej
  utworzenia. Odpowiedź mówi o tym wprost (`start_source`).
- **Podpowiedzi czytają opis stanowiska, nie opublikowane ogłoszenie.** System nie przechowuje treści ogłoszenia
  ani listy kanałów, dlatego to rekruter potwierdza stan faktyczny na liście.
- **Daty krótkiej listy.** Wpisy krótkiej listy są niezmienne, więc wskaźnik liczy pierwszy wpis, także później
  wycofany.

## Co doda część B

Część B domyka #277 i dotyka #18 (Quality of Hire) oraz #19 (pula talentów), które są w `CLAUDE.md` na liście
zamrożonych — wymaga więc osobnego potwierdzenia zakresu.

1. **Obserwacje po zatrudnieniu w 30, 90 i 180 dniu**: faktyczne zadania, jakość wdrożenia, zasoby, wsparcie
   i autonomia. Z rozróżnieniem „nie zmierzono” i „wynik negatywny”, tak jak tutaj.
2. **Data zatrudnienia**, a z nią pomiar `days_to_hire`, `probation_pass_rate` i `retention_rate`.
3. **Ocena wewnętrzna / awans jako odrębny cel przetwarzania**, z własnymi uprawnieniami — osobno od rekrutacji.
4. **Prześledzenie przypadku od kryteriów przez wynik do późniejszej obserwacji**, bez automatycznej decyzji
   kadrowej.

Punkty 1–3 wymagają tabel powiązanych z kandydatem lub pracownikiem, czyli **nowej rewizji inwentarza usuwania
danych** (zmiana sygnatury SC-010), reguł retencji i podstawy prawnej dla danych pracowniczych.
