# SkillCheck — selektywne wydanie sprzedaży (FREE / PRESELEKCJA)

Status: **PREPARATION ONLY**. Dokument i kod nie uruchamiają wydania, płatności, włączania AI ani zmian bazy.

## Dwie niezależne kolejki

1. `integration`: zwykłe prace produktowe, w tym niegotowe moduły HR i SC-019.
2. `release/sales-mvp-intake-YYYYMMDD`: małe wydanie przygotowane **od aktualnego `main`**, nie od `integration`. Kopiujemy tylko zatwierdzone pliki po niezależnym review; żadnego automatycznego scalenia całej gałęzi `integration`.

Pierwszy zakres jest umyślnie wąski: **wyłącznie zapytania handlowe** FREE / PRESELEKCJA. Dozwolone pliki:

- `app/preselekcja/page.tsx`
- `app/components/marketing/home-page.tsx`
- `app/components/marketing/site-header.tsx`
- `app/components/marketing/package-comparison.tsx`
- `tests/marketing-http.test.mjs`

Żadnych migracji, RLS, kredytów, automatycznych opłat, nowych kluczy ani workerów. Wdrożenie obsługi pakietów SC-019 będzie odrębną zmianą wysokiego ryzyka z własnymi testami rozliczeń, zgodą produkcyjną i przeglądem bezpieczeństwa.

## Automatyczny preflight wydania

`tools/agent-pipeline/lib/sales-release.mjs` jest funkcją **fail-closed**. Odrzuca:

- branch spoza `release/sales-mvp-intake-YYYYMMDD` i PR niecelujący w `main`;
- każdy plik poza pięcioma powyżej, pusty diff lub brak strony `/preselekcja`;
- usunięcia, zmiany typu, zmiany nazwy, pliki wykonywalne, symlinki i submoduły;
- brak metadanych `RELEASE_KIND: SALES_MVP_INTAKE`, `PROMOTION: YES`, `LEVEL: L3`;
- brak `PRODUCTION_APPROVAL: APPROVED`.

Sama treść `PRODUCTION_APPROVAL: APPROVED` w opisie PR **nie jest dowodem zgody właściciela**. Wymagana jest niezależna i egzekwowalna kontrola ochrony GitHub, review Codex oraz potwierdzenie właściciela przypięte do dokładnego SHA. Nie wolno wykonać merge, jeśli brakuje tych dowodów. Test: `node --test tests/agent-pipeline/sales-release-gate.test.mjs`.

## Wymagana aktywacja polityki — odrębna zgoda

Obecna gałąź `main` nie ma nowego gate i według sprawdzonego API GitHub nie była oznaczona jako chroniona. **Nie korzystać jeszcze z wyjątku wydaniowego.** Ten PR przygotowuje zmianę w `integration`; jego obecność nie modyfikuje `main`. Przed pierwszym selektywnym wydaniem należy:

1. Uzyskać niezależny L3 review zmiany klasyfikatora, testów i workflow, usunąć wszystkie P1/P2.
2. Ustalić osobny, minimalny i recenzowany sposób wprowadzenia samej polityki do `main` bez sześciu lub więcej niegotowych migracji HR z `integration`. Nie promować całej `integration`. To osobny production-governance checkpoint.
3. Zabezpieczyć `main`: wyłączyć force-push / deletion, wymagać poprawnych status checks, aktualnego niezależnego code review, odrzucać stale approvals, zablokować niezrecenzowane bezpośrednie push i zapewnić właścicielski approval na Production. Zweryfikować settings i dopiero wtedy uznać bramkę za egzekwowaną.
4. Przenieść **wyłącznie** 5 plików z ostatniego zatwierdzonego commitu PR #118 na branch z najnowszego `main`; nie cherry-pickować innych zmian z `integration`. Zapisać source SHA, target SHA i dokładną listę zmian.
5. Uruchomić fast release guard, pełne CI, marketing HTTP, build, kontrolę prywatności (bez danych CV), test Preview, Codex na finalnym SHA. Brak zielonego wyniku blokuje.
6. Zadać właścicielowi **jedno** pytanie: czy zatwierdza wdrożenie do Production konkretnego commit SHA i zakresu? Bez YES: nie scalać ani nie publikować.
7. Po zgodzie i merge: sprawdzić `/preselekcja` na własnej domenie, kliknięcie do maila, brak automatycznych płatności, dostępność loginu; w razie problemu rollback bez zmian w Supabase.

## Dodatkowe zasady obsługi

- Dalsze poprawki i ponowne testy są automatyczne; właściciel nie jest proszony o pojedyncze techniczne kliknięcia.
- Codex COMMENTED z P1/P2 nie jest PASS. Green CI nie jest niezależnym odbiorem.
- Nie zmieniać reguł ochronnych w celu przeforsowania czerwonego PR.
- Nigdy nie czytać ani nie logować wartości sekretów.
- SC-019 (FREE credits, zakup i aktywacja) nie jest zakończony przez wydanie samego formularza zapytania.
