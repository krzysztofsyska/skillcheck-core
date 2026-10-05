# SC-SALES-004A — przekazanie

- TASK: SC-SALES-004A — strona prezentacyjna SkillCheck i publiczne demo
- STATUS: DONE
- BRANCH: `feat/sc-sales-004a-public-frontend`
- BASE_COMMIT: `72fe4423d89417ea043051ff8c57cd1ff6a7c859`
- DB / MIGRATIONS: brak

## CHANGED FILES

- `app/page.tsx`
- `app/marketing.module.css`
- `app/demo/page.tsx`
- `app/demo/demo.module.css`
- `app/components/marketing/content.ts`
- `app/components/marketing/demo-data.ts`
- `app/components/marketing/demo-page.tsx`
- `app/components/marketing/home-page.tsx`
- `app/components/marketing/links.ts`
- `app/components/marketing/mobile-nav.tsx`
- `app/components/marketing/site-footer.tsx`
- `app/components/marketing/site-header.tsx`
- `tests/marketing-http.test.mjs`
- `package.json` — skrypt `test:marketing`
- `.github/workflows/checks.yml` — `test:marketing` po buildzie, za `test:auth-http`
- `docs/BACKLOG.md` — dopisane SC-SALES-004A ze statusem REVIEW
- `docs/sc-sales-004a-handoff.md`

## Co zostało zrobione

Publiczna strona `/` i przykład `/demo` są po polsku i działają bez konta. Build oznacza obie trasy jako statyczne. Nie importują Supabase ani klienta AI.

`/` prowadzi do sekcji „Jak to działa”, „Możliwości”, „Pakiety” i „FAQ”, do `/login` oraz do `/demo`. Sekcja otwierająca zachowuje nagłówek i przyciski. Po review opis otwierający mówi, że automatyczna analiza jest w przygotowaniu, a decyzję rekrutacyjną podejmuje człowiek. Notatka pod przyciskami nadal mówi, że rejestracja nie uruchamia analizy i nie aktywuje pakietu.

Oznaczenia dostępności wynikają ze stanu kodu, nie z samego istnienia workera:

- profil stanowiska, materiały kandydata (w tym CV TXT/PDF/DOCX zatwierdzane przez człowieka), przewodnik rozmowy oraz ręczne etapy, notatki i obserwacje są opisane jako dostępne w koncie;
- zestawienie dowodów przez analizę jest opisane jako przygotowywane: w koncie jest przygotowanie materiału, a ekran preselekcji nadal informuje, że analiza nie jest uruchomiona;
- porównanie kilku osób obok siebie jest tylko na stronie przykładowej;
- FREE, PRESELEKCJA, WERYFIKACJA i ASSESSMENT CENTER są pokazane jako planowana oferta, bez cen, limitów, terminów i bez przycisków zakupu;
- voicebot i pomiar jakości zatrudnienia są jedną wzmianką o planach, bez daty.

`/demo` pokazuje fikcyjną rekrutację przedstawiciela handlowego: wymagania, trzy profile w kolejności alfabetycznej nazwisk, porównanie czterech kryteriów, cytaty, braki i pytania do rozmowy. Brak danych nie jest zamieniany na wynik. Nie ma procentów dopasowania ani decyzji o zatrudnieniu. Widoczny baner: „Dane demonstracyjne — fikcyjny przykład prezentacji informacji o kandydatach”.

Na wąskim ekranie nawigacja jest przyciskiem „Menu”. Zamknięte menu nie wchodzi w kolejność tabulacji. Escape zamyka menu. Style nowych widoków są w CSS Modules i nadpisują globalne reguły `main` oraz `section` tylko wewnątrz tych widoków. `app/globals.css`, `app/layout.tsx` i `proxy.ts` nie były zmieniane.

## Testy

Środowisko: Node.js 24.21.0, zgodnie z `.github/workflows/checks.yml`. Moment: 2026-10-05, około 16:15–16:20 UTC.

| Polecenie | Wynik |
|---|---|
| `npm ci` | PASS, 0 znanych podatności |
| `npm run typecheck` | PASS |
| `npm run build` | PASS; `/` i `/demo` są statyczne |
| `npm run test:marketing` | PASS, 1 test, lokalny `next start` |
| `npm run test:http` | PASS, 1 test |
| `npm run test:auth-http` | PASS, 1 test |

`test:marketing` sprawdza odpowiedzi serwera: status 200 dla `/` i `/demo`, główne odnośniki, baner danych demonstracyjnych, brak formularza i brak wezwań do zapłaty. Serwer dostał fałszywy adres Supabase `http://127.0.0.1:9`. W logu i w HTML tych stron ten adres się nie pojawił.

`npm run test:live` nie był uruchamiany. Nie należy do tego zadania i wymaga prywatnego środowiska.

## Kontrola wizualna

Headless Chrome, ten sam lokalny `next start`, 2026-10-05 około 16:17–16:20 UTC.

- 1440 px i 390 px: `/`, `/demo`, porównanie kandydatów, planowana oferta, menu telefonu, `/login`, `/register`, `/forgot-password`.
- Brak poziomego przewijania (`scrollWidth` równe `clientWidth`) na `/`, `/demo`, `/login`, `/register` i `/forgot-password` przy obu szerokościach.
- Brak wyjątków i wpisów `console.error` podczas tych wejść.
- Brak żądań poza `127.0.0.1` podczas wejść na strony publiczne i auth.
- Wejście na `/dashboard` i `/onboarding` bez sesji kończy się na `/login`.
- Menu przy 390 px otwiera się kliknięciem (`aria-expanded=true`) i zamyka klawiszem Escape.
- Tab po przycisku Menu przechodzi do treści i stopki, nie do linków zamkniętego menu.
- `/login`, `/register` i `/forgot-password` nadal są wyśrodkowaną kartą dotychczasowego formularza, bez nawigacji marketingowej.

Zrzuty leżą poza repozytorium, przy przeglądzie wizualnym: strona główna i demo na obu szerokościach, porównanie, menu telefonu, pakiety oraz niezmieniony login.

## Znane problemy i ograniczenia

- Nie było autoryzowanego konta testowego, więc panelu po zalogowaniu nie sprawdzano wizualnie. Sprawdzone zostało tylko anonimowe przekierowanie `/dashboard` i `/onboarding` do `/login`.
- Review kodu i treści: PASS dla `91efe461282efe1f814ef875709dd81adb887c01`; poprawka komunikatu dostępności została zweryfikowana. Merge i produkcyjny smoke test opisano poniżej.
- Nie było nagrania pulpitu: agent przeglądarki interaktywnej nie wystartował. Kontrola jest z Chrome headless i protokołu DevTools.

## Do sprawdzenia przez Codex

- `/` i `/demo` nie sięgają do Supabase ani AI; build oznacza je jako statyczne.
- `proxy.ts`, `app/globals.css` i `app/layout.tsx` są nietknięte, a lokalne klasy nie zmieniają `/login`, `/register` i `/forgot-password`.
- Zakres plików jest zgodny z zadaniem. Brak migracji, sekretów i nowych zależności.
- `test:marketing` uderza w lokalny serwer, a CI uruchamia go po buildzie.

## Do oceny przez ChatGPT

- Czy język odróżnia funkcje dostępne w koncie od przygotowywanych i od planowanej oferty.
- Czy przykład jest spójny: profile, cytaty, porównanie, braki i pytania nie przeczą sobie nawzajem.
- Czy brak danych nie wygląda jak ocena zero i czy strona nie sugeruje decyzji o zatrudnieniu.
- Czy nie pojawiają się ceny, limity, terminy, opinie, regulamin ani puste odnośniki.

## Poprawka po review PR #31

Sprawdzony commit: `d427d1c9dc22a1984a2501026558c78333f41741`. Review kodu i testów zakończyło się pozytywnie. Ta poprawka zmienia tylko sposób komunikowania dostępności analizy. Na etapie przekazania poprawki status pozostawał REVIEW. Wygląd, demo, logowanie i pozostałe funkcje nie były ruszane.

Zmienione pliki:

- `app/components/marketing/home-page.tsx` — opis pod nagłówkiem mówi o przygotowaniu wymagań i materiałów, o fikcyjnym przykładzie zestawienia oraz o tym, że automatyczna analiza jest w przygotowaniu;
- `app/page.tsx` — `metadata.description` mówi o profilu stanowiska, materiałach kandydatów, dostępnych funkcjach i demonstracyjnym przykładzie planowanej analizy;
- `app/components/marketing/content.ts` — możliwość „Informacja poparta materiałem i brak danych” odnosi się do fikcyjnego przykładu i oznacza automatyczne przygotowywanie takiego zestawienia jako będące w przygotowaniu;
- `docs/sc-sales-004a-handoff.md` — ten zapis.

Kontrola poprawki, Node.js 24.21.0, 2026-10-05 około 16:34 UTC:

| Polecenie | Wynik |
|---|---|
| `npm run typecheck` | PASS |
| `npm run build` | PASS; `/` i `/demo` pozostają statyczne |
| `npm run test:marketing` | PASS, 1 test |

Pierwszy ekran `/` przy 1440 px i 390 px pokazuje nowy opis, dotychczasowy nagłówek i oba przyciski. Brak poziomego przewijania i brak wyjątków w konsoli. Zrzuty: `home_first_screen_1440.png` i `home_first_screen_390.png`.

## Zakończenie i publikacja — 2026-10-05

- STATUS: DONE.
- Zgoda właściciela na scalenie i publikację: 2026-10-05, 19:03 Europe/Warsaw.
- Review Codex kodu i treści: PASS dla `91efe461282efe1f814ef875709dd81adb887c01`.
- PR: https://github.com/krzysztofsyska/skillcheck-core/pull/31 — scalony do `main`.
- Commit scalający: `1eff163112baba8e5f158be9c21f5e2198136ed9`.
- Checks dla zatwierdzonego HEAD: push https://github.com/krzysztofsyska/skillcheck-core/actions/runs/37341862331 oraz PR https://github.com/krzysztofsyska/skillcheck-core/actions/runs/37341866827 — PASS.
- Checks po merge: https://github.com/krzysztofsyska/skillcheck-core/actions/runs/37345663116 — PASS.
- Vercel dla commitu scalającego: success, https://vercel.com/krzysztofs-projects-b7ce87b5/skillcheck-core/9wKx5D8Nasf5xqo9mofgMjFxRV4J.
- GitHub deployment `6865123901`, środowisko nazwane `Production`: success, 2026-10-05 17:04:59 UTC.
- Adres produkcyjny: https://skillcheck-core.vercel.app.
- DB / MIGRATIONS: brak. Publikacja nie zmienia auth, płatności ani uruchamiania analiz.

### Smoke test na produkcji

Kontrola HTTP: 2026-10-05 17:06:14 UTC (19:06:14 Europe/Warsaw), bez logowania i bez wysyłania formularzy.

| Trasa | Oczekiwany i uzyskany wynik |
|---|---|
| `/` | 200; nowy nagłówek, poprawiony komunikat „Automatyczna analiza jest w przygotowaniu.” i linki do demo/rejestracji/logowania |
| `/demo` | 200; baner danych demonstracyjnych, trzy fikcyjne profile i oznaczenie braku danych |
| `/login` | 200; formularz logowania |
| `/register` | 200; formularz rejestracji |
| `/forgot-password` | 200; formularz odzyskiwania dostępu |
| `/dashboard` | 307 → `/login` dla anonimowego użytkownika |
| `/onboarding` | 307 → `/login` dla anonimowego użytkownika |
| `/api/health/supabase` | 200, `ok: true`; nie jest to test migracji ani RLS |

Wynik: 8/8 PASS. Nie tworzono kont ani nie wysyłano wiadomości. Nie testowano panelu po zalogowaniu. Kontrola wizualna opiera się na raporcie i zrzutach Cursora; Codex nie potwierdził zrzutów niezależnie.

## Następny krok

Zadanie SC-SALES-004A zakończone. Kolejne funkcje sprzedażowe i analiza mają osobne zadania; ta publikacja ich nie aktywuje.
