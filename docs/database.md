# SkillCheck — kontrakt bazy danych

Stan docelowego Supabase na 2026-10-04 obejmuje dziewięć wykonanych migracji:
`20260930000100`, `20261001000100`, `20261001000200`, `20261002000100`,
`20261002000200`, `20261002000300`, `20261004000100`,
`20261004000200` i `20261005000100`. Schemat publiczny ma 18 tabel z RLS, 45 polityk, trzy widoki
`security_invoker` i 12 publicznych RPC. Nie wykonywać tych migracji ponownie. Instrukcja wykonania poniżej dotyczy
wyłącznie nowego, pustego środowiska.

Migracja bazowa: `supabase/migrations/20260930000100_skillcheck_core.sql`.
Przygotowanie pliku ani wdrożenie kodu na Vercel nie wykonuje migracji w Supabase.

SC-004 zostało wdrożone do produkcyjnego Supabase przez
`20261004000200_screening_results.sql`. Migracja dodała pięć tabel
persistowanego wyniku preselekcji oraz sześć RPC. Po wdrożeniu produkcyjny
baseline wynosi 18 tabel z RLS / 45 polityk / 3 widoki `security_invoker` /
12 publicznych RPC.

SC-005 zostało wdrożone produkcyjnie w trybie dark. Migracja
`20261005000100_screening_worker_claim_payload.sql` rozszerzyła wyłącznie
wynik `claim_screening_attempt` o niemutowalny payload workera i nie zmieniła
liczby tabel, RLS ani grantów. Edge Function `screening-worker` jest ACTIVE.
Od 26.10.2026 analiza AI jest włączona na produkcji decyzją właściciela
(`SCREENING_AI_ENABLED=true` w Vercel i Supabase, klucze OpenAI/HMAC ustawione).
Limit kredytów SC-019 (M13) nie jest jeszcze zastosowany; do tego czasu koszt
ogranicza budżet w panelu OpenAI.

## Model

| Tabela | Znaczenie |
| --- | --- |
| companies | Firma i jej właściciel z Supabase Auth |
| company_members | Dostęp pozostałych użytkowników: recruiter lub viewer |
| company_profiles | Jeden profil firmy: branża, wielkość, wartości, środowisko pracy |
| positions | Stanowisko: zadania, KPI, samodzielność 1–5, zachowania i kompetencje |
| recruitments | Rekrutacja dla stanowiska |
| candidates | Kandydat należący do jednej firmy |
| applications | Udział kandydata w rekrutacji; jedna osoba może mieć wiele aplikacji |
| assessment_stages | Uporządkowane etapy danej rekrutacji |
| candidate_assessments | Status, opcjonalny wynik 0–100 i notatka dla aplikacji i etapu |
| candidate_documents | Wersjonowany tekst CV i ręcznie zatwierdzona redakcja |
| behavior_assessment_entries | Niezmienna historia ocen zachowania z dowodami |
| exercise_definition_entries | Niezmienne wersje definicji zadań i rubryk |
| exercise_observation_entries | Niezmienna historia obserwacji wykonania zadań |
| screening_analysis_versions | Wersjonowany snapshot wejścia i stan logicznej analizy |
| screening_analysis_attempts | Próby wykonania, idempotency oraz worker lease |
| screening_criterion_results | Niezmienny wynik AI per kryterium |
| screening_result_reviews | Wersjonowana historia review człowieka |
| screening_criterion_review_overrides | Niezmienne korekty człowieka bez nadpisywania AI |

Każdy rekord operacyjny zawiera `company_id`. Złożone klucze obce wymagają tej
samej firmy po obu stronach relacji. Ocena wymaga dodatkowo tej samej rekrutacji
dla aplikacji i etapu. CV, oceny zachowania, definicje zadań i obserwacje opisują
odpowiednio [cv.md](cv.md), [behavior-assessments.md](behavior-assessments.md),
[exercise-definitions.md](exercise-definitions.md) i
[exercise-observations.md](exercise-observations.md). Nie ma automatycznej oceny,
integracji AI ani voicebota; wyniki zapisuje uprawniony użytkownik.

Widoki `latest_behavior_assessments`, `latest_exercise_definitions` i
`latest_exercise_observations` udostępniają najnowsze wersje przez
`security_invoker`, więc nadal obowiązuje RLS tabel źródłowych. Publiczne RPC to
`create_company`, `ensure_initial_company`, `review_candidate_document`,
`save_behavior_assessment`, `save_exercise_definition` i
`save_exercise_observations`.

SC-004 dodało `start_screening_analysis`,
`retry_screening_analysis` i `review_screening_result` dla owner/recruiter oraz
worker-only `claim_screening_attempt`, `complete_screening_analysis` i
`fail_screening_attempt`. Zwykła rola `authenticated` nie ma `EXECUTE` do
worker-only RPC. Dedykowana rola `screening_worker` nie ma bezpośredniego CRUD
do tabel i korzysta z hashowanego, wygasającego lease.

## Uprawnienia

| Użytkownik | Odczyt | Zapis danych operacyjnych | Zmiana nazwy firmy / członków |
| --- | --- | --- | --- |
| Właściciel | Własna firma | Tak | Tak |
| recruiter | Przypisana firma | Tak | Nie |
| viewer | Przypisana firma | Nie | Nie |
| Osoba spoza firmy / anonimowa | Nie | Nie | Nie |

RLS chroni wszystkie 18 wdrożonych tabel, w tym pięć tabel SC-004. Uprawnienia do kolumn blokują zmianę
właściciela, identyfikatorów, firmy i relacji nadrzędnych. Funkcje pomocnicze
SECURITY DEFINER mają pusty `search_path` i znajdują się w schemacie `private`.
Nie dodawaj go do Exposed schemas w Supabase. Tylko `public` jest potrzebny API.

`create_company(company_name)` jest dostępne dla zalogowanego użytkownika.
W jednej transakcji przypisuje mu firmę i tworzy pusty profil; nie przyjmuje
identyfikatora właściciela od klienta. Właściciel nie potrzebuje osobnego wpisu
w `company_members`. Dodawany członek musi już istnieć w `auth.users`.
Zapraszanie użytkowników, interfejs logowania i transfer własności to przyszły etap.

Usunięcie firmy przez API jest zablokowane. Usunięcie kandydata usuwa jego aplikacje
i oceny, usunięcie rekrutacji usuwa aplikacje, etapy i oceny, a usunięcie etapu usuwa
jego oceny. Stanowiska z rekrutacjami nie można usunąć — można je archiwizować.
Przyszły interfejs musi jasno pokazywać konsekwencje operacji usuwania.

## Wykonanie migracji

Na istniejącym projekcie Supabase otwórz SQL Editor, utwórz zapytanie, wklej cały
plik migracji i uruchom jako postgres. Plik obejmuje `begin`/`commit`, więc błąd
wycofa całą migrację. Uruchamiaj go raz; celowo nie ukrywa konfliktów istniejących
tabel przez `IF NOT EXISTS`. Nie usuwa istniejących tabel ani danych.

Po sukcesie sprawdź dziewięć tabel oraz RLS w Table Editor. Jeśli migracje będą
później zarządzane CLI, oznacz tę migrację jako wykonaną w historii migracji,
zamiast ponownie ją uruchamiać. Alternatywą dla SQL Editor jest standardowy
proces Supabase CLI: inicjalizacja lokalna, link do właściwego projektu i db push.
Nie stosuj obu metod jednocześnie. Nie uruchamiaj lokalnego db reset na produkcji.

Migracje SC-004 i SC-005 zostały zastosowane do docelowego Supabase 2026-10-04
i są zarejestrowane w zdalnej historii migracji jako `20261004000200` oraz
`20261005000100`. Nie uruchamiać ich ponownie. Testy nadal odtwarzają pełny kontrakt w efemerycznym PGlite.

Testy poniżej nie wymagają konta Supabase. Odtwarzają role i `auth.uid()` w lokalnym
PostgreSQL (PGlite), ale nie weryfikują konfiguracji zdalnego projektu, Auth, JWT ani
PostgREST. Po migracji potrzebny jest test z dwiema sesjami Supabase Auth, gdy
zostanie przygotowane logowanie. Obecny endpoint `/api/health/supabase` sprawdza
dostępność Auth, a nie obecność tej migracji.

## Korzystanie z kodu

Oba istniejące klienty Supabase korzystają z kontraktu `database.types.ts`.
`skillcheckData(client)` udostępnia typowane operacje dla całego modelu.
Zapytania firmowe mają filtr `company_id`; RLS pozostaje ostatecznym zabezpieczeniem.
Przekazuj klienta z sesją użytkownika, nigdy klienta z kluczem service role.
Publiczny klucz Supabase jest wystarczający; nie dodawaj sekretów do repozytorium.

```ts
import { createClient } from "../lib/supabase/server";
import { skillcheckData } from "../lib/supabase/skillcheck";

const db = skillcheckData(await createClient());
const { data: companyId, error } = await db.createCompany("Przykładowa firma");
if (error) throw error;
if (!companyId) throw new Error("Brak identyfikatora firmy");
const company = db.company(companyId);
const { data: position, error: positionError } = await company.positions.create({
  title: "Specjalista ds. obsługi klienta",
  tasks: ["Obsługa zgłoszeń"],
  kpis: ["Czas odpowiedzi"],
  autonomy_level: 3,
});
if (positionError) throw positionError;
```

To przykład dla przyszłego uwierzytelnionego handlera zapisu, nie kod do wykonania
podczas renderowania strony. Każda metoda zwraca standardowe `{ data, error }`.
Obsługuj błąd przed użyciem danych. Odczyt i aktualizacja jednego rekordu używają
`.single()` i zwracają błąd również wtedy, gdy RLS ukryje rekord. Usuwanie zwraca
listę usuniętych rekordów; pusta lista oznacza brak pasującego dostępnego rekordu.
Tworzenie aplikacji nie tworzy automatycznie wszystkich ocen — zapisuje się je
oddzielnie, gdy dany etap zostaje przypisany kandydatowi.

Przy kończeniu oceny ustaw jednocześnie `status: "completed"` i `completed_at`.
Przy jej ponownym otwieraniu ustaw `completed_at: null`. Statusy i zakresy wartości
sprawdza baza. Kolejność etapów jest unikalna w rekrutacji; przy zmianie kolejności
użyj wolnej dodatniej wartości przejściowej (docelowy edytor może dostać własne RPC).

Kontrakt TypeScript w `lib/supabase/database.types.ts` jest utrzymywany ręcznie.
Obejmuje 18 wdrożonych tabel, trzy widoki, 12 RPC, relacje między obiektami
publicznymi oraz celowo ograniczone typy `Insert`/`Update` zgodne z dostępnymi
ścieżkami zapisu. Tabele historii są zapisywane wyłącznie przez RPC, a firmy i ich
profile są tworzone atomowo przez RPC; ich bezpośredni `Insert` ma typ `never`.
Typy wygenerowane przez Supabase CLI należy porównywać z tym kontraktem, nie
zastępować nim ograniczeń API bez przeglądu. Baza zawsze egzekwuje uprawnienia.

`tests/database-types.test.mjs` odtwarza osiem wdrożonych migracji oraz
przygotowaną migrację SC-005 i zamraża
publiczne tabele, kolumny, relacje, widoki `security_invoker` oraz sygnatury RPC.
`tests/database-types.contract.ts` zamraża odpowiadające im typy TypeScript.

## Sprawdzenie

```sh
npm ci
npm run typecheck
npm run test:db
npm run build
```

Testy wykonują migracje w PGlite i sprawdzają istniejący model, pięć tabel
SC-004 oraz rozszerzony claim SC-005, a także
izolację odczytu/zapisu/usuwania, brak anonimowego dostępu, role, odebranie dostępu,
blokadę zmiany właściciela i firmy, złożone relacje, ograniczenia i bootstrap.
Te same kontrole są uruchamiane przez GitHub Actions. Plik lock stabilizuje wersje.

Źródła projektu zabezpieczeń:
[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
i [Database Functions](https://supabase.com/docs/guides/database/functions).


## SC-SALES-006B — zgłoszenia kontaktowe (REVIEW)

Migracja `20261007000200_sales_leads.sql` jest plikiem w repozytorium, nie wdrożeniem na zdalną bazę.
`public.sales_leads` przechowuje niezmienne zgłoszenia bez `company_id`; `public.platform_operators` przechowuje osobne uprawnienie operatora. Rola firmy ani domena e-maila nie nadaje dostępu. RLS jest włączone, API nie ma CRUD.

Jedyny zapis to `submit_sales_lead(uuid,text,text,text,text,text,text,bigint,text)` → tabela `(lead_id uuid,result_code text)`. HMAC wiąże pola, klucz, IP, czas i `auth.uid()`. Funkcja sama liczy odciski i limity. `list_sales_leads(integer default 50)`, `platform_operator_status()`, `grant_platform_operator(uuid)` i `revoke_platform_operator(uuid)` są dostępne tylko dla authenticated; lista i zmiany uprawnień wymagają aktywnego operatora. Grant/revoke zwracają tekstowy kod.

`private.sales_lead_settings` startuje wyłączone, bez sekretów. `private.sales_lead_attempts` zawiera wyłącznie odcisk, czas i kod próby. `private.sales_lead_replay_state` agreguje maksymalnie 20 ponowień na zgłoszenie. Rotacja i retire blokują ten sam wiersz ustawień co końcowa autoryzacja zapisu; poprzedni sekret pozostaje co najmniej 60 minut. Trigger usunięcia auth.users odczepia autora bez zmiany treści. Sprzątanie odbywa się przez prywatny helper, bez wyłączania triggera.

Migracja wymaga `pgcrypto` w `extensions` i przeciążenia `extensions.hmac(text,text,text)`. Inny schemat lub brak przeciążenia przerywa migrację. Nie przenosi istniejącego rozszerzenia.

Testy sekwencyjne: `npm run test:sales-leads`. Test współbieżności: `npm run test:sales-leads-concurrency`, wyłącznie jednorazowy PostgreSQL po migracji, `SALES_LEADS_TEST_DATABASE_URL` oraz jawne `SALES_LEADS_TEST_DISPOSABLE=YES`. Brak adresu oznacza SKIP, nie PASS. CI nie uruchamia tego skryptu. Domyślny przebieg obejmuje zapis, limity, operatorów i rotację. Dla każdego z trzech wariantów retire przygotować osobną jednorazową bazę, wykonać `--prepare-retire`, a po rzeczywistych 60 minutach uruchomić odpowiednio `--retire-current`, `--retire-previous` albo `--retire-after`. Skrypt nie cofa zegara ani znacznika rotacji. Pełna akceptacja współbieżności wymaga wszystkich czterech przebiegów. Nie uruchomiono ich w tym zadaniu.

Publiczne włączenie nadal wymaga 006C/006D, pełnego testu współbieżności, sekretu, operatora i zatwierdzonej informacji o danych.

## SC-008 — ranking i shortlista (implementacja)

Migracja `20261009081908_screening_ranking_shortlist.sql` rozszerza zaakceptowany
SC-006; nie jest potwierdzeniem wdrożenia na zdalną bazę. Polityka
`screening-ranking-v1` jest niemutowalna. Odczyty
`get_screening_ranking(recruitment, target_size)` oraz
`get_recruitment_shortlist(recruitment, include_removed)` działają jako invoker
pod RLS zalogowanego użytkownika. `target_size = NULL` używa domyślnej wartości
z polityki. Funkcja świeżości czyta wyłącznie metadane i sprawdza dostęp przed
odczytaniem analizy; nie nadajemy dostępu do starszego helpera odczytującego CV.

`recruitment_shortlist_entries` przechowuje audytowalny snapshot wyboru człowieka:
analizę, przegląd, wersję polityki, wynik i pokrycie. API ma wyłącznie SELECT.
Add/remove są kontrolowanymi funkcjami definer z jawną autoryzacją owner/recruiter.
Add wymaga oczekiwanych wersji źródeł i polityki. Blokady SHARE NOWAIT oraz
ponowna kontrola aktualności zapobiegają zapisaniu źródła innego niż widziane;
konflikt zwraca PT409. Usunięcie jest miękkie i idempotentne, snapshot pozostaje
niemutowalny. Viewer odczytuje, nie zapisuje. Worker i anon nie mają dostępu.

Kontrole: `npm run test:screening-ranking` (rzeczywiste funkcje SQL w PGlite)
i `npm run test:screening-ranking-concurrency` (dwa połączenia PostgreSQL;
wymaga SCREENING_TEST_DATABASE_URL do jednorazowej bazy testowej). CI uruchamia
obie bramki. Produkcyjna historia SC-007 ma numer `20261009073048`, podczas gdy
plik repozytorium ma `20261007000100`; przed przyszłym zatwierdzonym wdrożeniem
trzeba uzgodnić historię i nie wykonywać tej samej migracji drugi raz.

## Rozbieżność historii migracji produkcji (stan 2026-10-30)

Źródło: tryb tylko do odczytu workflow „DB migrate production” (`mode=inspect`),
run [41021636267](https://github.com/krzysztofsyska/skillcheck-core/actions/runs/41021636267)
z 2026-10-30 07:42 UTC, `main` @ `5c8ee94`, artefakt `db-inspection-41021636267`
(`inspection.json`, ważny do 2026-11-06). Projekt `wsvjawuikxfzjyivxgsu`, PostgreSQL 17.6.
Porównanie z `supabase/migrations` na `integration` @ `8aea00c`.
Agent nie łączył się z bazą produkcyjną bezpośrednio.

Podsumowanie: w `supabase_migrations.schema_migrations` jest 31 wierszy, w repozytorium 33 pliki.
21 migracji zgadza się wersją i nazwą. 7 ma tę samą nazwę i treść, ale inny numer wersji.
3 są tylko w bazie, 5 tylko w repozytorium.

### Brakujące w bazie (5) — pliki niezastosowane na produkcji

| # | Plik |
| ---: | --- |
| 1 | `20261021084732_sc019_credits_payments_inventory.sql` (M13) |
| 2 | `20261026220100_sc_step3_evidence_extensions.sql` |
| 3 | `20261026220200_sc_step3_evidence_worker.sql` |
| 4 | `20261028120000_sc_step3_erasure_inventory_r7.sql` |
| 5 | `20261029100000_sc019_operator_fulfillment.sql` |

### Obecne tylko w bazie (3) — migracje operacyjne bez pliku w repozytorium

| Wersja | Nazwa |
| --- | --- |
| `20261008155657` | `sc005_allow_postgres_set_screening_worker` |
| `20261008155719` | `sc005_keep_worker_role_explicit_only` |
| `20261011165916` | `sales_retention_cron_extension` |

Odtwarza je fixture `tests/fixtures/sc19-production-history.json`
(zob. `docs/release/sc-mvp-production-runbook.md`).

### Różnice numeracji (7) — ta sama nazwa, inna wersja

Zapisane w bazie instrukcje (`statements`) każdej z tych migracji występują w całości w odpowiadającym jej pliku.
Pliki zostały zastosowane, a w historii zapisano wersję nadaną w chwili wykonania.

| Nazwa | Wersja w bazie | Plik w repozytorium |
| --- | --- | --- |
| `screening_retry_active_conflict` | `20261009073048` | `20261007000100_screening_retry_active_conflict.sql` |
| `screening_latest_mutations` | `20261009091310` | `20261009080000_screening_latest_mutations.sql` |
| `screening_ranking_shortlist` | `20261009091318` | `20261009081908_screening_ranking_shortlist.sql` |
| `sales_leads` | `20261011081257` | `20261007000200_sales_leads.sql` |
| `sales_lead_inbox_retention` | `20261011081313` | `20261009073604_sales_lead_inbox_retention.sql` |
| `sales_lead_auto_reply` | `20261011081319` | `20261009104142_sales_lead_auto_reply.sql` |
| `sales_pipeline` | `20261011081326` | `20261009141832_sales_pipeline.sql` |

`tools/db-migrate/apply.mjs` rozpoznaje zastosowane migracje po **nazwie**, więc te pliki nie zostaną uruchomione ponownie.
Narzędzia porównujące po wersji (np. `supabase migration list` / `db push`) uznałyby je za brakujące.
Nie używać ich wobec produkcji.

### Wpisy bez `statements` (12)

Kroki M1–M12 runbooka SC-MVP (`20261009105025` … `20261021084245`) mają w `schema_migrations` wartość `statements = NULL`.
Nie mają też wpisu w `skillcheck_migration_ledger`, bo zastosowano je przed uruchomieniem workflow.
Narusza to regułę 1 z AGENTS.md (`statements = NULL` niedozwolone).
Uzupełnienie wymaga osobnej decyzji właściciela i przejścia przez workflow. Agent tego nie zmienia.

### Przyczyna błędów workflow „DB migrate production” z 2026-10-29

Oba nieudane uruchomienia dotyczyły `main` @ `8c09f0b` (PR #188). Żadne nie zmieniło bazy.

1. **Run [40951497826](https://github.com/krzysztofsyska/skillcheck-core/actions/runs/40951497826), 20:43 UTC.**
   Lista `migrations` zawierała M1–M12, które były już zapisane w historii.
   `apply.mjs` przed pierwszą zmianą sprawdza historię po nazwie i zatrzymał się na
   `Already applied, never re-run: 20261009105025_candidate_communication_foundation.sql`.
   To błąd danych wejściowych (zła lista migracji), nie błąd bazy.
2. **Run [40952836256](https://github.com/krzysztofsyska/skillcheck-core/actions/runs/40952836256), 20:52 UTC.**
   Lista: M13 + 4 późniejsze pliki (tabela „Brakujące w bazie”).
   M13 (`20261021084732_sc019_credits_payments_inventory.sql`) w bloku `$preflight$` liczy odcisk katalogu
   (`sc010_signature`, `routines`, `indexes`, `trigger_states`, `relations`, `policies`, `nonowned_acl`, `rewrites`)
   i wymaga dokładnej zgodności z jednym z 6 przejrzanych stanów (`r4_legacy`, `r4_voice`, `r5_legacy`, `r5_voice`,
   `orders129_legacy`, `orders152_legacy`) dla PG16/PG17.
   Produkcja nie pasuje do żadnego, więc migracja zgłosiła `sc19_source_schema_unreviewed` (55000) i została wycofana.
   Pozostałe 4 migracje nie były uruchamiane.

Inspekcja z 2026-10-30 potwierdza przyczynę 2. Najbliższy stan to `r4_legacy` (pg17).
Zgodne są `sc010_signature`, `indexes`, `trigger_states`, `relations`, `policies` i `rewrites`.
Różnią się dwa składniki:

| Składnik | Przejrzany `r4_legacy`/pg17 | Produkcja |
| --- | --- | --- |
| `routines` | `94cd7648…5c513c5f` | `00a80249…14b198c557e7` |
| `nonowned_acl` | `6428087b…3968b35` | `340b40cc…f9d68ce294` |

Następny krok: porównać `catalog.routines` i `catalog.nonowned_acl` z artefaktu z próbą generalną na PostgreSQL 17.6
(`sc19-migrations.yml`) i ustalić, które funkcje i ACL odbiegają.
Możliwe źródła różnic to M12 i trzy migracje operacyjne. To hipoteza, której jeszcze nie sprawdzono.
Potem przejrzeć nowy stan i dopisać go do listy `reviewed` w M13 w osobnym PR (L3).
Ponowne uruchomienie apply z tą samą M13 skończy się tym samym błędem.
