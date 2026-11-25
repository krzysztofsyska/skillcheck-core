# R1 — ponowne przejście ścieżki testu kompetencji na Preview (25.11.2026)

Zadanie z `docs/ROADMAP.md`, sekcja R1, wiersz „Włączenie testu kompetencji w Preview i przejście
całej ścieżki”. Powtórzone kroki 1, 3a i 8b z `docs/checks/r1-preview-walk-2026-11-18.md`. Tylko dane
testowe, nikomu nic nie wysłano.

**Wynik: nadal częściowo.** Strona kandydata jest już włączona na Preview (nie ma 404), ale jej
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

- Na adresie pojedynczego wdrożenia (`…-o97hoxykv-…vercel.app`) odpowiedź bootstrapu to **403**
  — to zgodne z kodem: `lib/competency-attempt-broker.ts:239` odrzuca żądania spoza przypiętego
  adresu (`COMPETENCY_BROKER_ORIGIN`).
- Na aliasie gałęzi (`skillcheck-core-git-integration-krzysztofs-projects-b7ce87b5.vercel.app`) odpowiedź to
  **503**. W `lib/competency-attempt-broker-runtime.ts` 503 zwraca `competencyBrokerPost`, gdy
  `COMPETENCY_BROKER_ENABLED` nie jest `true` albo gdy `construct()` rzuci wyjątek (zły/niepełny
  `COMPETENCY_BROKER_ORIGIN` — musi być `https`, bez ścieżki; klucze `…_CSRF_KEY` / `…_SOURCE_HMAC_KEY` nie
  w formacie 64 znaków hex; `COMPETENCY_BROKER_LIMITER` inny niż `postgres`/`redis`; błędny
  `COMPETENCY_BROKER_GATEWAY_DATABASE_URL`). Wyjątek jest połykany celowo (bez logu), więc z zewnątrz nie
  da się rozróżnić przyczyn; w logach uruchomieniowych Vercel nie ma wpisów.
- Sprawdziłem po stronie bazy Preview: login `competency_gateway_preview` istnieje, może się logować i jest
  członkiem roli `competency_test_gateway` (ta rola nie ma loginu) — baza jest przygotowana.
- Czego nie wiem: która dokładnie zmienna jest zła lub brakuje (agent nie czyta wartości). To wygląda na
  konfigurację, nie na błąd kodu. Nie znalazłem błędu w kodzie do opisania.

## Blokery

1. **503 pośrednika na Preview `integration`** — ktoś z dostępem do wartości zmiennych (właściciel) musi
   sprawdzić zmienne `COMPETENCY_BROKER_*` według listy powyżej (najpierw `COMPETENCY_BROKER_ORIGIN` =
   `https://skillcheck-core-git-integration-krzysztofs-projects-b7ce87b5.vercel.app` bez końcowej
   ścieżki, i `COMPETENCY_BROKER_LIMITER`). Propozycja na przyszłość: dodać do kodu rozróżnialny, bezpieczny
   kod przyczyny w logu (bez wartości), żeby agent mógł to diagnozować sam — to byłoby osobne zadanie.
2. **Brak hasła rekrutera testowego** — kroki 3a i 8b wymagają zalogowania. Propozycja: osobny test-login
   tylko dla Preview (hasło ustawia właściciel i wpisuje jako sekret sesji agenta) albo zgoda, żeby agent
   ustawił hasło konta `example.com` w bazie Preview. Bez tego agent tych kroków nie przejdzie.
3. Krok 3a dodatkowo wymaga `EXERCISE_AI_ENABLED=true` na Preview (ustawione według PR #599; nie
   zweryfikowane, bo nie ma jak wejść na ekran).

## Dane testowe

Niczego nowego nie dodałem do bazy Preview. Dane z 18.11 (shortlista, zadanie, dostęp, próba, ocena) nadal
tam są. Zrzut ekranu strony kandydata (komunikat po 503): `docs/checks/screens-2026-11-25/krok1-strona-kandydata.png`.
