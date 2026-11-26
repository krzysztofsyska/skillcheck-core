# R1 — kroki 3a i 8b na Preview (26.11.2026, część druga)

Zadanie z `docs/ROADMAP.md`, sekcja R1, wiersz „Włączenie testu kompetencji w Preview i przejście
całej ścieżki”. Dokończenie kroków 3a i 8b z `docs/checks/r1-preview-walk-2026-11-18.md`, po kroku 1
z `docs/checks/r1-preview-walk-2026-11-26.md`. Tylko dane testowe, nikomu nic nie wysłano.

**Wynik: krok 8b PASS, krok 3a NOT RUN** (na Preview nie ma skonfigurowanego klucza dostawcy AI).
Krok 1 został zaliczony 26.11 (część pierwsza).

## Gdzie i na czym

- Preview gałęzi `integration`: wdrożenie `dpl_CGKNmUAcEdS3VLAFvcHgV4xVssZk`, commit
  `9df1ebb1818053aa2f53852f3b8215db6527dcb1` (PR #604), stan READY, adres aliasu gałęzi.
- Dostęp do chronionej strony: istniejący tymczasowy link udostępnienia tylko do Preview (nie do
  produkcji). Linku nie zapisuję.
- Baza: `skillcheck-preview` (`orbyscrupgnupifzlqxp`). Produkcji nie dotykałem. Wartości zmiennych
  ani sekretów nie czytałem.

## Konto testowe rekrutera (tylko Preview)

Zgodnie z `AGENTS.md` (Preview służy do logowań testowych, bez pytania właściciela) utworzyłem
nowe, osobne konto testowe w bazie Preview:

- adres: `r1-walk-recruiter@example.com` (domena `example.com`, adres nie istnieje w prawdziwej poczcie);
- dodane jako członek (rola „rekruter”) istniejącej firmy testowej „Spacer MVP Sp. z o.o. (test)”
  (`8805e19d-…`), tej samej, na której robiono poprzednie przejścia;
- hasło wylosowane, trzymane tylko w pamięci sesji agenta; nie jest zapisane w pliku, commicie ani PR;
- hasła żadnego istniejącego konta nie zmieniałem; nie użyto klucza service-role ani sekretów.

Kolejny agent, który potrzebuje logowania, może ustawić nowe hasło **temu samemu** kontu testowemu
w bazie Preview (zapytanie na `auth.users` w `skillcheck-preview`) i nie musi pytać o hasło.

## Wyniki

| # | Krok | Wynik |
|---|---|---|
| 3a | AI układa wspólne zadanie, rekruter zatwierdza na ekranie rekrutera | **NOT RUN** — ekran „Zadania” pokazuje formularz „Przygotuj zadanie z pomocą AI” (flaga `EXERCISE_AI_ENABLED` jest włączona), ale po wysłaniu odpowiedź to „Konfiguracja modelu jest niedostępna.” Akcja kończy się tak, zanim zarezerwuje próbę, gdy w środowisku Preview brakuje klucza dostawcy AI (`OPENAI_API_KEY`); w bazie nie powstała żadna rezerwacja ani propozycja. Ustawienie klucza to nowy koszt i sekret, więc to decyzja właściciela. Zatwierdzanie propozycji nie było więc do sprawdzenia. |
| 8b | Sekcja „Test kompetencji” na ekranie raportu kandydata | **PASS** — raport kandydata A (`/applications/2538530f-…/report`) ma sekcję „Test kompetencji”: nowa próba `06d32e77-…` z 26.11 widoczna jako „Odpowiedź oddana — czeka na ocenę rekrutera” z linkiem „Oceń odpowiedź”, a wcześniejsza próba z 18.11 jako „Ocenione przez człowieka” z poziomami i cytatami z odpowiedzi. Brak decyzji zatrudnienia/odrzucenia. |

Zrzuty (`docs/checks/screens-2026-11-26b/`): `3a-ekran-zadan.png`, `3a-przed-generowaniem.png`, `3a-po-generowaniu.png`,
`8b-raport-kandydata.png`.

## Co zostaje

- Krok 3a: wymaga klucza dostawcy AI na Preview. Pytanie do właściciela (TAK/NIE): czy dodać
  `OPENAI_API_KEY` w środowisku Preview projektu `skillcheck-core` (nowy koszt, limit 20 prób na
  rekrutację)? Rekomendacja: TAK, tylko Preview, z niskim limitem kosztów. Do tego czasu wiersz R1
  zostaje W TOKU.
