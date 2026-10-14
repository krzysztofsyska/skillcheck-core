# Codex → Cursor → Codex: propozycja automatyzacji (NIEAKTYWNA)

Status: DRAFT / wymaga akceptacji właściciela i niezależnego review. Ten dokument nie uruchamia automatyzacji.

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
