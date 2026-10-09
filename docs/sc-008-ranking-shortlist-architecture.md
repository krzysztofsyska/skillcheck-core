# SC-008 — Architektura rankingu i shortlisty rekrutacji

Status: READY_FOR_REVIEW  
Phase: A, architecture only  
Level: L3  
Scope: BACKEND + ranking contract  
Depends on: SC-004 (wdrożony model wyniku), SC-007 (concurrency; nie zmienia scoringu)  
Blocks implementation until: SC-006 DONE, review architektury PASS, owner acceptance  
Base: `integration` @ `6495162b2c04ef39843d86070cd0ce71f7f84233`

Aktualizacja kontraktu: 2026-10-09, z uwzględnieniem SC-006 PR #61 i wdrożenia SC-007; kontynuacja istniejącego PR #47.

Ten dokument nie jest migracją, RPC, zmianą RLS ani kodem UI. Phase B nie zaczyna się w tym PR.

Phase A jest L3, nie L2. Dokument definiuje RLS, granty, autoryzację tenanta i RPC `SECURITY DEFINER`. To są granice zaufania z `AGENTS.md`, więc review tej fazy idzie ścieżką L3. Etykieta L2 w Issue #9 nie obniża tego poziomu. Implementacja nadal czeka na DONE SC-006, PASS review i owner acceptance.

## 1. Cel i granice

Ranking-v1 porządkuje zgłoszenia jednej rekrutacji wyłącznie na podstawie aktualnego, ukończonego i zatwierdzonego przez człowieka wyniku preselekcji. System może pokazać kolejność i propozycję shortlisty. Nie zmienia statusu zgłoszenia, nie zapisuje hire/reject i nie tworzy trwałego wpisu shortlisty bez wywołania użytkownika.

Obowiązujące granice:

- źródłem oceny kryterium zostaje `screening_criterion_results.rating`;
- `overall_score` zostaje `NULL` (check `screening_analysis_no_score_check`);
- nie dodajemy `rating_score`;
- wynik AI i historyczne review pozostają niezmienne;
- ranking nie zwraca tekstu CV, cytatów, explanation ani payloadu providera;
- dowody zostają w ścieżce SC-006;
- `service_role` nie wchodzi do klienta;
- tenant jest zawsze wyprowadzany z rekrutacji lub zgłoszenia, nigdy z argumentu `company_id` klienta.

## 2. Co już jest

Audyt `integration` @ `6495162`. Produkcyjny kod rankingu nie istnieje. Nie ma tabeli shortlisty, widoku rankingu ani RPC odczytu rankingu.

### 2.1. Tabele wyniku (SC-004, `20261004000200_screening_results.sql`)

Pięć tabel, RLS włączone, `SELECT` dla `authenticated`, brak grantów `INSERT`/`UPDATE`/`DELETE`:

- `screening_analysis_versions`
- `screening_analysis_attempts`
- `screening_criterion_results`
- `screening_result_reviews`
- `screening_criterion_review_overrides`

Fakty modelu użyte przez ranking:

- co najwyżej jedna bieżąca ukończona analiza na zgłoszenie: unikalny indeks częściowy `screening_analysis_current_completed_idx` na `(company_id, application_id)` gdzie `execution_status = 'completed' and stale_at is null`;
- kryteria ukończonej analizy są kompletne względem `criteria_snapshot` (tak zapisuje `complete_screening_analysis`);
- `screening_result_reviews` jest historią; `latest_review_version` na analizie jest cache numeru ostatniego review;
- override należy do jednego review; `approved` i `needs_reanalysis` nie mogą nieść override; `approved_with_changes` musi nieść co najmniej jeden;
- `rating_override` jest niezależny od `evidence_override` i `explanation_override`; sam override dowodu nie zmienia ratingu;
- bezpośredni zapis tych tabel jest zablokowany; review idzie przez `review_screening_result`.

Istniejące indeksy wystarczają do odczytu rankingu w skali jednej rekrutacji:

- `screening_analysis_status_idx (company_id, recruitment_id, execution_status, stale_at)`;
- `screening_review_history_idx (company_id, analysis_id, review_version desc)`;
- `screening_override_review_idx (company_id, review_id)`;
- `screening_criterion_order_idx (company_id, analysis_id, criterion_order)`.

### 2.2. Dostęp do firmy

`private.has_company_access(target_company, write_access)`:

- odczyt: owner albo member (`recruiter` lub `viewer`);
- zapis: owner albo member z `role = 'recruiter'`;
- viewer nie ma zapisu;
- użytkownik spoza firmy nie ma odczytu.

Role są w `company_members.role`: `recruiter | viewer`. Owner jest na `companies.owner_id`, nie w members.

### 2.3. Zgłoszenie i rekrutacja

`applications.status`: `new | in_progress | rejected | withdrawn | hired`.  
`recruitments.status`: `draft | open | paused | closed`.

Trigger `screening_application_stale` po każdym `UPDATE` zgłoszenia oznacza bieżące analizy jako stale (`application_changed`). Istniejące `private.screening_stale_reason(uuid)` zwraca `application_changed`, gdy status nie jest `new` ani `in_progress`. Analogiczne triggery pokrywają rekrutację, stanowisko i dokument.

Ta funkcja nie jest API rankingu. Jest `SECURITY DEFINER`, nie sprawdza dostępu do firmy, przyjmuje dowolne UUID analizy i robi `SELECT *` całego wiersza analizy oraz dokumentu. Wiersze te zawierają `input_cv_text_snapshot`, `source_text` i `redacted_text`. `EXECUTE` jest dziś odebrane `authenticated`. Phase B tego grantu nie dodaje i ranking tej funkcji nie wywołuje.

Skutek dla rankingu, bez nowej reguły hire/reject: zmiana statusu zgłoszenia na `rejected`, `withdrawn` albo `hired` unieważnia aktualność analizy już w SC-004. Takie zgłoszenie wypada z rankingu jako `stale`, a nie jako decyzja SC-008.

### 2.4. Co robi SC-007

`20261007000100_screening_retry_active_conflict.sql` zamyka wyścig start/retry. Nie zmienia ratingu, review, RLS ani `overall_score`. Po osobnej zgodzie właściciela 2026-10-09 poprawkę zastosowano na produkcji jako `20261009073048_screening_retry_active_conflict`. Treść funkcji jest identyczna z plikiem repozytorium. Mapowanie historii zapisano w Issue #8; przed przyszłym wdrożeniem CLI uzgodnić historię, nie wykonywać tej migracji ponownie pod starszym numerem. Ranking nie zależy od tej poprawki logicznie, ale testy Phase B odtwarzają cały łańcuch migracji z `integration`, łącznie z tym plikiem.

### 2.5. Czego nie ma

- brak tabeli `recruitment_shortlist_entries`;
- brak polityki `screening-ranking-v1` w SQL;
- brak mapowania `below/meets/above` na punkty;
- `docs/BACKLOG.md` nadal opisuje SC-008 jako BACKLOG; ten PR nie zmienia backlogu;
- `lib/supabase/database.types.ts` nie ma typów rankingu; Phase A ich nie dodaje;
- SC-006 ma implementację startu, wyników i review w otwartym PR #61; nie jest jeszcze zaakceptowane. Rankingu nadal nie ma.

## 3. Zgodność kontraktu z modelem SC-004

| Decyzja ranking-v1 | Stan modelu | Wniosek |
| --- | --- | --- |
| Tylko `completed` i `stale_at is null` | Indeks częściowy gwarantuje co najwyżej jeden taki wiersz na zgłoszenie | Da się wybrać źródło bez heurystyki „najnowsza wersja” |
| Ostatnie review `approved` albo `approved_with_changes` | Historia review + cache `latest_review_version` | Latest = wiersz o największym `review_version` |
| `rating_override` tylko z tego review | Override ma `review_id`; starsze review zostają w tabeli | Agregacja joinuje wyłącznie latest review |
| Override dowodu nie zmienia punktów | Kolumny są rozdzielone; RPC pozwala zapisać sam dowód | Effective rating zostaje przy AI, gdy `rating_override is null` |
| `insufficient_data` nie jest zerem | Brak `rating_score`; check trzyma `overall_score` w NULL | Punkty liczy tylko polityka rankingu, w locie |
| Próg coverage 0.60 | Nie istnieje w SQL | Jedna niemutowalna definicja w nowej tabeli polityki |
| Shortlista ludzka osobno od sugestii | Brak tabeli | Nowa tabela snapshotu, zapis tylko przez RPC |
| Brak hire/reject | Status zgłoszenia jest osobnym polem, zmienianym tylko kolumnowym grantem | RPC rankingu i shortlisty nie dotykają `applications.status` |

Kontrakt da się zrealizować bez przebudowy pięciu tabel SC-004.

### 3.1. Bieżący wynik w trakcie nowej analizy

`start_screening_analysis` nie unieważnia ukończonego wyniku o tym samym fingerprintcie w chwili startu. Poprzedni `completed` + `stale_at is null` zostaje jedynym bieżącym wynikiem, dopóki nowa analiza nie zakończy się sukcesem. Dopiero `complete_screening_analysis` oznacza poprzedni bieżący wynik jako stale i ustawia `superseded_by_analysis_id`.

Ranking używa wyłącznie bieżącego ukończonego wiersza. Równoległy `pending`/`processing` nie zasłania jeszcze aktualnego, zatwierdzonego wyniku. Po sukcesie nowej analizy stary wpis shortlisty staje się nieaktualny, a nowa analiza bez review dostaje `no_human_review`.

Nie wybierać `max(analysis_version)`. Wyższa wersja w trakcie wykonania nie jest źródłem rankingu.

### 3.2. Świeżość bez cudzego CV

Triggery utrzymują `stale_at`. Osobna kontrola logiczna zostaje, ale nie przez `private.screening_stale_reason(uuid)`.

Nowa funkcja, dodawana dopiero w migracji Phase B:

```sql
create function private.screening_ranking_freshness_reason(
  target_company uuid,
  target_analysis uuid
) returns text
language plpgsql stable security invoker set search_path = ''
```

`GRANT EXECUTE` tylko tej funkcji dla `authenticated`, po `REVOKE ALL` od `public`, `anon`, `authenticated` i `screening_worker`. Brak grantu na `private.screening_stale_reason(uuid)`. Nowa funkcja jej nie wywołuje.

Jest `SECURITY INVOKER`. Używa PL/pgSQL z jawnym `IF ... RETURN` przed odczytami danych; kolejność predykatów w SQL nie jest gwarancją wykonania kontroli dostępu jako pierwszej. Przy odczycie rankingu działa więc RLS wywołującego. Dodatkowo, zanim przeczyta jakikolwiek wiersz analizy, sprawdza `(select auth.uid())` i `private.has_company_access(target_company)`. Brak sesji albo brak dostępu zwraca `'unavailable'` i nie wykonuje dalszych selectów. Ten sam kod wraca, gdy wiersz analizy nie należy do `target_company` albo jest niewidoczny. `'unavailable'` nie jest świeżością i nie rozróżnia braku wiersza od obcej firmy.

`auth.uid()` czyta claim JWT, nie `current_user`. Gdy write `SECURITY DEFINER` wywoła tę funkcję, sprawdzenie firmy nadal dotyczy zalogowanego użytkownika. Write i tak najpierw robi własne `has_company_access(company_id, true)`, a `target_company` bierze z wiersza zgłoszenia, nie z klienta.

Analiza jest świeża tylko gdy jednocześnie:

- `stale_at is null`;
- `private.screening_ranking_freshness_reason(company_id, analysis_id) is null`.

Każdy nie-null powód, łącznie z `'unavailable'`, wyklucza świeżość. RPC odczytu niczego nie zapisuje. Utrwalenie `stale_at` zostaje przy istniejących triggerach oraz przy `review_screening_result` / `complete_screening_analysis`.

Semantyka powodów dla własnej firmy jest ta sama co w `private.screening_stale_reason`, liczona z wąskich kolumn:

| Powód | Warunek |
| --- | --- |
| `application_changed` | brak zgłoszenia w tej firmie, status spoza `new`/`in_progress`, albo `binding_snapshot->>'application_updated_at'` różny od `applications.updated_at` |
| `recruitment_changed` | brak rekrutacji, status spoza `draft`/`open`, albo rozjazd `recruitment_updated_at` |
| `position_changed` | brak stanowiska, `status = 'archived'`, albo rozjazd `position_updated_at` |
| `candidate_document_changed` | najnowszy dokument kandydata (`created_at desc, id desc`) ma inne `id` lub `version` niż analiza |
| `candidate_document_unreviewed` | ten dokument nie ma `status = 'reviewed'` albo brak `reviewed_by` / `reviewed_at` |
| `null` | żaden z powyższych |

Dozwolone kolumny:

- analiza: `company_id`, `recruitment_id`, `application_id`, `position_id`, `candidate_document_id`, `candidate_document_version`, `stale_at` oraz wyłącznie klucze `binding_snapshot->>'application_updated_at'`, `->>'recruitment_updated_at'`, `->>'position_updated_at'`;
- zgłoszenie: `id`, `company_id`, `candidate_id`, `status`, `updated_at`;
- rekrutacja: `id`, `company_id`, `status`, `updated_at`;
- stanowisko: `id`, `company_id`, `status`, `updated_at`;
- dokument: `id`, `company_id`, `candidate_id`, `version`, `status`, `reviewed_by`, `reviewed_at`, `created_at`.

Zakazane w funkcji świeżości: `input_cv_text_snapshot`, `criteria_snapshot`, `result_summary`, cały obiekt `binding_snapshot`, `candidate_documents.source_text`, `candidate_documents.redacted_text`, `SELECT *` oraz jakiekolwiek wywołanie `private.screening_stale_reason`. Klucze JSON czyta się wyrażeniem `->>`, bez pobierania tekstu CV. RPC rankingu może odczytać wyłącznie skalarne `jsonb_typeof(criteria_snapshot)` i `jsonb_array_length(criteria_snapshot)` do kontroli kompletności; nie zwraca ani nie ładuje całego snapshotu do zmiennej aplikacyjnej. Wyrażenie długości stosuje dopiero po potwierdzeniu typu tablicowego. Odczyt kluczy JSON może wymagać wewnętrznego odczytu wartości TOAST przez PostgreSQL; obietnica dotyczy minimalnej projekcji oraz braku treści CV w odpowiedzi, nie zerowego fizycznego I/O.

## 4. Rozstrzygnięcia przed kodem

Te punkty kontrakt Issue #9 zostawiał otwarte. Phase B implementuje je tak, jak niżej, chyba że review odrzuci dokument.

1. **Populacja odczytu.** Jeden wiersz na każde zgłoszenie rekrutacji, także `rejected` / `withdrawn` / `hired` i zgłoszenia bez analizy. Brak miejsca w rankingu nie jest odrzuceniem.
2. **Status zgłoszenia nie jest filtrem SC-008.** Wypadnięcie po hire/reject wynika z już istniejącego stale SC-004. Nowe RPC nie ustawia statusu.
3. **Kody `eligibility_reason` są zamknięte.** Lista w sekcji 6. UI później tłumaczy kody; SQL zwraca kod.
4. **`raw_score` dla `insufficient_evidence`.** Gdy jest zatwierdzony review i `known_criteria > 0`, zwracamy średnią. Rank i suggested shortlist pozostają puste. Średnia wyjaśnia lukę pokrycia. Przy `known_criteria = 0` średnia jest `NULL`.
5. **Człowiek może utrwalić shortlistę przy `insufficient_evidence`.** Próg 0.60 blokuje rank i sugestię systemową. Nie blokuje świadomego wyboru osoby, która ma świeży review `approved` albo `approved_with_changes`.
6. **`source = 'suggested'`** jest dozwolone tylko wtedy, gdy serwer w tej samej transakcji wyliczy, że zgłoszenie jest na sugestii dla podanego `target_size`. Klient nie przysyła ranku.
7. **Brak zbiorczego „zatwierdź całą sugestię”.** Jeden write = jedno zgłoszenie. Powtórzenie N razy jest akcją użytkownika. Osobnego RPC bulk nie ma w v1.
8. **Rank nie jest snapshotem.** Zależy od zestawu rówieśników. Wpis shortlisty utrwala własny `raw_score` i `coverage` kandydata oraz wersję polityki, nie miejsce na liście. Odtworzenie całej historycznej listy wymagałoby osobnej tabeli przebiegów i jest poza v1.
9. **Zaokrąglenie średniej.** `round(sum(points)::numeric / known_criteria::numeric, 3)`. Cast jest przed dzieleniem. Kolumny punktów są `integer`, a `sum` i `count` są `bigint`, więc `sum(points) / known_criteria` w PostgreSQL jest dzieleniem całkowitym: `100 / 3` daje `33`, a `round` zrobiłby z tego `33.000` zamiast `33.333`. Coverage już używa `::numeric` po obu stronach i tak zostaje. Coverage w wyniku RPC jest dokładnym `numeric`, porównywanym z progiem przed zaokrągleniem średniej.
10. **Wagi.** Ranking-v1 jest nieważoną średnią znanych kryteriów. `criterion_kind` nie zmienia punktów. Wagi wymagają nowej wersji polityki.
11. **Ta faza jest L3.** Review architektury obejmuje RLS, granty, autoryzację tenanta i RPC `SECURITY DEFINER`. Implementacja jest osobnym krokiem po PASS i akceptacji, na tym samym poziomie, nie obniżeniem do L2.

## 5. Polityka scoringu

Identyfikator: `screening-ranking-v1`.

Jedna definicja liczb, tabela w schemacie `private`, bez grantu dla `authenticated`, `anon` i `public`:

```sql
create table private.screening_ranking_policies (
  version text primary key
    check (version ~ '^screening-ranking-v[0-9]+$'),
  min_coverage numeric not null check (min_coverage > 0 and min_coverage <= 1),
  below_points integer not null check (below_points >= 0),
  meets_points integer not null check (meets_points >= 0),
  above_points integer not null check (above_points >= 0),
  min_target_size integer not null check (min_target_size >= 1),
  max_target_size integer not null check (max_target_size >= min_target_size),
  default_target_size integer not null
    check (default_target_size between min_target_size and max_target_size),
  created_at timestamptz not null default now()
);
```

Seed v1, wstawiany raz w przyszłej migracji:

| version | min_coverage | below_points | meets_points | above_points | min_target_size | max_target_size | default_target_size |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `screening-ranking-v1` | `0.60` | `0` | `50` | `100` | `5` | `10` | `10` |

`insufficient_data` nie ma kolumny punktów. Brak liczby jest częścią kontraktu, nie domyślnym zerem.

Odczyt liczb:

```sql
create function private.screening_ranking_policy(requested_version text)
returns private.screening_ranking_policies
language sql stable security definer set search_path = ''
```

`GRANT EXECUTE` tej funkcji dla `authenticated`. Zwraca jeden wiersz polityki, bez danych tenanta. Publiczne RPC nie wklejają literalnych `0`, `50`, `100` ani `0.60`. Jedyny literal wersji w RPC v1 to klucz `'screening-ranking-v1'` przy wywołaniu tej funkcji.

Trigger `BEFORE UPDATE OR DELETE` na `private.screening_ranking_policies` odrzuca zmianę i usunięcie. Nowa semantyka = nowy wiersz `INSERT`, np. `screening-ranking-v2`, plus RPC, które czyta nowy klucz. Wiersz v1 zostaje. Snapshoty shortlisty nie są przeliczane.

Polityka jest niemutowalna od chwili zapisania seeda, także zanim powstanie pierwszy wpis shortlisty. Każda korekta liczb wymaga nowej wersji i osobnej migracji; nie wolno omijać triggera. Brak wpisów nie dowodzi, że użytkownik nie zobaczył już rankingu tej wersji. Zmiana aktywnej wersji unieważnia wcześniejsze expected_policy_version i wymaga ponownego potwierdzenia wyboru.

Effective rating jednego kryterium, zawsze w ramach jednej analizy i jednego latest review:

- baza: `screening_criterion_results.rating`;
- jeśli latest disposition = `approved_with_changes` i w tym review istnieje wiersz override z `rating_override is not null`, effective rating = `rating_override`;
- `evidence_override` i `explanation_override` nie zmieniają ratingu;
- override z review o niższym `review_version` nie wchodzi do joina.

Punkty:

- `below` → `below_points`;
- `meets` → `meets_points`;
- `above` → `above_points`;
- `insufficient_data` → `NULL`.

Agregacja przy świeżej, kompletnej analizie:

- `total_criteria` = `count(*)` wierszy kryteriów tej analizy;
- `known_criteria` = liczba effective ratingów różnych od `insufficient_data`;
- `coverage` = `known_criteria::numeric / total_criteria::numeric`, gdy `total_criteria > 0`, inaczej `NULL`;
- `below_count`, `meets_count`, `above_count`, `insufficient_data_count` liczą effective rating;
- niezmiennik: `known_criteria = below_count + meets_count + above_count`;
- `total_criteria = known_criteria + insufficient_data_count`;
- `raw_score` = `round(sum(points)::numeric / known_criteria::numeric, 3)`, gdy warunki z sekcji 4.4 są spełnione, inaczej `NULL`. Oba operandy są `numeric` zanim powstanie iloraz.

`total_criteria` operacyjnie jest liczbą wierszy wyniku, nie długością JSON. Dla poprawnego `completed` obie liczby są równe. Nierówność z `jsonb_array_length(criteria_snapshot)` daje `result_incomplete` i wyklucza scoring.

## 6. Reguły rankability

Kandydat jest `rankable` tylko gdy wszystkie punkty są prawdziwe:

1. istnieje analiza `execution_status = 'completed'`, `stale_at is null`, `screening_ranking_freshness_reason(company_id, id) is null`, należąca do tej rekrutacji i tego zgłoszenia;
2. liczba wierszy kryteriów = `jsonb_array_length(criteria_snapshot)` i `total_criteria > 0`;
3. `max(review_version)` istnieje i równa się `latest_review_version`;
4. disposition tego review należy do `approved`, `approved_with_changes`;
5. `coverage >= min_coverage` polityki v1.

Wtedy `eligibility_reason = 'eligible'`, `rankable = true`. W przeciwnym razie `rankable = false`, `rank = null`, `suggested_shortlist = false`.

### 6.1. Kody powodu

Gdy bieżąca świeża analiza `completed` istnieje, pierwszy spełniony powód wygrywa:

| Kolejność | Kod | Znaczenie |
| --- | --- | --- |
| 1 | `result_incomplete` | Liczba kryteriów nie zgadza się ze snapshotem albo snapshot nie jest tablicą |
| 2 | `review_inconsistent` | `coalesce(max(review_version), 0)` różni się od `latest_review_version` |
| 3 | `no_human_review` | Brak wiersza review |
| 4 | `needs_reanalysis` | Latest disposition = `needs_reanalysis` |
| 5 | `insufficient_evidence` | Review zatwierdzony, ale coverage `< min_coverage` |
| 6 | `eligible` | Spełnione reguły rankability |

Gdy bieżącej świeżej analizy `completed` nie ma, pierwszy spełniony powód wygrywa:

| Kolejność | Kod |
| --- | --- |
| 1 | `processing` — istnieje analiza tej aplikacji ze statusem `processing` i `stale_at is null` |
| 2 | `pending` — istnieje analiza `pending` i `stale_at is null` |
| 3 | `failed` — najwyższa `analysis_version` ma status `failed` |
| 4 | `cancelled` — najwyższa `analysis_version` ma status `cancelled` |
| 5 | `stale` — istnieje `completed` ze `stale_at is not null` albo ze logicznym stale |
| 6 | `no_completed_result` |

`analysis_id` i `review_id` w wyniku odczytu są ustawione tylko dla bieżącej świeżej analizy `completed` i jej latest review. Dla powodów ze ścieżki „nie ma bieżącego completed” oba są `NULL`. Dzięki temu klient nie pobierze dowodów SC-006 ze starego albo niedokończonego wiersza przez identyfikator z rankingu.

Coverage dokładnie równe progowi jest rankable. Przykład v1: 3 znane z 5 daje coverage `0.60` i jest rankable. 2 z 5 daje `0.40`, kod `insufficient_evidence`, bez ranku. `insufficient_data` nie wchodzi do sumy ani do dzielnika `raw_score`.

### 6.2. Kolejność i sugestia

Wśród `rankable` w jednej rekrutacji:

1. `raw_score` DESC;
2. `coverage` DESC;
3. `below_count` ASC;
4. `above_count` DESC;
5. `application_id` ASC jako porządek `uuid`, nie rzutowanie na tekst.

`rank` = 1..N w tej kolejności. Nierankowalne wiersze mają `rank null` i w pełnym wyniku lecą po rankowalnych, po `application_id` ASC.

`target_size` NULL albo pominięty argument oznacza `default_target_size` z polityki. Wartość spoza `<min_target_size, max_target_size>` odrzuca całe wywołanie błędem `22023` (`Invalid ranking target size`). Brak cichego obcięcia.

`suggested_shortlist = true` wyłącznie gdy `rankable` i `rank <= target_size`. Gdy rankowalnych jest mniej niż `target_size`, sugestia zawiera wszystkich rankowalnych. Sugestia nie jest zapisem.

Brak review przy cache równym 0 oznacza `no_human_review`; brak review przy cache większym od 0 oznacza `review_inconsistent`. Pusty snapshot zawsze daje `result_incomplete`, więc nie jest ręcznie kwalifikowany.

## 7. Model shortlisty

Nowa tabela `public.recruitment_shortlist_entries`. Wpis powstaje tylko w `add_recruitment_shortlist_entry`. Usunięcie przez użytkownika jest miękkie. Kasowanie fizyczne następuje wyłącznie kaskadą z rodzicem (zgłoszenie, rekrutacja, firma), tak jak historia screeningu w SC-003.

| Kolumna | Typ | Null | Znaczenie |
| --- | --- | --- | --- |
| `id` | uuid | no | PK, `gen_random_uuid()` |
| `company_id` | uuid | no | tenant |
| `recruitment_id` | uuid | no | rekrutacja |
| `application_id` | uuid | no | zgłoszenie |
| `selected_by` | uuid | no | `auth.uid()` w RPC; FK `auth.users` `on delete restrict` |
| `selected_at` | timestamptz | no | `now()` |
| `source` | text | no | `manual` albo `suggested` |
| `analysis_id` | uuid | no | snapshot bieżącej analizy |
| `review_id` | uuid | no | snapshot latest review |
| `ranking_policy_version` | text | no | wersja użyta przy zapisie |
| `raw_score_snapshot` | numeric | yes | średnia z chwili wyboru; null gdy brak known criteria |
| `coverage_snapshot` | numeric | no | dokładny iloraz z chwili wyboru |
| `note` | text | yes | notatka, po `btrim`, max 2000 znaków |
| `removed_at` | timestamptz | yes | miękkie usunięcie |
| `removed_by` | uuid | yes | kto usunął; FK `auth.users` `on delete restrict` |

Constraints:

- `source in ('manual', 'suggested')`;
- `(removed_at is null) = (removed_by is null)`;
- `note` długość ≤ 2000;
- `unique (company_id, id)`;
- unikalny indeks częściowy `(company_id, recruitment_id, application_id) where removed_at is null` — jeden aktywny wpis na zgłoszenie;
- FK `(company_id, recruitment_id, application_id)` → `applications(company_id, recruitment_id, id)` `on delete cascade`;
- FK `(company_id, recruitment_id)` → `recruitments(company_id, id)` `on delete cascade`;
- FK `(company_id, analysis_id)` → `screening_analysis_versions(company_id, id)` `on delete cascade`;
- FK `(company_id, review_id)` → `screening_result_reviews(company_id, id)` `on delete cascade`;
- FK `(ranking_policy_version)` → `private.screening_ranking_policies(version)`.

Indeksy:

- `recruitment_shortlist_active_idx` na `(company_id, recruitment_id, selected_at desc)` gdzie `removed_at is null`;
- `recruitment_shortlist_application_idx` na `(company_id, application_id, selected_at desc)`.

Trigger `BEFORE INSERT`: analiza należy do tego `company_id`, `recruitment_id` i `application_id`; review należy do tej analizy i firmy; `selected_by` i `selected_at` są ustawione. Trigger łapie błąd RPC, nie zastępuje sprawdzenia uprawnień.

Trigger `BEFORE UPDATE`: wolno zmienić wyłącznie parę `removed_at`/`removed_by`, i tylko z NULL na NOT NULL, oba naraz. Pozostałe kolumny są niemutowalne. Nie ma undelete. Ponowne dodanie po usunięciu tworzy nowy wiersz.

Brak triggera blokującego `DELETE`. Grantu `DELETE` też nie ma. Kaskada rodzica działa jako właściciel tabeli i jest jedyną ścieżką fizycznego usunięcia.

### 7.1. Kiedy zapis jest legalny

RPC sam odczytuje bieżący stan. Argumenty klienta to: zgłoszenie, `source`, warunki oczekiwanej wersji, opcjonalna notatka, a dla `suggested` także `target_size`. Klient nie podaje `company_id`, score ani coverage. Przesyła `expected_analysis_id`, `expected_review_id` i `expected_policy_version` z wyświetlonego odczytu jako warunki wersji. Serwer sam wybiera aktualne źródło i porównuje je z tymi warunkami; identyfikatory klienta nie są źródłem autoryzacji ani danych snapshotu.

Zapis wymaga świeżej analizy `completed` oraz latest review `approved` albo `approved_with_changes`. Świeżość sprawdza `screening_ranking_freshness_reason` po własnym teście zapisu, nie `screening_stale_reason`. To obejmuje `insufficient_evidence`. Nie obejmuje `needs_reanalysis`, braku review, stale, failed, pending, processing, cancelled i braku wyniku.

`source = 'suggested'` dodatkowo wymaga, by wyliczony `suggested_shortlist` dla tego `target_size` był true. Inaczej błąd `22023`. Klient może powtórzyć wywołanie jako `manual`, jeśli reguły zapisu na to pozwalają.

Aktywny wpis tego samego zgłoszenia: błąd `PT409` (`Shortlist entry already exists`). Nieaktualny, ale jeszcze nieusunięty wpis też blokuje unikalny indeks. Odświeżenie snapshotu = miękkie usunięcie i nowy insert. RPC nie nadpisuje historii.

### 7.2. Transakcja wyboru i równoczesne zmiany

Read RPC daje stan jednej instrukcji SQL/MVCC. Nie gwarantuje, że ranking pozostaje identyczny do kliknięcia. Write wymaga warunków wersji opisanych powyżej, także dla wyboru ręcznego.

`add_recruitment_shortlist_entry` w jednej transakcji:

1. Sprawdza sesję i zapis do firmy wyprowadzonej ze zgłoszenia, zanim podejmie blokady danych tej firmy.
2. Wybiera bieżącą analizę i blokuje jej wiersz `FOR SHARE NOWAIT`; następnie blokuje zgłoszenie, rekrutację, stanowisko i aktualny dokument `FOR SHARE NOWAIT`, używając wyłącznie wąskich kolumn. Ponownie odczytuje stan po uzyskaniu blokad. Brak wiersza lub zmiana powiązania oznacza konflikt, nie fallback do innego CV.
3. Pod blokadami sprawdza świeżość, kompletność i latest review. Istniejące review/complete/stale triggery aktualizują wiersz analizy i kolidują z tą blokadą. Kontrole wersji porównuje do stanu serwera. Nie zastępuje po cichu wyniku widzianego przez użytkownika nową analizą lub nowym review.
4. Liczy ranking i sprawdza sugestię w jednej instrukcji SQL na jednym snapshotcie; snapshot punktów zapisywanego kandydata pochodzi z tego samego wyliczenia. Nie woła osobnych odczytów punktów i sugestii, między którymi mógłby zmienić się stan.
5. Zapisuje wpis z własnych danych serwera i `auth.uid()`. Zwalnia blokady dopiero przy końcu transakcji. Konkurencyjna zmiana źródeł może zakończyć się później; wtedy wpis zgodnie z kontraktem jest historyczny i `snapshot_current=false`.

NOWAIT zapobiega oczekiwaniu w odwrotnej kolejności do istniejących triggerów, które blokują najpierw materiał, a potem analizę. Błędy `55P03`, `40P01`, `40001` oraz konflikt unikalnego aktywnego wpisu są tłumaczone na `PT409`. Cały zapis wycofuje się; UI zachowuje notatkę, odświeża wynik i wymaga ponownego potwierdzenia. Nie ponawia automatycznie wyboru na nowej wersji.

Sugestia oznacza top N na snapshotcie serwerowego wyliczenia w transakcji wyboru, nie gwarancję miejsca po każdym późniejszym zapisie innego kandydata. Nie blokujemy wszystkich zgłoszeń rekrutacji. Wpis zapisuje własny score/coverage oraz źródła, nie historyczny rank całej populacji.

Dwa równoczesne add są rozstrzygane unikalnym indeksem: jeden wpis, drugi `PT409`. Remove blokuje docelowy wpis `FOR UPDATE`, ponownie sprawdza stan i miękko usuwa; powtórzenie pozostaje idempotentne. Add/remove nie wykonują zmian w tabelach screeningu.

### 7.3. Flaga aktualności

Nie ma kolumny `current`. Słowo jest zarezerwowane w SQL, a flaga zależy od stanu źródeł, więc jest wyliczana:

`snapshot_current` jest true tylko gdy wpis ma `removed_at is null` oraz snapshotowana analiza nadal jest tą bieżącą świeżą analizą `completed` tego zgłoszenia, a `review_id` nadal jest jej latest review (`review_version = latest_review_version` i wersje się zgadzają). Świeżość bierze się z tej samej `screening_ranking_freshness_reason`, nie z `screening_stale_reason`.

`policy_current` jest true, gdy `ranking_policy_version` równa się wersji, którą bieżące RPC liczy nowe rankingi (`screening-ranking-v1` w tej generacji).

Stale, nowsza analiza albo nowszy review ustawiają `snapshot_current = false`. Wpis zostaje. Nic nie jest kasowane automatycznie i snapshot liczb nie jest przepisywany.

## 8. Kontrakt RPC

Wszystkie funkcje: `set search_path = ''`, pełne nazwy schematów. Brak argumentu `company_id`.

### 8.1. `public.get_screening_ranking`

```sql
create function public.get_screening_ranking(
  target_recruitment uuid,
  target_size integer default null
) returns table (
  application_id uuid,
  analysis_id uuid,
  review_id uuid,
  rank integer,
  rankable boolean,
  eligibility_reason text,
  raw_score numeric,
  coverage numeric,
  total_criteria integer,
  known_criteria integer,
  below_count integer,
  meets_count integer,
  above_count integer,
  insufficient_data_count integer,
  suggested_shortlist boolean,
  ranking_policy_version text,
  shortlist_entry_id uuid,
  shortlist_snapshot_current boolean
)
language plpgsql stable security invoker set search_path = ''
```

Dwa ostatnie pola są rozszerzeniem minimalnej listy z Issue #9. Pozwalają oznaczyć aktywną shortlistę bez drugiego odczytu i bez danych osobowych. Pełny rekord shortlisty (kto, kiedy, notatka, usunięcia) zostaje w osobnym RPC.

Zachowanie:

- `SECURITY INVOKER`, więc RLS zgłoszeń i screeningu działa dodatkowo obok jawnego sprawdzenia;
- świeżość wyłącznie przez `private.screening_ranking_freshness_reason`; brak wywołania `private.screening_stale_reason`;
- brak sesji: `42501` `Authentication required`;
- rekrutacja nie istnieje albo `has_company_access(company_id)` jest false: ten sam `42501` `No access` (bez rozróżnienia braku wiersza i obcej firmy);
- `target_size` NULL traktowany jak default polityki; wartość spoza zakresu: `22023`;
- nie aktualizuje żadnej tabeli;
- nie czyta treści CV: `input_cv_text_snapshot`, `candidate_documents.source_text`, `candidate_documents.redacted_text`, ani `evidence`, `explanation`, całego `binding_snapshot`, `result_summary` czy identyfikatorów providera; dozwolone są wyłącznie projekcje kluczy bindingu i metadanych dokumentu wymienione w sekcji 3.2 oraz skalarne kontrole kompletności kryteriów;
- `shortlist_entry_id` wskazuje aktywny wpis (`removed_at is null`) albo jest NULL;
- `ranking_policy_version` w każdym wierszu to wersja użyta do tego wyliczenia.

Sortowanie wyniku: rankowalne według `rank` ASC, potem pozostałe według `application_id` ASC.

### 8.2. `public.get_recruitment_shortlist`

```sql
create function public.get_recruitment_shortlist(
  target_recruitment uuid,
  include_removed boolean default false
) returns table (
  entry_id uuid,
  application_id uuid,
  selected_by uuid,
  selected_at timestamptz,
  source text,
  analysis_id uuid,
  review_id uuid,
  ranking_policy_version text,
  raw_score_snapshot numeric,
  coverage_snapshot numeric,
  note text,
  snapshot_current boolean,
  policy_current boolean,
  removed_at timestamptz,
  removed_by uuid
)
language plpgsql stable security invoker set search_path = ''
```

Ten sam błąd `No access`, gdy rekrutacja jest niewidoczna. Świeżość snapshotu liczy `screening_ranking_freshness_reason`. Domyślnie tylko wpisy z `removed_at is null`. `include_removed = true` dodaje historię usunięć tej rekrutacji. Viewer może czytać.

### 8.3. `public.add_recruitment_shortlist_entry`

```sql
create function public.add_recruitment_shortlist_entry(
  target_application uuid,
  entry_source text,
  expected_analysis_id uuid,
  expected_review_id uuid,
  expected_policy_version text,
  entry_note text default null,
  target_size integer default null
) returns uuid
language plpgsql volatile security definer set search_path = ''
```

`SECURITY DEFINER`, bo `authenticated` nie dostaje `INSERT`. Jawne sprawdzenie: `auth.uid()` oraz `has_company_access(company_id, true)`. Brak wiersza i brak uprawnień dają ten sam `42501` `No write access`.

Zwraca `id` nowego wpisu. Błędy:

- `42501` brak zapisu;
- `22023` złe `source`, za długa notatka, zły `target_size`, `suggested` spoza aktualnej sugestii;
- `55000` `Not shortlist eligible` — brak świeżego zatwierdzonego review;
- `PT409` aktywny wpis już istnieje, wersja analizy/review/polityki zmieniła się albo trwa kolidujący zapis; odśwież i ponownie potwierdź wybór.

Funkcja nie zmienia tabel screeningu ani `applications.status`.

### 8.4. `public.remove_recruitment_shortlist_entry`

```sql
create function public.remove_recruitment_shortlist_entry(
  target_entry uuid
) returns uuid
language plpgsql volatile security definer set search_path = ''
```

Ustawia `removed_at = clock_timestamp()` i `removed_by = auth.uid()` na aktywnym wpisie. Każdy użytkownik z zapisem do firmy może usunąć wpis, nie tylko `selected_by`. Powtórne usunięcie już miękko usuniętego wpisu zwraca to samo `id` i nic nie zmienia. Brak wiersza albo brak zapisu: `42501` `No write access`.

### 8.5. Granty funkcji

Wzorzec SC-004: najpierw `REVOKE ALL` od `public`, `anon`, `authenticated` i `screening_worker`, potem:

- `GRANT EXECUTE` odczytów i obu write do `authenticated`;
- `screening_worker` nie dostaje rankingu ani shortlisty;
- `anon` nie dostaje nic.

## 9. RLS i bezpieczeństwo

`recruitment_shortlist_entries`:

- `ENABLE ROW LEVEL SECURITY`;
- `REVOKE ALL` od `public`, `anon`, `authenticated`, `screening_worker`;
- `GRANT SELECT` dla `authenticated`;
- jedna polityka `recruitment_shortlist_read` `FOR SELECT TO authenticated USING (private.has_company_access(company_id))`;
- brak polityk zapisu; zapis omija RLS tylko wewnątrz funkcji `SECURITY DEFINER` po sprawdzeniu zapisu.

Istniejących polityk pięciu tabel screeningu ta zmiana nie rusza.

Kontrole, które Phase B musi utrzymać:

- ranking obcej firmy jest niewidoczny i kończy się tym samym błędem co nieistniejąca rekrutacja;
- viewer czyta ranking i shortlistę, nie wywołuje add/remove;
- outsider nie czyta i nie zapisuje;
- recruiter i owner zapisują tylko w swojej firmie;
- bezpośredni `INSERT`/`UPDATE`/`DELETE` tabeli shortlisty z roli `authenticated` pada;
- odpowiedź rankingu nie zawiera CV, cytatów, explanation, bindingu, `result_summary` ani identyfikatorów providera;
- `authenticated` nie dostaje `EXECUTE` na `private.screening_stale_reason(uuid)`;
- świeżość rankingu i shortlisty idzie wyłącznie przez `private.screening_ranking_freshness_reason`, która po odmowie dostępu nie czyta wierszy, a przy zgodzie czyta tylko kolumny z sekcji 3.2;
- wywołania nie modyfikują `screening_criterion_results`, review, override ani `applications.status`;
- `overall_score` pozostaje NULL;
- brak ścieżki hire/reject;
- brak `service_role` w kliencie i w tych funkcjach.

`get_screening_ranking` jako `SECURITY INVOKER` nie omija RLS, nawet gdyby sprawdzenie firmy zostało pominięte przy błędzie implementacji. Write musi zostać `SECURITY DEFINER` i dlatego ma obowiązkowe `has_company_access(..., true)` przed jakąkolwiek mutacją. Wzorzec błędu jest ten sam co w `review_screening_result`: `if not found or not private.has_company_access(...)`.

## 10. Plan migracji

Nie tworzyć pliku w tym PR. Nie uruchamiać niczego na bazie. Nie edytować migracji już obecnych na `integration`.

Przyszły plik, nazwany dopiero na początku Phase B, z timestampem późniejszym niż ostatnia zastosowana migracja. Numer wygenerować narzędziem migracji dopiero w Phase B, po sprawdzeniu aktualnego repozytorium i historii środowiska docelowego. Historia produkcji obejmuje już `20261009073048`; nie opierać chronologii wyłącznie na dawnym baseline dokumentu. Nie powielać zastosowanej poprawki SC-007.

Jedna migracja, w jednej transakcji, zawiera:

1. tabelę `private.screening_ranking_policies`, seed v1 i trigger zamrażający update/delete;
2. `private.screening_ranking_policy(text)` oraz revoke/grant execute;
3. `private.screening_ranking_freshness_reason(uuid, uuid)` z sekcji 3.2, revoke/grant execute dla `authenticated`; bez zmiany grantów `private.screening_stale_reason(uuid)`;
4. `public.recruitment_shortlist_entries`, indeksy, FK, checki, triggery spójności i niemutowalności;
5. RLS, revoke, `GRANT SELECT`;
6. cztery funkcje publiczne z sekcji 8, revoke/grant; odczyty i zapis shortlisty wołają wyłącznie nową funkcję świeżości;
7. komentarz, że `overall_score` i tabele SC-004 nie są zmieniane.

Po migracji, w tym samym PR implementacyjnym, ręczna aktualizacja `lib/supabase/database.types.ts`:

- `recruitment_shortlist_entries` z `Insert: never` i `Update: never`;
- sygnatury czterech funkcji w `Database['public']['Functions']`.

Bez regenerowania typów z produkcji w tym zadaniu i bez `supabase db push`.

Aktualizacja `docs/database.md` i `docs/screening.md` należy do PR implementacyjnego, po tym jak migracja realnie istnieje. Ten dokument architektoniczny jest źródłem kontraktu do tego czasu.

## 11. Kontrakt UI na później

Phase A nie dodaje ekranu. SC-006 nadal jest uruchomieniem analizy i podglądem dowodów. Nie woła RPC shortlisty i nie liczy rankingu.

Przyszły ekran jednej rekrutacji:

- czyta `get_screening_ranking(recruitmentId, targetSize)`;
- nie liczy punktów w przeglądarce i nie trzyma progu 0.60 w kodzie UI;
- pokazuje `rank` albo pustą pozycję, kod powodu, `raw_score`, coverage, liczniki i badge sugestii;
- imię kandydata bierze z już dozwolonego odczytu `applications` / `candidates` po `application_id`, nie z RPC rankingu;
- dowody otwiera ścieżką SC-006, po `analysis_id` zwróconym tylko dla bieżącego completed;
- czyta skład shortlisty z `get_recruitment_shortlist`;
- badge nieaktualności bierze z `snapshot_current = false`, bez chowania wiersza;
- akcje add (`manual` albo `suggested`) i remove są dostępne dla owner/recruiter; viewer widzi odczyt;
- brak przycisku hire/reject na tym kontrakcie;
- `target_size` wybierany w zakresie 5–10, domyślnie 10;
- błąd `PT409` oznacza, że aktywny wpis już jest; odświeżenie nieaktualnego wpisu wymaga najpierw remove.

Słownik kodów dla późniejszego copy, nie dla SQL:

| Kod | Sens dla rekrutera |
| --- | --- |
| `eligible` | W rankingu |
| `insufficient_evidence` | Za mało ocenionych kryteriów, to nie jest odmowa |
| `no_human_review` | Wynik czeka na człowieka |
| `needs_reanalysis` | Ostatni review kazał powtórzyć analizę |
| `stale` | Wynik przestał być aktualny |
| `pending` | Analiza czeka |
| `processing` | Analiza trwa |
| `failed` | Ostatnie wykonanie nie doszło do wyniku |
| `cancelled` | Wykonanie zostało przerwane |
| `no_completed_result` | Nie ma ukończonego wyniku |
| `result_incomplete` | Wynik jest niespójny z snapshotem kryteriów |
| `review_inconsistent` | Historia review nie zgadza się z cache wersji |

## 12. Plan testów Phase B

Nowy plik `tests/screening-ranking-database.test.mjs`, harness PGlite jak w `tests/screening-result-database.test.mjs`. Łańcuch migracji obejmuje wszystkie pliki z `integration` plus migrację shortlisty, w tym `20261007000100_screening_retry_active_conflict.sql`. Role: owner A, owner B, recruiter, viewer, outsider. Asercje na `error.code`.

Przypadki wymagane przez Issue #9, rozwinięte o rozstrzygnięcia tego dokumentu:

1. Źródłem jest jedyny bieżący `completed` ze `stale_at is null`. Starszy superseded i nowszy `pending` nie zmieniają effective ratingu ani `analysis_id`.
2. `approved` oraz `approved_with_changes` są rankable, gdy coverage wystarcza.
3. `rating_override` latest review zmienia `raw_score`. Override z wcześniejszego review nie zmienia.
4. Sam `evidence_override` albo `explanation_override` przy `rating_override is null` zostawia punkty z ratingu AI.
5. Latest `needs_reanalysis` wyklucza, z kodem `needs_reanalysis`, bez ranku i bez sugestii.
6. `stale_at` ustawione oraz logiczne stale przy pustym `stale_at` dają `stale`. Odczyt nie zapisuje `stale_at`. Powód logiczny pochodzi z `screening_ranking_freshness_reason`. Dla własnej firmy zgadza się z wynikiem superuserowego `screening_stale_reason` na tym samym fixture, ale ranking jako `authenticated` tej starej funkcji nie wywołuje.
7. Zestaw z `insufficient_data`: punkty tej pozycji nie wchodzą do sumy ani do `known_criteria`; średnia nie traktuje ich jak `below`.
8. Coverage dokładnie `0.60` (3/5 przy progu z tabeli polityki) jest rankable. Coverage niższe daje `insufficient_evidence`, `rank null`, `suggested_shortlist false`. Przy `known_criteria > 0` `raw_score` nadal wraca.
9. Tie-breaki są osobnymi testami. W każdym teście klucze ważniejsze są równe, a `application_id` oraz klucze dalsze wskazują przeciwnika, żeby pominięcie albo odwrócenie sprawdzanego klucza oblało asercję. Oczekiwany zwycięzca ma większy `application_id`, chyba że test dotyczy właśnie tego klucza.
   - **raw_score.** A: `above, above, below, insufficient` → `round(200::numeric / 3, 3) = 66.667`, coverage `0.75`, `below_count = 1`, `above_count = 2`, większy uuid. B: trzy `above` i dziewięć `meets` → raw `62.5`, coverage `1`, `below_count = 0`, `above_count = 3`, mniejszy uuid. A jest pierwsza mimo gorszej coverage, gorszego `below_count`, gorszego `above_count` i większego uuid.
   - **coverage.** Przy równym raw `75`. A: cztery `above`, jeden `meets`, jeden `below` → coverage `1`, `below_count = 1`, `above_count = 4`, większy uuid. B: pięć `above`, pięć `meets` i cztery `insufficient_data` → raw `75`, coverage `10/14`, `below_count = 0`, `above_count = 5`, mniejszy uuid. A jest pierwsza.
   - **below_count.** Przy równym raw `50` i coverage `1`. A: dwa `meets` → `below_count = 0`, `above_count = 0`, większy uuid. B: `above` i `below` → `below_count = 1`, `above_count = 1`, mniejszy uuid. A jest pierwsza.
   - **above_count.** Przy równym raw `75`, coverage `1` i `below_count = 0`. A: dwa `above` i dwa `meets` → `above_count = 2`, większy uuid. B: jeden `above` i jeden `meets` → `above_count = 1`, mniejszy uuid. A jest pierwsza.
   - **application_id.** Dwa zgłoszenia z identycznym wektorem dwóch `meets`. Mniejszy uuid ma rank 1.
   - **Precedencja w jednym rankingu.** Te pięć par układów, jako pięć osób albo jako sąsiednie pary w jednym wyniku, ma rank zgodny z kolejnością kluczy: wyższy raw przed lepszą coverage, wyższa coverage przed mniejszym `below_count`, mniejszy `below_count` przed większym `above_count`, większy `above_count` przed mniejszym uuid. Jeden test nie może zastąpić pięciu izolowanych, bo remis na wyższych kluczach nie uruchamia niższego.
10. `target_size` 5, 10 i default 10. Wartości 4 i 11 dają `22023`. Mniej niż N rankowalnych zwraca krótszą sugestię. Dla obu RPC dodatkowy fixture nowej polityki z default_target_size = 7: argument pominięty i jawne NULL dają 7, jawne 10 daje 10. Próba UPDATE/DELETE polityki przed pierwszą shortlistą także jest odrzucana; przełączenie wersji między odczytem a add daje PT409 dla poprzedniego expected_policy_version.
11. Add wymaga zapisu firmy. Owner i recruiter dodają. Viewer i outsider dostają `42501`. Podwójny aktywny add daje `PT409`.
12. `suggested` poza aktualną sugestią daje `22023`. `manual` dla `insufficient_evidence` z zatwierdzonym review przechodzi. `manual` przy `needs_reanalysis` daje `55000`.
13. Po stale albo nowym latest review istniejący wpis zostaje, `snapshot_current` staje się false, wiersz screeningu AI się nie zmienia. Usunięcie jest miękkie; drugi insert po remove jest dozwolony i niesie nowy snapshot.
14. Ranking i shortlista nie zmieniają `screening_criterion_results.rating`, nie dokładają review i nie ruszają `applications.status` ani `overall_score`.
15. Firma B nie czyta rankingu ani shortlisty firmy A (`42501` i puste `SELECT` RLS). Bezpośredni insert do `recruitment_shortlist_entries` jako `authenticated` pada.
16. Wynik RPC nie zawiera kolumn CV, evidence, explanation, bindingu ani payloadu providera. Test kontraktu kolumn.
17. Seed polityki: odczyt `private.screening_ranking_policy('screening-ranking-v1')` zwraca 0/50/100 i `0.60`. Update tego wiersza pada. RPC nie daje innego progu.
18. `total_criteria = 0` albo rozjazd liczby kryteriów ze snapshotem daje `result_incomplete` i nie dzieli przez zero.
19. Dzielenie całkowite. Jeden `above` i dwa `below`: suma punktów `100`, `known_criteria = 3`. `raw_score` równa się `33.333`, nie `33` i nie `33.000`.
20. Świeżość i granty. `authenticated` dostaje `42501` na `private.screening_stale_reason(uuid)`. `pg_get_functiondef` nowej funkcji nie zawiera `input_cv_text_snapshot`, `source_text`, `redacted_text`, `screening_stale_reason` ani `select *`. Wywołanie z firmą B albo bez sesji zwraca `unavailable` i nie zwraca NULL. Własna firma z logicznym stale dostaje kod z tabeli w sekcji 3.2.

21. Warunki wersji: zmiana review lub analizy po wyświetleniu strony daje `PT409`; serwer nie zapisuje nowszego, niewidzianego źródła. Obce expected IDs nie ujawniają danych ani nie obchodzą dostępu.
22. Brak review/cache 0 daje `no_human_review`; brak review/cache >0 daje `review_inconsistent`; pusty lub uszkodzony snapshot daje `result_incomplete`, również dla ręcznego add.
23. Kontrola kompletności jest bezpieczna dla nie-tablicowego JSON; ranking nie zwraca treści snapshotu.

Osobny zestaw na rzeczywistym PostgreSQL, co najmniej dwa połączenia (jak SC-007): add kontra review; add kontra edycja CV/stanowiska; add kontra zakończenie nowej analizy; dwa add; dwa remove; add kontra remove. Wymusić oba porządki blokad. Sprawdzać finalne wiersze, snapshoty i kody konfliktu, nie tylko brak wyjątku. Nie może być dwóch aktywnych wpisów, zapisu źródeł innych niż oczekiwane, surowego deadlocka ani częściowego wpisu. Zmiana źródła zakończona po poprawnym add musi pozostawić audytowalny wpis z `snapshot_current=false`.

Testy izolowanych kluczy sortowania z punktu 9 mogą używać wejść agregatora o różnych liczbach kryteriów; nie wolno udawać, że są poprawnymi aktualnymi analizami różnych profili w jednej rekrutacji. Testy integracyjne muszą budować spójne snapshoty wspólnego stanowiska; kombinacje kluczy nieosiągalne przy jednakowej liczbie kryteriów weryfikować na czystym agregatorze. Zachować weryfikację deterministycznego końcowego porządku w realnym RPC.

Osobno, jeśli PR implementacyjny ruszy typy: `npm run typecheck` i `npm run build`. Ten PR architektoniczny ich nie uruchamia jako bramki produktu, bo nie zmienia kodu wykonywalnego.

## 13. Pytania otwarte

Nie blokują review tego dokumentu. Review może je odrzucić jako część werdyktu.

1. Czy świadoma shortlista osoby z `insufficient_evidence` zostaje dozwolona, jak w sekcji 4.5? Rekomendacja: tak.
2. Czy v1 naprawdę nie utrwala całego przebiegu rankingu (kto był na miejscu 1 w danym dniu)? Rekomendacja: nie utrwala. Wpis pamięta wybór człowieka i score tego zgłoszenia. Osobna tabela przebiegów to nowy task, jeśli audyt listy będzie wymagany.

Poziom L3 tej fazy jest rozstrzygnięty review i nie jest już pytaniem otwartym.

## 14. Blokery implementacji

- SC-006 nie jest DONE/accepted. Implementacja ścieżki review jest w PR #61 i czeka na domknięcie przeglądu oraz akceptację. Schemat review już jest i da się go testować w PGlite bez SC-006, ale Issue #9 zabrania kodu produkcyjnego i migracji przed DONE SC-006.
- Review architektury jeszcze nie ma werdyktu PASS.
- Brak owner acceptance architektury.
- Phase A jest już L3. Implementacja nie startuje przed PASS review, owner acceptance i DONE SC-006. Ten PR nie dodaje migracji.

## 15. Poza zakresem

- plik migracji, zmiana SQL, RLS, grantów i typów;
- implementacja RPC i testów PGlite;
- UI, copy w aplikacji, eksport SC-009;
- zmiana progu, wag, `overall_score` albo ratingów AI;
- włączanie workera, sekretów, deploy, `supabase db push`;
- `AGENT_PIPELINE_ENABLED` i `AGENT_PIPELINE_MERGE_ENABLED`;
- merge tego PR.
