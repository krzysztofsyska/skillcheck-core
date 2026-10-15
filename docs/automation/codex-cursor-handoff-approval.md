# Codex → Cursor → Codex: propozycja automatyzacji (NIEAKTYWNA)

Status: IMPLEMENTED_INACTIVE / kod i testy offline, bez aktywacji. Ten dokument nie uruchamia automatyzacji. Wynik PASS w teście offline nie jest pełnym testem żywego obiegu Cursor → Codex. Komentarz `cursor[bot]` z prośbą o review nie jest dowodem, że review wystartowało.

## Cel
Po review Codexa automatycznie przekazać aktywne uwagi do Cursora, odebrać poprawkę na tym samym PR, uruchomić CI i ponowny niezależny review dla nowego SHA. Maksymalnie trzy iteracje. Bez automatycznego merge, produkcji, migracji live, płatnych połączeń ani ujawniania sekretów.

## Projekt workflow
1. Zaufany workflow na chronionej gałęzi odbiera `pull_request_review.submitted` / `pull_request_review_comment.created`; reaguje tylko na zweryfikowaną tożsamość bota Codex i dokładny SHA. Wydarzenia grupuje, aby nie wysłać wielokrotnie tych samych uwag.
2. Pobiera nierozwiązane, aktualne wątki review z GitHub API, sprawdza repo, PR, head SHA, brak forka, zgodność docelowej gałęzi `integration` i stan PR. Nie wykonuje kodu z PR ani poleceń z treści komentarzy jako skryptów.
3. Deduplikuje po `PR + SHA + review ID`, zapisuje licznik prób i identyfikator przekazania w zaufanym stanie (nie w edytowalnym opisie PR). Limit 3; przekroczenie oznacza BLOCKED i wymaga interwencji, bez zapętlenia.
4. Przekazuje do Cursora przez **potwierdzony** mechanizm wyzwalania (osobny komentarz `@cursor` albo oficjalna integracja), z listą uwag i instrukcją aktualizacji istniejącego PR. Przed aktywacją wykonać sandbox test, że komentarz GitHub Actions faktycznie uruchamia Cursora; wcześniejsza odpowiedź na komentarz ChatGPT nie dowodzi działania konta Actions.
5. Po nowym commicie: CI na nowym SHA, następnie niezależny Codex review. Poprawka autora nie może być uznana za niezależne zatwierdzenie. Zapisuje audyt: event, PR, SHA, CI, review, komentarz i status.
6. PASS oznacza gotowość do ręcznej bramki OWNER ACCEPTANCE; żaden workflow nie scala ani nie wdraża do Production. Kosztowne operacje są wyłączone.

## Warunki aktywacji
- Niezależny review bezpieczeństwa: GitHub Actions permissions minimalne; brak `pull_request_target` z checkoutem niezaufanego kodu; bot identity allowlist; idempotencja i rate limit; obsługa 403 i błędów integracji.
- Potwierdzić dostępność automatycznego wyzwalania Codexa, Cursora i politykę tokenów, bez umieszczania sekretów w PR.
- Test sandbox: Codex review → pojedynczy dispatch → Cursor ACK → poprawka → CI → Codex review, w tym przypadek błędu i limitu trzech prób.
- Osobna zgoda właściciela na włączenie workflow; wdrożenie na integration po review, bez zmian main/Production.

## Kryteria odbioru
Powtarzalny dowód całego obiegu z URL komentarzy, SHA i wynikami CI; zero podwójnych dispatchy; bez eskalacji uprawnień, bez nieautoryzowanych merge/deploy i bez płatnych wywołań.

## Implementacja nieaktywna (2026-10-14)

Właściciel zatwierdził kod i testy offline. Nie zatwierdził aktywacji na chronionej gałęzi, merge, Production, sekretów ani płatnych wywołań.

Granice wobec istniejącej pracy:

- PR #57 (`agent-feedback.yml`, `feedback.mjs`, gałąź `agent-feedback-state`) zostaje mostem live dla zarejestrowanych PR. Ten obieg go nie kopiuje, nie zapisuje jego stanu i nie woła API Cursora.
- PR #124 zostaje propozycją automatycznego merge do `integration`. Ten obieg nie scala i nie zmienia polityki merge.
- Istniejące `agent-review.yml` / `agent-verify.yml` zostają miejscem płatnego review i CI kontrolera. Ten workflow ich nie dispatchuje.

Pliki: `.github/workflows/agent-handoff.yml`, `tools/agent-pipeline/lib/handoff-loop.mjs`, `tools/agent-pipeline/lib/handoff-admission.mjs`, `tools/agent-pipeline/handoff-cli.mjs`, `tests/agent-pipeline/handoff-loop.test.mjs`, `tests/agent-pipeline/handoff-admission.test.mjs`.

Silnik przyjmuje zrzut zdarzenia i ledger w pamięci. Deduplikacja to `PR + SHA + review ID`. Nowa rezerwacja zamyka wcześniejsze otwarte rezerwacje tego PR jako `SUPERSEDED`, więc stary cykl nie zamawia drugiego review. Czwarta próba też zamyka aktywną rezerwację, zanim wróci `BLOCKED_LIMIT`. Kolejne zdarzenie tego samego review dopisuje nowo widoczne ustalenia bez kolejnej próby. `PASS` wymaga tożsamości Codexa zarówno u nadawcy zdarzenia, jak i u autora review. Licznik prób jest na PR i kończy się na `BLOCKED_LIMIT` po trzech rezerwacjach. Komentarze są grupowane w jedno przekazanie; treść komentarza nie wchodzi do planu, audytu ani werdyktu i nie jest wykonywana. Po nowym SHA obieg czeka na istniejące CI i zapamiętuje jego wynik. Ponowny review jest zamawiany dopiero po `success`. Czysty werdykt `PASS` od Codexa kończy obieg także wtedy, gdy GitHub zapisze review jako `commented` i zdarzenie nie powtórzy CI. `PASS_WITH_FIXES` i `FAIL` nie są zgodą. Zatwierdzenie autora albo autora commita poprawki nie jest niezależnym PASS. `READY_FOR_OWNER` nie jest zgodą właściciela i nie jest dowodem, że commit pochodzi od Cursora — pochodzenie commita zostaje w #57.

Workflow nasłuchuje `pull_request_review` / `pull_request_review_comment` / `workflow_dispatch`, ale job startuje tylko przy `CODEX_CURSOR_HANDOFF_ENABLED=true`, wyłączonych flagach kontrolera i mostu #57, zgodnym repozytorium i tożsamości bota Codex. Checkout wskazuje `main` z `persist-credentials: false`. Brak `pull_request_target`, brak `secrets` i brak wywołań płatnych. Nawet przy ustawionej zmiennej CLI kończy się `BLOCKED_ACTIVATION`, bo `LIVE_EFFECTS_ENABLED` jest false.

## Kolejka offline (2026-10-15)

Ta sama pamięć ledgeru, bez nowego kontrolera i bez gałęzi stanu. W trybie offline nie wołamy transportu ani callbacku wykonawczego. Błąd 403 na zrzucie zdarzenia blokuje obieg przed otwarciem slotu. Istniejący `withTransportRetry` (#57) zostaje helperem na późniejszą aktywację i nie jest stąd uruchamiany. #124 dalej jest jedyną polityką merge; ten kod jej nie kopiuje.

- Najwyżej pięć zadań Cursora naraz. Rezerwacja `REQUESTED` bez ACK oraz `STARTED` bez ACK zajmują slot. Szóste czeka. Ten sam PR nie dostaje drugiego zlecenia, dopóki poprzednie jest w kolejce albo w slocie.
- `FREE`, `PRESELEKCJA` i `SC-005` wchodzą przed zwykłymi zadaniami. Ich jawne zależności też, ale samo zadanie priorytetowe czeka, aż zależność zostanie ukończona. Cykl zależności jest `BLOCKED_DEPENDENCY_CYCLE` i nie zajmuje slotu.
- Ważny review jest zapisany dla PR, identyfikatora review, HEAD, BASE i skrótu warunków kontroli (`policy_sha` oraz posortowane `required_checks`). Ta sama tożsamość nie tworzy drugiego review. Inny BASE, HEAD, PR albo skrót nie odtwarza starego wyniku; próba ponowienia daje `STALE_REVIEW`. Napis `trusted_adapter` nie wystarcza: numer PR, HEAD i BASE muszą zgadzać się ze zrzutem, a brak tych danych blokuje gotowość. Nowszy `FAIL`, `PASS_WITH_FIXES` albo odrzucenie review unieważnia zapisany PASS.
- Callback wykonawczy nie startuje w trybie offline i nie startuje przed walidacją. `LIVE_EFFECTS_ENABLED` zostaje false.
- Zdarzenie musi przyjść z `source: trusted_adapter`. Komentarz, także `@codex review` albo słowo `STARTED` w treści, zostaje `COMMENT_ONLY`. `STARTED` wymaga zgodnego identyfikatora agenta. `COMPLETED` wymaga ACK i nowego SHA. Brak ACK albo brak nowego commita zostawia slot zajęty. Tekst opisu PR nie jest dowodem.
- `READY_TO_MERGE` pojawia się tylko przy niezależnym strukturalnym `PASS` Codexa, zielonym CI tego HEAD, ukończonych wskazanych zależnościach i braku aktywnych P0/P1/P2. `READY_FOR_OWNER` nie jest `READY_TO_MERGE`. Żaden z tych statusów nie ustawia `merge_authorized`. Merge i deploy są zawsze `BLOCKED_MERGE` / `BLOCKED_DEPLOY`.
- Audyt etapu zapisuje PR, wykonawcę, zadanie, SHA, testy, review, następny etap, blokadę i identyfikator agenta z adaptera, nie z opisu PR.

Testy tej kolejki są offline. Zielony wynik nie jest pełnym testem żywego obiegu Cursor → Codex. Komentarz `cursor[bot]` z prośbą o review nie oznacza, że review wystartowało.

## Blokady aktywacji

- Workflow nie jest na domyślnej gałęzi `main`, więc zdarzenia review go nie uruchamiają.
- Zmienna `CODEX_CURSOR_HANDOFF_ENABLED` nie jest ustawiana.
- Brak trwałego, chronionego ledgeru. Zapis stanu w PR albo na `agent-feedback-state` byłby albo edytowalny, albo duplikatem #57.
- Brak testu, że komentarz konta Actions budzi Cursora. Test sandbox jest offline.
- Brak potwierdzenia budżetu i tokenów Codexa/Cursora.
- Niezależny review tego head musi zakończyć się PASS przed jakąkolwiek aktywacją.
- Osobna zgoda właściciela jest wymagana na włączenie. Merge do `integration` i promocja na `main` pozostają osobnymi decyzjami.
