# SC-SALES-013 — proces sprzedaży

TASK: SC-SALES-013
STATUS: IMPLEMENTED / awaiting integration acceptance; production paused
LEVEL: L3
SCOPE: FULLSTACK
OWNER: Krzysztof
REVIEWER: Codex (implementation self-review; independent review not claimed)
DEPENDS ON: SC-SALES-006D/E/F, PR #64
BRANCH: feat/sc-sales-013
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

Migracja `20261009141832_sales_pipeline.sql`, utworzona CLI; NIE zastosowana na produkcji.

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
- Gałąź zaczyna się od integration `5f8036e` i zawiera zależność #64 (`4f33ffa`). Konflikty scalania rozwiązano zachowując kontrakty i skrypty obu modułów. Najpierw akceptacja/integracja #64; potem ponowny diff/CI i akceptacja SC-SALES-013. Nie scalać tej gałęzi w celu obejścia akceptacji #64.
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
