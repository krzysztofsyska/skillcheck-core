# Zamówienia katalogowe (#283)

Zakup jest dostępny w istniejącej kasie firmy, z zachowaniem linku powrotnego do rekrutacji. Operator potwierdza wpłatę w istniejącym panelu rozliczeń. Nie dodano dostawcy płatności ani automatycznej faktury; istniejący P24 pozostaje osobnym transportem PRESELEKCJI. Obie drogi blokują nowe zamówienie, gdy firma ma już nieopłacone zamówienie w drugiej drodze.

Ten etap korzysta z wdrożonego katalogu `pricing.package_prices` / `addon_options` w groszach brutto, nie publikuje innej wersji silnika netto `pln-v1`. Snapshot zamówienia obejmuje wersję, pełne warunki, produkt, ilość, cenę i przyznawane jednostki. Baza porównuje cały pokazany snapshot z ponowną wyceną pod blokadą; żadna kwota z przeglądarki nie jest zaufana. Publikacja nowego katalogu wymaga ponownej akceptacji.

## Gotowość i aktywacja

- `SC19_CATALOG_ORDERS_ENABLED` domyślnie nieustawiona/OFF; `sc19_commerce.settings.enabled=false`. Żadna flaga środowiskowa ani produkcyjna nie została zmieniona.
- Reguły realizacji muszą wskazywać konkretną opublikowaną wersję, produkt i zgodny pakiet, `runtime_ready`, `auto_purchase`, ilości, prerequisites oraz exclusions. Nie ma domyślnych reguł dopuszczających sprzedaż.
- PRESELEKCJA przyznaje CV do istniejącego salda. WERYFIKACJA wymaga jawnie ustalonej liczby testów (nie wyprowadzamy jej z liczby CV), gotowości testu, meteringu i `sellable` w katalogu. Te ustawienia nie są aktywowane przez tę migrację.
- `skill_test` jest istniejącym kodem dodatku w katalogu. Jego jednostka jest zużywana przy utworzeniu nowego grantu testu. Retry nie zużywa kolejnej jednostki; transakcja cofa debit, jeśli utworzenie grantu zawiedzie. Odwołanie już wydanego grantu nie zwraca jednostki automatycznie. Metryka jest wyłączona do odrębnej aktywacji, a bez niej nie można sprzedawać testów.
- AC, report i OCR nie mają konsumenta jednostek w tym kontrakcie i pozostają niedostępne do zakupu. Ceny dodatków nadal są niezatwierdzone/zerowe; testy ustawiają ceny wyłącznie w odtwarzanej bazie syntetycznej.

## Rozliczenia i retencja

Nowy pakiet jest pełnym kolejnym zakupem, a nie proporcjonalną dopłatą. Zgodnie z #274 nie ma częściowych zwrotów. Wszystkie niewykorzystane CV i jednostki usług pozostają; ten etap nie dodaje dat wygaśnięcia. Cen, ilości i reguł pakietów nie zmieniono.

Potwierdzanie wpłaty wymaga bieżącej roli operatora, dokładnej kwoty i PLN. Referencja jest deduplikowana również względem starszego ręcznego przydziału PRESELEKCJI. Zamówienie i saldo zmieniają się atomowo. Order pozostaje niezmiennym zapisem warunków; można zmienić tylko stan pending→paid/cancelled. Dodatki nie tworzą fikcyjnych zapisów kredytów CV.

`sc19_commerce` zawiera księgowość firmy, bez identyfikatorów kandydatów, CV i powiązań do grantów. Historia nie jest usuwana z kandydatem. FK do firmy ma RESTRICT; usunięcie firmy z historią wymaga osobnej polityki retencji rozliczeń. Nie zmienia to sygnatury inwentarza danych kandydatów w public/private; pełny łańcuch migracji w natywnym PG16/17 sprawdza tę granicę. Wszystkie tabele mają RLS i brak klientowego CRUD; RPC sprawdzają aktualnego właściciela/członkostwo/operatora.

Rollback operacyjny wyłącza nowe zamówienia; pozostawia możliwość realizacji opłaconych zobowiązań i nie odbiera zakupionych jednostek. Produkcja i PR #266 pozostają HOLD.
