# SC-OPS-002C — runbook bootstrapu obiegu agentów

Status tego dokumentu: instrukcja. Nie została wykonana. Nie włącza flag, nie tworzy GitHub App, środowisk, rulesetów, sekretów, monitora ChatGPT ani wdrożenia.

Warunek wejścia: SC-OPS-002B ma review PASS, OWNER ACCEPTANCE i jest na `integration`, a następnie osobna promocja `integration -> main` nadal z obiema flagami `false`. Nowy workflow nie zatwierdza własnego pierwszego merge.

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
| `owner-acceptance` | jedyny required reviewer: właściciel | gate A, sam dowód, bez merge |
| `production-approval` | jedyny required reviewer: właściciel | gate B, sam dowód, bez merge i bez deploy |

Dla obu zgód: wyłączony bypass administratora i wyłączony self-review. Agenci nie dostają tokenu właściciela zdolnego zatwierdzić te joby. Jeżeli istniejąca integracja ma taki zakres, ograniczyć go przed aktywacją. Komentarz opublikowany kontem właściciela nie jest dowodem kliknięcia.

Po pierwszej prawdziwej zgodzie zapisać numeryczne `environments[].id`. Do tego czasu kod trzyma `id: null` i porównuje nazwę.

## 3. Rulesets

Osobne zestawy, bo wyjątek autora zapisu nie może omijać jakości:

- `writers-only` na `main` i `integration`: aktualizacje tylko przez GitHub App kontrolera, tryb PR-only. Wyjątek App wyłącznie w tym ruleset.
- `quality-gates` na `main` i `integration`: wymagany PR, strict checks, zakaz force i delete, bez listy bypass. Wymagane checki: dla `integration` `sc-agent/ci`, `sc-agent/review`, `sc-agent/owner-acceptance`; dla `main` `sc-agent/ci`, `sc-agent/review`, `sc-agent/production-approval` i `sc-agent/promotion-scope`. Źródło checków przypięte do App, nie „any source”.
- `agent-state`: writers-only pozwala App na bezpośredni zapis; osobny ruleset bez bypass zabrania force i delete. Gałąź nie jest scalana do aplikacji.

Jeżeli kombinacja nie jest skuteczna na tym repozytorium, auto-merge pozostaje wyłączone. Instrukcja w AGENTS nie zastępuje rulesetu.

`main` przyjmuje wyłącznie PR z `integration` tego samego `repository_id`. Nazwa `integration` w forku nie wystarcza.

## 4. Sekrety i budżety

W środowisku `agent-control`, nigdy w repozytorium, PR ani artefakcie:

- klucz Cursor API i zatwierdzony budżet; kontrakt v1 sprawdzony na koncie przed aktywacją,
- klucz prywatny GitHub App.

Klucz projektu OpenAI umieść wyłącznie w osobnym środowisku `agent-review`, dostępnym tylko dla gałęzi `main`. Nie dodawaj tam kluczy kontrolera ani Cursora. Job `model` w `agent-review.yml` korzysta z tego środowiska i wykonuje się tylko z `main`. Nie twórz repozytoryjnej kopii `OPENAI_API_KEY`. Model i limit wydatków wymagają osobnej decyzji; sama subskrypcja ChatGPT nie potwierdza budżetu API.

Klucz OpenAI wchodzi tylko jako wejście `openai-api-key` akcji Codex. Klucz Cursor tylko do adaptera tworzącego agenta. Nie przekazywać `envVars` razem z `agentId`.

Przypięcie Codex: `openai/codex-action@bdf19a4a223ec2549a3e2274a0cf61556bc07675`, CLI `@openai/codex@0.160.1`, `permission-profile: ":read-only"`. Przy bootstrapie ponownie odczytać tag `v1` i wersję CLI; zmiana SHA wymaga nowego `policy_sha`.

Numeryczne identyfikatory workflow w `policy.json` pochodzą z odczytu GitHuba z 2026-10-06. Przed aktywacją ponownie porównać je z właściwymi ścieżkami workflow; rejestracja workflow nie potwierdza konfiguracji usług.

## 5. Vercel

Production Branch tylko `main`. `integration` i gałęzie tasków nie dostają produkcyjnych sekretów i nie uruchamiają produkcji. Jeżeli merge do `main` sam wdraża Vercel, zgoda B musi wymieniać ten efekt i oczekiwany commit. Nie dodawać drugiego deploy tego samego commita. Ochrona environment GitHub nie blokuje sama niezależnego deployu Vercel.

Brak odczytu konfiguracji Vercel w 002B jest `NOT RUN`, nie PASS.

## 6. Flagi

Po promocji kodu na `main` obie flagi pozostają false. Włączenie `AGENT_PIPELINE_ENABLED` jest osobną decyzją po przejściu preflightu. `AGENT_PIPELINE_MERGE_ENABLED` włącza się jeszcze później, tylko gdy rulesety writers-only i quality-gates są potwierdzone bieżącym odczytem Administration:read.

Preflight jest fail-closed. Ręczny snapshot nie zastępuje bieżącego odczytu. Brak uprawnień albo niezgodna konfiguracja blokuje auto-merge.

## 7. Test pętli

Na osobnym zadaniu, bez biznesowej bazy i bez publikacji aplikacji:

1. rzeczywisty start API,
2. jedna wymuszona poprawka,
3. nowe SHA, review i CI,
4. zatrzymanie przed zgodą A,
5. merge tylko po zgodzie A,
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

- Uzupełnij w zaufanym policy.json numery controller_app_id, controller_actor_id, workflow_ids oraz obu środowisk. Odczytaj je z API właściwego repo i instalacji; nie używaj numerów fixture.
- Ustaw AGENT_PIPELINE_BOT_LOGIN na dokładny login tej App w allow-bot-users przypiętej Codex Action. Nie używaj wildcard ani właścicielskiego PAT. Kontroler sprawdza niezależnie numeryczną tożsamość actor w pochodzeniu run.
- runner kontrolera przekazuje AGENT_POLICY_COMMIT=github.sha oraz GITHUB_RUN_ID; klient odczytu współdzieli token instalacji App. Brak kompletu oznacza NOT_CONFIGURED.
- Środowiska owner-acceptance i production-approval: dokładnie jeden reviewer User o ID właściciela, prevent_self_review=true, can_admins_bypass=false; selected deployment branches: wyłącznie branch main. Polityki tagów nie spełniają tego warunku.
- Zatwierdzony runbook produkcyjny umieść przez osobną akceptowaną zmianę na main w .github/agent-pipeline/production-runbook.json. Plik example jest wyłącznie wzorem; nie jest ładowany przez kontroler. Operacje, rollback, smoke_tests i ewentualne secret_names muszą opisywać faktyczne wdrożenie. Kod nie wykonuje tych tekstów jako poleceń shell.
- GitHub environment approval dotyczy zakresu z raportu App i jego niezmiennego digestu, obejmującego SHA, CI/review i (dla B) cały manifest. Sprawdź rzeczywiste pochodzenie required checks z App oraz działanie obu niezależnych gates.
- Awaria kontrolera: nie usuwaj lock na podstawie czasu. Najpierw potwierdź zakończenie workflow; kolejny przebieg odczyta journal i uzgodni oczekujące efekty. Nieznany follow-up nie może zostać wysłany ponownie bez osobnego zatwierdzonego wznowienia.
- Próg >100 commitów / >=300 plików w porównaniu blokuje automatyczny odbiór jako niekompletny; nie omijaj go usuwając checks.

## Odczyt przygotowawczy 2026-10-06 — Issue #40

Przygotowanie nie jest aktywacją. Workflow IDs odczytane z GitHub: reconcile 376775092, verify 376775095, review 376775093, accept 376775089, promote 376775091, gates 375800413. Istniejący agent-control ma ID 23618160050, ale nie ma jeszcze wymaganej polityki gałęzi. Same numery nie dowodzą zabezpieczeń.

Brakuje środowisk owner-acceptance, production-approval i agent-review. Rulesets API zwróciło pustą listę; klasycznej ochrony gałęzi nie zweryfikowano (403). Brak agent-state. ID App i aktora pozostają null, obie flagi false. Nie dodano sekretów i nie testowano płatnej pętli.

Pin Codex Action zweryfikowany: annotated tag v1 wskazuje commit bdf19a4a223ec2549a3e2274a0cf61556bc07675. Wszystkie identyfikatory i ustawienia należy ponownie odczytać przed aktywacją. Szczegółowy kontrakt, kolejność konfiguracji usług i wymagania odbioru: https://github.com/krzysztofsyska/skillcheck-core/issues/40.
