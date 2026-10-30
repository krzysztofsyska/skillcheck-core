# SC-011-B1 — webhook Retell: uwierzytelnienie i minimalizacja (offline)

TASK: SC-011-B (#79), krok B1 | SCOPE: BACKEND | LEVEL: L3 | REVIEWER: niezależny Codex
STATUS: OFFLINE, BEZ ENDPOINTU | PRODUCTION_APPROVAL: NO | EXTERNAL_CALLS: NO | DB/MIGRATIONS: NONE

## Po co

Agent ma `data_storage_setting: basic_attributes_only`, więc Retell nie przechowuje transkrypcji. Według [dokumentacji Retell](https://docs.retellai.com/accounts/privacy-disable) webhook nadal ją dostarcza, a surowe pliki są kasowane po około 10 minutach. Webhook `call_ended` jest więc jedyną drogą, żeby odpowiedzi kandydata trafiły do SkillCheck (SC-013).

## Co jest w `lib/voice/retell-webhook.ts`

- `verifyRetellWebhookSignature(rawBody, header, key, nowMs)`: nagłówek `X-Retell-Signature` w ścisłym formacie `v=<ms>,d=<64 hex>`. Liczony jest HMAC-SHA256 z **dokładnych bajtów** body plus `v` (klucz API z odznaką webhooka) i porównywany w stałym czasie. Okno czasowe wynosi ±5 minut, a limit body 2 MiB, sprawdzany przed HMAC.
- `readRetellWebhook(rawBody, header, config, nowMs)`: po podpisie są kolejno:
  - parsowanie UTF-8 (fatal) i JSON;
  - zdarzenia spoza `call_started`/`call_ended`/`call_analyzed` zwracają `ignored` (do potwierdzenia 2xx);
  - wymagane: dokładny `agent_id` i `agent_version` naszego agenta, `phone_call`, `outbound`.
- Wynik zawiera tylko: `receiptId`, `providerCallId`, `occurredAt`, `status`, `outcome` oraz na `call_ended` transkrypcję w postaci `[{speaker: "agent"|"candidate", text}]`. `receiptId` jest stały dla ponowień tego samego zdarzenia (Retell ponawia do 3 razy).
- Odrzucane są: numery telefonów, nagrania, `retell_llm_dynamic_variables`, `metadata`, `call_analysis` (podsumowanie AI), koszty, znaczniki czasu słów i wszystkie inne pola.
- Transkrypcja ma limity: 400 wypowiedzi, 4000 znaków na wypowiedź, 60 000 łącznie. Zniekształcona albo za duża transkrypcja odrzuca całe zdarzenie zamiast zachować jej część.
- `outcome` przyjmuje zamkniętą listę wartości: `completed`, `dnc_requested`, `no_answer`, `busy`, `voicemail`, `provider_error`, `other`. `dnc_requested` (kandydat poprosił, żeby nie dzwonić) przyszła warstwa musi przenieść do preferencji kontaktu SC-010.
- `retellProviderEvent(result, config, attemptId)` mapuje zdarzenia statusowe na istniejący kontrakt `provider-event-contract.ts`, więc działa istniejąca projekcja statusów (kolejność, terminalność, duplikaty). Kontrakt dopuszcza teraz `_` w identyfikatorach (`agent_…`, `call_…`).

## Czego tu celowo nie ma (kolejne kroki #79)

1. **Wysyłka i korelacja**: worker SC-010-C wysyła `create-phone-call`, zapisuje zwrócone `call_id` przy przygotowaniu i dopiero po tym może przyjmować zdarzenia. Webhook nie niesie naszych identyfikatorów, bo `metadata` jest celowo puste.
2. **Endpoint `app/api/voice/retell/webhook`**: surowe body, klucz z sekretów serwera, deduplikacja po `receiptId`, odpowiedź 2xx w ciągu 10 s.
3. **Zapis transkrypcji**: tabela z RLS, retencją i wpisem do inwentarza usuwania SC-010. To migracja L3 i wymaga decyzji o okresie przechowywania.
4. Rejestracja `webhook_url` w agencie (`config/retell/…/agent.json`), gdy endpoint będzie gotowy.

## Testy

```bash
node --test tests/retell-webhook.test.mjs tests/voice-provider-event-contract.test.mjs
```

Testy obejmują:
- podpis na dokładnych bajtach (zmienione serializowanie, inny klucz, granice okna ±5 min, zniekształcone nagłówki, limit rozmiaru);
- powiązanie z agentem i wersją, odrzucenie połączeń przychodzących i webowych;
- `ignored` dla nieznanych zdarzeń i stały `receiptId` przy ponowieniach;
- mapowanie powodów rozłączenia;
- limity transkrypcji;
- przejście `call_started` → `call_ended` przez istniejącą projekcję statusów.
