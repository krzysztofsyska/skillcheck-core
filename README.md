# SkillCheck

Nowa baza aplikacji SkillCheck.

## Stack
- Next.js 16
- TypeScript
- Vercel
- Supabase
- OpenAI API — kolejny etap

## Supabase
Projekt zawiera klienta przeglądarkowego i serwerowego zgodnego z `@supabase/ssr`.
Integracja Vercel ↔ Supabase dostarcza zmienne środowiskowe.

Endpoint diagnostyczny:
`/api/health/supabase`

Oczekiwany wynik po poprawnym połączeniu:
`{"ok":true,"service":"supabase"}`

Stara wersja projektu jest zachowana w gałęzi `archive-old-version`.

## Etap 1 — model danych

Migracja SQL, zasady dostępu firm i przykłady użycia są opisane w
[docs/database.md](docs/database.md). Kod obejmuje firmy, profile firm, stanowiska,
rekrutacje, kandydatów, aplikacje i etapy oceny. Nie wdraża CV/AI/voicebota ani UI logowania.

Migracja wymaga osobnego wykonania w Supabase; wdrożenie na Vercel jej nie uruchamia.

Sprawdzenie: `npm ci`, `npm run typecheck`, `npm run test:db`, `npm run build`.
