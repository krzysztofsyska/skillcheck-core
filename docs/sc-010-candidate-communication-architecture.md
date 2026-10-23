# SC-010 — Architektura komunikacji z kandydatem

## Kontrakt zadania
- TASK: SC-010; LEVEL: L3; SCOPE przyszłej implementacji: BACKEND.
- OWNER: Codex; REVIEWER: Codex, niezależny przegląd wymagany.
- STATUS: ARCHITECTURE_REVIEW — projekt, nie działająca komunikacja.
- DEPENDS ON: SC-008, wdrożone przez PR #66.
- BLOCKS: kontrakt dostawcy SC-011 i wykonanie rozmów SC-012.
- Baza audytu: integration 75fdc03d18f602b66534026c521cc07eb4794dcf.
- Zakres tej zmiany: dokument architektury i plan implementacji. Zero migracji,
  zmian produkcyjnych, sekretów, wysyłek, połączeń i opłat.
- SC-005 provider E2E nie blokuje projektu SC-010 ani testów syntetycznych.

## Audyt istniejącej bazy
Źródła: supabase/migrations/20260930000100_skillcheck_core.sql,
20261009081908_screening_ranking_shortlist.sql, lib/supabase/database.types.ts,
docs/sc-008-ranking-shortlist-architecture.md i Issue #11.
- candidates ma company_id, first_name, last_name, email, phone; dane kontaktowe
  są obecnie w public.candidates, dostępne zgodnie z istniejącym RLS firmy.
  Nie twierdzimy, że są już odseparowane w prywatnym magazynie tożsamości.
- applications łączy firmę, rekrutację i kandydata. Klucz złożony
  (company_id,recruitment_id,id) istnieje i powinien wiązać nowe rekordy.
- recruitment_shortlist_entries przechowuje decyzję człowieka, analysis_id,
  review_id, policy, historyczny wynik i informację o usunięciu.
- Role: właściciel w companies.owner_id, recruiter/viewer w company_members.
  private.has_company_access(company_id,true) sprawdza prawo zapisu.
- W audytowanym schemacie nie ma modelu zezwoleń komunikacyjnych, kolejki,
  prób kontaktu ani zdarzeń dostawcy. Worker screeningu nie obsługuje kontaktu.
- Nie zmieniamy statusu applications ani immutable wyników AI podczas kontaktu.

## Decyzje produktowe v1
1. Komunikacja dotyczy jednej aplikacji/rekrutacji, a nie globalnej bazy osób.
2. Kanały słownikowe: email, sms, voice. SC-010 definiuje kontrakty wszystkich;
   nie wybiera dostawcy i nie implementuje adaptera wysyłkowego.
3. Cel v1: verification_invitation. Marketing i talent pool poza zakresem.
4. Tylko aktualny, nieusunięty wpis ludzkiej shortlisty uprawnia do zatwierdzenia
   zaproszenia. Sama suggested_shortlist nigdy nie tworzy kontaktu.
5. Owner/recruiter zatwierdza konkretny kanał, odbiorcę, wersję szablonu i termin.
   Zapis shortlisty sam w sobie nie jest zezwoleniem na kontakt.
6. Odmowa/wycofanie, brak podstawy w polityce lub brak potwierdzonego kanału
   blokują wykonanie. Brak odpowiedzi nie oznacza zgody.
7. Zgoda na kontakt, zgoda na nagranie, zgoda talent pool i preferencje kanału
   są odrębnymi faktami. Nie wyprowadzamy ich z uploadu CV ani oceny AI.
8. Ten dokument projektuje techniczne egzekwowanie polityki, nie rozstrzyga
   prawnej podstawy kontaktu. Treści informacyjne, podstawa i okresy retencji
   wymagają ustalenia przed aktywacją; brak zatwierdzonej polityki blokuje wysyłkę.
9. Domyślna propozycja produktu: pn–pt 09:00–18:00, Europe/Warsaw, maksymalnie
   3 próby jednego zaproszenia łącznie ze wszystkimi kanałami, odstęp >=24h,
   wygaśnięcie po 7 dniach. To parametry wersjonowane, nie wymogi prawne.
   Kandydat może zawęzić okno; nieznana strefa wymaga potwierdzenia.
10. Brak automatycznego przełączenia kanału po niepowodzeniu. Nowy kanał wymaga
    właściwego zezwolenia i nowego zatwierdzenia człowieka w ramach tego samego
    limitu zaproszenia. Nie wdrażamy masowej kampanii ani autonomicznego retry voice.

## Proponowany model danych (nie wykonany DDL)
Wszystkie identyfikatory uuid; czasy timestamptz UTC; daty okien obliczane w IANA TZ.
Każda tabela ma company_id, id, created_at; relacje biznesowe mają złożone FK.
Nie ufamy company_id ani actor_id z klienta — serwer wyprowadza je z aplikacji i auth.

| Obiekt | Pola i odpowiedzialność |
|---|---|
| private.communication_policy_versions | Nieedytowalna wersja: cel, wymagane zezwolenia, kanały, TZ/okna, limit prób i kosztu, retry, retencja, zatwierdzający |
| private.candidate_contact_points | company_id,candidate_id,channel,encrypted_destination,destination_hmac,key_version,version,verified_at,disabled_at; oddzielny odczyt tylko dla dedykowanego workera |
| public.candidate_contact_permissions | company_id,candidate_id,recruitment_id nullable,purpose,channel,state,revision,policy_version,expires_at; projekcja bieżącego stanu |
| private.candidate_contact_permission_events | append-only grant/revoke/block/expire, zakres jak wyżej, revision, actor/source, evidence_ref, notice_version, occurred_at, received_at; bez pełnego dokumentu dowodu |
| public.candidate_contact_preferences | candidate_id,revision,timezone,weekday_windows,blocked_channels; stan company-local, bez przenoszenia zgód między firmami |
| public.candidate_communications | company_id,recruitment_id,application_id,shortlist_entry_id,purpose,state,version,expires_at,attempt_count; jedno logiczne zaproszenie i wspólny budżet |
| private.communication_dispatch_snapshots | communication_id,channel,contact_point_id/version,permission_revision,preference_revision,policy_version,template_version,template_parameters_hash,approved_by/at; niezmienne zatwierdzenie |
| public.candidate_communication_attempts | communication_id,attempt_no,state,next_attempt_at,lease_generation,lease_expires_at,provider_message_ref,safe_error_code; bez adresu, treści i tokenu lease |
| private.communication_attempt_capabilities | attempt_id,lease_token_hash,provider_idempotency_key; dostęp tylko dla mechanizmu workera |
| public.candidate_communication_events | communication_id,attempt_id nullable,event_type,source,occurred_at,received_at,safe_code,correlation_id; redagowany audyt |
| private.communication_provider_events | provider_account_id,provider_event_id,payload_hash,processed_at; deduplikacja callbacków, bez raw payload |

Wymagane ograniczenia:
- FK communications -> applications(company_id,recruitment_id,id), shortlist przez
  odpowiedni złożony klucz dodany nową migracją; sprawdzenie tej samej aplikacji.
- FK candidate_id do candidates(company_id,id); nie łączyć po samym UUID.
- unique (company_id,application_id,purpose) WHERE state IN
  ('draft','scheduled','dispatching','awaiting_response','needs_reconciliation').
  Zakończone zaproszenie nie pozwala automatycznie resetować limitów: nowa seria
  wymaga uprawnienia owner, uzasadnienia, okresu blokady i audytu wg polityki.
- unique (communication_id,attempt_no), max jedna aktywna próba na komunikację;
  unique (provider_account_id,provider_event_id).
- Idempotency osobno: (company_id,actor_id,operation,request_key) -> request_hash,
  result_id. Ta sama treść zwraca ten sam wynik; inna treść daje konflikt.
- Revisions rosną pod blokadą, nie według podatnego na wyścigi max(created_at).
- Zgody globalne firmy i rekrutacyjne: efektywne deny ma pierwszeństwo w każdym
  pasującym zakresie; grant rekrutacyjny nie znosi globalnego block/revoke.
- Indeksy: (company_id,recruitment_id,created_at,id), częściowy (next_attempt_at,id)
  dla eligible prób, unikalne klucze deduplikacji i FK indeksowane.
- Metadane publiczne mają RLS; private ma RLS jako dodatkową ochronę i REVOKE.
  Żadnych uprawnień komunikacyjnych dla screening_worker.

## Maszyna stanów i błędy
Komunikacja: draft -> scheduled -> dispatching -> awaiting_response ->
completed / declined / expired. Dodatkowe cancelled, blocked, needs_reconciliation.
completed oznacza ustalony wynik zaproszenia, nie zatrudnienie.
Próba: pending -> leased -> submitting -> accepted ->
delivered / failed_permanent / failed_retryable / unknown.
Provider accepted nie oznacza delivered; delivered nie oznacza odpowiedzi ani zgody.
Callback busy/no_answer w voice jest wynikiem próby, nie odrzuceniem kandydata.
Brak potwierdzenia po timeout wysyłki prowadzi do unknown/needs_reconciliation.
Bezpieczny retry dopiero po uzgodnieniu stanu z dostawcą. Exactly-once przez sieć
nie jest gwarantowane. Wymagamy provider idempotency i query-by-key w SC-011;
jeśli ich brak, unknown trafia do ręcznego rozstrzygnięcia, bez ponownej wysyłki.
Trwały bounce/invalid_destination blokuje punkt kontaktowy; 429 honoruje Retry-After,
ale zawsze mieści się w oknie, limicie i expires_at. Unknown też rezerwuje budżet.
Odwołanie aktywnego kontaktu jest best-effort po zaakceptowaniu przez dostawcę;
nie obiecujemy cofnięcia już wysłanego maila. Rejestrujemy moment linearyzacji.

## Kontrakty przyszłych RPC i adapterów
Poniżej podpisy logiczne do implementacji; żaden endpoint nie powstaje w tym PR.
- get_candidate_communications(target_application uuid,cursor jsonb,limit int=50):
  invoker, limit 1..100, kursor (created_at,id), metadane i safe_code bez PII.
- record_contact_permission(target_candidate uuid,target_recruitment uuid nullable,
  purpose text,channel text,event text,evidence_ref uuid,notice_version text,
  expected_revision bigint,request_key uuid): zapis faktu i audytu, uprawnienie
  firmy; grant wymaga dowodu i zgodnej polityki, recruiter nie może udawać kandydata.
- set_contact_preferences(target_candidate uuid,timezone text,windows jsonb,
  blocked_channels text[],expected_revision bigint,request_key uuid).
- prepare_candidate_communication(target_application uuid,target_shortlist uuid,
  channel text,contact_point uuid,template_version text,request_key uuid):
  tylko draft, bez rezerwowania dostawcy i bez wysyłki.
- approve_candidate_communication(target_id uuid,expected_version bigint,
  expected_permission_revision bigint,expected_contact_version bigint,
  expected_preference_revision bigint,requested_at timestamptz,request_key uuid):
  wylicza snapshot i najbliższy dozwolony termin na serwerze; scheduled.
- cancel_candidate_communication(target_id uuid,expected_version bigint,
  reason_code text,request_key uuid): idempotentny zapis; unieważnienie pending lease.
- private claim_contact_attempt(worker_id uuid,batch_size int<=10):
  ograniczona rola communication_worker, FOR UPDATE SKIP LOCKED; nie service_role.
- private authorize_contact_dispatch(attempt_id uuid,lease_token text,generation bigint):
  ponowna walidacja i atomowy zapis submitting, rezerwacja limitu/kosztu.
- private record_contact_outcome(attempt_id uuid,lease_token text,generation bigint,
  outcome enum,provider_message_ref text): walidacja lease i dozwolonej tranzycji.
- Callback SC-011: dedykowany serwer weryfikuje podpis, czas/replay, account binding,
  body-size <=64 KiB, dozwolone pola i provider ID; dopiero potem narrow DB RPC.
  Event dla innego konta/tenanta nie aktualizuje próby. Kolejność callbacków nie cofa
  stanu terminalnego; spóźnione delivered po unknown rozstrzyga historię, nie wznawia
  cancelled komunikacji.

Error contract: 401 brak sesji; 404 brak widocznego zasobu; 403 brak prawa zapisu;
409 nieaktualne wersje/konflikt; 422 polityka/dane; 429 limit; 503 wykonanie wyłączone.
Nie zwracamy SQL/raw provider errors, numerów telefonu ani e-maili w komunikacie błędu.

## Granica zaufania i współbieżność
Owner/recruiter zarządza faktami i zatwierdzeniami. Viewer czyta redagowaną historię.
Anon nie ma SELECT ani EXECUTE. Przyszły link kandydata: losowy >=256-bit token,
hash w DB, cel/tenant/application/expiry, single-use, rate limit; żadne ogólne RPC
anon. Publiczne tokeny i handler wdraża osobny task po review, nie SC-010 baza.
SECURITY DEFINER tylko gdy niezbędne: search_path='', jawny auth.uid/access check,
REVOKE PUBLIC/anon, minimalne granty. Mutacje tabel wyłącznie przez RPC.

Przyszły approval/dispatch musi stosować blokady SC-008: źródło analizy ->
application -> recruitment -> position -> document, z NOWAIT i kontrolowanym 409.
Nie ustanawiamy konkurencyjnej blokującej kolejności recruitment -> application.
W B1 wszystkie mutacje serializuje candidate FOR UPDATE NOWAIT po sprawdzeniu
autoryzacji, a komunikacja jest blokowana dopiero po kandydacie. B1 nie wykonuje
approval/claim; draft jest tylko zapisem intencji, nigdy autoryzacją kontaktu.
Przed B2 należy przetestować rzeczywiste wyścigi z SC-006 advisory lock oraz
SC-008; wszystkich blokad innych modułów nie zastępuje blokada kandydata.
Sprawdzenia: firma i rola aktora nadal aktualne, recruitment=open,
application in(new,in_progress), istniejąca aktualna shortlista, zgody/preferencje,
kontakt/template/policy niezmienione, koszt/próby/okno/expiry, feature flag.
Nie polegamy na samej fladze ani wcześniejszym UI precheck.
Odwołanie zgody zwiększa revision, anuluje niewysłane zaproszenia i unieważnia lease
w jednej transakcji. Świeżość SC-008 odczytywana pod blokadami także źródła analizy,
review, CV i stanowiska zgodnymi z SC-008; implementacja musi wykazać testem
brak TOCTOU. Bez pełnej zgodności wersji wynik to 409/blocked, nie wysyłka.
Zmiana adresu/telefonu tworzy nową wersję punktu i unieważnia approval;
nie przekierowujemy starego zatwierdzenia na nowy adres.

Sieciowy side effect następuje poza transakcją DB. authorize_dispatch jest
punktem linearyzacji: revoke zatwierdzone wcześniej blokuje dispatch; revoke później
zatrzymuje następne próby i inicjuje anulowanie u dostawcy, jeżeli wspierane.
Awaria po authorize przed odpowiedzią dostawcy wymaga uzgodnienia po stałym
provider_idempotency_key. Wygasły lease nie pozwala staremu workerowi zapisać wyniku.
Zweryfikowany callback może uzgodnić dostawę niezależnie od starego lease.

## Okna, limity, prywatność
Najbliższy termin = pierwszy moment w przecięciu polityki firmy i preferencji
kandydata po requested_at, backoff i Retry-After, przed expires_at.
UTC służy do storage, IANA TZ do kalendarza; nieistniejący czas DST przesuwamy
do pierwszego dozwolonego momentu, powtórzony czas wybieramy późniejszy.
Rewalidacja w authorize, nie tylko podczas planowania. Otwarte godziny 09:00
włącznie, 18:00 wyłącznie; brak przecięcia -> blocked/no_contact_window.
Budżety atomowo company/day + invitation; klucze dni wg TZ polityki. Nieznany koszt
rezerwuje maksimum kontraktu; przekroczenie blokuje nowe próby.
Odbiorca i minimalne template variables trafiają tylko do adaptera danego kanału.
Nie wysyłamy CV, score, rankingów ani cytatów dostawcy komunikacji.
W logach: correlation_id i safe_code; żadnych tokenów, wiadomości, kontaktów.
PII encrypted envelope key poza DB; HMAC dla deduplikacji, nie zwykły hash telefonu.
Istniejące candidates.email/phone pozostają znanym źródłem PII, bez automatycznego
kopiowania i bez poszerzania ich grantów. Import do contact_points wymaga jawnej
weryfikacji źródła; nie jest dowodem zgody.
Retencja osobno dla PII, zdarzeń i dowodów; usuwanie poprzez autoryzowany proces
redakcji pozostawia minimalny nieidentyfikujący audit. Append-only nie oznacza
przechowywania PII bezterminowo. Hard-delete rodzica nie może kaskadowo kasować audytu:
nowe FK restrict plus jawna procedura purge/redakcji do przygotowania przed aktywacją.
Nagrania/transkrypcje należą do SC-012/013; recording_permission sprawdzane osobno.

## Plan implementacji i odbioru
A. SC-010 (ten PR): przegląd architektury, decyzje parametrów produktu, owner acceptance.
B1. Podstawa offline: nowa migracja wygenerowana CLI, typy, RLS/RPC,
   pure policy/state functions i testy; COMMUNICATION_ENABLED=false oraz
   COMMUNICATION_DELIVERY_ENABLED=false. Brak adapterów sieciowych; próba execution
   zwraca disabled, a nie fikcyjne delivered. Nie nadajemy production grants workerowi
   zanim powstanie jego zatwierdzony kontrakt i konfiguracja.
C. SC-011: provider, idempotency/reconciliation, webhook signature, limity/koszty,
   przetwarzanie danych, konfiguracja i synthetic-only smoke plan.
D. SC-012: adapter, kanał candidate-facing i voice zgodnie z SC-011.
Każdy etap osobny branch/PR -> integration. Produkcja wyłącznie osobna promocja.
Nie stosować blanket db push: SC-007/006/008 mają inne timestampy w zdalnej historii.
Rollback bazy: forward fix; nie kasować audytu i nie odtwarzać wykonanych migracji.

## Macierz obowiązkowych testów przyszłej implementacji
| Obszar | Dowód odbioru |
|---|---|
| Tenant/RLS | owner i recruiter zapis; viewer read-only; anon/outsider deny; użytkownik dwóch firm nie przepina FK |
| Zezwolenia | missing/expired/revoked/block deny; brak zgody na nagranie nie uruchamia nagrywania; grant jednego celu nie otwiera drugiego |
| Shortlista | suggested bez human entry deny; removed/stale/review changed deny; NULL score sam nie blokuje prawidłowej manual shortlist |
| Idempotency | identyczny request zwraca ten sam id; zmieniony payload 409; dwa approval tworzą jedną serię |
| Wyścigi PG | revoke vs authorize; zmiana CV/review/phone vs authorize; cancel vs claim; dwa claim; dwa finalizers; budżet przy dwóch procesach |
| Dostawca | timeout po przyjęciu -> unknown bez duplikatu; query-by-key; replay/wrong account/late webhook; podpis i limity payload |
| Lease | stary token i generation nie finalizują po odzyskaniu; callback ma własny zaufany kontrakt |
| Czas | DST obie zmiany, weekend, 18:00, Retry-After poza oknem, brak TZ, expiry i zmiana preferencji po approval |
| Prywatność | odczyt/logi bez PII/tokenu/raw payload; template allowlist; retention/redaction nie omija tenant |
| Produkt | brak automatycznej decyzji hire/reject, kontaktu po shortlist insert ani failover kanału; disabled jest jawne |

Testy DB: PGlite dla RLS/kontraktów, PostgreSQL z niezależnymi połączeniami dla wyścigów.
Fixture wyłącznie fikcyjne; adapter mock nie wysyła wiadomości. Typecheck/build oraz
regresje SC-006/008/009 wymagane przy implementacji. Review dokumentu nie jest PASS
tych przyszłych testów ani dowodem wdrożonego SC-010.

## Handoff i następny krok
TASK: SC-010; STATUS: ARCHITECTURE_REVIEW; DB/MIGRATIONS: NONE.
Do przeglądu: model uprawnień i dowodów, FK/audyt przy usuwaniu kandydata,
lock order zgodny z SC-008, revoke/dispatch boundary, provider unknown i limity.
Decyzje przed aktywacją: zatwierdzona polityka i treści informacyjne, retencja,
weryfikacja adresu/telefonu, provider i budżet. Domyślne parametry powyżej są propozycją.

Prompt następnego kroku — Codex, kontynuacja w skillcheck-core:
„Wykonaj niezależny review SC-010 w docs/sc-010-candidate-communication-architecture.md
i Issue #11. Porównaj FK, role, shortlist freshness i lock order z integration.
Sprawdź revoke vs dispatch, duplikaty po timeout, audyt i redakcję PII, DST i budżety.
Nie implementuj, nie twórz migracji, nie zmieniaj produkcji i nie kontaktuj kandydatów.
Raportuj PASS/PASS WITH FIXES/FAIL z konkretnymi poprawkami i kryteriami testów.
Po PASS przygotuj task backend foundation B do akceptacji architektury.”


## Doprecyzowanie po niezależnym review — zakres B1
Właściciel 2026-10-09 polecił wykonać przegląd i przygotowanie podstawy backendu.
B1 implementuje: zapis niezweryfikowanego zgłoszenia zgody (unverified), revoked,
blocked; preferencje zapisane przez rekrutera; draft/cancel/read komunikacji;
redagowany audyt i idempotency. Nie implementuje pełnego przyszłego modelu powyżej.

- evidence_ref to metadane zgłoszenia, nie dowód zweryfikowany. Recruiter nie może
  nadać effective grant ani podszyć się pod potwierdzenie kandydata. Actor i source
  pochodzą z serwera. Stan granted nie istnieje w B1. Kolejny unverified nie usuwa
  już zapisanego revoked/blocked; ponowna zgoda wymaga przyszłego zaufanego procesu.
- B1 nie zapisuje kontaktów/adresów, treści wiadomości, nagrań, tokenów ani
  provider payload. Używa bezpiecznych enumów i UUID. Brak nowych kluczy szyfrujących.
- Każdy wpis draft wiąże jawny human shortlist entry. Ocena świeżości przy tworzeniu
  jest kontrolą jakości szkicu, a nie gwarancją aktualności w momencie późniejszego
  kontaktu. Zmiany SC-008 nie powodują samoczynnej wysyłki ani reautoryzacji.
- Dane publiczne mają read-only RLS dla członków firmy; private idempotency/audit
  nie mają dostępu authenticated/anon/worker. Mutacje wyłącznie przez wąskie RPC.
- Revoke/block w pasującym zakresie anuluje drafty w tej samej transakcji.
  Preferencje mogą zawężać okna, ale nie znoszą odmowy.
- Próba aktywacji delivery jest niedostępna strukturalnie: brak API approve,
  worker/claim/attempt i adaptera, niezależnie od wartości flag środowiskowych.
- Nowe FK restrict zatrzymują dotychczasowe usunięcie rodzica z historią SC010.
  Jest to jawna zmiana zachowania: rollback transakcji usuwania, bez częściowego
  usunięcia danych; UI i procedura redakcji/purge wymagane przed produkcyjną
  aktywacją B1. Nie wolno przedstawiać istniejącego delete jako nadal bezwarunkowego.
- B2 musi dostarczyć rejestr zweryfikowanych dowodów i wersji informacji (tenant,
  kandydat, zakres, czas, hash treści, verifier), weryfikację kanału i punktu
  kontaktowego, politykę/template approval oraz API authorize/worker. Podpisy
  approval muszą wiązać wersje obu zakresów zgody (global/recruitment), nie jeden
  niejednoznaczny permission_revision.
- SC011/012 dostarcza delivery/attempt/webhook, provider reconciliation, limity
  kosztów i kompletne okna czasu. B1 nie zgłasza tych testów jako wykonanych.

Odbiór B1: tenant/role/immutable audit, serializacja revision i idempotency,
nieosiągalność granted/scheduled/dispatch, revoke vs draft/cancel, current human
shortlist gate, brak nowych danych kontaktowych i regresje SC006/008/009.
Przegląd architektury pełnego B2 pozostaje warunkiem następnej fazy, a nie
ukrytym założeniem ukończenia B1.
