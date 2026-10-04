# SC-003 — Architektura persistowanego wyniku preselekcji AI

Status: PROPOSED / architecture-first  
Level: L3  
Depends on: SC-002  
Blocks: SC-004, SC-005, SC-007, SC-008

## 1. Cel i granice

Celem SC-003 jest zamrożenie kontraktu danych dla trwałego, audytowalnego wyniku analizy CV przypisanego do konkretnego `application` w konkretnej rekrutacji. Dokument definiuje model danych, relacje, lifecycle, versioning, stale detection, idempotency, concurrency, human review, RLS, transakcje i wymagania privacy/ranking.

SC-003 nie implementuje kodu, migracji, RLS, RPC ani integracji z dostawcą AI. Implementacja rozpoczyna się dopiero w SC-004.

Istniejące kontrakty pozostają obowiązujące:
- każdy rekord operacyjny ma `company_id`;
- izolacja tenantów jest egzekwowana przez RLS;
- aplikacja nie używa `service_role` w runtime;
- zewnętrzne AI może otrzymać wyłącznie zatwierdzony materiał z `prepareScreening`;
- oryginalne CV, dane kontaktowe i wewnętrzne identyfikatory nie mogą trafić do zewnętrznego AI;
- wynik AI nie jest automatyczną decyzją „zatrudnij/odrzuć”;
- zmiana wejścia unieważnia aktualność wyniku;
- cytaty muszą odpowiadać zatwierdzonemu `redacted_text` znak w znak i używać offsetów UTF-16 zgodnych z istniejącym walidatorem.

## 2. Najważniejsza decyzja modelowa

Nie używać jednego pola status do opisania całego życia wyniku.

Trzy osie są niezależne:

1. **execution status** — stan wykonania logicznej analizy: `pending | processing | completed | failed | cancelled`;
2. **freshness** — aktualność względem bieżącego materiału: wynik jest current, dopóki `stale_at IS NULL`; po zmianie wejścia ustawiane są `stale_at` i `stale_reason`;
3. **human review** — niezależna historia review; wynik może być jednocześnie `completed`, `reviewed` i później `stale`.

To rozdzielenie zapobiega utracie informacji, pozwala zachować review history i upraszcza SC-008.

## 3. Proponowane tabele

### 3.1. `screening_analysis_versions`

Jedna wersja logicznego wyniku preselekcji dla jednego zgłoszenia i jednego zamrożonego wejścia.

| Kolumna | Typ | Null | Znaczenie |
| --- | --- | --- | --- |
| `id` | uuid | no | PK, `gen_random_uuid()` |
| `company_id` | uuid | no | tenant |
| `recruitment_id` | uuid | no | rekrutacja |
| `application_id` | uuid | no | analizowane zgłoszenie |
| `position_id` | uuid | no | stanowisko użyte do snapshotu |
| `candidate_document_id` | uuid | no | zatwierdzony dokument będący źródłem |
| `candidate_document_version` | integer | no | wersja dokumentu z chwili przygotowania |
| `analysis_version` | integer | no | monotoniczna wersja dla `application_id` |
| `input_fingerprint` | text | no | 64-znakowy lowercase SHA-256 istniejącego `prepareScreening` |
| `analysis_contract_hash` | text | no | SHA-256 canonical analysis contract; obowiązkowy dla reuse/idempotency |
| `payload_schema_version` | integer | no | obecnie 1; wersja wejścia do AI |
| `result_schema_version` | integer | no | wersja struktury odpowiedzi/scoringu |
| `prompt_version` | text | no | jawna wersja instrukcji system/developer |
| `provider` | text | no | np. `openai`; bez sekretów |
| `model` | text | no | nazwa modelu |
| `model_revision` | text | yes | pinned snapshot/revision jeśli dostawca udostępnia |
| `execution_status` | text | no | `pending|processing|completed|failed|cancelled` |
| `input_cv_text_snapshot` | text | no | dokładny zatwierdzony redacted text wysłany do modelu |
| `criteria_snapshot` | jsonb | no | dokładna, uporządkowana lista kryteriów wysłana do modelu |
| `binding_snapshot` | jsonb | no | internal audit binding z `prepareScreening`; nigdy nie jest payloadem AI |
| `result_summary` | jsonb | yes | opcjonalne, bez decyzji rekrutacyjnej; tylko agregaty techniczne/ranking-ready |
| `overall_score` | numeric(6,3) | yes | opcjonalny wynik po ukończeniu, obliczany deterministycznie z kryteriów; nie decyzja |
| `stale_at` | timestamptz | yes | moment wykrycia dezaktualizacji |
| `stale_reason` | text | yes | kontrolowany kod przyczyny |
| `superseded_by_analysis_id` | uuid | yes | następna zakończona wersja, jeśli istnieje |
| `failure_code` | text | yes | sanitarny kod błędu, bez provider payload/PII |
| `failure_message` | text | yes | bez sekretów i surowych odpowiedzi dostawcy |
| `created_by` | uuid | no | użytkownik inicjujący |
| `created_at` | timestamptz | no | default now() |
| `processing_started_at` | timestamptz | yes | start execution |
| `completed_at` | timestamptz | yes | zakończenie poprawnego wyniku |
| `failed_at` | timestamptz | yes | zakończenie błędem |
| `updated_at` | timestamptz | no | techniczne |
| `latest_review_version` | integer | no | default 0; cache do optimistic concurrency review |

#### Constraints
- PK: `id`.
- CHECK `analysis_version >= 1`.
- CHECK `candidate_document_version >= 1`.
- CHECK `input_fingerprint ~ '^[0-9a-f]{64}
- CHECK dozwolonych `execution_status`.
- CHECK spójności czasów:
  - `completed` wymaga `completed_at IS NOT NULL`, bez `failed_at`;
  - `failed` wymaga `failed_at IS NOT NULL`, bez `completed_at`;
  - inne stany nie mogą udawać ukończenia.
- CHECK `stale_at IS NULL` iff `stale_reason IS NULL`.
- CHECK `overall_score` w zakresie 0..100, jeśli zapisany.
- `criteria_snapshot` ma być tablicą JSON; walidacja pełnego kształtu w RPC/server contract.

#### FK i tenant-safe relations
W SC-004 należy zastosować złożone FK, analogicznie do istniejącego schematu:
- `(company_id, recruitment_id, application_id) -> applications(company_id, recruitment_id, id)`;
- `(company_id, recruitment_id) -> recruitments(company_id, id)`;
- `(company_id, position_id) -> positions(company_id, id)`;
- `(company_id, candidate_document_id) -> candidate_documents(company_id, id)`.

Dodatkowo RPC musi potwierdzić:
- `recruitment.position_id = position_id`;
- `candidate_document.candidate_id = application.candidate_id`;
- dokument jest najnowszym dokumentem wybranym przez obowiązujące `prepareScreening`.

#### Unique constraints / indexes
- UNIQUE `(company_id, application_id, analysis_version)`.
- UNIQUE `(company_id, id)` dla złożonych FK z tabel podrzędnych.
- INDEX `(company_id, recruitment_id, application_id, analysis_version DESC)`.
- INDEX `(company_id, recruitment_id, execution_status, stale_at)` dla rankingu/list.
- INDEX `(company_id, application_id, input_fingerprint, analysis_contract_hash)`.
- INDEX `(company_id, candidate_document_id, candidate_document_version)`.
- partial INDEX dla current completed: `(company_id, recruitment_id, application_id) WHERE execution_status='completed' AND stale_at IS NULL`.
- nie wymuszać UNIQUE tylko na `input_fingerprint`: ponowna analiza tego samego materiału po zmianie prompt/model contract musi być możliwa.

### 3.2. `screening_analysis_attempts`

Historia fizycznych prób wykonania provider call. Oddzielenie attempt od logical version umożliwia retry bez tworzenia fałszywych wersji wyniku.

| Kolumna | Typ | Null | Znaczenie |
| --- | --- | --- | --- |
| `id` | uuid | no | PK |
| `company_id` | uuid | no | tenant |
| `analysis_id` | uuid | no | logical version |
| `attempt_no` | integer | no | 1..N w ramach analysis |
| `idempotency_key` | uuid | no | klucz jednego żądania start/retry |
| `status` | text | no | `pending|processing|completed|failed|abandoned` |
| `lease_token_hash` | text | yes | hash sekretu lease; sam token nie jest przechowywany jawnie |
| `lease_expires_at` | timestamptz | yes | ochrona przed martwym workerem |
| `provider_request_id` | text | yes | identyfikator techniczny providera |
| `provider_response_id` | text | yes | jeśli dostępny |
| `input_tokens` | integer | yes | usage |
| `output_tokens` | integer | yes | usage |
| `cached_input_tokens` | integer | yes | jeśli provider raportuje |
| `cost_amount` | numeric(12,6) | yes | koszt liczbowy |
| `cost_currency` | char(3) | yes | np. USD |
| `error_code` | text | yes | sanitarny |
| `created_at` | timestamptz | no | start rekordu |
| `started_at` | timestamptz | yes | faktyczny provider execution |
| `finished_at` | timestamptz | yes | koniec |

Constraints / indexes:
- UNIQUE `(company_id, analysis_id, attempt_no)`.
- UNIQUE `(company_id, idempotency_key)`.
- FK `(company_id, analysis_id) -> screening_analysis_versions(company_id, id)`.
- CHECK `attempt_no >= 1`; tokeny >= 0; cost >= 0.
- partial UNIQUE zapewniający maksymalnie jeden aktywny attempt na analysis:
  `UNIQUE (company_id, analysis_id) WHERE status IN ('pending','processing')`.
- INDEX `(company_id, analysis_id, attempt_no DESC)`.

Nie zapisywać pełnego request/response body providera. Kanoniczny input jest w snapshotach analizy, a wynik w tabelach wynikowych. Ogranicza to retencję niekontrolowanych danych.

### 3.3. `screening_criterion_results`

Niezmienny wynik AI per kryterium dla ukończonej `screening_analysis_versions`.

| Kolumna | Typ | Null | Znaczenie |
| --- | --- | --- | --- |
| `id` | uuid | no | PK |
| `company_id` | uuid | no | tenant |
| `analysis_id` | uuid | no | wersja analizy |
| `criterion_id` | text | no | np. `task:1`, `kpi:2`, `competency:1` |
| `criterion_kind` | text | no | `task|kpi|competency` |
| `criterion_order` | integer | no | pozycja w snapshot |
| `criterion_text_snapshot` | text | no | kryterium dokładnie z wejścia |
| `rating` | text | no | `insufficient_data|below|meets|above` |
| `evidence` | jsonb | no | tablica max 5 cytatów `{start,end,quote}` |
| `explanation` | text | yes | krótka interpretacja AI; nie może zastępować evidence |
| `confidence` | numeric(4,3) | yes | 0..1; tylko jeśli kontrakt providera/promptu definiuje semantykę |
| `created_at` | timestamptz | no | zapis wyniku |

Constraints:
- UNIQUE `(company_id, analysis_id, criterion_id)`.
- FK `(company_id, analysis_id) -> screening_analysis_versions(company_id, id)`.
- CHECK dozwolonego `criterion_kind` i `rating`.
- CHECK `confidence BETWEEN 0 AND 1`, jeśli nie-null.
- CHECK `criterion_order >= 1`.
- pełna walidacja evidence w RPC: offsety UTF-16, quote exact match, max 5, max 2000 znaków, evidence wymagane dla rating != insufficient_data.
- wynik musi zawierać dokładnie jeden rekord dla każdego elementu `criteria_snapshot` i żadnego dodatkowego.

Indexes:
- `(company_id, analysis_id, criterion_order)`;
- `(company_id, analysis_id, rating)`;
- opcjonalnie `(company_id, recruitment_id)` nie jest potrzebne, bo parent lookup jest tani; nie dublować recruitment_id w child bez potrzeby.

### 3.4. `screening_result_reviews`

Niezmienna historia human review. Review nie nadpisuje wyniku AI.

| Kolumna | Typ | Null | Znaczenie |
| --- | --- | --- | --- |
| `id` | uuid | no | PK |
| `company_id` | uuid | no | tenant |
| `analysis_id` | uuid | no | review konkretnej wersji AI |
| `review_version` | integer | no | 1..N |
| `reviewer_id` | uuid | no | auth user |
| `disposition` | text | no | `approved|approved_with_changes|needs_reanalysis` |
| `review_note` | text | yes | notatka wewnętrzna |
| `created_at` | timestamptz | no | moment review |

Constraints:
- UNIQUE `(company_id, analysis_id, review_version)`.
- FK `(company_id, analysis_id) -> screening_analysis_versions(company_id, id)`.
- CHECK disposition.
- review dozwolone tylko dla `execution_status='completed'`.
- stale wynik może zostać odczytany wraz z historycznym review, ale nie może dostać nowego `approved`; reviewer może wyłącznie odnotować `needs_reanalysis` albo system wymusi start nowej analizy.

Index:
- `(company_id, analysis_id, review_version DESC)`;
- `(company_id, reviewer_id, created_at DESC)`.

### 3.5. `screening_criterion_review_overrides`

Korekty człowieka związane z konkretną wersją review. Oryginał AI pozostaje niezmienny.

| Kolumna | Typ | Null | Znaczenie |
| --- | --- | --- | --- |
| `id` | uuid | no | PK |
| `company_id` | uuid | no | tenant |
| `review_id` | uuid | no | review parent |
| `criterion_result_id` | uuid | no | oryginalny AI criterion row |
| `rating_override` | text | yes | poprawiony rating |
| `evidence_override` | jsonb | yes | poprawione/wybrane cytaty z tego samego snapshotu |
| `explanation_override` | text | yes | uzasadnienie korekty |
| `created_at` | timestamptz | no | audit |

Constraints:
- UNIQUE `(company_id, review_id, criterion_result_id)`.
- złożone FK do review i criterion result.
- RPC musi potwierdzić, że review oraz criterion result należą do tego samego `analysis_id`.
- co najmniej jedno pole override musi być nie-null.
- rating/evidence override podlegają tym samym regułom dowodowym co AI.
- confidence nie jest korygowane przez człowieka; human review jest osobnym, silniejszym sygnałem.

## 4. Relacje

```
companies
  └─ positions
      └─ recruitments
          └─ applications
              └─ screening_analysis_versions
                  ├─ screening_analysis_attempts
                  ├─ screening_criterion_results
                  └─ screening_result_reviews
                      └─ screening_criterion_review_overrides

candidates
  ├─ applications
  └─ candidate_documents
       └─ screening_analysis_versions (source binding)
```

Każde powiązanie operacyjne jest tenant-safe przez `company_id`. `analysis` jest zawsze wynikiem dla `application`, nigdy globalną oceną kandydata.

## 5. Status lifecycle

### Logical analysis
- `pending` — rekord utworzony po atomowym sprawdzeniu inputu, bez aktywnego zakończonego wyniku;
- `processing` — worker posiada ważny lease;
- `completed` — wszystkie criterion rows zapisane i zwalidowane w jednej transakcji;
- `failed` — ostatnia próba zakończona błędem i nie ma aktywnego attempt;
- `cancelled` — świadomie przerwana przed ukończeniem.

Dozwolone przejścia:
- pending -> processing;
- processing -> completed;
- processing -> failed;
- processing -> pending wyłącznie przez kontrolowany retry/lease recovery;
- failed -> pending przez retry tego samego logical analysis;
- pending/failed -> cancelled;
- completed jest terminalny dla treści AI.

### Freshness
`stale` nie jest execution status. Ukończony wynik staje się stale przez ustawienie:
- `stale_at`;
- `stale_reason`.

Kontrolowane `stale_reason`:
- `application_changed`;
- `recruitment_changed`;
- `position_changed`;
- `candidate_document_changed`;
- `candidate_document_unreviewed`;
- `screening_contract_changed`;
- `manual_invalidation`.

### Review
Latest review wyznacza stan:
- brak wpisu: `unreviewed`;
- `approved`;
- `approved_with_changes`;
- `needs_reanalysis`.

Nie dodawać boolean `reviewed`, który traci historię.

## 6. Wynik kryterium i evidence contract

Obowiązują cztery ratingi:
- `insufficient_data`;
- `below`;
- `meets`;
- `above`.

Każdy wynik kryterium przechowuje:
- stabilny `criterion_id` z przygotowanego payloadu;
- kind, kolejność i snapshot tekstu;
- rating jako źródło prawdy;
- evidence jako 0..5 cytatów;
- source offsets `start/end` UTF-16;
- exact `quote`;
- opcjonalne `explanation`;
- opcjonalne `confidence`.

Reguły:
- `insufficient_data` może mieć pustą evidence;
- pozostałe ratingi wymagają >=1 evidence;
- każdy quote musi być identyczny z `input_cv_text_snapshot.slice(start,end)`;
- evidence nie może wskazywać oryginalnego CV;
- explanation nie może być używane jako źródło prawdy zamiast cytatu;
- model nie może zwracać pola final decision/recommendation.

Confidence jest opcjonalne i wolno je włączyć dopiero, jeśli prompt/schema jednoznacznie definiuje znaczenie liczby 0..1. Nie traktować confidence jako kalibrowanego prawdopodobieństwa sukcesu pracownika.

### Rating a scoring
`rating` pozostaje jedynym źródłem prawdy w SC-004. SC-004 nie powinno zapisywać obowiązkowego numerycznego `rating_score`. Jeśli implementacja zachowa takie pole dla kompatybilności technicznej, musi ono być nullable i niewykorzystywane do rankingu bez jawnego `scoring_version`. W szczególności `insufficient_data` nie może automatycznie otrzymywać wartości `0` ani innej liczby sugerującej słaby wynik. Mapowanie ratingów, wagi i normalizacja należą do oddzielnego, wersjonowanego kontraktu rankingowego w SC-008.

## 7. Snapshot wejścia

W chwili utworzenia logical analysis trzeba zamrozić dokładnie to, co jest potrzebne do odtworzenia decyzji technicznej i walidacji evidence:

### Dane przechowywane wewnętrznie
1. `input_cv_text_snapshot` — dokładny zatwierdzony `redacted_text`;
2. `criteria_snapshot` — dokładny payload `criteria` w kolejności:
   - `id`,
   - `kind`,
   - `text`;
3. `binding_snapshot` z obecnego `prepareScreening`:
   - `company_id`,
   - `application_id`,
   - `application_updated_at`,
   - `recruitment_id`,
   - `recruitment_updated_at`,
   - `position_id`,
   - `position_updated_at`,
   - `document_id`,
   - `document_version`;
4. `payload_schema_version`;
5. `input_fingerprint`.

### Dane niewysyłane do AI
`binding_snapshot`, IDs, reviewer metadata i wszystkie relacje DB pozostają wyłącznie po stronie systemu.

Snapshot jest immutable po rozpoczęciu analizy. Zmiana źródeł tworzy nowy fingerprint i nową logical analysis version; nie modyfikuje starego snapshotu.

## 8. Fingerprint i versioning

### 8.1. Fingerprint — definicja obowiązująca

SC-003 zachowuje istniejący kontrakt z `lib/screening.ts` bez zmiany algorytmu:

`SHA-256(JSON.stringify({ binding, payload }))`

gdzie:

`binding`:
- company_id;
- application_id;
- application_updated_at;
- recruitment_id;
- recruitment_updated_at;
- position_id;
- position_updated_at;
- document_id;
- document_version.

`payload`:
- schema_version;
- cv_text = zatwierdzony `redacted_text`;
- criteria = uporządkowane task/kpi/competency z `criterion_id`, kind, text.

To oznacza, że zmiana dowolnego elementu tego kanonicznego obiektu zmienia fingerprint.

### 8.2. Co NIE wchodzi do input fingerprint
- provider/model;
- prompt version;
- result schema version;
- reviewer;
- token/cost metadata;
- wynik AI.

Te pola opisują wykonanie/kontrakt wyniku, nie materiał wejściowy.

### 8.3. Kiedy wynik jest stale
Wynik jest stale, gdy ponowne `prepareScreening(currentContext)` daje fingerprint różny od zapisanego albo przygotowanie bieżącego materiału nie jest już dozwolone.

W szczególności:
- zmieniono application (`updated_at`);
- zmieniono recruitment;
- zmieniono position tasks/KPI/competencies lub inny element powodujący `updated_at`;
- pojawiła się nowa wersja/nowszy dokument CV;
- redakcja utraciła review;
- dokument źródłowy przestał być najnowszym dokumentem używanym przez screening;
- zmienił się payload schema w sposób wpływający na wejście.

Zmiana prompt/model bez zmiany input fingerprint nie czyni historycznego wyniku „stale względem danych”, ale może czynić go niezgodnym z aktualnym **analysis contract**. Dlatego reuse sprawdza również contract key poniżej.

### 8.4. Analysis contract hash — obowiązkowy kontrakt
SC-004 musi przechowywać `analysis_contract_hash text not null`. Jest to SHA-256 kanonicznego kontraktu wykonania analizy i nie jest częścią `input_fingerprint`.

Canonical contract obejmuje co najmniej, w stałej kolejności i przy jednoznacznej serializacji:
- `provider`;
- `model`;
- `model_revision` — jawne `null`, jeśli brak;
- `prompt_version`;
- `payload_schema_version`;
- `result_schema_version`.

Rekomendowany kanoniczny obiekt przed hashowaniem:

`{ provider, model, model_revision, prompt_version, payload_schema_version, result_schema_version }`

Hash:

`SHA-256(JSON.stringify(canonical_contract))`

Kolejność pól i normalizacja wartości muszą być zamrożone testem kontraktowym, aby TS/server/DB nie wyliczały różnych hashy. Zmiana któregokolwiek elementu canonical contract tworzy inny `analysis_contract_hash`.

### 8.5. Reuse
Istniejący wynik można ponownie wykorzystać tylko jeśli:
- `execution_status='completed'`;
- `stale_at IS NULL`;
- bieżący `prepareScreening` daje dokładnie ten sam `input_fingerprint`;
- zapisany `analysis_contract_hash` jest identyczny z żądanym;
- wynik ma komplet dokładnie jednego criterion result na każde kryterium;
- nie istnieje najnowszy review `needs_reanalysis`.

Ponowne kliknięcie „analizuj” z tym samym idempotency key musi zwrócić ten sam analysis/attempt. Nowe świadome „reanalyze” z nowym idempotency key może utworzyć nową `analysis_version`, nawet przy tym samym input fingerprint, jeśli produkt ma taką akcję. Domyślna ścieżka powinna reuse’ować istniejący current completed result.

## 9. Human review

### Kto może review
- owner: tak;
- recruiter: tak;
- viewer: tylko odczyt;
- użytkownik spoza firmy/anon: nie.

### Co reviewer może zmienić
Reviewer nie edytuje AI rows. Może utworzyć immutable review z:
- disposition;
- note;
- per-criterion override rating/evidence/explanation.

### Czy korekta tworzy nową wersję AI
Nie. Korekta człowieka tworzy nową `review_version`, nie nową `analysis_version`.

Nowa `analysis_version` powstaje tylko dla nowego wykonania AI/reanalysis. W ten sposób:
- zachowany jest oryginalny wynik AI;
- zachowana jest pełna historia korekt człowieka;
- można później mierzyć zgodność AI z reviewerem.

### Effective result
Dla UI/rankingu:
- bez review: effective = AI;
- `approved`: effective = AI;
- `approved_with_changes`: latest review overrides zastępują wskazane pola kryteriów;
- `needs_reanalysis`: wynik nie kwalifikuje się jako reviewed result do shortlisty.

SC-008 powinno preferować reviewed effective result, ale polityka produktowa może dopuszczać jawnie oznaczony unreviewed result do podglądu. Nie wolno automatycznie podejmować decyzji zatrudnienia.

## 10. RLS / permissions — projekt

Wszystkie pięć nowych tabel mają RLS enabled.

### owner
- SELECT wszystkie rekordy własnej firmy;
- nie wykonuje bezpośrednich INSERT/UPDATE/DELETE na immutable result/history tables;
- mutacje wyłącznie przez publiczne RPC;
- może start/retry/review.

### recruiter
- SELECT własna firma;
- mutacje przez te same RPC co owner: start/retry/review;
- brak zarządzania członkami/tenantem.

### viewer
- SELECT własna firma;
- brak start/retry/review;
- brak bezpośrednich write grants.

### anon / outside tenant
- brak SELECT/INSERT/UPDATE/DELETE;
- brak EXECUTE mutacyjnych RPC.

### Service boundary
- aplikacyjny caller używa sesji Supabase Auth;
- publiczne RPC dla działań użytkownika wykonują kontrolę `auth.uid()`, tenant membership i role;
- pomocnicze funkcje SECURITY DEFINER wyłącznie w `private`, pusty `search_path`, bez exposed schema;
- provider worker nie może polegać na client-supplied `company_id`, `application_id`, fingerprint lub wynikach bez ponownej walidacji.

### Worker trust boundary — obowiązkowy mechanizm
Asynchroniczny worker jest zaufanym komponentem **server-side/internal**, odseparowanym od przeglądarki. Nie działa na podstawie sesji użytkownika i nie otrzymuje sekretu od klienta.

Rekomendowany mechanizm dla SC-004/SC-005:
1. `start_screening_analysis` jest wywoływane przez zalogowanego owner/recruiter w zwykłej sesji Supabase Auth i tworzy `attempt`.
2. Serwer aplikacyjny / backend job runner pobiera `attempt_id` przez wewnętrzną kolejkę lub bezpośrednie wywołanie server-side.
3. Worker uwierzytelnia się do wewnętrznej warstwy serwerowej za pomocą **internal capability** przechowywanej wyłącznie po stronie serwera, np. losowego sekretniego klucza/HMAC albo krótkotrwałego signed worker tokenu wystawianego przez backend. Capability nie jest JWT użytkownika, nie zawiera danych kandydata i nigdy nie jest wysyłana do przeglądarki.
4. Tylko ta wewnętrzna warstwa może wywołać `claim_screening_attempt`, `complete_screening_analysis` i `fail_screening_attempt`. Publiczny klient aplikacji nie dostaje EXECUTE do tych worker RPC.
5. Worker RPC weryfikują internal capability w warstwie serwerowej, a następnie wykonują DB RPC/funkcje o minimalnym zakresie. Do kodu klienckiego nie trafia `service_role`; jeśli środowisko serwerowe używa uprzywilejowanego połączenia technicznego do wykonania funkcji wewnętrznych, sekret pozostaje wyłącznie w chronionym runtime serwera i nie jest używany jako ogólny bypass RLS do CRUD. Preferowane jest dedykowane, wąsko ograniczone wywołanie/funkcja zamiast szerokiego dostępu service role.
6. `claim` wydaje losowy, wysokiej entropii lease token tylko workerowi przez kanał server-side. W DB przechowywany jest wyłącznie hash tokenu + expiry. `complete`/`fail` wymagają poprawnego lease proof i zgodności `attempt_id`.
7. Każde `complete`/`fail` ponownie weryfikuje stan attemptu, lease, parent analysis, `input_fingerprint` oraz `analysis_contract_hash`; capability nie zastępuje walidacji danych ani concurrency controls.

Granica zaufania:
- **browser/user session**: może start/retry/review zgodnie z rolą, ale nie claim/complete/fail;
- **server application layer**: posiada sekrety integracyjne i może zainicjować job;
- **async worker**: otrzymuje tylko minimalny kontekst/capability dla konkretnego attemptu;
- **database**: pozostaje źródłem prawdy dla lease, idempotency, wersji i finalizacji.

W SC-004 należy preferować odebranie bezpośrednich insert/update/delete grantów do nowych tabel historii i wystawić tylko SELECT + kontrolowane RPC, analogicznie do istniejących immutable entries.

## 11. Proponowane RPC i granice transakcji

### 11.1. `start_screening_analysis(...)`
Cel: atomowo utworzyć lub reuse’ować logical analysis i pierwszy/nowy attempt.

Wejście minimalne:
- `target_application uuid`;
- `expected_input_fingerprint text`;
- `expected_payload_schema_version int`;
- `result_schema_version int`;
- `prompt_version text`;
- `provider text`;
- `model text`;
- `model_revision text|null`;
- `idempotency_key uuid`.

RPC NIE przyjmuje `company_id`, CV text ani snapshotu z przeglądarki jako źródła prawdy. Serwer przed RPC/repository layer przygotowuje materiał, a RPC musi wiarygodnie zablokować relacje i potwierdzić expected binding/fingerprint na podstawie wartości utrzymywanych w DB lub przy użyciu kontrolowanej funkcji. Jeśli pełnego fingerprintu nie da się odtworzyć w SQL identycznie jak w TS, SC-004 powinno zastosować dwufazowy kontrakt: server reload + transakcja blokująca wszystkie wiersze bindingu i porównująca expected version/timestamps, nigdy sam fingerprint od klienta.

Transakcja:
1. sprawdź rolę owner/recruiter;
2. lock application/recruitment/position/document rows w stabilnej kolejności;
3. potwierdź screening eligibility i exact binding;
4. oznacz istniejące current completed wyniki stale, jeśli fingerprint nie odpowiada bieżącemu;
5. jeśli istnieje reusable completed result dla contract key — zwróć go bez nowego attempt;
6. jeśli istnieje aktywna logical analysis dla tego samego contract — zwróć istniejącą;
7. inaczej wyznacz `analysis_version = max+1` pod advisory/application lock;
8. zapisz immutable snapshot i analysis;
9. utwórz attempt z unikalnym idempotency key.

### 11.2. `claim_screening_attempt(...)`
Cel: zaufany worker server-side przejmuje pending attempt.

Dostęp:
- brak wywołania z przeglądarki;
- brak EXECUTE dla zwykłego `authenticated` klienta;
- wyłącznie wewnętrzna warstwa serwerowa po pozytywnej weryfikacji internal capability.

Wejście wewnętrzne:
- attempt_id;
- server-side worker identity/capability context;
- nowy losowy lease token generowany po stronie serwera; do DB trafia wyłącznie jego hash.

Transakcja:
- `SELECT ... FOR UPDATE SKIP LOCKED` lub row lock;
- tylko pending albo expired processing;
- ustaw processing, lease expiry, started_at;
- parent analysis -> processing.

Nie przekazywać lease tokenu do przeglądarki.

### 11.3. `complete_screening_analysis(...)`
Cel: jedyna ścieżka zapisu zaakceptowanego wyniku AI. Wywołanie wyłącznie przez zaufany worker/server-side po weryfikacji internal capability i aktywnego lease.

Wejście:
- analysis_id;
- attempt_id;
- lease proof;
- expected input fingerprint/contract hash;
- validated structured findings;
- usage metadata.

Transakcja:
1. lock analysis + attempt;
2. potwierdź attempt aktywny i lease;
3. ponownie sprawdź current screening binding/fingerprint przed zapisem;
4. jeśli zmiana nastąpiła w trakcie provider call:
   - NIE zapisuj criterion results jako current;
   - oznacz analysis stale/failed z kontrolowanym kodem `input_changed_during_processing` albo zapisz historyczny result jako completed+stale w tej samej transakcji; rekomendacja: zapisać zwalidowany wynik jako `completed` i natychmiast `stale_at=now()`, aby zachować audit/cost, ale nigdy go nie zwracać jako current;
5. waliduj dokładnie jedno kryterium na snapshot item;
6. waliduj evidence exact match;
7. insert wszystkich criterion rows;
8. wylicz deterministic aggregate `overall_score` jeśli SC-004 zamraża algorytm;
9. attempt -> completed, analysis -> completed, timestamps;
10. commit atomowo.

Brak częściowo zapisanego wyniku.

### 11.4. `fail_screening_attempt(...)`
Wywołanie wyłącznie przez zaufany worker/server-side po weryfikacji internal capability i aktywnego lease.

- lock attempt + analysis;
- idempotent: drugi zapis tego samego failure nie zmienia historii;
- zapis sanitarnych kodów i usage jeśli dostępne;
- parent -> failed tylko jeśli nie istnieje inny aktywny attempt;
- nie zapisuje raw provider response.

### 11.5. `retry_screening_analysis(...)`
- owner/recruiter;
- tylko failed/pending bez aktywnego attempt;
- przed retry ponownie sprawdza current fingerprint;
- jeśli fingerprint zmieniony: stary analysis stale i tworzy nową analysis_version, nie retry starej;
- jeśli fingerprint/contract zgodny: nowy attempt_no w tej samej analysis;
- nowy idempotency key.

### 11.6. `review_screening_result(...)`
Wejście:
- analysis_id;
- `expected_review_version`;
- disposition;
- note;
- overrides.

Transakcja:
1. lock analysis;
2. role owner/recruiter;
3. require completed;
4. compare `latest_review_version = expected_review_version`;
5. ponownie sprawdź stale/current;
6. validate overrides względem snapshotu i criterion rows;
7. insert immutable review + overrides;
8. increment cached `latest_review_version`.

To rozwiązuje konflikt dwóch reviewerów.

### 11.7. `refresh_screening_staleness(...)`
Może działać per application/recruitment:
- recompute/compare bieżący screening binding;
- mark affected completed analyses stale idempotently;
- nigdy nie od-stale’uje starego rekordu automatycznie.

W praktyce start, complete, review i ranking query powinny wykonywać stale check jako część własnej transakcji. Osobne RPC jest przydatne do UI/list refresh i SC-007.

## 12. Idempotency i concurrency

### Równoczesne kliknięcia użytkownika
- jeden `idempotency_key` na intencję UI;
- UNIQUE `(company_id, idempotency_key)`;
- start RPC pod application-scoped transaction/advisory lock;
- jeśli ten sam request dotarł dwa razy, oba zwracają ten sam attempt/result.

### Dwa różne kliknięcia
- partial unique/advisory lock gwarantuje tylko jedną aktywną analysis dla tego samego application + analysis contract;
- drugie wywołanie dostaje istniejącą analysis zamiast tworzyć duplikat.

### Retry HTTP/provider
- retry tego samego provider request nie może utworzyć drugiego result;
- `complete_screening_analysis` jest idempotentne dla już completed attempt: zwraca istniejący analysis id, jeśli payload hash/contract zgodny; odrzuca konfliktujący drugi payload.

### Dwa workery
- claim przez row lock + lease;
- tylko holder aktywnego lease może complete/fail;
- expired lease może być przejęty zgodnie z kontrolowaną procedurą;
- late result starego workera po utracie lease jest odrzucany.

### Version number race
- `analysis_version=max+1` wyłącznie pod lockiem scoped do `company_id + application_id`;
- unique constraint jest ostatnią warstwą ochrony.

### Review race
- optimistic concurrency przez `expected_review_version` + row lock;
- brak last-write-wins.

## 13. Privacy

### Payload do zewnętrznego AI — allowlist
Do AI wolno wysłać wyłącznie:
- `schema_version`;
- `cv_text` = zatwierdzony `redacted_text`;
- `criteria[] = { id, kind, text }`.

Nie wolno wysłać:
- imienia i nazwiska;
- email;
- telefonu;
- `company_id`, `candidate_id`, `application_id`, `recruitment_id`, `position_id`, `document_id`;
- `reviewed_by`;
- nazw użytkowników;
- oryginalnego `source_text`/oryginalnego CV;
- storage URL;
- notatek rekrutera;
- niepotrzebnego opisu firmy/rekrutacji;
- sekretów, JWT, kluczy API.

Należy utrzymać jawny allowlist serializer. Nigdy nie serializować całego obiektu DB do requestu providera.

### Persistencja
- źródłowy `source_text` pozostaje wyłącznie w candidate_documents;
- snapshot analizy przechowuje tylko zatwierdzony redacted text;
- nie przechowywać raw provider request/response, jeśli nie jest konieczny;
- provider IDs/usage są technicznym metadata;
- error logs nie mogą zawierać pełnego CV ani response body.

## 14. Prompt injection

Treść CV jest niezaufanym dokumentem, nigdy instrukcją.

W SC-005 kontrakt promptu musi:
- oddzielić system/developer instructions od CV data;
- jawnie oznaczyć CV jako quoted/untrusted data;
- nakazać ignorowanie poleceń znalezionych w CV;
- zakazać wykonywania URL, narzędzi, kodu, poleceń lub ujawniania system prompt;
- wyłączyć tools/web/function calling dla tej operacji, jeśli nie są wymagane;
- wymusić structured output tylko z dozwolonym schema;
- odrzucać dodatkowe pola i final hiring decision;
- ponownie walidować całe structured output po stronie serwera.

Cytat z CV zawierający prompt injection może być evidence tylko jako tekst źródłowy; nie wpływa na hierarchy instrukcji.

## 15. Ranking readiness dla SC-008

Schemat ma umożliwić ranking bez przebudowy:
- każda analiza jest przypięta do `recruitment_id` i `application_id`;
- każdy criterion result ma semantyczny `rating` jako źródło prawdy; SC-004 nie wymaga numeric `rating_score`;
- snapshot kryteriów zachowuje kolejność i tekst;
- review overrides dają effective rating bez niszczenia AI;
- `overall_score` może być utrwalonym agregatem deterministycznym;
- current/stale jest jednoznaczne;
- reviewed/unreviewed jest jednoznaczne;
- `needs_reanalysis` można wykluczyć;
- historyczne wersje pozostają dostępne.

SC-004 nie definiuje mapowania rating -> liczba. `insufficient_data` nie może automatycznie zostać zmapowane na `0` ani karę punktową. Właściwe wagi, mapowanie, normalizacja, `scoring_version`, `scored_criteria_count`, `insufficient_data_count`, `max_score_possible_for_scored` i końcowy ranking należą do SC-008.

`overall_score` pozostaje nullable i w SC-004 nie jest wymagane. SC-008 może wyliczać wersjonowany ranking z criterion rows + human overrides bez przebudowy podstawowego schematu.

## 16. Retention i audit

Minimalne audit metadata:
- analysis: `created_by`, `created_at`, `processing_started_at`, `completed_at`, `failed_at`;
- freshness: `stale_at`, `stale_reason`, `superseded_by_analysis_id`;
- AI contract: `provider`, `model`, `model_revision`, `prompt_version`, `payload_schema_version`, `result_schema_version`, obowiązkowe `analysis_contract_hash`;
- attempts: request/response IDs, token counts, cost/currency, timestamps, sanitized errors;
- review: reviewer_id, review_version, disposition, note, created_at;
- criterion: immutable AI output and immutable review overrides.

Nie hard-delete historycznych analiz pojedynczo przez zwykły CRUD. Retention/delete powinno dziedziczyć lifecycle danych kandydata/firmy i zostać wdrożone świadomie:
- usunięcie firmy/kandydata/application może kaskadowo usunąć zależne screening records zgodnie z polityką produktu i obowiązkami prawnymi;
- brak osobnego bezpośredniego DELETE dla recruiter/viewer;
- przyszła polityka retencji powinna być osobnym taskiem, jeśli ma zachowywać agregaty po usunięciu danych osobowych.

## 17. Widoki / read model — rekomendacja

SC-004 może dodać widoki `security_invoker`, jeśli uproszczą UI, ale nie są konieczne dla minimalnej migracji.

Rekomendowane read models:
- `latest_screening_analyses` — najwyższa completed analysis_version per application z freshness;
- `latest_screening_reviews` — najwyższa review_version per analysis;
- `effective_screening_criterion_results` — AI + latest human overrides.

Jeśli zostaną dodane, muszą być `security_invoker` i respektować RLS tabel źródłowych.

## 18. Open questions wymagające decyzji przed/na początku SC-004

Decyzje zamknięte po review:
- `analysis_contract_hash` jest **obowiązkowy** w SC-004;
- canonical contract obejmuje co najmniej provider/model/model_revision/prompt_version/payload_schema_version/result_schema_version;
- reuse wymaga jednocześnie `input_fingerprint + analysis_contract_hash`;
- SC-004 nie zapisuje obowiązkowego numeric `rating_score`; `rating` jest źródłem prawdy;
- worker trust boundary jest server-side/internal capability; browser nie może claim/complete/fail.

Pozostają otwarte wyłącznie:
1. Czy stale wynik po zmianie inputu w trakcie provider call zapisujemy jako `completed + stale`, czy odrzucamy bez criterion rows — rekomendacja: **completed + stale**, ponieważ zachowuje audit, koszt i odpowiedź, ale wymaga bezwzględnego filtrowania current result.
2. Czy reviewer może poprawiać evidence, czy tylko rating/explanation — rekomendacja: **tak, może poprawić evidence**, ale wyłącznie względem tego samego redacted snapshotu.
3. Czy świadome „reanalyze same input” jest funkcją od SC-007 czy od razu w SC-004 — rekomendacja: schema wspiera od razu, UI może poczekać.
4. Retencja dokładnego redacted snapshotu: rekomendacja pozostawić go tak długo jak wynik, bo bez niego nie da się wiarygodnie audytować offsetów/cytatów.

## 19. Ryzyka

1. **Divergence fingerprint TS vs SQL** — fingerprint jest dziś liczony w TS. Nie implementować drugiego, subtelnie różnego kanonizera w SQL bez testów kontraktowych.
2. **Stale race** — input może zmienić się po dispatch, ale przed save; dlatego required recheck w transakcji complete.
3. **Duplicate workers** — bez lease + row lock dwa procesy mogłyby zakończyć ten sam attempt.
4. **Review overwrite** — bez version check dwóch reviewerów stworzyłoby last-write-wins.
5. **Evidence corruption** — offsety muszą być walidowane względem immutable snapshotu, nie aktualnego CV.
6. **PII leakage in logs** — nie logować raw payload/response.
7. **Raw provider output drift** — structured output musi być walidowane lokalnie; provider schema nie jest jedyną ochroną.
8. **Overtrust in confidence/score** — confidence nie jest prawdopodobieństwem jakości zatrudnienia; score nie jest decyzją.
9. **Ranking bias by missing data** — `insufficient_data` musi pozostać semantycznie inne niż `below`.
10. **Cascade deletes** — SC-004 musi jawnie sprawdzić zgodność nowych FK/cascade z istniejącą polityką usuwania kandydatów/rekrutacji.

## 20. Implementation plan for SC-004

SC-004 powinno być jedną migracją L3 i nie powinno integrować providera AI.

Kolejność:
1. Dodać typy/check constraints dla statusów/ratingów albo użyć CHECK text zgodnie z istniejącym stylem.
2. Utworzyć:
   - `screening_analysis_versions` z obowiązkowym `analysis_contract_hash`;
   - `screening_analysis_attempts`;
   - `screening_criterion_results`;
   - `screening_result_reviews`;
   - `screening_criterion_review_overrides`.
3. Dodać złożone tenant-safe FK, unique constraints i indeksy; reuse/index lookup ma używać `input_fingerprint + analysis_contract_hash`.
4. Włączyć RLS na wszystkich tabelach.
5. Dodać SELECT policies dla owner/recruiter/viewer i brak write policies dla historii.
6. Ograniczyć grants; mutacje owner/recruiter tylko przez RPC.
7. Zaimplementować prywatne helpery autoryzacji/locking oraz jawny worker trust boundary: browser bez EXECUTE do claim/complete/fail, server-side internal capability, hash lease tokenu w DB, expiry i minimalny zakres uprawnień.
8. Zaimplementować RPC:
   - `start_screening_analysis`;
   - `claim_screening_attempt`;
   - `complete_screening_analysis`;
   - `fail_screening_attempt`;
   - `retry_screening_analysis`;
   - `review_screening_result`;
   - opcjonalnie `refresh_screening_staleness`.
9. W RPC odtworzyć walidację bindingu i zapewnić recheck przed complete/review; complete/fail dodatkowo wymagają aktywnego lease oraz zgodnego `analysis_contract_hash`.
10. Dodać/rozszerzyć ręczny kontrakt `database.types.ts`, z `Insert/Update = never` dla immutable tables. Nie dodawać obowiązkowego `rating_score`; jeśli pole pozostanie technicznie, tylko nullable i bez semantyki rankingowej w SC-004.
11. Dodać testy PGlite:
    - tenant isolation;
    - role owner/recruiter/viewer;
    - exact FK relations;
    - jedna aktywna próba;
    - browser/authenticated user nie może claim/complete/fail;
    - internal worker capability + lease wymagane dla claim/complete/fail;
    - reuse tylko przy zgodnym `input_fingerprint + analysis_contract_hash`;
    - zmiana prompt/model/schema tworzy inny `analysis_contract_hash`;
    - idempotency duplicate click;
    - concurrent version allocation;
    - retry po failed;
    - stale przy zmianie application/recruitment/position/document;
    - reject save po zmianie inputu;
    - exact criterion count;
    - quote/offset validation;
    - immutable AI result;
    - review optimistic concurrency;
    - review override bez utraty AI;
    - viewer read-only;
    - anon denied.
12. Zaktualizować `docs/database.md` i `docs/screening.md` dopiero w SC-004 po implementacji.
13. Nie dodawać OpenAI API, UI rankingu ani shortlisty w SC-004.

## 21. Acceptance architecture checklist

- [x] wynik jest per application i recruitment;
- [x] wejście jest snapshotowane i audytowalne;
- [x] fingerprint zachowuje istniejący kontrakt;
- [x] `analysis_contract_hash` jest obowiązkowy i ma zamrożony canonical contract;
- [x] reuse wymaga `input_fingerprint + analysis_contract_hash`;
- [x] model obsługuje stale;
- [x] model rozdziela logical version i provider attempts;
- [x] retry nie wymaga nowej wersji wyniku, jeśli input nie zmienił się;
- [x] świadome reanalysis może utworzyć nową analysis version;
- [x] AI result jest immutable;
- [x] human review jest immutable/versioned;
- [x] korekty człowieka nie niszczą oryginału AI;
- [x] evidence jest związane z immutable CV snapshot;
- [x] owner/recruiter/viewer mają zdefiniowany model uprawnień;
- [x] idempotency i concurrency są rozwiązane na poziomie DB transaction/constraints;
- [x] worker trust boundary jest zdefiniowany: internal server-side capability + lease; browser nie claim/complete/fail;
- [x] `rating` jest źródłem prawdy, SC-004 nie narzuca numeric scoringu i `insufficient_data` nie mapuje się automatycznie na 0;
- [x] privacy używa allowlist;
- [x] prompt injection jest rozpoznane jako boundary bezpieczeństwa;
- [x] SC-008 może korzystać z modelu bez przebudowy podstawowych tabel;
- [x] audit zawiera provider/model/prompt/schema/usage/cost/timestamps.

---

## TASK
SC-003 — Model danych dla persistowanego wyniku preselekcji AI.

## ARCHITECTURE STATUS
PROPOSED — gotowe do review przed SC-004. Brak implementacji.

## PROPOSED TABLES
- `screening_analysis_versions`
- `screening_analysis_attempts`
- `screening_criterion_results`
- `screening_result_reviews`
- `screening_criterion_review_overrides`

## PROPOSED RPC
- `start_screening_analysis`
- `claim_screening_attempt`
- `complete_screening_analysis`
- `fail_screening_attempt`
- `retry_screening_analysis`
- `review_screening_result`
- opcjonalnie `refresh_screening_staleness`

## RLS MODEL
Owner i recruiter: SELECT + mutacje wyłącznie przez RPC. Viewer: SELECT only. Anon/outside tenant: brak dostępu. Wszystkie tabele z RLS i `company_id`; immutable history bez bezpośredniego write CRUD.

## VERSIONING MODEL
`analysis_version` jest monotoniczne per application. Attempty są wersjonowane osobno przez `attempt_no`. Human review ma własne `review_version`. AI result jest immutable. `analysis_contract_hash` jest obowiązkowy; reuse wymaga jednocześnie zgodnego `input_fingerprint + analysis_contract_hash`.

## CONCURRENCY MODEL
Application-scoped lock przy tworzeniu wersji, unique constraints, jeden aktywny attempt, idempotency key, recheck fingerprint/contract przed save i optimistic concurrency dla review. Claim/complete/fail są dostępne wyłącznie przez zaufany server-side worker posiadający internal capability; claim wydaje lease token tylko workerowi, a DB przechowuje jego hash.

## PRIVACY MODEL
Do AI tylko `schema_version`, zatwierdzony `redacted_text` i allowlisted `criteria`. Bez nazwiska, emaila, telefonu, DB IDs, reviewer IDs, oryginalnego CV i niepotrzebnych danych. Brak raw provider request/response w bazie.

## OPEN QUESTIONS
Zamknięte po review: obowiązkowy `analysis_contract_hash`, reuse przez `input_fingerprint + analysis_contract_hash`, brak obowiązkowego numeric `rating_score`, server-side worker trust boundary. Nadal otwarte: zapis `completed+stale` przy zmianie inputu podczas provider call; reviewer evidence override; moment UI dla reanalysis same input; szczegółowa polityka retencji redacted snapshot.

## RISKS
Fingerprint divergence TS/SQL, stale race, duplicate workers, review race, błędne offsety evidence, PII w logach, provider schema drift, nadużycie confidence/score, błędne traktowanie insufficient_data, niezamierzone cascade deletes.

## IMPLEMENTATION PLAN FOR SC-004
Jedna nowa migracja: 5 tabel + obowiązkowy `analysis_contract_hash` + constraints/FK/indexes + RLS/grants + RPC + jawny server-side worker capability/lease boundary + typy kontraktowe + PGlite tests. Bez obowiązkowego `rating_score`, bez algorytmu rankingu, bez OpenAI API, bez rankingu UI i bez merge do czasu review/testów.

## FILES CHANGED
Tylko `docs/sc-003-screening-result-architecture.md`.

## TESTS
SC-003 nie zmienia kodu ani DB. Wymagane jest review architektury; testy runtime nie są uruchamiane dla samego dokumentu. SC-004 ma dodać testy DB/RLS/concurrency opisane powyżej.

## NEXT ACTION
Review SC-003. Po akceptacji rozpocząć SC-004 według powyższego planu. Nie implementować SC-004 w ramach tego tasku.
`.
- CHECK `analysis_contract_hash ~ '^[0-9a-f]{64}
- CHECK dozwolonych `execution_status`.
- CHECK spójności czasów:
  - `completed` wymaga `completed_at IS NOT NULL`, bez `failed_at`;
  - `failed` wymaga `failed_at IS NOT NULL`, bez `completed_at`;
  - inne stany nie mogą udawać ukończenia.
- CHECK `stale_at IS NULL` iff `stale_reason IS NULL`.
- CHECK `overall_score` w zakresie 0..100, jeśli zapisany.
- `criteria_snapshot` ma być tablicą JSON; walidacja pełnego kształtu w RPC/server contract.

#### FK i tenant-safe relations
W SC-004 należy zastosować złożone FK, analogicznie do istniejącego schematu:
- `(company_id, recruitment_id, application_id) -> applications(company_id, recruitment_id, id)`;
- `(company_id, recruitment_id) -> recruitments(company_id, id)`;
- `(company_id, position_id) -> positions(company_id, id)`;
- `(company_id, candidate_document_id) -> candidate_documents(company_id, id)`.

Dodatkowo RPC musi potwierdzić:
- `recruitment.position_id = position_id`;
- `candidate_document.candidate_id = application.candidate_id`;
- dokument jest najnowszym dokumentem wybranym przez obowiązujące `prepareScreening`.

#### Unique constraints / indexes
- UNIQUE `(company_id, application_id, analysis_version)`.
- UNIQUE `(company_id, id)` dla złożonych FK z tabel podrzędnych.
- INDEX `(company_id, recruitment_id, application_id, analysis_version DESC)`.
- INDEX `(company_id, recruitment_id, execution_status, stale_at)` dla rankingu/list.
- INDEX `(company_id, application_id, input_fingerprint)`.
- INDEX `(company_id, candidate_document_id, candidate_document_version)`.
- partial INDEX dla current completed: `(company_id, recruitment_id, application_id) WHERE execution_status='completed' AND stale_at IS NULL`.
- nie wymuszać UNIQUE tylko na `input_fingerprint`: ponowna analiza tego samego materiału po zmianie prompt/model contract musi być możliwa.

### 3.2. `screening_analysis_attempts`

Historia fizycznych prób wykonania provider call. Oddzielenie attempt od logical version umożliwia retry bez tworzenia fałszywych wersji wyniku.

| Kolumna | Typ | Null | Znaczenie |
| --- | --- | --- | --- |
| `id` | uuid | no | PK |
| `company_id` | uuid | no | tenant |
| `analysis_id` | uuid | no | logical version |
| `attempt_no` | integer | no | 1..N w ramach analysis |
| `idempotency_key` | uuid | no | klucz jednego żądania start/retry |
| `status` | text | no | `pending|processing|completed|failed|abandoned` |
| `lease_token_hash` | text | yes | hash sekretu lease; sam token nie jest przechowywany jawnie |
| `lease_expires_at` | timestamptz | yes | ochrona przed martwym workerem |
| `provider_request_id` | text | yes | identyfikator techniczny providera |
| `provider_response_id` | text | yes | jeśli dostępny |
| `input_tokens` | integer | yes | usage |
| `output_tokens` | integer | yes | usage |
| `cached_input_tokens` | integer | yes | jeśli provider raportuje |
| `cost_amount` | numeric(12,6) | yes | koszt liczbowy |
| `cost_currency` | char(3) | yes | np. USD |
| `error_code` | text | yes | sanitarny |
| `created_at` | timestamptz | no | start rekordu |
| `started_at` | timestamptz | yes | faktyczny provider execution |
| `finished_at` | timestamptz | yes | koniec |

Constraints / indexes:
- UNIQUE `(company_id, analysis_id, attempt_no)`.
- UNIQUE `(company_id, idempotency_key)`.
- FK `(company_id, analysis_id) -> screening_analysis_versions(company_id, id)`.
- CHECK `attempt_no >= 1`; tokeny >= 0; cost >= 0.
- partial UNIQUE zapewniający maksymalnie jeden aktywny attempt na analysis:
  `UNIQUE (company_id, analysis_id) WHERE status IN ('pending','processing')`.
- INDEX `(company_id, analysis_id, attempt_no DESC)`.

Nie zapisywać pełnego request/response body providera. Kanoniczny input jest w snapshotach analizy, a wynik w tabelach wynikowych. Ogranicza to retencję niekontrolowanych danych.

### 3.3. `screening_criterion_results`

Niezmienny wynik AI per kryterium dla ukończonej `screening_analysis_versions`.

| Kolumna | Typ | Null | Znaczenie |
| --- | --- | --- | --- |
| `id` | uuid | no | PK |
| `company_id` | uuid | no | tenant |
| `analysis_id` | uuid | no | wersja analizy |
| `criterion_id` | text | no | np. `task:1`, `kpi:2`, `competency:1` |
| `criterion_kind` | text | no | `task|kpi|competency` |
| `criterion_order` | integer | no | pozycja w snapshot |
| `criterion_text_snapshot` | text | no | kryterium dokładnie z wejścia |
| `rating` | text | no | `insufficient_data|below|meets|above` |
| `rating_score` | smallint | no | deterministyczne mapowanie do rankingu, np. 0/1/2/3 |
| `evidence` | jsonb | no | tablica max 5 cytatów `{start,end,quote}` |
| `explanation` | text | yes | krótka interpretacja AI; nie może zastępować evidence |
| `confidence` | numeric(4,3) | yes | 0..1; tylko jeśli kontrakt providera/promptu definiuje semantykę |
| `created_at` | timestamptz | no | zapis wyniku |

Constraints:
- UNIQUE `(company_id, analysis_id, criterion_id)`.
- FK `(company_id, analysis_id) -> screening_analysis_versions(company_id, id)`.
- CHECK dozwolonego `criterion_kind` i `rating`.
- CHECK `rating_score` zgodny z rating: rekomendowane `insufficient_data=0, below=1, meets=2, above=3`; do agregacji SC-008 należy jednak odróżniać insufficient_data od below, mimo tej samej lub różnej punktacji.
- CHECK `confidence BETWEEN 0 AND 1`, jeśli nie-null.
- CHECK `criterion_order >= 1`.
- pełna walidacja evidence w RPC: offsety UTF-16, quote exact match, max 5, max 2000 znaków, evidence wymagane dla rating != insufficient_data.
- wynik musi zawierać dokładnie jeden rekord dla każdego elementu `criteria_snapshot` i żadnego dodatkowego.

Indexes:
- `(company_id, analysis_id, criterion_order)`;
- `(company_id, analysis_id, rating)`;
- opcjonalnie `(company_id, recruitment_id)` nie jest potrzebne, bo parent lookup jest tani; nie dublować recruitment_id w child bez potrzeby.

### 3.4. `screening_result_reviews`

Niezmienna historia human review. Review nie nadpisuje wyniku AI.

| Kolumna | Typ | Null | Znaczenie |
| --- | --- | --- | --- |
| `id` | uuid | no | PK |
| `company_id` | uuid | no | tenant |
| `analysis_id` | uuid | no | review konkretnej wersji AI |
| `review_version` | integer | no | 1..N |
| `reviewer_id` | uuid | no | auth user |
| `disposition` | text | no | `approved|approved_with_changes|needs_reanalysis` |
| `review_note` | text | yes | notatka wewnętrzna |
| `created_at` | timestamptz | no | moment review |

Constraints:
- UNIQUE `(company_id, analysis_id, review_version)`.
- FK `(company_id, analysis_id) -> screening_analysis_versions(company_id, id)`.
- CHECK disposition.
- review dozwolone tylko dla `execution_status='completed'`.
- stale wynik może zostać odczytany wraz z historycznym review, ale nie może dostać nowego `approved`; reviewer może wyłącznie odnotować `needs_reanalysis` albo system wymusi start nowej analizy.

Index:
- `(company_id, analysis_id, review_version DESC)`;
- `(company_id, reviewer_id, created_at DESC)`.

### 3.5. `screening_criterion_review_overrides`

Korekty człowieka związane z konkretną wersją review. Oryginał AI pozostaje niezmienny.

| Kolumna | Typ | Null | Znaczenie |
| --- | --- | --- | --- |
| `id` | uuid | no | PK |
| `company_id` | uuid | no | tenant |
| `review_id` | uuid | no | review parent |
| `criterion_result_id` | uuid | no | oryginalny AI criterion row |
| `rating_override` | text | yes | poprawiony rating |
| `evidence_override` | jsonb | yes | poprawione/wybrane cytaty z tego samego snapshotu |
| `explanation_override` | text | yes | uzasadnienie korekty |
| `created_at` | timestamptz | no | audit |

Constraints:
- UNIQUE `(company_id, review_id, criterion_result_id)`.
- złożone FK do review i criterion result.
- RPC musi potwierdzić, że review oraz criterion result należą do tego samego `analysis_id`.
- co najmniej jedno pole override musi być nie-null.
- rating/evidence override podlegają tym samym regułom dowodowym co AI.
- confidence nie jest korygowane przez człowieka; human review jest osobnym, silniejszym sygnałem.

## 4. Relacje

```
companies
  └─ positions
      └─ recruitments
          └─ applications
              └─ screening_analysis_versions
                  ├─ screening_analysis_attempts
                  ├─ screening_criterion_results
                  └─ screening_result_reviews
                      └─ screening_criterion_review_overrides

candidates
  ├─ applications
  └─ candidate_documents
       └─ screening_analysis_versions (source binding)
```

Każde powiązanie operacyjne jest tenant-safe przez `company_id`. `analysis` jest zawsze wynikiem dla `application`, nigdy globalną oceną kandydata.

## 5. Status lifecycle

### Logical analysis
- `pending` — rekord utworzony po atomowym sprawdzeniu inputu, bez aktywnego zakończonego wyniku;
- `processing` — worker posiada ważny lease;
- `completed` — wszystkie criterion rows zapisane i zwalidowane w jednej transakcji;
- `failed` — ostatnia próba zakończona błędem i nie ma aktywnego attempt;
- `cancelled` — świadomie przerwana przed ukończeniem.

Dozwolone przejścia:
- pending -> processing;
- processing -> completed;
- processing -> failed;
- processing -> pending wyłącznie przez kontrolowany retry/lease recovery;
- failed -> pending przez retry tego samego logical analysis;
- pending/failed -> cancelled;
- completed jest terminalny dla treści AI.

### Freshness
`stale` nie jest execution status. Ukończony wynik staje się stale przez ustawienie:
- `stale_at`;
- `stale_reason`.

Kontrolowane `stale_reason`:
- `application_changed`;
- `recruitment_changed`;
- `position_changed`;
- `candidate_document_changed`;
- `candidate_document_unreviewed`;
- `screening_contract_changed`;
- `manual_invalidation`.

### Review
Latest review wyznacza stan:
- brak wpisu: `unreviewed`;
- `approved`;
- `approved_with_changes`;
- `needs_reanalysis`.

Nie dodawać boolean `reviewed`, który traci historię.

## 6. Wynik kryterium i evidence contract

Obowiązują cztery ratingi:
- `insufficient_data`;
- `below`;
- `meets`;
- `above`.

Każdy wynik kryterium przechowuje:
- stabilny `criterion_id` z przygotowanego payloadu;
- kind, kolejność i snapshot tekstu;
- rating;
- evidence jako 0..5 cytatów;
- source offsets `start/end` UTF-16;
- exact `quote`;
- opcjonalne `explanation`;
- opcjonalne `confidence`.

Reguły:
- `insufficient_data` może mieć pustą evidence;
- pozostałe ratingi wymagają >=1 evidence;
- każdy quote musi być identyczny z `input_cv_text_snapshot.slice(start,end)`;
- evidence nie może wskazywać oryginalnego CV;
- explanation nie może być używane jako źródło prawdy zamiast cytatu;
- model nie może zwracać pola final decision/recommendation.

Confidence jest opcjonalne i wolno je włączyć dopiero, jeśli prompt/schema jednoznacznie definiuje znaczenie liczby 0..1. Nie traktować confidence jako kalibrowanego prawdopodobieństwa sukcesu pracownika.

## 7. Snapshot wejścia

W chwili utworzenia logical analysis trzeba zamrozić dokładnie to, co jest potrzebne do odtworzenia decyzji technicznej i walidacji evidence:

### Dane przechowywane wewnętrznie
1. `input_cv_text_snapshot` — dokładny zatwierdzony `redacted_text`;
2. `criteria_snapshot` — dokładny payload `criteria` w kolejności:
   - `id`,
   - `kind`,
   - `text`;
3. `binding_snapshot` z obecnego `prepareScreening`:
   - `company_id`,
   - `application_id`,
   - `application_updated_at`,
   - `recruitment_id`,
   - `recruitment_updated_at`,
   - `position_id`,
   - `position_updated_at`,
   - `document_id`,
   - `document_version`;
4. `payload_schema_version`;
5. `input_fingerprint`.

### Dane niewysyłane do AI
`binding_snapshot`, IDs, reviewer metadata i wszystkie relacje DB pozostają wyłącznie po stronie systemu.

Snapshot jest immutable po rozpoczęciu analizy. Zmiana źródeł tworzy nowy fingerprint i nową logical analysis version; nie modyfikuje starego snapshotu.

## 8. Fingerprint i versioning

### 8.1. Fingerprint — definicja obowiązująca

SC-003 zachowuje istniejący kontrakt z `lib/screening.ts` bez zmiany algorytmu:

`SHA-256(JSON.stringify({ binding, payload }))`

gdzie:

`binding`:
- company_id;
- application_id;
- application_updated_at;
- recruitment_id;
- recruitment_updated_at;
- position_id;
- position_updated_at;
- document_id;
- document_version.

`payload`:
- schema_version;
- cv_text = zatwierdzony `redacted_text`;
- criteria = uporządkowane task/kpi/competency z `criterion_id`, kind, text.

To oznacza, że zmiana dowolnego elementu tego kanonicznego obiektu zmienia fingerprint.

### 8.2. Co NIE wchodzi do input fingerprint
- provider/model;
- prompt version;
- result schema version;
- reviewer;
- token/cost metadata;
- wynik AI.

Te pola opisują wykonanie/kontrakt wyniku, nie materiał wejściowy.

### 8.3. Kiedy wynik jest stale
Wynik jest stale, gdy ponowne `prepareScreening(currentContext)` daje fingerprint różny od zapisanego albo przygotowanie bieżącego materiału nie jest już dozwolone.

W szczególności:
- zmieniono application (`updated_at`);
- zmieniono recruitment;
- zmieniono position tasks/KPI/competencies lub inny element powodujący `updated_at`;
- pojawiła się nowa wersja/nowszy dokument CV;
- redakcja utraciła review;
- dokument źródłowy przestał być najnowszym dokumentem używanym przez screening;
- zmienił się payload schema w sposób wpływający na wejście.

Zmiana prompt/model bez zmiany input fingerprint nie czyni historycznego wyniku „stale względem danych”, ale może czynić go niezgodnym z aktualnym **analysis contract**. Dlatego reuse sprawdza również contract key poniżej.

### 8.4. Analysis contract key
Do decyzji o reuse używać logicznego zestawu:
- `input_fingerprint`;
- `payload_schema_version`;
- `result_schema_version`;
- `prompt_version`;
- `provider`;
- `model`;
- `model_revision` jeśli pinned.

Można wyliczać `analysis_contract_hash` w kodzie lub przechowywać jako dodatkową kolumnę SHA-256 w SC-004; rekomendacja: dodać kolumnę `analysis_contract_hash text not null`, aby uprościć idempotent lookup i audyt.

### 8.5. Reuse
Istniejący wynik można ponownie wykorzystać tylko jeśli:
- `execution_status='completed'`;
- `stale_at IS NULL`;
- bieżący `prepareScreening` daje dokładnie ten sam `input_fingerprint`;
- analysis contract key jest zgodny z żądanym;
- wynik ma komplet dokładnie jednego criterion result na każde kryterium;
- nie istnieje najnowszy review `needs_reanalysis`.

Ponowne kliknięcie „analizuj” z tym samym idempotency key musi zwrócić ten sam analysis/attempt. Nowe świadome „reanalyze” z nowym idempotency key może utworzyć nową `analysis_version`, nawet przy tym samym input fingerprint, jeśli produkt ma taką akcję. Domyślna ścieżka powinna reuse’ować istniejący current completed result.

## 9. Human review

### Kto może review
- owner: tak;
- recruiter: tak;
- viewer: tylko odczyt;
- użytkownik spoza firmy/anon: nie.

### Co reviewer może zmienić
Reviewer nie edytuje AI rows. Może utworzyć immutable review z:
- disposition;
- note;
- per-criterion override rating/evidence/explanation.

### Czy korekta tworzy nową wersję AI
Nie. Korekta człowieka tworzy nową `review_version`, nie nową `analysis_version`.

Nowa `analysis_version` powstaje tylko dla nowego wykonania AI/reanalysis. W ten sposób:
- zachowany jest oryginalny wynik AI;
- zachowana jest pełna historia korekt człowieka;
- można później mierzyć zgodność AI z reviewerem.

### Effective result
Dla UI/rankingu:
- bez review: effective = AI;
- `approved`: effective = AI;
- `approved_with_changes`: latest review overrides zastępują wskazane pola kryteriów;
- `needs_reanalysis`: wynik nie kwalifikuje się jako reviewed result do shortlisty.

SC-008 powinno preferować reviewed effective result, ale polityka produktowa może dopuszczać jawnie oznaczony unreviewed result do podglądu. Nie wolno automatycznie podejmować decyzji zatrudnienia.

## 10. RLS / permissions — projekt

Wszystkie pięć nowych tabel mają RLS enabled.

### owner
- SELECT wszystkie rekordy własnej firmy;
- nie wykonuje bezpośrednich INSERT/UPDATE/DELETE na immutable result/history tables;
- mutacje wyłącznie przez publiczne RPC;
- może start/retry/review.

### recruiter
- SELECT własna firma;
- mutacje przez te same RPC co owner: start/retry/review;
- brak zarządzania członkami/tenantem.

### viewer
- SELECT własna firma;
- brak start/retry/review;
- brak bezpośrednich write grants.

### anon / outside tenant
- brak SELECT/INSERT/UPDATE/DELETE;
- brak EXECUTE mutacyjnych RPC.

### Service boundary
- aplikacyjny caller używa sesji Supabase Auth;
- publiczne RPC wykonują kontrolę `auth.uid()`, tenant membership i role;
- pomocnicze funkcje SECURITY DEFINER wyłącznie w `private`, pusty `search_path`, bez exposed schema;
- provider worker nie może polegać na client-supplied `company_id`, `application_id`, fingerprint lub wynikach bez ponownej walidacji.

W SC-004 należy preferować odebranie bezpośrednich insert/update/delete grantów do nowych tabel historii i wystawić tylko SELECT + kontrolowane RPC, analogicznie do istniejących immutable entries.

## 11. Proponowane RPC i granice transakcji

### 11.1. `start_screening_analysis(...)`
Cel: atomowo utworzyć lub reuse’ować logical analysis i pierwszy/nowy attempt.

Wejście minimalne:
- `target_application uuid`;
- `expected_input_fingerprint text`;
- `expected_payload_schema_version int`;
- `result_schema_version int`;
- `prompt_version text`;
- `provider text`;
- `model text`;
- `model_revision text|null`;
- `idempotency_key uuid`.

RPC NIE przyjmuje `company_id`, CV text ani snapshotu z przeglądarki jako źródła prawdy. Serwer przed RPC/repository layer przygotowuje materiał, a RPC musi wiarygodnie zablokować relacje i potwierdzić expected binding/fingerprint na podstawie wartości utrzymywanych w DB lub przy użyciu kontrolowanej funkcji. Jeśli pełnego fingerprintu nie da się odtworzyć w SQL identycznie jak w TS, SC-004 powinno zastosować dwufazowy kontrakt: server reload + transakcja blokująca wszystkie wiersze bindingu i porównująca expected version/timestamps, nigdy sam fingerprint od klienta.

Transakcja:
1. sprawdź rolę owner/recruiter;
2. lock application/recruitment/position/document rows w stabilnej kolejności;
3. potwierdź screening eligibility i exact binding;
4. oznacz istniejące current completed wyniki stale, jeśli fingerprint nie odpowiada bieżącemu;
5. jeśli istnieje reusable completed result dla contract key — zwróć go bez nowego attempt;
6. jeśli istnieje aktywna logical analysis dla tego samego contract — zwróć istniejącą;
7. inaczej wyznacz `analysis_version = max+1` pod advisory/application lock;
8. zapisz immutable snapshot i analysis;
9. utwórz attempt z unikalnym idempotency key.

### 11.2. `claim_screening_attempt(...)`
Cel: worker przejmuje pending attempt.

Wejście:
- attempt_id;
- lease token proof / nonce według implementacji.

Transakcja:
- `SELECT ... FOR UPDATE SKIP LOCKED` lub row lock;
- tylko pending albo expired processing;
- ustaw processing, lease expiry, started_at;
- parent analysis -> processing.

Nie przekazywać lease tokenu do przeglądarki.

### 11.3. `complete_screening_analysis(...)`
Cel: jedyna ścieżka zapisu zaakceptowanego wyniku AI.

Wejście:
- analysis_id;
- attempt_id;
- lease proof;
- expected input fingerprint/contract hash;
- validated structured findings;
- usage metadata.

Transakcja:
1. lock analysis + attempt;
2. potwierdź attempt aktywny i lease;
3. ponownie sprawdź current screening binding/fingerprint przed zapisem;
4. jeśli zmiana nastąpiła w trakcie provider call:
   - NIE zapisuj criterion results jako current;
   - oznacz analysis stale/failed z kontrolowanym kodem `input_changed_during_processing` albo zapisz historyczny result jako completed+stale w tej samej transakcji; rekomendacja: zapisać zwalidowany wynik jako `completed` i natychmiast `stale_at=now()`, aby zachować audit/cost, ale nigdy go nie zwracać jako current;
5. waliduj dokładnie jedno kryterium na snapshot item;
6. waliduj evidence exact match;
7. insert wszystkich criterion rows;
8. wylicz deterministic aggregate `overall_score` jeśli SC-004 zamraża algorytm;
9. attempt -> completed, analysis -> completed, timestamps;
10. commit atomowo.

Brak częściowo zapisanego wyniku.

### 11.4. `fail_screening_attempt(...)`
- lock attempt + analysis;
- idempotent: drugi zapis tego samego failure nie zmienia historii;
- zapis sanitarnych kodów i usage jeśli dostępne;
- parent -> failed tylko jeśli nie istnieje inny aktywny attempt;
- nie zapisuje raw provider response.

### 11.5. `retry_screening_analysis(...)`
- owner/recruiter;
- tylko failed/pending bez aktywnego attempt;
- przed retry ponownie sprawdza current fingerprint;
- jeśli fingerprint zmieniony: stary analysis stale i tworzy nową analysis_version, nie retry starej;
- jeśli fingerprint/contract zgodny: nowy attempt_no w tej samej analysis;
- nowy idempotency key.

### 11.6. `review_screening_result(...)`
Wejście:
- analysis_id;
- `expected_review_version`;
- disposition;
- note;
- overrides.

Transakcja:
1. lock analysis;
2. role owner/recruiter;
3. require completed;
4. compare `latest_review_version = expected_review_version`;
5. ponownie sprawdź stale/current;
6. validate overrides względem snapshotu i criterion rows;
7. insert immutable review + overrides;
8. increment cached `latest_review_version`.

To rozwiązuje konflikt dwóch reviewerów.

### 11.7. `refresh_screening_staleness(...)`
Może działać per application/recruitment:
- recompute/compare bieżący screening binding;
- mark affected completed analyses stale idempotently;
- nigdy nie od-stale’uje starego rekordu automatycznie.

W praktyce start, complete, review i ranking query powinny wykonywać stale check jako część własnej transakcji. Osobne RPC jest przydatne do UI/list refresh i SC-007.

## 12. Idempotency i concurrency

### Równoczesne kliknięcia użytkownika
- jeden `idempotency_key` na intencję UI;
- UNIQUE `(company_id, idempotency_key)`;
- start RPC pod application-scoped transaction/advisory lock;
- jeśli ten sam request dotarł dwa razy, oba zwracają ten sam attempt/result.

### Dwa różne kliknięcia
- partial unique/advisory lock gwarantuje tylko jedną aktywną analysis dla tego samego application + analysis contract;
- drugie wywołanie dostaje istniejącą analysis zamiast tworzyć duplikat.

### Retry HTTP/provider
- retry tego samego provider request nie może utworzyć drugiego result;
- `complete_screening_analysis` jest idempotentne dla już completed attempt: zwraca istniejący analysis id, jeśli payload hash/contract zgodny; odrzuca konfliktujący drugi payload.

### Dwa workery
- claim przez row lock + lease;
- tylko holder aktywnego lease może complete/fail;
- expired lease może być przejęty zgodnie z kontrolowaną procedurą;
- late result starego workera po utracie lease jest odrzucany.

### Version number race
- `analysis_version=max+1` wyłącznie pod lockiem scoped do `company_id + application_id`;
- unique constraint jest ostatnią warstwą ochrony.

### Review race
- optimistic concurrency przez `expected_review_version` + row lock;
- brak last-write-wins.

## 13. Privacy

### Payload do zewnętrznego AI — allowlist
Do AI wolno wysłać wyłącznie:
- `schema_version`;
- `cv_text` = zatwierdzony `redacted_text`;
- `criteria[] = { id, kind, text }`.

Nie wolno wysłać:
- imienia i nazwiska;
- email;
- telefonu;
- `company_id`, `candidate_id`, `application_id`, `recruitment_id`, `position_id`, `document_id`;
- `reviewed_by`;
- nazw użytkowników;
- oryginalnego `source_text`/oryginalnego CV;
- storage URL;
- notatek rekrutera;
- niepotrzebnego opisu firmy/rekrutacji;
- sekretów, JWT, kluczy API.

Należy utrzymać jawny allowlist serializer. Nigdy nie serializować całego obiektu DB do requestu providera.

### Persistencja
- źródłowy `source_text` pozostaje wyłącznie w candidate_documents;
- snapshot analizy przechowuje tylko zatwierdzony redacted text;
- nie przechowywać raw provider request/response, jeśli nie jest konieczny;
- provider IDs/usage są technicznym metadata;
- error logs nie mogą zawierać pełnego CV ani response body.

## 14. Prompt injection

Treść CV jest niezaufanym dokumentem, nigdy instrukcją.

W SC-005 kontrakt promptu musi:
- oddzielić system/developer instructions od CV data;
- jawnie oznaczyć CV jako quoted/untrusted data;
- nakazać ignorowanie poleceń znalezionych w CV;
- zakazać wykonywania URL, narzędzi, kodu, poleceń lub ujawniania system prompt;
- wyłączyć tools/web/function calling dla tej operacji, jeśli nie są wymagane;
- wymusić structured output tylko z dozwolonym schema;
- odrzucać dodatkowe pola i final hiring decision;
- ponownie walidować całe structured output po stronie serwera.

Cytat z CV zawierający prompt injection może być evidence tylko jako tekst źródłowy; nie wpływa na hierarchy instrukcji.

## 15. Ranking readiness dla SC-008

Schemat ma umożliwić ranking bez przebudowy:
- każda analiza jest przypięta do `recruitment_id` i `application_id`;
- każdy criterion result ma rating + numeric `rating_score`;
- snapshot kryteriów zachowuje kolejność i tekst;
- review overrides dają effective rating bez niszczenia AI;
- `overall_score` może być utrwalonym agregatem deterministycznym;
- current/stale jest jednoznaczne;
- reviewed/unreviewed jest jednoznaczne;
- `needs_reanalysis` można wykluczyć;
- historyczne wersje pozostają dostępne.

Rekomendacja dla SC-004/SC-008: scoring aggregate nie może traktować `insufficient_data` jako dowodu niespełnienia kryterium. Należy przechowywać co najmniej:
- `scored_criteria_count`;
- `insufficient_data_count`;
- `max_score_possible_for_scored`;
- wynik znormalizowany tylko według jawnie zamrożonego algorytmu `scoring_version`.

Jeśli algorytm rankingu nie jest jeszcze zaakceptowany, `overall_score` pozostawić nullable w SC-004 i oprzeć SC-008 na criterion rows + oddzielnym versioned ranking contract. Nie wymaga to zmiany schematu bazowego.

## 16. Retention i audit

Minimalne audit metadata:
- analysis: `created_by`, `created_at`, `processing_started_at`, `completed_at`, `failed_at`;
- freshness: `stale_at`, `stale_reason`, `superseded_by_analysis_id`;
- AI contract: `provider`, `model`, `model_revision`, `prompt_version`, `payload_schema_version`, `result_schema_version`, rekomendowane `analysis_contract_hash`;
- attempts: request/response IDs, token counts, cost/currency, timestamps, sanitized errors;
- review: reviewer_id, review_version, disposition, note, created_at;
- criterion: immutable AI output and immutable review overrides.

Nie hard-delete historycznych analiz pojedynczo przez zwykły CRUD. Retention/delete powinno dziedziczyć lifecycle danych kandydata/firmy i zostać wdrożone świadomie:
- usunięcie firmy/kandydata/application może kaskadowo usunąć zależne screening records zgodnie z polityką produktu i obowiązkami prawnymi;
- brak osobnego bezpośredniego DELETE dla recruiter/viewer;
- przyszła polityka retencji powinna być osobnym taskiem, jeśli ma zachowywać agregaty po usunięciu danych osobowych.

## 17. Widoki / read model — rekomendacja

SC-004 może dodać widoki `security_invoker`, jeśli uproszczą UI, ale nie są konieczne dla minimalnej migracji.

Rekomendowane read models:
- `latest_screening_analyses` — najwyższa completed analysis_version per application z freshness;
- `latest_screening_reviews` — najwyższa review_version per analysis;
- `effective_screening_criterion_results` — AI + latest human overrides.

Jeśli zostaną dodane, muszą być `security_invoker` i respektować RLS tabel źródłowych.

## 18. Open questions wymagające decyzji przed/na początku SC-004

1. Czy SC-004 ma utrwalać `analysis_contract_hash` jako osobną kolumnę — rekomendacja: **tak**.
2. Czy `overall_score` liczymy już w SC-004, czy dopiero SC-008 — rekomendacja: **nullable teraz, algorytm w SC-008**, chyba że scoring zostanie zamrożony wcześniej.
3. Czy stale wynik po zmianie inputu w trakcie provider call zapisujemy jako `completed + stale`, czy odrzucamy bez criterion rows — rekomendacja: **completed + stale**, ponieważ zachowuje audit, koszt i odpowiedź, ale wymaga bezwzględnego filtrowania current result.
4. Czy reviewer może poprawiać evidence, czy tylko rating/explanation — rekomendacja: **tak, może poprawić evidence**, ale wyłącznie względem tego samego redacted snapshotu.
5. Czy świadome „reanalyze same input” jest funkcją od SC-007 czy od razu w SC-004 — rekomendacja: schema wspiera od razu, UI może poczekać.
6. Retencja dokładnego redacted snapshotu: rekomendacja pozostawić go tak długo jak wynik, bo bez niego nie da się wiarygodnie audytować offsetów/cytatów.

## 19. Ryzyka

1. **Divergence fingerprint TS vs SQL** — fingerprint jest dziś liczony w TS. Nie implementować drugiego, subtelnie różnego kanonizera w SQL bez testów kontraktowych.
2. **Stale race** — input może zmienić się po dispatch, ale przed save; dlatego required recheck w transakcji complete.
3. **Duplicate workers** — bez lease + row lock dwa procesy mogłyby zakończyć ten sam attempt.
4. **Review overwrite** — bez version check dwóch reviewerów stworzyłoby last-write-wins.
5. **Evidence corruption** — offsety muszą być walidowane względem immutable snapshotu, nie aktualnego CV.
6. **PII leakage in logs** — nie logować raw payload/response.
7. **Raw provider output drift** — structured output musi być walidowane lokalnie; provider schema nie jest jedyną ochroną.
8. **Overtrust in confidence/score** — confidence nie jest prawdopodobieństwem jakości zatrudnienia; score nie jest decyzją.
9. **Ranking bias by missing data** — `insufficient_data` musi pozostać semantycznie inne niż `below`.
10. **Cascade deletes** — SC-004 musi jawnie sprawdzić zgodność nowych FK/cascade z istniejącą polityką usuwania kandydatów/rekrutacji.

## 20. Implementation plan for SC-004

SC-004 powinno być jedną migracją L3 i nie powinno integrować providera AI.

Kolejność:
1. Dodać typy/check constraints dla statusów/ratingów albo użyć CHECK text zgodnie z istniejącym stylem.
2. Utworzyć:
   - `screening_analysis_versions`;
   - `screening_analysis_attempts`;
   - `screening_criterion_results`;
   - `screening_result_reviews`;
   - `screening_criterion_review_overrides`.
3. Dodać złożone tenant-safe FK, unique constraints i indeksy.
4. Włączyć RLS na wszystkich tabelach.
5. Dodać SELECT policies dla owner/recruiter/viewer i brak write policies dla historii.
6. Ograniczyć grants; mutacje owner/recruiter tylko przez RPC.
7. Zaimplementować prywatne helpery autoryzacji/locking zgodnie z obecnym wzorcem.
8. Zaimplementować RPC:
   - `start_screening_analysis`;
   - `claim_screening_attempt`;
   - `complete_screening_analysis`;
   - `fail_screening_attempt`;
   - `retry_screening_analysis`;
   - `review_screening_result`;
   - opcjonalnie `refresh_screening_staleness`.
9. W RPC odtworzyć walidację bindingu i zapewnić recheck przed complete/review.
10. Dodać/rozszerzyć ręczny kontrakt `database.types.ts`, z `Insert/Update = never` dla immutable tables.
11. Dodać testy PGlite:
    - tenant isolation;
    - role owner/recruiter/viewer;
    - exact FK relations;
    - jedna aktywna próba;
    - idempotency duplicate click;
    - concurrent version allocation;
    - retry po failed;
    - stale przy zmianie application/recruitment/position/document;
    - reject save po zmianie inputu;
    - exact criterion count;
    - quote/offset validation;
    - immutable AI result;
    - review optimistic concurrency;
    - review override bez utraty AI;
    - viewer read-only;
    - anon denied.
12. Zaktualizować `docs/database.md` i `docs/screening.md` dopiero w SC-004 po implementacji.
13. Nie dodawać OpenAI API, UI rankingu ani shortlisty w SC-004.

## 21. Acceptance architecture checklist

- [x] wynik jest per application i recruitment;
- [x] wejście jest snapshotowane i audytowalne;
- [x] fingerprint zachowuje istniejący kontrakt;
- [x] model obsługuje stale;
- [x] model rozdziela logical version i provider attempts;
- [x] retry nie wymaga nowej wersji wyniku, jeśli input nie zmienił się;
- [x] świadome reanalysis może utworzyć nową analysis version;
- [x] AI result jest immutable;
- [x] human review jest immutable/versioned;
- [x] korekty człowieka nie niszczą oryginału AI;
- [x] evidence jest związane z immutable CV snapshot;
- [x] owner/recruiter/viewer mają zdefiniowany model uprawnień;
- [x] idempotency i concurrency są rozwiązane na poziomie DB transaction/constraints;
- [x] privacy używa allowlist;
- [x] prompt injection jest rozpoznane jako boundary bezpieczeństwa;
- [x] SC-008 może korzystać z modelu bez przebudowy podstawowych tabel;
- [x] audit zawiera provider/model/prompt/schema/usage/cost/timestamps.

---

## TASK
SC-003 — Model danych dla persistowanego wyniku preselekcji AI.

## ARCHITECTURE STATUS
PROPOSED — gotowe do review przed SC-004. Brak implementacji.

## PROPOSED TABLES
- `screening_analysis_versions`
- `screening_analysis_attempts`
- `screening_criterion_results`
- `screening_result_reviews`
- `screening_criterion_review_overrides`

## PROPOSED RPC
- `start_screening_analysis`
- `claim_screening_attempt`
- `complete_screening_analysis`
- `fail_screening_attempt`
- `retry_screening_analysis`
- `review_screening_result`
- opcjonalnie `refresh_screening_staleness`

## RLS MODEL
Owner i recruiter: SELECT + mutacje wyłącznie przez RPC. Viewer: SELECT only. Anon/outside tenant: brak dostępu. Wszystkie tabele z RLS i `company_id`; immutable history bez bezpośredniego write CRUD.

## VERSIONING MODEL
`analysis_version` jest monotoniczne per application. Attempty są wersjonowane osobno przez `attempt_no`. Human review ma własne `review_version`. AI result jest immutable. Reuse wymaga zgodnego input fingerprint i analysis contract.

## CONCURRENCY MODEL
Application-scoped lock przy tworzeniu wersji, unique constraints, jeden aktywny attempt, lease dla workera, idempotency key, recheck fingerprint przed save, optimistic concurrency dla review.

## PRIVACY MODEL
Do AI tylko `schema_version`, zatwierdzony `redacted_text` i allowlisted `criteria`. Bez nazwiska, emaila, telefonu, DB IDs, reviewer IDs, oryginalnego CV i niepotrzebnych danych. Brak raw provider request/response w bazie.

## OPEN QUESTIONS
- trwała kolumna `analysis_contract_hash` — rekomendowane tak;
- moment wprowadzenia `overall_score` — rekomendowane SC-008;
- zapis completed+stale przy zmianie inputu podczas provider call — rekomendowane tak;
- reviewer evidence override — rekomendowane tak;
- UI reanalysis same input — schema gotowa, UI później;
- polityka retencji redacted snapshot — zachować wraz z wynikiem do osobnego tasku retencyjnego.

## RISKS
Fingerprint divergence TS/SQL, stale race, duplicate workers, review race, błędne offsety evidence, PII w logach, provider schema drift, nadużycie confidence/score, błędne traktowanie insufficient_data, niezamierzone cascade deletes.

## IMPLEMENTATION PLAN FOR SC-004
Jedna nowa migracja: 5 tabel + constraints/FK/indexes + RLS/grants + RPC + typy kontraktowe + PGlite tests. Bez OpenAI, bez rankingu UI, bez merge do czasu review/testów.

## FILES CHANGED
Tylko `docs/sc-003-screening-result-architecture.md`.

## TESTS
SC-003 nie zmienia kodu ani DB. Wymagane jest review architektury; testy runtime nie są uruchamiane dla samego dokumentu. SC-004 ma dodać testy DB/RLS/concurrency opisane powyżej.

## NEXT ACTION
Review SC-003. Po akceptacji rozpocząć SC-004 według powyższego planu. Nie implementować SC-004 w ramach tego tasku.
`.
- CHECK `payload_schema_version >= 1`, `result_schema_version >= 1`.
- CHECK dozwolonych `execution_status`.
- CHECK spójności czasów:
  - `completed` wymaga `completed_at IS NOT NULL`, bez `failed_at`;
  - `failed` wymaga `failed_at IS NOT NULL`, bez `completed_at`;
  - inne stany nie mogą udawać ukończenia.
- CHECK `stale_at IS NULL` iff `stale_reason IS NULL`.
- CHECK `overall_score` w zakresie 0..100, jeśli zapisany.
- `criteria_snapshot` ma być tablicą JSON; walidacja pełnego kształtu w RPC/server contract.

#### FK i tenant-safe relations
W SC-004 należy zastosować złożone FK, analogicznie do istniejącego schematu:
- `(company_id, recruitment_id, application_id) -> applications(company_id, recruitment_id, id)`;
- `(company_id, recruitment_id) -> recruitments(company_id, id)`;
- `(company_id, position_id) -> positions(company_id, id)`;
- `(company_id, candidate_document_id) -> candidate_documents(company_id, id)`.

Dodatkowo RPC musi potwierdzić:
- `recruitment.position_id = position_id`;
- `candidate_document.candidate_id = application.candidate_id`;
- dokument jest najnowszym dokumentem wybranym przez obowiązujące `prepareScreening`.

#### Unique constraints / indexes
- UNIQUE `(company_id, application_id, analysis_version)`.
- UNIQUE `(company_id, id)` dla złożonych FK z tabel podrzędnych.
- INDEX `(company_id, recruitment_id, application_id, analysis_version DESC)`.
- INDEX `(company_id, recruitment_id, execution_status, stale_at)` dla rankingu/list.
- INDEX `(company_id, application_id, input_fingerprint)`.
- INDEX `(company_id, candidate_document_id, candidate_document_version)`.
- partial INDEX dla current completed: `(company_id, recruitment_id, application_id) WHERE execution_status='completed' AND stale_at IS NULL`.
- nie wymuszać UNIQUE tylko na `input_fingerprint`: ponowna analiza tego samego materiału po zmianie prompt/model contract musi być możliwa.

### 3.2. `screening_analysis_attempts`

Historia fizycznych prób wykonania provider call. Oddzielenie attempt od logical version umożliwia retry bez tworzenia fałszywych wersji wyniku.

| Kolumna | Typ | Null | Znaczenie |
| --- | --- | --- | --- |
| `id` | uuid | no | PK |
| `company_id` | uuid | no | tenant |
| `analysis_id` | uuid | no | logical version |
| `attempt_no` | integer | no | 1..N w ramach analysis |
| `idempotency_key` | uuid | no | klucz jednego żądania start/retry |
| `status` | text | no | `pending|processing|completed|failed|abandoned` |
| `lease_token_hash` | text | yes | hash sekretu lease; sam token nie jest przechowywany jawnie |
| `lease_expires_at` | timestamptz | yes | ochrona przed martwym workerem |
| `provider_request_id` | text | yes | identyfikator techniczny providera |
| `provider_response_id` | text | yes | jeśli dostępny |
| `input_tokens` | integer | yes | usage |
| `output_tokens` | integer | yes | usage |
| `cached_input_tokens` | integer | yes | jeśli provider raportuje |
| `cost_amount` | numeric(12,6) | yes | koszt liczbowy |
| `cost_currency` | char(3) | yes | np. USD |
| `error_code` | text | yes | sanitarny |
| `created_at` | timestamptz | no | start rekordu |
| `started_at` | timestamptz | yes | faktyczny provider execution |
| `finished_at` | timestamptz | yes | koniec |

Constraints / indexes:
- UNIQUE `(company_id, analysis_id, attempt_no)`.
- UNIQUE `(company_id, idempotency_key)`.
- FK `(company_id, analysis_id) -> screening_analysis_versions(company_id, id)`.
- CHECK `attempt_no >= 1`; tokeny >= 0; cost >= 0.
- partial UNIQUE zapewniający maksymalnie jeden aktywny attempt na analysis:
  `UNIQUE (company_id, analysis_id) WHERE status IN ('pending','processing')`.
- INDEX `(company_id, analysis_id, attempt_no DESC)`.

Nie zapisywać pełnego request/response body providera. Kanoniczny input jest w snapshotach analizy, a wynik w tabelach wynikowych. Ogranicza to retencję niekontrolowanych danych.

### 3.3. `screening_criterion_results`

Niezmienny wynik AI per kryterium dla ukończonej `screening_analysis_versions`.

| Kolumna | Typ | Null | Znaczenie |
| --- | --- | --- | --- |
| `id` | uuid | no | PK |
| `company_id` | uuid | no | tenant |
| `analysis_id` | uuid | no | wersja analizy |
| `criterion_id` | text | no | np. `task:1`, `kpi:2`, `competency:1` |
| `criterion_kind` | text | no | `task|kpi|competency` |
| `criterion_order` | integer | no | pozycja w snapshot |
| `criterion_text_snapshot` | text | no | kryterium dokładnie z wejścia |
| `rating` | text | no | `insufficient_data|below|meets|above` |
| `rating_score` | smallint | no | deterministyczne mapowanie do rankingu, np. 0/1/2/3 |
| `evidence` | jsonb | no | tablica max 5 cytatów `{start,end,quote}` |
| `explanation` | text | yes | krótka interpretacja AI; nie może zastępować evidence |
| `confidence` | numeric(4,3) | yes | 0..1; tylko jeśli kontrakt providera/promptu definiuje semantykę |
| `created_at` | timestamptz | no | zapis wyniku |

Constraints:
- UNIQUE `(company_id, analysis_id, criterion_id)`.
- FK `(company_id, analysis_id) -> screening_analysis_versions(company_id, id)`.
- CHECK dozwolonego `criterion_kind` i `rating`.
- CHECK `rating_score` zgodny z rating: rekomendowane `insufficient_data=0, below=1, meets=2, above=3`; do agregacji SC-008 należy jednak odróżniać insufficient_data od below, mimo tej samej lub różnej punktacji.
- CHECK `confidence BETWEEN 0 AND 1`, jeśli nie-null.
- CHECK `criterion_order >= 1`.
- pełna walidacja evidence w RPC: offsety UTF-16, quote exact match, max 5, max 2000 znaków, evidence wymagane dla rating != insufficient_data.
- wynik musi zawierać dokładnie jeden rekord dla każdego elementu `criteria_snapshot` i żadnego dodatkowego.

Indexes:
- `(company_id, analysis_id, criterion_order)`;
- `(company_id, analysis_id, rating)`;
- opcjonalnie `(company_id, recruitment_id)` nie jest potrzebne, bo parent lookup jest tani; nie dublować recruitment_id w child bez potrzeby.

### 3.4. `screening_result_reviews`

Niezmienna historia human review. Review nie nadpisuje wyniku AI.

| Kolumna | Typ | Null | Znaczenie |
| --- | --- | --- | --- |
| `id` | uuid | no | PK |
| `company_id` | uuid | no | tenant |
| `analysis_id` | uuid | no | review konkretnej wersji AI |
| `review_version` | integer | no | 1..N |
| `reviewer_id` | uuid | no | auth user |
| `disposition` | text | no | `approved|approved_with_changes|needs_reanalysis` |
| `review_note` | text | yes | notatka wewnętrzna |
| `created_at` | timestamptz | no | moment review |

Constraints:
- UNIQUE `(company_id, analysis_id, review_version)`.
- FK `(company_id, analysis_id) -> screening_analysis_versions(company_id, id)`.
- CHECK disposition.
- review dozwolone tylko dla `execution_status='completed'`.
- stale wynik może zostać odczytany wraz z historycznym review, ale nie może dostać nowego `approved`; reviewer może wyłącznie odnotować `needs_reanalysis` albo system wymusi start nowej analizy.

Index:
- `(company_id, analysis_id, review_version DESC)`;
- `(company_id, reviewer_id, created_at DESC)`.

### 3.5. `screening_criterion_review_overrides`

Korekty człowieka związane z konkretną wersją review. Oryginał AI pozostaje niezmienny.

| Kolumna | Typ | Null | Znaczenie |
| --- | --- | --- | --- |
| `id` | uuid | no | PK |
| `company_id` | uuid | no | tenant |
| `review_id` | uuid | no | review parent |
| `criterion_result_id` | uuid | no | oryginalny AI criterion row |
| `rating_override` | text | yes | poprawiony rating |
| `evidence_override` | jsonb | yes | poprawione/wybrane cytaty z tego samego snapshotu |
| `explanation_override` | text | yes | uzasadnienie korekty |
| `created_at` | timestamptz | no | audit |

Constraints:
- UNIQUE `(company_id, review_id, criterion_result_id)`.
- złożone FK do review i criterion result.
- RPC musi potwierdzić, że review oraz criterion result należą do tego samego `analysis_id`.
- co najmniej jedno pole override musi być nie-null.
- rating/evidence override podlegają tym samym regułom dowodowym co AI.
- confidence nie jest korygowane przez człowieka; human review jest osobnym, silniejszym sygnałem.

## 4. Relacje

```
companies
  └─ positions
      └─ recruitments
          └─ applications
              └─ screening_analysis_versions
                  ├─ screening_analysis_attempts
                  ├─ screening_criterion_results
                  └─ screening_result_reviews
                      └─ screening_criterion_review_overrides

candidates
  ├─ applications
  └─ candidate_documents
       └─ screening_analysis_versions (source binding)
```

Każde powiązanie operacyjne jest tenant-safe przez `company_id`. `analysis` jest zawsze wynikiem dla `application`, nigdy globalną oceną kandydata.

## 5. Status lifecycle

### Logical analysis
- `pending` — rekord utworzony po atomowym sprawdzeniu inputu, bez aktywnego zakończonego wyniku;
- `processing` — worker posiada ważny lease;
- `completed` — wszystkie criterion rows zapisane i zwalidowane w jednej transakcji;
- `failed` — ostatnia próba zakończona błędem i nie ma aktywnego attempt;
- `cancelled` — świadomie przerwana przed ukończeniem.

Dozwolone przejścia:
- pending -> processing;
- processing -> completed;
- processing -> failed;
- processing -> pending wyłącznie przez kontrolowany retry/lease recovery;
- failed -> pending przez retry tego samego logical analysis;
- pending/failed -> cancelled;
- completed jest terminalny dla treści AI.

### Freshness
`stale` nie jest execution status. Ukończony wynik staje się stale przez ustawienie:
- `stale_at`;
- `stale_reason`.

Kontrolowane `stale_reason`:
- `application_changed`;
- `recruitment_changed`;
- `position_changed`;
- `candidate_document_changed`;
- `candidate_document_unreviewed`;
- `screening_contract_changed`;
- `manual_invalidation`.

### Review
Latest review wyznacza stan:
- brak wpisu: `unreviewed`;
- `approved`;
- `approved_with_changes`;
- `needs_reanalysis`.

Nie dodawać boolean `reviewed`, który traci historię.

## 6. Wynik kryterium i evidence contract

Obowiązują cztery ratingi:
- `insufficient_data`;
- `below`;
- `meets`;
- `above`.

Każdy wynik kryterium przechowuje:
- stabilny `criterion_id` z przygotowanego payloadu;
- kind, kolejność i snapshot tekstu;
- rating;
- evidence jako 0..5 cytatów;
- source offsets `start/end` UTF-16;
- exact `quote`;
- opcjonalne `explanation`;
- opcjonalne `confidence`.

Reguły:
- `insufficient_data` może mieć pustą evidence;
- pozostałe ratingi wymagają >=1 evidence;
- każdy quote musi być identyczny z `input_cv_text_snapshot.slice(start,end)`;
- evidence nie może wskazywać oryginalnego CV;
- explanation nie może być używane jako źródło prawdy zamiast cytatu;
- model nie może zwracać pola final decision/recommendation.

Confidence jest opcjonalne i wolno je włączyć dopiero, jeśli prompt/schema jednoznacznie definiuje znaczenie liczby 0..1. Nie traktować confidence jako kalibrowanego prawdopodobieństwa sukcesu pracownika.

## 7. Snapshot wejścia

W chwili utworzenia logical analysis trzeba zamrozić dokładnie to, co jest potrzebne do odtworzenia decyzji technicznej i walidacji evidence:

### Dane przechowywane wewnętrznie
1. `input_cv_text_snapshot` — dokładny zatwierdzony `redacted_text`;
2. `criteria_snapshot` — dokładny payload `criteria` w kolejności:
   - `id`,
   - `kind`,
   - `text`;
3. `binding_snapshot` z obecnego `prepareScreening`:
   - `company_id`,
   - `application_id`,
   - `application_updated_at`,
   - `recruitment_id`,
   - `recruitment_updated_at`,
   - `position_id`,
   - `position_updated_at`,
   - `document_id`,
   - `document_version`;
4. `payload_schema_version`;
5. `input_fingerprint`.

### Dane niewysyłane do AI
`binding_snapshot`, IDs, reviewer metadata i wszystkie relacje DB pozostają wyłącznie po stronie systemu.

Snapshot jest immutable po rozpoczęciu analizy. Zmiana źródeł tworzy nowy fingerprint i nową logical analysis version; nie modyfikuje starego snapshotu.

## 8. Fingerprint i versioning

### 8.1. Fingerprint — definicja obowiązująca

SC-003 zachowuje istniejący kontrakt z `lib/screening.ts` bez zmiany algorytmu:

`SHA-256(JSON.stringify({ binding, payload }))`

gdzie:

`binding`:
- company_id;
- application_id;
- application_updated_at;
- recruitment_id;
- recruitment_updated_at;
- position_id;
- position_updated_at;
- document_id;
- document_version.

`payload`:
- schema_version;
- cv_text = zatwierdzony `redacted_text`;
- criteria = uporządkowane task/kpi/competency z `criterion_id`, kind, text.

To oznacza, że zmiana dowolnego elementu tego kanonicznego obiektu zmienia fingerprint.

### 8.2. Co NIE wchodzi do input fingerprint
- provider/model;
- prompt version;
- result schema version;
- reviewer;
- token/cost metadata;
- wynik AI.

Te pola opisują wykonanie/kontrakt wyniku, nie materiał wejściowy.

### 8.3. Kiedy wynik jest stale
Wynik jest stale, gdy ponowne `prepareScreening(currentContext)` daje fingerprint różny od zapisanego albo przygotowanie bieżącego materiału nie jest już dozwolone.

W szczególności:
- zmieniono application (`updated_at`);
- zmieniono recruitment;
- zmieniono position tasks/KPI/competencies lub inny element powodujący `updated_at`;
- pojawiła się nowa wersja/nowszy dokument CV;
- redakcja utraciła review;
- dokument źródłowy przestał być najnowszym dokumentem używanym przez screening;
- zmienił się payload schema w sposób wpływający na wejście.

Zmiana prompt/model bez zmiany input fingerprint nie czyni historycznego wyniku „stale względem danych”, ale może czynić go niezgodnym z aktualnym **analysis contract**. Dlatego reuse sprawdza również contract key poniżej.

### 8.4. Analysis contract key
Do decyzji o reuse używać logicznego zestawu:
- `input_fingerprint`;
- `payload_schema_version`;
- `result_schema_version`;
- `prompt_version`;
- `provider`;
- `model`;
- `model_revision` jeśli pinned.

Można wyliczać `analysis_contract_hash` w kodzie lub przechowywać jako dodatkową kolumnę SHA-256 w SC-004; rekomendacja: dodać kolumnę `analysis_contract_hash text not null`, aby uprościć idempotent lookup i audyt.

### 8.5. Reuse
Istniejący wynik można ponownie wykorzystać tylko jeśli:
- `execution_status='completed'`;
- `stale_at IS NULL`;
- bieżący `prepareScreening` daje dokładnie ten sam `input_fingerprint`;
- analysis contract key jest zgodny z żądanym;
- wynik ma komplet dokładnie jednego criterion result na każde kryterium;
- nie istnieje najnowszy review `needs_reanalysis`.

Ponowne kliknięcie „analizuj” z tym samym idempotency key musi zwrócić ten sam analysis/attempt. Nowe świadome „reanalyze” z nowym idempotency key może utworzyć nową `analysis_version`, nawet przy tym samym input fingerprint, jeśli produkt ma taką akcję. Domyślna ścieżka powinna reuse’ować istniejący current completed result.

## 9. Human review

### Kto może review
- owner: tak;
- recruiter: tak;
- viewer: tylko odczyt;
- użytkownik spoza firmy/anon: nie.

### Co reviewer może zmienić
Reviewer nie edytuje AI rows. Może utworzyć immutable review z:
- disposition;
- note;
- per-criterion override rating/evidence/explanation.

### Czy korekta tworzy nową wersję AI
Nie. Korekta człowieka tworzy nową `review_version`, nie nową `analysis_version`.

Nowa `analysis_version` powstaje tylko dla nowego wykonania AI/reanalysis. W ten sposób:
- zachowany jest oryginalny wynik AI;
- zachowana jest pełna historia korekt człowieka;
- można później mierzyć zgodność AI z reviewerem.

### Effective result
Dla UI/rankingu:
- bez review: effective = AI;
- `approved`: effective = AI;
- `approved_with_changes`: latest review overrides zastępują wskazane pola kryteriów;
- `needs_reanalysis`: wynik nie kwalifikuje się jako reviewed result do shortlisty.

SC-008 powinno preferować reviewed effective result, ale polityka produktowa może dopuszczać jawnie oznaczony unreviewed result do podglądu. Nie wolno automatycznie podejmować decyzji zatrudnienia.

## 10. RLS / permissions — projekt

Wszystkie pięć nowych tabel mają RLS enabled.

### owner
- SELECT wszystkie rekordy własnej firmy;
- nie wykonuje bezpośrednich INSERT/UPDATE/DELETE na immutable result/history tables;
- mutacje wyłącznie przez publiczne RPC;
- może start/retry/review.

### recruiter
- SELECT własna firma;
- mutacje przez te same RPC co owner: start/retry/review;
- brak zarządzania członkami/tenantem.

### viewer
- SELECT własna firma;
- brak start/retry/review;
- brak bezpośrednich write grants.

### anon / outside tenant
- brak SELECT/INSERT/UPDATE/DELETE;
- brak EXECUTE mutacyjnych RPC.

### Service boundary
- aplikacyjny caller używa sesji Supabase Auth;
- publiczne RPC wykonują kontrolę `auth.uid()`, tenant membership i role;
- pomocnicze funkcje SECURITY DEFINER wyłącznie w `private`, pusty `search_path`, bez exposed schema;
- provider worker nie może polegać na client-supplied `company_id`, `application_id`, fingerprint lub wynikach bez ponownej walidacji.

W SC-004 należy preferować odebranie bezpośrednich insert/update/delete grantów do nowych tabel historii i wystawić tylko SELECT + kontrolowane RPC, analogicznie do istniejących immutable entries.

## 11. Proponowane RPC i granice transakcji

### 11.1. `start_screening_analysis(...)`
Cel: atomowo utworzyć lub reuse’ować logical analysis i pierwszy/nowy attempt.

Wejście minimalne:
- `target_application uuid`;
- `expected_input_fingerprint text`;
- `expected_payload_schema_version int`;
- `result_schema_version int`;
- `prompt_version text`;
- `provider text`;
- `model text`;
- `model_revision text|null`;
- `idempotency_key uuid`.

RPC NIE przyjmuje `company_id`, CV text ani snapshotu z przeglądarki jako źródła prawdy. Serwer przed RPC/repository layer przygotowuje materiał, a RPC musi wiarygodnie zablokować relacje i potwierdzić expected binding/fingerprint na podstawie wartości utrzymywanych w DB lub przy użyciu kontrolowanej funkcji. Jeśli pełnego fingerprintu nie da się odtworzyć w SQL identycznie jak w TS, SC-004 powinno zastosować dwufazowy kontrakt: server reload + transakcja blokująca wszystkie wiersze bindingu i porównująca expected version/timestamps, nigdy sam fingerprint od klienta.

Transakcja:
1. sprawdź rolę owner/recruiter;
2. lock application/recruitment/position/document rows w stabilnej kolejności;
3. potwierdź screening eligibility i exact binding;
4. oznacz istniejące current completed wyniki stale, jeśli fingerprint nie odpowiada bieżącemu;
5. jeśli istnieje reusable completed result dla contract key — zwróć go bez nowego attempt;
6. jeśli istnieje aktywna logical analysis dla tego samego contract — zwróć istniejącą;
7. inaczej wyznacz `analysis_version = max+1` pod advisory/application lock;
8. zapisz immutable snapshot i analysis;
9. utwórz attempt z unikalnym idempotency key.

### 11.2. `claim_screening_attempt(...)`
Cel: worker przejmuje pending attempt.

Wejście:
- attempt_id;
- lease token proof / nonce według implementacji.

Transakcja:
- `SELECT ... FOR UPDATE SKIP LOCKED` lub row lock;
- tylko pending albo expired processing;
- ustaw processing, lease expiry, started_at;
- parent analysis -> processing.

Nie przekazywać lease tokenu do przeglądarki.

### 11.3. `complete_screening_analysis(...)`
Cel: jedyna ścieżka zapisu zaakceptowanego wyniku AI.

Wejście:
- analysis_id;
- attempt_id;
- lease proof;
- expected input fingerprint/contract hash;
- validated structured findings;
- usage metadata.

Transakcja:
1. lock analysis + attempt;
2. potwierdź attempt aktywny i lease;
3. ponownie sprawdź current screening binding/fingerprint przed zapisem;
4. jeśli zmiana nastąpiła w trakcie provider call:
   - NIE zapisuj criterion results jako current;
   - oznacz analysis stale/failed z kontrolowanym kodem `input_changed_during_processing` albo zapisz historyczny result jako completed+stale w tej samej transakcji; rekomendacja: zapisać zwalidowany wynik jako `completed` i natychmiast `stale_at=now()`, aby zachować audit/cost, ale nigdy go nie zwracać jako current;
5. waliduj dokładnie jedno kryterium na snapshot item;
6. waliduj evidence exact match;
7. insert wszystkich criterion rows;
8. wylicz deterministic aggregate `overall_score` jeśli SC-004 zamraża algorytm;
9. attempt -> completed, analysis -> completed, timestamps;
10. commit atomowo.

Brak częściowo zapisanego wyniku.

### 11.4. `fail_screening_attempt(...)`
- lock attempt + analysis;
- idempotent: drugi zapis tego samego failure nie zmienia historii;
- zapis sanitarnych kodów i usage jeśli dostępne;
- parent -> failed tylko jeśli nie istnieje inny aktywny attempt;
- nie zapisuje raw provider response.

### 11.5. `retry_screening_analysis(...)`
- owner/recruiter;
- tylko failed/pending bez aktywnego attempt;
- przed retry ponownie sprawdza current fingerprint;
- jeśli fingerprint zmieniony: stary analysis stale i tworzy nową analysis_version, nie retry starej;
- jeśli fingerprint/contract zgodny: nowy attempt_no w tej samej analysis;
- nowy idempotency key.

### 11.6. `review_screening_result(...)`
Wejście:
- analysis_id;
- `expected_review_version`;
- disposition;
- note;
- overrides.

Transakcja:
1. lock analysis;
2. role owner/recruiter;
3. require completed;
4. compare `latest_review_version = expected_review_version`;
5. ponownie sprawdź stale/current;
6. validate overrides względem snapshotu i criterion rows;
7. insert immutable review + overrides;
8. increment cached `latest_review_version`.

To rozwiązuje konflikt dwóch reviewerów.

### 11.7. `refresh_screening_staleness(...)`
Może działać per application/recruitment:
- recompute/compare bieżący screening binding;
- mark affected completed analyses stale idempotently;
- nigdy nie od-stale’uje starego rekordu automatycznie.

W praktyce start, complete, review i ranking query powinny wykonywać stale check jako część własnej transakcji. Osobne RPC jest przydatne do UI/list refresh i SC-007.

## 12. Idempotency i concurrency

### Równoczesne kliknięcia użytkownika
- jeden `idempotency_key` na intencję UI;
- UNIQUE `(company_id, idempotency_key)`;
- start RPC pod application-scoped transaction/advisory lock;
- jeśli ten sam request dotarł dwa razy, oba zwracają ten sam attempt/result.

### Dwa różne kliknięcia
- partial unique/advisory lock gwarantuje tylko jedną aktywną analysis dla tego samego application + analysis contract;
- drugie wywołanie dostaje istniejącą analysis zamiast tworzyć duplikat.

### Retry HTTP/provider
- retry tego samego provider request nie może utworzyć drugiego result;
- `complete_screening_analysis` jest idempotentne dla już completed attempt: zwraca istniejący analysis id, jeśli payload hash/contract zgodny; odrzuca konfliktujący drugi payload.

### Dwa workery
- claim przez row lock + lease;
- tylko holder aktywnego lease może complete/fail;
- expired lease może być przejęty zgodnie z kontrolowaną procedurą;
- late result starego workera po utracie lease jest odrzucany.

### Version number race
- `analysis_version=max+1` wyłącznie pod lockiem scoped do `company_id + application_id`;
- unique constraint jest ostatnią warstwą ochrony.

### Review race
- optimistic concurrency przez `expected_review_version` + row lock;
- brak last-write-wins.

## 13. Privacy

### Payload do zewnętrznego AI — allowlist
Do AI wolno wysłać wyłącznie:
- `schema_version`;
- `cv_text` = zatwierdzony `redacted_text`;
- `criteria[] = { id, kind, text }`.

Nie wolno wysłać:
- imienia i nazwiska;
- email;
- telefonu;
- `company_id`, `candidate_id`, `application_id`, `recruitment_id`, `position_id`, `document_id`;
- `reviewed_by`;
- nazw użytkowników;
- oryginalnego `source_text`/oryginalnego CV;
- storage URL;
- notatek rekrutera;
- niepotrzebnego opisu firmy/rekrutacji;
- sekretów, JWT, kluczy API.

Należy utrzymać jawny allowlist serializer. Nigdy nie serializować całego obiektu DB do requestu providera.

### Persistencja
- źródłowy `source_text` pozostaje wyłącznie w candidate_documents;
- snapshot analizy przechowuje tylko zatwierdzony redacted text;
- nie przechowywać raw provider request/response, jeśli nie jest konieczny;
- provider IDs/usage są technicznym metadata;
- error logs nie mogą zawierać pełnego CV ani response body.

## 14. Prompt injection

Treść CV jest niezaufanym dokumentem, nigdy instrukcją.

W SC-005 kontrakt promptu musi:
- oddzielić system/developer instructions od CV data;
- jawnie oznaczyć CV jako quoted/untrusted data;
- nakazać ignorowanie poleceń znalezionych w CV;
- zakazać wykonywania URL, narzędzi, kodu, poleceń lub ujawniania system prompt;
- wyłączyć tools/web/function calling dla tej operacji, jeśli nie są wymagane;
- wymusić structured output tylko z dozwolonym schema;
- odrzucać dodatkowe pola i final hiring decision;
- ponownie walidować całe structured output po stronie serwera.

Cytat z CV zawierający prompt injection może być evidence tylko jako tekst źródłowy; nie wpływa na hierarchy instrukcji.

## 15. Ranking readiness dla SC-008

Schemat ma umożliwić ranking bez przebudowy:
- każda analiza jest przypięta do `recruitment_id` i `application_id`;
- każdy criterion result ma rating + numeric `rating_score`;
- snapshot kryteriów zachowuje kolejność i tekst;
- review overrides dają effective rating bez niszczenia AI;
- `overall_score` może być utrwalonym agregatem deterministycznym;
- current/stale jest jednoznaczne;
- reviewed/unreviewed jest jednoznaczne;
- `needs_reanalysis` można wykluczyć;
- historyczne wersje pozostają dostępne.

Rekomendacja dla SC-004/SC-008: scoring aggregate nie może traktować `insufficient_data` jako dowodu niespełnienia kryterium. Należy przechowywać co najmniej:
- `scored_criteria_count`;
- `insufficient_data_count`;
- `max_score_possible_for_scored`;
- wynik znormalizowany tylko według jawnie zamrożonego algorytmu `scoring_version`.

Jeśli algorytm rankingu nie jest jeszcze zaakceptowany, `overall_score` pozostawić nullable w SC-004 i oprzeć SC-008 na criterion rows + oddzielnym versioned ranking contract. Nie wymaga to zmiany schematu bazowego.

## 16. Retention i audit

Minimalne audit metadata:
- analysis: `created_by`, `created_at`, `processing_started_at`, `completed_at`, `failed_at`;
- freshness: `stale_at`, `stale_reason`, `superseded_by_analysis_id`;
- AI contract: `provider`, `model`, `model_revision`, `prompt_version`, `payload_schema_version`, `result_schema_version`, rekomendowane `analysis_contract_hash`;
- attempts: request/response IDs, token counts, cost/currency, timestamps, sanitized errors;
- review: reviewer_id, review_version, disposition, note, created_at;
- criterion: immutable AI output and immutable review overrides.

Nie hard-delete historycznych analiz pojedynczo przez zwykły CRUD. Retention/delete powinno dziedziczyć lifecycle danych kandydata/firmy i zostać wdrożone świadomie:
- usunięcie firmy/kandydata/application może kaskadowo usunąć zależne screening records zgodnie z polityką produktu i obowiązkami prawnymi;
- brak osobnego bezpośredniego DELETE dla recruiter/viewer;
- przyszła polityka retencji powinna być osobnym taskiem, jeśli ma zachowywać agregaty po usunięciu danych osobowych.

## 17. Widoki / read model — rekomendacja

SC-004 może dodać widoki `security_invoker`, jeśli uproszczą UI, ale nie są konieczne dla minimalnej migracji.

Rekomendowane read models:
- `latest_screening_analyses` — najwyższa completed analysis_version per application z freshness;
- `latest_screening_reviews` — najwyższa review_version per analysis;
- `effective_screening_criterion_results` — AI + latest human overrides.

Jeśli zostaną dodane, muszą być `security_invoker` i respektować RLS tabel źródłowych.

## 18. Open questions wymagające decyzji przed/na początku SC-004

1. Czy SC-004 ma utrwalać `analysis_contract_hash` jako osobną kolumnę — rekomendacja: **tak**.
2. Czy `overall_score` liczymy już w SC-004, czy dopiero SC-008 — rekomendacja: **nullable teraz, algorytm w SC-008**, chyba że scoring zostanie zamrożony wcześniej.
3. Czy stale wynik po zmianie inputu w trakcie provider call zapisujemy jako `completed + stale`, czy odrzucamy bez criterion rows — rekomendacja: **completed + stale**, ponieważ zachowuje audit, koszt i odpowiedź, ale wymaga bezwzględnego filtrowania current result.
4. Czy reviewer może poprawiać evidence, czy tylko rating/explanation — rekomendacja: **tak, może poprawić evidence**, ale wyłącznie względem tego samego redacted snapshotu.
5. Czy świadome „reanalyze same input” jest funkcją od SC-007 czy od razu w SC-004 — rekomendacja: schema wspiera od razu, UI może poczekać.
6. Retencja dokładnego redacted snapshotu: rekomendacja pozostawić go tak długo jak wynik, bo bez niego nie da się wiarygodnie audytować offsetów/cytatów.

## 19. Ryzyka

1. **Divergence fingerprint TS vs SQL** — fingerprint jest dziś liczony w TS. Nie implementować drugiego, subtelnie różnego kanonizera w SQL bez testów kontraktowych.
2. **Stale race** — input może zmienić się po dispatch, ale przed save; dlatego required recheck w transakcji complete.
3. **Duplicate workers** — bez lease + row lock dwa procesy mogłyby zakończyć ten sam attempt.
4. **Review overwrite** — bez version check dwóch reviewerów stworzyłoby last-write-wins.
5. **Evidence corruption** — offsety muszą być walidowane względem immutable snapshotu, nie aktualnego CV.
6. **PII leakage in logs** — nie logować raw payload/response.
7. **Raw provider output drift** — structured output musi być walidowane lokalnie; provider schema nie jest jedyną ochroną.
8. **Overtrust in confidence/score** — confidence nie jest prawdopodobieństwem jakości zatrudnienia; score nie jest decyzją.
9. **Ranking bias by missing data** — `insufficient_data` musi pozostać semantycznie inne niż `below`.
10. **Cascade deletes** — SC-004 musi jawnie sprawdzić zgodność nowych FK/cascade z istniejącą polityką usuwania kandydatów/rekrutacji.

## 20. Implementation plan for SC-004

SC-004 powinno być jedną migracją L3 i nie powinno integrować providera AI.

Kolejność:
1. Dodać typy/check constraints dla statusów/ratingów albo użyć CHECK text zgodnie z istniejącym stylem.
2. Utworzyć:
   - `screening_analysis_versions`;
   - `screening_analysis_attempts`;
   - `screening_criterion_results`;
   - `screening_result_reviews`;
   - `screening_criterion_review_overrides`.
3. Dodać złożone tenant-safe FK, unique constraints i indeksy.
4. Włączyć RLS na wszystkich tabelach.
5. Dodać SELECT policies dla owner/recruiter/viewer i brak write policies dla historii.
6. Ograniczyć grants; mutacje owner/recruiter tylko przez RPC.
7. Zaimplementować prywatne helpery autoryzacji/locking zgodnie z obecnym wzorcem.
8. Zaimplementować RPC:
   - `start_screening_analysis`;
   - `claim_screening_attempt`;
   - `complete_screening_analysis`;
   - `fail_screening_attempt`;
   - `retry_screening_analysis`;
   - `review_screening_result`;
   - opcjonalnie `refresh_screening_staleness`.
9. W RPC odtworzyć walidację bindingu i zapewnić recheck przed complete/review.
10. Dodać/rozszerzyć ręczny kontrakt `database.types.ts`, z `Insert/Update = never` dla immutable tables.
11. Dodać testy PGlite:
    - tenant isolation;
    - role owner/recruiter/viewer;
    - exact FK relations;
    - jedna aktywna próba;
    - idempotency duplicate click;
    - concurrent version allocation;
    - retry po failed;
    - stale przy zmianie application/recruitment/position/document;
    - reject save po zmianie inputu;
    - exact criterion count;
    - quote/offset validation;
    - immutable AI result;
    - review optimistic concurrency;
    - review override bez utraty AI;
    - viewer read-only;
    - anon denied.
12. Zaktualizować `docs/database.md` i `docs/screening.md` dopiero w SC-004 po implementacji.
13. Nie dodawać OpenAI API, UI rankingu ani shortlisty w SC-004.

## 21. Acceptance architecture checklist

- [x] wynik jest per application i recruitment;
- [x] wejście jest snapshotowane i audytowalne;
- [x] fingerprint zachowuje istniejący kontrakt;
- [x] model obsługuje stale;
- [x] model rozdziela logical version i provider attempts;
- [x] retry nie wymaga nowej wersji wyniku, jeśli input nie zmienił się;
- [x] świadome reanalysis może utworzyć nową analysis version;
- [x] AI result jest immutable;
- [x] human review jest immutable/versioned;
- [x] korekty człowieka nie niszczą oryginału AI;
- [x] evidence jest związane z immutable CV snapshot;
- [x] owner/recruiter/viewer mają zdefiniowany model uprawnień;
- [x] idempotency i concurrency są rozwiązane na poziomie DB transaction/constraints;
- [x] privacy używa allowlist;
- [x] prompt injection jest rozpoznane jako boundary bezpieczeństwa;
- [x] SC-008 może korzystać z modelu bez przebudowy podstawowych tabel;
- [x] audit zawiera provider/model/prompt/schema/usage/cost/timestamps.

---

## TASK
SC-003 — Model danych dla persistowanego wyniku preselekcji AI.

## ARCHITECTURE STATUS
PROPOSED — gotowe do review przed SC-004. Brak implementacji.

## PROPOSED TABLES
- `screening_analysis_versions`
- `screening_analysis_attempts`
- `screening_criterion_results`
- `screening_result_reviews`
- `screening_criterion_review_overrides`

## PROPOSED RPC
- `start_screening_analysis`
- `claim_screening_attempt`
- `complete_screening_analysis`
- `fail_screening_attempt`
- `retry_screening_analysis`
- `review_screening_result`
- opcjonalnie `refresh_screening_staleness`

## RLS MODEL
Owner i recruiter: SELECT + mutacje wyłącznie przez RPC. Viewer: SELECT only. Anon/outside tenant: brak dostępu. Wszystkie tabele z RLS i `company_id`; immutable history bez bezpośredniego write CRUD.

## VERSIONING MODEL
`analysis_version` jest monotoniczne per application. Attempty są wersjonowane osobno przez `attempt_no`. Human review ma własne `review_version`. AI result jest immutable. Reuse wymaga zgodnego input fingerprint i analysis contract.

## CONCURRENCY MODEL
Application-scoped lock przy tworzeniu wersji, unique constraints, jeden aktywny attempt, lease dla workera, idempotency key, recheck fingerprint przed save, optimistic concurrency dla review.

## PRIVACY MODEL
Do AI tylko `schema_version`, zatwierdzony `redacted_text` i allowlisted `criteria`. Bez nazwiska, emaila, telefonu, DB IDs, reviewer IDs, oryginalnego CV i niepotrzebnych danych. Brak raw provider request/response w bazie.

## OPEN QUESTIONS
- trwała kolumna `analysis_contract_hash` — rekomendowane tak;
- moment wprowadzenia `overall_score` — rekomendowane SC-008;
- zapis completed+stale przy zmianie inputu podczas provider call — rekomendowane tak;
- reviewer evidence override — rekomendowane tak;
- UI reanalysis same input — schema gotowa, UI później;
- polityka retencji redacted snapshot — zachować wraz z wynikiem do osobnego tasku retencyjnego.

## RISKS
Fingerprint divergence TS/SQL, stale race, duplicate workers, review race, błędne offsety evidence, PII w logach, provider schema drift, nadużycie confidence/score, błędne traktowanie insufficient_data, niezamierzone cascade deletes.

## IMPLEMENTATION PLAN FOR SC-004
Jedna nowa migracja: 5 tabel + constraints/FK/indexes + RLS/grants + RPC + typy kontraktowe + PGlite tests. Bez OpenAI, bez rankingu UI, bez merge do czasu review/testów.

## FILES CHANGED
Tylko `docs/sc-003-screening-result-architecture.md`.

## TESTS
SC-003 nie zmienia kodu ani DB. Wymagane jest review architektury; testy runtime nie są uruchamiane dla samego dokumentu. SC-004 ma dodać testy DB/RLS/concurrency opisane powyżej.

## NEXT ACTION
Review SC-003. Po akceptacji rozpocząć SC-004 według powyższego planu. Nie implementować SC-004 w ramach tego tasku.
