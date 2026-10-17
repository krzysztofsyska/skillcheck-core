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

## Izolowany preflight — tylko do przygotowania

`tools/agent-pipeline/lib/sales-release.mjs` to **wyłącznie doradczy analizator zakresu**. Sprawdza końcową różnicę i **przekazane mu rekordy pośrednich commitów** (wraz ze spójnością łańcucha `baseSha -> headSha`), odrzucając:
- nieznaną gałąź, nieoczekiwany cel lub brak strony `/preselekcja`;
- dowolny plik spoza pięciu dozwolonych, duplikaty i pusty zestaw zmian;
- usunięcia, rename, merge commity, symlinki, submoduły i tryb pliku wykonywalnego;
- przekazany rekord commitu dotykającego niedozwolonego pliku, nawet gdy znika on z końcowego diffu;
- niespójne SHA, brakujące powiązania rodzic–dziecko i brak pokrycia plików końcowych przez przekazane rekordy.

**Istotne ograniczenie (P2):** ten moduł jest analizatorem dostarczonych danych, a nie niezależnym odczytem historii Git. Dowolny wywołujący może podać fałszywy spójny łańcuch SHA lub pominąć fragment rzeczywistego repozytorium. Moduł **nie czyta blobów historycznych, nie skanuje ich zawartości pod kątem sekretów i nie potwierdza kompletności realnego zakresu Git**. `ok:true` oznacza wyłącznie wewnętrznie spójny rekord ograniczonego zakresu, nie audyt bezpieczeństwa wydania. Dopiero zaufana bramka, uruchomiona z chronionego `main`, musi samodzielnie wyliczyć pełny zakres commitów i sprawdzić także zawartość historycznych blobów/skan sekretów, niezależnie od danych dostarczanych przez PR.

Funkcja **ZAWSZE zwraca `authorizedForProduction:false`, `historyAuthenticated:false` i `secretsScanned:false`**, także przy prawidłowym zakresie. Nigdy nie wnioskuje zgody z pól tekstowych PR. `node --test tests/agent-pipeline/sales-release-gate.test.mjs` sprawdza również, że aktywna kontrola `main` **w dalszym ciągu odrzuca** wszystkie selektywne gałęzie wydaniowe.

Workflow `Sales Release Scope` działa **tylko na roboczych PR do `integration`**, bez użycia sekretów i bez Production environment. Nie jest obowiązującą bramką wydania do `main` i nie zastępuje przyszłego procesu.

## Wymagana aktywacja polityki — odrębna zgoda

Obecna gałąź `main` nie ma nowego gate i według sprawdzonego API GitHub nie była oznaczona jako chroniona. **Nie korzystać jeszcze z wyjątku wydaniowego.** Ten PR przygotowuje zmianę w `integration`; jego obecność nie modyfikuje `main`. Przed pierwszym selektywnym wydaniem należy:

1. Uzyskać niezależny L3 review odrębnej polityki oraz testów, usunąć wszystkie P1/P2.
2. Przygotować osobną, minimalną implementację **zaufanej bramki** działającej z chronionej wersji `main`, a nie z plików PR; samodzielnie enumerować i uwierzytelniać pełną historię commitów, sprawdzać także historyczne bloby i finalny diff. Jej instalacja wymaga osobnego zatwierdzenia właściciela. Nie promować całej `integration`.
3. Zabezpieczyć `main`: wyłączyć force-push / deletion, wymagać poprawnych status checks, aktualnego niezależnego code review, odrzucać stare approvals i niekontrolowane bezpośrednie push. Wymagać **dwóch odrębnych dowodów z zaufanego GitHub**, nie tekstu PR: OWNER ACCEPTANCE oraz PRODUCTION APPROVAL. Zweryfikować przez API konfigurację uprawnień, ochrony `main` i wymaganych reviewerów środowisk przed uznaniem bramki za egzekwowaną; gdy API zwróci 403 lub ustawienia są niepełne, bramka musi FAIL CLOSED.
4. Gotowy DRAFT #120 jest oparty na `main` i zawiera dokładnie pięć plików. Przed jakąkolwiek produkcją zweryfikować ponownie jego HEAD oraz `main`; jeśli baza się zmieni, bezpiecznie odtworzyć wydanie od aktualnego `main`. Nie cherry-pickować innych zmian z `integration`.
5. Zastosować zaufaną bramkę (po jej odrębnej aktywacji), pełne CI, marketing HTTP, build, kontrolę prywatności bez danych CV, test Preview, Codex na finalnym SHA. Tylko odpowiednia, formalnie egzekwowana ochrona `main` oraz recenzja mogą dopuścić do etapu decyzji właściciela.
6. Zadać właścicielowi **jedno** pytanie: czy zatwierdza wdrożenie do Production konkretnego commit SHA i zakresu? Bez YES: nie scalać ani nie publikować.
7. Po zgodzie i merge: sprawdzić `/preselekcja` na własnej domenie, kliknięcie do maila, brak automatycznych płatności, dostępność loginu; w razie problemu rollback bez zmian w Supabase.

## Dodatkowe zasady obsługi

- Dalsze poprawki i ponowne testy są automatyczne; właściciel nie jest proszony o pojedyncze techniczne kliknięcia.
- Codex COMMENTED z P1/P2 nie jest PASS. Green CI nie jest niezależnym odbiorem.
- Nie zmieniać reguł ochronnych w celu przeforsowania czerwonego PR.
- Nigdy nie czytać ani nie logować wartości sekretów.
- SC-019 (FREE credits, zakup i aktywacja) nie jest zakończony przez wydanie samego formularza zapytania.
