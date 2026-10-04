# Test rzeczywistego Supabase

`npm run test:live` wykonuje dwa logowania hasłem i wyłącznie odczyty przez Supabase API. Nie tworzy użytkowników, nie wysyła wiadomości, nie zapisuje ani nie usuwa rekordów. Dane dostępowe umieszcza się tylko w ignorowanym `.env.local` lub środowisku procesu. Wymagane nazwy zmiennych są opisane w README; używamy klucza publicznego, nigdy service_role.

## Warunki wiarygodnego wyniku

### Wprowadzanie haseł lokalnie, bez pliku

Na Windows można uruchomić `powershell -NoProfile -File .\scripts\run-live-check.ps1` w katalogu repozytorium. Skrypt pyta o klucz **publishable** projektu, adresy A/B i ukryte hasła; nie zapisuje ich w pliku ani argumentach procesu. Przywraca poprzednie zmienne środowiskowe w finally. Nie używać transkrypcji terminala ani nie wklejać haseł do czatu. Skrypt nie tworzy kont, danych, członkostw ani uprawnień i nie omija brakujących rekordów. Wymaga Node.js i zależności repozytorium. Hasła są krótkotrwale dostępne procesowi testu w pamięci/środowisku; skrypt nie gwarantuje wymazania wszystkich kopii z pamięci systemu.

Właściciele A/B nie wystarczą do testów recruiter/viewer. Nie należy nadać A członkostwa w B (ani odwrotnie) podczas testu rozłączności. Testy tych ról wymagają oddzielnie przygotowanego, kontrolowanego członkostwa; niniejszy skrypt sprawdza tylko odczyty izolacji dwóch sesji.

Oba potwierdzone konta muszą należeć do rozłącznych firm testowych. W każdej firmie muszą być widoczne dla danego konta rekordy wszystkich 13 tabel oraz trzech widoków najnowszych wersji:

- firma i jej profil;
- przynajmniej jeden jawny wpis członkostwa (właściciel sam w sobie nie tworzy rekordu company_members);
- stanowisko, rekrutacja, kandydat i jego zgłoszenie;
- etap oceny i zapis postępu tego zgłoszenia;
- dokument CV z syntetyczną treścią;
- co najmniej jedna ocena z uzasadnieniem, utworzona przez RPC/formularz i widoczna również w latest_behavior_assessments. Wymaga wykonanych migracji 20261002000100 i 20261002000200.

Dane przygotowujemy wcześniej w uzgodnionym środowisku testowym. Nie dodajemy fikcyjnych kont do produkcji, nie przyznajemy członkostwa obcym osobom ani nie używamy prawdziwych CV tylko po to, by przeprowadzić test. Interfejs zarządzania członkami nie jest jeszcze zaimplementowany; istniejący testowy wpis może przygotować administrator zgodnie z docelowym modelem dostępu.

Test najpierw sprawdza widoczność własnego rekordu w tabeli dla A oraz B, a następnie brak dostępu krzyżowego. Pobiera najwyżej jeden klucz firmy na zapytanie; nie pobiera nazwisk ani treści CV. Brak widocznego rekordu jest błędem niepełnych danych testowych. Błąd API także jest błędem, a nie dowodem izolacji.

`npm run test:live-check` sprawdza sam mechanizm kontroli na lokalnych odpowiedziach testowych: kompletne dane, brak danych, wyciek między firmami, błąd API i wspólne członkostwo. Jest uruchamiany w CI. Nie wymaga kluczy i nie potwierdza rzeczywistego połączenia z Supabase.

## Granice testu

PASS dotyczy odczytów przez dwie sesje Auth w przygotowanych firmach. Osobno pozostają zapisy formularzy, uprawnienia viewer/recruiter, potwierdzanie e-maila, odzyskiwanie hasła, import PDF/DOCX na Vercel, konflikty dwóch okien i współbieżny onboarding. Lokalne testy PostgreSQL sprawdzają zapisy oraz RLS, ale nie zastępują tych prób wdrożenia.

2026-10-02 wykonano osobno część prób jednej sesji właściciela: formularze stanowiska/rekrutacji/kandydata, import PDF/DOCX, redakcję i konflikt CV, przygotowanie preselekcji, zapis statusu/notatki etapu i odczyt przewodnika. Wyniki: docs/e2e-2026-10-02.md. Nie zmienia to wymagań `test:live` ani nie potwierdza izolacji dwóch rzeczywistych firm.

Definicje zadań: każda firma musi mieć wpis exercise_definition_entries widoczny również w latest_exercise_definitions. Migracja 20261002000300 została wykonana 2026-10-04. Test obejmuje 16 relacji; brak własnego wpisu uniemożliwia potwierdzenie izolacji.

Każda firma wymaga również obserwacji wykonania, widocznej w exercise_observation_entries i latest_exercise_observations (migracja 20261004000100 wykonana).

## Osobny test członkostw
Tryb run-live-check.ps1 -Check Membership jest testem zapisów na dedykowanej TEST Firmie B, nie testem rozłącznych A/B. Konto A w tym trybie oznacza C (członka), B właściciela firmy B. Dokładne kroki i przywracanie roli opisano w owner-audit-runbook.md. Tryb domyślny Tenants pozostaje tylko do odczytu.
