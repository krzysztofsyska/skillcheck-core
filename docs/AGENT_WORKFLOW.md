# SkillCheck — Agent Workflow

## Role

### ORCHESTRATOR — ChatGPT
- utrzymuje backlog, zależności i priorytety,
- rozbija epiki na małe taski SC-XXX,
- przypisuje poziom L1/L2/L3,
- decyduje, które taski mogą iść równolegle,
- nie pozwala agentom rozszerzać zakresu bez tasku.

### ARCHITECT — Codex
- projektuje L3: RLS, migracje, model danych, bezpieczeństwo, AI contracts, concurrency, billing,
- przygotowuje plan implementacji przed kodowaniem,
- wskazuje ryzyka i wymagane testy.

### BUILDER — Cursor
- implementuje L1 i L2,
- implementuje L3 według zaakceptowanego planu Codex,
- nie zmienia kontraktów poza zakresem tasku.

### REVIEWER — Codex
- review zgodności z architekturą, bezpieczeństwem, RLS, typami, testami i kryteriami akceptacji,
- wynik: PASS / PASS WITH FIXES / FAIL.

### TESTER / INTEGRATOR — CI + Codex
- uruchamia wymagane testy,
- sprawdza regresję,
- potwierdza gotowość do merge.

## Poziomy

### L1 — LOW
UI, teksty, prosty formularz, mały refactor, test jednostkowy, drobny endpoint.
Wykonanie: Cursor. Review: CI lub szybkie review.

### L2 — MEDIUM
Flow użytkownika, CRUD modułu, integracja kilku tabel, raport, większy formularz.
Wykonanie: Cursor. Review: Codex.

### L3 — HIGH
RLS, schema/migracje, bezpieczeństwo, pseudonimizacja, AI scoring, voicebot, billing, concurrency, tenant model.
Projekt: Codex. Implementacja: Cursor lub Codex zależnie od planu. Review: Codex.

## Statusy
BACKLOG -> READY -> IN PROGRESS -> REVIEW -> TEST -> READY TO MERGE -> DONE
Dodatkowo: BLOCKED.

## Zasady równoległości
Taski mogą iść równolegle tylko gdy:
- nie modyfikują tych samych tabel/migracji,
- nie modyfikują tych samych głównych plików,
- mają zamrożone kontrakty wejścia/wyjścia,
- zależności są oznaczone jako DONE.

## Branching
Format: `feat/sc-XXX-short-name`, `fix/sc-XXX-short-name`, `chore/sc-XXX-short-name`.
Bez bezpośrednich zmian funkcjonalnych na `main`.

## Handoff
Każdy agent kończy pracę blokiem:
- TASK
- BRANCH
- COMMIT
- CHANGED FILES
- DB/MIGRATIONS
- TESTS
- KNOWN ISSUES
- NEXT ACTION

## Kontynuacja po raporcie — ustalenie właściciela z 2026-10-05

- Każdy etap pracy nad projektem kończy się konkretnym raportem i od razu pełnym promptem do wykonania następnego kroku, w tej samej odpowiedzi.
- Koordynator sam ustala następny krok na podstawie wyniku i zależności. Użytkownik nie musi ponawiać pytań „co dalej”, „przygotuj prompt” ani „gdzie to wkleić”.
- Przy prompcie zawsze podać wykonawcę (Cursor, Codex lub ChatGPT), repozytorium/projekt oraz dokładne miejsce użycia: nowa rozmowa czy kontynuacja dotychczasowej.
- Prompt ma zawierać identyfikator zadania, cel, zakres, ograniczenia, kryteria odbioru, wymagane kontrole i format raportu przekazania. Do kodowania podać zweryfikowaną bazę i dozwolone pliki albo zlecić najpierw ich ustalenie w zadaniu projektowym.
- Jeśli etap wymaga poprawek, review lub wdrożenia, następny prompt dotyczy tego kroku. Nie pomijać zależności i nie przedstawiać nieukończonego zadania jako DONE.
- Generowanie kolejnego promptu nie oznacza, że został wysłany do innego narzędzia lub że inny agent już pracuje. Wykonanie i publikacja pozostają w granicach udzielonego upoważnienia.

## Guardrails
- nie ponawiać wykonanych migracji,
- nie commitować sekretów,
- nie używać service_role w runtime aplikacji,
- nie kontaktować kandydatów bez jawnego tasku i konfiguracji,
- nie generować automatycznej decyzji „zatrudnij/odrzuć”,
- każda zmiana RLS = L3,
- każda zmiana kontraktu AI = co najmniej L2, zwykle L3.
