# SC-010-R2 — autoryzacja i odwracalne zamrożenie danych

Data: 2026-10-10, Europe/Warsaw.

TASK: SC-010-R2
LEVEL: L3
SCOPE: FULLSTACK
OWNER: Codex / orchestrator
REVIEWER: niezależny Codex architect/reviewer
DEPENDS ON: R1 #90, B1/B2, SC-006/008/009
STATUS: CODE REVIEW PASS / CI PENDING
BRANCH: feat/sc-010-r2-lifecycle
BASE: 5b63807f30654a8829701ef566909b318a82a281

Właściciel zlecił R2 o 21:39. Etap udostępnia zatwierdzenie konkretnego zakresu i odwracalną blokadę odczytów/zapisów. Nie wykonuje usunięcia. Zaakceptowana architektura pełnego procesu pozostaje w `sc-010-retention-erasure-architecture.md`.

## Granica R2 i kontrakt

R1 preview pozostaje operacją wyłącznie odczytową. Do autoryzacji R2 służy osobny bilet zapisany przez bazę: właściciel, firma, zakres, potwierdzenie rekordów, hash operacyjny, generacje i pięciominutowy termin. Klient nie może wystawić biletu ani przedłużyć jego ważności przez podanie własnego czasu.

| Operacja | Znaczenie |
| --- | --- |
| issue_candidate_erasure_preview | Wystawia bilet i zwraca aktualny podgląd do zatwierdzenia |
| request_candidate_erasure | Ponownie sprawdza uprawnienia, bilet, generacje i manifest pod blokadą; zatwierdza i zamraża zakres |
| cancel_candidate_erasure | Odwołuje lokalne zatwierdzenie przy zgodnej generacji; nie cofa niezależnych zmian zgody |
| get_candidate_erasure_status / get_erasure_status | Zwraca bezpieczny status bez CV i danych kontaktowych |
| list_candidate_erasure_requests | Pozwala właścicielowi znaleźć żądania, gdy rekord kandydata jest ukryty w zwykłych widokach |

Dozwolone są wyłącznie stany `authorized` i `cancelled`. Autoryzacja oznacza zgodę na zakres i lokalną blokadę, nie zdolność do wykonania purge. Brak funkcji przejścia do `erasing`, wykonawcy, sekretów i eksportu recovery envelope. Stałe blokady wykonania dotyczą R3 oraz nieuzgodnionych danych zewnętrznych, kopii i metadanych administracyjnych.

Nieznany schemat/JSON, zmieniony manifest, niepełna polityka, obce lub nieaktualne rozpoznanie osoby, aktywna analiza i konflikt pokrywających się zakresów zatrzymują zatwierdzenie. Zakres pojedynczego rekordu jest jawny i nie obiecuje znalezienia wszystkich duplikatów. Pełny potwierdzony zakres pochodzi z zapisanego rozpoznania właściciela.

## Odczyt, zapis i wyścigi

Blokady są egzekwowane w bazie, także dla direct DML i funkcji uprzywilejowanych. Obejmują graf kandydata, relacje rodziców, zmianę identyfikatora/firmy i przepinanie dzieci. Zwykłe listy, raporty i eksporty nie zwracają zamrożonych danych. Osobny panel właściciela pokazuje status i anulowanie, bez wymagania odczytu ukrytego rekordu.

Zatwierdzenie nie zmienia B1 draft na cancelled i nie dopisuje zdarzenia anulowania komunikacji. Wycofanie lub zablokowanie zgody pozostaje możliwe podczas freeze; jego własne konsekwencje są trwałe. Odwołanie żądania nie odtwarza zgód, kontaktów ani niezależnie anulowanych draftów. Po odblokowaniu B2 ponownie sprawdza aktualność dowodów.

R2 wymaga świeżej transakcji READ COMMITTED (PostgreSQL traktuje READ UNCOMMITTED równoważnie). Mutacje są odrzucane, a zwykłe odczyty danych kandydatów zwracają pusty wynik w REPEATABLE READ/SERIALIZABLE, aby stara migawka nie omijała freeze. Aplikacja używa domyślnego READ COMMITTED.

Ochrona kontekstu jest konserwatywna: zmiana danych firmy lub współdzielonego stanowiska/procesu z zamrożonym kandydatem wymaga wcześniejszego anulowania żądania. Nie wprowadzono nowej ścieżki przenoszenia własności podczas freeze.

Generacja rośnie przy przejściach, nie jest cofana. Bilet sprzed cyklu freeze/cancel nie upoważnia do ponownego zatwierdzenia. Idempotencja obejmuje firmę, aktora, operację i dokładny payload; formularze zachowują klucz przy ponowieniu po utracie odpowiedzi.

## Dlaczego anulowanie R2 jest lokalne

Pełna architektura wymaga ledger ACK przed odblokowaniem po kontakcie z niezależnym recovery ledger. W R2 nie istnieje żadna ścieżka emisji envelope ani nieodwracalna operacja, więc lokalna transakcja może bezpiecznie odwołać wyłącznie lokalne zamrożenie. To ograniczenie strukturalne, nie flaga klienta ani zapewnienie workera. R3 musi zastąpić ten kontrakt protokołem ledger/CAS/reconciliation **przed** dodaniem wykonawcy lub zewnętrznego envelope. Lokalny `authorized` po przywróceniu backupu nigdy sam nie upoważnia do purge.

## Metadane administracyjne i mapa R3

UUID i hashe pozostają danymi pseudonimowymi. Administracyjne bilety/żądania/zdarzenia nie są częścią hasha operacyjnego: dopisanie biletu nie może unieważniać jego własnego podglądu. Ich tabele nadal są objęte sygnaturą schematu, dostęp jest ograniczony, a podgląd jawnie wskazuje brak gotowego wykonania ich retencji/usuwania. Mapa administracyjna wymagająca adapterów R3:

| Tabela private | Powiązania objęte przyszłym usuwaniem/retencją |
| --- | --- |
| erasure_preview_tickets | firma, aktor, anchor_candidate_id, candidate_ids[], resolution_id, manifest_hash, generations JSON z UUID jako kluczami |
| erasure_requests | anchor_candidate_id, candidate_ids[], preview_ticket_id, aktor, manifest_hash i wersje |
| erasure_candidate_lifecycle | candidate_id, company_id, request_id, monotoniczna generacja |
| erasure_lifecycle_events | request_id, company_id, actor_id i zdarzenie/generacja; bez dowolnego payloadu |
| erasure_lifecycle_commands | company_id, actor_id, request_key, payload_hash i result_id żądania |
| erasure_denial_context | txid i candidate_id; kontekst istnieje tylko podczas autoryzowanego wycofania/blokady zgody i znika w tej transakcji |

Nowy immutable erasure_inventory_baseline_r2 jest konfiguracją schematu bez danych osoby; nie nadpisuje baseline R1. R3 musi objąć wszystkie te powiązania adapterami i skończoną polityką retencji przed aktywacją.

## Weryfikacja i przekazanie

Wymagane: pełny łańcuch nowych migracji; role i izolacja firm; aktualność biletu/manifestu/polityki/rozpoznania; generacje i idempotencja; odczyty oraz bezpośrednie zapisy i funkcje worker/verifier; niezależne cofnięcie zgody; wyścigi PostgreSQL 16; regresje R1/B1/B2/SC-006/008/009; formularze, HTTP, typecheck/build i niezależny review. Lokalnie R2 DB 9/9, UI 12/12, regresja R1 27/27, typecheck/build PASS. Niezależny review PASS po poprawkach ponowień screening, autoryzacji przed kontekstem cofnięcia zgody i izolacji funkcji RLS. Wyniki końcowego CI PostgreSQL oraz niezmienny SHA będą w PR.

Nowe migracje CLI: 20261010194216_candidate_erasure_lifecycle.sql, 20261010194230_candidate_erasure_guards.sql, 20261010194343_candidate_erasure_inventory_v2.sql. Starsze migracje pozostają bez zmian.

Nowe migracje wyłącznie na branchu zadania. Brak operacji produkcyjnych, kontaktu z kandydatem i usuwania danych. Integracja po review/CI oraz OWNER ACCEPTANCE zgodnie z AGENTS.md. R3 i R4 pozostają osobnymi etapami.
