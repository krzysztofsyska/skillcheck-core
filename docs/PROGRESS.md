# SkillCheck — stan prac

- Etap 1: migracja 20260930000100 wykonana w Supabase w projekcie wsvjawuikxfzjyivxgsu. Zweryfikowano 9 tabel, 34 polityki RLS, brak uprawnień anon. Nie wykonywać ponownie.
- Kod etapu 1: PR #1 (feat/tenant-database), lokalny commit i commit na GitHub różnią się z powodu publikacji przez connector. Nie wykonywać force push.
- Etap 2: dodano rejestrację, logowanie, wylogowanie, odświeżanie sesji, chroniony onboarding firmy i stronę listy firm. Brak finalnego panelu rekrutacji.
- Rejestracja używa standardowego potwierdzenia Supabase; po potwierdzeniu użytkownik wraca do /login i loguje się hasłem. Site URL w Supabase musi wskazywać prawdziwą domenę aplikacji. Endpoint /auth/callback obsługuje PKCE, jeśli skonfigurowano taki redirect.
- Następne kroki: testy sesji i dwóch kont w środowisku testowym, konfiguracja adresów Auth w Supabase/Vercel, idempotentny onboarding odporny na równoległe żądania, odzyskiwanie hasła. Następnie panel i formularz Kogo potrzebujesz.
- W dalszych etapach: CV, anonimizacja, AI, voicebot, kompetencje, AC, raport. Wczytać szczegółowe wcześniejsze ustalenia z rozmowy 6ab8157c-d460-83eb-81a9-56d7bd8aa23e. Decyzje rekrutacyjne zatwierdza człowiek. Nie kontaktować kandydatów bez upoważnienia.
- Automatyzacja budowa-i-testowanie-skillcheck jest aktywna co godzinę w tym czacie.

- Weryfikacja 2026-10-01: npm run typecheck, npm run build, npm run test:db (9) i npm run test:auth (2) przeszły. Nie wykonano jeszcze testu logowania z prawdziwą skrzynką ani sesji w dwóch firmach przez HTTP. Zmiany etapu 2 są szkicem, nie ukończonym wdrożeniem.
