# SC-002 (dalszy ciąg) — wyrównanie bazy Preview z kodem (27.11.2026)

Krok R0 SC-002 z `docs/ROADMAP.md`, dalszy ciąg raportu
[`sc002-db-parity-2026-11-26.md`](sc002-db-parity-2026-11-26.md). Dotyczy **wyłącznie testowej
bazy Preview** `skillcheck-preview` (`orbyscrupgnupifzlqxp`). Produkcji
(`wsvjawuikxfzjyivxgsu`) ta sesja nie dotykała w żaden sposób.

## Krótko

- Na Preview brakowało 4 migracji z kodu. **Wszystkie 4 zostały wgrane** (27.11.2026, ok. 03:20
  czasu polskiego), po kolei, w kolejności nazw plików, dokładnie w treści z plików — bez żadnych
  poprawek.
- **Zatwierdzanie wyników analizy CV działa teraz na Preview tak jak w kodzie** (różnica P1 z
  poprzedniego raportu usunięta). Można na Preview testować SC-005 i SC-008.
- Ponowne porównanie: **każda migracja z kodu jest na Preview**, a jej treść w rejestrze jest
  identyczna z plikiem. Na Preview zostały 3 dodatkowe wpisy i schemat `checkout` — opisane niżej,
  **niczego nie usunięto**.

## Co brakowało i co wgrano

Wgrane narzędziem Supabase MCP `apply_migration` na projekcie `orbyscrupgnupifzlqxp`, w tej
kolejności:

| # | Plik w kodzie | Co robi | Wynik | Wpis w rejestrze Preview |
|---|---|---|---|---|
| P2 | `20261011165916_sales_retention_cron_extension.sql` | instaluje rozszerzenie `pg_cron` | OK | `20261127022042` |
| P3 | `20261021084500_normalize_function_line_endings.sql` | zamienia CRLF na LF w 13 funkcjach (na Preview nic do zmiany) | OK | `20261127022054` |
| P1 | `20261030120000_sc_step3_matrix_change_invalidates_approval.sql` | zmiana w wierszu oceny CV unieważnia wcześniejsze zatwierdzenie; zatwierdzenie analizy wymaga przejrzenia każdego wiersza | OK | `20261127022135` |
| P4 | `20261102090000_sales_leads_enable.sql` | włącza formularz `/rozmowa` tylko tam, gdzie jest sekret podpisu | OK (na Preview nic się nie zmieniło — sekretu nie ma, formularz zostaje wyłączony) | `20261127022143` |

Uwaga o numerach: narzędzie `apply_migration` zapisuje w rejestrze numer z chwili wgrania, a nie
numer z nazwy pliku. Dlatego te 4 wpisy mają numery z 27.11.2026. Nazwa i treść są takie jak w
kodzie. Workflow `preview-db-migrate` porównuje po nazwie i treści, więc mu to nie przeszkadza
(podobnie jak przy 3 wpisach z innym numerem opisanych w poprzednim raporcie). Numerów w rejestrze
nie poprawiano ręcznie.

Dlaczego wgranie P1 było bezpieczne: żadna późniejsza migracja w kodzie nie zmienia funkcji
`public.review_screening_evidence_row` ani `public.review_screening_result`, więc wgranie tej
migracji teraz daje dokładnie ten stan, jaki ma baza zbudowana z kodu.

## Ponowne porównanie (po wgraniu)

Na Preview wykonano po wgraniu tylko zapytania odczytu.

| Sprawdzenie | Wynik |
|---|---|
| Nazwy migracji: kod (112 plików) ↔ rejestr Preview (115 wpisów) | każda z 112 migracji z kodu jest na Preview; brak migracji z kodu, której nie ma na Preview |
| Treść 4 nowych wpisów: skrót SHA-256 treści w rejestrze ↔ skrót pliku | identyczne dla wszystkich 4 |
| Funkcje zatwierdzania: skrót MD5 treści funkcji na Preview ↔ treść w `20261030120000` | `review_screening_evidence_row` i `review_screening_result` identyczne z kodem; obie `security definer`, wywoływać może `authenticated` (nie `anon`) |
| `pg_cron` | zainstalowane (wersja 1.6.4); zaplanowanych zadań: 0 |
| Funkcje ze znakiem CR (schematy `public`, `private`) | 0 |
| Formularz `/rozmowa` (`private.sales_lead_settings`) | `leads_enabled = false`, sekret nieustawiony (sprawdzone testem `is not null`, bez odczytu wartości) |

Wniosek: **między kodem a Preview nie ma już brakujących migracji**. Zostały tylko pozostałości,
które są na Preview, a nie ma ich w kodzie.

## Co zostaje (pozostałości — opisane, nie usunięte)

| # | Wpis w rejestrze Preview | Co jest w bazie dziś | Propozycja |
|---|---|---|---|
| P5 | `checkout_orders` (`20261031185337`) | schemat `checkout`: 2 tabele (`orders`, `settings`) i 7 funkcji (`checkout.*` oraz `public.checkout_*`). Kod aplikacji z tego nie korzysta; `anon` i `authenticated` nie mają dostępu (wg raportu z 26.11) | osobny krok: usunąć schemat `checkout` i ten wpis z Preview albo zostawić jako opisaną pozostałość. Usuwanie danych i obiektów — nie w tym PR |
| P6 | `screening_ranking_evidence_verdicts` (`20261101140000`) | tylko wpis w rejestrze; funkcja rankingu ma treść zgodną z kodem | bez działania; ewentualnie usunąć sam wpis w tym samym osobnym kroku co P5 |
| P7 | `sc19_p24_preview_runtime_role` (`20261105223256`) | rola `sc19_p24_preview` (Przelewy24, tryb testowy), odpowiada skryptowi `supabase/preview-setup/sc19-p24-runtime.sql` | bez działania; sprzątnąć razem z resztą Przelewy24, gdy dojdzie do usuwania P24 |

Tabeli `checkout.settings` nie czytano (może zawierać sekret). Liczby tabel i funkcji wzięto z
katalogu bazy (`information_schema`, `pg_proc`), bez czytania danych.

## Czego nie zrobiono (NOT RUN)

| Co | Dlaczego |
|---|---|
| Porównanie z produkcją na żywo | bez zmian względem raportu z 26.11: brak potwierdzonego połączenia tylko do odczytu z produkcją (zasada 2 w `AGENTS.md`) |
| Pełne porównanie wszystkich definicji, uprawnień, RLS i wyzwalaczy (zrzut schematu Preview ↔ baza zbudowana z kodu) | brak lokalnego PostgreSQL w tej sesji; propozycja z raportu z 26.11 (porównanie `pg_dump --schema-only` w CI) aktualna |
| Usunięcie pozostałości P5–P7 | usuwanie obiektów i wpisów to osobny krok, poza zakresem tego PR |

## Co dalej

1. SC-002 zostaje **W TOKU**: do zamknięcia brakuje porównania z produkcją (połączenie tylko do
   odczytu) i decyzji co do pozostałości P5–P7 (usunąć czy zostawić jako opisane).
2. Na Preview można już testować SC-005 i SC-008 z aktualnym zatwierdzaniem wyników.
