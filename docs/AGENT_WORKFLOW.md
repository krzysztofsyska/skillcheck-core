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
BACKLOG -> READY -> BUILDING -> PR_REVIEW -> FIXING -> READY_FOR_OWNER -> ACCEPTED -> READY_FOR_PROD -> DEPLOYING -> DONE
Dodatkowo: BLOCKED.

Właściciel podejmuje tylko dwa checkpointy:
- OWNER ACCEPTANCE — zgoda na scalenie gotowego tasku do `integration`,
- PRODUCTION APPROVAL — osobna zgoda na promocję `integration -> main` i produkcyjny runbook.

Od SC-OPS-002B te checkpointy są środowiskami GitHub `owner-acceptance` i `production-approval`. Komentarz, reakcja i pole w opisie PR nie zastępują kliknięcia w środowisku. Kontroler ma flagi `AGENT_PIPELINE_ENABLED` i `AGENT_PIPELINE_MERGE_ENABLED`; obie domyślnie są false i ta implementacja ich nie włącza.

## Zasady równoległości
Taski mogą iść równolegle tylko gdy:
- nie modyfikują tych samych tabel/migracji,
- nie modyfikują tych samych głównych plików,
- mają zamrożone kontrakty wejścia/wyjścia,
- zależności są oznaczone jako DONE.

## Branching
- `main` = źródło produkcji.
- `integration` = zaakceptowane zmiany oczekujące na zgodę produkcyjną.
- Nowe task branches powstają z `integration`.
- Normalne PR-y tasków targetują `integration`.
- Do `main` może targetować tylko promotion PR `integration -> main` po PRODUCTION APPROVAL.
- Format task branch: `feat/sc-XXX-short-name`, `fix/sc-XXX-short-name`, `chore/sc-XXX-short-name`.
- PR-y otwarte przed wdrożeniem SC-OPS-001 mogą dokończyć dotychczasowy base; nowych tasków nie rozpoczynać według starego modelu.

## Handoff
Każdy agent kończy pracę blokiem zapisanym w GitHub PR/Issue, nie przekazywanym ręcznie przez właściciela:
- TASK
- STATUS
- BRANCH
- COMMIT
- CHANGED FILES
- DB/MIGRATIONS
- TESTS
- SECURITY CHECKS
- KNOWN ISSUES
- BLOCKERS
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


## Agent-to-agent przez GitHub

- ChatGPT/Orchestrator przekazuje zadanie przez GitHub Issue.
- Cursor zapisuje implementację, wyniki testów i handoff w PR.
- Codex/Reviewer zapisuje verdict i uwagi w PR.
- Cursor poprawia uwagi w tym samym branchu.
- Orchestrator odczytuje GitHub i pyta właściciela dopiero przy OWNER ACCEPTANCE.
- Po akceptacji task trafia do `integration`.
- Osobny promotion PR i osobna zgoda właściciela poprzedzają produkcję.
- Szczegóły: [AGENT_PIPELINE.md](AGENT_PIPELINE.md).
