# SC-DB-API-001 — audyt Data API i uprawnień tabel

Data odczytu: 21.10.2026, Europe/Warsaw. Kontrakt: [Issue #153](https://github.com/krzysztofsyska/skillcheck-core/issues/153).
Poziom L3, zakres BACKEND. Production approval: **NO**.

## Domknięcie repozytorium — 21.10.2026

- [PR #154](https://github.com/krzysztofsyska/skillcheck-core/pull/154) scalono do
  `integration`: `3713a0c44b7579172bb613c6dba99a6403164646`.
  HEAD `1d96da6c8993031c3d04c7b8fa4b7e2bc6df5b4f`, BASE `bcc9a200a8a082c13fa3796e9375b37e4b520c8d`.
  Przed merge: 10/10 checks SUCCESS, wymagane `verify` i `Agent contract / scope gate`
  od GitHub Actions app 15368, brak legacy statuses i nierozwiązanych wątków, aktualny
  ruleset 25299230 (strict checks, bez bypass). Standardowy merge z expected HEAD.
- Niezależny exact-HEAD review pierwotny PASS i GitHub Codex bez findings;
  dodatkowy niezależny przegląd statyczny `/root/acl_reviewer`: PASS, P0/P1/P2/P3=0/0/0/0.
  Dodatkowy przegląd nie jest nowym uruchomieniem historycznych 24 testów ACL.
  [Receipt scalenia](https://github.com/krzysztofsyska/skillcheck-core/issues/153#issuecomment-6312355932).
- Po merge: 21/21 powiązanych workflow runs SUCCESS, w tym push Checks `39575034363`.
  Automatyczny Vercel Preview `dpl_E14KkgEwRApkrcc8Cg51i1VYL6uR`: READY,
  ref `integration`, SHA scalenia, target null. To wdrożenie aplikacji Preview,
  **nie zastosowanie SQL do bazy**. Nie wykonywano testowych zapisów na Preview.
- `main` pozostaje `76760b7ffb7e95231fc7af313cc67bc8d36fefe1`.
  Nie wykonano zdalnych migracji, zmian sekretów/default privileges ani aktywacji usług.

### SC-021: kompletna poprawka zależna

[PR #156](https://github.com/krzysztofsyska/skillcheck-core/pull/156), branch
`fix/sc021-explicit-data-api-acl-20261021` → `feat/sc-021-ai-gateway-foundation` (#108).
HEAD `be8b564ce3ce00494bc5cd0d27e5bdbc5c84b558`, BASE `1546789e757360c738cdf72fdef9eb78bfae6f66`,
TREE `838a71a6d3d01618227edc8db1e6b431538dd16d` zgodne z lokalnie testowanym.

Minimalny REVOKE z patcha poniżej przeniesiono do niewdrożonego prototypu na oddzielnej
zależnej gałęzi. Nie nadpisano #108/#111/#112 i nie zaimportowano całego SC-021 do integration.
Testy rozszerzono o oba zbiory danych, oba tenanty/outsider, macierz pięciu ról i pełny cykl
reserve/replay/unknown/settle/release obu workerów. `test:ai-gateway` uruchamia nowy plik
w istniejącym Checks oraz dedykowanym CI SC-021.

Lokalnie: 23 PASS, 1 jawny SKIP natywnego PostgreSQL bez URL; typecheck/build PASS.
Niezależny reviewer `/root/acl_reviewer` pobrał remote HEAD, potwierdził tree i sam uruchomił
nowe ACL: 2/2 PASS, 0 SKIP; P0/P1/P2/P3=0/0/0/0.
[Receipt review](https://github.com/krzysztofsyska/skillcheck-core/pull/156#issuecomment-6312462458).
Dedykowane CI `39575724444` z PostgreSQL 16.15: 24/24 PASS, 0 SKIP. Końcowy odczyt wszystkich checks
jest zapisany w PR. Początkowy Agent Gate odrzucił metadane BACKEND, ponieważ niezmieniony
historyczny klasyfikator #108 klasyfikuje ścieżki prototypu/testu/package jako OPERATIONS;
skorygowano wyłącznie metadane, zachowując rzeczywisty zakres BACKEND/L3 i zabezpieczenia.

Poprawka ACL nie jest zgodą na cały moduł. Integracja nadal zależy od uzgodnienia stosu
#108/#111/#112, rzeczywistego niezmiennego SC-010 R5 i jego signed erasure/restore oraz
końcowego CI/review. PR #156 pozostaje zależny; nie zmienia uprawnień EXECUTE service_role.

### SC-019: zweryfikowany kod i otwarta zależność integracyjna

Istniejący Builder prowadzi [PR #155](https://github.com/krzysztofsyska/skillcheck-core/pull/155)
w #93/#91. Nie tworzono konkurencyjnej migracji. Odczytowy niezależny przegląd obejmował
lokalny HEAD `2195bdfa8cdb3a9ca35baf4886928bd3e86be6c4` i SQL
`20261021084732_sc019_credits_payments_inventory.sql`, SHA256
`b838f49c2d5279efc82f1c9f6ac98c6a78ec138a335d8b2af275cac0321b2038`;
opublikowany #155 HEAD `42a223ed69604186ce0df09b9a0a9a537bfe51d0` wskazuje ten sam SQL.

Potwierdzono w kodzie: 10 tabel private z RLS, cleanup tabelowych/kolumnowych/funkcyjnych
ACL nie-ownerów i grant options, tylko przewidziane public RPC, prywatne rozliczenie przez
zaufany adapter, literalny R6 i niezmieniony guard `sc19_payment_erasure_revision_required`.
Runtime resolver pozostaje null. To przegląd ACL, nie finalny PASS całej migracji.

**P2 do poprawy w istniejącym PR #155:** nowy domyślny cutoff R4 w helperze
`setupRankingDatabase` wymaga jawnego `{ throughMigration: null }` w dwóch testach
`full clean replay` z `tests/data-api-grants.test.mjs`. Bez tego pierwszy test pozostawia
legacy ACL i zawodzi, drugi może przejść bez nowych migracji. Nie cofać cutoff potrzebnego
historycznym prototypom i nie usuwać guardów.

Następnie wymagany jest łączny łańcuch R4 → #154 → R6 na PG16/17, co najmniej bez defaults
oraz z legacy grants i syntetyczną rolą service_role BYPASSRLS, pełny replay, tenant/role/RPC,
concurrency, purge/restore i rollback. Dotychczasowy combined rehearsal SC-019 pomijał tę
rolę; hostile-default test używał contact_verifier. Nie poszerzać arbitralnie fingerprintów
ani nie uczyć baseline z bazy docelowej. Nieznane ACL schematów/funkcji nadal mają odmawiać.
Końcowa zgodność połączonego kodu pozostaje **NOT VERIFIED** do nowych testów i review.
[Wymagania przekazane istniejącemu Builderowi](https://github.com/krzysztofsyska/skillcheck-core/issues/93#issuecomment-6312413419)
i [komentarz w #155](https://github.com/krzysztofsyska/skillcheck-core/pull/155#issuecomment-6312456042).

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
| SC-021 PR #108/#111/#112 | 2 tabele public ai_gateway_limits/usage; jawny SELECT authenticated i tenant RLS, pominięty REVOKE service_role. Patch wdrożony na zależnej gałęzi PR #156; historyczny patch zachowany w `docs/patches/sc021-explicit-data-api-acl.patch`. |
| Pricing PR #151 | 6 tabel w sc_pricing_isolated; brak nowych tabel public. Nie nadawać grantów API. |
| Pozostałe SQL db/isolated i prototypy | Nie dodają kolejnych tabel public; pozostają poza automatyczną migracją Supabase. |

Historyczny patch SC-021 przygotowano i przetestowano w osobnym worktree na niezmiennym HEAD #108
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
z pozostałymi uprawnieniami administracyjnymi. **24/24 PASS**. Obejmuje:

- pełne ACL tabel i kolumn, RLS/widoki, blokadę anon i service_role;
- właściciela, rekrutera, viewer, outsider i dwa tenanty; onboarding/CV, screening worker
  claim/complete, review i ranking; brak możliwości zmiany tożsamości/firmy;
- transakcyjny rollback ACL, powtarzalność tylko w izolowanym teście, brak wpływu na obcą tabelę;
- identyczne RPC ACL, polityki, default ACL i sygnaturę SC-010 przed/po naprawie;
- prywatne kredyty SC-019, jawne RPC i nadal działającą blokadę inwentarza płatności;
- osobny dozwolony fixture płatności bez SC-010, bez usuwania guardów;
- pełny clean replay wszystkich aktualnych migracji z niezależną macierzą ACL/RLS;
  test wykrywania przyszłej tabeli i przyszłego nadania anon SELECT; osobny replay bez service_role.

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

KONTYNUUJ SKILLCHECK — istniejący Builder SC-019 w PR #155 / #93 / #91, kontynuacja
obecnej sesji. Użyj skillcheck-orchestrator, skillcheck-builder i Supabase. Najpierw odśwież
integration, HEAD/BASE, własność i komentarz 6312413419; zachowaj rozpoczęty kod.
Uzgodnij pełny replay po scalonym #154, wykonaj łączną macierz ACL/PG16/17, R6 purge/restore,
CI i niezależny review. Nie deklaruj zgodności przyszłego kodu. Zależny PR #156 zawiera
przetestowaną poprawkę SC-021; nie importuj całego modułu ani nie usuwaj jego bramek R5.
Bez main, zdalnych migracji, aktywacji i kosztów. Przed przyszłym wdrożeniem pozostają osobny
runbook, historia migracji, zewnętrzni konsumenci service_role i osobna zgoda Production.
