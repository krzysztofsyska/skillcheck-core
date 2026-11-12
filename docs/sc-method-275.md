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
   chroni przed nadpisaniem zmian z drugiej karty (PT409).
2. **Zatwierdzenie** — `method_profile_approve`. Pełna walidacja: uzupełnione cel, wynik, ograniczenia i poziom,
   a macierz obejmuje **dokładnie** kompetencje z aktualnego profilu stanowiska, każda z dowodem, metodą,
   uzasadnieniem, co najmniej jednym kryterium i granicami wniosku. Błąd `method_profile_incomplete:<pole>`
   (22023) mówi, czego brakuje; panel tłumaczy go na zdanie po polsku.
3. **Zatwierdzona wersja jest niezmienna** dla wszystkich ról, także właściciela tabeli (wyzwalacz
   `method.guard_version`). Zmiana = nowy szkic i nowa wersja z kolejnym numerem. Historia jest tylko dopisywana.

### Powiązanie z definicją zadania (reguła migawki)

Definicja zadania (`public.exercise_definition_entries`) jest niezmienną wersją, a nadania i próby wskazują dokładny
`definition_entry_id`. `method_bind_definition(firma, definicja)` zapisuje, z którą wersją metody powstała definicja.

- Reguła jest deterministyczna: wybierana jest zatwierdzona wersja metody stanowiska, która obowiązywała
  **w chwili utworzenia definicji** (`approved_at <= created_at` definicji, najwyższy numer). Wynik nie zależy od
  tego, kiedy funkcja została wywołana, a ponowne wywołanie zwraca to samo.
- Powiązanie jest niezmienne. Zatwierdzenie nowej wersji metody nie zmienia powiązania, definicji, nadania ani
  rozpoczętej próby (test: „a new method version changes neither a started attempt…").
- Definicja utworzona, zanim stanowisko miało zatwierdzoną metodę, nie dostaje powiązania (funkcja zwraca `null`).
- Akcja zapisu zadania (`exercise-actions.ts`) woła tę funkcję po udanym zapisie; błąd powiązania nie cofa zapisu.

**Dlaczego osobna tabela, a nie pole w `position_snapshot` definicji.** Dopisanie odcisku do migawki wymagałoby
podmiany `public.save_exercise_definition`, której treść jest przypięta w testach łańcucha migracji, i zmieniałoby
kształt migawki czytanej przez test kompetencji i Assessment Center. Powiązanie w schemacie `method`, bez klucza
obcego, nie dotyka żadnej relacji objętej inwentarzem usuwania danych.

**Znane ograniczenie.** `created_at` definicji to początek jej transakcji, `approved_at` to zegar w chwili
zatwierdzenia. Gdy zatwierdzenie metody i zapis zadania nakładają się w tej samej sekundzie, definicja może
zostać związana z poprzednią wersją (albo z żadną). Nigdy nie zostaje związana z wersją późniejszą niż ona sama.

## Role i dostęp

Schemat `method` jest zamknięty dla `anon` i `authenticated`: brak `usage`, RLS włączone bez polityk, brak grantów
do tabel. Jedyna droga to funkcje `public.method_*` (`security definer`, `search_path = ''`), wykonywalne tylko
przez `authenticated`:

| Funkcja | Kto |
| --- | --- |
| `method_profile_state`, `method_profile_version`, `method_definition_binding` | każdy członek firmy (viewer też); szkic widzą tylko osoby z prawem zapisu |
| `method_profile_save_draft`, `method_profile_approve`, `method_bind_definition` | właściciel lub rekruter tej firmy (`private.has_company_access(firma, true)`) |

Każda funkcja sprawdza zalogowanie, członkostwo w `target_company` i to, że stanowisko/definicja/wersja należy do
tej samej firmy. Identyfikator z innej firmy daje `42501` albo `null` — bez rozróżnienia „nie istnieje" od „cudze".
Zarchiwizowanego stanowiska nie da się edytować (`55000`).

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
  Jedyne identyfikatory osób to id użytkowników firmy, którzy zapisali i zatwierdzili wersję.
- Do propozycji nie jest wysyłane nic na zewnątrz; nie ma wywołania modelu AI.
- Schemat `method` nie ma kluczy obcych do `public`/`private`, więc `private.erasure_schema_signature()` (SC-010,
  R15) pozostaje bez zmian — migracja i rollback sprawdzają to na wejściu i na wyjściu, test po instalacji.
  Usunięcie danych kandydata nie dotyka profilu metody i nie musi: nie ma w nim danych kandydata.
- Historia jest niezmienna. Wiersze osierocone po usunięciu stanowiska są niewidoczne (każdy odczyt sprawdza
  stanowisko lub definicję w tej samej firmie). Jedyna droga usunięcia to przyszła uprzywilejowana procedura
  usuwania firmy, która w swojej transakcji ustawi `set_config('method.purge_company', '<uuid firmy>', true)`;
  wtedy wyzwalacze pozwalają usunąć wiersze tylko tej firmy. Ta zmiana takiej procedury nie dodaje.
- Rollback odmawia, gdy istnieje jakikolwiek profil lub powiązanie: usunięcie zapisanych decyzji rekrutera to
  decyzja właściciela, nie rollback.

## Bezpieczne domyślnie

Zmiana nie dotyka cen, pakietów, płatności, przełączników sprzedaży ani ustawień produkcji. Nie zmienia żadnej
istniejącej tabeli, polityki ani funkcji. Bez migracji strona pokazuje komunikat „niedostępne w tym środowisku",
a zapis zadania działa jak dotąd.

## Testy

- `npm run test:method` — propozycja dla trzech poziomów (różne, adekwatne kryteria), brak danych, walidacja,
  komunikaty, akcja serwera od formularza do wywołań bazy (pozytywna, niekompletna, tylko odczyt, konflikt).
- `npm run test:method-db` — natywny PostgreSQL 16/17, pełny łańcuch migracji, dwie syntetyczne firmy: sygnatura
  SC-010 bez zmian, zamknięty schemat, ścieżka pozytywna od propozycji do zapisanej wersji, każdy brak danych,
  viewer / osoba spoza firmy / anon, dostęp między firmami, niezmienność historii, rozpoczęta próba kontra nowa
  wersja metody, rollback i ponowna instalacja. Wymaga `SC19_TEST_DATABASE_URL` i `SC19_TEST_PG_MAJOR`.
- Oba zestawy są w `.github/workflows/checks.yml`; zestaw bazodanowy także w `.github/workflows/sc19-migrations.yml`.
