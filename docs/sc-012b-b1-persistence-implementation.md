# SC-012-B B1 — implementacja kontraktu persystencji (offline, bez SQL)

TASK SC-012-B/B1; LEVEL L3; SCOPE BACKEND; STATUS IMPLEMENTED_CONTRACT_ONLY; OWNER_APPROVAL PENDING; PRODUCTION_APPROVAL NO.
Issue #80, architecture PR #82 (under Codex review), source SC-012-A merged into integration.

## Zrealizowane
`lib/voice/plan-persistence-contract.ts` buduje typowany, spójny snapshot scenariusza ze znanych identyfikatorów firmy, zgłoszenia, rekrutacji, analizy, review i shortlisty. Ponownie wywołuje dotychczasowy generator SC-012-A — dopytania z allowlist, bez transkryptu/CV/danych kontaktowych. Zwraca wyłącznie pytania, źródła i kontrolowane skróty SHA-256. `validatePlanReviewCommand` oraz `validatePlanReleaseCommand` walidują kształt żądań (bez aktora z payloadu), wersje i klucze idempotency; to domenowe DTO, **nie** RPC DB ani autoryzacja.

## Ograniczenia i bramki
- Nie zapisano żadnego wiersza do Supabase, nie utworzono migracji/tabel/RPC. Bez realnej funkcji zabezpieczonego zapisu nie można twierdzić, że persystencja jest gotowa.
- Snapshot jest **propozycją danych dla zaufanego serwera**, a nie capability. `source` / `binding` mogą być skonstruowane przez caller; nie wolno uruchamiać tego modułu bez server-side RLS, DB source authorization, locków SC-006/008 i zweryfikowanej aktualnej shortlisty.
- Migracja może powstać dopiero po PASS niezależnego review architektury #82 i po sprawdzeniu kolejności blokad w SC-010-C. Należy wygenerować ją przez Supabase CLI i testować najpierw na izolowanej DB, bez `db push` produkcji.
- Review/release zatwierdza rekruter po uwierzytelnieniu: actor/tenant pochodzą z serwera. Stan po stronie React ani `generatedInProcess` nie może stać się zapisem autorytatywnym.
- Tylko status braku aktywacji, brak telefonów, Vapi, Retell, nagrania, sekretów czy billing.

## Wymagane kontrole do ukończenia SC-012-B
Rzeczywisty Postgres/PGlite RLS, FK/udziały w tenantach, RPC submit/review/release, dwie sesje dla conflict/race, brak PII w odczytach, wersjonowana historia, nowy profil/CV/review/stale, role owner/recruiter/viewer/anon, dopiero potem UI.

## Testy tej gałęzi
`node --test tests/voice-plan-persistence-contract.test.mjs`, `npm run typecheck`, `npm run build`. CI na PR; status podawać wyłącznie po sprawdzeniu.

NEXT: review architektury #82 → migration CLI + SQL/RPC/RLS w kolejnym commicie PR B1 → real DB tests → human acceptance dla integration. UI companion PR pozostaje read-only do czasu dostępności zatwierdzonych RPC.
