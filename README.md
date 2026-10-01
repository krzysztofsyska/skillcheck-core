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
rekrutacje, kandydatów, aplikacje i etapy oceny. Zawiera logowanie, panel, profil stanowiska, rekrutacje i ręczne dodawanie kandydatów. Tekst CV/TXT/PDF i weryfikacja anonimizacji są przygotowane; wymagają nowej migracji opisanej w docs/cv.md. DOCX/OCR/AI/voicebot pozostają do implementacji.

Migracje 20260930000100 i 20261001000100 wykonano już w docelowym Supabase. Nie uruchamiać ponownie.

Sprawdzenie: `npm ci`, `npm run typecheck`, `npm run test:db`, `npm run build`.

## Konfiguracja i test rzeczywistego Supabase
Skopiuj `.env.example` do ignorowanego `.env.local` i uzupełnij publiczny klucz projektu. Nie używaj klucza service_role. Na Vercel sprawdź konfigurację osobno dla Preview i Production; Site URL powinien wskazywać właściwą domenę HTTPS.

`npm run test:live` sprawdza logowanie dwóch potwierdzonych kont i odmowę odczytu obcej firmy we wszystkich 10 tabelach (po migracji CV). W `.env.local` wymagane są SKILLCHECK_TEST_EMAIL_A, SKILLCHECK_TEST_PASSWORD_A oraz analogiczne wartości B. Konta muszą mieć różne istniejące firmy testowe. Test nie zmienia danych, nie wysyła e-maili i kończy się błędem przy braku konfiguracji. Nie zastępuje testu formularzy w przeglądarce ani odzyskiwania hasła. Nigdy nie zapisuj haseł w repozytorium.
