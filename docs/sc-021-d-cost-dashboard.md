# SC-021-D — panel kosztów AI i marży

TASK: SC-021-D · Issue #81 · LEVEL: L3 · SCOPE: FULLSTACK · OWNER: Claude (builder) ·
REVIEWER: niezależna sesja · DEPENDS ON: SC-021-B (rejestr prób) · równolegle z SC-021-C (budżety) ·
PRODUCTION_APPROVAL: NO.

## Co dostarcza

| element | rola |
|---|---|
| `supabase/migrations/20261110090000_sc021_cost_dashboard.sql` | kursy walut (`ai_ledger.fx_rates`), inne koszty zmienne (`ai_ledger.other_cost_lines`), funkcje odczytu i zapisu operatora |
| `app/operator/ai-costs/` | strona `/operator/ai-costs`: podsumowanie, marża, koszty w przekrojach, kursy, inne koszty |
| `lib/ai-cost-dashboard.ts` | parsowanie okresu i formularzy, formatowanie kwot (liczby całkowite, bez float) |
| `tests/ai-cost-dashboard*.test.mjs` | testy bez bazy i na PostgreSQL 16 (dwie syntetyczne firmy) |

Panel jest **wyłącznie dla operatora** (ta sama bramka co `/operator/billing`: `salesOperator()` w aplikacji,
`private.sc19_require_operator()` w każdej funkcji bazy, z odwołaniem uprawnień od razu). Firmy go nie
widzą; marża i przychód są wewnętrzne. Członek firmy nadal widzi tylko własne wiersze rejestru (RLS z SC-021-B),
ale żadnego nowego widoku dla firm nie dodajemy — to decyzja produktowa na później.

## Przekroje kosztów

Firma, rekrutacja, kandydat, pakiet, model, dostawca, rodzaj zadania, miesiąc (czas Europe/Warsaw),
zakres miesięcy włącznie, najwyżej 24.

- **Operacja** (reguła z SC-021-B): screening = `operation_id`; generowanie zadań = (firma, rekrutacja,
  `operation_id`). Ponowienia jednej analizy to jedna operacja, wiele wywołań.
- **Kandydat** wyłącznie jako pseudonim `K-` + 16 znaków HMAC-SHA256 identyfikatora zgłoszenia z tajnym
  kluczem (`ai_ledger.pseudonym_key`, 32 losowe bajty generowane raz w migracji, niedostępne dla żadnej roli
  API i nigdy niezwracane). Bez klucza pseudonimu nie da się policzyć z identyfikatora zgłoszenia. Funkcja nie
  zwraca identyfikatora zgłoszenia, imion, e-maili ani CV.
- **Pakiet** = pakiet firmy w chwili wywołania: ostatnie z opłaconego zamówienia pakietu, ręcznego
  przydziału PRESELEKCJI, aktywacji FREE; inaczej „Bez pakietu”. Oś czasu pakietów liczona raz na zapytanie
  (przedziały od zdarzenia do następnego), nie osobno dla każdego wywołania.

## Koszt potwierdzony a szacunek

| klasa | znaczenie | w kwotach |
|---|---|---|
| zatwierdzone | stawka `approved` | „Koszt (stawki zatwierdzone)” |
| testowe | stawka `placeholder` | osobno, jako **„szacunek (stawki testowe)”** |
| bez stawki | koszt `NULL` | tylko liczba; koszt zaniżony |
| nieznany | `unknown` (mogło być naliczone) | tylko liczba |
| nienaliczone | `released` | 0 |
| zarezerwowane | wiersz rejestru `reserved` (dziś nie powstaje) | nie wliczane; żywe rezerwacje C — osobno, patrz niżej |

Ponad limit tokenów trasy (`bounds_exceeded`) to osobny licznik anomalii.

## Kursy walut

Koszt jest w walucie stawki (mikro-jednostki), przychód w złotych (grosze). Kurs: PLN za 1 USD/EUR ×1 000 000,
od daty, ze źródłem i flagą „testowy”. Tylko dopisywanie, autor i czas w każdym wierszu.

- Kurs wybierany jest **dla każdego wywołania osobno, według chwili wywołania** (`created_at` próby).
- Kolejność: kurs prawdziwy przed testowym (**także starszy** — prawdziwy zawsze wygrywa z testowym), potem
  najnowsza data obowiązywania, przy tej samej dacie najnowszy wpis (poprawka).
- Gdy zastosowany kurs prawdziwy jest starszy niż 45 dni względem wywołania, marża dostaje powód
  „kurs starszy niż 45 dni” (`fx_stale`) i status „szacunek”.
- Data „obowiązuje od” z formularza oznacza **północ UTC** tego dnia, a miesiące panelu liczone są w czasie
  **Europe/Warsaw** — kurs wpisany na 1. dzień miesiąca zaczyna obowiązywać o 1:00/2:00 czasu polskiego.

W migracji jest **tylko kurs testowy USD→PLN 4,000000** — to nie jest kurs NBP ani rynkowy. Prawdziwy kurs
wpisuje operator w panelu. **Brak kursu → koszt w złotych i marża „niedostępne”**, nigdy zgadywane.

## Marża kontrybucyjna

`marża = przychód netto − koszt AI (PLN) − inne koszty zmienne`, per firma / pakiet / miesiąc.

- **Przychód**: opłacone zamówienia katalogowe (`sc19_commerce.orders`, status `paid`, data rozliczenia).
  Netto = `round_half_up(brutto · 10000 / (10000 + VAT_bp))` per zamówienie, VAT z wersji katalogu, z której
  zamówienie wyceniono. Ceny nie są zmieniane.
- **Wpłaty bez kwoty**: ręczny przydział PRESELEKCJI (`sc19_grant_paid`, dziennik analiz) nie zapisuje kwoty —
  liczony jako „wpłata bez kwoty”, przychód 0, marża oznaczona jako szacunek.
- **Inne koszty**: wpisuje operator (opłata za płatność, SMS, e-mail, inne), netto w PLN, na miesiąc i firmę,
  opcjonalnie pakiet. Poprawka = nowy wiersz zastępujący poprzedni (raz), historia zostaje. Nic nie zasiano.
  W marży według pakietu koszt bez wskazanego pakietu trafia do pakietu firmy **na koniec swojego miesiąca**
  (czas Europe/Warsaw). Wybór firmy w formularzu ma wyszukiwarkę (lista operatora ma limit 200 wyników).
- **Status**: `niedostępna` (brak kursu), `szacunek` (kurs testowy lub starszy niż 45 dni, stawki testowe,
  wywołania bez stawki lub nieznane, rezerwacje, wpłaty bez kwoty), inaczej `potwierdzona`. Powody są pokazane obok.

Zaokrąglenia (całkowite, `numeric`): koszt PLN = `ceil(Σ cost_micros · kurs_micros / 10^10)` na grupę (w górę —
koszt nigdy niedoszacowany; suma grup może przekroczyć całość o < 1 gr na grupę).

## Bezpieczeństwo i SC-010

- Nowe tabele w `ai_ledger`, bez kluczy obcych do `public`/`private` → sygnatura R15 bez zmian (preflight
  i postflight w migracji, test). Kandydat tylko jako pseudonim.
- Brak dostępu do tabel dla `anon`/`authenticated`/workerów; odczyt i zapis wyłącznie przez funkcje
  `SECURITY DEFINER` z `search_path=''`, `EXECUTE` tylko dla `authenticated`, operator sprawdzany w środku.
- Tabele tylko do dopisywania (wyzwalacz z SC-021-B), także dla właściciela tabel.
- Formularze: klucz żądania (ponowne wysłanie nie dubluje wpisu), potwierdzenie, walidacja w aplikacji i w bazie.

## Wydajność

Strona wywołuje 4 odczyty (koszty: suma i przekrój; marża: suma i przekrój), każdy przegląda wiersze rejestru
z okresu (indeks `attempts_company_created`, maks. 24 miesiące). Przy obecnych wolumenach to akceptowane;
gdy rejestr urośnie, można połączyć sumę z przekrojem (`grouping sets`) w jednym wywołaniu. Sprawdzenie
„rozliczenie zamówienia katalogowego” używa unikalnego indeksu `settlement_reference`.

## Wycofanie

`supabase/rollbacks/20261110090000_sc021_cost_dashboard_down.sql` usuwa funkcje i trzy tabele D, ale odmawia
(`sc021d_rollback_operator_data_present`), gdy operator wpisał kurs lub inny koszt — to dane finansowe.
Rejestr prób B zostaje. Test: wycofanie i ponowna migracja, sygnatura SC-010 bez zmian.

## Rezerwacje budżetu (SC-021-C)

Rezerwacje żyją w `ai_ledger.budget_reservations` (C). Panel pokazuje dla każdej grupy **liczbę żywych
rezerwacji i niewykorzystaną kwotę** (rezerwacja − koszt już zapisanych prób operacji, min. 0), osobno —
nigdy jako koszt ani jako wywołanie. Reguła „żywa” (niezwolniona, niewygasła, operacja wciąż w toku) i
„pozostałość” są takie same jak w `ai_ledger.budget_usage` z C; test porównuje sumy D z `budget_usage`, żeby
kopie się nie rozjechały. Liczy się każda żywa rezerwacja utworzona przed końcem okresu (jak w C); w przekroju
„miesiąc” trafia do miesiąca utworzenia albo pierwszego miesiąca okresu. Gdy w grupie jest żywa rezerwacja,
marża ma powód `reserved_not_counted` i status „szacunek”. Wiersze rejestru w statusie `reserved` (jeśli
kiedyś powstaną) również nie są kosztem.

Kolejność wycofania: najpierw D, potem C (funkcje D używają typu wiersza `budget_reservations`).

## Inne koszty — lista

Lista ma filtr firmy i strony po 100 wpisów w stałej kolejności (miesiąc, czas wpisu, id — malejąco), z
linkami „poprzednia / następna strona”, więc każdy wpis wpływający na marżę da się znaleźć i poprawić.

Zdarzenia budżetu z C (np. `warning_80`) nie są dziś czytane przez D. Przy przyszłej integracji: zdarzenie
`warning_80` zapisane przy **odrzuconym** skoku ponad 100% zawiera hipotetyczną kwotę zobowiązaną — pokazywać
je jako „operacja odrzucona”, nie jako „zużycie osiągnęło 80%”.

## Testy

- `npm run test:ai-cost` — okres, formularze, formatowanie, statyczne sprawdzenie strony.
- `npm run test:ai-cost-db` — PostgreSQL 16 (CI `checks.yml`): wycofanie i ponowna migracja, prywatny klucz pseudonimów, reguły grupowania (ten sam klucz generowania
  w dwóch firmach = dwie operacje), klasy kosztu, brak/test/prawdziwy kurs, netto z VAT, marża (w tym
  ujemna i potwierdzona), wersjonowanie innych kosztów, idempotencja, operator / członek / odwołany operator /
  anon / worker, tylko dopisywanie, pseudonimy kandydatów.
