# SC-WER-001 — Audyt punktu wejścia (2026-11-05)

TASK: SC-WER-001
LEVEL: L3
SCOPE: FULLSTACK
STATUS: AUDIT_IN_PROGRESS
BASE: integration @ 7f172d72176fa87719efb81d8db583d3ed5d21af

## Potwierdzone w kodzie

- `lib/competency-test.ts`: definicja rubryki, sanitizacja widoku kandydata, walidacja odpowiedzi i deterministyczna ocena człowieka z dokładnym cytatem. Wynik poniżej 60% pokrycia jest null; nie ma decyzji zatrudnieniowej.
- `app/api/competency/attempt/route.ts`: istnieje izolowany broker B3 z metodą POST; GET/HEAD i inne metody są odrzucane. Nie jest to pełny interfejs dla kandydata.
- `lib/competency-attempt-broker.ts`: broker obsługuje bootstrap, exchange, inspect, status, start, save, submit; wymaga walidacji pochodzenia, ograniczenia wejścia i sesji. Własny komentarz modułu wskazuje brak strony B4 i zaproszeń.
- `docs/sc-014-competency-test.md` opisuje etap A jako kontrakt domenowy, a etap B jako wymagający dalszej integracji. Dokument jest historyczny; przed implementacją trzeba zweryfikować obecne migracje i testy B1–B3.
- `lib/behavior-assessment.ts` oraz `docs/behavior-assessments.md` zapewniają odrębny model ocen zachowania z historią; nie wolno utożsamiać go automatycznie z oceną testu kompetencji.

## Następny bezpieczny zakres

1. Zweryfikować B1–B3 i testy uprawnień, sesji, wygaśnięcia, replay, izolacji firm oraz retencji, zanim powstanie UI B4.
2. Ustalić kontrakt odczytu raportu: wersja zadania, stan próby, dowody, brak danych, wersjonowana ocena rekrutera. Nie dodawać danych ani wyników do SC-015/SC-019.
3. Zbudować B4 i odczyt rekrutera dopiero po potwierdzeniu, że backend autoryzuje konkretną wersję zadania i konkretne zgłoszenie.
4. Weryfikować przez CI i niezależną sesję reviewer; nie wdrażać migracji ani usług na produkcję.

## Ryzyka

- Samo istnienie brokera nie dowodzi dostępności całego procesu dla kandydata.
- Dowody z CV, odpowiedzi testowej i obserwacji AC to trzy odrębne źródła; nie wolno mieszać ich statusów.
- Moduł AC #271 ma osobny kontrakt obserwacji; współdzielone mają być nazwy kompetencji i zasady braku automatycznej decyzji, nie tabele ani skale wyników.

Brak zmian w istniejącym kodzie, DB, billing, FREE i PRESELEKCJI.
