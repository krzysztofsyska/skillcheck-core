# Pełny prompt implementacyjny — SC-OPS-002B

Miejsce użycia: zadanie GitHub dla Cursora w krzysztofsyska/skillcheck-core, po zaakceptowaniu projektu SC-OPS-002A. Koordynator przekazuje ten prompt przez GitHub; właściciel nie kopiuje raportów między agentami. Ten dokument nie oznacza, że agent został już uruchomiony.

```text
ZADANIE: SC-OPS-002B — implementacja automatycznego obiegu agentów
WYKONAWCA: Cursor
REVIEWER: Codex
POZIOM: L3
SCOPE: OPERATIONS — kontroler, CI i mechanizm zgód, bez funkcji produktu
REPOZYTORIUM: krzysztofsyska/skillcheck-core
GAŁĄŹ: feat/sc-ops-002b-agent-orchestration
BAZA: aktualny origin/integration
ZNANA BAZA PROJEKTU: 579da382f976971392bc15239fded5417945c0f0
PROJEKT: docs/sc-ops-002a-agent-orchestration.md
ZALEŻNOŚĆ: zaakceptowany projekt 002A; instalacja usług nie jest
warunkiem pisania i testowania kodu offline.

1. WARUNKI I INSTRUKCJE

Przeczytaj AGENTS.md, docs/AGENT_PIPELINE.md, docs/AGENT_WORKFLOW.md
oraz cały zatwierdzony projekt 002A.
Projekt musi być dostępny jako wersjonowany plik albo niezmienny
załącznik kontraktu Issue z podanym SHA-256. Jeżeli jest załącznikiem,
wprowadź jego dokładną treść do wskazanego pliku; nie przeprojektowuj go.
Nie uznawaj starego opisu automatyzacji w AGENT_PIPELINE za implementację.
Sprawdź kolizję identyfikatora zadania; nie nadpisuj istniejącego tasku.

Zapisz rzeczywisty BASE_COMMIT. Nie resetuj repo i nie nadpisuj cudzych
zmian. Nowa gałąź wychodzi z integration, PR targetuje integration.
Nie powtarzaj testu połączenia #35 ani #37.

2. CEL

Zaimplementuj kontroler zgodnie z całym projektem 002A:
READY -> Cursor -> CI i Codex -> poprawki -> READY_FOR_OWNER,
osobny gate A do integration oraz osobny gate B dla promocji do main.
Domyślny tryb offline/dry-run. Flagi uruchamiania i merge domyślnie false.
Nie twórz funkcji biznesowych SkillCheck, SC-SALES-006B/C/D ani UI produktu.

3. ALLOWED_FILES

- tools/agent-pipeline/** — kontroler i adaptery Node.js 24
- tests/agent-pipeline/** — testy oraz dane syntetyczne
- .github/agent-pipeline/** — polityki, JSON Schema, prompty,
  przykładowa konfiguracja bez sekretów
- .github/workflows/agent-reconcile.yml
- .github/workflows/agent-verify.yml
- .github/workflows/agent-review.yml
- .github/workflows/agent-accept.yml
- .github/workflows/agent-promote.yml
- .github/workflows/agent-gates.yml — usunięcie pozornych zgód,
  wyjątku SC-OPS-001 i obejścia przez OPERATIONS; klasyfikacja
  narzędzi kontrolera jako OPERATIONS/L3 bez zwalniania z gates
- .github/workflows/checks.yml — tylko dołączenie testów kontrolera
- package.json — wyłącznie skrypty test:agent-pipeline i agent:dry-run
- AGENTS.md
- .cursor/rules/skillcheck-agent-pipeline.mdc
- docs/AGENT_PIPELINE.md
- docs/AGENT_WORKFLOW.md
- docs/sc-ops-002a-agent-orchestration.md — dokładny zatwierdzony projekt
- docs/sc-ops-002b-cursor-prompt.md — dokładny prompt
- docs/sc-ops-002b-handoff.md
- docs/sc-ops-002c-bootstrap-runbook.md
- docs/BACKLOG.md — wyłącznie zadania SC-OPS-002A/B/C

Preferuj moduły wbudowane Node i node:test, bez nowych zależności.
package-lock.json nie wymaga zmiany. Jeśli realizacja bez nowej
zależności nie jest możliwa, zgłoś konkretny blocker; nie poszerzaj
samodzielnie listy. Nie zmieniaj znaczenia SC-001–SC-020 ani SC-006.

4. KONTROLER I STAN

Napisz czystą funkcję przejść stanu oraz osobne adaptery efektów.
Issue to kontrakt, PR to raport; komentarze i labels nie są bazą zgód.
Zamrażaj kontrakt, ALLOWED_FILES, wymagane testy i hash wersji.
Tylko skonfigurowani autorzy i jawnie dopuszczony kontrakt mogą
otworzyć READY. Edycja kontraktu unieważnia start. Publiczny Issue
lub dowolne @mention nie może uruchamiać płatnej pracy.

Stan i journal utrwalaj na agent-state zgodnie z projektem:
append-only historia, atomowa aktualizacja ref bez force,
porównanie poprzedniego HEAD, konflikt wymaga ponownego odczytu.
Testy używają izolowanego lokalnego git, nie zdalnej gałęzi.
Klucze operacji muszą uwzględniać repo/task/revision/H/B/action/round.
Najpierw zamiar, potem efekt, następnie odpowiedź i nowy stan.

Workflow z main: krótkie reconcile, schedule co 5 minut,
issue_comment jako sygnał i workflow_dispatch do odtworzenia.
Nie zakładaj terminowości cron ani dostarczenia każdego eventu.
Nie trzymaj runnera przez godzinę pracy Cursora lub oczekiwania na zgodę.
Jedna aktywna sesja per task, domyślnie jeden task w repo.

Retry i timeouty dokładnie z sekcji 4 projektu. Maksymalnie trzy
rundy poprawki i cztery review merytoryczne. Zmiana SHA nie zeruje
limitu. Nieznany wynik nieidempotentnego wywołania to BLOCKED,
nie uzasadnienie do kolejnego POST.

5. CURSOR

Implementuj adapter API v1 według aktualnego oficjalnego kontraktu.
Utrwal agentId przed utworzeniem; timeout/409 uzgadniaj przez GET.
Task branch tworzona z integration, workOnCurrentBranch=true
wyłącznie na task branch, autoCreatePR=false. PR tworzy kontroler.
Odrzuć main, integration, agent-state, fork i obcy repo ID.
Nie przekazuj envVars z agentId ani sekretów kontrolera do Cursora.

Poprawki przez runs istniejącej sesji. agent_busy -> oczekiwanie.
Niejednoznaczny timeout follow-up -> odczyt i uzgodnienie runs;
jeśli nie można przypisać jednoznacznie, DISPATCH_UNKNOWN/BLOCKED.
Faktyczny head, branch, diff i base sprawdzaj w GitHub.

6. CI I CODEX

Oddziel job CI, job modelu i job publikujący wyniki. Kod sterujący,
prompty i schematy wyłącznie z zatwierdzonego policy_sha na main.
Nigdy nie uruchamiaj npm lub kodu PR z credentialami kontrolera.
Nie używaj pull_request_target do wykonania head.

CI na nowym runnerze, bez sekretów, read-only token,
persist-credentials=false. Lista obowiązkowych komend z zaufanej
polityki; zmieniony workflow PR nie może usuwać bramek.

Review przez przypięty do pełnego SHA openai/codex-action,
ustaloną wersję CLI i read-only sandbox. Zweryfikuj SHA i wejścia
action w źródle; nie wymyślaj ich. Klucz OpenAI tylko wejściem action.
Nie dawaj modelowi praw publikacji ani merge.
Użyj schema wyniku opisanej w sekcji 6 projektu, włącznie z H/B,
contract_hash, request_id, acceptance_checks, findings i limitations.

Walidator wyniku jest deterministyczny. Nie traktuj sukcesu procesu,
emoji, ciszy bota ani „no major issues” jako PASS. Obowiązkowe
niewykonane testy i luki dowodowe blokują pełne PASS.
Artefakt przyjmuj tylko z oczekiwanego workflow/run/attempt/policy_sha.
Required checks publikuje odrębna tożsamość kontrolera.
Nowe H/B/kontrakt/policy unieważnia poprzedni wynik i prośbę o zgodę.

7. ZGODY I MERGE

Wdrożeniowa konfiguracja dwóch środowisk powstaje tylko jako runbook:
owner-acceptance oraz production-approval, właściciel jako jedyny
required reviewer, bez bypass i self-review. Workflow inicjuje App.
Nie zakładaj, że komentarz z loginem właściciela dowodzi kliknięcia
człowieka: integracja może publikować pod jego kontem.

Implementuj osobny niezmienny request_id/digest i zakres A/B.
Przed prośbą utrwal H/B, kontrakt, manifest, policy i dowody.
Po zgodzie sprawdź jej pochodzenie przez natywny mechanizm GitHuba,
bieżącą konfigurację recenzenta, workflow/ref/run/attempt i zakres.
GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals ma potwierdzić
state=approved, właściwe user.id/type i environments[].id/name.
Tylko run_attempt=1; rerun wymaga nowego request_id i nowego run_id.
Brak dowodu lub sprzeczność blokuje zgodę. Nie zastępuj jej komentarzem.

Zmiana SHA, upływ ważności, odmowa lub rerun unieważniają zgodę.
Zgoda A nigdy nie odblokowuje B. Job zgody jedynie wystawia dowód;
decyzję o efekcie wykonuje kontroler po ponownym sprawdzeniu.

Implementuj adapter merge za osobną flagą false. Globalna
serializacja, aktualne H/B, expected head SHA i obowiązkowy preflight
zabezpieczeń. Nie deklaruj ochrony base samym parametrem head SHA.
Bez potwierdzonej wyłączności zapisów gałęzi nie ma auto-merge.
Promotion wyłącznie integration tego samego repo -> main.
Runbook opisuje osobne rulesets writers-only i quality-gates;
wyjątek dla App dotyczy wyłącznie writers-only. Quality-gates nie ma
bypass. Bieżący preflight używa Administration:read, nigdy write.

Nie implementuj ogólnego wykonawcy migracji produkcyjnych.
Gate B odnosi się do jawnego manifestu i zatwierdzonego runbooku.
Brak runbooku blokuje wdrożenie. Sam merge nie oznacza DONE.

8. POWIADOMIENIA

Jeden raport per Issue/PR i trwałe notification_id/outbox.
Powiadomienia READY_FOR_OWNER, READY_FOR_PROD, BLOCKED i DONE
mają SHA, wynik, link do dowodów i właściwego działania.
Adresat tylko z zatwierdzonej konfiguracji.
Awaria powiadomienia nie zmienia zgód ani wyników.

Do runbooku dodaj dokładny prompt monitora ChatGPT co godzinę:
czyta stan GitHuba i journal, streszcza nowe istotne stany,
podaje link do natywnej zgody; nie uruchamia agentów i nie scala.
Nie obiecuj exactly-once dostarczenia w ChatGPT ani stale działającego
czatu. Nie twórz teraz tej automatyzacji.

9. TESTY

Wszystkie 12 grup testów z sekcji 12 projektu są obowiązkowe.
Testy offline nie wywołują prawdziwych Cursor/OpenAI/GitHub mutations.
Pokaż test dwóch niezależnych procesów konkurujących o stan.
Uwzględnij utratę odpowiedzi po przyjętym żądaniu, podrobione źródło
review/checka, changed head/base podczas zgody, workflow rerun,
fork integration, brak ochrony i oba wyłączniki.

Na Node 24 wykonaj:
- npm ci
- npm run test:agent-pipeline
- npm run agent:dry-run -- --fixture complete-cycle
- npm run typecheck
- npm run build

Nowy dry-run musi przejść pełny symulowany cykl z jedną poprawką,
zatrzymaniem A i B, bez jakichkolwiek zewnętrznych efektów.
Sprawdź składnię workflow oraz model uprawnień i ALLOWED_FILES.
Dotychczasowych testów verify nie usuwaj; dodaj testy kontrolera.
Jeżeli zmieniasz zachowanie workflow verify, wykonaj również jego
dotychczasowe kontrole albo jawnie wykaż każdą niewykonaną.

Brak sekretów nie blokuje testów offline. Prawdziwe API, zgody,
ochrona gałęzi, monitor ChatGPT i wdrożenie pozostają NOT RUN
do etapu 002C. Testy mocków nie są testem działającej integracji.

10. ZAKAZY I PRZEKAZANIE

Nie uruchamiaj innych agentów, nie publikuj @cursor/@codex,
nie zmieniaj kont, ochrony gałęzi, środowisk, sekretów lub budżetów.
Nie włączaj flag, nie uruchamiaj płatnych API ani test:live.
Nie wykonuj migracji, merge ani wdrożenia.

Przygotuj commit i draft PR do integration z metadanymi wymaganymi
przez aktualne repo. OWNER_APPROVAL i PRODUCTION_APPROVAL pozostają
PENDING, REVIEW_VERDICT=PENDING, PROMOTION=NO. Opis nie udaje zgody.
Opublikowanie draft PR jest dozwolone w tym zadaniu wykonawczym;
uruchomienie botów review/implementacji wymaga osobnego przekazania
przez koordynatora. Jeśli istniejąca konfiguracja uruchamia review
automatycznie, zaznacz ten znany efekt przed publikacją.

Zapisz handoff i runbook bootstrapu. Wyraźnie oddziel:
IMPLEMENTED, VERIFIED_OFFLINE, NOT_CONFIGURED, NOT_RUN.
Zakończ raportem:
TASK
STATUS: REVIEW
BRANCH
BASE_COMMIT
COMMIT
PR
CHANGED FILES
DB / MIGRATIONS: brak
WYKONANE KONTROLE — rzeczywiste wyniki
ODCHYLENIA OD PROJEKTU
WARUNKI AKTYWACJI
NEXT ACTION

Po raporcie wygeneruj pełny prompt review dla Codexa, z rzeczywistym
PR i SHA, zapisz go w handoff. Koordynator przekaże go przez GitHub.
Nie proś właściciela o przenoszenie raportu do innego czatu.
Następny krok to review implementacji, potem odrębny 002C bootstrap;
nie uruchomienie automatyzacji ani kolejnego modułu sprzedażowego.
```
