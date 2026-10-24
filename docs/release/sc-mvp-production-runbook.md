# SC-MVP — runbook wydania produkcyjnego (integration → main)

Status: **PROPOZYCJA — NIEZATWIERDZONA.** Dokument nie autoryzuje żadnej zmiany na produkcji.
Data odczytu stanu: 2026-10-24, Europe/Warsaw. Zadanie: SC-MVP-RELEASE-PREP, L3, OPERATIONS.
Powiązane: draft PR #86 (promocja), PR #160 (zgodność migracji), `docs/release/promotion-manifest.md`.

## 1. Stan wejściowy (zweryfikowany odczytem, bez zapisu)

| Element | Stan |
| --- | --- |
| Kandydat | `integration` @ `5f5df6a6d9a22832359908db744db7a1be94da0d` (554 commity, 47 kroków PR, 368 plików) |
| Produkcja Vercel | `dpl_FAdsWMLnAyYVe19v6sNEY4Ci9zqm`, READY, `main` @ `76760b7ffb7e95231fc7af313cc67bc8d36fefe1` |
| Supabase produkcja | `wsvjawuikxfzjyivxgsu` („white Label”), **PostgreSQL 17.6**, 19 migracji, ostatnia `20261011165916 sales_retention_cron_extension` |
| Historia migracji | identyczna z `tests/fixtures/sc19-production-history.json` (19 pozycji) |
| Obiekty docelowe SC-010 | brak (`private.candidate_retention_policies`, `erasure_execution_config`, `erasure_executions`, `retention_delegations`, `erasure_inventory_baseline_r4`) |
| Role | istnieje tylko `screening_worker`; ról erasure brak |
| Rozszerzenia | `pg_cron 1.6.4`, `pgcrypto 1.3` |
| pg_cron | 1 aktywne zadanie: `sales-leads-retention` (`17 * * * *`) |
| `service_role` | 168 grantów tabelowych w `public` (zostaną odebrane migracją 12) |

Odczyt wykonano zapytaniami `select` (inwentarz zgodny z `tools/erasure/production-preflight.sql`).

## 2. Rozbieżność historii migracji — ZAKAZ `supabase db push`

Produkcja zapisała część migracji pod **innymi numerami wersji** niż pliki w repozytorium:

| Nazwa | Wersja w repo | Wersja na produkcji |
| --- | --- | --- |
| `screening_retry_active_conflict` | 20261007000100 | 20261009073048 |
| `sales_leads` | 20261007000200 | 20261011081257 |
| `screening_latest_mutations` | 20261009080000 | 20261009091310 |
| `screening_ranking_shortlist` | 20261009081908 | 20261009091318 |
| `sales_lead_inbox_retention` | 20261009073604 | 20261011081313 |
| `sales_lead_auto_reply` | 20261009104142 | 20261011081319 |
| `sales_pipeline` | 20261009141832 | 20261011081326 |

Dodatkowo produkcja ma 3 migracje operacyjne bez plików w repo: `sc005_allow_postgres_set_screening_worker`,
`sc005_keep_worker_role_explicit_only`, `sales_retention_cron_extension` (pokryte fixture #160).

Skutek: `supabase db push` / `migration up` porównuje wersje i **ponownie wykonałby już zastosowane migracje**.
Nigdy nie używać zbiorczego push. Każdą migrację stosujemy pojedynczo, po nazwie, zgodnie z sekcją 4.

## 3. Warunki wejścia (wszystkie muszą być spełnione)

1. Pełne CI na dokładnym SHA kandydata: wszystkie workflow SUCCESS, w tym `sc19-migrations` (PG16/17 + hosted-history).
2. Niezależne review dokładnego SHA: PASS, P0/P1 = 0, zero nierozwiązanych wątków.
3. Manifest wygenerowany ponownie dla końcowego SHA: 0 commitów nieprzypisanych (`node tools/release/promotion-manifest.mjs`).
4. **Próba generalna na PostgreSQL 17.6** (wersja produkcji): job CI `Production history / PostgreSQL 17.6-production` PASS na końcowym SHA (decyzja właściciela w sekcji 9).
5. Kopia zapasowa: potwierdzony punkt PITR / backup projektu z czasu bezpośrednio przed krokiem M1 (zapisać znacznik czasu).
6. **Spełnione (2026-10-24):** właściciel potwierdził, że żadne zewnętrzne narzędzie nie używa klucza `service_role` (migracja 12 odbiera mu dostęp do tabel). Kod aplikacji i `screening-worker` go nie używają — sprawdzono.
7. Osobna, jawna zgoda właściciela (PRODUCTION APPROVAL) obejmująca: końcowy SHA, ten runbook, listę akcji bazodanowych M1–M12 oraz automatyczne wdrożenie Vercel.

## 4. Kolejność migracji (12 z 13 pending; M13 odłożona)

**M13 (`20261021084732_sc019_credits_payments_inventory.sql`) NIE wchodzi do tego wydania.** Zakłada bezwarunkowo wyzwalacz `sc19_analysis_bill` na `public.screening_analysis_versions`, który przy braku dodatniego salda firmy zgłasza `sc19_quota_exhausted` (PT402). Przy pustych saldach zablokowałby każdą nową analizę CV — także w obecnej aplikacji z `main` (review Codex na #164). Kod `integration` przy `SC19_PACKAGES_ENABLED` ≠ `true` nie odczytuje obiektów M13 (strona główna, billing i płatności sprawdzają flagę przed RPC). M13 wejdzie w osobnym wydaniu aktywacji FREE/PRESELEKCJA, razem z przydziałem kredytów (decyzja właściciela co do 6 istniejących firm) i ponowną próbą generalną.

Każda pozycja to **osobna akcja do zatwierdzenia**. Każdy plik ma własne `begin; … commit;` — błąd wycofuje całą migrację.
Wykonawca: rola `postgres` (topologia hosted zweryfikowana w #160). Polecenie: `psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -f <plik>`.

| Krok | Plik | Zakres | Uwagi |
| --- | --- | --- | --- |
| M1 | `20261009105025_candidate_communication_foundation.sql` | 6 tabel, 10 funkcji | SC-010 komunikacja |
| M2 | `20261009141836_candidate_communication_verification.sql` | 5 tabel, 1 rola | tworzy `contact_verifier` |
| M3 | `20261010190255_candidate_retention_preview.sql` | 4 tabele | R1 |
| M4 | `20261010194216_candidate_erasure_lifecycle.sql` | 5 tabel | R2 |
| M5 | `20261010194230_candidate_erasure_guards.sql` | 26 triggerów na 22 istniejących tabelach `public` | krótkie blokady tabel z danymi — wykonać poza godzinami pracy |
| M6 | `20261010194343_candidate_erasure_inventory_v2.sql` | baseline R2 | |
| M7 | `20261010204840_erasure_execution_protocol.sql` | 5 tabel, 4 role NOLOGIN | `erasure_worker`, `erasure_ledger_attestor`, `erasure_restore_attestor`, `erasure_purge_owner`; zmienione w #160 |
| M8 | `20261010205030_erasure_purge_graph.sql` | 5 tabel, polityki RLS dla `erasure_purge_owner` | zmienione w #160; uprawnienia tymczasowe cofane przed COMMIT |
| M9 | `20261010205052_erasure_inventory_v3.sql` | baseline R3 | |
| M10 | `20261012031026_retention_scheduler_protocol.sql` | 6 tabel, rola `erasure_scheduler` | zmienione w #160; **nie** tworzy zadań pg_cron |
| M11 | `20261012031039_retention_scheduler_inventory.sql` | baseline R4 | zmienione w #160 |
| M12 | `20261021084245_explicit_data_api_table_acl.sql` | `revoke` na `service_role` (29 relacji) | patrz warunek 3.6 |
| ~~M13~~ | `20261021084732_sc019_credits_payments_inventory.sql` | — | **odłożona** do wydania aktywacji (patrz wyżej) |

Zapis historii: po każdym sukcesie dopisać wiersz do `supabase_migrations.schema_migrations` z **wersją i nazwą z repozytorium**
(zalecane — kończy dryf dla nowych migracji). Sposób zapisu historii wymaga decyzji właściciela (sekcja 9).

### Kontrole przed każdym krokiem (tylko odczyt)

- liczba wierszy w `schema_migrations` = 19 + (numer kroku − 1); żadna nazwa kroku nie jest już zapisana; po M12 łącznie 31;
- brak blokad długotrwałych: `select count(*) from pg_stat_activity where state <> 'idle' and xact_start < now() - interval '1 minute'` = 0;
- aktywne zadania pg_cron bez zmian (1 zadanie).

### Kontrole po każdym kroku (tylko odczyt)

- `psql` zakończony kodem 0, ostatnia instrukcja `COMMIT`;
- obiekty kroku istnieją (`to_regclass`), nowe role mają `rolcanlogin = false`, `rolsuper = false`, `rolbypassrls = false`;
- po M11: zapytania z `tools/erasure/production-preflight.sql` — wszystkie wymagane nazwy `recorded = true`, obiekty `present = true`;
- po M12: `select count(*) from information_schema.role_table_grants where grantee='service_role' and table_schema='public'` dla 29 relacji = 0;
- po M12: `private.sc19_*` **nie istnieją** i na `public.screening_analysis_versions` nie ma wyzwalaczy `sc19_*` (`select tgname from pg_trigger where tgrelid='public.screening_analysis_versions'::regclass and tgname like 'sc19%'` = 0 wierszy).

Błąd w kroku: **stop**. Nie ponawiać automatycznie, nie przechodzić dalej. Aplikacja produkcyjna dalej działa na starym kodzie — migracje są addytywne, a obecny `main` nie używa nowych obiektów.

## 5. Wdrożenie aplikacji

1. Dopiero po M1–M12 i kontrolach: ponownie wygenerować manifest dla końcowego SHA i porównać hash z zatwierdzonym.
2. Scalić PR #86 (`integration → main`). **Scalenie automatycznie publikuje produkcję na Vercelu** (`vercel.json`: `main: true`). Zgody GitHub Environment nie wstrzymują integracji Git Vercel.
3. Poczekać na stan READY nowego wdrożenia produkcyjnego; zapisać jego ID.

## 6. Flagi po wydaniu — bez zmian

Wszystkie nowe funkcje są domyślnie wyłączone (brak zmiennej = wyłączone). W ramach tego wydania **nie** ustawiamy:

| Zmienna | Stan | Skutek |
| --- | --- | --- |
| `SALES_LEADS_ENABLED` | `false` | formularz zgłoszeń nieaktywny |
| `SALES_AUTO_REPLY_ENABLED` | `false` | brak automatycznych e-maili |
| `SC19_PACKAGES_ENABLED` | brak | pakiety/billing ukryte, `/billing` przekierowuje |
| `COMPETENCY_BROKER_ENABLED` | brak | broker testu kompetencji wyłączony |
| operator płatności | brak | płatne endpointy zwracają 503 |
| `RETELL_*` | tylko Preview | brak połączeń głosowych na produkcji |

Włączenie FREE, sprzedaży lub płatności to **osobne** decyzje i osobne runbooki aktywacji.

## 7. Testy dymne po wdrożeniu

1. `https://skillcheck.pl` — strona główna 200, brak sekcji pakietów.
2. Logowanie testowego rekrutera fikcyjnej firmy, dashboard 200.
3. Fikcyjna rekrutacja: dodanie kandydata z syntetycznym CV, lista kandydatów, ranking i raport (SC-006/008/009) — bez regresji.
4. `/dashboard/<firma>/billing` przekierowuje na `/dashboard`.
5. `/rozmowa` pokazuje stan wyłączony; brak nowych wierszy w `sales_leads`.
6. Vercel: brak nowych błędów runtime przez 30 minut (`get_runtime_errors`).
7. Supabase: nadal 1 zadanie pg_cron; brak błędów w logach Postgres z ostatniej godziny.
8. Fikcyjna firma: nowa analiza CV przechodzi (brak `sc19_quota_exhausted`).

## 8. Wycofanie

- **Aplikacja:** promocja poprzedniego wdrożenia `dpl_FAdsWMLnAyYVe19v6sNEY4Ci9zqm` (Instant Rollback w Vercel), potem revert merge na `main`, żeby kolejny build nie przywrócił nowej wersji.
- **Baza:** migracje są addytywne i **nie są cofane**. Stary kod działa z nowym schematem (nie korzysta z nowych obiektów; M13 z wyzwalaczem rozliczeń nie jest stosowana). Wyjątek — M12: jeśli zewnętrzne narzędzie przestanie działać, nie przywracać hurtem grantów `service_role`; przygotować osobną, przejrzaną migrację tylko dla potrzebnych tabel.
- **Awaria w trakcie M1–M12:** zatrzymać sekwencję; nieudany krok wycofał się sam. Udane kroki zostają. Nie scalać `main`, dopóki pełna sekwencja nie przejdzie.
- **Ostateczność:** przywrócenie PITR do znacznika z warunku 3.5 — tylko za osobną zgodą właściciela (utrata danych zapisanych po tym czasie).

## 9. Decyzje właściciela

1. **Zakres:** ROZSTRZYGNIĘTE 2026-10-24 — pierwsze wydanie **bez płatności online**. FREE jest bezpłatny; PRESELEKCJA sprzedawana na fakturę i przydzielana ręcznie przez operatora. Operator płatności i checkout pozostają wyłączone (blokada 1 z #86 nie blokuje tego wydania). Aktywacja FREE i obsługi PRESELEKCJI to osobny runbook po wydaniu: `SC19_PACKAGES_ENABLED`, zatwierdzone liczby kredytów w `private.sc19_package_policy` (seed jest tylko przykładem), weryfikacja firmy przez operatora (`private.sc19_trial_approvals`) oraz procedura ręcznego przydziału PRESELEKCJI po fakturze.
2. **PostgreSQL 17.6:** ROZSTRZYGNIĘTE 2026-10-24 — próba w CI na obrazie przypiętym do 17.6 (job `Production history / PostgreSQL 17.6-production` w `sc19-migrations.yml`; job sprawdza dokładną wersję serwera). Warunek 3.4 spełniony, gdy job przejdzie na końcowym SHA.
3. **Historia migracji:** zapisywać 13 nowych pozycji z wersjami z repo (zalecane) i czy naprawić 7 starszych rozbieżności (`supabase migration repair`) osobnym zadaniem.
4. **`service_role`:** ROZSTRZYGNIĘTE 2026-10-24 — właściciel potwierdził, że nic zewnętrznego go nie używa.
5. **Runbook dla kontrolera:** kontroler czyta `.github/agent-pipeline/production-runbook.json` z `main`, a `main` przyjmuje tylko promocję z `integration`. Wniosek: plik musi trafić na `main` w samej promocji albo osobną, zatwierdzoną zmianą zarządczą. Propozycja w `docs/release/production-runbook.proposed.json`.
6. **Weryfikacja obejść ruleset (blokada 3 z #86):** akceptacja ręcznej weryfikacji przez właściciela zamiast automatycznej.

## 10. Czego ten dokument nie dowodzi

Zielone CI, Preview na Vercelu i ten runbook nie dowodzą gotowości produkcji. Gotowość = warunki z sekcji 3 spełnione dla końcowego SHA + jawna zgoda właściciela.
