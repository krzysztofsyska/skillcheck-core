# Przewodnik rozmowy

Rekrutacja → Przewodnik rozmowy. Dostępny również z przygotowania preselekcji i etapów oceny zgłoszenia. Pokazuje osiem uzgodnionych obszarów: odpowiedzialność, samodzielność, inicjatywa, wynik, współpraca, zmiana, feedback oraz działanie pod presją. Każdy ma definicję, dwa pytania sytuacyjne, przykłady działań i sygnały wymagające dopytania.

Przewodnik odczytuje wymagane poziomy z bieżącego profilu stanowiska przypisanego do rekrutacji. Brak wpisu, nieznany poziom, powtórzenie lub sprzeczność wymagają sprawdzenia przez rekrutera; aplikacja nie zgaduje poziomu. Nieznane wymagania są pokazywane osobno, aby nie zniknęły bez informacji.

To materiał do rozmowy prowadzonej przez człowieka, bez voicebota, kontaktowania kandydatów ani automatycznej oceny. Wskazówki pomagają zebrać dowody zawodowych działań. Nie diagnozują osobowości, zdrowia czy odporności psychicznej. Brak przykładu oznacza brak danych, a nie automatycznie ocenę poniżej wymagań. Rekruter zapisuje odpowiedzi i wnioski w istniejących notatkach etapu wybranego zgłoszenia.

Zawartość słownika przygotowano na podstawie odczytanej 2026-10-02 rozmowy 6ab8157c-d460-83eb-81a9-56d7bd8aa23e. Drugi wariant pytania dla obszaru rozwija tę samą definicję. Sygnały wymagają dopytania, nie stanowią reguł zatrudnienia ani punktacji.

## Dostęp i ograniczenia

Strona wymaga sesji i dostępu do firmy. Rekrutacja jest pobierana po identyfikatorze i firmie, stanowisko wyłącznie z powiązania tej rekrutacji z filtrem tej samej firmy. Wszystkie role z odczytem, w tym viewer, mają dostęp. Nie ma zapisu, pobierania CV lub danych kandydatów ani nowych migracji.

Przewodnik pokazuje aktualny profil; nie tworzy kopii wymagań z dnia rozmowy. Interfejs prosi o zapisanie wymaganego poziomu w notatce. Strukturalne oceny, dowody przypisane do kryteriów, wersjonowanie rubryk oraz ich audyt wymagają osobnej implementacji przed formalnymi ocenami i raportami.

## Weryfikacja

`test:behavior-guide` sprawdza mapowanie zapisów stanowiska, wszystkie osiem obszarów oraz brak zgadywania poziomów przy niepełnych/błędnych danych. `test:http` sprawdza przekierowanie anonimowego wejścia do logowania i zakaz cache.

2026-10-02 zalogowana sesja właściciela na Vercel odczytała wymagania testowego stanowiska: odpowiedzialność Wysoki, pozostałe siedem obszarów Standardowy. Widoczne osiem obszarów i 16 pytań; nawigacja do odpowiedzialności i rozwinięcie wskazówek zadziałały. Wygląd sprawdzono w bieżącym widoku desktop. Dostęp viewer, druga firma i widok mobilny pozostają do sprawdzenia. Szczegóły docs/e2e-2026-10-02.md.
