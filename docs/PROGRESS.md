# Punkt kontrolny 2026-10-04 — audyt, bez nowych modułów

**NOT READY do merge.** Najnowsze polecenie właściciela w PR #1 zastępuje starsze plany rozwoju poniżej. Obowiązuje audyt i naprawy regresji, bez nowych modułów i bez merge do main. Pełna macierz, SHA i wyniki: [audit-2026-10-04.md](audit-2026-10-04.md).

- Kod GitHub/Preview 4c4a369d8b8939595048ec00aaf809dc13003620 zgodny z lokalnym kodem (cztery różnice wyłącznie CRLF/LF). Main 62a47ba bez zmian.
- Wszystkie lokalne zestawy: 96 raportowanych testów PASS, typecheck/build/pdf-bundle PASS. test:live BLOCKED przez brak konfiguracji i kont, nie zaliczony.
- Supabase: 13 tabel RLS, 40 polityk, trzy widoki security_invoker; siedem migracji wykonano, nie ponawiać.
- Preview: obserwacje v1/v2, historia i konflikt starego okna potwierdzone. Ponowiono TXT/PDF/DOCX, ręczne zatwierdzenie i blokadę/odblokowanie przygotowania preselekcji.
- Użytkownik dostarczył dwa adresy dla kont testowych; rejestracja/potwierdzenie i hasła pozostają do wykonania. Nadal brak pełnego Auth/poczty, dwóch firm, ról, równoległego onboardingu i kompletnego E2E na jednym HEAD.
- Starsze wpisy poniżej są chronologią, nie aktualną instrukcją wdrażania kolejnych modułów.
# Aktualizacja 2026-10-04 — obserwacje wykonania zadań

- Dodano tabelę historii, widok security_invoker, walidację SQL i RPC, typy, akcję serwerową, wybór wersji zadania, formularz i historię przy zgłoszeniu. Ocena wiąże się z niezmienną wersją rubryki, nie z jej najnowszą wersją. Dowody są wymagane; brak danych oddzielny. Stare zapisy dają PT409.
- Migracja 20261004000100_exercise_observations.sql wykonana w Supabase z wynikiem Success po prechecku; NIE ponawiać żadnej z siedmiu migracji. Szczegóły: docs/exercise-observations.md.
- Build/TypeScript, 26 raportowanych testów assessments, HTTP nowych tras i 5 testów checkera przeszły. Test:live rozszerzony na 13 tabel / trzy widoki (16 relacji). Rzeczywiste dwie firmy i pełny Auth nadal niewykonane. Zalogowany test nowego formularza czeka na Preview.
# Aktualizacja 2026-10-04 — migracja zadań i test Preview

- Wykonano 20261002000300_exercise_definitions.sql po potwierdzeniu braku obiektów. Docelowa baza ma 12 tabel z RLS, 39 polityk i dwa widoki security_invoker. NIE ponawiać żadnej z sześciu migracji. Poniższe starsze wpisy o oczekiwaniu na migrację/login są historyczne.
- Na Preview rzeczywista sesja właściciela utworzyła zadanie TEST z dwoma kryteriami, zapisała wersje 1 i 2; historia zachowała stare dane. Stare okno odrzucono, tekst formularza zachowano. Szczegóły i identyfikatory: docs/e2e-2026-10-04.md.
- Dodano walidator obserwacji wykonania z testami, bez UI i persystencji. TypeScript, build oraz 19 testów assessments przeszły. Rozszerzono checker izolacji na 12 tabel i dwa widoki; pełny test dwóch rzeczywistych firm nadal niewykonany.
- Dalej: zapis i formularz obserwacji powiązane z konkretną wersją definicji, raport, pozostałe próby Auth/rol/firm. Produkcja bez zmian, kod w PR/Preview; AI i voicebot niepołączone.
# SkillCheck — stan prac (2026-10-04)

## Interfejs definicji zadań — 2026-10-04
- Dokończono formularz po przerwanym uruchomieniu oraz strony listy, tworzenia, edycji i historii. Nawigacja z rekrutacji; lista po 25 zadań i historia po 20 wersji. Strony sprawdzają sesję i filtrują firmę/rekrutację. Viewer i zamknięte procesy nie mają edycji. Brak nowej migracji wyświetla jawny komunikat.
- Formularz ma 1–12 dynamicznych kryteriów ze stabilnymi kluczami, zachowuje dane po błędach i blokuje zmiany podczas zapisu. Kontekst wersji/profilu pozostaje zamrożony, wersja zwiększa się dopiero po potwierdzeniu RPC. Historia pokazuje kryteria, autora i pełną kopię profilu, a zmiana wymagań daje ostrzeżenie.
- Przeszły TypeScript, build, 16 raportowanych testów etapów/definicji/migracji oraz HTTP anonimowego wejścia/no-store do trzech nowych tras. Nie wykonano jeszcze interakcyjnego testu zalogowanego UI ani zapisu Preview.
- Próba wejścia do Supabase pokazała Session expired. Migracja 20261002000300 nadal NIE została wykonana; pięciu poprzednich nie ponawiać. Następny krok: ponowne zalogowanie do Supabase, kontrola stanu przed migracją, wykonanie nowej migracji i weryfikacja formularza w Preview. Następnie obserwacje wykonania i raport.

## Nowy etap — wersjonowane definicje zadań
- Przygotowano migrację 20261002000300_exercise_definitions.sql oraz typy Supabase dla zadań kompetencyjnych i Assessment Center. Migracja NIE została wykonana w docelowym Supabase; stan wdrożonej bazy poniżej pozostaje bez zmian. Nowa tabela historii, widok security_invoker i transakcyjne RPC zachowują autora, wersję oraz profil stanowiska; stary formularz i zmiana profilu dają PT409. Nie ma bezpośrednich zapisów tabeli z klienta.
- Baza niezależnie waliduje definicję i kryteria, usuwa obce pola JSON, blokuje przenoszenie zadania między rekrutacjami/firmami i ponowienie pierwszego zapisu. Owner/recruiter zapisują, viewer czyta. Zamknięta rekrutacja, zarchiwizowane stanowisko i odebrane członkostwo blokują zapis.
- npm run test:assessments: 12 raportowanych testów przeszło (w tym nadrzędny test migracji); kontrola TypeScript bez emisji przeszła. Test migracji używa PostgreSQL/PGlite z dwiema firmami i rolami. Nie jest testem rzeczywistego Auth ani równoczesnych połączeń. Testy włączone do istniejącego CI.
- Dalej: formularz tworzenia/edycji zadań i historia, zastosowanie nowej migracji po przygotowaniu UI, próby Preview, a następnie obserwacje wykonania powiązane z konkretną wersją rubryki i raport. Szczegóły: docs/exercise-definitions.md. Ten etap nie jest jeszcze gotowym modułem UI ani działającym Assessment Center.

## Bieżący wynik — zalogowany test Preview
- Użytkownik samodzielnie zarejestrował konto i utworzył firmę. Potwierdzono działającą sesję właściciela oraz rzeczywiste odczyty i zapisy na Vercel/Supabase. Nie obserwowano całego przepływu poczty ani odzyskiwania hasła.
- Na jawnie fikcyjnych danych TEST przeszły: stanowisko, rekrutacja, kandydat bez kontaktu, przypisanie i blokada duplikatu, tekst CV, import PDF i DOCX (polskie znaki i tabela), edycja/zatwierdzenie CV, cofnięcie zatwierdzenia po zmianie i konflikt dwóch okien. Najnowszy szkic blokuje preselekcję mimo starszego zatwierdzonego CV; po zatwierdzeniu przygotowanie jest dostępne. AI nie jest połączone.
- Etap zapisuje status i notatkę, zachowuje je po odświeżeniu; zakończenie pokazuje datę. Przewodnik pokazuje osiem obszarów / 16 pytań i poziomy zgodne ze stanowiskiem, w tym rozwijane wskazówki. Szczegóły i ograniczenia: docs/e2e-2026-10-02.md.
- Dane TEST pozostawiono do dalszych prób; nie zmieniano rzeczywistego profilu firmy, nie kontaktowano kandydatów. Generator scripts/create-test-cv-fixtures.mjs odtwarza syntetyczne pliki PDF/DOCX użyte w próbie.

## Oceny z dowodami — implementacja i migracja
- Dokończono formularz ośmiu ocen przy zgłoszeniu, zapis przez transakcyjne RPC i historię po 20 wpisów z kopią profilu stanowiska. Rekruter/właściciel zapisuje; viewer czyta. Każda poprawka tworzy wersję, a autor i wymagania pochodzą z bazy. Konflikt oceny lub profilu blokuje zapis, nie nadpisuje dowodów. Brak integracji AI lub automatycznej decyzji.
- Migracja 20261002000100_behavior_assessments.sql wykonana 2026-10-02 po potwierdzeniu braku nowej tabeli/widoku. Wynik Success; kontrola SQL: 11 tabel, 38 polityk, RLS nowej tabeli, security_invoker widoku, brak odczytu anon i bezpośredniego zapisu authenticated, dostępne RPC. NIE uruchamiać jej ponownie.
- Próba Preview wykryła dwa problemy: reset listy oceny po akcji React oraz długie ponawianie konfliktu 40001 przez PostgREST. Zablokowano reset formularza; migrację naprawczą 20261002000200_behavior_conflict_response.sql wykonano z wynikiem Success. Konflikty domenowe używają teraz PT409; nie zmienia to reguł dostępu. Nie ponawiać żadnej z pięciu migracji. Powtórne testy poprawionej wersji przeszły; nie pozostały aktywne zapytania RPC po konflikcie.
- Przeszły 12 raportowanych testów nowych ocen (w tym nadrzędny test bazy), 6 przewodnika, 4 mechanizmu live, typecheck, build i HTTP obu nowych chronionych tras. Pierwsza próba testu widoku oczekiwała złego kodu błędu; poprawiono oczekiwanie na PostgreSQL 55000 dla nieaktualizowalnego widoku i sprawdzono osobno brak grantu UPDATE.
- Zalogowany test Preview 9390785 przeszedł: pięć wersji fikcyjnej oceny, zachowanie wybranej wartości po zapisie, brak utraty notatki w innym obszarze, odmowa zapisu ze starego okna oraz po zmianie profilu. Historia zachowała Wysoki w wersjach 1–4 i Standardowy w wersji 5; rozwinięta kopia profilu zawiera poprzednie zadania, KPI i wymagania. GitHub Checks 37038905809 oraz Vercel: success. Szczegóły docs/behavior-assessments.md i docs/e2e-2026-10-02.md.
- Następnie: dalsze rubryki testów kompetencji/AC i raport oparty na dowodach; zewnętrzne AI/voicebot wymagają dostawcy, kluczy i budżetu. Niezależnie pozostają druga firma, role, poczta/recovery i równoległy onboarding. Testy dwóch okien jednej sesji nie potwierdzają izolacji dwóch rzeczywistych firm.

## Wdrożona baza
- Supabase: wsvjawuikxfzjyivxgsu, 11 tabel i 38 polityk po migracji ocen. Poprzednia kontrola potwierdziła RLS w dziesięciu tabelach, kolejna także w nowej tabeli; widok ocen używa security_invoker.
- Migracje 20260930000100, 20261001000100, 20261001000200, 20261002000100 i 20261002000200 już wykonano. Nie wykonywać ponownie.
- Migracja CV wykonana 2026-10-02 po potwierdzeniu braku candidate_documents. Kontrola po wykonaniu potwierdziła trzy polityki CV, aktywny wyzwalacz wersjonowania i granty RPC; anonimowy odczyt oraz bezpośrednia zmiana oryginału/metadanych zatwierdzenia są niedozwolone.
- ensure_initial_company chroni przed duplikacją onboardingu. Test powtórzenia i członkostwa przeszedł; test równoległych sesji pozostaje do wykonania.

## Kod w PR #1
- Rejestracja, logowanie, wylogowanie, odświeżanie sesji, tworzenie firmy.
- Odzyskiwanie hasła: /forgot-password → e-mail PKCE → /auth/callback?flow=recovery → /reset-password. Link wymaga tej samej przeglądarki. Nie wysyłano jeszcze testowych wiadomości.
- Panel /dashboard/[companyId]: profil firmy, ostatnie 50 stanowisk i rekrutacji, liczba kandydatów, utworzenie rekrutacji dla stanowiska.
- Kogo potrzebujesz: tworzenie i edycja profilu stanowiska z zadaniami, KPI, samodzielnością, kompetencjami i 8 wymaganiami behawioralnymi. Wymagania są w required_behaviors; zapis oceny waliduje jednoznaczność obszaru i kopiuje wymagany poziom oraz pełny profil do wersjonowanego wpisu.
- Właściciel/rekruter edytuje, viewer czyta; zapisy ponownie sprawdzają sesję i rolę, RLS pozostaje końcowym zabezpieczeniem.
- Kandydaci: formularz z walidacją i zachowaniem danych po błędzie, lista po 25 osób, karta kandydata, przypisanie do rekrutacji i czytelny komunikat o duplikacie. Nowa rekrutacja otwiera własną stronę ze stanowiskiem i kandydatami. Uprawnienia zapisu sprawdzane na serwerze; RLS i złożone klucze obce blokują obce firmy. Nie wymaga nowej migracji.
- CV tekstowe/TXT/PDF/DOCX i sprawdzanie anonimizacji są w Preview (docs/cv.md); migrację 20261001000200 wykonano na Supabase. Import PDF/DOCX, wklejanie i edycję sprawdzono w zalogowanej aplikacji na fikcyjnych danych. OCR, integracja AI, voicebot, testy kompetencji, AC i raporty pozostają do zbudowania.
- Dostępne są przygotowanie danych do preselekcji oraz etapy rekrutacji z ręcznymi statusami i notatkami. Nie są to działające integracje AI ani formalne testy kompetencji/AC.
- Przewodnik rozmowy przy rekrutacji: osiem obszarów, 16 pytań sytuacyjnych, definicje oraz wskazówki do zebrania dowodów. Wymagania są odczytywane z aktualnego stanowiska; niepełne, błędne lub sprzeczne zapisy są oznaczane do sprawdzenia. Linki ze strony rekrutacji, preselekcji i etapów oceny. Bez nowej migracji ani kontaktowania kandydatów; szczegóły docs/interview-guide.md.
- PR #1 pozostaje szkicem. Zalogowane testy podstawowego przepływu wykonano na Preview 1e4a3dd, a ocen i historii na 9390785. CI i Vercel dla obu wersji zakończyły się sukcesem. Produkcja pozostaje na main 62a47ba.

## Testy
- W dotychczasowych uruchomieniach przeszły build/TypeScript, 12 raportowanych testów bazy, 11 auth/walidacji, 7 preselekcji, 2 walidacji etapów, testy HTTP rzeczywistego buildu Next i kontrola plików parsera PDF. Datowane wpisy poniżej opisują zakres poszczególnych uruchomień.
- 2026-10-02 ponownie wykonano test:cv: wszystkie 15 raportowanych testów parserów i uprawnień PostgreSQL/PGlite przeszło.
- Test:live wymaga widocznego własnego rekordu obu firm w 11 tabelach i widoku ocen przed sprawdzeniem odczytu krzyżowego. Puste tabele i błędy API nie dają PASS. Cztery testy mechanizmu kontroli przeszły i trafiły do CI. Próba test:live nadal nie została wykonana z dwoma kontami; lokalnie brak konfiguracji. Przygotowanie: docs/live-testing.md.
- Przewodnik rozmowy: 6 testów mapowania wymagań przeszło; build z TypeScript oraz test HTTP blokady anonimowego wejścia i no-store również przeszły. Zalogowany odczyt wymagań testowej rekrutacji na Vercel potwierdzono 2026-10-02.
- Test HTTP używa nieaktywnego testowego adresu Supabase; potwierdza zachowanie bez sesji, nie pełne logowanie.
- Pozostają: pełny przepływ logowania/poczty/recovery, dwa konta przez HTTP, role viewer/recruiter i równoległy onboarding. Test jednej sesji właściciela nie potwierdza izolacji dwóch rzeczywistych firm. Formularza rzeczywistego profilu firmy nie zmieniano.

## Konfiguracja i następne kroki
- 2026-10-02 zapisano Supabase Auth Site URL = https://skillcheck-core.vercel.app oraz cztery dokładne callbacki produkcji i gałęzi Preview, podane w docs/auth-configuration.md. Zachowano cztery starsze wpisy; łącznie osiem Redirect URLs. Nie zmieniano kont ani haseł.
- Vercel ma NEXT_PUBLIC_SUPABASE_URL i NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY dla All Environments. Systemowe zmienne są włączone; kod może używać VERCEL_PROJECT_PRODUCTION_URL bez osobnej NEXT_PUBLIC_SITE_URL. Sprawdzić dostawę poczty, limity i nadawcę podczas rzeczywistych testów Auth.
- Oznaczenie API DISABLED w panelu nie było dowodem awarii: 2026-10-02 rzeczywista zalogowana aplikacja odczytała i zapisała testowe rekordy przez Supabase. Nie rozszerzano grantów ani nie wyłączano RLS.
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

## Przygotowanie zadań kompetencyjnych i Assessment Center
- Dodano lib/exercise-definition.ts: wspólny walidator definicji zadania człowieka. Wymaga instrukcji, oczekiwanego rezultatu, czasu 1–180 minut i 1–12 kryteriów z odrębnymi opisami zachowań poniżej/zgodnie/powyżej wymagań. Odrzuca puste lub zbyt długie pola, powtórzone kompetencje po normalizacji Unicode i nieodróżnialne opisy poziomów. Odrzuca nieznane rodzaje; wynik nie przenosi podanych z zewnątrz firm ani punktacji.
- Trzy nowe testy walidatora oraz dwa dotychczasowe testy etapów przeszły; TypeScript bez emisji również. Usunięto zbędną flagę regex u po pierwszym błędzie zgodności ze starszym celem TypeScript. Nowe testy włączono do istniejącego test:assessments, więc obejmuje je CI.
- To sprawdzony kontrakt danych do następnego etapu, NIE gotowy moduł UI ani zapis zadań w bazie. Dalej: definicje i wersjonowanie rubryk w bazie z RLS, formularz przygotowania zadania, obserwacje z dowodami oraz raport. Nie wykonywano migracji ani nie publikowano produkcji. Ponownie odczytano dostępną wcześniejszą rozmowę; ograniczona historia nie zawiera pełnej specyfikacji ćwiczeń.

## Przygotowanie formularza zadań
- Dodano parseExerciseFormData do odbioru natywnych pól formularza: pola pojedyncze muszą wystąpić dokładnie raz, a kryteria mają równoliczne kolumny. Pliki w polach tekstowych, brakujące opisy, nadmiarowe wiersze i niejednoznaczny zapis czasu są odrzucane. Firma, autor i wersja przesłane jako obce pola nie trafiają do definicji.
- Pięć testów walidatora/formularza oraz kontrola TypeScript przeszły. Nowe testy są już objęte test:assessments i CI. Nie wykonywano migracji ani zmian produkcji. Pozostaje interfejs i serwerowa akcja zapisu; parser sam nie zapewnia autoryzacji, którą trzeba sprawdzić przed RPC.

## Akcja zapisu definicji — 2026-10-03
- Dodano serwerową akcję saveExerciseDefinition: sprawdzenie sesji/roli i przynależności rekrutacji do firmy, walidacja formularza i kontekstu wersji, wywołanie transakcyjnego RPC oraz odświeżenie przyszłej trasy exercises. Nie przyjmuje autora ani firmy z pól definicji. Zwraca id zapisanej wersji; formularz powinien aktualizować swój kontekst dopiero po potwierdzonym sukcesie.
- Czytelne błędy rozróżniają konflikt, brak uprawnień, zamknięty proces, niepoprawne kryteria i brak migracji. Przy nieznanym wyniku komunikat zaleca sprawdzenie historii przed ponowieniem. Siedem testów walidatora/formularza/kontekstu i TypeScript przeszło; testy samej akcji z prawdziwą sesją czekają na podłączenie UI. Pozostają strona i formularz, migracja docelowa oraz testy Preview. Nie wykonywano migracji ani publikacji produkcji.

## Weryfikacja publikacji — 2026-10-04
- Kod interfejsu 8158646 opublikowany do gałęzi PR; Vercel deployment 52rqM3dzt93Rjge737MCP4E7UcBp zakończony success. GitHub Checks verify: success (runs 37166622809 i 37166620917).
- Wznowienie istniejącego logowania Supabase przez ChatGPT próbowano dwukrotnie. Obie próby wróciły z OAuth state has expired. Nie wykonano migracji 20261002000300 ani zapisu nowych zadań na docelowej bazie. Potrzebne zalogowanie użytkownika w przeglądarce Codex; ekran pozostawiono otwarty. Nie pobierano haseł ani tokenów.

## Uzupełnienie audytu — rzeczywiste konto B

Potwierdzono TEST Firmę B, zapis/trwałość profilu, stanowisko/KPI/zachowania, rekrutację, kandydata/przypisanie i blokadę duplikatu, tekst CV/anonimizację/zatwierdzenie oraz logout z ochroną panelu. Konto B otrzymało 404 przy wejściu do panelu firmy A. Oczekiwanie na login użytkownika A do próby odwrotnej; pełnego RLS/test:live/rol/recovery nie zaliczono. Szczegóły i identyfikatory: docs/audit-2026-10-04.md. Kod bez zmian, bez merge.

## Uzupełnienie audytu — rzeczywiste konto A

Potwierdzono własny panel Ekoflame i odmowę dostępu (404) do panelu B, CV B oraz identyfikatora kandydata B pod ścieżką A. Kontrola paneli A↔B przeszła; nie zastępuje pełnego test:live/RLS/rol/recovery. Sesja A pozostawiona w swoim panelu. Szczegóły w docs/audit-2026-10-04.md; kod bez zmian, bez merge.

## Kontynuacja audytu — przepływ A i konflikt etapów

Utworzono dane TEST A od stanowiska do zadania i obserwacji. Sprawdzono notatkę wymaganą do zakończenia, trwałość daty, konflikt starego okna bez nadpisania i ponowne otwarcie etapu. Oceny v1/v2 zachowały historię; CV zatwierdzone, przygotowanie preselekcji dostępne. Recovery przyjęte przez formularz, wiadomość/reset czekają na użytkownika. Naprawiono nieaktualny komunikat liczby relacji w checkerze; 5/5 testów mechanizmu PASS. Pełnego test:live nie zaliczono. Szczegóły i ograniczenia: docs/audit-2026-10-04.md. Bez merge.

## Lokalny test dwóch sesji — 2026-10-04

Dodano scripts/run-live-check.ps1: ukryte wprowadzanie haseł, publiczny klucz projektu, brak pliku z poświadczeniami, przywrócenie zmiennych procesu także po błędzie. Kontrola składni PowerShell PASS; próba na syntetycznych danych bez sieci potwierdziła przekazanie danych do procesu testu, propagację exit 7 i przywrócenie wszystkich sześciu zmiennych. Mechanizm live-check: 5/5 PASS. To nie jest wynik rzeczywistego test:live.

Login A w Codex potwierdzono osobno (docs/login-password-verification.md). Do pełnego odczytu API nadal potrzebne są lokalnie wprowadzone poświadczenia oraz komplet rekordów obu firm: jawne członkostwa i brakujące dane B (etap/postęp, ocena zachowania, zadanie i obserwacja). Nie należy uruchamiać testu z niepełnymi danymi i traktować odmowy jako potwierdzenia izolacji. Właściciele nie potwierdzają uprawnień viewer/recruiter. Recovery i role pozostają nieweryfikowane. NOT READY do merge; bez nowych modułów, migracji i zmian main.

## Uzupełnienie danych B przez Preview — 2026-10-04, 07:24 UTC

Potwierdzono aktywną sesję B i TEST Firmę B. Przez istniejące formularze utworzono etap TEST B — ręczna weryfikacja oraz zapisano status W trakcie i syntetyczną notatkę. Zapisano odpowiedzialność jako niewystarczające dane z uzasadnieniem (wersja 1, autor Ty), zadanie TEST B — priorytetyzacja z jednym kryterium (wersja 1) i syntetyczną obserwację wykonania (wersja 1, autor Ty). Po pełnym odświeżeniu obserwacja i historia pozostały widoczne. Nie oceniano rzeczywistej osoby i nie wysyłano wiadomości.

Identyfikatory do ponowienia audytu: application 4a0788c1-8ec9-41a5-942b-82d23e7fd411; exercise 73b3666c-317f-4c1d-9b8f-b530a70496ca; exercise revision 2ba871ce-c1ee-467e-8024-7707daa5dd03. Firma B e732b9dc-ec23-4bcb-b06f-f7dd9fa2c0fb.

Wcześniejsza lista braków B dotycząca etapu, postępu, oceny zachowania, zadania i obserwacji jest nieaktualna — te dane uzupełniono. Nadal nie zaliczono test:live: jawne członkostwa obu firm i kompletność wszystkich relacji wymagają sprawdzenia/przygotowania; poświadczenia do lokalnego testu wprowadza użytkownik poza czatem. Testy viewer/recruiter i pełny recovery pozostają otwarte. Brak zmian implementacji, migracji i main. NOT READY do merge.

## Kompletność danych A/B — 2026-10-04

Kontrola administratora Supabase potwierdziła brak wyłącznie company_members. Dodano po jednym wpisie viewer wskazującym istniejącego właściciela własnej firmy (INSERT SELECT owner_id, tylko dwa znane company_id, ON CONFLICT DO NOTHING). Nie dodano dostępu do obcej firmy. Uprawnienia właściciela nadal mają pierwszeństwo: NIE jest to test ograniczeń viewer.

Po uzupełnieniu zbiorcze SELECT: checked_relations=16, populated_for_both=16, missing=NULL. Obie firmy mają dane we wszystkich 13 tabelach i 3 widokach. To kontrola kompletności wykonana jako administrator, NIE test RLS przez sesje użytkowników. test:live nadal wymaga lokalnego wprowadzenia poświadczeń. Nadal otwarte: role, pełny cykl recovery, współbieżny onboarding i końcowy E2E. NOT READY do merge. Nie wykonywano migracji ani zmiany main.

## Ostatnia kontrola lokalna — 2026-10-04

Lokalny SHA 8cfd55a16a2eb274dc52c42849a220da3bcb0fb8: ponownie uruchomiono wszystkie 10 zestawów (db, auth, cv, screening, assessments, auth-http, live-check, behavior-guide, behavior-assessments, http); każdy exit 0. build, typecheck i pdf-bundle także exit 0. Logi w artifacts/audit-2026-10-04/*-final.log, zestawienie final-checks.json. Nie jest to ponowienie test:live.

GitHub HEAD przy kontroli 7a205dbe2dbbd909786d074ba3e893c9b3d4656f, Vercel success (AgQu5QVVH2Wjb6zk96PB9y3yxWeU); PR draft, merged=false; main nadal 62a47ba6b40a1d92149fd2f6b1d34b195756048d. Nowsze lokalne zmiany dotyczą dokumentacji kompletności danych i tego wyniku.

Aktualne blokady: kompletność rekordów A/B jest już potwierdzona (16/16), więc poprzednie braki danych nie obowiązują. Następny krok to scripts/run-live-check.ps1 z danymi wprowadzonymi lokalnie przez użytkownika; aktywna sesja przeglądarki nie jest sesją skryptu Node. Nie pobierano ciasteczek ani tokenów z przeglądarki. Pełny test API, rzeczywiste role recruiter/viewer, pełny cykl recovery oraz współbieżny onboarding nadal niezaliczone. Przygotowanie testów i dostępna walidacja lokalna zakończone, cały audyt NIE jest zakończony. NOT READY do merge.
