# SC-010-R — retencja i kontrolowane usuwanie danych

Data: 2026-10-10, Europe/Warsaw.
TASK: SC-010-R (roboczy podetap zadania #11, projekt architektury).
LEVEL: L3. SCOPE: OPERATIONS (wyłącznie dokumentacja; przyszła implementacja FULLSTACK).
OWNER: ChatGPT/Codex orchestrator. REVIEWER: niezależny Codex.
DEPENDS ON: SC-010 B1/B2, SC-006/008/009; kontrakty SC-011/012.
STATUS: PROPOSED — bez migracji, operacji usuwania i wdrożenia.
Baza odczytu: integration `55b5b45ae5ac3a31cc01438c057e489ca99c8df1`.

## 1. Cel i decyzja

Zapewnić kontrolowane usuwanie danych kandydata w jednej firmie oraz wygaśnięcie
zbędnej historii kontaktu, bez możliwości odtworzenia zgody przez replay lub backup.
Nie nazywamy usunięcia e-maila anonimizacją całej osoby: CV, dowody, notatki,
identyfikatory, HMAC i kombinacje cech nadal mogą pozwalać na powiązanie danych.
Domyślny wynik pełnego żądania to usunięcie danych operacyjnych i ich kopii zależnych,
a nie pozostawienie pseudonimizowanego profilu pod nazwą „anonimowy”.

Oddzielamy: cofnięcie zgody (B1), ograniczenie dostępu, usunięcie aktywnych danych,
wygaśnięcie kopii zapasowych oraz ewentualne agregaty anonimowe. Żadne z tych działań
nie jest automatycznie równoważne pozostałym. Projekt nie ustala podstaw prawnych
ani uniwersalnych ustawowych terminów. Właściciel danych zatwierdza wersjonowaną
politykę przed aktywacją automatycznej retencji.

Nie zajmujemy numeru SC-010-C: dokument SC-011-A rezerwuje go dla przyszłego dispatch.
SC-010-R nie uruchamia telefonii, AI, wiadomości, nagrywania ani rozliczeń.

## 2. Stan zastany i granice dowodów

Odczytano kod integration, nie wykonano audytu bieżącej bazy produkcyjnej.

| Obszar | Dowód w repozytorium | Konsekwencja |
|---|---|---|
| B1 | migracja 20261009105025; `private.contact_immutable`, restrictive FK | Zwykły DELETE historii jest odrzucany, także podczas kaskad |
| B2 | migracja 20261009141836; approvals, receipts, contact points | Zaszyfrowany kontakt i dowody są niezmienne; approvals blokują usunięcie shortlist/review/analysis |
| Idempotencja | `private.contact_requests.payload` JSON, result_id | Brak FK do kandydata nie oznacza braku jego danych; JSON zawiera identyfikatory i kontekst |
| Usuwanie rodziców | `lib/supabase/skillcheck.ts` remove dla candidates/applications/recruitments/positions | Ścieżki bezpośredniego DELETE wymagają zastąpienia lub jawnej blokady |
| Screening | `screening_analysis_versions`, criteria, reviews, overrides, attempts | Snapshot CV, evidence, review_note, failure/provider IDs są częścią inwentaryzacji |
| SC-008/009 | shortlist snapshots oraz raporty/CSV | Wyników i eksportów nie wolno uznać za anonimowe tylko przez usunięcie nazwiska |
| SC-011-A/012-A | dokumenty i lib/voice na tej bazie | Kontrakty offline; brak dowodu istnienia produkcyjnych nagrań czy trwałej bazy planów |

Przed implementacją należy ponownie sprawdzić integration i otwarte PR-y SC-012-B/013.
Każda nowa trwała tabela, obiekt Storage lub dostawca z danymi kandydata musi mieć
adapter usuwania. Nieznana zależność blokuje wykonanie, nie jest pomijana.

## 3. Inwentaryzacja i retencja

| Klasa | Zawartość | Reguła projektowa |
|---|---|---|
| Dane kandydata | candidates, candidate_documents: source_text, redacted_text; e-mail/telefon | Pełne usunięcie po zatwierdzonym żądaniu, dla jednej firmy |
| Proces rekrutacji | applications, candidate_assessments, behavior_assessment_entries, exercise_observation_entries | Wszystkie procesy tej osoby w firmie objęte pełnym żądaniem; wspólne definicje stanowisk/zadań pozostają |
| Screening/shortlista | analizy, próby, wyniki kryteriów, review, overrides, shortlist | Usunięcie zależności w kolejności FK; także kopii treści i identyfikatorów dostawcy |
| B1/B2 | permissions, preferences, communications, events, approvals, private audit/requests, receipts/points | Usunięcie payloadów i powiązań osoby; pozostawienie tylko minimalnego potwierdzenia operacji |
| Konfiguracja firmy | issuer/policy registry, ranking policies, wspólne templates | Nie usuwać podczas żądania jednej osoby; zamknięcie firmy wymaga osobnego zakresu |
| Zewnętrzne kopie | Storage, provider, cache, log drains, generowane raporty | Wykryć rzeczywistą obecność; potwierdzić wykonanie albo jawnie oznaczyć oczekiwanie/blokadę |
| Backup i eksport ręczny | backup/PITR/WAL, pobrany CSV/PDF | Osobny cykl i komunikat; brak deklaracji natychmiastowego usunięcia wszystkich kopii |

Proponowany schemat polityki: tenant, immutable policy_version, data_class,
trigger_event, duration, approved_by/at, effective_from, hold_review_interval.
Każda duration musi być zatwierdzona i skończona; brak konfiguracji blokuje aktywację
harmonogramu i gotowość produkcyjną, wywołując alert. Nie oznacza retencji bez końca.
Dowód B2 może być ważny najwyżej 15 minut, ale nie jest to automatycznie termin jego
usunięcia. Replay ledger przechowuje minimalne nonce/receipt IDs do końca maksymalnej
ważności dowodów i przyjętego marginesu czasu. Stare payloady nie są do tego potrzebne.
Terminy CV po zakończeniu procesu, audytu, eksportów, backup i logów pozostają
konkretnymi decyzjami przed aktywacją, nie ukrytymi domyślnymi wartościami w kodzie.

## 4. Model żądania i uprawnienia

Projektowane obiekty (nazwy robocze, nie istniejące API):

- private.erasure_requests: tenant, opaque request ID, candidate reference nullable,
  scope, reason enum, expected revision, policy version, manifest hash, status,
  authorizer, timestamps. Bez e-maila, nazwiska, CV i dowolnej treści uzasadnienia.
- private.erasure_items: zamknięta lista adapterów i kluczy zasobów, faza, lease,
  attempt count, bezpieczny error code. Wrażliwy manifest dostępny tylko executorowi;
  klucze usuwa się po wykonaniu i zakończeniu wymaganej obsługi odtworzeń.
- private.erasure_holds: zakres, reason enum, authorized_by, review_at, expires_at;
  brak przełącznika wiecznego legal hold i brak arbitralnej decyzji workera.
- private.erasure_receipts: tenant, losowy receipt ID, policy_version, zakończona faza,
  rounded timestamps, liczby klas usuniętych danych; bez candidate ID, payloadu,
  contact digest, dawnego request key, ścieżek Storage ani identyfikatorów provider.
  To minimalny audyt administracyjny, nie gwarancja anonimowości całej metryki.
- private.erasure_restore_ledger: oddzielny, ograniczony dostęp do tenant+starych UUID,
  koniecznych do ponownego usunięcia po restore. Dane nadal pseudonimowe, z własnym
  TTL obejmującym najdłuższy zatwierdzony okres kopii; nie udostępniać w raporcie.

Owner firmy zatwierdza pełne usunięcie. Recruiter może zgłosić; viewer tylko odczyt
bezpiecznego statusu uprawnionego procesu. Operator platformy nie otrzymuje przez
to dostępu do danych wszystkich firm. Tenant i actor wyznacza serwer/session.
Zwykłe role, contact_verifier i screening_worker nie mogą wykonać purge ani
modyfikować manifestu/hold. Rozdzielamy dwie role bez BYPASSRLS: erasure_worker ma wyłącznie EXECUTE purge
i bezpiecznych lease/status RPC, bez DML do tabel/kontekstu; erasure_purge_owner
jest NOLOGIN właścicielem funkcji z minimalnymi DML. Worker ani żadna rola aplikacji
nie może SET ROLE erasure_purge_owner ani dziedziczyć jego uprawnień. Membership
worker nie trafia do authenticated/authenticator. Przypisanie połączenia runtime
do worker i sekretów jest osobnym zatwierdzonym wdrożeniem. Publicznie tylko wąskie
RPC z autoryzacją.

Kontrakty: preview_candidate_erasure(candidate, scope) zwraca counts/blockers,
manifest hash i expected revision; request_candidate_erasure(candidate, scope,
expected_revision, manifest_hash, request_key) zatwierdza konkretny zakres;
get_erasure_status(request_id) zwraca fazy i bezpieczne kody. Recruiter używa
oddzielnego submit_erasure_request(candidate, reason_enum), które tylko zgłasza
żądanie; request_candidate_erasure wymaga owner i jest punktem autoryzacji.
Preview ma skończony TTL.
Zmiana zakresu lub roli wymaga nowego preview/akceptacji. Idempotencja per tenant,
actor i operation; ten sam klucz z inną treścią = konflikt. Globalne usunięcie osoby
w innych firmach nie jest funkcją tego RPC. Nie usuwa konta auth.users.

## 5. Przebieg i wyścigi

1. Preview analizuje FK, jawne powiązania JSON i adaptery; niczego nie usuwa.
2. Zatwierdzenie blokuje candidate NOWAIT, autoryzację owner i manifest. Zapisuje
   pending erasure i monotoniczną erasure_generation. Atomowo anuluje drafty.
   Przed pierwszym usunięciem zapisuje też tenant, UUID, generation i request ID
   do niezależnego trwałego restore ledger. Dopiero potwierdzony zapis i watermark
   pozwalają rozpocząć erasing; brak ACK => blocked. Retry tego zapisu jest idempotentny.
3. Od tego commit kandydat jest ukryty w zwykłych listach i raportach. Wszystkie
   zapisy potomków, claim/finalize workera, upload, receipt ingestion i approval
   sprawdzają status/generation pod blokadą. Nie wystarcza schowanie przycisku.
4. Worker zamraża manifest. Nieznany adapter, hold, aktywny lease AI/provider lub
   obca wersja schematu => blocked; nie ma fałszywego DONE. Wykonujący się request
   zewnętrzny wymaga reconciliation i ponownego usunięcia późnego wyniku.
5. Przed pierwszą nieodwracalną operacją utrwala erasing pod blokadą request/hold;
   zmiana hold używa tego samego protokołu. Hold zatwierdzony wcześniej blokuje
   start, a późniejszy nie cofa już wykonanych operacji i wymaga eskalacji.
   Usuwa zasoby zewnętrzne przez ich API, z bezpieczną idempotencją, po zakończeniu
   lokalnych transakcji. W DB zapisuje potwierdzenia etapów. Awaria => retry_pending
   z limitami prób i alertem; kandydat nadal niedostępny. Brak automatycznego restore.
6. DB purge usuwa zamknięty graf w jednej transakcji; nie trzyma blokad podczas
   sieci. Rewaliduje lease/generation/manifest/hold/politykę. Po commit status
   active_data_erased; backup_pending jest widocznym osobnym wymiarem.
7. Zakończenie cyklu kopii wymaga potwierdzenia restore-ledger i retencji operatora.
   Status completed oznacza tylko zadeklarowany zakres, bez obietnicy zdalnego
   skasowania plików wcześniej pobranych przez użytkownika.

Stany: requested -> authorized -> erasing -> active_data_erased -> completed;
blocked i retry_pending mają powód i fazę wznowienia. Cancel dopuszczalny wyłącznie
przed pierwszą nieodwracalną operacją; po usuwaniu tylko dokończenie lub eskalacja.
Nowy import nie może odtworzyć dawnych UUID ani zgód. Stare webhooki i tokeny
nie tworzą brakującego kandydata; nie zakładamy wykrywania tej samej osoby wyłącznie
po innym UUID. Nowa osoba/proces wymaga nowej zgody, nie odziedziczonego grant.

## 6. Niezmienność a autoryzowane usunięcie

Nie wyłączamy globalnie triggerów, RLS ani FK, nie używamy session_replication_role
ani ustawianego przez klienta GUC jako obejścia niezmienności. Nowa migracja będzie
modyfikować kontrakt triggera wyłącznie dla DELETE w ograniczonym executorze.
UPDATE historii nadal zawsze odrzucony. B1/B2 applied migrations bez zmian.

Rekomendowany mechanizm: prywatna SECURITY DEFINER funkcja purge, należąca do
oddzielnej roli erasure_purge_owner z minimalnymi grantami. Trigger SECURITY INVOKER
sprawdza current_user = erasure_purge_owner oraz aktywny wiersz kontekstu (request, tenant,
manifest, txid) zapisany wyłącznie przez purge i zablokowany w tej transakcji.
Każdy OLD row musi należeć do zatwierdzonego manifestu. RPC owner nie wykonuje
DELETE samodzielnie. Żadna rola aplikacyjna ani runtime erasure_worker nie ma membership purge_owner
ani prawa zapisu kontekstu; worker ma tylko EXECUTE wąskiej funkcji purge. Funkcja ma pusty search_path, stałe SQL, jawne grant/revoke;
PUBLIC/anon/authenticated/verifier/AI worker nie mają EXECUTE. RLS purge_owner
pozwala jedynie na wiersze aktywnego kontekstu; testy rzeczywistego SET ROLE i
SECURITY DEFINER muszą dowieść zachowania, nie polegamy na nazwie roli w JWT.
DB superuser pozostaje granicą administracyjną, nie użytkownikiem produktu.

Kolejność SC-010: approvals -> communication events -> communications -> receipts
-> contact points -> permissions/preferences -> contact_audit/contact_requests;
potem shortlist -> screening overrides/reviews/results/attempts/analyses ->
observations/assessments -> applications/documents -> candidate. Ostateczna lista
jest wyprowadzana z pełnego pg_catalog grafu i jawnych adapterów, nie z tej skróconej
listy. Rozpoznane kaskady muszą być przetestowane na kompletnym łańcuchu migracji.

contact_requests wymaga migracji backfill do jawnej relacji request-subject dla
każdej znanej operation (permission/preferences/draft/cancel/approve). Nie stosować
wyszukiwania UUID jako podciągu JSON. Zmapować payload i result przed usunięciem
rodziców; nieznana operation => blocked. Wspólny rekord wieloosobowy wymaga osobnego
adaptera redakcji lub podziału, nigdy DELETE danych innych kandydatów.

Usuwanie recruitment/application/position/company ma osobny preview zakresu.
Nie wolno automatycznie usuwać wszystkich danych osoby przy usuwaniu jednej
aplikacji ani usuwać osoby w innej firmie. Do wdrożenia właściwych adapterów takie
operacje z zależnościami otrzymują czytelny blocker. Revoke direct DELETE grant lub
wymuszający trigger musi zamknąć również API, a nie tylko interfejs aplikacji.

## 7. UI i ochrona odczytów

Przycisk „Usuń dane kandydata” pokazuje wszystkie rekrutacje w firmie, klasy danych,
blokady i osobne terminy kopii. Owner potwierdza preview o konkretnym hash/revision.
Nie zbieramy potwierdzenia przez ponowne wpisywanie e-maila/PII. Widoki list, detail,
SC-009 CSV/print, RPC i cache respektują erasure flag; RLS/funkcje odmawiają także
bezpośredniego odczytu historycznych wierszy po rozpoczęciu. Status dostępny przez
oddzielny bezpieczny endpoint; brak CV/destination w błędach/logach.

Komunikaty: „Usuwanie w toku”, „Usunięto dane aktywne; kopie oczekują na wygaśnięcie”,
„Wymagana interwencja: [bezpieczny powód]”. Nie pokazujemy „Usunięto wszystko” dla
partial failure. Pobrane wcześniej pliki nie podlegają zdalnemu unieważnieniu;
obsługa klienta otrzymuje instrukcję dotyczącą takich kopii.

## 8. Backup, Storage, dostawcy i klucze

Database backup nie obejmuje binarnych obiektów Storage; należy obsłużyć oba
zasoby. Storage usuwa się przez Storage API, nie SQL DELETE jego metadanych.
Nie założono konkretnego planu Supabase ani obecności bucketów w tym audycie.

Restore odbywa się w izolacji, z wyłączonym dostępem produktu i workerami. Przed
ponownym otwarciem odtwarza się ledger z niezależnej, kontrolowanej kopii i ponawia
usunięcia nowsze od backup. Brak/niezgodność ledger => blokada uruchomienia.
Nie wystarczy dowolna istniejąca kopia ledger: odtworzenie musi potwierdzić ciągłość
i watermark co najmniej do ostatniej autoryzowanej generacji na niezależnym trwałym
rejestrze, nie z backupu produktu. Niepełna/starsza kopia lub brak dowodu coverage
blokuje start. ACK ledger poprzedza każdy nieodwracalny krok; brak takiej kolejności
uniemożliwia gotowość produkcyjną. Ledger też ma retencję, kontrolę dostępu,
szyfrowanie i okresowe ćwiczenie restore.
PITR, WAL, repliki, log drains i eksporty ręczne są częścią runbooka; nie obiecujemy
selektywnego natychmiastowego usunięcia pojedynczego wiersza z każdej kopii.

Obecny wspólny klucz AES B2 nie pozwala na zniszczenie klucza jednej osoby bez
wpływu na innych. Nie niszczymy klucza tenant/global jako metody purge. Fizyczne
usunięcie rekordów jest pierwszym mechanizmem; per-subject envelope encryption
może być osobnym projektem. HMAC, receipt_json i manifest też podlegają retencji.
Nowi dostawcy muszą mieć delete/reconcile/status adapter, politykę kopii i logów;
brak potwierdzenia uniemożliwia deklarację completed dla ich danych.

Źródła techniczne sprawdzone 2026-10-10:
- https://supabase.com/docs/guides/platform/backups
- https://supabase.com/docs/guides/storage/management/delete-objects

## 9. Etapy wdrożenia i odbiór

R1: mapa danych/FK/JSON i wersjonowane polityki + preview bez wykonywania.
R2: lifecycle/generation, blokady zapisu i odczytu, owner authorization oraz UI.
R3: kontrolowany executor purge, adaptery, minimalny audyt i restore ledger.
R4: automatyczna retencja z zatwierdzoną polityką, monitoring i próba restore.
Wszystkie etapy na osobnych branchach z aktualnego integration, L3 review.
Żaden etap nie włącza dispatch. Produkcja dopiero po pełnym R1–R4 i osobnej zgodzie.

Wymagane kontrole implementacji:
1. Owner/recruiter/viewer/anon/worker/verifier, obca firma i bezpośrednie DML/RPC;
   zmiana właściciela między preview a zatwierdzeniem.
2. Pełny graf dwóch firm, wielu aplikacji i kandydatów; inne osoby nietknięte;
   stare UUID w JSON oraz payloadach wyników nie pozostają po purge.
3. Trigger immutable blokuje każdy zwykły UPDATE/DELETE, fałszywy GUC, context,
   membership i inny txid; tylko dokładny manifest może zostać usunięty.
4. PG multisession: request vs ingest/approve/revoke/upload/review/AI finalize,
   zmiana hold i polityki, dwóch executorów, crash/retry/lease expiry.
5. Błąd sieci po usunięciu zasobu, restart przed lokalnym potwierdzeniem, późny
   callback; brak ponownego ujawnienia danych i brak fałszywego completed.
6. Restore z backup sprzed purge: replay ledger przed odblokowaniem dostępu;
   crash przed/po ACK, stary ledger i brak watermark/ciągłości blokują start;
   brak ledger blokuje start; TTL ledger obejmuje najstarszą możliwą kopię.
7. RLS i SC-009 list/CSV/print nie ujawniają danych pending erasure; cache oraz
   wszystkie server actions respektują status; status endpoint zachowuje tenant.
8. Polityka nieaktywna, brak terminu, hold expired, nieznana tabela/operation,
   próba usunięcia application zamiast całego candidate: bezpieczna blokada.
9. typecheck/build, pełne testy B1/B2, SC-006/008/009 i dostępnych SC-011/012.
10. Po migracji katalog FK/grants/policies/triggers zgodny z manifestem; brak
    sekretów, parametrów SQL z PII i regresji istniejących applied migrations.

## 10. Handoff i następny prompt

CHANGED FILES: tylko ten dokument. DB/MIGRATIONS: brak.
TESTS: review dokumentu i referencji, nie test działania nieistniejącego purge.
SECURITY CHECKS: tenant scope, jawna capability, deny/replay, niezmienność,
pełny graf danych, minimalizacja audytu, backup i częściowe awarie.
KNOWN ISSUES/BLOCKERS: brak zatwierdzonych okresów; aktualizacja mapy o nowe PR;
brak zaimplementowanego purge/restore/UI. Nie deklarujemy usunięcia blokady produkcji.
NEXT ACTION: niezależny review architektury; po PASS akceptacja, potem R1.

Wykonawca: Codex, ta sama rozmowa, repo krzysztofsyska/skillcheck-core.
> SC-010-R: sprawdź review i aktualny integration oraz równoległe PR SC-012/013.
> Po akceptacji architektury przygotuj R1: kompletny manifest danych/FK/JSON,
> wersjonowane polityki i preview usunięcia. Najpierw ustal dozwolone pliki i
> kontrakt w Issue #11. Bez faktycznego usuwania, migracji na produkcji, ustawiania
> prawnych terminów za właściciela i kontaktu z kandydatami. Kryteria: pełny graf,
> tenant-safe counts/blockers, nieznane zależności fail-closed, testy ról i rewizji.
> Raport: TASK, STATUS, BRANCH, COMMIT, CHANGED FILES, DB/MIGRATIONS, TESTS,
> SECURITY CHECKS, KNOWN ISSUES, BLOCKERS, NEXT ACTION. Kod dopiero po autoryzacji R1.
