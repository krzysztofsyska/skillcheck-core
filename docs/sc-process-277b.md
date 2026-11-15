# SC-PROCESS — część B: dalsza obserwacja

TASK: SC-PROCESS-277B
LEVEL: L3
SCOPE: FULLSTACK
OWNER: Codex / builder
REVIEWER: niezależna sesja
DEPENDS ON: #434, #435
PRODUCTION_APPROVAL: NO

## Zakres

Właściciel 13.11.2026 zlecił wykonanie części B #277: oceny wewnętrzne i przy awansie oraz obserwacje 30/90/180 dni. Nie otwiera to pozostałego zakresu #18/#19: brak Talent Pool, matchingu, uczenia modelu i automatycznych decyzji kadrowych. Produkcja pozostaje osobną bramką.

Na stronie etapów oceny zgłoszenia znajduje się dalsza obserwacja. Właściciel tworzy odrębny, niezmienny cel (`post_hire`, `internal_assessment`, `promotion`) z datą rozpoczęcia, kryteriami oraz wynikiem początkowym i źródłami dowodów zapisanymi przez człowieka. Nie oznacza to zatrudnienia ani awansu w żadnej innej części systemu. Wskazanie rzeczywistego zatrudnienia i jego wyników jest deklaracją uprawnionej osoby.

Każdy cel ma osobne uprawnienia. Właściciel nadaje i odbiera dostęp członkom firmy o roli rekruter. Sama rola rekrutera nie daje odczytu ocen wewnętrznych ani po zatrudnieniu. Obserwator nie uzyskuje dostępu. Nadanie dostępu dotyczy wyłącznie wskazanego celu i pozwala odczytać go oraz dopisać obserwację. Cofnięcie działa przy kolejnej operacji, także z otwartej wcześniej karty.

## Obserwacje i pomiar

Po upływie 30, 90 lub 180 dni uprawniona osoba może raz zapisać obserwację danego okresu. Opisuje faktyczne zadania, wdrożenie, zasoby, wsparcie, autonomię i dowody (albo powód braku pomiaru). Wybiera wykonanie kryteriów: spełnione / niespełnione / brak pomiaru. Osobno zapisuje faktyczny wynik próby i stan zatrudnienia. Dane są niezmienne; wcześniejsze kryteria i wynik początkowy pozostają widoczne obok późniejszych obserwacji.

Wskaźniki strony osoby obejmują tylko dostępne użytkownikowi cele `post_hire` konkretnego zgłoszenia, osobno dla okresu. Diagnostyka rekrutacji pokazuje osobną tabelę 30/90/180 dni z RPC `process_followup_recruitment_metrics`: po jednym najnowszym dostępnym celu po zatrudnieniu na zgłoszenie. Ukryte cele nie ujawniają swojej obecności, cofnięte uprawnienia i zamrożone osoby są wyłączone. Tabela podaje liczbę dostępnych zgłoszeń, licznik, mianownik i braki; odczyt niedostępny nie zamienia się w zero. Przejście próby = liczba `passed` / liczba `passed` + `failed`. Retencja = liczba `yes` / liczba `yes` + `no`. Mianownik nie obejmuje `not_measured` ani niezapisanych okresów; liczba braków jest pokazana osobno. Wynik 0% jest pomiarem, brak danych daje `null`, nigdy zero. Nie są to wskaźniki całej firmy ani ranking pracowników. Oceny przy awansie i wewnętrzne nie zasilają tych mianowników.

Kryteria i wynik początkowy to jawny zapis człowieka, nie automatyczna kopia raportu ani generowany przez AI wynik. Powiązanie `application_id` zapewnia przejście do wcześniejszych etapów i dowodów. System nie traktuje braku obserwacji jako negatywnej oceny.

## Dane i kontrakt

RPC: `process_followup_create`, `process_followup_grant`, `process_followup_record`, `process_followup_read`, `process_followup_recruitment_metrics`. UI nie autoryzuje w zastępstwie bazy. Akcja serwera wiąże zgłoszenie z firmą i rekrutacją z adresu strony, a cel z tym zgłoszeniem; każda operacja ponownie sprawdza uprawnienia w bazie. Żadne API role nie czytają tabel prywatnych bezpośrednio.

Trzy nowe tabele prywatne są objęte R17 inwentarza usuwania danych. Cel, historia nadań dostępu i obserwacje podlegają temu samemu zamrożeniu, retencji i usunięciu co osoba, a nie osobnemu okresowi przechowywania. Nie powstają nowe dane kontaktowe, wysyłki, konta ani wywołania AI. Formularze ostrzegają przed kopiowaniem CV i danych kontaktowych; treść wpisywana przez uprawnioną osobę może zawierać dane osobowe i jest w pełni objęta usuwaniem.

## Weryfikacja

- Formularz → akcja serwera → parametry RPC; odmowa nieuprawnionej roli i celu spoza adresowanego zgłoszenia.
- Wartości ujemne/brak pomiaru i zakres mianownika; Unicode zgodny z PostgreSQL.
- Testy bazy: firma obca, rekruter bez nadania, nadanie/cofnięcie osobno na cel, terminy i niezmienność, freeze/erasure.
- `typecheck`, `build`, regresje procesów, migracji i usuwania danych.
- Niezależny przegląd końcowego commitu i CI przed scaleniem.

## Ograniczenia

Brak edycji już zapisanej obserwacji; późniejsza korekta wymaga odrębnego projektu wersjonowania, nie nadpisania dowodu. Rekruterzy w selektorze są identyfikowani UUID, tak jak istniejący asesorzy. Funkcja nie importuje pracowników, nie generuje zatrudnienia, nie liczy ogólnofirmowej jakości rekrutacji i nie kontaktuje się z osobą.
