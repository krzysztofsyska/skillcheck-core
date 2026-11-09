# SC-021-A — AI Gateway (wielodostawcowa warstwa wywołań modeli)

TASK: SC-021-A · Issue #81 · LEVEL: L3 · SCOPE: BACKEND · OWNER: Claude (builder) ·
REVIEWER: niezależna sesja Claude · DEPENDS ON: SC-005 (screening), SC-014 (generowanie zadań) ·
PRODUCTION_APPROVAL: NO (od A2 podłączona do screeningu i generowania zadań, ale tylko za flagą `AI_GATEWAY_ENABLED`, która nigdzie nie jest włączona).

## Co dostarcza

`lib/ai-gateway/`:

| plik | rola |
|---|---|
| `contract.ts` | wspólny kontrakt: zadania AI, dostawcy, **`ACTIVE_AI_PROVIDERS = ['openai']`** (stała w kodzie), błędy z informacją, czy wywołanie mogło zostać naliczone (`not_billed` / `maybe_billed`) |
| `policy.ts` | wersjonowana polityka routingu: modele (dostawca, model, rewizja, jakość, `costRank`, `enabled`) i trasy per zadanie (`pinned` / `cheapest` / `best_quality`, próg jakości, timeout, liczba prób, czy ponawiać przy możliwym naliczeniu, blokada danych kontaktowych, limit rozmiaru). Walidacja pełna, błędna polityka = brak trasy (fail closed) |
| `default-policy.ts` | obowiązująca polityka: `cv_screening` i `exercise_generation` przypięte (`pinned`) do modelu, który dziś zapisują ich kontrakty wyników; bez ponowień płatnych prób |
| `gateway.ts` | jedyne wejście: kontekst → autoryzacja → trasa → prywatność ładunku → allowlista adapterów → próby; hook `onAttempt` dla rejestru SC-021-B |
| `openai.ts` | adapter Responses API (jedyny aktywny) |
| `anthropic.ts` | adapter Messages API — **nieaktywny**, tylko testy syntetyczne |
| `http.ts` | wspólne HTTP: `redirect: 'error'`, limit 2 MB odpowiedzi, klasyfikacja statusów |
| `responses-bridge.ts` | (A2) zamiana istniejącego ciała żądania Responses API na żądanie gatewaya z kontrolą bajt w bajt, model trasy przypiętej, linia logu próby |

## Zasady bezpieczeństwa

- **Tylko OpenAI.** Gateway odrzuca już przy tworzeniu adapter dostawcy spoza `ACTIVE_AI_PROVIDERS`;
  routing pomija takie modele nawet gdy polityka ma `enabled: true`. Włączenie innego dostawcy =
  zmiana kodu + decyzja właściciela (koszty, nowy procesor danych). Brak automatycznego fallbacku
  do niezatwierdzonych usług.
- **Autoryzacja obowiązkowa.** `authorize(ctx)` musi zwrócić dokładnie `true`; wyjątek lub inna wartość = odmowa.
  `companyId`/`operationId` muszą pochodzić z zaufanego kontekstu serwera (członkostwo, claim workera), nigdy z JSON przeglądarki.
- **Prywatność.** Na trasie z `blockContactData: true` ładunek z adresem e-mail lub numerem telefonu (te same
  detektory co redakcja CV) jest zatrzymany przed dostawcą (`payload_not_redacted`). Obie trasy podłączone w A2
  mają ją świadomie wyłączoną — uzasadnienie w sekcji A2 niżej. Rejestr prób nie zawiera promptu ani CV.
- **Klucze** tylko po stronie serwera, w nagłówku; komunikaty błędów to same kody, bez treści odpowiedzi dostawcy.
- **Ponowienia.** Ponawiane są tylko błędy przejściowe. Błąd, po którym model mógł już się wykonać
  (timeout, 5xx, sieć) jest ponawiany wyłącznie gdy trasa ma `retryMaybeBilled: true` (domyślnie nie).
  Każda fizyczna próba ma własny `attemptId` i trafia do `onAttempt` — dodatkowe rzeczywiste
  wywołania są widoczne; `operationId` (correlation ID) jest wspólny dla operacji.
- **Dostępność.** Prosty circuit breaker per model (domyślnie 3 błędy → 60 s przerwy); trasy `pinned` nie zmieniają modelu.
- **Limity czasu.** Gateway przestaje czekać po `timeoutMs` nawet gdy adapter ignoruje sygnał przerwania;
  hook `onAttempt` jest obowiązkowy i ma limit 10 s.
- **Prywatność** obejmuje `system`, `user` i schemat JSON (wszystko, co trafia do dostawcy).
- **Rollback routingu** = powrót do poprzedniej wersji polityki (test w `tests/ai-gateway.test.mjs`).

## Zgodność ze screeningiem

Test „screening parity” sprawdza, że ciało żądania budowane przez adapter dla trasy `cv_screening`
jest bajt w bajt równe temu, które dziś wysyła `buildScreeningOpenAiRequest`. Hash kontraktu
screeningu (model, prompt, schemat) się nie zmienia.

## SC-021-A2 — podłączenie screeningu i generowania zadań (flaga, domyślnie wyłączona)

Flaga serwerowa `AI_GATEWAY_ENABLED` (tylko wartość dokładnie `true` ją włącza). **Nigdzie nie jest włączona.**
Gdy jest wyłączona, screening (`callOpenAiResponses` w workerze Supabase Edge) i generowanie zadań
(`requestExerciseDraft`) działają dokładnie tak jak przed A2.

Gdy jest włączona:

| element | jak zachowana jest zgodność |
|---|---|
| treść żądania do OpenAI | `lib/ai-gateway/responses-bridge.ts` zamienia dotychczasowe ciało żądania na żądanie gatewaya i przy **każdym** wywołaniu sprawdza, że adapter wyśle te same bajty; inaczej `invalid_request` przed wysłaniem |
| model | trasa `pinned`; wywołanie jest odrzucane, gdy polityka wskazuje inny model niż kontrakt wyniku (screening: `contract_mismatch`) |
| parsowanie wyniku | `gateway.runRaw` zwraca surową odpowiedź dostawcy, którą parsują dotychczasowe `parseScreeningOpenAiResponse` / `parseExerciseDraftResponse` (odmowy, ucięcia, użycie tokenów, cytaty) |
| kody błędów | błąd gatewaya niesie status HTTP; mapowanie przez dotychczasowe `mapScreeningHttpError` / `mapExerciseAiHttpError`; testy porównują obie ścieżki dla każdego statusu i przypadków brzegowych |
| ponowienia | trasa robi 1 fizyczną próbę; screening zachowuje własną pętlę (3 próby, te same przerwy), generowanie zadań — 1 próbę |
| hash kontraktu analizy | bez zmian (test z wartościami stałymi) |
| autoryzacja | screening: claim workera (to samo `attempt_id`, niewygasła dzierżawa); zadania: członkostwo w firmie i uprawnienia sprawdzone przez `exerciseContext`, klucz żądania, rekrutacja. Nigdy dane z przeglądarki |
| rejestr prób | `onAttempt` zapisuje jedną linię JSON na fizyczną próbę (identyfikatory, model, wynik, tokeny, czas) — bez promptu, CV, profilu i klucza. Trwały rejestr = SC-021-B |
| Supabase Edge | gateway nie używa `Buffer` ani `node:crypto` (Deno ich nie ma globalnie); stałe modelu zadań w `lib/exercise-ai-model.ts`, żeby worker nie ładował `exercise-ai.ts`; test grafu importów to pilnuje |

### Blokada danych kontaktowych — świadomie wyłączona na obu trasach (warunek z review A)

Test „guard parity” (`tests/ai-gateway.test.mjs`) mierzy detektor na realistycznych CV po automatycznej
redakcji pojedynczego CV (`suggestRedaction`) i na typowych kryteriach rekrutera:

- zredagowane CV + typowe kryteria — **przechodzą** (detektor nic nie zgłasza);
- kryteria z 9-cyfrowymi kwotami („budżet 500 000 000 zł”, „wolumen 600 000 000 transakcji”) — **są
  brane za numer telefonu**. Takie analizy dziś działają; z blokadą kończyłyby się `payload_not_redacted`,
  dla którego screening nie ma kodu błędu ani komunikatu.

Dlatego `cv_screening.blockContactData = false` (CV jest redagowane wcześniej: `suggestRedaction` + przegląd
rekrutera, a w masowym uploadzie dodatkowo ten sam detektor). `exercise_generation.blockContactData = false`,
bo ładunek to wyłącznie profil firmy i stanowiska (bez danych kandydatów), gdzie telefon czy e-mail biura
są czymś normalnym. Włączenie blokady dla screeningu wymaga: sprawdzania tylko tekstu CV (nie kryteriów),
osobnego kodu błędu z komunikatem i migracji — do zrobienia razem z SC-021-B/C.

### Znane, udokumentowane różnice (tylko przy włączonej fladze)

- `companyId` w kontekście screeningu to `null`: claim workera nie zawiera firmy. SC-021-B musi dodać firmę
  do claimu, zanim rejestr lub budżety będą liczone per firma.
- Odpowiedź dostawcy większa niż 2 MB (screening) jest odrzucana jako `openai_invalid_output`; ścieżka
  bezpośrednia nie miała limitu. Generowanie zadań zachowuje swój dotychczasowy limit (800 000 bajtów).
- Odpowiedź będąca poprawnym JSON-em, ale nie obiektem (np. `[]`), ma w logu powód `response_not_json`
  zamiast `invalid_envelope`; kod błędu jest ten sam.
- Brak klucza API: zamiast wysłania żądania i odpowiedzi 401 — od razu `openai_auth_error` / `exercise_ai_auth_error`, bez wywołania.
- Każde żądanie przez gateway ma dodatkowy nagłówek `x-client-request-id` (identyfikator próby) i `redirect: 'error'`;
  przy odpowiedzi innej niż 2xx treść odpowiedzi jest od razu porzucana. Treść żądania jest identyczna.
- Błąd połączenia przed odpowiedzią to zawsze `openai_network_error` (ponawiany jak dotąd). Ścieżka bezpośrednia
  rozpoznawała go po treści komunikatu, a komunikaty `fetch` w Deno (np. „error sending request…”) do wzorca nie
  pasowały, więc kończyły się `worker_internal_error` bez ponowienia. Przez gateway działa to zgodnie z zamiarem.
- Zerwanie połączenia w trakcie czytania odpowiedzi 2xx (model już się wykonał i jest naliczony) to
  `invalid_response` → `openai_invalid_output` / `exercise_ai_invalid_output`, **bez ponowienia** — żeby nie
  płacić drugi raz (wcześniej zwykle `worker_internal_error` / `exercise_ai_network_error`, też bez ponowienia).
- Autoryzacja screeningu porównuje zegar workera z `lease_expires_at` z bazy. Dzierżawa trwa 5 min, a najdłuższa
  pętla prób ok. 3 min; różnica zegarów powyżej ok. 2 min mogłaby odrzucić ostatnią próbę (bez wywołania dostawcy).
- `companyId: null` jest przyjmowane wyłącznie dla zadania `cv_screening`; każde inne zadanie z `null` → `invalid_context`.
- Ochrona „tylko serwer” w gatewayu uwzględnia Deno (który może mieć globalne `window`), żeby worker Edge nie był
  przez nią blokowany.

## Czego tu jeszcze nie ma (następne zadania)

- **SC-021-B** — trwały rejestr prób i kosztów w Supabase (`onAttempt`), cenniki wersjonowane, RLS,
  retencja zgodna z SC-010 (wymaga nowej bazy inwentarza R5 — patrz zamknięty PR #108). Warunki z review A:
  zapis idempotentny po `attemptId`; błąd hooka → `ledger_error` z zachowaniem informacji o naliczeniu.
  Warunek z A2: firma w claimie workera screeningu.
- **SC-021-C** — budżety 80%/100%, rezerwacja, override, polityka zarządzana przez operatora.
- **SC-021-D** — panel kosztów i marży.

## Testy

`npm run test:ai-gateway` — 40 testów syntetycznych, bez sieci i bez kluczy.
A2: `tests/screening-gateway.test.mjs` (w `test:screening`) i `tests/exercise-ai-gateway.test.mjs`
(w `test:assessments`) porównują ścieżkę bezpośrednią i przez gateway na tych samych sztucznych odpowiedziach.
