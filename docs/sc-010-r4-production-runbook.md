# SC-010-R4 — przygotowanie uruchomienia

Data kontroli: 2026-10-12, Europe/Warsaw.

Właściciel zlecił R4 i produkcję. Zgoda pozwala przygotować i wykonać sprawdzone wydanie, ale nie zastępuje polityki retencji konkretnej firmy, brakujących usług, testu odtworzenia ani wymaganych bramek repozytorium. Nie wybieramy domyślnych okresów prawnych.

## Potwierdzony stan wejściowy

- Repozytorium: `krzysztofsyska/skillcheck-core`; R3 zaakceptowane i scalone do integration jako `b94ce3eb6555794a360a4b24bb8eb794a95fbcb1`.
- Supabase SkillCheck: `wsvjawuikxfzjyivxgsu`, nazwa wyświetlana `white Label`, EU west, PostgreSQL 17.6.
- Odczyt katalogu potwierdził brak `private.candidate_retention_policies`, `private.erasure_execution_config` i `private.erasure_executions`.
- Historia produkcji kończy się na operacyjnej migracji `sales_retention_cron_extension`; migracje B1/B2/R1/R2/R3 nie zostały zastosowane.
- Vercel Production READY: `dpl_CULtPSTZQ4WHzfGezNq9UbQGT9hE`, commit `76760b7ffb7e95231fc7af313cc67bc8d36fefe1` z main. Brak SC-010-R3 na produkcji.
- Porównanie main–integration zawiera także sprzedaż i offline SC-011/012. Istniejące PR #86 i #100 dotyczą wydania sprzedażowego; nie traktować promocji całej integration jako wydania samego R4.

## Kolejność wydania

1. Zamknąć R4 na osobnej gałęzi: testy SQL, prawdziwy PostgreSQL, ledger, role, UI, regresje, build i niezależny review dokładnego SHA.
2. Zatwierdzić wynik integracji zgodnie z AGENTS.md i przygotować jeden spójny promotion PR integration → main. Porównać jego pełny zakres z równoległymi wydaniami; nie scalać konkurujących promocji bez uzgodnienia ich aktualnych SHA.
3. Porównać definicje i historię migracji, a nie wyłącznie daty. Produkcja używa operacyjnych timestampów SC-007 i sprzedaży. Nie uruchamiać zbiorczego db push.
4. W jednorazowej bazie odtworzeniowej wykonać brakujące migracje B1/B2/R1/R2/R3/R4 w kolejności repozytorium. Zachować role NOLOGIN i wyłączoną konfigurację wykonania.
5. Zapewnić oddzielny PostgreSQL ledger i jego niezależne kopie, osobne klucze AES/Ed25519/rezerwacji oraz niezależny trwały rejestr minimalnego watermark. Nie przechowywać tych kluczy w produkcie ani kopii produktu.
6. Przygotować ograniczone tożsamości scheduler, worker, attestor i restore. Żadna rola aplikacji nie otrzymuje możliwości podpisania rezerwacji ani samodzielnego ACK.
7. Zatwierdzić politykę per firma, wszystkie klasy/zdarzenia, horyzont kopii i artefaktów, margines, wielkość partii oraz tryb. Zacząć od suggest_only. Nieznany zakres zasobów zewnętrznych blokuje automatyczne usuwanie.
8. Uruchomić syntetyczną próbę: dwie firmy → propozycja → delegowana autoryzacja → podpisana rezerwacja → trwały ledger → ACK → purge → odtworzenie starej kopii w izolacji → pełna weryfikacja i ponowne purge. Sprawdzić brak zmian w drugiej firmie, utratę ACK i ponowienie.
9. Dopiero po dowodzie poprawnej próby skonfigurować wywołanie ograniczonego scheduler tick na zaufanym hoście. Monitoring sprawdza ostatni tick, zaległości, holds, wygasłe lease i niezależny checkpoint. Brak ticka oznacza awarię, nie pustą kolejkę.
10. Zastosować wyłącznie brakujące przejrzane migracje na produkcji, wykonać smoke na fikcyjnej firmie, wdrożyć odpowiadający im kod, zweryfikować faktycznie działający harmonogram. Oddzielnie aktywować delegację firmy. W raporcie podać wyniki, wersje i faktyczne flagi.

## Blokady aktywacji

| Warunek | Stan wejściowy |
| --- | --- |
| Migracje SC-010 B1–R4 na produkcji | brak B1–R3; R4 w implementacji |
| Niezależny ledger, klucze i watermark | niepotwierdzone / bez wskazanej instancji |
| Zatwierdzone horyzonty kopii i artefaktów | brak przekazanych wartości |
| Inwentarz zasobów zewnętrznych i adaptery | niepotwierdzony |
| Polityka i delegacja firmy | brak konfiguracji produkcyjnej |
| Izolowana próba restore na docelowym środowisku | niewykonana |
| Scheduler i jego odrębne uprawnienia | nieskonfigurowane |
| Pełny zakres promocji wraz z równoległą sprzedażą | wymaga uzgodnienia aktualnych PR |

## Wycofanie i incydenty

Wyłączyć nowe ticki/delegacje i nowe autoryzacje, zachować ledger oraz dane recovery. Nie odwracać trwałego erasing przez ustawienie cancelled. Oczekujące ACK uzgadniać według tej samej rezerwacji. Nie przywracać starej kopii do ruchu bez izolacji i pełnego replay. Wycofanie aplikacji nie cofa migracji ani wykonanego usunięcia. Nie usuwać tombstones lub kluczy jako sposobu wycofania wydania.

## Co nie jest dowodem produkcyjnego uruchomienia

Zielone CI, Vercel Preview, sama zgoda właściciela, lokalna flaga enabled ani ręczny pojedynczy tick nie dowodzą działającego harmonogramu i poprawnego restore. Raport ma rozróżniać przygotowany kod, wdrożone komponenty i aktywne przetwarzanie.
