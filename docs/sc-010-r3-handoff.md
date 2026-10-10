# SC-010-R3 — kontrolowany executor i niezależny rejestr odtworzeń

Data: 2026-10-10, Europe/Warsaw.

TASK: SC-010-R3
LEVEL: L3
SCOPE: FULLSTACK
OWNER: Codex / orchestrator
REVIEWER: niezależny Codex architect/reviewer
DEPENDS ON: R2 #94, R1, B1/B2, SC-006/008/009
STATUS: CODE REVIEW PASS / CI PENDING — bieżący wynik i SHA w PR
BRANCH: feat/sc-010-r3-purge
BASE: 5479c56a10c483d3c98932a5898c347d52a5bb54

Właściciel zlecił implementację o 22:46. R3 dodaje wykonanie ograniczonego zakresu usuwania oraz protokół odtworzenia. Wdrożenie, poświadczenia, rejestr niezależny, zatwierdzone horyzonty kopii i rzeczywisty inwentarz środowiska wymagają osobnej aktywacji. Nie zastosowano migracji na produkcji i nie usunięto rzeczywistych danych.

## Granice uprawnień

| Komponent | Zdolność |
| --- | --- |
| Owner firmy | R1/R2 zatwierdzenie zakresu, status, żądanie anulowania i blokady wykonania |
| erasure_worker | Wyłącznie wąskie RPC rezerwacji, stanu i wykonania; bez DML i możliwości potwierdzenia własnego ACK |
| erasure_ledger_attestor | Zweryfikowany kryptograficznie ACK, związany w SQL z dokładną rezerwacją |
| erasure_restore_attestor | Odtwarzanie zweryfikowanego strumienia wyłącznie w izolowanym środowisku |
| erasure_purge_owner | NOLOGIN, bez BYPASSRLS i członkostw ról aplikacji; właściciel ograniczonego purge |

Rejestr działa w oddzielnej bazie PostgreSQL. Jego SQL jest w `tools/erasure`, poza migracjami produktu. AES-GCM chroni zapisane envelope, Ed25519 potwierdza zdarzenia i checkpoint. Klucze, tożsamość rejestru i zaufany watermark są przypięte poza odtwarzaną bazą produktu. Sam hash lub oświadczenie workera nie jest dowodem trwałego zapisu.

Doprecyzowanie architektury: standardowy pgcrypto nie weryfikuje Ed25519. Weryfikację podpisu wykonuje osobny proces attestor w Node; SQL dopuszcza wyłącznie jego odizolowaną rolę i ponownie wiąże wszystkie parametry z serwerową rezerwacją. Uprawnienia tego procesu są granicą zaufania, podobnie jak administrator bazy. Nie wolno współdzielić jego poświadczeń z workerem, aplikacją lub przeglądarką.

## Protokół i awarie

Rezerwacja lokalna tworzy dokładny tekst envelope i jego hash. Rejestr wykonuje atomowy compare-and-append z numerem i hashem poprzedniego zdarzenia. Dopiero trwały commit i zweryfikowane potwierdzenie pozwalają zmienić lokalną fazę. Awaria po zapisie, ale przed odpowiedzią, wymaga ponowienia tej samej rezerwacji. Wygaśnięcie lease nie uprawnia do przeciwnej decyzji.

Pierwszy potwierdzony `erasing` jest nieodwracalną granicą. Od tego momentu anulowanie jest niedopuszczalne również po awarii przed lokalnym ACK. Wcześniejsze anulowanie wymaga potwierdzenia w tym samym strumieniu, zanim dane zostaną odblokowane. R2 lokalnie anuluje tylko żądania, dla których jeszcze nie istnieje możliwy do wyeksportowania envelope.

Cofnięcie zgody pozostaje dostępne. Może zmienić graf po wcześniejszym ACK, co blokuje purge starego manifestu. Reconciliation `erasing → erasing` zwiększa numer zdarzenia i potwierdza nowy manifest obliczony przez bazę. Nie zmienia firmy, osoby/UUID, zakresu, generacji, polityki, autora ani kontraktu adapterów; nie przywraca możliwości anulowania. Współbieżna kolejna zmiana ponownie wymaga uzgodnienia.

## Usuwanie grafu

Purge działa w jednej transakcji z blokadami i dokładnym kontekstem dopuszczonych wierszy. Nie wyłącza RLS, FK, triggerów ani nie używa ustawianego przez klienta GUC jako uprawnienia. Wyjątki DELETE w niezmiennej historii są ograniczone do roli, transakcji i wpisów manifestu. Zwykłe UPDATE historii pozostaje zabronione.

Zakres obejmuje kandydatów, aplikacje, dokumenty, oceny, screening, shortlisty, B1/B2, dokładne adaptery JSON oraz R1/R2 bilety, rozpoznania zakresu, żądania i historię poleceń. Rekord administracyjny odnoszący się również do osoby spoza zatwierdzonego zakresu blokuje operację; zakres nie rozszerza się automatycznie. Wspólne definicje i konfiguracja firmy pozostają.

Nowy schemat, nieznany adapter/JSON lub nieobsługiwany zasób zewnętrzny blokuje wykonanie. Rejestr i worker nie mogą przyjąć od klienta deklaracji, że zewnętrznych danych nie ma. Konfiguracja wykonania jest domyślnie wyłączona, nie ma domyślnych okresów prawnych. Blokada wymagająca przeglądu nie znika samoczynnie tylko dlatego, że upłynął jej termin.

Minimalne potwierdzenie usunięcia nie zawiera dawnych UUID osoby, treści, kluczy idempotencji ani ścieżek dostawców. Stan wykonania, manifest i rejestr odtworzeń pozostają danymi pseudonimowymi z osobnym horyzontem. Nie nazywamy ich anonimowymi. Tombstone wycofanego UUID przetrwa usunięcie kandydata; jego GC nie jest włączone, dopóki istnieje możliwość ponownego importu dowolnego starego UUID.

## Odtwarzanie

Odtwarzana baza pozostaje izolowana od produktu i workerów. Przed pierwszym replay runtime weryfikuje cały strumień, podpisy, kolejność, powiązania hashy, tożsamość rejestru, świeże wyzwanie checkpointu i zaufany minimalny watermark. Starszy lub niepełny rejestr blokuje otwarcie środowiska. Watermark nie może pochodzić wyłącznie z przywróconej kopii produktu lub z przywróconej starszej bazy rejestru.

Envelope zawiera podpisany zakres i kopię polityki/autoryzacji. Backup sprzed powstania żądania lub polityki nie wymaga odtwarzania konta dawnego ownera. Najpierw instalowane są tombstones, następnie odtwarzany jest dokładny zakres na przywróconym grafie. Brakujące znane zasoby są idempotentne; nieznane zależności blokują otwarcie. `authorized` przywraca wyłącznie freeze, `cancelled` nie upoważnia do purge.

## UI i zakres gotowości

Panel pokazuje oczekiwanie na ACK, anulowanie oczekujące, nieodwracalne usuwanie i usunięcie danych aktywnych. Nie oferuje publicznego przycisku wywołującego worker/purge. Potwierdzenie anulowania pochodzi z autorytatywnego statusu, nie z samego zwróconego UUID.

`active_data_erased` nie oznacza zakończenia okresu kopii, usunięcia pobranych plików ani nieobsługiwanych kopii dostawcy. R4 — harmonogram, aktywacja delegacji, monitoring i produkcyjna próba restore — pozostaje oddzielnym etapem. SC-012/019 mają otwarte osobne PR-y; nowe trwałe tabele wymagają nowych adapterów i przeglądu sygnatury.

## Weryfikacja i przekazanie

Wymagane testy: pełny graf dwóch firm, izolacja każdej roli, brak możliwości samopotwierdzenia ACK przez worker, fałszywy kontekst/GUC, obce UUID, stare UUID po purge, współdzielone metadane, schemat/polityka/hold, dwa wykonawcy, cancel/erasing, revoke po ACK, trwały rejestr i utrata odpowiedzi, restore sprzed request/policy oraz niepełny watermark. Dalej pełne regresje R1/R2/B1/B2/SC006/008/009, typecheck/build/HTTP i niezależny review.

Wyniki, SHA i znane blokady są utrzymywane w PR. Integracja wymaga OWNER ACCEPTANCE. Produkcja i rzeczywiste usuwanie wymagają osobnej zgody i kompletnego przygotowania środowiska.

Lokalnie: testy wykonania R3 10/10, rejestru 8/8, regresje R1 27/27 i R2 27/27, B1/B2 DB28/28; typecheck/build PASS. Niezależny review kodu PASS po poprawkach restore, ponowień, potwierdzeń i izolacji. Rzeczywiste wyścigi PostgreSQL oraz wynik końcowego head wymagają CI.
