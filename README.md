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
