# Obserwacje wykonania zadań

Migracja 20261004000100_exercise_observations.sql wykonana w Supabase 2026-10-04 po sprawdzeniu braku tabeli, widoku i RPC. SQL Editor potwierdził Success. Siedmiu migracji nie ponawiać.

Każdy zapis dopisuje wersję oceny dla pary zgłoszenie + identyfikator niezmiennej wersji definicji. Praca do 20 000 znaków, osobne rating/evidence dla każdego kryterium w kolejności rubryki. Poziomy below/meets/above wymagają dowodu, insufficient_data pozostaje osobnym wynikiem. Baza ponownie waliduje liczbę, indeksy, typy i długości, ignoruje podrobione metadane. Autor pochodzi z sesji. Brak punktacji, rankingu i decyzji rekrutacyjnych.

Tabela exercise_observation_entries ma RLS odczytu firmy. Właściciel/rekruter zapisuje wyłącznie przez save_exercise_observations, viewer czyta. Złożone klucze obce i RPC nie pozwalają mieszać firm/rekrutacji. Bezpośredni INSERT/UPDATE/DELETE nie jest dostępny. Widok latest_exercise_observations ma security_invoker. Historia jest usuwana kaskadowo z usunięciem rodzica; to nie jest niezależne archiwum retencyjne.

Transakcyjne blokady rodziców i blokada pary zgłoszenie/definicja serializują zapisy. expected_version sprawdza konflikt PT409, również przy ponowieniu pierwszego zapisu. Zamknięty proces i odebrana rola blokują zapis. Nowa wersja definicji nie zmienia poprzedniej pracy ani kryteriów: użytkownik wybiera dokładną wersję wykonanej próby. Zmiana aktualnego profilu jest oznaczona w UI, nie przelicza oceny dawnej wersji zadania.

Link z etapów zgłoszenia prowadzi do wyboru wersji zadań (25 na stronę), formularza i historii (20 na stronę). Serwer sprawdza sesję, firmę, rekrutację i zgłoszenie; również w akcji zapisu. Formularz zachowuje tekst i wybory po błędzie, blokuje pola w trakcie zapisu i aktualizuje wersję tylko po potwierdzeniu RPC. Przy brakującej migracji nie udaje działającego zapisu.

Weryfikacja lokalna: build/TypeScript, test:assessments 26 raportowanych testów (w tym dwa nadrzędne), test:http oraz test:live-check 5/5. PGlite wykonuje wszystkie siedem migracji, sprawdza dwie firmy i role, historię, autora, błędne JSON, stare wersje, statusy oraz zachowanie dawnej rubryki. Nie zastępuje dwóch rzeczywistych sesji Auth ani wyścigu równoczesnych połączeń. Próba zalogowanego UI pozostaje do wykonania po publikacji Preview.

## Uzupełnienie audytu 2026-10-04

Próba zalogowanego Preview 4c4a369 przeszła: zapis v1/v2, utrzymanie pól, autor i historia dla niezmiennej rubryki, konflikt starego okna z zachowaniem tekstu i bez nadpisania. Szczegóły i granice: [audit-2026-10-04.md](audit-2026-10-04.md). Nadal nie potwierdzono dwóch rzeczywistych firm ani równoczesnych połączeń.
