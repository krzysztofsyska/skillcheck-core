# SC-SALES-013 — proces sprzedaży

TASK: SC-SALES-013
STATUS: FIXING — poprawki review na gałęzi wydania; scalenie do main ZABLOKOWANE
LEVEL: L3
SCOPE: FULLSTACK
OWNER: Krzysztof
REVIEWER: Codex (niezależny review PR #100; poprawki w toku)
DEPENDS ON: SC-SALES-006D/E/F, PR #64
BRANCH: release/sales-only-20261011
ISSUE: #70
OWNER_APPROVAL: NO
PRODUCTION_APPROVAL: NO

## Co jest gotowe

- `/operator/sales`: lista, etapy Nowe / Rozmowa / Oferta wysłana / Wygrane / Przegrane, filtry etapu i terminu, strony po 20 zgłoszeń. Filtry działają w bazie przed paginacją, nie tylko na pierwszych 50 rekordach.
- `/operator/sales/[id]`: dane kontaktowe, opis potrzeb, odpowiedź przez własną pocztę, notatka do 2000 znaków, data kolejnego kontaktu, historia wersji z paginacją.
- Terminy Na dziś i Zaległe obliczane według Europe/Warsaw. Są przypomnieniami w panelu, bez dodatkowej automatycznej wysyłki.
- Ręczne powiązanie z istniejącą firmą: wyszukiwanie po co najmniej dwóch znakach, maksymalnie 20 wyników, nazwa i UUID do rozróżnienia. Powiązanie nie tworzy firmy ani członkostwa, nie nadaje dostępu do rekrutacji.
- Zapis sprawdza wersję. Dwie edycje tego samego zgłoszenia nie nadpisują się po cichu. Konflikt zachowuje tekst w formularzu.
- Wygrana wymaga wskazania istniejącej firmy. Wygrana i przegrana wymagają checkboxa potwierdzenia, kończą edycję i usuwają termin kontaktu. To status handlowy, bez płatności i automatycznych umów.
- Przegrana korzysta z tego samego zakończenia i sześciomiesięcznej retencji co 006E; notatki, historia i powiązanie są usuwane kaskadowo. Nie usuwa to firmy klienta. Wygrane nie są traktowane jak rozmowy zakończone bez umowy.
- Dotychczasowy panel ma odnośnik do procesu sprzedaży. Stare RPC zakończenia synchronizuje przegraną i nie pozwala zamknąć wygranej jako przegranej.

## Baza i kontrakt

Migracja `20261009141832_sales_pipeline.sql`, utworzona CLI. Plik poprawiono 2026-10-14 (trigger przed backfillem). Jeśli poprzednia wersja jest już w historii bazy, nie powtarzać jej; ta edycja nie była wykonywana na produkcji.

Prywatne tabele `sales_pipeline` i `sales_pipeline_events`: RLS oraz brak bezpośrednich grantów dla anon/authenticated. Oryginalne zgłoszenie pozostaje niemodyfikowalne. Migracja inicjalizuje metadane istniejących zgłoszeń, uwzględniając wcześniejsze zakończenia; nowe zgłoszenia inicjalizuje trigger.

RPC `list_sales_pipeline`, `save_sales_pipeline`, `sales_pipeline_history`, `find_sales_companies`: tylko authenticated i aktualna lista operatorów. Pusta ścieżka wyszukiwania; blokada wspólna z nadaniem/cofnięciem operatora. Zapis atomowy: wersja, metadata, historia i ewentualne zakończenie. Użytkownik zwykłej firmy nie jest operatorem.

Powiązania do firm są tylko metadanymi handlowymi. Nowe RPC nie udostępniają kandydatów, użytkowników, właścicieli firmy ani dokumentów. Historia przechowuje poprzednie notatki i identyfikator autora wewnętrznie, UI pokazuje wersję i czas. Nie ma eksportu danych ani publicznego endpointu z danymi zgłoszeń.

## Weryfikacja

- Typecheck i produkcyjny build lokalnie.
- Test DB: anon, użytkownik, operator, cofnięty operator, walidacja, brak firmy, przejścia końcowe, wykrycie starej wersji, brak zapisu przy no-op, historia, filtry, pełna paginacja, retencja z cascade.
- Wariant PostgreSQL w CI dodatkowo uruchamia pięć równoczesnych zapisów tej samej wersji: oczekuje jednego sukcesu, czterech konfliktów i jednego wpisu historii. Lokalna próba uruchomienia osobnego Postgresa była zablokowana konfiguracją użytkownika systemowego; lokalne testy SQL uruchomiono w PGlite. Wynik rzeczywistej współbieżności należy czytać z Checks dla PR.
- HTTP: sesja, rola, cofnięcie, parametry filtrów, 404, błędy bez PII/SQL, escapowanie treści.
- Chromium 1280 i 390 px: wyszukanie firmy, zapis etapu/notatki/terminu, zachowanie pól po zapisie i konflikcie, cofnięte uprawnienia, wymagane potwierdzenie zakończenia, filtrowanie i wylogowanie, brak poziomego przewijania.
- Regresje: kontrakt DB, zgłoszenia, dotychczasowa skrzynka operatora, formularz HTTP, automat potwierdzenia; bez rzeczywistych klientów i wysyłki.

## Ograniczenia i uruchomienie

- Produkcja nadal wstrzymana na życzenie właściciela. Przygotowanie kodu nie oznacza uruchomienia formularza.
- P1, promocja: ta gałąź wydania ma rodzica `main` `76760b7`, a nie `integration`. Scalenie PR #100 do `main` pominęłoby checkpoint integration i rozstrzygnięcie konfliktów z zaakceptowaną pracą. Tego PR nie wolno scalać do `main`. Promocja produkcji ma powstać od nowa jako `integration -> main` dopiero wtedy, gdy zależności i te poprawki są już na `integration`. Ta zmiana nie przełącza bazy PR, nie zastępuje gałęzi całą `integration` i nie osłabia reguły classify-pr. Decyzja o odtworzeniu promocji zostaje przy orkiestratorze.
- Po osobnej zgodzie produkcyjnej: zastosować brakujące migracje 006B/E/F, następnie 013, zachowując istniejącą historię migracji; wdrożyć aplikację w zatwierdzonym procesie integration → main; wykonać test własnego zgłoszenia i uprawnień.
- Scheduler retencji i aktywacja formularza/maila pozostają opisane w 006E/F. Ta zmiana ich nie uruchamia.
- Zamknięte zgłoszenia nie mają ponownego otwarcia. Korekty terminalnych decyzji i polityka retencji dokumentacji umów są osobnym zakresem. Przed produkcyjnym użyciem statusu Wygrane właściciel musi ustalić retencję dokumentacji klienta; automat usuwania przegranych nie usuwa wygranych.
- Korespondencja pozostaje w skrzynce pomoc@skillcheck.pl; historia panelu nie jest archiwum e-maili. Generator ofert, płatności i powiadomienia poza panelem nie należą do SC-SALES-013.

## Poprawki po przeglądzie — 2026-10-10

- R1: karta montuje formularz ponownie dla pary identyfikator/wersja (oraz wyszukiwania firmy). Pola i expected_version po rewalidacji pochodzą z tego samego odczytu. Konflikt nadal zachowuje niezapisany szkic. Dodano regresję Chromium: drugi operator zapisuje między RPC a odczytem RSC, następny zapis nie przywraca starej notatki.
- R2: skrzynka kontaktowa prowadzi każde zgłoszenie do karty procesu. Usunięto mylący status „Otrzymane” i stary formularz zakończenia bez umowy; status oraz zakończenie obsługuje karta procesu. Wygrana bez closed_at nie oferuje już błędnej akcji. RPC pozostają zgodne wstecznie.
- Walidacja lokalna: build (po usunięciu uszkodzonego cache Turbopack), typecheck, 2 testy modułu, 16 testów HTTP/Chromium panelu i skrzynki PASS. Chromium 1280/390 px, syntetyczny backend, bez wysyłki wiadomości i bez zdalnych zmian DB.
- Ponowny przegląd autora: oba zgłoszone defekty naprawione. To nie jest niezależny review. CI nowego commitu wymaga osobnego potwierdzenia.
- Zależność PR #64, akceptacja właściciela i osobna zgoda produkcyjna nadal obowiązują. Retencja wygranych pozostaje do ustalenia. Nie wdrożono na produkcję.

## Poprawki po niezależnym review PR #100 — 2026-10-14

- P2, wygasły lease `sending`: `claim_sales_mail` tłumi też wygasłe wiersze `sending` zamkniętej rozmowy, zanim scheduler może je ponownie przejąć. Aktywny lease pozostaje do czasu wygaśnięcia, żeby dokończenie wysyłki nadal mogło zapisać wynik.
- P2, inicjalizacja pipeline: migracja najpierw blokuje `sales_leads` i `sales_lead_closures`, instaluje trigger, potem wykonuje backfill z `on conflict (lead_id) do nothing`.
- P2, UUID: `isUuid` wymaga całej wartości — kotwice `^` i `$` oraz długość 36. Sufiks nie przechodzi do RPC; trasa zwraca 404.
- P2, przeglądarka: Checks instaluje Playwright Chromium i ustawia `PLAYWRIGHT_MODULE`. W CI brak tej zmiennej kończy test błędem, zamiast po cichu pominąć scenariusz.
- P1, promocja: BLOCKED. Nie scalać tej gałęzi do `main`. Nie uruchamiano migracji na bazie współdzielonej ani produkcyjnej. Jeśli poprzednie wersje tych dwóch migracji są już zapisane w historii bazy, nie wolno ich powtarzać; zmiana pliku nie aktualizuje wtedy żywej funkcji. Naprawa takiej bazy wymaga osobno zatwierdzonej migracji forward i nie została wykonana w tym zadaniu.
