# SC-WER-001 / SC-014-C1 — bramka R11 przed aktywną migracją

STATUS: DESIGN_ONLY — nie jest migracją, nie uruchamia schematu ani brokera.
TASK: #270; PR: #273; bazowa gałąź: `integration`. Zakres: wyłącznie WERYFIKACJA.

## Potwierdzone punkty odniesienia (2026-11-06)

- `supabase/migrations/20261103090100_sc_erasure_inventory_r11.sql` jest źródłem obecnego inwentarza usuwania. Utrwala `private.erasure_inventory_baseline_r11`, sprawdza `private.erasure_schema_signature()` i porównuje pełną listę relacji `public` + `private`. Nie wolno modyfikować historycznej migracji R11.
- `db/isolated/sc014-b2-attempts.sql` i pozostałe pliki B2 są prototypem izolowanym. Odwołania do starszych R5 / wpisane sygnatury historyczne w części retencji nie są kontraktem aktywnej migracji C1. Proste kopiowanie do `supabase/migrations` jest niedopuszczalne.
- R11 czytają funkcje `public.preview_candidate_erasure`, `private.prepare_erasure_purge_manifest`, `private.authorize_retention_suggestion`, `public.get_retention_schedule`. Dodanie tabel bez zgodnej aktualizacji inwentarza i ścieżek usuwania zatrzyma te mechanizmy przez fail-closed.
- Reguła R1 z `docs/plan-budowy-2026-11-02.md`: grant tylko dla aktualnego wpisu `public.recruitment_shortlist_entries`; weryfikacja w transakcji bazodanowej, również przy obejściu UI.

## Kontrakt implementacji C1 (do osobnego L3 review przed Preview)

1. Zrekonstruować aktualny schemat po R11 na czystej bazie testowej i sprawdzić jego dokładny podpis oraz zgodność istniejących zależności. Nie przenosić podpisu ani manifestu z R5/R10.
2. Opracować nową, append-only rewizję inwentarza po R11 (roboczo „R12” — oznaczenie do uzgodnienia z aktualnymi migracjami). Instalacja nowego schematu i rewizji inwentarza musi być spójna transakcyjnie, fail-closed przy nieznanym źródłowym schemacie, z kontrolą podpisu i pokrycia wszystkich nowych relacji. Nie przepisywać R11.
3. Ująć w przeglądzie siedem powierzchni z izolowanego B2: `private.competency_test_grants`, `private.competency_test_grant_events`, `public.competency_test_attempts`, `private.competency_test_sessions`, `private.competency_test_drafts`, `public.competency_test_review_entries`, `private.competency_test_cancellations`. Osobno ocenić kolumny anulowania w `public.candidates` i `public.applications`, indeksy, zależności FK i rolę danych historycznych.
4. Dla każdej powierzchni powiązanej z kandydatem udowodnić działanie inwentarza `preview`, manifestu `purge` i kontrolowanego usuwania lub jawnie uzasadniony wyjątek retencyjny. Samo dopisanie nazwy tabeli do `known_tables` NIE wystarcza. Przy danych wielopodmiotowych / tablicach identyfikatorów wykonać negatywne testy rozdziału tenantów i usuwania powiązanych osób.
5. Zachować minimalne uprawnienia `competency_test_gateway` i `competency_test_marker_writer`; domyślnie brak dostępu public/anon/authenticated do tabel prywatnych. Sprawdzić `SECURITY DEFINER`, `search_path`, RLS, sprawdzanie statusu aplikacji/rekrutacji, ochronę przed ponownym użyciem tokenu, TTL, wycofaniem i kolizjami transakcji.
6. Wydanie, rotacja oraz wykorzystanie grantu muszą mieć powiązanie `company_id` + `recruitment_id` + `application_id` + niemutowalna wersja zadania i aktualny wpis shortlisty (R1). Brak wpisu lub cofnięcie wpisu po wystawieniu grantu = odmowa według zatwierdzonego kontraktu; bez mieszania z tabelami AC.
7. Zapewnić rollback odpowiadający nowym obiektom, test preflight/postflight oraz test, że niewspierany podpis źródłowy, nieznana tabela albo brak adaptera kończy się błędem przed zatwierdzeniem transakcji.

## Bramka testowa

- Testy migracji C1 na pustej bazie testowej z kompletnym łańcuchem do R11; negatywny test błędnej sygnatury i dodatkowej nieznanej relacji; test idempotencji procesu deploymentu.
- Testy dwóch firm, przejęcia identyfikatorów, shortlisty R1, rotacji/replay/TTL, anulowania i ponownego odczytu po cofnięciu uprawnienia; kontrola niezmienności wersji zadania.
- Test retencji: widoczność wszystkich nowych danych kandydata w `preview` / `purge`, brak osieroconych danych, brak usuwania cudzych rekordów; regresja istniejącego R11 i SC-019.
- `typecheck`, `build`, izolowane B2/B3 i nowe testy migracji muszą przejść na dokładnym HEAD. Przed próbą Preview: niezależny review SQL, danych i uprawnień na tym samym SHA.

## Ograniczenia

Ten dokument to bezpieczny artefakt projektowy C1; **nie potwierdza** gotowości migracji ani działającego B4/C2/C3. Nie wolno scalać, wdrażać na produkcję ani modyfikować FREE, PRESELEKCJI, P24, main lub współdzielonych tabel AC. Aktywne zmiany schematu w Preview dopiero po odrębnym review i kontroli aktualnego stanu.
