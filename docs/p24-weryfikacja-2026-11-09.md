# SC-P24-VERIFY-002 — ponowna weryfikacja Przelewy24 (stan na 2026-11-09)

Dokument roboczy dla właściciela i agentów. Nie zawiera haseł, kluczy ani danych klientów.

## 1. Co sprawdzono na produkcji (https://skillcheck.pl)

Domena `skillcheck.pl` jest podpięta do projektu Vercel `skillcheck-core` (`www` przekierowuje na nią).
Produkcja pokazuje gałąź `main` (commit `a474846`).

| Wymaganie | Stan na produkcji | Gdzie |
|---|---|---|
| Regulamin sklepu | jest, ale pod nazwą „Regulamin” / „Regulamin świadczenia usług SkillCheck” | stopka → `/regulamin` |
| Polityka prywatności | jest | stopka → `/polityka-prywatnosci` |
| Dane firmy (nazwa, adres, KRS, NIP, REGON) | są | stopka każdej strony |
| Kontakt (e-mail, telefon) | jest w stopce; brak osobnej strony (`/kontakt` = 404) | stopka |
| Opis i ceny usług | są | strona główna, sekcja „Pakiety”; `/preselekcja` |
| Metody płatności | tylko w treści regulaminu (§ 7) i w FAQ; brak odnośnika w stopce | `/regulamin` |
| Reklamacje i odstąpienie | tylko w treści regulaminu (§ 10–11); brak odnośnika w stopce; na produkcji w stopce nie ma też formularza odstąpienia | `/regulamin` |

## 2. Co dodaje ten PR (do `integration`, nie na produkcję)

- Stopka: „Regulamin sklepu” (ten sam dokument, nowa nazwa odnośnika), „Płatności, reklamacje i odstąpienie”, „Kontakt”.
- Nowa strona `/kontakt` — dane firmy z jednego źródła (`lib/legal.ts`).
- Nowa strona `/platnosci-i-reklamacje` — krótkie podsumowanie regulaminu.

### Teksty wymagające akceptacji właściciela przed publikacją

**PROJEKT — do zatwierdzenia.** Strona `/platnosci-i-reklamacje` (`app/platnosci-i-reklamacje/page.tsx`)
streszcza zapisy regulaminu o płatnościach (§ 7), terminie realizacji (§ 8), reklamacjach (§ 10)
i odstąpieniu od umowy oraz zwrotach (§ 11). Nie dodaje żadnych nowych zasad; każda sekcja odsyła do
właściwego paragrafu, a wstęp mówi, że wiążący jest regulamin.

**Jedna świadoma różnica wobec regulaminu:** § 7 ust. 1 regulaminu wymienia płatność online Przelewy24 jako
dostępną. Strona mówi, że dziś płaci się przelewem z faktury proforma, a Przelewy24 „jest przygotowywana” —
tak jak pozostałe strony oferty i zgodnie ze stanem faktycznym. Do decyzji właściciela (i prawnika), czy
do czasu uruchomienia płatności online poprawić regulamin, czy zostawić tę różnicę.

Promocja na produkcję musi zawierać osobne pytanie TAK/NIE o akceptację tej strony. Mimo to jest to tekst o prawach klienta
i nie powinien trafić na produkcję bez przeczytania przez właściciela (najlepiej także przez prawnika,
który przygotował regulamin). Treść samego regulaminu nie została zmieniona.

Zmiana nazwy odnośnika na „Regulamin sklepu” też jest do potwierdzenia: tytuł dokumentu nadal brzmi
„Regulamin świadczenia usług SkillCheck”.

## 3. Ścieżka testowa dla weryfikatora

### Stan faktyczny

- Płatność testowa (sandbox Przelewy24) działa wyłącznie w wersji testowej serwisu zbudowanej z gałęzi
  `integration`, na testowej bazie `skillcheck-preview`. Kod odmawia jej uruchomienia gdziekolwiek indziej
  (`lib/sc19-payment-preview.ts`). Na produkcji nie ma kluczy Przelewy24 i płatność online nie działa.
- Wersja testowa ma stały adres gałęzi (nie zmienia się przy kolejnych wdrożeniach):
  `https://skillcheck-core-git-integration-krzysztofs-projects-b7ce87b5.vercel.app`
- **Blocker:** ten adres — tak jak adres pojedynczego wdrożenia wysłany 7.11 — jest zasłonięty logowaniem
  Vercel. Osoba z zewnątrz zobaczy ekran logowania do Vercel, nie serwis. Odsłonięcie to zmiana ustawień
  ochrony wdrożeń, czyli decyzja i kliknięcie właściciela.

### Co zobaczy weryfikator (po odsłonięciu adresu testowego)

Kroki wynikają z kodu; pełne przejście na żywo trzeba powtórzyć po odsłonięciu adresu.

1. Strona główna: oferta, ceny, w stopce dane firmy, „Regulamin sklepu”, „Płatności, reklamacje i odstąpienie”, „Kontakt”, „Polityka prywatności”.
2. „Zaloguj się” (`/login`) — konto testowe podane w mailu.
3. `/kup/preselekcja` — przenosi zalogowanego właściciela firmy do zamówienia w panelu firmy.
4. Ekran „Pakiet PRESELEKCJA”: wariant, cena brutto, warunki oferty, zgoda na regulamin i politykę prywatności,
   informacja o operatorze (PayPro S.A.), przycisk „Zamawiam i płacę …”.
   Widoczna notatka: „Płatność testowa w Sandboxie Przelewy24. Środki nie zostaną pobrane.”
5. Po kliknięciu — przejście na `sandbox.przelewy24.pl` (środowisko testowe operatora).
6. Powrót do serwisu: status zamówienia sprawdzany na serwerze; po potwierdzeniu analizy są dopisane do konta testowego.

Na produkcji (`https://skillcheck.pl`) weryfikator widzi strony publiczne i dokumenty; płatność online
pozostaje wyłączona do czasu aktywacji konta przez Przelewy24 i osobnej zgody właściciela.

## 4. Czego brakuje do kliknięcia „Przekaż do weryfikacji”

1. Nowa stopka i strony muszą być na `https://skillcheck.pl` — to wymaga wydania na produkcję (decyzja właściciela).
2. Adres testowy musi być dostępny dla osoby z zewnątrz (decyzja właściciela, patrz blocker wyżej).
3. Konto testowe dla weryfikatora w bazie testowej (agent zakłada sam po decyzji z pkt 2; hasło idzie tylko w mailu właściciela, nie do repozytorium).
