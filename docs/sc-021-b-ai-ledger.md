# SC-021-B — rejestr prób i kosztów AI (ledger)

TASK: SC-021-B · Issue #81 · LEVEL: L3 · SCOPE: BACKEND · OWNER: Claude (builder) ·
REVIEWER: niezależna sesja · DEPENDS ON: SC-021-A, SC-021-A2 ·
PRODUCTION_APPROVAL: NO (działa tylko przy `AI_GATEWAY_ENABLED=true`, które nigdzie nie jest włączone).

## Co dostarcza

| element | rola |
|---|---|
| `supabase/migrations/20261109200000_sc021_ai_ledger.sql` | schemat `ai_ledger`: tabela prób `attempts`, cennik `prices`, funkcje zapisu |
| `lib/ai-gateway/ledger.ts` | hook `onAttempt` (`createLedgerHook`): jedna próba → jeden wiersz; błąd zapisu → `ledger_error` |
| `lib/ai-gateway/gateway.ts` | każdy błąd lub przekroczenie czasu hooka (`SC021_ATTEMPT_HOOK_TIMEOUT`) → `ledger_error` z zachowaną informacją o naliczeniu |
| `lib/screening-gateway.ts`, worker Edge | firma z bazy (`public.screening_attempt_tenant`) w claimie; zapis próby jako `screening_worker` |
| `lib/exercise-ai-provider.ts`, akcja generowania | zapis próby sesją rekrutera, związany w bazie z jego rezerwacją generacji |

Wiersz rejestru: firma, rekrutacja, pseudonim kandydata (tylko screening), `operation_id`
(wspólny dla ponowień), `attempt_id` (UNIQUE, klucz idempotencji), numer próby, zadanie,
dostawca, model, rewizja, wersja polityki, wersja ceny, waluta, tokeny (wejście / z cache /
wyjście), koszt w mikro-jednostkach (`bigint`), status, pewność naliczenia, kod wyniku,
identyfikator żądania u dostawcy (tylko poza screeningiem), czas trwania, znaczniki czasu.
**Bez promptu, bez tekstu CV, bez treści odpowiedzi.**

## Statusy

| sytuacja | status | koszt |
|---|---|---|
| odpowiedź (completed / refused / incomplete) z tokenami | `settled` | z cennika; brak stawki → `NULL` („bez wyceny”) |
| odpowiedź bez tokenów albo `maybe_billed` (timeout, 5xx, sieć) | `unknown` | `NULL` |
| `not_billed` (odmowa przed uruchomieniem modelu: 401, 429, 400) | `released` | `0` |
| `reserved` | tylko w schemacie, dla budżetów SC-021-C | — |

Każda fizyczna próba ma własny `attempt_id`, więc ponowienia są osobnymi wierszami z tym samym
`operation_id`. Zapis jest idempotentny: ten sam `attempt_id` i ta sama treść → istniejący wiersz
(nic nie liczy się dwa razy); ta sama `attempt_id` i inna treść → błąd konfliktu, bez nadpisania.
Maksymalnie 16 wierszy na operację. Rejestr i cennik są tylko dopisywane (wyzwalacz).

## Bezpieczeństwo

- **Firma zawsze z zaufanego stanu bazy**, nigdy z wejścia:
  - screening: funkcja zapisu wyprowadza firmę, rekrutację i zgłoszenie z
    `public.screening_analysis_attempts` po `operation_id` (= `attempt_id` claimu workera).
    Worker dokleja do claimu firmę odczytaną z bazy (`screening_attempt_tenant`); gateway ma więc
    `companyId` zawsze ustawione — wyjątek `null` dla screeningu z A2 został usunięty;
  - generowanie zadań: `private.competency_authority` + rezerwacja w
    `exercise_ai.recruitment_settings.generation_requests[operation_id]` należąca do tego samego
    użytkownika; nowe wiersze tylko gdy rezerwacja ma status `reserved` (trwająca generacja).
  - `company_id` przesłany w danych jest tylko sprawdzany; niezgodność → odmowa.
- **Zapis**: `record_screening_ai_attempt` i `screening_attempt_tenant` — tylko rola
  `screening_worker`; `record_exercise_ai_attempt` — tylko `authenticated` z powyższym powiązaniem
  (aplikacja nie ma klucza `service_role`; akcja serwera działa sesją rekrutera). Rdzeń
  `ai_ledger.record_attempt` nie jest dostępny dla nikogo poza właścicielem. Brak bezpośredniego
  INSERT/UPDATE/DELETE dla jakiejkolwiek roli API.
- **Odczyt**: RLS — członek firmy (właściciel, rekruter, przeglądający) widzi wyłącznie wiersze
  swojej firmy (`private.has_company_access`). `anon`: brak dostępu. Cennik: brak dostępu.
- Błąd zapisu nigdy nie przepuszcza niezarejestrowanej pracy: gateway zwraca `ledger_error`, a
  próba z odpowiedzią, której nie udało się zapisać, jest `maybe_billed` (nigdy `not_billed`).
  Screening kończy się `worker_internal_error` (bez ponowienia), generowanie zadań
  `exercise_ai_server_error`. Komunikat błędu to sam kod (bez tekstu z bazy).

## Retencja i usuwanie danych kandydata (SC-010)

Wybrany wariant **(b)**: rejestr leży poza `public`/`private` (jak `pricing`), nie ma kluczy
obcych do tych schematów, więc sygnatura inwentarza SC-010 (R15) się nie zmienia (preflight i
postflight w migracji). Uzasadnienie: rejestr to dokument kosztów firmy, który ma przetrwać
usunięcie danych kandydata, i nie przechowuje nic, co po usunięciu wskazywałoby osobę:

- `operation_id` screeningu (id próby analizy) i `candidate_ref` (id zgłoszenia) to pseudonimy,
  których jedyne mapowanie na osobę żyje w tabelach inwentarza R15 i jest usuwane przez purge;
- identyfikator żądania u dostawcy nie jest zapisywany dla screeningu (dla screeningu żyje tylko
  w `public.screening_analysis_attempts`, które inwentarz zna);
- generowanie zadań nie dotyczy kandydatów (`candidate_ref` zawsze pusty).

Dowód: `tests/ai-ledger-database.test.mjs` wykonuje pełny purge kandydata i przeszukuje wszystkie
tabele wszystkich schematów — po purge żadna nie zawiera id próby ani id zgłoszenia; id analizy
zostaje wyłącznie w zatwierdzonych tabelach rozliczeń SC-019 (bez danych kandydata, ten sam
precedens co R11). Wiersz kosztu zostaje.

Uwaga: `attempt_id` jest wysyłany do dostawcy jako `x-client-request-id` (od A). Jego powiązanie z
treścią żądania istnieje tylko w logach dostawcy (poza SkillCheck), objętych umową powierzenia i
retencją dostawcy — tak samo jak dotąd identyfikatory odpowiedzi w tabelach screeningu.

## Ceny (wersjonowane, tylko stawki testowe)

`ai_ledger.prices`: dostawca, model, rewizja (opcjonalna), `price_version`, waluta, stawki w
mikro-jednostkach za 1 000 000 tokenów (wejście / wejście z cache / wyjście), `valid_from` /
`valid_to`, `placeholder`, `approved`. Do wyceny używana jest stawka zatwierdzona, a gdy jej nie ma
— jawna stawka testowa; szkic nie wycenia niczego. Brak stawki → koszt `NULL`.

W migracji jest **wyłącznie** wersja `placeholder-test-2026-11-09` (`placeholder = true`). To nie są
ceny OpenAI. Koszt policzony na niej ma `price_placeholder = true`, więc panel (D) może pokazać
„szacunek na stawkach testowych”. Prawdziwe stawki to osobny, zatwierdzony wiersz.

Koszt: `ceil(((wejście − cache)·s_wejście + cache·s_cache + wyjście·s_wyjście) / 1 000 000)` —
arytmetyka całkowita (`numeric`, bez liczb zmiennoprzecinkowych), zaokrąglenie **w górę**.

## Co zostaje na C i D

- **C**: rezerwacje (`reserved` → `settled`/`released`, kolumna `reserved_micros` jest gotowa;
  wyzwalacz „tylko dopisywanie” trzeba wtedy zastąpić jawnie dozwolonym przejściem), budżety
  80%/100%, override, polityka operatora; zatwierdzone stawki dostawcy (decyzja właściciela).
- **D**: panel kosztów i marży (odczyt przez RLS lub funkcję odczytu).
- Zastąpienie zapisu sesją rekrutera rolą serwerową, gdy aplikacja będzie miała własną tożsamość serwera.

## Testy

- `npm run test:ai-gateway` — gateway + hook rejestru (`tests/ai-ledger.test.mjs`), bez sieci.
- `npm run test:ai-ledger-db` — PostgreSQL (CI: PG16, `checks.yml`): dwie firmy, izolacja odczytu,
  brak zapisu z klienta, idempotencja, ponowienia, konflikt, ceny (testowa, zatwierdzona, brak),
  purge kandydata, rollback.
