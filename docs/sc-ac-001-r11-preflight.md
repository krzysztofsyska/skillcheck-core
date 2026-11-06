# Aktualizacja 2026-11-06

Założenia poniżej zachowano jako historię preflight. Implementację aktywnego kontraktu R13, jego kolejność po R12/C1, rollback i testy opisuje [sc-ac-001-contract.md](sc-ac-001-contract.md). Prototyp isolated zastąpiono składnikiem aktywnej migracji.

# SC-AC-001 / #271 — bramka AC/R11 przed aktywną migracją

STATUS: DESIGN_ONLY. PR #272, gałąź `feat/sc-ac-scenario-foundation`, baza `integration`. Nie jest to migracja, nie uruchamia AC w Preview.

## Stan wejściowy

- `db/isolated/sc-ac-paired-sheets.sql` zawiera jedną tabelę `private.ac_paired_sheets` i cztery RPC: `ac_assign_pair`, `ac_submit_sheet`, `ac_read_pair`, `ac_find_pair`. Testy są izolowane; nie dowodzą autoryzacji w Preview.
- W modelu są dwie osobne oceny z `criterionIndex`, `rating`, `evidence` i `context`. Raport porównawczy jest dostępny dopiero po złożeniu obu ocen. Powiązanie obejmuje firmę, rekrutację, zgłoszenie oraz identyfikator wersji ćwiczenia.
- Aktualny baseline usuwania danych: `supabase/migrations/20261103090100_sc_erasure_inventory_r11.sql`. R11 obejmuje `public` i `private` oraz kontroluje podpis schematu. Nie modyfikować już zastosowanej migracji.
- Współzależna WERYFIKACJA (#270, PR #273) również przygotowuje nowy schemat. Obie gałęzie startowały z `integration` @ `7f172d7`, który w dniu 2026-11-06 był 8 commitów za bieżącym `integration`. Przed migracją sprawdzić ponownie aktualne migracje i bazę.

## Wymagania dla implementacji L3

1. Zaprojektować **własną, późniejszą rewizję inwentarza** po R11, korzystając z dokładnego aktualnego podpisu schematu i przeglądu wszystkich relacji; nie zakładać z góry numeru „R12”, gdy WERYFIKACJA może dodać swoją rewizję wcześniej. Uzgodnić kolejność rewizji i konfliktujące funkcje retencji z PR #273. Każdy krok fail-closed przy nieznanej sygnaturze.
2. Ustalić ścieżkę usunięcia danych `private.ac_paired_sheets`: arkusze zawierają dowody i kontekst o kandydacie, choć nie mają jawnego `candidate_id`. Powiązanie biegnie przez `public.applications`. Wykazać zgodność `private.erasure_inventory_rows`, `private.erasure_purge_rows`, `private.erasure_row_candidates`, manifestu, kontroli scope i kaskady `ON DELETE CASCADE`; samo dopisanie tabeli do `known_tables` jest niewystarczające.
3. Przed migracją rozstrzygnąć politykę widoczności arkuszy po wycofaniu zgłoszenia, zamknięciu rekrutacji, archiwizacji stanowiska lub zmianie członkostwa. Obecny `ac_submit_sheet` blokuje zapis przy zmianie statusu; `ac_read_pair` / `ac_find_pair` sprawdzają członkostwo firmy, lecz nie sprawdzają aktywnego statusu zgłoszenia/rekrutacji. Nie zmieniać semantyki odczytu bez testów i uzgodnienia retencji/audytu.
4. W aktywnej migracji zachować rozdział uprawnień właściciela i asesorów, sprawdzenie aktualnego członkostwa w każdym wywołaniu, tenant isolation także przy zgadniętym UUID oraz bezpieczne `SECURITY DEFINER SET search_path=''`. Brak bezpośredniego dostępu `anon`/`authenticated` do prywatnej tabeli. Osobno zweryfikować minimalne `EXECUTE` na RPC i kto może przypisać parę.
5. Zatrzymać oba arkusze jako oddzielne niezmienne zgłoszenia: zakaz nadpisania oceny po wysłaniu, brak ujawniania drugiej oceny przed kompletem; raport nie może generować fikcyjnych dowodów ani automatycznej decyzji o zatrudnieniu. Każdy arkusz musi zachować pełny `context` i wskazanie wersji definicji ćwiczenia.
6. Dodać nową migrację i odpowiedni rollback wyłącznie po review projektu. Wcześniej przygotować testy pełnego łańcucha do aktualnego R11 (albo następcy), negatywnego podpisu i nieznanej tabeli; przed Preview wymagany niezależny review gotowego SQL na dokładnym HEAD.

## Bramka testowa

- SQL: dwie firmy, niedozwolony assessor, odebranie członkostwa, wycofanie zgłoszenia, pauza rekrutacji, archiwizacja stanowiska, ponowne złożenie oceny, współbieżne zapisy, odczyt po zmianie statusu.
- Ocena i raport: identyczny układ kryteriów w obu arkuszach, niemutowalna wersja definicji, poprawny `context`, brak porównania przed kompletem i brak automatycznej rekomendacji zatrudnieniowej.
- Usuwanie: `preview_candidate_erasure` i `prepare_erasure_purge_manifest` uwzględniają wiersze AC, usuwają tylko wskazanych kandydatów, nie zostawiają osieroconych arkuszy, odrzucają nieznaną zależność.
- CI: testy izolowane, pełny typecheck, build i regresja istniejących modułów; potem test autoryzowanego przepływu w `skillcheck-preview` na danych syntetycznych.

## Granice

Nie współdzielić tabel testu kompetencji z AC. Nie zmieniać FREE, PRESELEKCJI, P24, main ani produkcji. Ten plik nie jest potwierdzeniem ukończonej migracji, testów Preview czy gotowości do merge.
