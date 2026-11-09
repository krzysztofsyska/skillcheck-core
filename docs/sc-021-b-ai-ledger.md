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
| `lib/ai-ledger-writer.ts`, `lib/exercise-ai-provider.ts`, akcja generowania | zapis próby generowania zadań wyłącznie przez serwerowe połączenie `AI_LEDGER_DATABASE_URL` jako rola `ai_ledger_writer`, związany w bazie z rezerwacją generacji |

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
Limit wierszy na (operację, zadanie): screening 16, generowanie zadań = liczba prób trasy (1).
Rejestr, cennik i lista dozwolonych tras są tylko dopisywane (wyzwalacz).

## Bezpieczeństwo

- **Zapisują wyłącznie role serwerowe**, nigdy sesja użytkownika:
  - screening: rola `screening_worker` (worker Edge). `record_screening_ai_attempt` wyprowadza firmę,
    rekrutację i zgłoszenie z `public.screening_analysis_attempts` po `operation_id` (= `attempt_id`
    claimu). Worker dokleja do claimu firmę odczytaną z bazy (`screening_attempt_tenant`); gateway
    wymaga `companyId` dla każdego zadania (wyjątek `null` dla screeningu z A2 usunięty);
  - generowanie zadań: nowa rola **NOLOGIN `ai_ledger_writer`** (bez dziedziczenia, bez innych praw),
    osiągana tylko przez serwerowe połączenie `AI_LEDGER_DATABASE_URL` (`lib/ai-ledger-writer.ts`,
    login `ai_ledger_<nazwa>` z hasłem, nie localhost). `ai_ledger.record_exercise_attempt` nie używa
    `auth.uid()`; firma i rekrutacja z zaufanego kontekstu serwera muszą wskazywać rezerwację generacji
    o kluczu `operation_id` w statusie `reserved` z niewygasłym `expires_at`; ta sama blokada
    `exercise_ai:` co reserve/finish; dostawca, model, rewizja, klucz modelu i wersja polityki muszą być
    na liście `ai_ledger.route_allowlist`; tokeny ograniczone limitami trasy (wejście ≤ 48 000, wyjście
    ≤ 4 000); maks. 1 wiersz na generację; klucz nie może być operacją screeningu ani innego zadania.
    Sesja rekrutera nie może wywołać tej funkcji (test).
  - `company_id` przesłany w danych jest tylko sprawdzany; niezgodność → odmowa.
- **Warunek włączenia `AI_GATEWAY_ENABLED=true`** (krok operatora/właściciela, nie ta zmiana): utworzyć
  login `ai_ledger_<nazwa>` z hasłem, członkostwem wyłącznie w `ai_ledger_writer`, i ustawić
  `AI_LEDGER_DATABASE_URL` po stronie serwera. Bez tego, przy włączonej fladze, generowanie zadań
  odmawia przed rezerwacją i przed wywołaniem dostawcy („Rejestr kosztów AI jest niedostępny”).
- **Odczyt**: RLS — członek firmy (właściciel, rekruter, przeglądający) widzi wyłącznie wiersze
  swojej firmy (`private.has_company_access`). `anon`: brak dostępu. Cennik i lista tras: brak dostępu.
- Rdzeń `ai_ledger.record_attempt` nie jest dostępny dla nikogo poza właścicielem. Brak
  bezpośredniego INSERT/UPDATE/DELETE dla jakiejkolwiek roli API.
- Błąd zapisu nigdy nie przepuszcza niezarejestrowanej pracy: gateway zwraca `ledger_error`
  z **niezmienioną** flagą naliczenia próby (odpowiedź dostawcy, której nie udało się zapisać, zostaje
  `billed`). Screening kończy się `worker_internal_error` (bez ponowienia), generowanie zadań
  `exercise_ai_server_error`. Komunikat błędu to sam kod (bez tekstu z bazy).
- Równoległe zapisy: blokada doradcza na operację; test na dwóch połączeniach — ten sam `attempt_id`
  daje jeden wiersz, a limit wierszy trzyma się przy wyścigu.

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

`attempt_id` **nie jest** wysyłany do dostawcy: nagłówek `x-client-request-id` niesie osobny, losowy
identyfikator, którego SkillCheck nigdzie nie zapisuje. Rejestr nie ma więc żadnego klucza do rekordu
żądania u dostawcy.

## Ceny (wersjonowane, tylko stawki testowe)

`ai_ledger.prices`: dostawca, model, rewizja (opcjonalna), `price_version`, waluta, stawki w
mikro-jednostkach za 1 000 000 tokenów (wejście / wejście z cache / wyjście), `valid_from` /
`valid_to`, `placeholder`, `approved`. Do wyceny używana jest stawka zatwierdzona, a gdy jej nie ma
— jawna stawka testowa; szkic nie wycenia niczego. Brak stawki → koszt `NULL`.

W migracji jest **wyłącznie** wersja `placeholder-test-2026-11-09` (`placeholder = true`). To nie są
ceny OpenAI. Koszt policzony na niej ma `price_placeholder = true`, więc panel (D) może pokazać
„szacunek na stawkach testowych”. Prawdziwe stawki to osobny, zatwierdzony wiersz.

Cennik jest dziś w pełni „tylko do dopisywania”, więc zatwierdzonej stawki nie da się zamknąć
(`valid_to`). SC-021-C dopuści jednorazowe ustawienie `valid_to` (z pustego na datę) dla stawki,
bez zmiany samych stawek.

Koszt: `ceil(((wejście − cache)·s_wejście + cache·s_cache + wyjście·s_wyjście) / 1 000 000)` —
arytmetyka całkowita (`numeric`, bez liczb zmiennoprzecinkowych), zaokrąglenie **w górę**.

## Co zostaje na C i D

- **C**: rezerwacje (`reserved` → `settled`/`released`, kolumna `reserved_micros` jest gotowa;
  wyzwalacz „tylko dopisywanie” trzeba wtedy zastąpić jawnie dozwolonym przejściem), budżety
  80%/100%, override, polityka operatora; zatwierdzone stawki dostawcy (decyzja właściciela).
- **D**: panel kosztów i marży (odczyt przez RLS lub funkcję odczytu).
- C: jednorazowe zamknięcie stawki (`valid_to`), patrz wyżej.
- Utworzenie loginu dla `ai_ledger_writer` i ustawienie `AI_LEDGER_DATABASE_URL` (operator/właściciel)
  przed włączeniem flagi.

## Testy

- `npm run test:ai-gateway` — gateway + hook rejestru (`tests/ai-ledger.test.mjs`), bez sieci.
- `npm run test:ai-ledger-db` — PostgreSQL (CI: PG16, `checks.yml`): dwie firmy, izolacja odczytu,
  brak zapisu z klienta (także sesją rekrutera), rola `ai_ledger_writer` (rezerwacja, wygaśnięcie,
  limit 1, lista tras, limity tokenów, kolizja z operacją screeningu), idempotencja, ponowienia,
  konflikt, ceny (testowa, zatwierdzona, brak), wyścigi na dwóch połączeniach, purge kandydata, rollback.
