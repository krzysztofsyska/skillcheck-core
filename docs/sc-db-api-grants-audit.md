# SC-DB-API-001 — audyt Data API i uprawnień tabel

Data odczytu: 21.10.2026, Europe/Warsaw. Kontrakt: [Issue #153](https://github.com/krzysztofsyska/skillcheck-core/issues/153).
Poziom L3, zakres BACKEND. Production approval: **NO**.

## Wynik i granice dowodów

Nie stwierdzono brakującego jawnego GRANT wymaganego przez obecne wywołania Data API.
27 migracji `integration` tworzy 26 tabel `public`; wszystkie mają RLS. 24 tabele mają
jawny SELECT dla `authenticated`, a `sales_leads` i `platform_operators` celowo wymagają RPC.
`anon` nie wymaga bezpośredniego dostępu do żadnej z tych tabel. W repo nie znaleziono
wywołań wymagających CRUD jako `service_role`; kontrakt projektu zabrania tej roli w runtime aplikacji.

Potwierdzono P2: historyczne default ACL Supabase pozostawiają `service_role` szeroki dostęp
do 26 tabel i trzech widoków, mimo istniejących REVOKE dla pozostałych ról. Test z rolą
BYPASSRLS odtworzył odczyt dokumentów dwóch **syntetycznych** firm. Odczyt katalogów
rzeczywistego projektu `wsvjawuikxfzjyivxgsu` potwierdził 21 istniejących tabel `public`
z RLS i trzy widoki z szerokimi grantami `service_role`; `anon` nie miał badanych uprawnień
tabelowych. Nie odczytywano dokumentów, danych kandydatów ani sekretów Production.
Nie jest to dowód wycieku klucza ani publicznego dostępu bez uwierzytelnienia.

Przygotowana poprawka odbiera bezpośrednie uprawnienia tej roli do enumerowanych relacji,
łącznie z niezależnymi grantami kolumnowymi. Nie zmienia uprawnień EXECUTE funkcji,
członkostwa ról, default ACL ani polityk RLS. Nie oznacza odebrania `service_role`
wszelkiego dostępu do bazy lub RPC. Nie stosowano migracji do zdalnej bazy.

## Źródła i wersje

- `integration`: `bcc9a200a8a082c13fa3796e9375b37e4b520c8d`, 27 migracji przed poprawką;
  zawiera scalony PR #152, którego implementacji nie powielano.
- `main`: `76760b7ffb7e95231fc7af313cc67bc8d36fefe1`, 13 migracji.
  Gałąź produkcyjna i rzeczywisty stan bazy nie są utożsamiane.
- [Komunikat Supabase](https://github.com/orgs/supabase/discussions/45329), potwierdzony też
  powiadomieniem właściciela z 20.10.2026: od 30.10 nowe tabele wymagają jawnego opt-in;
  istniejące zachowują granty. Dotyczy także odtworzenia migracji w nowych projektach/resetach.
- [Securing your API](https://supabase.com/docs/guides/api/securing-your-api): ACL określa
  dostęp do obiektu; RLS ogranicza wiersze. Nowe ustawienie może pozostawiać nieużywane przez
  Data API uprawnienia TRUNCATE/REFERENCES/TRIGGER/MAINTAIN, a funkcje mają osobny model EXECUTE.
- Przejrzano bieżący `changelog.md`, `AGENTS.md`, `AGENT_WORKFLOW.md`, `AGENT_PIPELINE.md`,
  backlog, kontrakt i komentarze #93 oraz listę wszystkich 20 otwartych PR.

## Macierz docelowego bezpośredniego dostępu

Wszystkie poniższe nazwy należą do `public`. Dla **anon: brak**; dla **service_role: brak
po zastosowaniu nowej migracji**. Wszystkie tabele mają RLS. SELECT podlega izolacji firmy,
zapisy — dodatkowo roli właściciela/rekrutera; zarządzanie członkami tylko właścicielowi.
Wiersze „RPC” oznaczają brak bezpośredniego CRUD, a nie brak funkcjonalności.

| Tabela | Tworząca migracja (prefiks) | `authenticated` |
|---|---|---|
| companies | 20260930000100 | SELECT; UPDATE(name); tworzenie przez RPC |
| company_members | 20260930000100 | SELECT, INSERT, DELETE; UPDATE(role) |
| company_profiles | 20260930000100 | SELECT, INSERT, DELETE; UPDATE pól profilu |
| positions | 20260930000100 | SELECT, INSERT, DELETE; UPDATE pól stanowiska |
| recruitments | 20260930000100 | SELECT, INSERT, DELETE; UPDATE name/status/opened_at/closed_at |
| candidates | 20260930000100 | SELECT, INSERT, DELETE; UPDATE first_name/last_name/email/phone |
| applications | 20260930000100 | SELECT, INSERT, DELETE; UPDATE(status) |
| assessment_stages | 20260930000100 | SELECT, INSERT, DELETE; UPDATE name/description/sequence |
| candidate_assessments | 20260930000100 | SELECT, INSERT, DELETE; UPDATE status/score/notes/completed_at |
| candidate_documents | 20261001000200 | SELECT; INSERT company_id/candidate_id/source_text/redacted_text; UPDATE(redacted_text) |
| behavior_assessment_entries | 20261002000100 | SELECT; zapis przez RPC |
| exercise_definition_entries | 20261002000300 | SELECT; zapis przez RPC |
| exercise_observation_entries | 20261004000100 | SELECT; zapis przez RPC |
| screening_analysis_versions | 20261004000200 | SELECT; zapis przez RPC |
| screening_analysis_attempts | 20261004000200 | SELECT; zapis przez RPC |
| screening_criterion_results | 20261004000200 | SELECT; zapis przez RPC |
| screening_result_reviews | 20261004000200 | SELECT; zapis przez RPC |
| screening_criterion_review_overrides | 20261004000200 | SELECT; zapis przez RPC |
| sales_leads | 20261007000200 | RPC |
| platform_operators | 20261007000200 | RPC |
| recruitment_shortlist_entries | 20261009081908 | SELECT; zapis przez RPC |
| candidate_contact_permissions | 20261009105025 | SELECT; zapis przez RPC |
| candidate_contact_preferences | 20261009105025 | SELECT; zapis przez RPC |
| candidate_communications | 20261009105025 | SELECT; zapis przez RPC |
| candidate_communication_events | 20261009105025 | SELECT; zapis przez RPC |
| candidate_communication_approvals | 20261009141836 | SELECT; zapis przez RPC |

Dokładne allowlisty kolumn są sprawdzane niezależnie w `tests/data-api-grants.test.mjs`.
Trzy widoki `latest_behavior_assessments`, `latest_exercise_definitions`,
`latest_exercise_observations` mają SELECT dla authenticated i `security_invoker=true`;
respektują RLS tabel źródłowych. Brak sekwencji public wymagających dodatkowego USAGE.

## Konkretne pliki wymagające rozliczenia

Dziesięć historycznych migracji poniżej poprawia **jedna nowa migracja forward-only**;
nie edytować zastosowanych plików i nie wykonywać ich ponownie:

- `20260930000100_skillcheck_core.sql`
- `20261001000200_candidate_documents.sql`
- `20261002000100_behavior_assessments.sql`
- `20261002000300_exercise_definitions.sql`
- `20261004000100_exercise_observations.sql`
- `20261004000200_screening_results.sql`
- `20261007000200_sales_leads.sql`
- `20261009081908_screening_ranking_shortlist.sql`
- `20261009105025_candidate_communication_foundation.sql`
- `20261009141836_candidate_communication_verification.sql`

Poprawka: `supabase/migrations/20261021084245_explicit_data_api_table_acl.sql`, utworzona
przez `supabase@2.121.0 migration new explicit_data_api_table_acl` po odczycie CLI help.
Jawna lista 29 relacji; brak zależności kończy transakcję błędem. Brak service_role w zwykłym
lokalnym Postgresie nie powoduje tworzenia nowej roli. Przy wdrażaniu do Supabase operator
musi potwierdzić istnienie tej roli, historię migracji i dokładny zestaw relacji.

## Planowane schematy i otwarte gałęzie

| Zakres | Wynik i działanie |
|---|---|
| SC-019 `docs/prototypes/sc-019-mvp-credits.sql` | 6 tabel private, RLS, wszystkie nie-owner ACL usuwane. `sc19_package_sizes()` jawnie dla anon/authenticated; trial/balance tylko authenticated z kontrolą firmy. Nie dodawać grantów tabel. |
| SC-019 `docs/prototypes/sc19-payment-storage.sql` po #152 | 4 tabele private, RLS, czyszczenie ACL; zapis przez zaufany adapter SQL. Nie wymaga service_role Data API. Nadal **blokuje** instalację przy istniejącym SC-010 bez nowego inwentarza — poprawka ACL tego nie omija. |
| SC-012 `db/prototypes/sc012b-plan-schema.sql` | `voice_plan_versions` RPC-only, RLS/FORCE RLS. Dodano brakujący REVOKE service_role. PR #96–99 nie dodają innych tabel public. |
| SC-014 `db/isolated/sc014-b2-attempts.sql` | 2 tabele public: competency_test_attempts/review_entries, RLS i usuwanie nie-owner ACL. Broker/RPC, bez bezpośrednich grantów API. Brak poprawki. |
| SC-021 PR #108/#111/#112 | 2 tabele public ai_gateway_limits/usage; jawny SELECT authenticated i tenant RLS, pominięty REVOKE service_role. Gotowy patch i 2 testy w `docs/patches/sc021-explicit-data-api-acl.patch`. |
| Pricing PR #151 | 6 tabel w sc_pricing_isolated; brak nowych tabel public. Nie nadawać grantów API. |
| Pozostałe SQL db/isolated i prototypy | Nie dodają kolejnych tabel public; pozostają poza automatyczną migracją Supabase. |

Patch SC-021 przygotowano i przetestowano w osobnym worktree na niezmiennym HEAD #108
`1546789e757360c738cdf72fdef9eb78bfae6f66`. Nie przenosi on całego niescalonego SC-021 do
integration i nie zmienia cudzych gałęzi. Przed przeniesieniem patcha sprawdzić nowy HEAD.
Test `node --test tests/ai-gateway-data-api-acl.test.mjs`: **2/2 PASS**, profile bez defaults
i ze starymi grants, tenant RLS, odmowy zapisu i service SELECT, działający ai_meter_worker RPC.
Nie jest to nowy test współbieżności całego SC-021 ani aprobata wdrożenia PR #108.

Punkty odczytu PR: #96 `ed04c37fb134c4d4c8b1c60ef69eaf04ad29ea2d`,
#97 `80582c61298c9cdae39d2900873d31f68a1dbaa0`,
#98 `2fef51908719acaf00d405312d070af1f58230d5`,
#99 `6bda5604b20bac37d4c886bc64dcee189bb7124c`,
#111 `9000eb96387e27e2a4f4ea552120b57c249d3b6d`,
#112 `bedb447f6484d45f9f53fbe437cfd996f2afe520`,
#151 `ac857aead334437999e1ab2a4fbb136787c8a839`.

## Testy i przygotowanie wdrożenia

Nowy test odtwarza wszystkie historyczne migracje w PGlite (PostgreSQL/WASM), następnie
sprawdza upgrade w trzech profilach: brak default grants, historyczny ALL oraz opt-in
z pozostałymi uprawnieniami administracyjnymi. **23/23 PASS**. Obejmuje:

- pełne ACL tabel i kolumn, RLS/widoki, blokadę anon i service_role;
- właściciela, rekrutera, viewer, outsider i dwa tenanty; onboarding/CV, screening worker
  claim/complete, review i ranking; brak możliwości zmiany tożsamości/firmy;
- transakcyjny rollback ACL, powtarzalność tylko w izolowanym teście, brak wpływu na obcą tabelę;
- identyczne RPC ACL, polityki, default ACL i sygnaturę SC-010 przed/po naprawie;
- prywatne kredyty SC-019, jawne RPC i nadal działającą blokadę inwentarza płatności;
- osobny dozwolony fixture płatności bez SC-010, bez usuwania guardów;
- pełny clean replay z nową migracją także bez roli service_role w fixture.

`npm run typecheck` i `npm run build`: PASS. Nowy test jest w istniejącym `npm run test:db`
i wymaganym CI Checks. Wyniki całej regresji, bieżącego CI i niezależnego review przypina
handoff PR do pełnego HEAD. PGlite nie zastępuje testu rzeczywistego PostgREST/GraphQL.
Takiego zdalnego E2E ani produkcyjnej migracji w tym audycie nie wykonano.

Przed osobno zatwierdzonym wdrożeniem: odczytać ledger i zależności całego release,
zachować dokładne ACL 29 relacji (w tym kolumn), potwierdzić brak zewnętrznej integracji
wymagającej bezpośredniego service_role CRUD, wykonać izolowany upgrade i smoke jako
authenticated/scoped worker. Nie kopiować samej migracji na bazę bez poprzedzających
zależności SC-010. Nie uruchamiać `db push` jako części tego audytu.

Rollback przed COMMIT jest transakcyjny. Po COMMIT ewentualny rollback wymaga osobno
przejrzanego odtworzenia **wyłącznie zapisanych wcześniej ACL**; nie używać GRANT ALL
ON ALL TABLES ani regenerowania szerokich default privileges.

Zasada dla przyszłych migracji: w tym samym pliku zadeklarować RLS, dokładne REVOKE/GRANT
(w tym service_role), wymagania kolumn/sekwencji i RPC. Tabela wewnętrzna może celowo mieć
zero grantów API. Każda nowa tabela public wymaga rozszerzenia jawnej macierzy testowej.

## Handoff i kontynuacja

Audyt i poprawki repozytorium nie oznaczają wdrożenia ani uruchomienia FREE/PRESELEKCJA.
Nie zmieniano main, sekretów, konfiguracji Supabase ani aktywacji usług. SC-019 nadal
wymaga własnej migracji i zatwierdzonego inwentarza zgodnie z #93.

KONTYNUUJ SKILLCHECK — Codex/Orchestrator + skillcheck-builder, nowa sesja lub kontynuacja.
Repo krzysztofsyska/skillcheck-core, kontrakt #153, branch fix/sc-db-api-explicit-grants-20261021
→ integration. Odczytaj bieżący PR/HEAD, CI i niezależne review; kompletne dowody są w jego
handoff. Następny krok w zakresie audytu: przenieść zweryfikowany patch SC-021 do aktualnej
gałęzi zależnej #108, odświeżyć dwa testy ACL i niezależny review. Nie powielać SC-019/#152,
nie wykonywać migracji produkcyjnych ani aktywować usług. Ten dokument nie nadaje nowej
zgody produkcyjnej ani kosztowej.
