# SC-SALES-006C — formularz /rozmowa

TASK: SC-SALES-006C · Issue #52
LEVEL: L3 (podpisy i granica zaufania)
SCOPE: FULLSTACK
OWNER: krzysztofsyska
REVIEWER: review PR do integration; niezależne review jeszcze niewykonane
DEPENDS ON: SC-SALES-006A, SC-SALES-006B (#46)
STATUS: implementacja i lokalne testy zakończone; do review i OWNER ACCEPTANCE
BRANCH: feat/sc-sales-006c-contact-form
BASE: c563a03c4c43e5f8f2eb48206bf574c21c2bed50 (integration)
COMMIT: commit implementacji wskazany w PR

## Zmiana

Publiczna strona `/rozmowa` udostępnia imię, firmę, e-mail, opcjonalny telefon i opis potrzeb. Odnośniki prowadzą z początku i końca strony głównej, końca demo, stopki oraz nawigacji desktop/mobile. Główne CTA strony głównej pozostaje „Zobacz przykład”. Formularz nie rezerwuje terminu, nie wysyła wiadomości, nie tworzy konta ani firmy i nie aktywuje pakietu.

Formularz wymaga JavaScript (komunikat noscript). Pola są kontrolowane i pozostają po błędzie; oczekiwanie blokuje fieldset, ustawia aria-busy i zmienia etykietę przycisku. Informacja zwrotna otrzymuje fokus, sukces ukrywa formularz. Etykiety są powiązane z polami, autocomplete ustawiony, przyciski mają minimum 44 px.

## Kontrakt i bezpieczeństwo

- `submitLead` sprawdza flagę, tekst informacji o danych, długość sekretu, surowe limity i znaki sterujące, następnie normalizuje istniejącym, niezmienionym helperem 006B.
- Klient generuje UUID, zachowuje go przy ponowieniu oraz nieznanym wyniku sieciowym. Zmienione pola dostają nowy UUID. Serwer porównuje skrót dokładnie znormalizowanych pól z poprzednim stanem i zachowuje poprzedni UUID dla równoważnej treści (w tym Unicode). Konflikt czyści stan ponowienia. Ten stan nie jest zaufanym uprawnieniem: baza nadal sprawdza treść, podpis i klucz.
- Tylko pojedynczy `x-real-ip` zgodny z gramatyką IPv4/IPv6. Bez fallbacku ani użycia x-forwarded-for/User-Agent. Hosting zakłada Vercel bez reverse proxy przed projektem.
- Czas i HMAC wyliczane na serwerze. `auth.getUser()` wiąże podpis z rzeczywistą sesją. Błąd istniejącej sesji nie przechodzi do anonimowego RPC.
- RPC używa zwykłego klienta Supabase/public key i istniejącej sesji; nigdy service_role. Identyfikator autora, IP, czas i podpis przesłane przez klienta są ignorowane.
- Tylko pojedynczy wynik accepted/replay z poprawnym niepustym UUID lead_id daje sukces. Inny kod nawet z UUID nie daje potwierdzenia.
- Logi aplikacji zawierają tylko lokalnie wybrane kody wyniku. Bez danych kontaktowych, IP, HMAC i szczegółów SQL.
- Bez nowych migracji, zmian RLS, helpera podpisów, auth, screeningu, globalnego limitu body ani konfiguracji produkcji.

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
| Interakcje w Chromium i zrzuty desktop/mobile | NOT RUN: brak przeglądarki w runtime; pobieranie Chromium zwraca uszkodzone archiwum |
| Współbieżność na rzeczywistym Postgresie | NOT RUN w 006C; pozostaje bramką publikacji 006B |
| Produkcyjny zapis i odbiór zgłoszenia | NOT RUN |

HTTP uruchamia prawdziwy build Next i lokalny stub Supabase: anonimowe oraz uwierzytelnione podpisy, normalizacja i ponowienia, walidacja, brak/niepoprawne IP, ignorowanie User-Agent, błędy RPC, wszystkie kody biznesowe, brak ID, błędny kształt wyniku, cztery braki konfiguracji, brak PII w logach. Sprawdza także `/`, `/demo`, `/login`, `/register`, `/forgot-password` oraz anonimowe przekierowania dashboard/onboarding. Nie wysyła e-maili ani prawdziwych zgłoszeń. Test HTTP nie zastępuje testu interakcji w przeglądarce.

## Uruchomienie pozostaje wyłączone

Brak `SALES_LEADS_ENABLED=true`, brak informacji `SALES_LEAD_NOTICE` albo sekret krótszy niż 32 bajty oznacza zamknięty formularz i odmowę action. `.env.example` ma flagę false oraz puste wartości pozostałych zmiennych. Nie utworzono żadnych sekretów.

Przed publicznym włączeniem nadal potrzebne są: 006D (odbiór przez operatora), zastosowanie migracji 006B w uzgodnionym środowisku, test rzeczywistej współbieżności, operator, zatwierdzona informacja o danych/retencji, konfiguracja i rotacja sekretu, obie flagi oraz osobna zgoda na publikację. Dokładna kolejność: sekcja 10 architektury 006A.

NEXT ACTION: review PR, sprawdzenie interakcji na dostępnym preview, OWNER ACCEPTANCE i dopiero merge do integration. Produkcja pozostaje osobną decyzją.

Prompt dla review: „Sprawdź SC-SALES-006C względem docs/sc-sales-006a-lead-architecture.md: walidację przed HMAC, kontekst sesji, fail-closed, idempotencję po błędzie sieciowym i normalizacji, brak PII w logach, sukces wyłącznie accepted/replay z UUID. Uruchom testy wskazane w PR i sprawdź formularz na telefonie/desktopie. Zwróć PASS / PASS WITH FIXES / FAIL z konkretnymi uwagami. Bez wdrażania i zmian automatyzacji agentów.” Nie wysłano tego zadania innemu agentowi.
