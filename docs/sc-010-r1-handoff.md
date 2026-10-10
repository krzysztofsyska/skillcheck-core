# SC-010-R1 — polityki, potwierdzone rekordy osoby i podgląd

TASK: SC-010-R1
LEVEL: L3
SCOPE: FULLSTACK
OWNER: Codex / orchestrator
REVIEWER: niezależny Codex reviewer
DEPENDS ON: SC-010-B1/B2, zaakceptowana architektura SC-010-R (#83)
STATUS: CODE REVIEW PASS / CI IN PROGRESS
BRANCH: feat/sc-010-r1-preview
BASE: 5f92bbfd01e0bb35fb70df44d4bc6e64ded9855b

Zlecenie właściciela: 2026-10-10, „Zrób”. R1 dostarcza konfigurację i inwentaryzację. Nie wykonuje usunięcia, nie uruchamia retencji automatycznej, nie zamraża kandydata i nie wdraża zmian produkcyjnych. Podgląd nie jest upoważnieniem do późniejszego purge. Projekt wykonania pozostaje w `sc-010-retention-erasure-architecture.md`.

## Kontrakt frontend–backend

Wszystkie operacje wymagają aktualnego właściciela firmy sprawdzanego w bazie. Sesja aplikacji korzysta z normalnego klienta użytkownika; brak service_role. Identyfikatory z formularza podlegają ponownej walidacji uprawnień i przynależności do firmy w RPC.

| RPC | Wejście | Wynik |
| --- | --- | --- |
| configure_candidate_retention_policy | target_company, expected_revision, policy_rules, request_key | UUID niezmiennej wersji polityki |
| get_candidate_retention_policy | target_company | aktualna wersja i reguły |
| confirm_erasure_subject | target_candidate, candidate_ids, expected_revision, request_key | UUID niezmiennego potwierdzenia właściciela |
| get_erasure_subject_resolution | target_candidate | aktualne potwierdzenie i wersja |
| preview_candidate_erasure | target_candidate, scope_kind, resolution_id | liczności, blokady, wersje, skróty manifestu i schematu, czas utworzenia i wygaśnięcia |

Polityka ma od 1 do 8 jawnych reguł: `data_class`, `trigger_event`, `duration_days`, `hold_review_days`. Klasy: candidate, assessment, screening, communication, audit, external, backup, exports. Zdarzenia: record_created, process_closed, consent_revoked. Okresy wpisuje właściciel; R1 nie podaje domyślnych okresów prawnych ani nie ocenia kwalifikacji do automatycznego usunięcia. Brak wymaganych klas jest blokadą podglądu.

Potwierdzenie obejmuje od 1 do 100 rekordów jednej firmy i zawsze rekord główny. Nie ma automatycznego łączenia osób po emailu, nazwisku ani innych podobieństwach. Aktualizacja wymaga oczekiwanej wersji; powtórzenie klucza z innym wejściem jest konfliktem. Formularz zachowuje klucz dla tego samego wejścia i wersji przy ponowieniu. Wybór dodatkowych rekordów odbywa się przez wyszukiwanie nazwiska i strony po 25 pozycji; zaznaczenia są zachowywane między stronami. Każda pozycja ma identyfikator i link do rekordu do samodzielnego sprawdzenia.

Podgląd ma zakres `candidate_record` lub `confirmed_subject`; drugi wymaga aktualnego potwierdzenia. Jest odczytem migawki danych. Serializacja manifestu używa UTC i ISO niezależnie od ustawień sesji. Skrót manifestu wiąże zawartość, wersje polityki/potwierdzenia i sygnaturę schematu. Ważność wynosi pięć minut, lecz nigdy nie zastępuje ponownej walidacji przyszłego wykonawcy. Wynik zawsze zawiera blokadę `execution_not_implemented`.

## Mapa i granice

Inwentaryzacja obejmuje bieżący graf kandydata: dokumenty, aplikacje, oceny i obserwacje, screening z przeglądami i shortlistą, komunikację B1/B2 oraz prywatne dowody, audyt i żądania. Referencje JSON `private.contact_requests` mają jawne adaptery operacji permission/preferences/draft/cancel/approve. Nieznany schemat lub operacja powodują blokadę. Nowe moduły, w tym niezaakceptowane jeszcze tabele SC-012, wymagają osobnego adaptera i testów.

Wynik nie zwraca treści CV, kontaktów, dowodów ani rekordów audytu. Dane zewnętrzne, kopie zapasowe i eksporty pozostają jawnie nieuzgodnione. R1 nie twierdzi, że podgląd gwarantuje kompletne usunięcie danych poza bazą.

## Weryfikacja i przekazanie

Wymagane: testy pełnego łańcucha migracji z rzeczywistymi fixture B1/B2, izolacja ról i firm, zakaz bezpośredniego DML, wersjonowanie/idempotencja, manifest po zmianach danych i schematu, nieznane JSON, podgląd bez zapisu, testy współbieżności PostgreSQL, formularze i autoryzacja serwerowa, typecheck/build oraz regresje CI. Pierwsze CI wykryło nieprzenośność sygnatury schematu między wersjami PostgreSQL; normalizacja wpisów NOT NULL zachowuje sprawdzanie attnotnull. Checks38078778360 na 847ea905 zakończył się SUCCESS, w tym real PostgreSQL 9/9 i wszystkie regresje/build/HTTP. Dodatkowy review GitHub doprowadził do poprawy wyboru rekordów, ponowień formularzy, stronicowania i serializacji dat. Regresja bazy po poprawce UTC: 13/13 PASS. Końcowe wyniki wszystkich testów i review bieżącego kodu są śledzone w PR #90. PR jest źródłem aktualnego werdyktu i niezmiennego SHA przy odbiorze.

Migracja jest nowa, wygenerowana przez Supabase CLI. Nie stosować jej na produkcji w ramach R1. Po PASS review i CI wymagane jest OWNER ACCEPTANCE integracji zgodnie z AGENTS.md. Dalszy krok: R2 — lifecycle freeze i autoryzacja żądania usunięcia; R3 — wykonawca purge i odtwarzanie; R4 — harmonogram retencji. Żaden z tych etapów nie jest wykonany przez R1.
