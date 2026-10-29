# SC-019 — obsługa pakietów przez operatora (FREE i PRESELEKCJA)

TASK: SC-019-MVP A2 (#93), krok 3–4 · LEVEL: L3 · SCOPE: FULLSTACK · PRODUCTION_APPROVAL: NO

## Problem

M13 (`20261021084732_sc019_credits_payments_inventory.sql`) celowo nie daje żadnej
ścieżki w aplikacji do:

- zatwierdzenia weryfikacji firmy przed FREE (`private.sc19_trial_approvals`),
- ustawienia liczby analiz w pakietach (`private.sc19_package_policy`),
- przydziału PRESELEKCJI po wpłacie (`private.sc19_grant_paid`).

Każda z tych czynności wymagała ręcznego SQL na produkcyjnej bazie. Agenci tego nie
robią (AGENTS.md, zasady dostępu do produkcji), a dla właściciela to ryzykowna praca
przy każdym kliencie. Bez tego żaden klient nie dostanie analiz po włączeniu
`SC19_PACKAGES_ENABLED`.

## Rozwiązanie

Migracja `20261029100000_sc019_operator_fulfillment.sql` (tylko funkcje; bez tabel,
kolumn, wyzwalaczy i bez danych startowych, więc inwentarz usuwania R7 bez zmian):

| RPC (`authenticated`, tylko operator platformy) | Działanie |
| --- | --- |
| `sc19_operator_companies(search)` | lista do 200 firm: pakiet, saldo, FREE, zatwierdzony NIP |
| `sc19_operator_package_policy()` | bieżąca liczba analiz w FREE i PRESELEKCJA |
| `sc19_operator_set_package_policy(plan, credits)` | ustawia liczbę analiz dla kolejnych aktywacji i przydziałów |
| `sc19_operator_approve_trial(company, nip, proof)` | zapisuje weryfikację firmy; dowód zapisywany z identyfikatorem operatora |
| `sc19_operator_grant_paid(company, settlement)` | przydziela PRESELEKCJĘ przez recenzowane `private.sc19_grant_paid`; numer rozliczenia = klucz idempotencji |

Każda funkcja najpierw sprawdza `private.is_platform_operator(auth.uid())` (odwołany
operator = 42501). Funkcja prywatna `sc19_grant_paid` pozostaje niedostępna dla
`authenticated`.

Panel: `/operator/billing` (ten sam dostęp co `/operator/sales`). Każdy formularz
wymaga zaznaczenia potwierdzenia.

Wycofanie: `supabase/rollbacks/20261029100000_sc019_operator_fulfillment_down.sql`
usuwa tylko funkcje; zapisane zatwierdzenia, polityka i salda zostają.

## Testy

- `tests/sc-019-operator-fulfillment.test.mjs` — prawdziwy PostgreSQL, cały łańcuch
  migracji: odmowa dla anon/użytkownika/odwołanego operatora, polityka, weryfikacja
  NIP (idempotencja, konflikt NIP między firmami), FREE raz, PRESELEKCJA raz na numer
  rozliczenia, izolacja firm, inwentarz R7 bez zmian, wycofanie i ponowne wdrożenie.
  CI: workflow `SC-019 forward migrations` (PG16, PG17, historia produkcji 17.6).
- `tests/sc-019-operator-ui.test.mjs` — walidacja formularzy i mapowanie błędów (`Checks`).

## Znane ograniczenia

- Przydział PRESELEKCJI nie zapisuje identyfikatora operatora (dziennik M13 ma tylko
  `reference`). Dodanie kolumny audytowej zmienia sygnaturę inwentarza i wymaga R8 —
  osobne zadanie L3.
- Płatności online (Przelewy24/Fakturownia) nadal wyłączone: `resolveSc19PaymentRuntime`
  zwraca `null`. Ten panel obsługuje decyzję właściciela z 2026-10-24: PRESELEKCJA na
  fakturę, przydział przez operatora po zaksięgowaniu wpłaty.

## Kolejność uruchomienia (wymaga zgody właściciela na produkcję)

1. Scalenie do `integration` po CI i niezależnym review.
2. Promocja `integration → main` z osobnym PRODUCTION APPROVAL.
3. **Warunek wstępny:** workflow `db-migrate-production` w środowisku
   `production-approval` (AGENTS.md, zasady dostępu do produkcji, pkt 1) jest
   zainstalowany na `main` i zweryfikowany. Dziś go nie ma, więc migracje produkcyjne
   są zablokowane. Ręczna procedura `psql "$PROD_DB_URL"` z
   `docs/release/sc-mvp-production-runbook.md` nie jest dopuszczalną ścieżką wykonania.
4. Migracje wyłącznie przez ten workflow, po zgodzie właściciela powiązanej z dokładnym
   SHA i listą migracji, pojedynczo w kolejności (nigdy `supabase db push`): M13, Step 3
   (`20261026220100`, `20261026220200`), R7 (`20261028120000`), potem ta migracja.
5. W `/operator/billing`: FREE = 5, PRESELEKCJA = 60 (oferta 300 zł brutto).
6. Ustawienie `SC19_PACKAGES_ENABLED=true` w Vercel Production — wyłącznie właściciel.
7. Smoke test na fikcyjnej firmie: weryfikacja → FREE → analiza → saldo 4.
