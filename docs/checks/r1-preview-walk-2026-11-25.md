# R1 — ponowne przejście ścieżki testu kompetencji na Preview (25.11.2026)

Zadanie z `docs/ROADMAP.md`, sekcja R1, wiersz „Włączenie testu kompetencji w Preview i przejście
całej ścieżki”. Powtórzone kroki 1, 3a i 8b z `docs/checks/r1-preview-walk-2026-11-18.md`. Tylko dane
testowe, nikomu nic nie wysłano.

**Wynik: nadal częściowo** (uzupełnione 26.11.2026 o przyczynę 503, zob. blokery). Strona kandydata jest już włączona na Preview (nie ma 404), ale jej
„pośrednik” odpowiada błędem 503, więc kandydat nie dojdzie do zadania. Kroków 3a i 8b nie dało się
wykonać: wymagają zalogowania rekrutera, a agent nie ma hasła do konta testowego.

## Gdzie i na czym

- Preview gałęzi `integration`: wdrożenie `dpl_GFvinQ1GVmk4SUo8kpMbXJn7hzHH`, commit
  `52fdb6c632f00137e9cb6f7bbb1ba9fbbaeee9f0`, stan READY (zmienne z PR #599 wchodzą w to wdrożenie).
- Dostęp do chronionej strony: tymczasowy link udostępnienia Vercel, tylko do tego wdrożenia Preview
  (nie do produkcji). Linku nie zapisuję.
- Baza: `skillcheck-preview` (`orbyscrupgnupifzlqxp`), tylko odczyt metadanych ról i zliczeń. Produkcji
  nie dotykałem. Wartości zmiennych ani sekretów nie czytałem.

## Kroki i wyniki

| # | Krok | Wynik |
|---|---|---|
| 1 | Strona kandydata `/zadanie-kompetencyjne` na Preview | **CZĘŚCIOWO** — strona zwraca 200 i się wyświetla (18.11 było 404), czyli flaga `COMPETENCY_CANDIDATE_PREVIEW` działa. Ale zaraz po wejściu przeglądarka wywołuje `POST /api/competency/attempt` (operacja „bootstrap”) i dostaje **503**; strona pokazuje „Nie udało się potwierdzić operacji…”. Kandydat nie przejdzie dalej. |
| 3a | AI układa wspólne zadanie, rekruter zatwierdza | **NOT RUN** — ekran rekrutera wymaga logowania (e-mail + hasło), a agent nie ma hasła do konta testowego w `example.com`. Nie zmieniałem haseł ani nie omijałem logowania. |
| 8b | Sekcja testu na ekranie raportu kandydata | **NOT RUN** — jak wyżej, ekran za logowaniem. |

Dodatkowo: `/dashboard` bez logowania przekierowuje na `/login` (zgodnie z oczekiwaniem).

## Szczegóły kroku 1 (diagnoza)

Przyczyna 503 jest **nieustalona**. Z zebranych danych nie da się jeszcze wskazać, która ścieżka w kodzie
daje tę odpowiedź, i nie twierdzę, że to konfiguracja ani błąd kodu.

Obserwacje:

- Na aliasie gałęzi (`skillcheck-core-git-integration-krzysztofs-projects-b7ce87b5.vercel.app`) odpowiedź
  to **503**.
- Na adresie pojedynczego wdrożenia (`…-o97hoxykv-…vercel.app`) odpowiedź bootstrapu to **403**
  (`lib/competency-attempt-broker.ts`, sprawdzenie adresu pochodzenia, które odrzuca adres inny niż
  przypięty w `COMPETENCY_BROKER_ORIGIN`).
- W logach uruchomieniowych Vercel nie ma wpisów o przyczynie. Wyjątki są łapane celowo, bez logu.

Wszystkie ścieżki, które w kodzie dają 503 (żadna nie została jeszcze wykluczona):

A. Uruchomienie pośrednika (`lib/competency-attempt-broker-runtime.ts`). Każdy błąd przy starcie jest
łapany i zwraca 503:
- `COMPETENCY_BROKER_ENABLED` nie jest równe `true`;
- adres `COMPETENCY_BROKER_ORIGIN` nie jest czystym `https` (ścieżka, zapytanie lub dane logowania w adresie);
- klucze `COMPETENCY_BROKER_CSRF_KEY` lub `COMPETENCY_BROKER_SOURCE_HMAC_KEY` nie mają 64 znaków hex;
- `COMPETENCY_BROKER_LIMITER` ma inną wartość niż `postgres` albo `redis`;
- adres bazy dla pośrednika jest błędny, niebezpieczny albo brak loginu;
- weryfikacja roli pośrednika w bazie się nie powiodła;
- pula połączeń jest przeciążona.

B. Obsługa żądania (`lib/competency-attempt-broker.ts`). Te błędy pojawiają się dopiero przy wywołaniu,
więc sam fakt, że login i rola w bazie istnieją, ich nie wyklucza:
- brak zaufanego adresu źródłowego (poza Vercel, czyli gdy `VERCEL` nie jest `1`, nagłówek
  `X-Forwarded-For` jest pusty albo zawiera przecinek);
- przekroczony limit równoczesnych żądań w jednej instancji (8 miejsc);
- współdzielony limiter rzuca błąd: połączenie z bazą, weryfikacja roli, funkcja
  `private.consume_competency_rate_limit` albo przeciążenie puli (`lib/competency-postgres-limiter.ts`).
  Błąd przy żądaniu zeruje też pośrednika, więc następne żądanie uruchamia go od nowa.

Jak czytać obserwację 403: kontrola adresu pochodzenia jest dopiero po sprawdzeniu „włączony”, więc 403 na
adresie wdrożenia wskazuje, że przy starcie się udało. To sugeruje raczej ścieżkę B niż A. To tylko
wniosek z dwóch odpowiedzi, nie dowód: adresy mogą trafiać do różnych instancji, a logi nie mówią, która
ścieżka odrzuciła żądanie.

Co już sprawdzono po stronie bazy Preview: login `competency_gateway_preview` istnieje, może się logować i
jest członkiem roli `competency_test_gateway` (ta rola nie ma loginu). To nie dowodzi, że limiter działa,
bo jego sprawdzenie odbywa się dopiero przy żądaniu.

## Blokery

1. **503 pośrednika na Preview `integration` — przyczyna ustalona 26.11.2026, naprawia agent.**
   Kod przyczyny w logu jest na `integration` od PR #601. Agent otworzył stronę kandydata raz na nowym
   Preview (`dpl_qfTQY1ZWFvisLHw7eG1SLKhD891B`, commit `682a1ba`); bootstrap znów dał 503, a log serwera
   pokazał: `{"event":"competency_broker_unavailable","reason":"limiter_unavailable","detail":"connect"}`.
   Czyli pośrednik uruchomił się poprawnie (ścieżka A wykluczona), a nie udało się nawiązać połączenia
   z bazą Preview (ścieżka B, limiter).
   Prawdopodobna przyczyna: bezpośredni adres bazy `db.orbyscrupgnupifzlqxp.supabase.co` ma tylko adres
   IPv6 (DNS: rekord AAAA jest, rekordu A nie ma), a funkcje Vercel łączą się wyłącznie po IPv4. To ryzyko
   było opisane w `docs/checks/r1-preview-setup-2026-11-18.md`.
   Naprawa po stronie agenta, bez nowego sekretu i bez kosztów: osobny PR R1 pozwala pośrednikowi łączyć
   się przez darmowy pooler Supabase (tryb sesji, adres IPv4), z hostem poolera w jawnej zmiennej tylko dla
   Preview; hasło zostaje w obecnym sekrecie. Płatny dodatek IPv4 Supabase nie jest potrzebny.
2. **Hasło do konta rekrutera testowego (kroki 3a i 8b).** Propozycja agenta: ustawić hasło wyłącznie dla
   konta testowego w `example.com` w bazie Preview, bez zmian na produkcji i bez prawdziwych danych.
   **TAK/NIE?** Rekomendacja: TAK. Powód: zmienia to dane logowania, więc potrzebna jest Twoja zgoda.
3. Krok 3a dodatkowo wymaga `EXERCISE_AI_ENABLED=true` na Preview (ustawione według PR #599; nie
   zweryfikowane, bo nie ma jak wejść na ekran).

## Dane testowe

Niczego nowego nie dodałem do bazy Preview. Dane z 18.11 (shortlista, zadanie, dostęp, próba, ocena) nadal
tam są. Zrzut ekranu strony kandydata (komunikat po 503): `docs/checks/screens-2026-11-25/krok1-strona-kandydata.png`.
