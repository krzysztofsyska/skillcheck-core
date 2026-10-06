# SC-OPS-002B — poprawki R1–R10 (Codex)

STATUS: REVIEW — implementacja do niezależnego review, nie zgoda na aktywację.
WYKONAWCA POPRAWKI: Codex, po zatrzymaniu pracy Cursora przez właściciela.
BRANCH: feat/sc-ops-002b-agent-orchestration
BASE_COMMIT POPRAWKI: c96de5a28ebe943a657380395c00b60fcc55c2ed
BASE PR: 579da382f976971392bc15239fded5417945c0f0
PR: https://github.com/krzysztofsyska/skillcheck-core/pull/38
COMMIT: dokładny SHA publikacji jest w raporcie przekazania w tym PR (plik nie odwołuje się do własnego przyszłego SHA).
DB / MIGRATIONS: brak.

Ten raport zastępuje poprzednią ocenę kompletności implementacji. Dotychczasowe zielone testy nie wykrywały błędów adapterów wskazanych w review FAIL.

## Zmiany i dowody

| Uwaga | Zmiana | Regresja offline |
| --- | --- | --- |
| R1 | Jeden uwierzytelniony klient App dla odczytu i efektów; kontrola brakujących ID i policy commit przed efektami. | Pełne reconcileFromEnv, bez podmieniania ports/loadWork/journal, wyłącznie mock HTTP. |
| R2 | Utworzenie task branch przed Cursor, pełna treść kontraktu w hash/payload, walidacja metadanych, zależności, jeden aktywny task. | Payload zawiera kontrakt; mock odrzuca start bez gałęzi; edycja opisu zmienia hash. |
| R3 | policy_sha jest faktycznym commitem main; runner przypięty do github.sha, dry-run używa syntetycznego SHA commita. | Cykl HTTP sprawdza 40-znakowy policy commit; drift nadal unieważnia dowody. |
| R4 | Walidacja checked-in JSON Schema, wymagane kryteria z kontraktu, blokery i duplikaty; niezależne pochodzenie run/artifact. | required=false/NOT_RUN, dodatkowe pole, blocker, duplikat, obcy actor/workflow/ref/SHA/attempt i podrobione run_id. |
| R5 | Rzeczywiste refy, identyfikatory App, źródła checks, brak bypass, force/delete, konfiguracja obu środowisk. | Poprawna konfiguracja oraz zmieniona gałąź, App, puste checks, niepełna ochrona i admin bypass. |
| R6 | Odczyt agent-state po jednym SHA, CAS odczytanej wersji, hash-linked journal i globalna blokada. Konflikt przerywa tick; następny tick odczytuje i planuje ponownie. | Stary record odrzucony; dwa niezależne procesy przez produkcyjny adapter GitHub do lokalnego mock HTTP — jeden zwycięzca. |
| R7 | Wymagana własna blokada, ponowne odczyty H/B/dowodów/zgody/ochrony, normalizacja merge, GET konkretnego zamkniętego PR. | Brak lock odrzucony; utrata odpowiedzi po przyjętym merge odtworzona bez drugiego PUT. |
| R8 | Oddzielny pakiet request.json/change.patch, CI przed review, wymagane checks publikowane przez App po kontroli pochodzenia. | Cykl HTTP obserwuje dispatch z pakietem i publikację checks. Składnia YAML i rozdział poświadczeń. |
| R9 | Manifest całego diffu integration/main z pokryciem commitów zaakceptowanymi taskami; osobny promotion PR, review i gate B. | Cykl kończy się przed B; A nie otwiera B; obcy commit i brak runbooku blokują promocję. |
| R10 | Trwały outbox, jeden raport, identyfikator i zweryfikowany autor, link do run zgody i jej zakres, ograniczone retry odczytów. | Utracona odpowiedź komentarza uzgodniona po markerze, brak duplikatu; odczyty max 3 próby; brak ślepych ponowień mutacji. |

Nowe moduły: schema, protection, live-journal, evidence, live-effects, promotion, prepare-review. Zmiany ograniczone do narzędzi/testów kontrolera, jego workflow/polityk i dokumentacji. Brak nowych zależności; package.json i package-lock.json bez zmian w poprawce.

## Weryfikacja

Node.js v24.19.0, 2026-10-06, lokalnie:

- npm ci — PASS (72 pakiety instalowane na tym systemie).
- npm run test:agent-pipeline — 34 PASS, 0 FAIL.
- npm run agent:dry-run -- --fixture complete-cycle — PASS; external_calls=0, merge_calls=0, jedna poprawka, gate A i B; obie flagi false.
- npm run typecheck — PASS.
- npm run build — PASS.
- git diff --check — PASS.
- kontrola ALLOWED_FILES — PASS w zestawie testów na gałęzi 002B; również nowe pliki kontrolowane przed publikacją.

CI nowego SHA: wynik zostanie odczytany po publikacji i podany osobno w PR. Nie przenosimy wyniku CI z c96de5a na nowy commit.

Zweryfikowano źródło action.yml openai/codex-action na przypiętym bdf19a4a223ec2549a3e2274a0cf61556bc07675, w tym working-directory, output-schema-file, permission-profile i allow-bot-users. Odczytano aktualny kontrakt Cursor API v1 (https://cursor.com/docs/cloud-agent/api/endpoints): status wykonania pochodzi z runs; Get Run /v1/agents/{id}/runs/{runId}; git jest stanem sesji, nie historycznym snapshotem. Brak wiarygodnego przypisania nieznanego follow-up nadal oznacza BLOCKED.

## Ograniczenia i aktywacja

IMPLEMENTED / VERIFIED_OFFLINE nie oznacza VERIFIED_LIVE. Cursor/OpenAI API, rzeczywiste zgody, rulesety, merge, deploy, monitor, test:live oraz #35/#37 — NOT RUN. Ustawienia usług, sekrety i gałęzie main/integration nie były zmieniane. Obie flagi pozostają false.

- Rzeczywiste numery workflow, App/actor, środowisk i allow-bot-users wymagają konfiguracji 002C. W repo pozostają null/symboliczne.
- Kontroler nie wykonuje uniwersalnych migracji/deploy. Po merge produkcyjnym oczekuje na potwierdzenie runbooku i smoke testów; sam merge nie jest DONE.
- Manifest z ponad 100 commitami albo diff z 300 plikami jest celowo BLOCKED jako niekompletny, nie obcinany po cichu.
- Niepewna mutacja nie jest ponawiana w ciemno. Nieznany follow-up pozostaje BLOCKED; nieznana dostawa raportu czeka na uzgodnienie markera, bez drugiego POST.
- Blokada pozostawiona przez przerwany kontroler może być przejęta dopiero po potwierdzeniu completed poprzedniego run GitHuba; nie wygasa samym zegarem. Lokalna blokada bez run_id wymaga kontrolowanego odzyskania.
- JSON Schema validator obsługuje jawnie słownictwo używane w naszym schemacie; nieznane słowo walidacyjne odrzuca wynik.

## Następne zadanie

WYKONAWCA: niezależny reviewer Codex, nowa sesja review repozytorium, bez implementacji ani uruchamiania agentów przez ten task. Pełny prompt z rzeczywistym SHA publikacji zostaje zapisany w komentarzu PR przez wykonawcę; właściciel nie kopiuje raportu.

Review obejmuje R1–R10, ścieżkę reconcileFromEnv/adapters, regresje negatywne i kompletność 002A. Wynik PASS/PASS WITH FIXES/FAIL należy zapisać w PR. Do tego czasu PR pozostaje draft, 002C nie jest rozpoczynane, merge i wdrożenie pozostają zabronione.
