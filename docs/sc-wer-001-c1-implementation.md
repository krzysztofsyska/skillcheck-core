# SC-WER-001 C1 — aktywny schemat i inwentarz R12

Stan: przygotowane do niezależnego review SQL i natywnych testów PostgreSQL 16/17. Migracji nie zastosowano zdalnie. Baza gałęzi zawiera integration `cb3352e`.

`20261106063720_sc_wer_c1_inventory_r12.sql` instaluje atomowo siedem tabel B2, znaczniki wycofania, role i RPC oraz kompletną rewizję retencji R12. Kompozycja pochodzi z przypiętych źródeł repozytorium; `node scripts/sc-wer-c1-compose.mjs --check` sprawdza identyczność migracji i rollbacku.

- Źródło R11: `0d22eb7a547b1f8838298b034d3d257ca4cba9e81430f5c6b20b9212e4d88b84`.
- R12 na pełnym czystym replay PostgreSQL 17.5/PGlite: `48afc7b117acb3640b1521c9b8b2e525e89d653d9e2981edf2b1209f9515eaba`. Natywne PG16/17 muszą potwierdzić ten sam literał.
- Preflight sprawdza pełny zestaw tabel, brak R12 i zajętych nazw wrapperów oraz źródło, właściciela, ACL i konfigurację ośmiu nadpisywanych/owijanych funkcji.
- Zastane role gateway/marker mogą istnieć tylko bez własnych obiektów, jawnych ACL, initial ACL i przypisanych policies. Sprawdzenie zależności całego klastra odrzuca drift przed nadaniem dostępu do schematu private; nie usuwa cudzych uprawnień. Role z poprawnymi atrybutami, bez takich zależności, są akceptowane.
- `erasure_inventory_rows_r11` i `erasure_row_candidates_r11` zachowują bieżący łańcuch bulk CV → Step 4 → wcześniejsze adaptery. Nie włączono wariantu voice.
- `preview_candidate_erasure` oblicza blocker współdzielonego anulowania przed hashem manifestu. Trzy pozostałe czytniki zmieniają wyłącznie nazwę baseline. Istniejące `erasure_check_purge_scope` i `erasure_purge_rows` pozostają bez zmian.
- Obecny `erasure_purge_engine` zachowuje validate/ACK/lease/restore/context i kontrolę hashów. Siedem usunięć następuje dopiero po `mode=delete`, przed rodzicami FK; każde sprawdza licznik manifestu. Zachowany właściciel `erasure_purge_owner`.
- R1: aktywny wpis shortlisty tej samej firmy/rekrutacji/aplikacji jest wymagany przed idempotentnym wydaniem/rotacją i przy wymianie oraz każdym użyciu sesji. `FOR SHARE NOWAIT` serializuje usunięcie wpisu. Unieważnienie grantu działa również po usunięciu wpisu.
- Tymczasowy dostęp instalatora do ról właścicieli korzysta z istniejącego protokołu migracji SC-010. Po operacji odtwarza członkostwa i ACL schematu. Tylko zaufane funkcje właściciela `postgres` wywołują zapis znaczników; API i gateway nie otrzymują tego uprawnienia.

Testy obejmują pełny replay, odmowę driftu tabel/funkcji/ACL/config, rollback, R1, dwie firmy, rotację, replay, TTL, wycofanie, siedem powierzchni preview/purge, współdzielone anulowania i idempotencję purge. Osobny test natywny wymaga dwóch połączeń i sprawdza kolejność usunięcie shortlisty ↔ grant/sesja oraz start/submit/revoke. Są podpięte do istniejącego workflow `SC-019 forward migrations`, macierz PostgreSQL 16/17. Historyczne testy B2/B3 pozostają bez zmian.

Rollback jest dozwolony wyłącznie przed pierwszymi danymi/znacznikami C1 i przed C2. Przy danych kończy się odmową. Przywraca R11 i wcześniejsze funkcje. PostgreSQL zachowuje numery usuniętych kolumn, więc ponowne C1 na fizycznym schemacie po rollbacku jest celowo odrzucane atomowo; ponowne wdrożenie wymaga odtworzenia czystej bazy Preview lub osobno zrecenzowanej rewizji. Proces deploymentu z ledgerem migracji nie wykonuje już zastosowanego C1 drugi raz.

C1 nie włącza brokera, usług ani żadnych flag wykonywania erasure. C2/C3 i syntetyczny przepływ kandydata do raportu są kolejnym etapem tego samego PR.
