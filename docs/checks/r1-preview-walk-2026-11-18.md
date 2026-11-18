# R1 — przejście ścieżki testu kompetencji na Preview (18.11.2026)

Zadanie z `docs/ROADMAP.md`, sekcja R1, wiersz „Włączenie testu kompetencji w Preview i przejście
całej ścieżki”. Tryb: **„zatwierdzam sam”** (ręczny). Tylko dane testowe.

**Wynik: częściowo.** Cała ścieżka działa w bazie Preview (`skillcheck-preview`), ale na stronie
Preview nie da się jej przejść, bo test kompetencji jest tam wyłączony (brakuje zmiennych w Vercel,
patrz „Blokery”). Zgodnie z zasadami nie zmieniałem żadnych ustawień Vercel.

## Gdzie i na czym

- Preview gałęzi `integration`: wdrożenie `dpl_BR8iKMMazMmmmLsofgFsxd3E841f`, commit
  `21427382837bb47fa6bbc0a52b649b5890f0d4d4`, stan READY.
- Baza: projekt testowy `skillcheck-preview` (`orbyscrupgnupifzlqxp`). Produkcji nie dotykałem.
- Firma testowa `8805e19d-…`, właściciel konta z adresem w domenie `example.com`, rekrutacja
  `32403306-…` (5 fikcyjnych zgłoszeń z gotową analizą CV). Obaj kandydaci użyci w teście mają
  adresy w `example.com`.
- Nikt nie dostał żadnej wiadomości: wydanie dostępu zwraca tylko jednorazowy kod, nic nie wysyła.
  Kodu nie zapisałem w tym dokumencie.
- Zrzutów ekranu nie ma: strona Preview jest chroniona logowaniem Vercel, a ekrany testu są i tak
  wyłączone (patrz niżej). Dowodem są odpowiedzi strony i bazy opisane poniżej.

## Kroki i wyniki

Kroki 2–7 wykonałem wywołaniami tych samych funkcji bazy, których używa aplikacja, jako zalogowany
właściciel testowej firmy (te same sprawdzenia uprawnień co w aplikacji).

| # | Krok | Wynik |
|---|---|---|
| 1 | Strona kandydata `/zadanie-kompetencyjne` na Preview | **NIE DZIAŁA NA PREVIEW** — odpowiedź 404 „Zadanie niedostępne.” (flaga wyłączona) |
| 2 | Kandydat A dodany na shortlistę rekrutacji (ręcznie, z notatką „R1 preview walk”) | OK — wpis `b812dc2c-…` |
| 3a | AI układa wspólne zadanie, rekruter zatwierdza | **NIE SPRAWDZONE** — generowanie AI wyłączone na Preview (brak `EXERCISE_AI_ENABLED`) |
| 3b | Rekruter sam zapisuje wspólne zadanie (rodzaj „test kompetencji”, 2 kryteria, 30 min) | OK — wersja zadania `ded13ea7-…` |
| 4 | **Reguła R1:** dostęp dla kandydata B, który NIE jest na shortliście | OK — odmowa „Resource unavailable” z miejsca w bazie, które sprawdza shortlistę |
| 5 | Dostęp dla kandydata A z shortlisty (termin startu +2 h) | OK — dostęp `bb0b3d32-…`, wersja 1 |
| 6 | Kandydat A: wymiana kodu na sesję, start, wysłanie odpowiedzi | OK — próba `7249b885-…`, stan „submitted”. Kandydat przy starcie widzi tytuł, polecenie, oczekiwany wynik i czas, **nie widzi** kryteriów oceny |
| 7a | Ocena człowieka z cytatami (2 kryteria „zgodnie z wymaganiami”, cytaty z odpowiedzi) | OK — ocena `111ce45f-…`, status „review_required” |
| 7b | Ocena z „cytatem”, którego nie ma w odpowiedzi | OK — odmowa „Exact visible evidence required” |
| 8a | Dane dla sekcji testu w raporcie kandydata (te same funkcje, z których czyta raport) | OK — lista prób kandydata A pokazuje próbę „submitted”, odpowiedź zawiera ocenę z obu cytatami; kandydat B nie ma żadnej próby |
| 8b | Sekcja testu na ekranie raportu kandydata na Preview | **NIE DZIAŁA NA PREVIEW** — sekcja jest ukryta tą samą flagą co strona kandydata |
| 9 | Tryb „Automatycznie” | **NIE SPRAWDZONE** — znany błąd naprawiany osobno (R1-AUTO-GEN-FIX); tu nie ruszałem |

## Odstępstwo od prawdziwej ścieżki (uczciwie)

Krok 6 aplikacja wykonuje rolą bazy `competency_test_gateway` (pośrednik strony kandydata). Z narzędzia
do bazy nie mogłem przełączyć się na tę rolę (brak uprawnienia do zmiany roli), więc te trzy funkcje
wywołałem rolą administratora bazy Preview. Logika i sprawdzenia w funkcjach są te same (reguła R1
jest sprawdzana ponownie przy wymianie kodu), ale uprawnienia samej roli pośrednika nie zostały tu
sprawdzone. Sprawdzają je testy w CI (`tests/competency-*`).

## Blokery (decyzja / kliknięcie właściciela — agent nie zmienia zmiennych Vercel)

Na Preview gałęzi `integration` (i w całym projekcie Vercel) **nie istnieje żadna** z tych zmiennych:

- `COMPETENCY_CANDIDATE_PREVIEW=true` — włącza stronę kandydata, ekrany testu u rekrutera i sekcję w raporcie;
- `COMPETENCY_BROKER_ENABLED=true` — włącza pośrednika strony kandydata;
- `COMPETENCY_BROKER_GATEWAY_DATABASE_URL` — połączenie pośrednika z bazą **Preview** dedykowanym loginem `competency_gateway_<nazwa>` (sekret; hasło tego loginu ustawia właściciel). Login jest członkiem roli `competency_test_gateway`, a sama rola `competency_test_gateway` nie ma loginu. Login o innej nazwie kończy się odpowiedzią 503 (zgodnie z `docs/sc-wer-001-preview-runtime.md`);
- `COMPETENCY_BROKER_ORIGIN` — adres strony Preview, z którego pośrednik przyjmuje żądania;
- `COMPETENCY_BROKER_CSRF_KEY` i `COMPETENCY_BROKER_SOURCE_HMAC_KEY` — dwa niezależne klucze, każdy 32 bajty zapisane szesnastkowo (64 znaki `0-9a-f`); sekrety, wartości ustawia właściciel, agent ich nie czyta. Brak któregokolwiek albo zły format kończy się odpowiedzią 503 (`lib/competency-attempt-broker-runtime.ts`, funkcja `key`);
- `COMPETENCY_BROKER_LIMITER` (oraz, zależnie od wybranego rodzaju, `COMPETENCY_BROKER_LIMITER_REST_URL` i `COMPETENCY_BROKER_LIMITER_REST_TOKEN`) — ograniczenie liczby prób;
- `EXERCISE_AI_ENABLED=true` — generowanie zadania przez AI (krok 3a).

Bez nich krok 1, 3a i 8b nie przejdą na stronie Preview. Propozycja, która zdejmuje to z właściciela
na przyszłość: jedna jednorazowa zgoda na ustawienie tych zmiennych tylko dla Preview gałęzi
`integration` (wartości testowe, baza `skillcheck-preview`), potem agent przechodzi ścieżkę w
przeglądarce sam.

## Znalezione błędy

W sprawdzonych krokach nie znalazłem błędów. Brak przejścia na stronie Preview to blokada
konfiguracji (zmienne Vercel), nie błąd kodu.

## Dane testowe zostawione w bazie Preview

Wpis shortlisty `b812dc2c-…`, zadanie `ded13ea7-…`, dostęp `bb0b3d32-…`, próba `7249b885-…`,
ocena `111ce45f-…` — wszystkie w testowej firmie `8805e19d-…` na `skillcheck-preview`. Zostawione
celowo, żeby następne przejście w przeglądarce (po włączeniu flag) miało gotowy wynik w raporcie.
