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
- Kandydaci: formularz z walidacją i zachowaniem danych po błędzie, lista po 25 osób, karta kandydata, przypisanie do rekrutacji i czytelny komunikat o duplikacie. Nowa rekrutacja otwiera własną stronę ze stanowiskiem i kandydatami. Uprawnienia zapisu sprawdzane na serwerze; RLS i złożone klucze obce blokują obce firmy. Nie wymaga nowej migracji.
- Brak CV, AI, voicebota, testów kompetencji, AC i raportów.

## Testy
- Przeszły: build, TypeScript, 11 testów bazy, 8 testów walidacji/bezpiecznych przekierowań, test HTTP rzeczywistego buildu Next (formularze i blokada anonimowych wejść).
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

## Aktualizacja: kandydaci i domknięcie nawigacji
- Formularze profilu firmy i rekrutacji zachowują wpisane dane przy błędzie.
- Test PostgreSQL używa walidowanych danych stanowiska i kandydata, zapisuje rekrutację i zgłoszenie; sprawdza duplikat, viewer i odczyt obcej firmy. Test HTTP obejmuje nowe chronione strony. Build oraz wszystkie 20 raportowanych testów przeszły (w tym nadrzędny test bazy).
- Pełny test rzeczywistego Supabase Auth nadal NIE jest zakończony: lokalnie brak .env i danych logowania testowego. Otworzono panel Auth w zalogowanym Supabase, ale nawigacja konfiguracji URL nie powiodła się. Nie zmieniano kont, haseł ani ustawień Auth.
- Kod kandydatów wymaga sprawdzenia po zalogowaniu przed produkcją. Nie utożsamiać testów PostgreSQL i anonimowego HTTP z pełnym testem przeglądarkowym.

## Weryfikacja wdrożenia i przygotowanie testu live
- GitHub Actions run 36812151622 zakończony success dla d74d778; Vercel również success.
- Panel wdrożenia https://vercel.com/krzysztofs-projects-b7ce87b5/skillcheck-core/6zp5kKfFrTJybm6TKnYj2ywL3joF wymaga zalogowania użytkownika w przeglądarce Codex. Poproszono o tę jedną czynność.
- Dodano .env.example i test:live: dwa rzeczywiste logowania oraz odczyt RLS w 9 tabelach, bez zmian danych. Próba uruchomienia zakończyła się prawidłowym błędem braku konfiguracji; NIE uznawać za udany test integracyjny.

