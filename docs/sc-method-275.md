# SC-METHOD (#275) — profil metody stanowiska i macierz dowodów

LEVEL L3 · SCOPE FULLSTACK · powiązane: #270, #271 (SC-014 test kompetencji), `docs/exercise-definitions.md`,
`docs/sc-014-competency-test.md`, `docs/sc-ac-001-contract.md`.

## Po co

Profil stanowiska (`public.positions`) mówi, **czego** wymagamy: zadania, mierniki, samodzielność, kompetencje.
Profil metody mówi, **jak to sprawdzamy**: po czym poznamy każdą kompetencję, jaką metodą, według jakich kryteriów
i czego z wyniku nie wolno wnioskować. Rekruter dostaje propozycję dopasowaną do poziomu stanowiska, poprawia ją
i zatwierdza. System niczego nie punktuje i nie podejmuje decyzji o kandydacie.

## Dane

Migracja `supabase/migrations/20261112100000_sc_method_profile.sql`, rollback
`supabase/rollbacks/20261112100000_sc_method_profile_down.sql`. Osobny schemat `method`, dwie tabele:

| Tabela | Co trzyma |
| --- | --- |
| `method.profile_versions` | Szkic (najwyżej jeden na stanowisko) i zatwierdzone wersje profilu metody. |
| `method.definition_bindings` | Która zatwierdzona wersja metody obowiązywała, gdy powstała dana wersja definicji zadania. |

Treść wersji (`content`, JSON w postaci kanonicznej):

| Pole | Znaczenie | Limit |
| --- | --- | --- |
| `goal` | cel stanowiska | 1000 znaków |
| `expectedOutcome` | oczekiwany wynik | 1000 |
| `constraints` | ograniczenia | 1000 |
| `responsibilityLevel` | `specialist` / `manager` / `director` | — |
| `matrix[]` | jeden wiersz na kompetencję, najwyżej 30 | — |
| `matrix[].competency` | tekst kompetencji z profilu stanowiska | 500 |
| `matrix[].evidence` | oczekiwany dowód | 600 |
| `matrix[].method` | `cv_evidence` / `competency_test` / `case_study` / `simulation` / `interview` | — |
| `matrix[].justification` | uzasadnienie wyboru metody | 600 |
| `matrix[].criteria[]` | kryteria, 1–8 | 300 każde |
| `matrix[].limits` | granice wniosku | 600 |

Zadania i samodzielność zostają w `public.positions`. Zatwierdzona wersja zapisuje ich kopię w `position_snapshot`
(tytuł, opis, zadania, mierniki, samodzielność, kompetencje), więc jest kompletna sama w sobie. `content_hash` to
SHA-256 treści i tej kopii.

### Cykl życia

1. **Szkic** — `method_profile_save_draft`. Pola mogą być puste; sprawdzany jest kształt i limity. `expected_revision`
   chroni przed nadpisaniem zmian z drugiej karty (PT409). To licznik zmian profilu metody **stanowiska**, nie
   pojedynczego szkicu: rośnie przy każdym zapisie szkicu i przy zatwierdzeniu, a nowy szkic kontynuuje numerację
   (nigdy nie wraca do 1). Panel bierze go z pola `revision` w `method_profile_state` (0, gdy nic jeszcze nie
   zapisano). Karta otwarta przed zatwierdzeniem nie nadpisze więc szkicu utworzonego po nim.
2. **Zatwierdzenie** — `method_profile_approve`. Pełna walidacja: uzupełnione cel, wynik, ograniczenia i poziom,
   a macierz obejmuje **dokładnie** kompetencje z aktualnego profilu stanowiska, każda z dowodem, metodą,
   uzasadnieniem, co najmniej jednym kryterium i granicami wniosku. Błąd `method_profile_incomplete:<pole>`
   (22023) mówi, czego brakuje; panel tłumaczy go na zdanie po polsku.
3. **Zatwierdzona wersja jest niezmienna** dla wszystkich ról, także właściciela tabeli (wyzwalacz
   `method.guard_version`). Zmiana = nowy szkic i nowa wersja z kolejnym numerem. Historia jest tylko dopisywana.

### Powiązanie z definicją zadania (reguła migawki)

Definicja zadania (`public.exercise_definition_entries`) jest niezmienną wersją, a nadania i próby wskazują dokładny
`definition_entry_id`. Powiązanie zapisuje, z którą wersją metody powstała definicja. Są dwie funkcje o tej samej
regule: `method_bind_definition(firma, definicja)` dla jednej definicji i
`method_bind_recruitment_definitions(firma, rekrutacja)` dla wszystkich jeszcze niepowiązanych definicji rekrutacji.

- Reguła jest deterministyczna: wybierana jest zatwierdzona wersja metody stanowiska, która obowiązywała
  **w chwili utworzenia definicji** (`approved_at <= created_at` definicji, najwyższy numer). Wynik nie zależy od
  tego, kiedy funkcja została wywołana, a ponowne wywołanie zwraca to samo.
- Powiązanie jest niezmienne. Zatwierdzenie nowej wersji metody nie zmienia powiązania, definicji, nadania ani
  rozpoczętej próby (test: „a new method version changes neither a started attempt…").
- Definicja utworzona, zanim stanowisko miało zatwierdzoną metodę, nie dostaje powiązania (funkcja zwraca `null`).
- **Każda ścieżka aplikacji, która tworzy lub zatwierdza wersję definicji, wiąże ją** przez jeden wspólny pomocnik
  `bindMethodToDefinitions` (`lib/method-binding.ts`), wołany po udanym zapisie:

  | Akcja serwera | Funkcja bazy, która tworzy/zatwierdza definicję |
  | --- | --- |
  | `saveExerciseDefinition` (`exercise-actions.ts`) | `save_exercise_definition` |
  | `editExerciseAiProposal` (`exercise-ai-actions.ts`) | `edit_exercise_ai_proposal` (nowa wersja powstaje w bazie) |
  | `generateExerciseProposal` (`exercise-generation-action.ts`) | `finish_exercise_ai_generation` (akcja nie dostaje id definicji) |
  | `approveExerciseAiProposal` (`exercise-ai-actions.ts`) | `approve_exercise_ai_proposal` (nie tworzy definicji; domyka ewentualne wcześniej nieudane powiązanie) |

  Pomocnik woła wariant dla całej rekrutacji, bo nie każda akcja zna id nowej definicji, a przypiętych treści
  istniejących funkcji `public.*` ta zmiana nie podmienia. Dzięki regule czasu wynik jest ten sam co przy wiązaniu
  pojedynczym, a każde kolejne wywołanie nadrabia definicje, których wcześniej nie udało się powiązać.
- Błąd powiązania nie cofa zapisu zadania i nie zmienia odpowiedzi dla rekrutera. Trafia do logu serwera jako
  `method_bind_failed code=<kod>` — sam kod błędu, bez komunikatu bazy i bez danych.
- Definicja utworzona inną drogą niż te akcje (np. bezpośrednie wywołanie funkcji bazy) zostaje niepowiązana do
  następnego wywołania pomocnika dla tej rekrutacji.

**Dlaczego osobna tabela, a nie pole w `position_snapshot` definicji.** Dopisanie odcisku do migawki wymagałoby
podmiany `public.save_exercise_definition`, której treść jest przypięta w testach łańcucha migracji, i zmieniałoby
kształt migawki czytanej przez test kompetencji i Assessment Center. Powiązanie w schemacie `method`, bez klucza
obcego, nie dotyka żadnej relacji objętej inwentarzem usuwania danych.

**Znane ograniczenie — nakładające się transakcje.** `created_at` definicji to początek jej transakcji.
`approved_at` to odczyt zegara (`clock_timestamp()`) wewnątrz transakcji zatwierdzenia, czyli chwilę **przed** jej
zatwierdzeniem w bazie (commit). Reguła porównuje te dwa znaczniki, a nie kolejność commitów, więc gdy zatwierdzenie
metody i zapis zadania nakładają się w czasie, możliwe są dwa odstępstwa:

- definicja zostaje związana z poprzednią wersją metody albo z żadną, mimo że nowa wersja powstała ułamek sekundy
  wcześniej (powiązanie zapisano, zanim transakcja zatwierdzenia stała się widoczna);
- definicja zostaje związana z wersją, której transakcja zatwierdzenia nie była jeszcze zakończona, gdy definicja
  powstawała (`approved_at` minimalnie wcześniejsze niż `created_at`, commit później). Autor zadania nie mógł tej
  wersji widzieć. Okno ma długość końcówki transakcji zatwierdzenia — zwykle poniżej milisekundy.

Poza takim nakładaniem się definicja nigdy nie jest wiązana z wersją zatwierdzoną po jej utworzeniu, a raz zapisane
powiązanie nigdy się nie zmienia. Zmiana tej reguły wymagałaby zapisu powiązania w tej samej transakcji co
definicja, czyli podmiany `public.save_exercise_definition`.

## Role i dostęp

Schemat `method` jest zamknięty dla `anon` i `authenticated`: brak `usage`, RLS włączone bez polityk, brak grantów
do tabel. Jedyna droga to funkcje `public.method_*` (`security definer`, `search_path = ''`), wykonywalne tylko
przez `authenticated`:

| Funkcja | Kto |
| --- | --- |
| `method_profile_state`, `method_profile_version`, `method_definition_binding` | każdy członek firmy (viewer też); szkic widzą tylko osoby z prawem zapisu |
| `method_profile_save_draft`, `method_profile_approve`, `method_bind_definition`, `method_bind_recruitment_definitions` | właściciel lub rekruter tej firmy (`private.has_company_access(firma, true)`) |

Każda funkcja sprawdza zalogowanie i członkostwo w `target_company`, a wiersze wybiera wyłącznie po `company_id` tej
firmy. Identyfikator z innej firmy daje `42501` albo `null` — bez rozróżnienia „nie istnieje" od „cudze".
Zarchiwizowanego stanowiska nie da się edytować (`55000`).

Co dokładnie sprawdza odczyt:

- `method_profile_state(firma, stanowisko)` wymaga, żeby stanowisko nadal istniało w tej firmie;
- `method_profile_version(firma, wersja)` i `method_definition_binding(firma, definicja)` sprawdzają **tylko
  członkostwo w firmie** i szukają po id. Nie sprawdzają, czy stanowisko albo definicja nadal istnieje.

## Propozycja dla poziomu (bez AI)

`proposeMethodProfile(position, level)` w `lib/method-profile.ts` — czysta funkcja, bez sieci, zegara i losowości.

| Poziom | Kryteria dotyczą | Domyślna metoda |
| --- | --- | --- |
| Specjalista | jakości i terminowości własnej pracy, zgłaszania spraw poza zakresem | test kompetencji (próbka pracy) |
| Menedżer | wyniku zespołu, delegowania, informacji zwrotnej | studium przypadku / symulacja rozmowy |
| Dyrektor | strategii, budżetu i wyniku finansowego (P&L), wpływu na inne działy | studium przypadku / rozmowa ustrukturyzowana |

Wymaganie formalne (np. prawo jazdy, certyfikat) dostaje metodę „dowody w CV" na każdym poziomie. Każde „granice
wniosku" kończy się zdaniem, że to materiał dla rekrutera, a nie automatyczna decyzja. Propozycja niczego nie
zapisuje; rekruter ją poprawia, zapisuje szkic i zatwierdza.

## Panel

`/dashboard/<firma>/positions/<stanowisko>/metoda` (link z profilu stanowiska): obowiązująca wersja, formularz
(propozycja / szkic / poprzednia wersja jako punkt wyjścia), przyciski „Zapisz szkic" i „Zapisz i zatwierdź",
historia wersji z podglądem. Osoba z dostępem tylko do odczytu widzi zatwierdzone wersje bez formularza.

## Minimalizacja i retencja

- **Wyłącznie dane firmy o stanowisku.** Żadnych danych kandydata: brak imion, CV, odpowiedzi, wyników.
- **Identyfikatory pracowników firmy zostają.** Każda wersja trzyma id użytkowników, którzy ją utworzyli, ostatnio
  zapisali i zatwierdzili (`created_by`, `updated_by`, `approved_by`), a powiązanie — id osoby, której akcja je
  zapisała (`bound_by`). To gołe identyfikatory bez klucza obcego do `auth.users`: usunięcie konta użytkownika ich
  nie czyści i nic w tej zmianie ich nie anonimizuje. Kopia profilu stanowiska w zatwierdzonej wersji
  (`position_snapshot`) również zostaje po zmianie lub usunięciu stanowiska.
- Do propozycji nie jest wysyłane nic na zewnątrz; nie ma wywołania modelu AI.
- Schemat `method` nie ma kluczy obcych do `public`/`private`, więc `private.erasure_schema_signature()` (SC-010,
  R15) pozostaje bez zmian — migracja i rollback sprawdzają to na wejściu i na wyjściu, test po instalacji.
  Usunięcie danych kandydata nie dotyka profilu metody i nie musi: nie ma w nim danych kandydata.
- Historia jest niezmienna i **nic jej dziś nie usuwa**. Po usunięciu stanowiska albo rekrutacji wiersze w schemacie
  `method` zostają (nie ma klucza obcego, więc nie ma kaskady). Panel przestaje je pokazywać, bo
  `method_profile_state` wymaga istniejącego stanowiska, ale członek **tej samej firmy**, który zna id wersji lub
  definicji, nadal odczyta je przez `method_profile_version` i `method_definition_binding`. Osoba spoza firmy nie
  odczyta nic.
- Wyzwalacze przewidują jedną drogę usunięcia: uprzywilejowana procedura w swojej transakcji ustawia
  `set_config('method.purge_company', '<uuid firmy>', true)` i wtedy może usunąć wiersze tylko tej firmy. **Żadna
  procedura tego dziś nie robi** — ani usuwanie firmy, ani retencja, ani ta zmiana. Dopóki taka procedura nie
  powstanie, profile metody i powiązania są przechowywane bezterminowo.
- Rollback odmawia, gdy istnieje jakikolwiek profil lub powiązanie: usunięcie zapisanych decyzji rekrutera to
  decyzja właściciela, nie rollback.

## Bezpieczne domyślnie

Zmiana nie dotyka cen, pakietów, płatności, przełączników sprzedaży ani ustawień produkcji. Nie zmienia żadnej
istniejącej tabeli, polityki ani funkcji. Bez migracji strona pokazuje komunikat „niedostępne w tym środowisku",
a zapis zadania działa jak dotąd.

## Testy

- `npm run test:method` — propozycja dla trzech poziomów (różne, adekwatne kryteria), brak danych, walidacja,
  komunikaty, akcja serwera od formularza do wywołań bazy (pozytywna, niekompletna, tylko odczyt, konflikt) oraz
  każda z czterech akcji tworzących lub zatwierdzających definicję: powiązanie po udanym zapisie, brak powiązania
  po nieudanym, błąd powiązania nie zmienia wyniku i trafia do logu jako sam kod.
- `npm run test:method-db` — natywny PostgreSQL 16/17, pełny łańcuch migracji, dwie syntetyczne firmy: sygnatura
  SC-010 bez zmian, zamknięty schemat, ścieżka pozytywna od propozycji do zapisanej wersji, każdy brak danych,
  viewer / osoba spoza firmy / anon, dostęp między firmami, niezmienność historii, rozpoczęta próba kontra nowa
  wersja metody, nieaktualna karta kontra szkic utworzony po zatwierdzeniu, białe znaki w kompetencjach, definicje
  utworzone w bazie przez generowanie i korektę propozycji AI, rollback i ponowna instalacja. Wymaga `SC19_TEST_DATABASE_URL` i `SC19_TEST_PG_MAJOR`.
- Oba zestawy są w `.github/workflows/checks.yml`; zestaw bazodanowy także w `.github/workflows/sc19-migrations.yml`.
