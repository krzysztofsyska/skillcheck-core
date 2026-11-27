# SC-016a — test końcowy Assessment Center (27.11.2026)

Krok R3 z `docs/ROADMAP.md`. Test: `tests/sc016a-ac-end-to-end-database.test.mjs`
(`npm run test:ac-session-db`, natywny PostgreSQL, pełny łańcuch migracji, dane fikcyjne).
Nie zmienia kodu aplikacji ani migracji.

## Kto może być asesorem (zasada egzekwowana w bazie)

Asesorem w parze jest wyłącznie:

1. właściciel firmy, do której należy rekrutacja, albo
2. aktualny członek tej firmy z rolą `recruiter`.

Odmowa (`42501`, „Assessor unavailable”) dla: członka z rolą `viewer`, osoby bez członkostwa,
właściciela lub rekrutera innej firmy oraz osoby usuniętej z firmy lub zdegradowanej do `viewer`
po przypisaniu. Jedna osoba nie może być oboma asesorami pary. Pary tworzy tylko właściciel firmy.

Gdzie to jest w kodzie:

- `supabase/migrations/20261106120000_sc_ac_inventory_r13.sql` — `ac_assign_pair` (sprawdzenie
  właściciela/rekrutera przy przypisaniu) oraz te same warunki przy `ac_find_pair`, `ac_read_pair`,
  `ac_submit_sheet`;
- `supabase/migrations/20261112120000_sc_ac_session_inventory_r16.sql` — sesja finalistów, wywołuje
  ten sam silnik par (`ac_session_assign_pair`);
- testy: `tests/ac-session-database.test.mjs` („AC session assessors…”),
  `tests/ac-assessor-names-database.test.mjs`, a w tym kroku jedna ścieżka całościowa.

## Dostęp tylko z pakietem AC (egzekwowane w bazie)

`supabase/migrations/20261121090000_r3_ac_package_gate.sql`: `ac_session_create` i przejście
`draft -> open` w `ac_session_set_status` wymagają wiersza
`sc19_commerce.entitlements(company_id, 'package:ASSESSMENT_CENTER')` z `available > 0` (kod `PT402`).
Pakiet nie jest zużywany; zamknięcie sesji nie wymaga pakietu. Osoba spoza firmy i rekruter dostają tę
samą odmowę co wcześniej, więc nie dowiadują się nic o pakiecie. Test końcowy nadaje pakiet drogą, którą
robi to aplikacja (`sc19_stripe.grant_package`, tryb testowy).

## Co sprawdza test końcowy

Jedna ścieżka: konto bez pakietu (obie firmy) nie tworzy sesji, nie widzi cudzej sesji; po opłaconym
pakiecie firma A planuje sesję z szablonu, dodaje dwóch finalistów z krótkiej listy, otwiera sesję,
dwóch asesorów (właściciel i rekruter) niezależnie wypełnia arkusze wszystkich 4 etapów obu
finalistów, rekruter zapisuje uzgodnienie, właściciel je potwierdza, finalista 1 ma drugą próbę
(praca, informacja zwrotna, poprawka, dowód zmiany) i notatkę eksperta, raport pokazuje obu asesorów
przy każdej kompetencji, braki jako „brak danych”, bez rankingu i decyzji; po zamknięciu raport jest
zamrożony, a pakiet nie jest zużyty. Zasada asesora jest sprawdzona w tej samej ścieżce.

Czego ten test nie powtarza (jest w istniejących testach): wyścigi dwóch asesorów
(`ac-session-concurrency`), kasowanie kandydata, rollback migracji, limit 10 osób, eksport CSV
(`ac-session-export-audit-database`).

## Luka (osobny krok, nie naprawiana w tym PR)

Brama pakietu obejmuje tylko `ac_session_create` i otwarcie sesji. Surowe funkcje par z R13
(`ac_assign_pair`, `ac_submit_sheet`, `ac_read_pair`, `ac_find_pair`) nie sprawdzają pakietu.
Sprawdzone lokalnie na fikcyjnych danych: właściciel firmy BEZ pakietu AC, mając rekrutera w firmie,
przypisał parę do ćwiczenia typu `assessment_center` swojej rekrutacji i oddał arkusz przez te funkcje
(bez sesji). Dane zostają w jego firmie, ale „konto bez pakietu AC nie ma dostępu” jest dziś spełnione
dla sesji, nie dla samych par. Ekran par jest za flagą `AC_PAIRED_SHEETS_PREVIEW`
(`lib/assessment-center-preview.ts`), domyślnie wyłączoną, więc użytkownik tego dziś nie dosięgnie z
interfejsu.

Propozycja osobnego kroku (L3: migracja, RPC security-definer, granica zaufania): ta sama
`private.ac_package_required` w `ac_assign_pair` (przypisanie pary), z odmową `PT402`; odczyt i
oddanie arkusza już utworzonej pary bez zmian, żeby nie ucinać rozpoczętej pracy. Przed zmianą trzeba
zdecydować, co z parami już utworzonymi w R13 bez pakietu. Nie robić w tym PR; wymaga migracji na
produkcji przez `production-approval`.

## Wyniki uruchomień

Zapisane w opisie PR (tylko to, co faktycznie uruchomiono).
