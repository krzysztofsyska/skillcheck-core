# SkillCheck — stan prac (2026-10-01)

## Wdrożona baza
- Supabase: wsvjawuikxfzjyivxgsu, 9 tabel i 34 polityki RLS.
- Migracje 20260930000100 i 20261001000100 już wykonano. Nie wykonywać ponownie.
- ensure_initial_company chroni przed duplikacją onboardingu. Test powtórzenia i członkostwa przeszedł; test równoległych sesji pozostaje do wykonania.

## Kod w PR #1
- Rejestracja, logowanie, wylogowanie, odświeżanie sesji, tworzenie firmy.
- Odzyskiwanie hasła: /forgot-password → e-mail PKCE → /auth/callback?flow=recovery → /reset-password. Link wymaga tej samej przeglądarki. Nie wysyłano jeszcze testowych wiadomości.
- Panel /dashboard/[companyId]: profil firmy, ostatnie 50 stanowisk i rekrutacji, liczba kandydatów, utworzenie rekrutacji dla stanowiska.
- Kogo potrzebujesz: tworzenie i edycja profilu stanowiska z zadaniami, KPI, samodzielnością, kompetencjami i 8 wymaganiami behawioralnymi. Wymagania zachowań są zapisane jako teksty w required_behaviors; normalizacja do osobnych rekordów wymaga późniejszej migracji przed ocenianiem kandydatów.
- Właściciel/rekruter edytuje, viewer czyta; zapisy ponownie sprawdzają sesję i rolę, RLS pozostaje końcowym zabezpieczeniem.
- Brak obsługi kandydatów, CV, AI, voicebota, testów kompetencji, AC i raportów.

## Testy
- Przeszły: build, TypeScript, 10 testów bazy, 6 testów walidacji/bezpiecznych przekierowań, test HTTP rzeczywistego buildu Next (formularze i blokada anonimowych wejść).
- Test HTTP używa nieaktywnego testowego adresu Supabase; potwierdza zachowanie bez sesji, nie pełne logowanie.
- Pozostają: logowanie i e-mail end-to-end, dwa konta przez HTTP, test zapisów i wyglądu panelu po zalogowaniu, równoległy onboarding.

## Konfiguracja i następne kroki
- Dla odzyskiwania hasła ustawić NEXT_PUBLIC_SITE_URL na kanoniczny adres HTTPS (alternatywnie VERCEL_PROJECT_PRODUCTION_URL).
- W Supabase Auth: Site URL = domena aplikacji; dopuścić adres /auth/callback oraz /auth/callback?flow=recovery. Zachować włączone potwierdzanie e-maila. Sprawdzić limity i nadawcę przed testami e-mail.
- Rejestracja używa domyślnego szablonu Supabase; po potwierdzeniu użytkownik może wrócić do /login i zalogować się hasłem.
- Dokończyć wymienione testy i konfigurację, dopiero wtedy scalić PR i uznać etapy za wdrożone. Nie przedstawiać kodu w PR jako działającej produkcji.
- Repo lokalne i GitHub mają różne SHA wskutek publikacji przez connector. Nie wykonywać force push; bazować kolejne commity zdalne na aktualnym HEAD PR.
- Odczytano dostępną historię 6ab8157c-d460-83eb-81a9-56d7bd8aa23e. Ustalono osiem obszarów: odpowiedzialność, samodzielność, inicjatywa, wynik, współpraca, zmiana, feedback, presja. Oceny muszą mieć dowody i poziomy: brak danych/poniżej/zgodnie/powyżej wymagań. Nie diagnozować zdrowia ani automatycznie decydować o zatrudnieniu.
- Automatyzacja budowa-i-testowanie-skillcheck aktywna co godzinę. Brak zgody na nowe koszty i kontaktowanie kandydatów.
