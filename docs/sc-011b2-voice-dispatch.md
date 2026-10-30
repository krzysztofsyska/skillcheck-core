# SC-011-B2 — rejestr połączeń i przyjmowanie webhooków Retell

TASK: SC-011-B (#79), krok B2 | SCOPE: BACKEND | LEVEL: L3 | REVIEWER: niezależny Codex
STATUS: IZOLOWANY SCHEMAT + ENDPOINT ZA BRAMKĄ (404) | PRODUCTION_APPROVAL: NO | DB/MIGRATIONS: brak migracji; `db/isolated/sc011b2-voice-dispatch.sql` tylko w testowej bazie

## Co dochodzi

- **`db/isolated/sc011b2-voice-dispatch.sql`** (wzorzec SC-010-C):
  - `private.sc011b_voice_attempts`: jedno połączenie u dostawcy na przygotowanie. Unikalny `provider_call_id`, status projekcji SC-011, `outcome` z zamkniętej listy i `dnc_requested`. Wiersza nie da się usunąć, a pola tożsamości nie da się zmienić. Status terminalny się nie zmienia. Wstawienie wymaga przygotowania w stanie `prepared_offline` i blokuje kandydata przez `erasure_lock_candidate`.
  - `private.sc011b_voice_webhook_receipts`: tylko dopisywanie, klucz `receipt_id` (stały dla ponowień Retell). Zdarzenia nieskorelowane i ignorowane są zapisywane bez tenanta.
  - Wyzwalacz blokuje anulowanie i zwrot przygotowania, gdy połączenie już wyszło (`VOICE_PREPARATION_DISPATCHED`).
  - Brak grantów dla `anon`/`authenticated`.
- **`lib/voice/retell-dispatch-ledger.ts`**:
  - `recordRetellDispatch`: przyszły worker zapisuje `call_id` zwrócony przez `create-phone-call`. Ponowienie z tym samym `call_id` zwraca tę samą próbę. Inne `call_id` dla tego samego przygotowania to konflikt, a nie ponowne dzwonienie.
  - `ingestRetellWebhook`: najpierw podpis i minimalizacja (B1), potem transakcja. Blokuje próbę po `call_id`, odrzuca duplikat po `receipt_id`, stosuje istniejącą projekcję statusów, zapisuje wynik i DNC, a na końcu pokwitowanie. **Transkrypcja jest odrzucana**; jej zapis z retencją 90 dni po zamknięciu rekrutacji (decyzja właściciela z 2026-10-30) to krok B3.
- **`lib/voice/retell-webhook-http.ts` + `app/api/voice/retell/webhook/route.ts`**: odpowiedzi bez treści.
  - 204: przyjęte.
  - 401: podpis lub czas.
  - 400: odrzucone.
  - 413: przekroczony rozmiar.
  - 503: błąd bazy; Retell ponawia.
  - `resolveRetellWebhookRuntime()` zwraca `null`, więc w każdym środowisku route odpowiada **404**, tak jak `resolveSc19PaymentRuntime`.

## Zanim bramka zostanie zdjęta

1. Schemat SC-010-C i B2 jako zatwierdzone migracje, z adapterami usuwania i przywracania (inwentarz SC-010).
2. Klucz webhooka Retell jako sekret serwera (tylko właściciel lub pipeline). Dedykowana rola bazy z dostępem tylko do tych tabel.
3. Worker wysyłki (SC-010-C), który wywołuje `recordRetellDispatch` po zaakceptowanym POST i obsługuje wynik nieznany przez zapytanie do Retell, bez ponownego dzwonienia.
4. `webhook_url` w `config/retell/…/agent.json` i nowy skrót agenta.
5. Przeniesienie `dnc_requested` do preferencji kontaktu kandydata oraz rozliczenie puli SC-019 (zarezerwowane → zużyte). Obie decyzje są otwarte.

## Testy

```bash
SCREENING_TEST_DATABASE_URL=postgres://… node --test --test-isolation=none --test-concurrency=1 tests/retell-dispatch-ledger.test.mjs
```

Prawdziwy PostgreSQL. Testy obejmują:
- zapis wysyłki, ponowienie i konflikt;
- blokadę anulowania po wysyłce i niezmienność wierszy;
- przejścia `call_started` → `call_ended`, zapis DNC, `call_analyzed`;
- brak transkrypcji i numerów w bazie;
- zdarzenia nieskorelowane i ignorowane;
- odrzucenia bez żadnego zapisu;
- dwa równoległe doręczenia tego samego zdarzenia, z których zastosowane zostaje jedno;
- odpowiedzi HTTP 404/204/401/400/413/503.
