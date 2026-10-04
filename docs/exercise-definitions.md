# Definicje zadań kompetencyjnych i Assessment Center

Migracja `20261002000300_exercise_definitions.sql` jest przygotowana i przetestowana lokalnie. Nie wykonano jej jeszcze w docelowym Supabase. Pięć wcześniejszych migracji pozostaje wykonanych i nie należy ich ponawiać. Docelowa baza nadal ma 11 tabel i 38 polityk; ta migracja dodaje jedną tabelę, jedną politykę odczytu, widok i RPC.

Definicja obejmuje rodzaj zadania, tytuł, instrukcję, oczekiwany rezultat, czas 1–180 minut i 1–12 kryteriów. Kryterium zawiera kompetencję oraz trzy odrębne opisy obserwowalnych zachowań: poniżej, zgodnie i powyżej wymagań. Brak danych będzie osobnym wynikiem obserwacji; nie jest opisem oczekiwanego zachowania. Walidator nie generuje punktów, rankingu ani decyzji rekrutacyjnej.

## Kontrakt zapisu

`save_exercise_definition(target_recruitment, target_exercise, new_definition, expected_version, expected_position_id, expected_position_updated_at)` zwraca identyfikator nowej wersji. `target_exercise` to UUID generowany raz dla nowego formularza, zachowywany przy ponowieniu. Pierwszy zapis wymaga wersji 0; kolejne podają aktualną wersję. Ponowne wysłanie starej wersji powoduje PT409, nie tworzy kolejnego zadania. Ten sam identyfikator nie może zostać przeniesiony do innej firmy ani rekrutacji.

RPC sam ustala firmę, autora, datę oraz kopię aktualnego profilu stanowiska. Sprawdza rolę właściciela/rekrutera, rekrutację draft/open i niezarchiwizowane stanowisko. Nie ufa firmie ani punktacji przesłanej w JSON. Baza ponownie waliduje wszystkie pola, duplikaty kompetencji i identyczne opisy po normalizacji Unicode. Pozostałe pola JSON są pomijane. Limity tekstu w TypeScript liczą jednostki UTF-16, w PostgreSQL znaki; frontend może zatem być bardziej restrykcyjny dla znaków spoza BMP.

Każdy zapis dopisuje wiersz `exercise_definition_entries`. Poprzednie wersje nie mają grantów zmiany/usunięcia dla klientów API. Widok `latest_exercise_definitions` używa security_invoker; zarówno historia, jak i najnowsze definicje podlegają RLS firmy. Viewer może czytać. Usunięcie rekrutacji usuwa historię kaskadowo zgodnie z modelem danych, więc nie jest to niezależne archiwum retencyjne. Blokady rodziców i transakcyjna blokada identyfikatora zadania chronią kontekst zapisu. Zmiana profilu lub wersji daje PT409 i wymaga porównania danych.

Typy klienta Supabase obejmują RPC, tabelę tylko do odczytu i widok. Przyszły formularz powinien najpierw użyć `parseExerciseDefinition`, sprawdzić sesję i firmę, zachować wpisany tekst przy konflikcie oraz filtrować odczyt po firmie i rekrutacji. Oceny wykonania muszą odnosić się do konkretnego `id` wersji definicji, a nie do dynamicznego widoku najnowszej wersji.

## Testy i pozostały zakres

`npm run test:assessments` obejmuje dotychczasowe etapy, walidator i faktyczne wykonanie migracji w PostgreSQL/PGlite. Nowe przypadki sprawdzają dwie firmy, owner/recruiter/viewer/anon, odebrane członkostwo, niezmienność historii, duplikację pierwszego zapisu, zmianę profilu, niezależną walidację JSON, zamknięty proces i zachowanie autora/kopii profilu. Testy wykonują sekwencyjne konflikty; nie potwierdzają wyścigu dwóch połączeń ani rzeczywistego Supabase Auth.

Dodano strony listy (25 zadań na stronę), tworzenia, edycji i historii (20 wersji na stronę), dostępne z rekrutacji. Wszystkie odczyty sprawdzają sesję oraz filtrują firmę i rekrutację. Formularz zachowuje dane przy błędzie, zamraża wersję/profil z chwili otwarcia i zwiększa lokalną wersję tylko po potwierdzonym zapisie. Viewer i zamknięty proces mają odczyt historii; brak migracji wyświetla komunikat bez formularza. Zmiana profilu stanowiska jest oznaczona ostrzeżeniem.

2026-10-04: build/TypeScript, 16 raportowanych testów etapów/definicji/migracji i test HTTP anonimowych wejść do trzech nowych tras przeszły. To nie jest jeszcze zalogowany test nowego interfejsu. Sesja Supabase w przeglądarce wygasła (Session expired); nie wykonano nowej migracji. Pozostają migracja docelowa, testy interakcji i zapisu Preview, obserwacje wykonania i raport. Nie przedstawiać tej zmiany jako gotowego całego modułu Assessment Center.
