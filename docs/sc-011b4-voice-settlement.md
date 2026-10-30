# SC-011-B4 — rozliczenie puli rozmów i blokada kontaktu po prośbie kandydata

TASK: SC-011-B (#79), krok B4 | SCOPE: BACKEND | LEVEL: L3 | REVIEWER: niezależny Codex
STATUS: IZOLOWANY SCHEMAT (tylko testowa baza) | PRODUCTION_APPROVAL: NO | DB/MIGRATIONS: brak migracji; `db/isolated/sc011b4-voice-settlement.sql`

## Decyzje właściciela (2026-10-30)

1. Prośba kandydata, żeby więcej nie dzwonić, **automatycznie blokuje dalszy kontakt**.
2. **Nieodebrane połączenie nie zużywa rozmowy** z puli FREE ani PRESELEKCJA.

## Wdrożenie

Wyzwalacz `private.sc011b_attempt_settlement()` działa po zmianie wiersza `private.sc011b_voice_attempts`, w tej samej transakcji, która zapisuje wynik z webhooka. Kod aplikacji nie może go więc obejść.

- **Pula SC-019**: przy pierwszym przejściu do stanu końcowego:
  - `completed` → `used + 1, reserved − 1` (rozmowa się odbyła, także gdy kandydat na końcu poprosił o DNC);
  - `failed`/`cancelled` (brak odpowiedzi, zajęte, poczta głosowa, błąd operatora) → `reserved − 1`, rezerwacja wraca do puli.
  
  Używa istniejących, dozwolonych przejść strażnika `sc19_voice_entitlement_guard`. Stan terminalny się nie zmienia, więc rozliczenie zachodzi raz. `unknown` zachowuje rezerwację do wyjaśnienia.
- **DNC**: `candidate_contact_preferences.blocked_channels` = `{email, sms, voice}` i `revision + 1`. Istniejące sprawdzenia (`contact_receipt_status`, `set_contact_preferences`, przygotowanie rozmowy) odmawiają kontaktu na zablokowanym kanale i przy zmienionej rewizji. Gdy kandydat nie ma preferencji, zostaje utworzony wiersz z blokadą wszystkich kanałów.

## Do migracji

- Kolumna `candidate_contact_preferences.source` dopuszcza dziś tylko `operator_recorded`. Migracja powinna dodać `candidate_requested`. Do tego czasu źródłem prośby jest `dnc_requested` w rekordzie próby.
- Zdjęcie blokady to świadoma decyzja operatora przez `set_contact_preferences`, nie automat.

## Testy

`tests/retell-dispatch-ledger.test.mjs` (PostgreSQL 16) obejmuje:
- sam postęp rozmowy nie rozlicza puli;
- `completed` → zużyta jednostka, a `call_analyzed` nie rozlicza drugi raz;
- brak odpowiedzi, zajęte, poczta i błąd zwracają rezerwację;
- DNC blokuje email, SMS i voice, podnosi rewizję i zużywa jednostkę.

`tests/voice-preparation-privileges.test.mjs` obejmuje nową funkcję.
