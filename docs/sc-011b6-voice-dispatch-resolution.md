# SC-011-B6 — wyjaśnianie połączeń w stanie „nieznany” przez operatora

TASK: SC-011-B (#79), krok B6 | SCOPE: BACKEND | LEVEL: L3 | REVIEWER: niezależny Codex
STATUS: IZOLOWANY SCHEMAT, bez UI i bez kontaktu z Retell | PRODUCTION_APPROVAL: NO | DB/MIGRATIONS: brak migracji; `db/isolated/sc011b6-voice-dispatch-resolution.sql`

## Kiedy

Worker (B5) oznacza rezerwację wysyłki jako `unknown`, gdy minęło okno deduplikacji Retell (55 min z marginesem) albo limit prób, a wynik nadal jest nieznany. Nie dzwoni wtedy ponownie, a rozmowa zostaje zarezerwowana w puli. Ktoś musi sprawdzić w panelu Retell, czy połączenie wyszło.

## Procedura operatora (platform operator)

1. `listUnknownVoiceDispatches(db)` zwraca firmę, przygotowanie, czas startu, ostatnią próbę i liczbę prób. Najstarsze są pierwsze. Bez danych kandydata.
2. W panelu Retell: lista połączeń agenta SkillCheck z okresu od `startedAt` do `lastAttemptAt` + kilka minut.
3. `resolveUnknownVoiceDispatch(db, {companyId, preparationId}, decyzja)`:
   - `{resolution: "not_placed"}`: połączenia nie ma. Rezerwacja wysyłki → `abandoned`, przygotowanie zostaje anulowane, a rozmowa wraca do puli.
   - `{resolution: "placed", providerCallId, outcome, agentId}`: połączenie jest. Zapis próby z `call_id` i wynikiem. Rozliczenie B4 działa jak przy webhooku: `completed` lub `dnc_requested` zużywa rozmowę, inne wyniki zwalniają rezerwację, a `dnc_requested` blokuje kontakt. Rezerwacja wysyłki → `accepted`.
   
   Transkrypcja z takiej rozmowy nie jest odzyskiwana, bo Retell już jej nie przechowuje.

Każda decyzja trafia do `private.sc011b_dispatch_resolutions` (tylko dopisywanie) z `resolved_by`. Druga decyzja dla tej samej rezerwacji wysyłki kończy się konfliktem. Nie-operator dostaje `VOICE_RESOLUTION_FORBIDDEN`.

## Ważne szczegóły

- Funkcje działają na zaufanym połączeniu serwera, z `auth.uid()` operatora. Skutki (anulowanie, pula, blokada DNC) funkcja wykonuje jako system, tak jak webhook. Operator nie jest członkiem firmy, a strażnik usuwania danych odrzuciłby jego zapis.
- `abandoned` może ustawić wyłącznie ta funkcja (flaga sesji w strażniku). Worker traktuje każdy stan inny niż „wyślij” jako koniec bez wysyłki.
- Dodatkowy test potwierdza, że webhook bez aktora sesji, czyli tak jak w produkcji, poprawnie rozlicza DNC.

## Do zrobienia przed produkcją

Strona operatora w `/operator` (po migracji tabel), migracje z adapterami usuwania. Opcjonalnie automatyczne wyszukiwanie połączenia w Retell (`list-calls`) jako podpowiedź dla operatora, ale decyzja zostaje ręczna.

## Testy

`tests/retell-dispatch-resolution.test.mjs` (PostgreSQL 16) obejmuje:
- dostęp tylko dla operatora;
- listę bez numeru;
- `not_placed` → anulowanie, zwrot do puli, wpis w dzienniku, worker nic nie wysyła;
- `placed` z `completed`, `no_answer` i `dnc_requested` → rozliczenie i blokada;
- nieprawidłowe decyzje niczego nie zmieniają.

`tests/retell-dispatch-ledger.test.mjs` obejmuje DNC bez aktora. `tests/voice-preparation-privileges.test.mjs` obejmuje nową tabelę i funkcje.
