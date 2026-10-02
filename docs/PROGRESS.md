# SkillCheck — stan prac (2026-10-02)

## Wdrożona baza
- Supabase: wsvjawuikxfzjyivxgsu, 10 tabel i 37 polityk; kontrola SQL 2026-10-02 potwierdziła RLS włączone we wszystkich tabelach.
- Migracje 20260930000100, 20261001000100 i 20261001000200 już wykonano. Nie wykonywać ponownie.
- Migracja CV wykonana 2026-10-02 po potwierdzeniu braku candidate_documents. Kontrola po wykonaniu potwierdziła trzy polityki CV, aktywny wyzwalacz wersjonowania i granty RPC; anonimowy odczyt oraz bezpośrednia zmiana oryginału/metadanych zatwierdzenia są niedozwolone.
- ensure_initial_company chroni przed duplikacją onboardingu. Test powtórzenia i członkostwa przeszedł; test równoległych sesji pozostaje do wykonania.

## Kod w PR #1
- Rejestracja, logowanie, wylogowanie, odświeżanie sesji, tworzenie firmy.
- Odzyskiwanie hasła: /forgot-password → e-mail PKCE → /auth/callback?flow=recovery → /reset-password. Link wymaga tej samej przeglądarki. Nie wysyłano jeszcze testowych wiadomości.
- Panel /dashboard/[companyId]: profil firmy, ostatnie 50 stanowisk i rekrutacji, liczba kandydatów, utworzenie rekrutacji dla stanowiska.
- Kogo potrzebujesz: tworzenie i edycja profilu stanowiska z zadaniami, KPI, samodzielnością, kompetencjami i 8 wymaganiami behawioralnymi. Wymagania zachowań są zapisane jako teksty w required_behaviors; normalizacja do osobnych rekordów wymaga późniejszej migracji przed ocenianiem kandydatów.
- Właściciel/rekruter edytuje, viewer czyta; zapisy ponownie sprawdzają sesję i rolę, RLS pozostaje końcowym zabezpieczeniem.
- Kandydaci: formularz z walidacją i zachowaniem danych po błędzie, lista po 25 osób, karta kandydata, przypisanie do rekrutacji i czytelny komunikat o duplikacie. Nowa rekrutacja otwiera własną stronę ze stanowiskiem i kandydatami. Uprawnienia zapisu sprawdzane na serwerze; RLS i złożone klucze obce blokują obce firmy. Nie wymaga nowej migracji.
- CV tekstowe/TXT/PDF/DOCX i sprawdzanie anonimizacji przygotowane w kodzie (docs/cv.md); migrację 20261001000200 wykonano na Supabase. Pozostaje sprawdzenie importu i edycji w zalogowanej aplikacji. OCR, integracja AI, voicebot, testy kompetencji, AC i raporty pozostają do zbudowania.
- Dostępne są przygotowanie danych do preselekcji oraz etapy rekrutacji z ręcznymi statusami i notatkami. Nie są to działające integracje AI ani formalne testy kompetencji/AC.
- PR #1 pozostaje szkicem. Preview d76fdf7 jest Ready; /login dostępne anonimowo. Produkcja pozostaje na main 62a47ba.

## Testy
- W dotychczasowych uruchomieniach przeszły build/TypeScript, 12 raportowanych testów bazy, 11 auth/walidacji, 7 preselekcji, 2 walidacji etapów, testy HTTP rzeczywistego buildu Next i kontrola plików parsera PDF. Datowane wpisy poniżej opisują zakres poszczególnych uruchomień.
- 2026-10-02 ponownie wykonano test:cv: wszystkie 15 raportowanych testów parserów i uprawnień PostgreSQL/PGlite przeszło.
- Wzmocniono test:live: wymaga widocznego własnego rekordu dla obu firm w każdej z 10 tabel przed sprawdzeniem odczytu krzyżowego. Puste tabele i błędy API nie dają PASS. Cztery testy mechanizmu kontroli przeszły i trafiły do CI (test:live-check). Próba test:live nadal kończy się brakiem lokalnej konfiguracji; nie jest to udany test zdalny. Przygotowanie danych: docs/live-testing.md.
- Test HTTP używa nieaktywnego testowego adresu Supabase; potwierdza zachowanie bez sesji, nie pełne logowanie.
- Pozostają: logowanie i e-mail end-to-end, dwa konta przez HTTP, test zapisów i wyglądu panelu po zalogowaniu, równoległy onboarding.

## Konfiguracja i następne kroki
- 2026-10-02 zapisano Supabase Auth Site URL = https://skillcheck-core.vercel.app oraz cztery dokładne callbacki produkcji i gałęzi Preview, podane w docs/auth-configuration.md. Zachowano cztery starsze wpisy; łącznie osiem Redirect URLs. Nie zmieniano kont ani haseł.
- Vercel ma NEXT_PUBLIC_SUPABASE_URL i NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY dla All Environments. Systemowe zmienne są włączone; kod może używać VERCEL_PROJECT_PRODUCTION_URL bez osobnej NEXT_PUBLIC_SITE_URL. Sprawdzić dostawę poczty, limity i nadawcę podczas rzeczywistych testów Auth.
- Oznaczenie API DISABLED w panelu nie zostało potwierdzone jako awaria API. Kontrola SQL potwierdziła grant SELECT dla authenticated na candidates; brak rzeczywistego testu HTTP po autoryzacji. Nie rozszerzać grantów ani wyłączać RLS na podstawie samej etykiety.
- Rejestracja używa domyślnego szablonu Supabase; po potwierdzeniu użytkownik może wrócić do /login i zalogować się hasłem.
- Dokończyć wymienione testy i konfigurację, dopiero wtedy scalić PR i uznać etapy za wdrożone. Nie przedstawiać kodu w PR jako działającej produkcji.
- Repo lokalne i GitHub mają różne SHA wskutek publikacji przez connector. Nie wykonywać force push; bazować kolejne commity zdalne na aktualnym HEAD PR.
- Odczytano dostępną historię 6ab8157c-d460-83eb-81a9-56d7bd8aa23e. Ustalono osiem obszarów: odpowiedzialność, samodzielność, inicjatywa, wynik, współpraca, zmiana, feedback, presja. Oceny muszą mieć dowody i poziomy: brak danych/poniżej/zgodnie/powyżej wymagań. Nie diagnozować zdrowia ani automatycznie decydować o zatrudnieniu.
- Automatyzacja budowa-i-testowanie-skillcheck aktywna co godzinę. Brak zgody na nowe koszty i kontaktowanie kandydatów.

## Historia prac do 2026-10-02
Poniższe wpisy zachowują stan z chwili ich zapisu. Dawne informacje o oczekującej migracji CV lub niezmienionej konfiguracji Auth są historyczne; bieżący stan opisano powyżej i w ostatniej aktualizacji.

## Aktualizacja: kandydaci i domknięcie nawigacji
- Formularze profilu firmy i rekrutacji zachowują wpisane dane przy błędzie.
- Test PostgreSQL używa walidowanych danych stanowiska i kandydata, zapisuje rekrutację i zgłoszenie; sprawdza duplikat, viewer i odczyt obcej firmy. Test HTTP obejmuje nowe chronione strony. Build oraz wszystkie 20 raportowanych testów przeszły (w tym nadrzędny test bazy).
- Pełny test rzeczywistego Supabase Auth nadal NIE jest zakończony: lokalnie brak .env i danych logowania testowego. Otworzono panel Auth w zalogowanym Supabase, ale nawigacja konfiguracji URL nie powiodła się. Nie zmieniano kont, haseł ani ustawień Auth.
- Kod kandydatów wymaga sprawdzenia po zalogowaniu przed produkcją. Nie utożsamiać testów PostgreSQL i anonimowego HTTP z pełnym testem przeglądarkowym.

## Weryfikacja wdrożenia i przygotowanie testu live
- GitHub Actions run 36812151622 zakończony success dla d74d778; Vercel również success.
- Panel wdrożenia https://vercel.com/krzysztofs-projects-b7ce87b5/skillcheck-core/6zp5kKfFrTJybm6TKnYj2ywL3joF wymaga zalogowania użytkownika w przeglądarce Codex. Poproszono o tę jedną czynność.
- Dodano .env.example i test:live: dwa rzeczywiste logowania oraz odczyt RLS w 9 tabelach, bez zmian danych. Próba uruchomienia zakończyła się prawidłowym błędem braku konfiguracji; NIE uznawać za udany test integracyjny.

## Aktualizacja: tekst CV i ręczne zatwierdzenie anonimizacji
- Odczytano dostępną wcześniejszą rozmowę; pełnej specyfikacji formatów CV nie udostępnia ograniczona historia. Jawnie ograniczono pierwszą wersję do tekstu i TXT UTF-8.
- Nowa tabela candidate_documents chroni oryginał, wersjonuje poprawki i zapisuje rzeczywistego recenzenta. Zmiana tekstu cofa zatwierdzenie. Wdrożenie i testy po zalogowaniu odłożone zgodnie z prośbą użytkownika do powrotu do domu.
- Lokalnie: build/TypeScript, 11 testów bazy podstawowej, 8 walidacji, 7 CV (łącznie z testami nadrzędnymi) i test HTTP przeszły. Pierwsza kompilacja wykryła iterację Set przy starym celu TS; poprawiono na Array.from i ponowiono build.
- Nie uruchomiono nowych płatnych usług, nie wysyłano dokumentów do AI ani wiadomości do kandydatów.

## Aktualizacja: odczyt tekstowego PDF
- Dodano pdf-parse 2.4.5, odczyt PDF do 750 KB / 20 stron / 100 000 znaków, odrzucanie pustych stron, skanów i uszkodzonego formatu. Bez zewnętrznego AI i bez zachowywania pliku binarnego. DOCX/OCR wciąż nieobsługiwane.
- Testy PDF przeszły dla syntetycznych dokumentów, w tym kompresji, kolejności stron i limitów; testy pozostałego CV przeszły w tym uruchomieniu. Build/TypeScript, test HTTP i test:pdf-bundle przeszły. Uzupełniono tracing workera i natywnych zależności po wykryciu braków w pierwszym manifeście.
- Brak nowej migracji: moduł nadal czeka na 20261001000200 i testy zalogowanej wersji na Vercel po powrocie użytkownika. Żadnej migracji ani wdrożenia produkcyjnego nie uruchomiono.

## Aktualizacja: odczyt DOCX
- Dodano odczyt akapitów i tabel DOCX, polskie znaki, limity 750 KB pliku / 500 wpisów / 2 MB wpisu / 10 MB rozpakowanego archiwum / 100 000 znaków tekstu. Parser otrzymuje archiwum odbudowane ze sprawdzonych wpisów.
- Odrzucane: błędny format, szyfrowanie, duplikaty/niebezpieczne ścieżki, DTD, osadzone programy i elementy pomijane przez parser. Nagłówki, stopki i przypisy wymagają wklejenia pełnej treści lub tekstowego PDF. Nie dodano OCR ani integracji zewnętrznej.
- Testy CV: 15 raportowanych testów (w tym nadrzędny test RLS), wszystkie przeszły; w tej liczbie 5 nowych scenariuszy DOCX z wieloma przypadkami błędów. Pierwszy typecheck wykrył brak jawnego typu wpisu ZIP, poprawiono.
- Migracja CV i testy zalogowanego wdrożenia nadal czekają na powrót użytkownika; nie wykonywano migracji ani scalenia do main.
- Końcowa kompilacja z TypeScript, test HTTP buildu oraz kontrola plików parsera PDF w manifeście przeszły. npm install zgłosił 0 znanych podatności.

## Aktualizacja: przygotowanie preselekcji dla zgłoszenia
- Odczytano ponownie dostępną wcześniejszą rozmowę; historia jest ograniczona i nie zawiera pełnej specyfikacji AI.
- Przy kandydacie w rekrutacji dodano stronę przygotowania: wymagania stanowiska i najnowsze zatwierdzone CV. Nowszy szkic, obca firma/kandydat i zamknięte zgłoszenie blokują przygotowanie. Brak migracji CV pokazuje komunikat.
- Kontrakt danych wyklucza oryginał, dane kontaktowe i identyfikatory z przyszłego payload. Powiązanie wersji i walidator cytatów chronią przed nieaktualnym lub niezgodnym wynikiem. Zachowania pozostają do oceny w rozmowie/zadaniach.
- Brak połączenia AI i zapisów wyników: ekran jawnie to komunikuje. Integracja, budżet, kontrola kosztów i zapis z RLS nadal do zbudowania (docs/screening.md). Nie zakupiono usług ani nie wysłano danych.
- Przeszły: 7 testów preselekcji, build/TypeScript, 11 raportowanych testów podstawowej bazy i izolacji firm, test HTTP z nową trasą oraz kontrola plików PDF. Testy zalogowanej wersji oraz migracja CV nadal odłożone; nie zmieniono produkcji.

## Aktualizacja: etapy i ręczne notatki rekrutera
- Dodawanie etapów w rekrutacji (nazwa, opis, jednoznaczna kolejność). Każde zgłoszenie ma osobny ekran postępu: oczekuje, w trakcie, zakończony, pominięty. Zakończenie/pominięcie wymaga notatki. Nie ma automatycznej decyzji o kandydacie ani kontaktu z nim.
- Tworzenie i zapisy kontrolują sesję i rolę, firmę, rekrutację i zgłoszenie. Baza chroni przed duplikatami i relacjami z obcej rekrutacji. Zapis istniejącej notatki porównuje updated_at, aby starsze okno nie nadpisało nowej wersji. Ponowne otwarcie etapu usuwa datę zakończenia; edycja notatki zakończonego etapu ją zachowuje.
- Definicje etapów są dodawane, bez edycji/usuwania w interfejsie. Nie dodano skali punktowej, rubryk testów, wersjonowania definicji ani pełnego audytu autorów notatek; potrzebne przed formalnymi ocenami/raportami. To rejestr ręcznego postępu, nie działający voicebot/test kompetencji/AC.
- Nie wymaga nowej migracji; używa assessment_stages i candidate_assessments z istniejącej bazy. Nie zmieniano migracji już wykonanych.
- Przeszły 2 testy walidacji, 12 raportowanych testów bazy (z cyklem etapów, duplikatami, konfliktem notatek i RLS), build/TypeScript i test HTTP nowej chronionej strony. Testy zalogowanej wersji nadal niewykonane.

## Kontrola konfiguracji — obserwacje 2026-10-01, zapis 2026-10-02
- Vercel: zalogowany panel dostępny. Produkcja Ready, nadal main 62a47ba, wdrożenie B5VamFwj7JpY9SwUmK7CgBgbJdnS. Preview dla badb889 gotowy: 98Bk9AAofmKzABXL9f6hKZNetyYE. GitHub Checks run 36879665470: success.
- Vercel Environment Variables: NEXT_PUBLIC_SUPABASE_URL i NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY obecne, All Environments. Nie ujawniano wartości. Brak osobnej NEXT_PUBLIC_SITE_URL na liście Project. System environment variables włączone; kod ma fallback VERCEL_PROJECT_PRODUCTION_URL.
- Supabase URL Configuration: Site URL = https://skillcheck-core-krzysztofs-projects-b7ce87b5.vercel.app/; redirect allowlist zawiera tę domenę z / i /** oraz wzorzec https://skillcheck-*-core-krzysztofs-projects-b7ce87b5.vercel.app (także /**). Nie zawiera widocznej produkcyjnej domeny skillcheck-core.vercel.app ani właściwego adresu gałęzi preview. Do poprawienia i przetestowania przed uznaniem poczty/recovery za gotowe. Nie zmieniano ustawień.
- Supabase Policies: widoczne 9 tabel i 34 polityki authenticated, RLS włączone; candidate_documents nie ma na liście. Panel wyświetla także API DISABLED i informację o custom Data API permissions. Ten znacznik nie został zweryfikowany testem API po zalogowaniu; nie zmieniać grantów ani wyłączać RLS na podstawie samej etykiety.
- Próba otwarcia produkcyjnego /api/health/supabase w przeglądarce została zablokowana ERR_BLOCKED_BY_CLIENT; nie potwierdza ani awarii Supabase, ani udanego połączenia. Konieczny rzeczywisty test aplikacji i dwóch kont.

## Aktualizacja 2026-10-02: adresy Auth dla Preview i produkcji
- PR #1 pozostaje szkicem; dla bc9119e GitHub Checks run 37009180127 i Vercel ExUtc2ndqtZXV9sBKLrUXC2a4dtW zakończyły się sukcesem.
- Naprawiono fallback Preview do produkcji: adresy wiadomości pochodzą z konfiguracji danego wdrożenia, Origin żądania musi dokładnie pasować. Rejestracja dostała jawne emailRedirectTo; odzyskiwanie korzysta z tego samego mechanizmu.
- Uzupełniono komunikaty tej samej przeglądarki i błędnego/wygasłego linku. Callback ustawia no-store/no-referrer również przy błędzie.
- Konfiguracji Supabase nie zmieniono. Dokładne brakujące callbacki i instrukcje testów zapisano w docs/auth-configuration.md. Nie tworzono kont ani nie wysyłano prawdziwych wiadomości.
- Przeszły: 11 testów auth/walidacji, build/TypeScript, test HTTP formularzy i chronionych tras oraz nowy test rzeczywistych akcji Next z lokalnym stubem Auth. Testy HTTP powtórzono po zakończeniu buildu. Dostawy poczty i rzeczywistego logowania nadal nie zweryfikowano.

## Aktualizacja 2026-10-02: konfiguracja Auth i migracja CV w Supabase
- W panelu Supabase zapisano produkcyjny Site URL i cztery dokładne callbacki dla produkcji oraz gałęzi Preview. Panel potwierdził osiem wpisów po zachowaniu czterech wcześniejszych. Szczegóły w docs/auth-configuration.md.
- Precheck SQL potwierdził 9 tabel / 34 polityki i brak candidate_documents. Wykonano wyłącznie migrację 20261001000200_candidate_documents.sql; SQL Editor zwrócił Success. Nie ponawiano migracji podstawowej ani onboardingu.
- Weryfikacja SQL po migracji: 10 tabel / 37 polityk, RLS włączone we wszystkich tabelach, trzy polityki candidate_documents i aktywny wyzwalacz wersjonowania. Authenticated ma grant odczytu, edycji redacted_text i wywołania RPC review_candidate_document; nie ma bezpośredniego UPDATE source_text ani metadanych zatwierdzenia. Anon nie ma odczytu ani wywołania RPC. Potwierdzono również grant SELECT authenticated na candidates.
- Ponownie przeszło 15 testów test:cv. Nie wykonano rzeczywistego testu HTTP z autoryzacją ani testu dwóch kont; nadal brak danych logowania testowego. PGlite i kontrola SQL nie zastępują tych testów.
- Vercel Preview d76fdf7 Ready, /login otwiera się anonimowo. Produkcja nadal main 62a47ba; PR #1 nie został scalony. Nie tworzono kont, nie wysyłano poczty, CV do AI ani wiadomości do kandydatów.
