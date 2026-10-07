# SC-008 — Architektura rankingu i shortlisty rekrutacji

Status: READY_FOR_REVIEW  
Phase: A, architecture only  
Level tej fazy: L2 (dokument). Implementacja Phase B eskaluje do L3.  
Scope: BACKEND + ranking contract  
Depends on: SC-004 (wdrożony model wyniku), SC-007 (concurrency; nie zmienia scoringu)  
Blocks implementation until: SC-006 DONE, review architektury PASS, owner acceptance  
Base: `integration` @ `6495162b2c04ef39843d86070cd0ce71f7f84233`

Ten dokument nie jest migracją, RPC, zmianą RLS ani kodem UI. Phase B nie zaczyna się w tym PR.

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

Trigger `screening_application_stale` po każdym `UPDATE` zgłoszenia oznacza bieżące analizy jako stale (`application_changed`). `private.screening_stale_reason` dodatkowo zwraca `application_changed`, gdy status nie jest `new` ani `in_progress`. Analogiczne triggery pokrywają rekrutację, stanowisko i dokument.

Skutek dla rankingu, bez nowej reguły hire/reject: zmiana statusu zgłoszenia na `rejected`, `withdrawn` albo `hired` unieważnia aktualność analizy już w SC-004. Takie zgłoszenie wypada z rankingu jako `stale`, a nie jako decyzja SC-008.

### 2.4. Co robi SC-007

`20261007000100_screening_retry_active_conflict.sql` zamyka wyścig start/retry. Nie zmienia ratingu, review, RLS ani `overall_score`. Komentarz migracji mówi, że SC-007 sam nie stosuje jej na produkcji. Ranking nie zależy od tej poprawki logicznie, ale testy Phase B odtwarzają cały łańcuch migracji z `integration`, łącznie z tym plikiem.

### 2.5. Czego nie ma

- brak tabeli `recruitment_shortlist_entries`;
- brak polityki `screening-ranking-v1` w SQL;
- brak mapowania `below/meets/above` na punkty;
- `docs/BACKLOG.md` nadal opisuje SC-008 jako BACKLOG; ten PR nie zmienia backlogu;
- `lib/supabase/database.types.ts` nie ma typów rankingu; Phase A ich nie dodaje;
- UI rekrutacji nie uruchamia analizy i nie pokazuje rankingu (`docs/screening.md`).

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

### 3.2. Świeżość: kolumna i funkcja

Triggery utrzymują `stale_at`, ale `private.screening_stale_reason` jest osobną kontrolą logiczną. Odczyt rankingu traktuje analizę jako świeżą tylko gdy jednocześnie:

- `stale_at is null`;
- `private.screening_stale_reason(analysis.id) is null`.

Rozjazd oznacza `stale`. RPC odczytu niczego nie zapisuje. Utrwalenie `stale_at` zostaje przy istniejących triggerach oraz przy `review_screening_result` / `complete_screening_analysis`.

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
9. **Zaokrąglenie średniej.** `round(suma_punktów / known_criteria, 3)` funkcją PostgreSQL `round(numeric, integer)`. Porównanie coverage do progu używa dokładnego ilorazu `numeric`, przed zaokrągleniem prezentacyjnym. Coverage w wyniku RPC zostaje dokładnym `numeric`.
10. **Wagi.** Ranking-v1 jest nieważoną średnią znanych kryteriów. `criterion_kind` nie zmienia punktów. Wagi wymagają nowej wersji polityki.
11. **Phase B jest L3.** Dochodzą migracja, RLS, granty i RPC `SECURITY DEFINER`. Etykieta L2 w Issue #9 opisuje ten dokument, nie przyszłą migrację.

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

Dopóki nie istnieje żaden wpis shortlisty z daną wersją, korekta błędnego seeda może być osobną migracją z jawnym komentarzem. Po pierwszym wpisie shortlisty tej wersji korekta liczb w miejscu jest zabroniona.

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
- `raw_score` = `round(sum(points) / known_criteria, 3)`, gdy warunki z sekcji 4.4 są spełnione, inaczej `NULL`.

`total_criteria` operacyjnie jest liczbą wierszy wyniku, nie długością JSON. Dla poprawnego `completed` obie liczby są równe. Nierówność z `jsonb_array_length(criteria_snapshot)` daje `result_incomplete` i wyklucza scoring.

## 6. Reguły rankability

Kandydat jest `rankable` tylko gdy wszystkie punkty są prawdziwe:

1. istnieje analiza `execution_status = 'completed'`, `stale_at is null`, `screening_stale_reason is null`, należąca do tej rekrutacji i tego zgłoszenia;
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
| 2 | `review_inconsistent` | `max(review_version)` różni się od `latest_review_version` |
| 3 | `no_human_review` | Brak wiersza review |
| 4 | `needs_reanalysis` | Latest disposition = `needs_reanalysis` |
| 5 | `insufficient_evidence` | Review zatwierdzony, ale `total_criteria = 0` albo coverage `< min_coverage` |
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

RPC sam odczytuje bieżący stan. Argumenty klienta to: zgłoszenie, `source`, opcjonalna notatka, a dla `suggested` także `target_size`. Klient nie podaje `company_id`, `analysis_id`, `review_id`, score ani coverage.

Zapis wymaga świeżej analizy `completed` oraz latest review `approved` albo `approved_with_changes`. To obejmuje `insufficient_evidence`. Nie obejmuje `needs_reanalysis`, braku review, stale, failed, pending, processing, cancelled i braku wyniku.

`source = 'suggested'` dodatkowo wymaga, by wyliczony `suggested_shortlist` dla tego `target_size` był true. Inaczej błąd `22023`. Klient może powtórzyć wywołanie jako `manual`, jeśli reguły zapisu na to pozwalają.

Aktywny wpis tego samego zgłoszenia: błąd `PT409` (`Shortlist entry already exists`). Nieaktualny, ale jeszcze nieusunięty wpis też blokuje unikalny indeks. Odświeżenie snapshotu = miękkie usunięcie i nowy insert. RPC nie nadpisuje historii.

### 7.2. Flaga aktualności

Nie ma kolumny `current`. Słowo jest zarezerwowane w SQL, a flaga zależy od stanu źródeł, więc jest wyliczana:

`snapshot_current` jest true tylko gdy wpis ma `removed_at is null` oraz snapshotowana analiza nadal jest tą bieżącą świeżą analizą `completed` tego zgłoszenia, a `review_id` nadal jest jej latest review (`review_version = latest_review_version` i wersje się zgadzają).

`policy_current` jest true, gdy `ranking_policy_version` równa się wersji, którą bieżące RPC liczy nowe rankingi (`screening-ranking-v1` w tej generacji).

Stale, nowsza analiza albo nowszy review ustawiają `snapshot_current = false`. Wpis zostaje. Nic nie jest kasowane automatycznie i snapshot liczb nie jest przepisywany.

## 8. Kontrakt RPC

Wszystkie funkcje: `set search_path = ''`, pełne nazwy schematów. Brak argumentu `company_id`.

### 8.1. `public.get_screening_ranking`

```sql
create function public.get_screening_ranking(
  target_recruitment uuid,
  target_size integer default 10
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
- brak sesji: `42501` `Authentication required`;
- rekrutacja nie istnieje albo `has_company_access(company_id)` jest false: ten sam `42501` `No access` (bez rozróżnienia braku wiersza i obcej firmy);
- `target_size` NULL traktowany jak default polityki; wartość spoza zakresu: `22023`;
- nie aktualizuje żadnej tabeli;
- nie czyta `input_cv_text_snapshot`, `evidence`, `explanation`, `binding_snapshot`, `result_summary`, identyfikatorów providera ani dokumentów kandydata;
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

Ten sam błąd `No access`, gdy rekrutacja jest niewidoczna. Domyślnie tylko wpisy z `removed_at is null`. `include_removed = true` dodaje historię usunięć tej rekrutacji. Viewer może czytać.

### 8.3. `public.add_recruitment_shortlist_entry`

```sql
create function public.add_recruitment_shortlist_entry(
  target_application uuid,
  entry_source text,
  entry_note text default null,
  target_size integer default 10
) returns uuid
language plpgsql volatile security definer set search_path = ''
```

`SECURITY DEFINER`, bo `authenticated` nie dostaje `INSERT`. Jawne sprawdzenie: `auth.uid()` oraz `has_company_access(company_id, true)`. Brak wiersza i brak uprawnień dają ten sam `42501` `No write access`.

Zwraca `id` nowego wpisu. Błędy:

- `42501` brak zapisu;
- `22023` złe `source`, za długa notatka, zły `target_size`, `suggested` spoza aktualnej sugestii;
- `55000` `Not shortlist eligible` — brak świeżego zatwierdzonego review;
- `PT409` aktywny wpis już istnieje.

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
- wywołania nie modyfikują `screening_criterion_results`, review, override ani `applications.status`;
- `overall_score` pozostaje NULL;
- brak ścieżki hire/reject;
- brak `service_role` w kliencie i w tych funkcjach.

`get_screening_ranking` jako `SECURITY INVOKER` nie omija RLS, nawet gdyby sprawdzenie firmy zostało pominięte przy błędzie implementacji. Write musi zostać `SECURITY DEFINER` i dlatego ma obowiązkowe `has_company_access(..., true)` przed jakąkolwiek mutacją. Wzorzec błędu jest ten sam co w `review_screening_result`: `if not found or not private.has_company_access(...)`.

## 10. Plan migracji

Nie tworzyć pliku w tym PR. Nie uruchamiać niczego na bazie. Nie edytować migracji już obecnych na `integration`.

Przyszły plik, nazwany dopiero na początku Phase B, z timestampem późniejszym niż ostatnia zastosowana migracja. Na tym `integration` ostatni plik to `20261007000100_screening_retry_active_conflict.sql`. Jeśli wcześniej dojdzie kolejna migracja, timestamp shortlisty ma być od niej późniejszy.

Jedna migracja, w jednej transakcji, zawiera:

1. tabelę `private.screening_ranking_policies`, seed v1 i trigger zamrażający update/delete;
2. `private.screening_ranking_policy(text)` oraz revoke/grant execute;
3. `public.recruitment_shortlist_entries`, indeksy, FK, checki, triggery spójności i niemutowalności;
4. RLS, revoke, `GRANT SELECT`;
5. cztery funkcje publiczne z sekcji 8, revoke/grant;
6. komentarz, że `overall_score` i tabele SC-004 nie są zmieniane.

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
6. `stale_at` ustawione oraz logiczne stale przy pustym `stale_at` dają `stale`. Odczyt nie zapisuje `stale_at`.
7. Zestaw z `insufficient_data`: punkty tej pozycji nie wchodzą do sumy ani do `known_criteria`; średnia nie traktuje ich jak `below`.
8. Coverage dokładnie `0.60` (3/5 przy progu z tabeli polityki) jest rankable. Coverage niższe daje `insufficient_evidence`, `rank null`, `suggested_shortlist false`. Przy `known_criteria > 0` `raw_score` nadal wraca.
9. Remis: ta sama średnia, coverage, `below_count` i `above_count` rozstrzyga `application_id` ASC. Rank jest 1..N bez dziur.
10. `target_size` 5, 10 i default 10. Wartości 4 i 11 dają `22023`. Mniej niż N rankowalnych zwraca krótszą sugestię.
11. Add wymaga zapisu firmy. Owner i recruiter dodają. Viewer i outsider dostają `42501`. Podwójny aktywny add daje `PT409`.
12. `suggested` poza aktualną sugestią daje `22023`. `manual` dla `insufficient_evidence` z zatwierdzonym review przechodzi. `manual` przy `needs_reanalysis` daje `55000`.
13. Po stale albo nowym latest review istniejący wpis zostaje, `snapshot_current` staje się false, wiersz screeningu AI się nie zmienia. Usunięcie jest miękkie; drugi insert po remove jest dozwolony i niesie nowy snapshot.
14. Ranking i shortlista nie zmieniają `screening_criterion_results.rating`, nie dokładają review i nie ruszają `applications.status` ani `overall_score`.
15. Firma B nie czyta rankingu ani shortlisty firmy A (`42501` i puste `SELECT` RLS). Bezpośredni insert do `recruitment_shortlist_entries` jako `authenticated` pada.
16. Wynik RPC nie zawiera kolumn CV, evidence, explanation, bindingu ani payloadu providera. Test kontraktu kolumn.
17. Seed polityki: odczyt `private.screening_ranking_policy('screening-ranking-v1')` zwraca 0/50/100 i `0.60`. Update tego wiersza pada. RPC nie daje innego progu.
18. `total_criteria = 0` albo rozjazd liczby kryteriów ze snapshotem daje `result_incomplete` albo `insufficient_evidence` według sekcji 6 i nie dzieli przez zero.

Osobno, jeśli PR implementacyjny ruszy typy: `npm run typecheck` i `npm run build`. Ten PR architektoniczny ich nie uruchamia jako bramki produktu, bo nie zmienia kodu wykonywalnego.

## 13. Pytania otwarte

Nie blokują review tego dokumentu. Review może je odrzucić jako część werdyktu.

1. Czy świadoma shortlista osoby z `insufficient_evidence` zostaje dozwolona, jak w sekcji 4.5? Rekomendacja: tak.
2. Czy v1 naprawdę nie utrwala całego przebiegu rankingu (kto był na miejscu 1 w danym dniu)? Rekomendacja: nie utrwala. Wpis pamięta wybór człowieka i score tego zgłoszenia. Osobna tabela przebiegów to nowy task, jeśli audyt listy będzie wymagany.
3. Potwierdzenie, że Phase B idzie jako L3, a nie jako L2 z migracją RLS.

## 14. Blokery implementacji

- SC-006 nie jest DONE. Nie ma user-facing ścieżki, która w produkcie tworzy review. Schemat review już jest i da się go testować w PGlite bez SC-006, ale Issue #9 zabrania kodu produkcyjnego i migracji przed DONE SC-006.
- Review architektury jeszcze nie ma werdyktu PASS.
- Brak owner acceptance architektury.
- Phase B dotyka RLS, grantów i `SECURITY DEFINER`, więc czeka na dispatch L3. Ten PR nie obchodzi tej eskalacji.

## 15. Poza zakresem

- plik migracji, zmiana SQL, RLS, grantów i typów;
- implementacja RPC i testów PGlite;
- UI, copy w aplikacji, eksport SC-009;
- zmiana progu, wag, `overall_score` albo ratingów AI;
- włączanie workera, sekretów, deploy, `supabase db push`;
- `AGENT_PIPELINE_ENABLED` i `AGENT_PIPELINE_MERGE_ENABLED`;
- merge tego PR.
