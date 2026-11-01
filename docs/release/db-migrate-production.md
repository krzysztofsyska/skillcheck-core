# Migracje produkcyjne — workflow `db-migrate-production`

TASK: SC-OPS-DB-MIGRATE · LEVEL: L3 · SCOPE: OPERATIONS · PRODUCTION_APPROVAL: NO

Jedyna dozwolona ścieżka migracji bazy produkcyjnej (AGENTS.md, zasady dostępu do produkcji, pkt 1).
Agent nie uruchamia tego workflow, nie zatwierdza go i nie zna sekretów. Robi to wyłącznie właściciel.

## Jak to działa

1. Właściciel uruchamia workflow ręcznie z gałęzi `main`, podając pełny SHA `main` i listę migracji.
2. Job **Plan** sprawdza, że SHA = bieżący `main`, a pliki istnieją i są w kolejności repozytorium. W podsumowaniu runu pokazuje tabelę: migracja + sha256.
3. Job **Apply** czeka na zatwierdzenie środowiska `production-approval`. Bez kliknięcia „Approve” nic się nie dzieje.
4. Po zatwierdzeniu `tools/db-migrate/apply.mjs`:
   - odmawia, jeśli plik zmienił się od planu (sha256), jeśli migracja o tej nazwie jest już zapisana albo jeśli wcześniejsza migracja z repozytorium nie jest ani zapisana, ani na liście;
   - wykonuje migracje **pojedynczo**, każdą w osobnej transakcji razem z wpisem do historii;
   - zatrzymuje się na pierwszym błędzie (ta migracja wycofuje się w całości, kolejne nie startują).
5. Wpisy: `supabase_migrations.schema_migrations` (wersja i nazwa z repo, `statements` = treść pliku) oraz `supabase_migrations.skillcheck_migration_ledger` (sha256, treść, SHA wydania, numer runu). Tabela rejestru powstaje przy pierwszym uruchomieniu.

Nigdy `supabase db push` — 7 starszych migracji ma na produkcji inne numery wersji niż w repo, więc `db push` wykonałby je drugi raz.

## Co ustawić raz (GitHub)

**GitHub → repozytorium `skillcheck-core` → Settings → Environments → `production-approval`**

1. **Required reviewers:** tylko `krzysztofsyska`.
2. **Prevent self-review: wyłączone.** Uruchamiasz i zatwierdzasz sam; przy włączonym nie da się zatwierdzić własnego runu.
3. **Allow administrators to bypass: wyłączone.**
4. **Deployment branches and tags:** „Selected branches” → `main`.
5. **Environment secrets → Add environment secret** (nie „Repository secret”):

| Nazwa | Wartość | Skąd |
| --- | --- | --- |
| `PRODUCTION_DATABASE_URL` | `postgresql://postgres.wsvjawuikxfzjyivxgsu:<HASŁO>@<HOST-POOLERA>:5432/postgres?sslmode=require` | Supabase → projekt `wsvjawuikxfzjyivxgsu` → **Connect** → zakładka **Session pooler** → skopiuj URI i wstaw hasło bazy |
| `PRODUCTION_DATABASE_CA_CERT` | cała zawartość pliku `.crt` (od `-----BEGIN CERTIFICATE-----` do `-----END CERTIFICATE-----`) | Supabase → **Project Settings → Database → SSL Configuration → Download certificate** |

- Użyj **Session pooler** (port 5432), nie „Direct connection”: bezpośrednie połączenie Supabase działa tylko po IPv6, a maszyny GitHub Actions go nie mają. Nie używaj „Transaction pooler” (6543).
- Hasło bazy: Supabase → Project Settings → Database → **Database password** (jeśli go nie masz — „Reset database password”; aplikacja z niego nie korzysta, używa kluczy API).
- Bez `PRODUCTION_DATABASE_CA_CERT` połączenie jest szyfrowane, ale bez weryfikacji certyfikatu serwera (run pokaże ostrzeżenie). Zalecane: dodać.
- Sekretów nie wklejaj nigdzie indziej — ani do repo, ani na czat.

## Warunek: workflow musi być na `main`

GitHub pozwala uruchomić workflow ręcznie tylko z pliku, który jest na gałęzi domyślnej. Plik trafi na `main` z najbliższą promocją `integration → main` (za Twoją zgodą na produkcję). Do tego czasu przycisk „Run workflow” nie będzie widoczny.

## Uruchomienie

**GitHub → Actions → „DB migrate production” → Run workflow**

- **Use workflow from:** `main`
- **release_sha:** pełny SHA bieżącego `main` (GitHub → Code → gałąź `main` → ikona historii commitów → skopiuj pełny SHA ostatniego commita).
- **migrations:** lista z jednego z kroków niżej (bez spacji, po przecinku).

Potem: otwórz run → job **Plan** → sprawdź tabelę w podsumowaniu → przy jobie **Apply** kliknij **Review deployments → production-approval → Approve and deploy**.

### Krok A — migracje bez wpływu na działanie aplikacji (M1–M12)

Addytywne; obecna aplikacja z nich nie korzysta. M5 zakłada krótkie blokady tabel — uruchom poza godzinami pracy.

```
20261009105025_candidate_communication_foundation.sql,20261009141836_candidate_communication_verification.sql,20261010190255_candidate_retention_preview.sql,20261010194216_candidate_erasure_lifecycle.sql,20261010194230_candidate_erasure_guards.sql,20261010194343_candidate_erasure_inventory_v2.sql,20261010204840_erasure_execution_protocol.sql,20261010205030_erasure_purge_graph.sql,20261010205052_erasure_inventory_v3.sql,20261012031026_retention_scheduler_protocol.sql,20261012031039_retention_scheduler_inventory.sql,20261021084245_explicit_data_api_table_acl.sql
```

Jeśli część z nich już jest na produkcji, run odmówi przed wykonaniem czegokolwiek i wypisze, która — wtedy usuń ją z listy.

### Krok B — pakiety (M13, Step 3, R7, panel operatora)

**Uwaga:** po M13 każda nowa analiza CV pobiera 1 analizę z salda firmy. Firma z pustym saldem nie uruchomi analizy, dopóki operator nie przydzieli pakietu w `/operator/billing`. Uruchom krok B dopiero, gdy jesteś gotowy od razu ustawić pakiety i obsłużyć istniejące firmy.

```
20261021084500_normalize_function_line_endings.sql,20261021084732_sc019_credits_payments_inventory.sql,20261026220100_sc_step3_evidence_extensions.sql,20261026220200_sc_step3_evidence_worker.sql,20261028120000_sc_step3_erasure_inventory_r7.sql,20261029100000_sc019_operator_fulfillment.sql
```

Po kroku B: `/operator/billing` → FREE = 5, PRESELEKCJA = 60 → przydziały dla istniejących firm → dopiero potem `SC19_PACKAGES_ENABLED=true` w Vercel Production + Redeploy.

### Krok C — limit firm na użytkownika (SC-COMPANY-LIMIT-001)

Osobna zgoda, po kroku B. `create_company` odmawia (PT409 / HTTP 409) użytkownikowi, który jest już właścicielem 1 firmy. Istniejące firmy zostają bez zmian. Onboarding (`ensure_initial_company`) działa jak dotąd.

```
20261101120000_company_creation_limit.sql
```

Wcześniejsze migracje z repozytorium muszą być już zastosowane. Jeśli którejś brakuje, run odmówi przed wykonaniem czegokolwiek i ją wypisze.

## Błąd w trakcie

Run czerwony: nieudana migracja wycofała się w całości, wcześniejsze z tego runu zostają zapisane. Nie uruchamiaj ponownie tej samej listy w ciemno — przekaż log runu do analizy; kolejny run z pozostałymi plikami po naprawie.

## Testy

`tests/db-migrate/apply.test.mjs` (PostgreSQL 16 i 17 w workflow „SC-019 forward migrations”): kolejność i walidacja listy, ramka `begin;/commit;` każdej migracji w repo, brak luk względem zaobserwowanej historii produkcji (i odmowa pominięcia M13), wpisy historii i rejestru, odmowa ponownego wykonania, wycofanie i zatrzymanie po błędzie, cały łańcuch z repo przez runner z poprawnym inwentarzem R7.

## Tryb „tylko sprawdź” (`mode: inspect`)

Gdy migracja odmawia (np. `sc19_source_schema_unreviewed`), uruchom workflow z **mode = inspect** (pole `migrations` zostaw puste) i zatwierdź jak zwykle. `tools/db-migrate/inspect.mjs` w transakcji READ ONLY, zawsze wycofywanej:

- liczy odciski struktury bazy (te same, które sprawdza M13) i porównuje je z zatwierdzonymi stanami z `tests/fixtures/sc19-migration-manifest.json`;
- odczytuje historię `supabase_migrations.schema_migrations` (treść migracji, nie dane aplikacji);
- zapisuje raport `inspection.json` jako artefakt runu (7 dni). Niczego nie zmienia i nie czyta danych klientów.

Pierwsze użycie (2026-10-29): M13 odmówiła na produkcji. M1–M12 są już zapisane na produkcji (9–21.10), przed poprawkami hostingowymi z #160 — raport ma pokazać, czym schemat różni się od zatwierdzonego stanu.

### Wynik inspekcji 2026-10-30 (run 41021636267)

- PostgreSQL 17.6; historia: 31 wpisów (M1–M12 i `20261021084245` zapisane bez treści — `statements` puste, zastosowane przed istnieniem tego workflow).
- Najbliższy zatwierdzony stan: `r4_legacy`. Różnią się tylko `routines` i `nonowned_acl`.
- `nonowned_acl`: wyłącznie krotki hostingu (EXECUTE dla `service_role` na 55 funkcjach i USAGE na `public` od `pg_database_owner`), które M13 sama usuwa przed porównaniem, oraz `MAINTAIN` z PostgreSQL 17 (uwzględnione w odcisku pg17). Po tej normalizacji odcisk = `r4_legacy`/pg17.
- `routines`: 13 funkcji ma w treści końce linii CRLF zamiast LF; poza tym treść jest identyczna. Po zamianie CRLF → LF odcisk = `r4_legacy`.
- Naprawa: `20261021084500_normalize_function_line_endings.sql` przed M13 — odtwarza te 13 funkcji z ich własnej definicji z LF, sprawdza, że właściciel i uprawnienia się nie zmieniły, i odmawia przy samotnym CR. Na bazie zbudowanej z repozytorium nic nie robi. Test: `tests/db-migrate/normalize-line-endings.test.mjs`.
