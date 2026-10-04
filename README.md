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
rekrutacje, kandydatów, aplikacje i etapy oceny. Zawiera logowanie, panel, profil stanowiska, rekrutacje i ręczne dodawanie kandydatów. Import tekstu/PDF/DOCX i sprawdzanie anonimizacji przeszły próby jednej zalogowanej firmy na Preview — docs/e2e-2026-10-02.md. OCR/AI/voicebot pozostają do implementacji.

Migracje 20260930000100, 20261001000100, 20261001000200, 20261002000100 20261002000200 20261002000300 i 20261004000100 wykonano już w docelowym Supabase. Stan zweryfikowany 2026-10-04: 13 tabel, 40 polityk RLS oraz trzy widoki z security_invoker. Nie uruchamiać ponownie. Kod aplikacji pozostaje w PR #1 / Preview; produkcja nadal używa wcześniejszej wersji z main.

Sprawdzenie: `npm ci`, `npm run typecheck`, `npm run test:db`, `npm run build`.

## Konfiguracja i test rzeczywistego Supabase
Skopiuj `.env.example` do ignorowanego `.env.local` i uzupełnij publiczny klucz projektu. Nie używaj klucza service_role. Na Vercel sprawdź konfigurację osobno dla Preview i Production; Site URL powinien wskazywać właściwą domenę HTTPS.

`npm run test:live` sprawdza logowanie dwóch potwierdzonych kont, odczyt własnych rekordów i odmowę odczytu obcej firmy w 13 tabelach i trzech widokach. W `.env.local` wymagane są SKILLCHECK_TEST_EMAIL_A, SKILLCHECK_TEST_PASSWORD_A oraz analogiczne wartości B. Konta muszą mieć rozłączne firmy i widoczne dane testowe w każdej relacji. Brak danych daje wynik niepełny/błąd, nigdy PASS na pustej tabeli. Przygotowanie: [docs/live-testing.md](docs/live-testing.md). Test nie zmienia danych, nie wysyła e-maili i kończy się błędem przy braku konfiguracji. Nie zastępuje testu formularzy w przeglądarce ani odzyskiwania hasła. Nigdy nie zapisuj haseł w repozytorium.

Przy zgłoszeniu do rekrutacji dostępne jest przygotowanie preselekcji: wymagania stanowiska i najnowsze zatwierdzone CV. Integracja AI nie jest uruchomiona; nie generujemy ocen ani decyzji. Kontrakt danych, ograniczenia i pozostałe kroki: [docs/screening.md](docs/screening.md).

Etapy oceny: rekruter dodaje plan etapów w rekrutacji i zapisuje status oraz notatki osobno dla każdego zgłoszenia. Konflikty edycji są wykrywane. Nie jest to automatyczne ocenianie, voicebot ani decyzja o zatrudnieniu.

Oceny z dowodami: osiem ocen człowieka przy zgłoszeniu, wymagane uzasadnienie, niezmienne wersje i kopia profilu stanowiska z chwili zapisu. Historia pokazuje autora i poprzednie wymagania; zmiana profilu albo konflikt edycji blokuje nieaktualny zapis. Szczegóły i testy: [docs/behavior-assessments.md](docs/behavior-assessments.md), `npm run test:behavior-assessments`.

Przewodnik rozmowy: przy rekrutacji dostępnych jest osiem obszarów zachowania i 16 pytań z wymaganym poziomem stanowiska oraz wskazówkami do zebrania dowodów. Brakujące lub sprzeczne wymagania są jawnie oznaczane. Rozmowę prowadzi człowiek; odpowiedzi można opisać w istniejących notatkach etapów. Zakres: [docs/interview-guide.md](docs/interview-guide.md).
