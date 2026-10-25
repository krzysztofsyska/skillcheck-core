# Manifest promocji origin/integration → origin/main

Wygenerowano narzędziem `tools/release/promotion-manifest.mjs` (tylko odczyt lokalnego Git).

- Kandydat (head): `5f5df6a6d9a22832359908db744db7a1be94da0d`
- Produkcja (base): `76760b7ffb7e95231fc7af313cc67bc8d36fefe1`
- Commity: **554**, przypisane do PR: **554**, nieprzypisane: **0**
- Pliki: **368**; nowe migracje: **16**
- Hash manifestu (sha256): `fe299b47b61fd7d36eec533edc59e75bc1259ab48826985547b59e3880de7763`

Manifest jest dowodem do przeglądu właściciela. Nie zastępuje rejestru ACCEPTED kontrolera i niczego nie autoryzuje.

## Kategorie plików

| Kategoria | Pliki |
| --- | ---: |
| tests | 136 |
| docs | 56 |
| backend | 52 |
| frontend | 41 |
| tooling | 31 |
| ci-governance | 26 |
| migration | 16 |
| api | 6 |
| other | 2 |
| runtime-config | 2 |

## Nowe migracje (kolejność repozytorium)

1. `supabase/migrations/20261009073604_sales_lead_inbox_retention.sql`
2. `supabase/migrations/20261009104142_sales_lead_auto_reply.sql`
3. `supabase/migrations/20261009105025_candidate_communication_foundation.sql`
4. `supabase/migrations/20261009141832_sales_pipeline.sql`
5. `supabase/migrations/20261009141836_candidate_communication_verification.sql`
6. `supabase/migrations/20261010190255_candidate_retention_preview.sql`
7. `supabase/migrations/20261010194216_candidate_erasure_lifecycle.sql`
8. `supabase/migrations/20261010194230_candidate_erasure_guards.sql`
9. `supabase/migrations/20261010194343_candidate_erasure_inventory_v2.sql`
10. `supabase/migrations/20261010204840_erasure_execution_protocol.sql`
11. `supabase/migrations/20261010205030_erasure_purge_graph.sql`
12. `supabase/migrations/20261010205052_erasure_inventory_v3.sql`
13. `supabase/migrations/20261012031026_retention_scheduler_protocol.sql`
14. `supabase/migrations/20261012031039_retention_scheduler_inventory.sql`
15. `supabase/migrations/20261021084245_explicit_data_api_table_acl.sql`
16. `supabase/migrations/20261021084732_sc019_credits_payments_inventory.sql`

## Kroki historii integration (chronologicznie)

| # | Commit | PR | Commity | Migracje | Tytuł PR |
| ---: | --- | --- | ---: | :---: | --- |
| 1 | `fdcd9f2` | #68 | 3 |  | SC-010: architektura komunikacji z kandydatem i plan podstawy backendu |
| 2 | `5f8036e` | #69 | 2 | tak | SC-010 B1: offline communication records, drafts and audit |
| 3 | `b304518` | #71 | 3 | tak | SC-010 B2: trusted contact verification and offline approvals |
| 4 | `c1e6c45` | #75 | 14 |  | SC-011-A: provider interface and synthetic-only voice fake |
| 5 | `00bfe73` | #76 | 13 |  | SC-012-A: offline role-specific interview plan generator |
| 6 | `7dde447` | #64 | 5 | tak | feat(sales): contact inbox, retention and prepared automatic confirmation |
| 7 | `55b5b45` | #72 | 5 | tak | feat(sales): SC-SALES-013 — etapy, notatki i terminy kontaktu |
| 8 | `5f92bbf` | #83 | 3 |  | SC-010-R: architecture for retention and controlled erasure |
| 9 | `5b63807` | #90 | 4 | tak | SC-010-R1: polityki retencji i podgląd zakresu danych |
| 10 | `5479c56` | #94 | 4 | tak | SC-010-R2: zatwierdzanie żądań i odwracalne zamrożenie danych |
| 11 | `ab4e757` | #82 | 10 |  | SC-012-B: architecture for persisted interview plans and recruiter approvals |
| 12 | `6d1be17` | #84 | 32 |  | SC-012-B B1: offline persistence command contracts and source-bound snapshots |
| 13 | `dca0da7` | #85 | 27 |  | SC-012-B B2: recruiter voice-plan review panel (disabled until trusted backend) |
| 14 | `9356cfa` | #89 | 22 |  | SC-012-B B1: isolated SQL schema prototype and fail-closed tests |
| 15 | `b94ce3e` | #95 | 6 | tak | SC-010-R3: kontrolowany purge i niezależny rejestr odtworzeń |
| 16 | `2bc4d5d` | #103 | 6 | tak | SC-010-R4: retention scheduler and production launch preparation |
| 17 | `b2fbc71` | #104 | 8 |  | SC-005: bezpieczna diagnostyka błędów OpenAI |
| 18 | `7a36579` | #106 | 4 |  | SC-010-R5: osobna usługa ledger i konfiguracja operatora |
| 19 | `8ae2184` | #110 | 1 |  | OPS: ogranicz automatyczne wdrożenia Vercel do integration, main i release |
| 20 | `f2f9b44` | #118 | 15 |  | SC-SALES MVP: pilotaż PRESELEKCJA — zamówienie bez blokady SC-019 |
| 21 | `efdd4c7` | #119 | 18 |  | SC-SALES: izolowana bramka selektywnych wydań FREE/PRESELEKCJA — przygotowanie |
| 22 | `9a33601` | #116 | 15 |  | SC-011 Retell Preview: bezpieczny odczyt statusu agenta (bez połączeń) |
| 23 | `d774e11` | #122 | 22 |  | SC-011-C: Retell offline outbound — VoIPstudio/GoTrunk SIP do weryfikacji |
| 24 | `3cdb515` | #88 | 7 |  | SC-011-B prep: synthetic provider event contract and transition tests |
| 25 | `9f573b9` | #124 | 14 |  | SC-OPS: automatic merge to integration after verified CI + Codex, no owner gate A |
| 26 | `1e2ec57` | #125 | 5 |  | SC-SALES: zweryfikowana historia Git i 5 przypiętych plików wydania (preflight) |
| 27 | `5c612a9` | #121 | 24 |  | Voicebot MVP FREE i PRESELEKCJA — uprawnienia i scenariusz offline bez telefonii |
| 28 | `dc4d202` | #41 | 13 |  | SC-OPS-002C: prepare isolated review environment and workflow IDs |
| 29 | `172a7c4` | #57 | 59 |  | SC-OPS-002D: bounded Codex-to-Cursor feedback bridge (activation blocked) |
| 30 | `e999ab6` | #130 | 3 |  | SC-010-C: trwałe przygotowanie rozmowy offline, zgoda i rezerwacja puli |
| 31 | `b511eeb` | #107 | 19 |  | SC-014-A: kontrakt testu kompetencji, dowody i punktacja |
| 32 | `ab82270` | #133 | 2 |  | SC-OPS: poprawna klasyfikacja izolowanego SQL jako BACKEND/L3 |
| 33 | `a796ac3` | #134 | 2 |  | SC-010-R4-VOICE: retencja, purge i restore przygotowanych rozmów |
| 34 | `5b9cf12` | #92 | 49 |  | SC-019 MVP A1: FREE credits and prepaid PRESELEKCJA quota prototype |
| 35 | `bd0d1d5` | #113 | 8 |  | SC-014-B1: architektura bezpiecznej próby kandydata i bramka SC-010 |
| 36 | `a3612b5` | #135 | 5 |  | SC-014-B2: isolated safe competency attempt backend |
| 37 | `fbc75c7` | #115 | 16 |  | SC-019 MVP: konfigurowalne limity FREE i PRESELEKCJA (prototyp) |
| 38 | `d34200d` | #129 | 7 |  | SC-019 A2: trwały zapis PostgreSQL i checkout PRESELEKCJI (wyłączone) |
| 39 | `7cc79a1` | #136 | 43 |  | SC-014-B3: isolated secure candidate attempt HTTP broker |
| 40 | `bcc9a20` | #152 | 2 |  | SC-019: bezpieczne ponawianie checkoutu i wspólne warunki zakupu |
| 41 | `3713a0c` | #154 | 3 | tak | SC-DB-API: audyt grantów Supabase i ograniczenie service_role |
| 42 | `8aa7483` | #157 | 2 |  | SC-DB-API: wynik scalenia i zależności SC-021 / SC-019 |
| 43 | `4382c4e` | #155 | 5 | tak | SC-019: migracja kredytów i płatności z inventory R6 oraz testami PG16/17 |
| 44 | `afbe862` | #158 | 8 |  | SC-SALES: kalkulator v4 → zgłoszenie z zachowaniem wyboru |
| 45 | `55be4f7` | #160 | 7 | tak | SC-019: hosted migration compatibility and FREE/payment release evidence |
| 46 | `319b19f` | #162 | 6 |  | SC-OPS-002C: zweryfikowane ID GitHub App i środowisk |
| 47 | `5f5df6a` | #163 | 3 |  | fix: preserve complete evidence for large production promotions |
