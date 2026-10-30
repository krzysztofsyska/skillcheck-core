# SC-011-B5 — worker wysyłki połączenia Retell (raz i tylko raz)

TASK: SC-011-B (#79), krok B5 | SCOPE: BACKEND | LEVEL: L3 | REVIEWER: niezależny Codex
STATUS: IZOLOWANY SCHEMAT, TRANSPORT WSTRZYKIWANY (brak domyślnego `fetch`, brak połączeń) | PRODUCTION_APPROVAL: NO | DB/MIGRATIONS: brak migracji; `db/isolated/sc011b5-voice-dispatch-worker.sql`

## Zasada

Retell przez godzinę deduplikuje ponowione `create-phone-call` z tym samym `idempotency_key` ([dokumentacja](https://docs.retellai.com/api-references/create-phone-call)). Worker może więc ponowić ten sam szkic w tym oknie, a nigdy po nim.

## Co dochodzi

- `private.sc011b_voice_dispatches`: jedna rezerwacja wysyłki na przygotowanie.
  - Stany: `sending` → `accepted` | `rejected` | `unknown`; stan końcowy jest niezmienny.
  - Maksymalnie 10 prób.
  - Brak usuwania; RLS `force` i brak grantów.
- `lib/voice/retell-dispatch-worker.ts` → `dispatchRetellCall(db, {companyId, operationId, draft, apiKey}, http, nowMs)`:
  - Odrzuca szkic nieświeży (dowód agenta ważny 30 s) albo zmieniony (inny endpoint lub metoda), bez rezerwacji i bez wysyłki.
  - `201` z `call_id` → `recordRetellDispatch` (B2) i stan `accepted`. Ponowne wywołanie niczego nie wysyła.
  - `400`/`422` → `rejected`: Retell odrzuci to samo żądanie zawsze. Przygotowanie jest anulowane, a rezerwacja wraca do puli (wyzwalacz, ta sama transakcja).
  - `401`/`402`/`429`/`5xx`/błąd sieci/`201` bez czytelnego `call_id` → `retry_later` z tym samym kluczem. Problem z konfiguracją albo rozliczeniem nie zwalnia masowo rezerwacji.
  - Rezerwacja wysyłki starsza niż 55 minut (margines do okna 1 h) albo 10 prób → `unknown`. Brak ponownego dzwonienia; rezerwacja zostaje do wyjaśnienia.
- Wyzwalacz blokuje anulowanie i zwrot przygotowania, dopóki połączenie mogło wyjść (`sending`, `accepted`, `unknown`).
- Numer docelowy i klucz API nie są zapisywane.

## Zanim zadziała naprawdę

1. Migracje (SC-010-C, B2–B5) z adapterami usuwania.
2. Runtime: klucz API Retell z sekretów serwera, prawdziwy transport, harmonogram workera i świeży szkic z `prepareOfflineVoiceDraft` tuż przed wysyłką.
3. Procedura wyjaśniania stanu `unknown` (np. lista połączeń w Retell po numerze agenta i czasie), bez automatycznego ponownego dzwonienia.
4. Zgoda właściciela na pierwszy testowy telefon na własny numer.

## Testy

`tests/retell-dispatch-worker.test.mjs` (PostgreSQL 16, fałszywy transport, globalny `fetch` zablokowany) obejmuje:
- dokładne żądanie (URL, metoda, `redirect: error`, nagłówki, body = szkic);
- jedną wysyłkę przy powtórzeniu;
- brak numeru i klucza w bazie;
- przypadki przejściowe z zachowaną rezerwacją, blokadą anulowania i ponowieniem z tym samym kluczem;
- `422` → anulowanie i zwrot do puli bez ponownej wysyłki;
- przekroczenie okna → `unknown` bez wysyłki;
- odrzucenie nieświeżego lub zmienionego szkicu bez rezerwacji.
