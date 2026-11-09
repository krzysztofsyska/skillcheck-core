# Obowiązkowa bramka CI i pełnego przeglądu commitów

Decyzja właściciela: 2026-11-09. Dotyczy każdego zadania i PR, w tym poprawek, integracji i promocji produkcyjnej. Uzupełnia AGENTS.md, nie znosi żadnej jego bramki.

## Warunki przed scaleniem

1. Ustal aktualne `head SHA`, `base SHA`, listę **wszystkich** commitów PR od merge-base oraz pełny diff (łącznie z migracjami, plikami usuniętymi i zmianami zależności). Sprawdź autorów, historię zmian, konflikty, zakres, powiązane issue i regresje. Przegląd tylko ostatniego commitu nie wystarcza.
2. Uruchom wszystkie wymagane CI dla **aktualnego head SHA**. Każdy required check musi mieć końcowy status success. Pending, queued, skipped bez uzasadnienia, cancelled, timed out, stale, missing lub failure oznaczają **BLOCKED**, nigdy PASS. Sprawdź też typecheck, build, testy modułowe, integracyjne, bezpieczeństwo i izolację firm zgodnie z zakresem.
3. Niezależny reviewer, który nie pisał zmian, ocenia **pełną historię commitów i łączny diff** na aktualnym SHA, z wynikiem PASS / PASS WITH FIXES / FAIL. Musi wymienić SHA, zakres przeglądu, znalezione ryzyka, status wszystkich uwag i dowód zamknięcia. PASS WITH FIXES nie uprawnia do merge, dopóki poprawki nie zostaną wdrożone i ponownie ocenione.
4. Każdy nowy push, rebase, merge-base change lub poprawka po review wymaga ponownego sprawdzenia CI i przeglądu nowego SHA. Wykryte brakujące lub czerwone kontrole uruchom ponownie, jeśli jest to bezpieczne i dozwolone; diagnozuj, naprawiaj i ponawiaj, zamiast zostawiać je bez rozstrzygnięcia.
5. Dopiero gdy finalne CI i niezależny review dotyczą tego samego aktualnego SHA, wszystkie uwagi bezpieczeństwa są zamknięte, a zakres jest zgodny z issue, można automatycznie scalić do `integration` zgodnie z AGENTS.md. Jeśli brak dowodu, FAIL CLOSED. `main` i produkcja zawsze wymagają odrębnej zgody właściciela.
6. Po scaleniu sprawdź CI **wynikowego SHA integration** i zapisz rezultat. Jeśli jest czerwone, zgłoś regresję, utwórz zadanie naprawcze i nie uznawaj dostawy za DONE.
7. Raport z każdego PR: lista commitów lub zakres SHA, status CI (liczba sukcesów i blokad), niezależny review, wynik merge i post-merge CI. Przed wydaniem produkcyjnym dodatkowo pełen przegląd wszystkich commitów od wspólnej bazy `main` i `integration`, lista migracji, rollback i testy E2E.

## Automatyzacja

Codex/Claude Code mają wdrożyć powyższe jako fail-closed kontrole w istniejącym pipeline GitHub Actions / agent controller, bez samodzielnego włączania wyłączonych flag, zmieniania rulesets lub branch protection. Nie wystarczy sam dokument: automatyczna bramka ma mieć testy pozytywne i negatywne (pending CI, stary review, dodatkowy commit, brak kontroli, fail po merge). Do czasu wdrożenia technicznej bramki obowiązuje ręczna weryfikacja tych samych warunków przez agenta przed każdym merge.
