# SC-SALES-006D — odbiór zgłoszeń kontaktowych

TASK: SC-SALES-006D
LEVEL: L3
SCOPE: FRONTEND
OWNER: Codex
REVIEWER: Codex (przegląd w tej samej sesji, nie niezależna druga osoba)
DEPENDS ON: SC-SALES-006B, SC-SALES-006C (#53)
STATUS: READY TO MERGE
BRANCH: feat/sc-sales-006d-operator-leads
ISSUE: #54

SCOPE jest klasyfikacją ścieżek bieżącego gate (app/** = FRONTEND, proxy.ts nie jest klasyfikowany). Funkcjonalnie zmiana obejmuje serwerową kontrolę dostępu; dlatego LEVEL L3 i testy bezpieczeństwa pozostają wymagane. Kontrakt Issue opisuje zakres funkcjonalny FULLSTACK. Nie zmieniono klasyfikatora ani zabezpieczeń gate.

## Wynik

Operator otwiera `/operator/leads`, serwer weryfikuje użytkownika przez istniejący klient SSR/public key, sprawdza `platform_operator_status`, a następnie pobiera `list_sales_leads({result_limit:50})`. RPC powtarza sprawdzenie roli. Brak sesji prowadzi do `/login`; nie-operator i odebranie uprawnień między wywołaniami kończą się 404.

Widok pokazuje datę (Europe/Warsaw), firmę, imię, e-mail, telefon, potrzeby, status i autora. Brak telefonu i autora ma jawny opis. Pusta lista jest odróżniona od błędu. Odświeżenie wykonuje nowy odczyt. Bez edycji, eksportu i wysyłki. Zgłoszenia renderowane wyłącznie jako tekst; brak HTML z wejścia. Fingerprint i klucz idempotencji nie trafiają do HTML/RSC.

Dopisany wyłącznie matcher `/operator/:path*` w proxy zapewnia odświeżanie sesji i `Cache-Control: private, no-store`. Strona jest dynamiczna, z `noindex,nofollow`. Nie ma współdzielonego cache danych ani `service_role`.

## Zmienione pliki

- app/operator/leads/page.tsx
- app/operator/leads/leads.module.css
- proxy.ts — matcher
- tests/sales-leads-operator-http.test.mjs
- package.json — skrypt test:sales-leads-operator
- .github/workflows/checks.yml — wywołanie testu po build
- docs/sc-sales-006d-handoff.md

Dopisanie skryptu i kroku CI rozszerza listę plików 006A wyłącznie o uruchamianie testu 006D.

## Weryfikacja 2026-10-08

- npm ci — PASS, lockfile bez zmian.
- npm run build — PASS.
- npm run typecheck — PASS.
- npm run test:sales-leads — 13 PASS (PGlite, w tym role, listowanie i limity).
- test operator HTTP + opcjonalny Chromium — 12 PASS (11 podtestów + nadrzędny).
- HTTP: anonimowy, nie-operator, operator, pusty wynik, odebranie roli między wywołaniami, błędy status/list, nieważna sesja, brak ponownego użycia danych dla anonimowego, regresja tras, brak PII/SQL w logach.
- Chromium: 1280px i 390px; odczyt, brak overflow, HTML zgłoszenia jako tekst, odświeżenie do pustej listy, 404 po odebraniu uprawnień, /login po usunięciu sesji, brak pageerror. Mobilny zrzut sprawdzony wizualnie.
- git diff --check — PASS.

Przegląd kodu: PASS w zakresie 006D. Testy HTTP/przeglądarkowe używają syntetycznego serwera Supabase; to nie jest live E2E produkcji. Test browser jest opcjonalny lokalnie (`PLAYWRIGHT_MODULE`, `BROWSER_EXECUTABLE`, `BROWSER_ARGS`), bez nowych zależności aplikacji. CI uruchamia deterministyczne HTTP.

## DB / produkcja

Brak migracji, zapisu do produkcji, ustawiania operatora, sekretów, flag ani wdrożenia w tym zadaniu. 006D usuwa brak panelu, ale nie pozostałe warunki aktywacji.

Ostatni potwierdzony preflight z 006C: produkcyjny Supabase nie miał sales_leads/platform_operators/private.sales_lead_settings; Vercel odrzucił odczyt konfiguracji zmiennych błędem 403 dla właściwego projektu i zespołu. Nie zakładamy, że zgoda właściciela naprawia dostęp narzędzia.

Pozostają przed publicznym włączeniem: migracja 006B, rzeczywisty test współbieżności (w tym trzy scenariusze retire po realnych 60 min, bez cofania czasu), wskazanie UUID pierwszego operatora, zatwierdzona informacja o danych i okres przechowywania, wspólny sekret DB/Vercel, poprawny dostęp do konfiguracji oraz kontrolowana promocja integration → main i smoke test. Zgoda właściciela na wdrożenie była już udzielona; nie jest brakującym warunkiem. Nie promować niezwiązanych zmian bez sprawdzenia zakresu promocji.

NEXT ACTION: przejść CI/review, przygotować produkcję po uzyskaniu brakujących danych właściciela i dostępu Vercel. Nie włączać automatyki agentów.
