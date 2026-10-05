# SkillCheck — Agent Pipeline v1

## Cel

Właściciel nie przekleja promptów ani raportów pomiędzy ChatGPT, Cursor i Codex.
GitHub jest wspólną szyną komunikacyjną.

Właściciel wykonuje tylko dwa checkpointy:
1. **OWNER ACCEPTANCE** — „akceptuję wykonanie”.
2. **PRODUCTION APPROVAL** — „wdrażaj na produkcję”.

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
  +--> asks Owner: ACCEPT?
              |
             YES
              v
      merge task PR -> integration
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

Frontend może być scalony do `integration` po OWNER ACCEPTANCE.
Nie trafia do produkcyjnego `main` przed PRODUCTION APPROVAL.

## Backend

Zmiany backendowe obejmują m.in.:
- `lib/**`
- `app/api/**`
- server actions
- Supabase functions
- migracje
- auth, RLS, RPC

Zmiany DB/security mają L3 i wymagają review przed acceptance.
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

### Gate A — OWNER ACCEPTANCE

Orchestrator pyta właściciela dopiero gdy:
- reviewer PASS
- CI PASS
- brak blockerów
- acceptance criteria spełnione

Po odpowiedzi „zatwierdzam” orchestrator zapisuje approval w PR i scala do `integration`.

### Gate B — PRODUCTION APPROVAL

Orchestrator tworzy promotion PR `integration -> main`.
Po zielonym CI/review pyta właściciela:
**„Moduł jest gotowy do produkcji. Wdrażamy? TAK/NIE.”**

Tylko odpowiedź TAK uprawnia do:
- merge do `main`
- produkcyjnych migracji
- funkcji/server deployment
- zmian produkcyjnych sekretów
- smoke testów produkcyjnych

## Co jest automatyczne

- task contract w GitHub
- implementacja i handoff przez PR
- review loop
- CI
- klasyfikacja FRONTEND/BACKEND/FULLSTACK
- wykrywanie migracji/L3
- przygotowanie promotion PR
- odczyt wyników przez orchestrator

## Co pozostaje ręczne z definicji

Tylko decyzje właściciela:
- OWNER ACCEPTANCE
- PRODUCTION APPROVAL

Sekrety i logowanie do zewnętrznych usług mogą wymagać jednorazowego bootstrapu kont, ale nie są częścią codziennego przeklejania promptów.
