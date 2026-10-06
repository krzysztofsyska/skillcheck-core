# SC-OPS-002A — projekt automatycznej współpracy agentów

Data: 2026-10-06. Wykonawca: Codex. Poziom: L3. Status: REVIEW — projekt, niewdrożony.
Repozytorium: krzysztofsyska/skillcheck-core (publiczne, ID 1043384454).
Baza odczytu: main i integration = 579da382f976971392bc15239fded5417945c0f0.
Identyfikatory SC-OPS-002A/B/C są propozycją dla tego pakietu; przy publikacji sprawdzić kolizję w backlogu.

## 1. Wynik i granice zadania

Przeczytano AGENTS.md, docs/AGENT_PIPELINE.md, docs/AGENT_WORKFLOW.md, checks.yml i agent-gates.yml na wskazanej bazie. Działające wywołania Cursor w Issue #35 i Codex w PR #37 są dowodem integracji GitHub, nie dowodem całego automatycznego cyklu. Nie powtarzano tych testów.

Aktualne workflow nie sterują przekazywaniem pracy. Pola APPROVED/PASS w opisie PR nie dowodzą zgody ani review. Agent Gates dopuszcza wyjątek SC-OPS-001 i omijanie klasyfikacji deklaracją OPERATIONS. Odczyt gałęzi nadal wskazuje protected=false dla main i integration.

Powstaje projekt, prompt implementacyjny i plan uruchomienia. Nie wykonano implementacji, testów implementacji, publikacji do GitHuba, ustawień kont, uruchomienia agentów, merge ani wdrożenia.

## 2. Wybrany mechanizm i potwierdzone możliwości

GitHub pozostaje kontraktem zadania i miejscem raportów. Deterministyczny kontroler w GitHub Actions wykonuje przekazania w imieniu koordynatora. ChatGPT ustala zakres i przedstawia wyniki; aktywny czat nie jest serwerem stale nasłuchującym zdarzeń.

Weryfikacja dokumentacji:

- Cursor API v1: utworzenie agenta, kolejne runs tej samej sesji oraz odczyt wyników. Możliwe jest własne agentId przy utworzeniu. Kolejna aktywna praca zwraca agent_busy. Jest to public beta; v1 nie ma jeszcze webhooków. Wybrano odczyt stanu, nie nieistniejący webhook. Dostępu konta do API i klucza nie testowano [S1].
- Codex GitHub Action uruchamia review w Actions; CLI obsługuje wynik według JSON Schema. Wybrano kontrolowany wynik JSON zamiast parsowania swobodnego komentarza bota. To osobny tryb od już podłączonego GitHub Code Review; wymaga konfiguracji klucza API i kosztów API. Nie zakładamy, że abonament ChatGPT je pokrywa [S2, S3].
- GitHub ma środowiska z wymaganym recenzentem. Publiczny charakter tego repo pozwala zastosować ten mechanizm na aktualnych planach opisanych w dokumentacji [S4].
- ChatGPT obsługuje zadania harmonogramowe oraz, na uprawnionych kontach, zdarzenia GitHuba. Dla wersji pierwszej wybieramy osobny monitor co godzinę: obejmuje również błąd przed powstaniem PR. Zdarzenia PR mogą być późniejszą optymalizacją; nie są wymogiem pierwszej wersji [S7].

Nie wprowadzamy nowej bazy Supabase, publicznego endpointu aplikacji ani nowego serwera. Kod kontrolera trafia do tego samego repo, ale działa poza aplikacją SkillCheck.

## 3. Przebieg

1. Koordynator publikuje kontrakt zatwierdzonego zadania w Issue. Kontrakt zawiera TASK, LEVEL, SCOPE, ALLOWED_FILES, zależności, kryteria i testy. READY oznacza wcześniejsze upoważnienie do pracy, a nie upoważnienie do scalenia. Nie uruchamiamy dowolnego nowego Issue ani dowolnego komentarza z @cursor.
2. Kontroler utrwala wersję kontraktu i jego SHA-256 oraz dowód dopuszczenia do READY. Przyjmuje zgłoszenie tylko od skonfigurowanej tożsamości koordynatora albo właściciela, na podstawie tożsamości GitHuba pobranej z API. Edycja treści po zamrożeniu unieważnia READY; sama etykieta nie upoważnia do pracy.
3. Z aktualnego integration kontroler tworzy jedną gałąź zadania. Cursor dostaje jej nazwę i zamrożony kontrakt przez API. Nie dostaje sekretów kontrolera ani produkcji.
4. Po zakończeniu pracy kontroler sprawdza faktyczne commity, zakres plików i raport. Tworzy albo odnajduje jeden draft PR do integration. Identyfikuje go przez repo ID, head branch, base branch i task ID, nie przez sam tytuł.
5. Dla aktualnej pary commitów H (head) i B (base) uruchamia niezależnie zaufane CI oraz Codex review. Wynik przypisuje do H, B, kontraktu i wersji polityki.
6. Uwagi albo naprawialny błąd CI trafiają automatycznie do tej samej sesji Cursora. Poprawka musi pozostać na tej samej gałęzi i w ALLOWED_FILES. Kolejny commit rozpoczyna nowe CI/review.
7. Dopiero pełne PASS i zielone obowiązkowe CI prowadzą do READY_FOR_OWNER. Kontroler otwiera prośbę o zgodę A. Właściciel dostaje podsumowanie i link do właściwego zatwierdzenia w GitHubie.
8. Po zgodzie A oraz ponownym sprawdzeniu aktualności kontroler może scalić do integration. Stan ACCEPTED nie oznacza produkcji.
9. Powstaje oddzielny PR integration -> main z manifestem wydania, testami i instrukcją wdrożenia. Jego gotowość otwiera zgodę B. Do czasu tej zgody nie ma merge do main ani produkcyjnych operacji.
10. Po zgodzie B wolno wykonać wyłącznie zakres z manifestu wydania. DONE wymaga potwierdzenia wdrożenia i smoke testów; sam merge to stan MERGED_AWAITING_DEPLOYMENT. Automatyzacja nie wymyśla poleceń migracji z opisu PR.

Statusy główne pozostają zgodne z AGENTS: BACKLOG, READY, BUILDING, PR_REVIEW, FIXING, READY_FOR_OWNER, ACCEPTED, READY_FOR_PROD, DEPLOYING, DONE, BLOCKED. Podstany techniczne: DISPATCH_PENDING, DISPATCH_UNKNOWN, REVIEW_STALE, WAITING_CI, APPROVAL_STALE, MERGED_AWAITING_DEPLOYMENT. FAIL lub PASS WITH FIXES nigdy nie otwiera zgody.

## 4. Trwały stan, kolejność i ponowienia

Dedykowana gałąź agent-state przechowuje tylko dziennik operacji i projekcję stanu. Nie wolno jej scalać do aplikacji. Zapis tylko tożsamością kontrolera; bez force push i usuwania. Dziennik nie zawiera kluczy, CV ani danych kandydatów. Publiczne repo oznacza publiczną historię tego dziennika.

Każdy rekord: schema_version, repository_id, task_id, issue_number, task_revision, contract_hash, state_revision, base_sha, head_sha, policy_sha, state, cursor_agent_id, cursor_run_id, pr_number, review_request_id, review_run_id/attempt, ci_run_id/attempt, repair_round, approval_request_id, notification_id, last_transition_at, blocked_reason. Brak identyfikatora zapisujemy jako null, nie wymyślamy numerów.

Journal zawiera poprzedni hash, klucz operacji, stan before/after, identyfikatory efektów i czas UTC. Atomowy zapis: nowy commit z poprzednim HEAD agent-state jako rodzicem oraz aktualizacja ref bez force. Konflikt non-fast-forward oznacza ponowny odczyt i obliczenie przejścia, nigdy nadpisanie. Test dwóch niezależnych procesów musi wykazać jednego zwycięzcę. Sam concurrency w Actions nie jest dowodem trwałości ani kolejką wszystkich zdarzeń.

Kontroler robi krótkie przebiegi: issue_comment jako sygnał oraz schedule co 5 minut jako uzgadnianie stanu; workflow_dispatch jako odtworzenie/próba kontrolowana. Harmonogram GitHuba nie ma gwarantowanego czasu wykonania. Każdy tick ponownie czyta stan GitHuba i oczekujące operacje. Nie utrzymuje runnera śpiącego przez czas pracy agenta lub oczekiwania na zgodę. Jedna aktywna praca na task, domyślnie jedna praca agenta w repo. W MVP nie uruchamiamy równoległych zadań o nachodzącym zakresie.

Klucz semantyczny operacji: repository_id/task_id/task_revision/H/B/action/round. Event ID służy do audytu, ale nie zastępuje tego klucza. Najpierw zapis zamiaru DISPATCH_PENDING, dopiero potem wywołanie zewnętrzne, następnie zapis odpowiedzi.

- Utworzenie Cursor: przed POST utrwalić deterministyczne bc-UUID jako agentId; timeout -> GET tego ID, 409 -> potwierdzić zgodność istniejącego agenta. Nie generować kolejnego ID dla tej samej operacji. Nie wysyłać envVars razem z agentId.
- Follow-up Cursor: utrwalić listę dotychczasowych run IDs i znacznik operacji w prompcie. Brak udokumentowanego klucza idempotencji follow-up oznacza brak ślepego retry. Po timeout odczytać nowe runs. Jeden jednoznaczny run własnej operacji można przypisać; brak dowodu lub konkurencyjny run -> DISPATCH_UNKNOWN/BLOCKED. Nie deklarować exactly-once dla nieidempotentnego API.
- Utworzenie PR/komentarza: przed ponowieniem szukać trwałego znacznika i tożsamości autora. Nie ufać markerowi w komentarzu obcego konta. Dopuszczalne jest odtworzenie projekcji; niedopuszczalne podwójne uruchomienie kodowania.
- Bezpieczne odczyty i jednoznacznie odrzucone żądania: maksymalnie trzy próby transportowe łącznie, opóźnienia 1 i 5 minut z jitter; honorować Retry-After. 401/403 -> BLOCKED_CONFIGURATION. Nie naprawiać przez poszerzanie uprawnień.
- Follow-up 409 agent_busy: czekać na istniejący run, nie zużywać rundy poprawki. Domyślne timeouty: build 120 min, CI/review 45 min, oczekiwanie na zgodę 72 h. Osiągnięcie limitu -> BLOCKED, bez ponownego naliczenia pracy w ciemno.
- Najwyżej 3 rundy poprawek i 4 review merytoryczne na wersję kontraktu. Zmiana SHA nie zeruje budżetu tasku. Dwie identyczne uwagi po poprawkach lub zmiana zakresu -> BLOCKED. Nowy budżet tylko jawnie zatwierdzonym wznowieniem.
- Dostawcy otrzymują ograniczenia budżetu skonfigurowane poza kodem. Lokalne limity rund nie stanowią gwarancji konkretnej kwoty.
- AGENT_PIPELINE_ENABLED=false zatrzymuje nowe efekty, pozostawiając odczyt i raport. AGENT_PIPELINE_MERGE_ENABLED=false niezależnie blokuje merge. Domyślnie obie flagi są false.

## 5. Adapter Cursor

Kontroler tworzy branch feat/<task-id>-<slug> wyłącznie z zamrożonego integration SHA. Wywołanie utworzenia: jeden repo URL z allowlisty, startingRef = ta gałąź, workOnCurrentBranch=true, autoCreatePR=false, zapisane agentId. Warunek przed wywołaniem bezwzględnie odrzuca main, integration, agent-state, fork i nieoczekiwany repository_id. PR zakłada kontroler, aby jawnie ustawić base=integration [S1].

Własny prompt Cursora nie daje uprawnienia do zmiany zakresu. Po zakończeniu run sprawdzenie przez GitHub head SHA i listy plików jest obowiązkowe. Dane git zwracane przez Cursor mogą odzwierciedlać aktualny stan sesji, nie historyczny snapshot konkretnego run; przypisanie wyniku musi uwzględniać latestRunId i czas zakończenia [S1].

Poprawki: POST runs do tej samej sesji, tylko kiedy nie ma aktywnego run. Prompt zawiera review_request_id, aktualne H/B, uwagi z lokalizacjami, wyniki CI oraz niezmieniony ALLOWED_FILES. Wygaśnięcie sesji w MVP powoduje BLOCKED z gotowym wznowieniem, nie ciche utworzenie kilku nowych agentów.

## 6. CI, review i granica zaufania

Sterujące workflow i polityki ładowane wyłącznie z zatwierdzonego main; dla uruchomienia utrwalać dokładny policy_sha. Nigdy nie wykonujemy kodu z PR w uprzywilejowanym jobie. Wejścia użytkownika i tekst modelu są danymi; nie interpolować ich do shell, eval, dynamicznego workflow lub nazw środowisk.

Zaufane sterowanie działa przez workflow na main i środowisko agent-control ograniczone dokładnie do main. Nie używać pull_request_target z checkout/uruchamianiem kodu head. Fork PR i obcy actor nie uruchamiają płatnej pracy. Zmiany .github/**, narzędzi kontrolera, schematów review i polityk wymagają L3 oraz osobnego review; nie mogą wpływać na swój własny gate.

Rozdzielić joby i poświadczenia:

- Kontroler: GitHub App token tylko dla tego repo, krótkotrwały, bez administration; klucz Cursor tylko w adapterze. Nigdy w jobie modelu lub npm z PR.
- CI: świeży runner, read-only GitHub token, persist-credentials=false, bez sekretów środowisk i dostawców. Uruchamia kod H według listy wymaganych komend z zaufanej polityki. Zmiana checks.yml w PR nie usuwa obowiązkowych testów.
- Codex: świeży runner, przypięty SHA oficjalnej action i ustalona wersja CLI, read-only sandbox, bez tokenu zapisu GitHuba, klucza Cursor i sekretów produkcji. Klucz OpenAI tylko wejściem action, nie job-level env. Osobny katalog wejścia z zamrożonym diffem/kodem; konfiguracja i instrukcje kontrolera z policy_sha. Instrukcje dodane w PR są materiałem review, nie uprawnieniem. Nie wykonywać install/testów kodu PR w tym jobie. Wynik modelu pozostaje niezaufaną treścią do walidacji.
- Publikacja: osobny job kontrolera sprawdza pochodzenie run, workflow ID, policy_sha, run attempt i integralność artefaktu. Nie wykonuje poleceń z artefaktu. Tworzy komentarz i check przypisany do własnej GitHub App.

Review JSON: schema_version, request_id, repository_id, pr_number, head_sha, base_sha, contract_hash, verdict (PASS/PASS_WITH_FIXES/FAIL), acceptance_checks[], findings[] (id, severity, path, line, description, required_fix), limitations[]. Wszystkie wymagane kryteria muszą mieć ocenę; niewykonany obowiązkowy test/bloker nie może być oznaczony PASS. Walidator odrzuca obce SHA, brak pól, obce request_id i nieznany enum. Nie konwertuje tekstu „no major issues”, reakcji 👍, zielonego procesu CLI ani braku komentarzy na PASS.

CI jest przypisane do H/B i zaufanego workflow. Dopuszczalne wyłącznie success; cancelled, skipped, neutral, timeout, brak joba i oczekiwanie nie są PASS. Obowiązkowy zestaw obejmuje dotychczasowy verify oraz testy kontrolera. Kontroler weryfikuje identyfikator workflow/run, nie samą nazwę checka. Dowolny PR może próbować nadać identyczną nazwę checkowi GitHub Actions.

Każda zmiana head lub base, kontraktu albo policy_sha unieważnia review, CI i przygotowaną zgodę. Stare wyniki mogą zostać w historii, ale nie odblokowują kolejnego commita. Dla task PR aktualizacja integration wymaga aktualizacji gałęzi, nowego CI/review i nowego przedstawienia zakresu, jeżeli poprzednia zgoda straciła aktualność.

## 7. Dwie zgody właściciela

Nie przyjmujemy jako zgody komentarza bota, pola PR, reakcji, label ani samego author_association. Narzędzia koordynatora mogą publikować pod kontem użytkownika, dlatego nawet komentarz z loginem właściciela nie powinien samodzielnie otwierać produkcji.

Wybrana zgoda to natywne zatwierdzenie oczekującego joba środowiska GitHub. Dwa stałe środowiska: owner-acceptance i production-approval. Jedyny required reviewer: krzysztofsyska, ID 222297538 (ID odczytane z GitHub; ponownie potwierdzić przy konfiguracji). Zakaz obejścia przez admina; prevent self-review. Workflow proszący o zgodę uruchamia kontroler jako GitHub App, aby właściciel mógł go zatwierdzić. Agentom nie udostępniać tokenów właściciela zdolnych do zatwierdzania tych jobów. Jeżeli istniejąca integracja dysponuje takim zakresem, ograniczyć go przed aktywacją albo nie deklarować odporności na zatwierdzenie przez agenta.

Prośba ma unikalny request_id i niezmienny digest kanonicznego JSON:

- A: repo ID, task, PR, target integration, head H, base B, contract_hash, policy_sha, review i CI run IDs/attempts/digests, zakres plików, operacja merge.
- B: promotion PR, target main, integration H, main B, policy_sha, zbiór tasków i ich zgód A, manifest wydania, jego hash, lista dokładnych operacji i środowisk, dowody CI/review, rollback i smoke tests. Lista sekretów może wskazywać nazwy, nigdy wartości.

Podsumowanie i link do niezmiennego manifestu muszą być dostępne przed kliknięciem. Job zgody nie wdraża niczego i nie scala; po zatwierdzeniu emituje dowód wykonania dla request_id. Kontroler potwierdza konfigurację required reviewers i brak bypass, właściwy workflow/ref/run attempt i oczekiwane środowisko. Autora ustala przez GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals: state=approved, user.id=222297538, user.type=User oraz zgodne environments[].id/name [S9]. Brak wpisu, odrzucenie, nieznane środowisko lub niejednoznaczność oznacza odmowę. Treść comment jest wyłącznie opisem. Odczyt tego endpointu dla istniejącego run 37468845703 zwrócił []; potwierdza dostęp do odczytu, nie test rzeczywistej zgody.

Nie odczytywać autora z JSON wygenerowanego przez model. Akceptować tylko nowy run_id i run_attempt=1; rerun zawsze unieważnia zgodę i wymaga nowego workflow_dispatch z nowym request_id/run_id. Historia approvals nie daje podstawy do przeniesienia zgody między próbami. Dowód zgody wiązać z digestem wejść zarejestrowanym przed rozpoczęciem run, a nie aktualizowanym opisem PR.

Nowe H/B/policy/manifest podczas oczekiwania -> anulować starą prośbę, oznaczyć APPROVAL_STALE. Ponowne uruchomienie workflow nie dziedziczy zgody; każda próba wymaga nowego request_id. Odrzucenie lub brak odpowiedzi nie upoważnia do żadnej operacji. Zgoda A nigdy nie spełnia B.

## 8. Zabezpieczenia gałęzi i merge

Wymagania konfiguracji przed włączeniem:

- main i integration: PR required, brak force push/usuwania, zasady także dla admina; bez trwałego wyjątku SC-OPS-001. Wymagane checks: sc-agent/ci, sc-agent/review, sc-agent/owner-acceptance dla integration oraz sc-agent/ci, sc-agent/review, sc-agent/production-approval, sc-agent/promotion-scope dla main. Źródło checks przypięte do dedykowanej GitHub App, nie „any source” [S5].
- Strict/up-to-date checks. Wyłączyć inne automatyczne merge ścieżki. Publikowanie checka z tej samej nazwie przez Buildera/GITHUB_TOKEN nie odblokowuje merge.
- Zastosować osobne rulesets: writers-only ogranicza aktualizacje main/integration do GitHub App kontrolera (jej wyjątek tylko w tym ruleset, tryb PR-only); quality-gates zawiera wymagane PR/checks, strict i zakaz force/delete, bez listy bypass. Dla agent-state writers-only dopuszcza bezpośredni zapis App, a osobny ruleset bez bypass zabrania force/delete. Rozdzielenie jest konieczne: wyjątek autora zapisu nie może omijać jakości i zgód. GitHub dokumentuje GitHub Apps i tryb PR-only jako mechanizmy rulesets [S10]. Zweryfikować kombinację na tym repo w bootstrapie. Jeśli nie jest skuteczna, auto-merge pozostaje wyłączony; nie zastępować jej instrukcją w AGENTS.
- main przyjmuje wyłącznie PR z integration tego samego repository_id; nazwa integration w forku nie wystarcza. Promotion scope ma obejmować wszystkie zmiany wydania, a nie tylko ostatni moduł.
- agent-state: zapis kontrolera, brak force/delete, nie jest gałęzią aplikacji. Poświadczenie podpisujące stan nie trafia do agentów.

W MVP jeden globalny szereg operacji merge. Podczas końcowego sprawdzenia i wywołania merge kontroler trzyma trwałą blokadę serializacji; żaden inny proces kontrolera nie zmienia main/integration. REST merge wysyła oczekiwany head SHA. Sam ten parametr nie chroni base — ochronę daje wyłączność zapisów, globalna kolejność i reguły strict. Brak potwierdzonej wyłączności wyłącza auto-merge.

Kontroler tuż przed merge ponownie sprawdza H/B, aktualne dowody, digest zgody, reguły ochrony i obie flagi. Po timeout odczytuje merged/merge_commit_sha, nigdy nie zakłada sukcesu ani nie wykonuje drugiego merge na zmienionym PR. Każda awaria pomiędzy zgodą a merge jest odtwarzana z dziennika, nie z tekstu raportu.

## 9. Produkcja i Vercel

W tym projekcie nie dodajemy uniwersalnego wdrażania Supabase ani migracji produkcyjnych. Przygotowujemy gate i kontrakt przekazania do zatwierdzonego runbooku. Bez konkretnego runbooku produkcja pozostaje BLOCKED.

Sprawdzić osobno ustawienie Production Branch w Vercel: docelowo tylko main. integration oraz gałęzie tasków nie mogą uruchamiać produkcji ani otrzymywać produkcyjnych sekretów. Jeśli merge main automatycznie wdraża Vercel, zgoda B musi wyraźnie obejmować ten efekt i wskazywać oczekiwany commit. Nie dokładać drugiego deploy tego samego commita. Ochrona GitHub environment nie blokuje sama z siebie niezależnego deploy Vercel.

Brak dostępu do konfiguracji Vercel i zakresów zainstalowanych aplikacji w tym audycie nie jest wynikiem PASS. Ich konfiguracja to warunek uruchomienia, nie powód do blokowania pisania kodu w trybie offline.

## 10. Powiadomienia i ChatGPT

Kontroler utrzymuje jeden aktualizowany raport per Issue/PR i dziennik ważnych przejść. Przy READY_FOR_OWNER, READY_FOR_PROD, BLOCKED i DONE publikuje powiadomienie z notification_id, taskiem, SHA, wynikiem i linkiem do działania. Odbiorca właścicielski jest brany ze zweryfikowanej konfiguracji, nie z tekstu Issue. Nie wysyła wiadomości kandydatom ani klientom.

Native task w ChatGPT, utworzony dopiero w etapie konfiguracji: co godzinę odczytuje repo i kontrolny dziennik, streszcza nowe stany wymagające uwagi, podaje link do zgody GitHuba. Nie uruchamia Cursora, nie scala i nie traktuje odpowiedzi „tak” w czacie jako dowodu zgody środowiska. Jedyny mechanizm zatwierdzania pierwszej wersji to linkowane zgody GitHuba — nie kopiowanie promptów.

Dedup: notification_id = hash(task/state_revision/recipient/kind). Kontroler ma trwały outbox dla GitHub; po timeout uzgadnia komentarze po markerze i autorze. Native ChatGPT monitor przechowuje ostatnio zgłoszone ID w kontekście zadania. Nie deklarujemy dokładnie jednokrotnej dostawy do ChatGPT: po utracie kontekstu możliwy duplikat, wiadomość niesie to samo ID. Niedostarczona wiadomość nie gubi raportu GitHub i nie zmienia stanu zgód.

Opcjonalny późniejszy monitor zdarzeń PR wymaga sprawdzenia schematu dostępnego konta i filtra repo/zarządzanych PR. Nie przełączamy na niego bez osobnego ustawienia; nie mieszamy event trigger i harmonogramu w jednym zadaniu [S7].

Gotowy prompt przyszłego monitora (nie został utworzony ani włączony):

```text
Co godzinę sprawdź kontrolny journal na gałęzi agent-state oraz
powiązane Issue i PR w krzysztofsyska/skillcheck-core. Czytaj wyłącznie
zadania zarejestrowane w journal, a nie każdy publiczny komentarz.
Zweryfikuj aktualne SHA i dowody w GitHub. Powiadom Krzysztofa po polsku
o nowych READY_FOR_OWNER, READY_FOR_PROD, BLOCKED i DONE.
Podaj task, rzeczywisty wynik, SHA, notification_id oraz link do
konkretnej prośby o zatwierdzenie lub raportu błędu.
Pomiń notification_id już zgłoszone w kontekście tej automatyzacji.
Jeśli nic nowego nie wymaga uwagi, nie wysyłaj powiadomienia.
Brak dostępu/nieaktualny journal zgłoś jako błąd monitorowania;
nie domyślaj się sukcesu. Po utracie historii nie ukrywaj niepewności.
Nie uruchamiaj agentów, nie publikuj ich wywołań, nie zmieniaj zgód,
nie scalaj, nie wdrażaj i nie przyjmuj „tak” w czacie jako zgody GitHuba.
```

Konfiguracja monitora: Europe/Warsaw, co godzinę, wykonanie chmurowe z dostępem do GitHuba; bez dostępu do lokalnego komputera. Kanał powiadomienia należy włączyć w ustawieniach konta. Powiadomienia GitHub również wymagają poprawnych ustawień odbiorcy. Dostawa w ciągu godziny jest celem harmonogramu, nie gwarancją SLA.

## 11. Podział prac

SC-OPS-002B — Cursor: implementacja kontrolera, adapterów, schematów, testów i dokumentacji, domyślnie dry-run, bez włączania usług. Codex: review kodu na rzeczywistym SHA. Nie wdrażać tego kodu automatycznie samym workflow, który dopiero powstaje.

SC-OPS-002C — właściciel + koordynator: jednorazowy bootstrap po review. Obejmuje GitHub App, ograniczenia tożsamości, środowiska zgód, ochronę gałęzi, klucze i budżety API, sprawdzenie Vercel, monitor ChatGPT, kontrolowany test całej pętli na osobnym zadaniu. Część wymaga uprawnień administracyjnych; nie wymaga przenoszenia raportów między agentami.

Bootstrap ma własne jawne zatwierdzenie instalacji mechanizmu. SC-OPS-002B najpierw przechodzi dotychczasowe review i akceptację do integration, następnie osobną promocję do main, nadal z flagami false. Nie dodawać furtki pozwalającej nowemu workflow samodzielnie zatwierdzić swój pierwszy merge.

Konfiguracja zewnętrzna wymagana od właściciela:

| Element | Ustawienie/docelowy warunek |
| --- | --- |
| GitHub App | Instalacja tylko w skillcheck-core; poświadczenia niedostępne Builderowi. Contents, PR, Issues, Checks i Actions: write dla kontrolowanych efektów. Administration: read wyłącznie do bieżącego preflight ochrony (nigdy write); odczyt środowisk zgód zgodnie z wymaganiami API. Bez praw zatwierdzania jako właściciel. Uprawnienia potrzebne do CI/modelu są osobnymi, węższymi tokenami. |
| agent-control | Dostęp tylko z main; klucze kontrolera i dostawców tylko w zaufanych jobach. Brak sekretów w repo/PR/artifactach. |
| Dwie zgody | Required reviewer = właściciel; brak self-review i bypass; brak uprawnień agentów do zatwierdzenia. |
| Gałęzie | Zabezpieczenia z sekcji 8, kontrola rzeczywistego dostępu Cursor/GitHub Apps. |
| Cursor API | Klucz i zatwierdzony budżet; kontrakt v1 sprawdzony na koncie przed aktywacją. |
| Codex Action | Klucz projektu OpenAI, model z dozwolonej listy i limit wydatków; nie zakładać dostępności z samej subskrypcji. |
| ChatGPT | Monitor w trybie chmurowym i powiadomienia konta; test dostarczenia wyniku. |
| Vercel | main jako jedyne źródło produkcji; izolacja preview; zatwierdzony runbook. |

Preflight ma być fail-closed: bieżący odczyt rulesets, ochrony gałęzi i środowisk jest obowiązkowy przed otwarciem i wykorzystaniem zgody. Brak uprawnień lub niezgodna konfiguracja blokuje auto-merge. Ręczny snapshot nie zastępuje bieżącego odczytu. Nie przyznawać administration/write, żeby preflight przeszedł.

## 12. Wymagane dowody odbioru

Lokalnie/offline w 002B, na mockach i izolowanym git:

1. Dwa zdarzenia i dwa procesy -> jeden task/run; konflikt zapisu stanu nie nadpisuje historii.
2. Awaria po zapisaniu zamiaru, po POST, przed zapisem odpowiedzi; odtworzenie bez podwójnego agenta. Nieznany follow-up pozostaje BLOCKED.
3. H1 review po H2 push oraz zmiana B/policy/kontraktu -> stare PASS i zgoda odrzucone.
4. Review JSON uszkodzone/podrobione/niepełne; test pominięty; workflow o tej samej nazwie z innego źródła -> brak PASS.
5. Treść APPROVED, spoofowany login/marker, zwykła reakcja i zgoda A użyta jako B -> odmowa.
6. Zmiana SHA podczas oczekiwania, rerun zgody, odmowa i timeout -> brak merge.
7. Fork integration, branch main dla Cursora, niezgodny zakres i wyjątek SC-OPS-001 -> odmowa.
8. Limit 3 poprawek; 401, 403, 409, 429, 5xx; wyłączone flagi; brak wymaganych sekretów; brak ochrony -> opisany stan, bez poszerzenia praw.
9. Kolejka merge nie dopuszcza zmiany base podczas operacji; timeout merge uzgadniany z GitHub.
10. Model/CI nie otrzymują credentiali kontrolera; tekst PR z poleceniem shell jest tylko danymi. Kontroler nie wykonuje plików z head.
11. Powiadomienia mają stałe ID; błąd powiadomienia nie otwiera gates i nie zatraca wyniku.
12. Odnowienie procesu odtwarza cały stan z agent-state; etykiety i treść PR nie są źródłem autoryzacji.

W 002C, dopiero po konfiguracji: rzeczywisty start API, jedna wymuszona poprawka, nowe SHA/review/CI, zatrzymanie przed A, merge tylko po A, zatrzymanie przed B, odmowa produkcji bez B, dostarczenie powiadomienia do ChatGPT. Testy izolowane, bez biznesowej bazy i bez publikacji aplikacji. Oddzielnie zatwierdzony test produkcyjnego runbooku. Niewykonane testy: NOT RUN, nigdy PASS.

## 13. Źródła

Odczyt 2026-10-06. Propozycje projektowe powyżej nie są deklaracją istniejących ustawień kont.

- S1: https://cursor.com/docs/cloud-agent/api/endpoints — endpointy i ograniczenia Cursor v1.
- S2: https://learn.chatgpt.com/docs/github-action — Codex Action, konfiguracja i bezpieczeństwo.
- S3: https://learn.chatgpt.com/docs/non-interactive-mode — sandbox i schema wyniku.
- S4: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments — required reviewers i ograniczenia.
- S5: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches — źródło required checks i strict.
- S6: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow — zdarzenia wywołane tokenami. Dlatego kontroler używa GitHub App, a nie polega na kaskadzie komentarzy GITHUB_TOKEN.
- S7: https://learn.chatgpt.com/docs/automations — harmonogram i zdarzenia, dostępność zależna od powierzchni/konta.
- S8: https://github.com/krzysztofsyska/skillcheck-core/tree/579da382f976971392bc15239fded5417945c0f0 — analizowany kod i dokumentacja.
- S9: https://docs.github.com/fr/rest/actions/workflow-runs?apiVersion=2026-03-10#get-the-review-history-for-a-workflow-run — endpoint approvals oraz pola user/environments/state (odczytana wersja dokumentacji z pełnym schematem odpowiedzi).
- S10: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository — oddzielne rulesets i uprawnienia GitHub Apps.

## 14. Raport

TASK: SC-OPS-002A (proponowany identyfikator)
STATUS: REVIEW
WYNIK: Projekt i prompt gotowe do oceny; nie jest to PASS wdrożonej automatyzacji.
BASE_COMMIT: 579da382f976971392bc15239fded5417945c0f0
BRANCH / COMMIT / PR: nie utworzono
DB / MIGRATIONS: brak
KONTROLE: odczyt instrukcji/workflow/GitHub i oficjalnej dokumentacji; analiza granic zaufania, aktualności zgód i odtwarzania operacji.
TESTY IMPLEMENTACJI: NOT RUN — implementacja nie powstała.
NEXT ACTION: Po zaakceptowaniu projektu przekazać SC-OPS-002B Cursorowi przez GitHub; bez ręcznego przeklejania raportów. Bootstrap usług i włączenie dopiero w SC-OPS-002C.
