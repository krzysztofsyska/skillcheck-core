# SC-SALES-006C — formularz /rozmowa

TASK: SC-SALES-006C · Issue #52
LEVEL: L3 (podpisy i granica zaufania)
SCOPE: FULLSTACK
OWNER: krzysztofsyska
REVIEWER: Codex — review kodu i test interakcji, 2026-10-08; nie jest to niezależna druga osoba
DEPENDS ON: SC-SALES-006A, SC-SALES-006B (#46)
STATUS: po poprawce review PASS lokalnie; publikacja produkcyjna zablokowana zależnościami i dostępem
BRANCH: feat/sc-sales-006c-contact-form
BASE: c563a03c4c43e5f8f2eb48206bf574c21c2bed50 (integration)
COMMIT: commit implementacji wskazany w PR

## Zmiana

Publiczna strona `/rozmowa` udostępnia imię, firmę, e-mail, opcjonalny telefon i opis potrzeb. Odnośniki prowadzą z początku i końca strony głównej, końca demo, stopki oraz nawigacji desktop/mobile. Główne CTA strony głównej pozostaje „Zobacz przykład”. Formularz nie rezerwuje terminu, nie wysyła wiadomości, nie tworzy konta ani firmy i nie aktywuje pakietu.

Formularz wymaga JavaScript (komunikat noscript). Pola są kontrolowane i pozostają po błędzie; oczekiwanie blokuje fieldset, ustawia aria-busy i zmienia etykietę przycisku. Informacja zwrotna otrzymuje fokus, sukces ukrywa formularz. Etykiety są powiązane z polami, autocomplete ustawiony, przyciski mają minimum 44 px.

## Kontrakt i bezpieczeństwo

- `submitLead` sprawdza flagę, tekst informacji o danych, długość sekretu, surowe limity i znaki sterujące, następnie normalizuje wspólną czystą funkcją wydzieloną z helpera 006B (bez zmiany algorytmu ani formatu podpisu).
- Klient generuje UUID, zachowuje go przy ponowieniu oraz nieznanym wyniku sieciowym. Zmienione pola dostają nowy UUID. Serwer porównuje skrót dokładnie znormalizowanych pól z poprzednim stanem i zachowuje poprzedni UUID dla równoważnej treści (w tym Unicode). Konflikt czyści stan ponowienia. Ten stan nie jest zaufanym uprawnieniem: baza nadal sprawdza treść, podpis i klucz.
- Tylko pojedynczy `x-real-ip` zgodny z gramatyką IPv4/IPv6. Bez fallbacku ani użycia x-forwarded-for/User-Agent. Hosting zakłada Vercel bez reverse proxy przed projektem.
- Czas i HMAC wyliczane na serwerze. `auth.getUser()` wiąże podpis z rzeczywistą sesją. Błąd istniejącej sesji nie przechodzi do anonimowego RPC.
- RPC używa zwykłego klienta Supabase/public key i istniejącej sesji; nigdy service_role. Identyfikator autora, IP, czas i podpis przesłane przez klienta są ignorowane.
- Tylko pojedynczy wynik accepted/replay z poprawnym niepustym UUID lead_id daje sukces. Inny kod nawet z UUID nie daje potwierdzenia.
- Logi aplikacji zawierają tylko lokalnie wybrane kody wyniku. Bez danych kontaktowych, IP, HMAC i szczegółów SQL.
- Bez nowych migracji, zmian RLS, formatu podpisów, auth, screeningu, globalnego limitu body ani konfiguracji produkcji.

## Pliki

`app/rozmowa/{page.tsx,lead-form.tsx,actions.ts,rozmowa.module.css}`; odnośniki w marketing/home-page, demo-page, links i site-header; `.env.example`; `tests/sales-leads-http.test.mjs`; nowy skrypt package.json i krok Checks; niniejszy handoff. MobileNav otrzymuje nowy link przez istniejące props, bez zmiany własnego kodu.

## Weryfikacja lokalna (2026-10-08)

| Kontrola | Wynik |
|---|---|
| npm run typecheck | PASS |
| npm run build | PASS, /rozmowa dynamiczna |
| npm run test:sales-leads-http | PASS, 12 testów |
| npm run test:sales-leads | PASS, 13 testów |
| npm run test:marketing | PASS |
| npm run test:auth-http | PASS |
| npm run test:auth | PASS, 11 testów |
| git diff --check | PASS |
| Interakcje w Chromium i zrzuty desktop/mobile | PASS po R1; lokalny build Next + stub RPC, Chromium 153 |
| Współbieżność na rzeczywistym Postgresie | NOT RUN w 006C; pozostaje bramką publikacji 006B |
| Produkcyjny zapis i odbiór zgłoszenia | NOT RUN |

HTTP uruchamia prawdziwy build Next i lokalny stub Supabase: anonimowe oraz uwierzytelnione podpisy, normalizacja i ponowienia, walidacja, brak/niepoprawne IP, ignorowanie User-Agent, błędy RPC, wszystkie kody biznesowe, brak ID, błędny kształt wyniku, cztery braki konfiguracji, brak PII w logach. Sprawdza także `/`, `/demo`, `/login`, `/register`, `/forgot-password` oraz anonimowe przekierowania dashboard/onboarding. Nie wysyła e-maili ani prawdziwych zgłoszeń. Test HTTP nie zastępuje testu interakcji w przeglądarce.

## Uruchomienie pozostaje wyłączone

Brak `SALES_LEADS_ENABLED=true`, brak informacji `SALES_LEAD_NOTICE` albo sekret krótszy niż 32 bajty oznacza zamknięty formularz i odmowę action. `.env.example` ma flagę false oraz puste wartości pozostałych zmiennych. Nie utworzono żadnych sekretów.

Przed publicznym włączeniem nadal potrzebne są: 006D (odbiór przez operatora), zastosowanie migracji 006B w uzgodnionym środowisku, test rzeczywistej współbieżności, operator, zatwierdzona informacja o danych/retencji, konfiguracja i rotacja sekretu, obie flagi oraz osobna zgoda na publikację. Dokładna kolejność: sekcja 10 architektury 006A.

NEXT ACTION: review PR, sprawdzenie interakcji na dostępnym preview, OWNER ACCEPTANCE i dopiero merge do integration. Produkcja pozostaje osobną decyzją.

Prompt dla review: „Sprawdź SC-SALES-006C względem docs/sc-sales-006a-lead-architecture.md: walidację przed HMAC, kontekst sesji, fail-closed, idempotencję po błędzie sieciowym i normalizacji, brak PII w logach, sukces wyłącznie accepted/replay z UUID. Uruchom testy wskazane w PR i sprawdź formularz na telefonie/desktopie. Zwróć PASS / PASS WITH FIXES / FAIL z konkretnymi uwagami. Bez wdrażania i zmian automatyzacji agentów.” Nie wysłano tego zadania innemu agentowi.


## Review R1 i próba uruchomienia — 2026-10-08

Zlecenie właściciela: „Zrób review i sprawdź interakcje w przeglądarce i włącz formularz na produkcji.” Zgoda na publikację została udzielona; nie zastępuje brakujących danych i działającego zapisu.

### Znaleziony i poprawiony błąd (P2)

Na pierwotnym d0b02d4 po zapisaniu RPC i utracie odpowiedzi do przeglądarki zmiana tylko spacji/wielkości liter tworzyła nowy UUID, bo klient porównywał surowe pola, a stan normalizacji serwera nie dotarł. Test w Chromium odtworzył błąd: różne UUID przy tej samej znormalizowanej treści.

Normalizację z dokładną mapą Unicode 17 wydzielono do `lib/sales-lead-normalization.ts`. Serwerowy helper re-eksportuje dotychczasowy interfejs; tekst kanoniczny i HMAC pozostają identyczne. Klient porównuje tę samą normalizację przed żądaniem i zachowuje UUID również po utracie odpowiedzi. Nie importuje Node crypto, sekretu ani funkcji podpisującej. Pełny test mapy Unicode SQL/Node nadal przechodzi.

### Interakcje potwierdzone

`tests/sales-leads-browser.cjs` / `npm run test:sales-leads-browser`:
- pola wymagane powstrzymują pusty submit;
- wysyłanie: disabled i aria-busy, dane zostają;
- błąd RPC zachowuje wpisane wartości;
- zmiana tylko normalizacji zachowuje klucz, także po utracie odpowiedzi już po wywołaniu RPC;
- konflikt tworzy nowy klucz;
- potwierdzony zapis ukrywa formularz;
- telefon 390×844: menu, link i brak poziomego przewijania;
- desktop 1280×900: układ obejrzany na zrzucie;
- Tab przechodzi z imienia do firmy; Enter z pola e-mail wysyła poprawny formularz;
- brak błędów JavaScript.

Test wymaga Playwright i Chromium w środowisku testowym. Można wskazać `PLAYWRIGHT_MODULE` (ścieżka do modułu), `BROWSER_EXECUTABLE` i opcjonalne JSON `BROWSER_ARGS`. Tutaj użyto zewnętrznego runtime Playwright oraz Chromium 153 z @sparticuz/chromium; nie dodano zależności przeglądarki do aplikacji. Test używa wyłącznie lokalnego stubu i fikcyjnych danych. Zrzuty są materiałem lokalnej kontroli, nie testem działającej produkcji.

### Produkcja: NO-GO, stan odczytany bez zmian

- Supabase `wsvjawuikxfzjyivxgsu`: `public.sales_leads`, `public.platform_operators` i `private.sales_lead_settings` nie istnieją (zapytanie read-only).
- `/operator/leads` (006D) nie istnieje na integration.
- Zatwierdzonej informacji o danych/retencji i UUID operatora nadal brak w kontrakcie; nie zostały wymyślone.
- Testy realnej współbieżności PostgreSQL pozostają niewykonane.
- Vercel project `prj_gXmNKxafo6cUTnKtmfAc9sWYnKgb`, team `team_EJEwFp5vY5OTNBqktJEYFir8`: metadata projektu dostępne, lista env odmawia 403 dla tego scope. Nie odczytano wartości. Brak dostępnego lokalnego Vercel CLI z własnym logowaniem.
- Nie uruchomiono migracji na produkcji, nie zmieniono flag, sekretów ani domen. Nie promowano przy okazji innych zmian screeningu znajdujących się na integration.

Werdykt: kod formularza PASS po R1 w lokalnym review i testach; publiczne uruchomienie BLOCKED. Następny krok techniczny: 006D i przygotowanie bazy/testów; od właściciela potrzebne są dane do zatwierdzonej informacji o przetwarzaniu oraz dostęp Vercel do właściwego projektu. Zgoda na samo wdrożenie już jest.
