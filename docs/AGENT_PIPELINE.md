# SkillCheck — Agent Pipeline v1

## Cel

Właściciel nie przekleja promptów ani raportów pomiędzy ChatGPT, Cursor i Codex.
GitHub jest wspólną szyną komunikacyjną.

Właściciel nie zatwierdza zwykłych PR-ów do `integration`. Po aktualnych testach CI i niezależnym review PASS kod jest scalany automatycznie, o ile ochrona gałęzi i blokady bezpieczeństwa są spełnione. Właściciel zatwierdza dopiero **PRODUCTION APPROVAL**, nowe koszty lub operacje nieodwracalne.

## Topologia

```
Owner
  |
  v
ChatGPT Orchestrator
  |
  +--> GitHub Issue (task contract)
  |       |
  |       +--> Cursor Builder
  |       |       |
  |       |       v
  |       |     task branch
  |       |       |
  |       |       v
  |       +---- GitHub PR ----> Codex/Reviewer
  |                         |          |
  |                         |<-- fixes-+
  |                         v
  |                        CI
  |
  +--> CI PASS + reviewer PASS + security gates
              |
              v
      automatic merge task PR -> integration
              |
      ready for production
              |
  +--> asks Owner: DEPLOY?
              |
             YES
              v
   promotion PR integration -> main
              |
        production runbook
              |
          smoke tests
              |
             DONE
```

## Statusy

`BACKLOG -> READY -> BUILDING -> PR_REVIEW -> FIXING -> READY_FOR_OWNER -> ACCEPTED -> READY_FOR_PROD -> DEPLOYING -> DONE`

Dodatkowo: `BLOCKED`.

Sterownik zapisuje gotowość zwykłego tasku jako `READY_FOR_OWNER`. Automatyczne scalenie do `integration` nie wprowadza osobnej wartości statusu.

## Kanał agent-agent

### ChatGPT -> Cursor
Orchestrator tworzy/aktualizuje Issue i przekazuje implementację poprzez GitHub.
Cursor nie potrzebuje promptu kopiowanego przez właściciela.

### Cursor -> Reviewer
Kod, testy i handoff są w PR.

### Reviewer -> Cursor
Uwagi są komentarzem/review w PR. Cursor poprawia ten sam branch.

### Cursor/Reviewer -> ChatGPT
Orchestrator odczytuje Issue, PR, CI i komentarze z GitHuba.

## Frontend

Zmiany frontendowe obejmują m.in.:
- strony i komponenty `app/**`
- publiczne strony marketingowe
- dashboard UI
- formularze
- style i interakcje klienta

Frontend może być scalony do `integration` automatycznie po aktualnym CI PASS i review PASS oraz po spełnieniu pozostałych bramek.
Nie trafia do produkcyjnego `main` przed PRODUCTION APPROVAL.

## Backend

Zmiany backendowe obejmują m.in.:
- `lib/**`
- `app/api/**`
- server actions
- Supabase functions
- migracje
- auth, RLS, RPC

Zmiany DB/security mają L3 i wymagają niezależnego review przed scaleniem do integration.
Produkcja wymaga osobnego runbooku i jawnej zgody właściciela.

## Fullstack

PR musi wskazać:
- kontrakt frontend -> backend
- autoryzację
- loading/error states
- sposób testowania
- wpływ na DB/API

## Git branches

- `main`: produkcja
- `integration`: zaakceptowane zmiany przed produkcją
- `feat/sc-...`, `fix/sc-...`, `chore/sc-...`: zadania

## Dwa gates

### Gate A — AUTOMATIC INTEGRATION

Nie wymaga zgody właściciela. Sterownik może scalić zwykły task PR do `integration` wyłącznie po niezależnym review PASS i CI PASS dla niezmienionego HEAD/BASE/kontraktu. Przed merge ponownie pobiera aktualne dane GitHuba, weryfikuje podpisane dowody, zakres zmian, blokadę scalenia, ochronę gałęzi i źródła wymaganych checks. Publikuje `sc-agent/integration-ready`, nigdy nie fałszuje `owner-acceptance`.

Flagi LIVE, poświadczenia GitHub App oraz konfiguracja rulesetów nadal pozostają osobnymi wymaganiami. Brak spełnionej ochrony i testów oznacza STOP, a nie obejście kontroli.

### Gate B — PRODUCTION APPROVAL

Osobny promotion PR `integration -> main` ma własne środowisko `production-approval`. Zgoda A nie spełnia zgody B. Tekst „TAK” w czacie nie jest zgodą.

Tylko potwierdzona zgoda B uprawnia do zakresu z manifestu wydania:
- merge do `main`
- produkcyjnych migracji opisanych w zatwierdzonym runbooku
- funkcji/server deployment
- zmian produkcyjnych sekretów
- smoke testów produkcyjnych

Sam merge pozostawia stan `MERGED_AWAITING_DEPLOYMENT`. Brak runbooku blokuje wdrożenie.

## Kontroler SC-OPS-002B

Kod kontrolera jest w `tools/agent-pipeline/`. Domyślnie `AGENT_PIPELINE_ENABLED=false` i `AGENT_PIPELINE_MERGE_ENABLED=false`: odczyt i raport są dozwolone, nowe efekty i merge nie. Starszy opis, w którym komentarz albo pole PR oznacza zgodę, nie jest implementacją. Projekt: [sc-ops-002a-agent-orchestration.md](sc-ops-002a-agent-orchestration.md). Bootstrap usług: [sc-ops-002c-bootstrap-runbook.md](sc-ops-002c-bootstrap-runbook.md).

Kontroler utrwala kontrakt, `ALLOWED_FILES`, wymagane testy i skrót wersji. Issue pozostaje kontraktem, PR raportem. Stan i journal są na gałęzi `agent-state`. Cursor, CI, Codex, automatyczna integracja, zgoda B i merge mają osobne adaptery. Publiczny Issue albo `@mention` nie uruchamia płatnej pracy.

## Co jest automatyczne po włączeniu flag

Przy flagach pozostawionych na false poniższe kroki są tylko zaimplementowane i testowane offline:

- zamrożenie kontraktu i jeden task branch z `integration`
- implementacja Cursora i jedna sesja poprawek
- CI oraz review przypięte do pary commitów, kontraktu i `policy_sha`
- automatyczne scalenie do integration na podstawie CI + review, bez zgody właściciela; osobna prośba o zgodę B
- klasyfikacja FRONTEND/BACKEND/FULLSTACK/OPERATIONS
- wykrywanie migracji/L3
- odczyt wyników przez orchestrator

## Co pozostaje ręczne z definicji

Osobne zgody właściciela, składane poza codziennym scaleniem tasku:
- pierwsza aktywacja kontrolera i włączenie flag LIVE,
- PRODUCTION APPROVAL — środowisko `production-approval`,
- nowe koszty i operacje nieodwracalne.

Sekrety, GitHub App, ochrona gałęzi i budżety API są jednorazowym bootstrapem SC-OPS-002C, nie częścią codziennego przeklejania promptów.
