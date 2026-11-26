# R1 — strona kandydata na Preview przechodzi całą ścieżkę (26.11.2026)

Zadanie z `docs/ROADMAP.md`, sekcja R1, wiersz „Włączenie testu kompetencji w Preview i przejście
całej ścieżki”. Powtórzenie kroku 1 z `docs/checks/r1-preview-walk-2026-11-25.md` po scaleniu PR #603.
Tylko dane testowe (kandydat w domenie `example.com`), nikomu nic nie wysłano.

**Wynik: krok 1 PASS** — kandydat z linkiem przechodzi na stronie Preview przez pośrednika całą
ścieżkę: wejście, rozpoczęcie, szkic, wysłanie. Kroki 3a i 8b nadal NOT RUN (brak hasła rekrutera
testowego — bez zmian, decyzja właściciela z raportu 25.11).

## Gdzie i na czym

- Preview gałęzi `integration`: wdrożenie `dpl_CruLKeLpYBzvWxWpZAoGijkTkWwo`, commit
  `8a55505cfff7d03fbbedf4052e47e61392aa5760` (PR #603), stan READY, adres aliasu gałęzi
  (`COMPETENCY_BROKER_ORIGIN`).
- Dostęp do chronionej strony: istniejący tymczasowy link udostępnienia tylko do Preview (nie do
  produkcji). Linku nie zapisuję.
- Baza: `skillcheck-preview` (`orbyscrupgnupifzlqxp`). Produkcji nie dotykałem. Wartości zmiennych
  ani sekretów nie czytałem.

## Przygotowanie danych testowych (funkcje aplikacji, jako właściciel testowej firmy)

Dotychczasowy dostęp kandydata A (z 18.11) wygasł, a jego próba jest już wysłana, więc nie da się go
odnowić. Pozostali kandydaci tej rekrutacji nie mają recenzji CV, więc nie mogą trafić na shortlistę.
Dlatego, tymi samymi funkcjami bazy co ekran rekrutera:

1. `save_exercise_definition` — nowe wspólne zadanie „Plan komunikacji fikcyjnego projektu (R1 walk 26.11)”
   (rodzaj „test kompetencji”, 2 kryteria, 30 min), wersja `8e813961-…`;
2. `create_competency_test_grant` — dostęp dla kandydata A z shortlisty (termin startu +2 h),
   dostęp `e93df91b-…`. Reguła R1 sprawdzona przez funkcję przy wydaniu i przy wymianie kodu.

Kod dostępu nie jest nigdzie zapisany; po użyciu jest bezużyteczny (krok 1g).

## Krok 1 — wyniki (przeglądarka, strona `/zadanie-kompetencyjne`)

| # | Krok | Odpowiedź pośrednika | Wynik |
|---|---|---|---|
| 1a | Wejście bez linku | `bootstrap` 200, `inspect` 403 | OK — strona mówi „Nie udało się potwierdzić operacji…” (brak dostępu, zgodnie z założeniem). 25.11 tu było 503. |
| 1b | Wejście z linkiem `#grant=…` | `bootstrap` 200, `exchange` 200, `inspect` 200 | OK — „Czas na wykonanie: 30 min. Licznik ruszy po rozpoczęciu.”; adres w pasku bez kodu |
| 1c | „Rozpocznij zadanie” | `start` 200 | OK — widać tytuł, polecenie, oczekiwany rezultat i termin; **kryteriów oceny nie widać** |
| 1d | „Zapisz szkic” | `save` 200 | OK — „Szkic zapisany.” |
| 1e | „Wyślij odpowiedź ostateczną” | `submit` 200 | OK — „Odpowiedź została przyjęta.” |
| 1f | Odświeżenie strony | `bootstrap` 200, `inspect` 200 | OK — nadal „Odpowiedź została przyjęta.” |
| 1g | Ten sam link w nowej przeglądarce | `exchange` 404 | OK — kod jednorazowy, drugi raz nie działa |
| 1h | Baza Preview | — | OK — próba `06d32e77-…` w stanie „submitted” |

W logu wdrożenia nie ma wpisów `competency_broker_unavailable` z czasu przejścia.

Zrzuty: `docs/checks/screens-2026-11-26/krok1-start.png`, `krok1-zadanie.png`, `krok1-wyslane.png`.

## Co zostaje

- Kroki 3a (AI układa zadanie, rekruter zatwierdza na ekranie) i 8b (sekcja testu na ekranie raportu)
  — NOT RUN, wymagają logowania rekrutera testowego. Pytanie do właściciela bez zmian: ustawić hasło
  wyłącznie dla konta testowego w `example.com` w bazie Preview? Rekomendacja: TAK.
- Ocena człowieka z cytatami dla nowej próby nie była częścią kroku 1 (sprawdzona w bazie 18.11, krok 7).
