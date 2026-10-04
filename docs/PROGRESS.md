# SkillCheck — stan prac

## Baseline produkcyjny po merge — 2026-10-04

- PR #1 (`feat/tenant-database`) scalono do `main` jako `21b4c5f`.
- PR #22 (`chore/dev-operating-system`) scalono do `main` jako `e517d9e`.
- Aktualny `main` i `origin/main` wskazują `e517d9e7edda5a73b665d7fb2877e8e02bc9e46d`.
- GitHub Actions `Checks` dla tego SHA zakończył się sukcesem.
- Vercel wdrożył ten sam SHA do środowiska Production; deployment zakończył się sukcesem.
- `https://skillcheck-core.vercel.app/` zwraca HTTP 200.
- `https://skillcheck-core.vercel.app/api/health/supabase` zwraca `{"ok":true,"service":"supabase"}`.

Funkcje dostarczone w PR #1 nie są już ograniczone do Preview: znajdują się na `main`
i w produkcji. Obejmują istniejący fundament opisany w
[ARCHITECTURE.md](ARCHITECTURE.md), między innymi auth/onboarding, firmy,
stanowiska i rekrutacje, kandydatów, import i ręczną redakcję CV, przygotowanie
preselekcji, ręczne etapy, oceny zachowania, przewodnik rozmowy oraz wersjonowane
zadania i obserwacje.

## Walidacja aktualnego `main`

Walidację wykonano lokalnie na Node.js 24.21.0, zgodnie z wersją główną używaną
przez `.github/workflows/checks.yml`.

- `npm ci` — PASS, 0 znanych podatności
- `npm run typecheck` — PASS
- `npm run test:db` — PASS, 12 testów
- `npm run test:auth` — PASS, 11 testów
- `npm run test:cv` — PASS, 15 testów
- `npm run test:screening` — PASS, 7 testów
- `npm run test:assessments` — PASS, 26 testów
- `npm run test:live-check` — PASS, 19 testów
- `npm run test:behavior-guide` — PASS, 6 testów
- `npm run test:behavior-assessments` — PASS, 12 testów
- `npm run build` — PASS
- `npm run test:pdf-bundle` — PASS
- `npm run test:http` — PASS, 1 test
- `npm run test:auth-http` — PASS, 1 test

Łącznie: 110 testów PASS. `npm run test:live` nie należy do wymaganej macierzy CI
i wymaga prywatnych danych dwóch kont oraz przygotowanych rekordów w rzeczywistym
Supabase, dlatego nie był częścią tej walidacji baseline'u. Mechanizm tego testu
jest objęty przechodzącym zestawem `test:live-check`.

## Baza i migracje

Stan pozostaje bez zmian: 13 tabel z RLS, 40 polityk i trzy widoki
`security_invoker`. Migracje `20260930000100`, `20261001000100`,
`20261001000200`, `20261002000100`, `20261002000200`, `20261002000300`
i `20261004000100` są wykonane w docelowym Supabase i nie wolno uruchamiać ich
ponownie. SC-001 nie zmienia schematu, migracji ani RLS.

## Zakres nadal niewdrożony

Integracja AI, automatyczne ocenianie, voicebot, OCR, ranking/raporty oraz kolejne
moduły backlogu pozostają do realizacji w osobnych taskach. Istniejące
przygotowanie preselekcji nie wysyła danych do AI i nie podejmuje automatycznej
decyzji o zatrudnieniu.

## Historia audytu przed merge

Szczegółowy przebieg testów Preview, RLS, ról, recovery i współbieżnego
onboardingu pozostaje w [audit-2026-10-04.md](audit-2026-10-04.md). Dokument ten
jest zapisem historycznym sprzed merge; bieżący stan produkcji opisuje baseline
powyżej.
