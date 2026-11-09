# SC-021-A — AI Gateway (wielodostawcowa warstwa wywołań modeli)

TASK: SC-021-A · Issue #81 · LEVEL: L3 · SCOPE: BACKEND · OWNER: Claude (builder) ·
REVIEWER: niezależna sesja Claude · DEPENDS ON: SC-005 (screening), SC-014 (generowanie zadań) ·
PRODUCTION_APPROVAL: NO (biblioteka nie jest jeszcze podłączona do żadnej ścieżki produkcyjnej).

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

## Zasady bezpieczeństwa

- **Tylko OpenAI.** Gateway odrzuca już przy tworzeniu adapter dostawcy spoza `ACTIVE_AI_PROVIDERS`;
  routing pomija takie modele nawet gdy polityka ma `enabled: true`. Włączenie innego dostawcy =
  zmiana kodu + decyzja właściciela (koszty, nowy procesor danych). Brak automatycznego fallbacku
  do niezatwierdzonych usług.
- **Autoryzacja obowiązkowa.** `authorize(ctx)` musi zwrócić dokładnie `true`; wyjątek lub inna wartość = odmowa.
  `companyId`/`operationId` muszą pochodzić z zaufanego kontekstu serwera (członkostwo, claim workera), nigdy z JSON przeglądarki.
- **Prywatność.** Ładunek z adresem e-mail lub numerem telefonu (te same detektory co redakcja CV)
  jest zatrzymany przed dostawcą (`payload_not_redacted`). Rejestr prób nie zawiera promptu ani CV.
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

## Czego tu jeszcze nie ma (następne zadania)

- **SC-021-A2** — podłączenie screeningu i generowania zadań do gatewaya (za flagą, domyślnie wyłączoną).
  Warunek z review A: dziś detektor telefonu/e-maila działa tylko w ścieżce masowego uploadu CV;
  pojedyncze CV i kryteria wpisane przez rekrutera nie są nim sprawdzane. Zanim screening przejdzie
  przez gateway z `blockContactData: true`, A2 musi mieć test zgodności na prawdziwych, zredagowanych
  pojedynczych CV i kryteriach (żeby analizy, które dziś przechodzą, nie zaczęły kończyć się
  `payload_not_redacted`) — albo świadomie zmienić zachowanie i opisać to w PR.
- **SC-021-B** — trwały rejestr prób i kosztów w Supabase (`onAttempt`), cenniki wersjonowane, RLS,
  retencja zgodna z SC-010 (wymaga nowej bazy inwentarza R5 — patrz zamknięty PR #108).
- **SC-021-C** — budżety 80%/100%, rezerwacja, override, polityka zarządzana przez operatora.
- **SC-021-D** — panel kosztów i marży.

## Testy

`npm run test:ai-gateway` — 26 testów syntetycznych, bez sieci i bez kluczy.
