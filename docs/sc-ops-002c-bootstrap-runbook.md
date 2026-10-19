# SC-OPS-002C — runbook bootstrapu obiegu agentów

Status tego dokumentu: instrukcja. Nie została wykonana w całości. Nie włącza flag, nie tworzy GitHub App, środowisk, rulesetów, sekretów, monitora ChatGPT ani wdrożenia. Odczytane dane konfiguracji są oddzielone od niewykonanych testów połączeń.

Warunek wejścia dla jednorazowego bootstrapu: SC-OPS-002B ma review PASS, OWNER ACCEPTANCE i jest na `integration`, a następnie osobna, zatwierdzona promocja `integration -> main` nadal z obiema flagami `false`. To akceptacja pierwszej instalacji/aktywacji kontrolera, nie zgoda na każdy późniejszy PR. Nowy workflow nie zatwierdza własnego pierwszego merge. Zgodnie z przyjętym PR #124 rutynowe scalenie do `integration` nie wymaga owner-acceptance, ale wymaga CI, niezależnego review i skutecznej ochrony gałęzi.

Potwierdzić ponownie przy konfiguracji: właściciel `krzysztofsyska`, GitHub user id `222297538`. Identyfikator repozytorium: `1043384454`.

## 1. GitHub App

Aplikacja instalowana tylko w `krzysztofsyska/skillcheck-core`. Poświadczenia niedostępne dla Cursora i dla joba modelu.

- Contents, Pull requests, Issues, Checks, Actions: write dla kontrolowanych efektów.
- Administration: read, wyłącznie do bieżącego preflightu ochrony. Nigdy write. Nie nadawać write, żeby preflight przeszedł.
- Brak uprawnień zatwierdzania środowisk jako właściciel.
- Tokeny CI i modelu są osobne i węższe niż token kontrolera.

## 2. Środowiska

| Środowisko | Kto zatwierdza | Zakres |
| --- | --- | --- |
| `agent-control` | brak recenzenta właściciela; dostęp workflow tylko z `main` | klucze GitHub App i Cursor |
| `agent-review` | brak recenzenta; dostęp workflow tylko z `main` | wyłącznie klucz projektu OpenAI dla joba modelu |
| `owner-acceptance` | jedyny required reviewer: właściciel | środowisko sprawdzane przez preflight; nie jest checkiem statusu `integration` |
| `production-approval` | jedyny required reviewer: właściciel | gate B, sam dowód, bez merge i bez deploy |

Dla obu środowisk zgód: wyłączony bypass administratora i wyłączony self-review. Agenci nie dostają tokenu właściciela zdolnego zatwierdzić te joby. Jeżeli istniejąca integracja ma taki zakres, ograniczyć go przed aktywacją. Komentarz opublikowany kontem właściciela nie jest dowodem kliknięcia.

Przed aktywacją potwierdzić numeryczne `environments[].id` oraz dokładne polityki gałęzi bieżącym odczytem API. Wpisany identyfikator lub zrzut ekranu nie zastępuje tego odczytu. `null` blokuje preflight.

## 3. Rulesets

Osobne zestawy, bo wyjątek autora zapisu nie może omijać jakości:

- `writers-only` na `main` i `integration`: aktualizacje tylko przez GitHub App kontrolera, tryb PR-only. Wyjątek App wyłącznie w tym ruleset.
- `quality-gates` na `main` i `integration`: wymagany PR, strict checks, zakaz force i delete, bez listy bypass. Wymagane checki, te same co `required_checks` w policy.json: dla `integration` `sc-agent/ci`, `sc-agent/review`, `sc-agent/integration-ready`; dla `main` `sc-agent/ci`, `sc-agent/review`, `sc-agent/production-approval`, `sc-agent/promotion-scope`. Źródło checków przypięte do App, nie „any source”.
- Na `integration` nie ustawiaj wymaganego checka `sc-agent/owner-acceptance`. Brak `sc-agent/integration-ready` albo check z innego źródła niż App oznacza nieudany preflight i brak automatycznego scalenia, także gdy obie flagi LIVE są włączone. Środowisko `owner-acceptance` zostaje, bo preflight sprawdza jego reviewerów.
- `agent-state`: writers-only pozwala App na bezpośredni zapis; osobny ruleset bez bypass zabrania force i delete. Gałąź nie jest scalana do aplikacji.

Jeżeli kombinacja nie jest skuteczna na tym repozytorium, auto-merge pozostaje wyłączone. Instrukcja w AGENTS nie zastępuje rulesetu.

`main` przyjmuje wyłącznie PR z `integration` tego samego `repository_id`. Nazwa `integration` w forku nie wystarcza.

Kontrola `verify` w `checks.yml` pozostaje bez zmiany nazwy. Zadanie `verify` w `agent-verify.yml` ma odrębną nazwę widoczną `Agent verify / artifact`, aby nie kolidować z kontrolą zwykłego CI. To nadal job GitHub Actions, NIE dowód `sc-agent/ci` wystawiony przez zaufaną App. Samo dodanie `verify` i `Agent contract / scope gate` do rulesetu nie wymusza niezależnego review Codexa i nie spełnia docelowego preflightu.

## 4. Sekrety i budżety

W środowisku `agent-control`, nigdy w repozytorium, PR ani artefakcie:

- klucz Cursor API i zatwierdzony budżet; kontrakt v1 sprawdzony na koncie przed aktywacją,
- klucz prywatny GitHub App.

Klucz projektu OpenAI umieść wyłącznie w osobnym środowisku `agent-review`, dostępnym tylko dla gałęzi `main`. Nie dodawaj tam kluczy kontrolera ani Cursora. Job `model` wchodzi do tego środowiska dopiero po `authorize`: workflow z `main`, `workflow_dispatch`, `github.run_attempt == 1`, `AGENT_PIPELINE_ENABLED=true` i numeryczny `github.actor_id` równy dodatniemu `controller_actor_id` z polityki na SHA workflow. Rerun zachowuje aktora pierwszej próby, dlatego próba inna niż 1 jest odrzucana PRZED wejściem do sekretu. Ręczne wybranie `main` nie wystarcza. `controller_actor_id=null` blokuje także właściciela. Preflight sprawdza osobno ID `agent-review` i wyłącznie gałąź `main`; dodatkowa gałąź albo tag są odrzucane. Nie twórz repozytoryjnej kopii `OPENAI_API_KEY`. Model i limit wydatków wymagają odrębnej decyzji; obecność sekretu nie jest dowodem budżetu ani działającego połączenia.

Klucz OpenAI wchodzi tylko jako wejście `openai-api-key` akcji Codex. Klucz Cursor tylko do adaptera tworzącego agenta. Nie przekazywać `envVars` razem z `agentId`.

Przypięcie Codex: `openai/codex-action@bdf19a4a223ec2549a3e2274a0cf61556bc07675`, CLI `@openai/codex@0.160.1`, `permission-profile: ":read-only"`. Przy bootstrapie ponownie odczytać tag `v1` i wersję CLI; zmiana SHA wymaga nowego `policy_sha`.

Numeryczne identyfikatory workflow w `policy.json` pochodzą z wcześniejszego odczytu GitHuba w SC-OPS-002C. Przed aktywacją ponownie porównać je z właściwymi ścieżkami workflow na `main`; rejestracja workflow nie potwierdza uruchomienia ani konfiguracji usług.

## 5. Vercel

Production Branch tylko `main`. `integration` i gałęzie tasków nie dostają produkcyjnych sekretów i nie uruchamiają produkcji. Jeżeli merge do `main` sam wdraża Vercel, zgoda B musi wymieniać ten efekt i oczekiwany commit. Nie dodawać drugiego deploy tego samego commita. Ochrona environment GitHub nie blokuje sama niezależnego deployu Vercel.

Brak odczytu konfiguracji Vercel w 002B jest `NOT RUN`, nie PASS.

## 6. Flagi

Po promocji kodu na `main` obie flagi pozostają false. Włączenie `AGENT_PIPELINE_ENABLED` jest osobną decyzją po przejściu preflightu. `AGENT_PIPELINE_MERGE_ENABLED` włącza się jeszcze później, tylko gdy rulesety writers-only i quality-gates są potwierdzone bieżącym odczytem Administration:read.

Preflight jest fail-closed. Ręczny snapshot nie zastępuje bieżącego odczytu. Brak uprawnień albo niezgodna konfiguracja blokuje auto-merge.

Przed wykonaniem zewnętrznego efektu `guardEffects` wymaga również `observation.preflight.ok === true`, nie tylko włączonej flagi. `reconcile` zawsze zastępuje preflight nowym wynikiem z zaufanego odczytu zabezpieczeń. Odpowiedź 403/404, niezgodne ID/polityka środowiska albo brak dowodu nie mogą uruchomić Cursor create/followup ani dispatchu review. Odrzucony plan zachowuje wcześniejszą rezerwację do ponownej weryfikacji; nie oznacza wykonania wywołania. Odczyty, raportowanie i dziennik mogą nadal działać — nie jest to deklaracja braku wszystkich zapisów GitHub. Testy offline z jawną symulacją nie otrzymują przez to uprawnień LIVE.

## 7. Test pętli

Na osobnym zadaniu, bez biznesowej bazy i bez publikacji aplikacji:

1. rzeczywisty start API,
2. jedna wymuszona poprawka,
3. nowe SHA, review i CI,
4. automatyczne scalenie do integration po bieżącym CI PASS i review PASS, bez zgody A,
5. publikacja checka sc-agent/integration-ready i raportu gotowości; brak zgody A nie jest warunkiem tego scalenia,
6. zatrzymanie przed zgodą B,
7. odmowa produkcji bez zgody B,
8. dostarczenie powiadomienia monitora.

Osobno, już po własnej zgodzie, test produkcyjnego runbooku konkretnego wydania. Brak uniwersalnego wykonawcy migracji. Bez runbooku produkcja zostaje BLOCKED. Sam merge nie jest DONE.

## 8. Monitor ChatGPT

Utworzyć dopiero w tym etapie, nie razem z 002B. Harmonogram: Europe/Warsaw, co godzinę, wykonanie chmurowe z dostępem do GitHuba, bez dostępu do lokalnego komputera. Kanał powiadomienia włączyć w ustawieniach konta. Dostawa w ciągu godziny jest celem harmonogramu, nie SLA. Nie obiecywać exactly-once: po utracie kontekstu możliwy duplikat z tym samym `notification_id`.

Prompt monitora, jeszcze nieutworzony i niewłączony:

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

Monitor nie jest serwerem zdarzeń. Nie mieszać go w jednym zadaniu z event triggerem GitHuba.

## 9. Czego ten runbook nie robi

Nie scala PR, nie uruchamia migracji, nie ustawia sekretów i nie oznacza testów live jako wykonanych. Każdy niewykonany punkt zostaje `NOT RUN`.

## Uzupełnienie po R1–R10 (do wykonania dopiero w 002C)

- Uzupełnij w zaufanym policy.json numery controller_app_id, controller_actor_id, workflow_ids oraz środowisk. Odczytaj je z API właściwego repo i instalacji; nie używaj numerów fixture.
- Ustaw AGENT_PIPELINE_BOT_LOGIN na dokładny login tej App w allow-bot-users przypiętej Codex Action. Nie używaj wildcard ani właścicielskiego PAT. Kontroler sprawdza niezależnie numeryczną tożsamość actor w pochodzeniu run.
- runner kontrolera przekazuje AGENT_POLICY_COMMIT=github.sha oraz GITHUB_RUN_ID; klient odczytu współdzieli token instalacji App. Brak kompletu oznacza NOT_CONFIGURED.
- Środowiska owner-acceptance i production-approval: dokładnie jeden reviewer User o ID właściciela, prevent_self_review=true, can_admins_bypass=false; selected deployment branches: wyłącznie branch main. Polityki tagów nie spełniają tego warunku.
- Zatwierdzony runbook produkcyjny umieść przez osobną akceptowaną zmianę na main w .github/agent-pipeline/production-runbook.json. Plik example jest wyłącznie wzorem; nie jest ładowany przez kontroler. Operacje, rollback, smoke_tests i ewentualne secret_names muszą opisywać faktyczne wdrożenie. Kod nie wykonuje tych tekstów jako poleceń shell.
- GitHub environment approval dotyczy zakresu z raportu App i jego niezmiennego digestu, obejmującego SHA, CI/review i (dla B) cały manifest. Sprawdź rzeczywiste pochodzenie required checks z App oraz działanie obu niezależnych gates.
- Awaria kontrolera: nie usuwaj lock na podstawie czasu. Najpierw potwierdź zakończenie workflow; kolejny przebieg odczyta journal i uzgodni oczekujące efekty. Nieznany follow-up nie może zostać wysłany ponownie bez osobnego zatwierdzonego wznowienia.
- Próg >100 commitów / >=300 plików w porównaniu blokuje automatyczny odbiór jako niekompletny; nie omijaj go usuwając checks.

## Stan konfiguracji z 2026-10-17 — nie test LIVE

Historyczny odczyt SC-OPS-002C z 2026-10-06 identyfikował workflow reconcile 376775092, verify 376775095, review 376775093, accept 376775089, promote 376775091 i gates 375800413 oraz agent-control 23618160050. Raport o brakujących wtedy środowiskach i rulesetach nie opisuje już obecnego stanu konta.

Na zrzutach właściciela z 2026-10-17 środowisko `agent-review` ma ID `23622706434`, jedyną dozwoloną gałąź `main`, zero tagów i brak required reviewers/wait timera. Lista sekretów pokazuje `OPENAI_API_KEY` wyłącznie w `agent-review`, a poświadczenia App i Cursor w `agent-control`. Są to dowody konfiguracji UI, nie poprawności wartości kluczy, limitu kosztów ani testu API.

Zapisany przez właściciela ruleset `quality-gates` 25299230 nadal jest disabled i zawiera zwykłe checki GitHub Actions. Nie dowodzi spełnienia docelowego preflightu App. `controller_app_id` i `controller_actor_id` w tej poprawce pozostają null; flags false. Nie uruchomiono płatnej pętli ani produkcji.
