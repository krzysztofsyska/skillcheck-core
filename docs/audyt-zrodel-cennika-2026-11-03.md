# SC-PRICING-W1 — audyt źródeł cennika (2026-11-03)

Zadanie: ustalić, skąd dziś bierze liczby każde miejsce pokazujące lub liczące cenę, i wypisać
każdą rozbieżność. **Żadna cena nie jest w tym zadaniu zmieniana.**

Powód: właściciel 2026-11-03 (głosowo) — „jak się rozjedzie w dwóch miejscach, a trzeba wpisywać
ręcznie, to jest bez sensu". Celem docelowym jest jedno źródło, z którego czytają wszystkie
miejsca (SC-PRICING-W2), oraz element zaakceptowany w kalkulatorze wewnętrznym pojawiający się
na stronie do wyboru przez klienta (SC-PRICING-W3/W4).

## 1. Pięć źródeł liczb

| # | Miejsce | Plik / obiekt | Kto to widzi | Gdzie mieszkają liczby |
|---|---------|---------------|--------------|------------------------|
| 1 | Kalkulator wewnętrzny | `lib/pricing/internal-calculator.ts` → `defaultConfig()` | tylko właściciel cennika (`PRICING_OWNER_EMAILS`) | w kodzie; edycje **tylko w localStorage przeglądarki** |
| 2 | Strona oferty i porównanie pakietów | `lib/preselekcja-offer.ts`, `app/components/marketing/content.ts` | klient | w kodzie |
| 3 | Kalkulator publiczny | `public/kalkulator-demo.html` (statyczny) | klient | w kodzie strony statycznej |
| 4 | Dokument cennika | `docs/cennik-2026-11-02.md` | zespół | w dokumencie |
| 5 | Baza: polityka pakietów i oferta zakupu | `private.sc19_package_policy`, `private.sc19_payment_offers` | ekran zakupu i przyznanie analiz | w bazie (Preview: seed z PR #263) |

Źródło 5 jest nowe — doszło 2026-11-03 razem z SC-P24-VERIFY-001. To ono realnie decyduje, ile
klient zapłaci i ile analiz dostanie.

## 2. Czy liczby są dziś zgodne?

**Tak, co do grosza.** Nie ma dziś rozjazdu cen.

| Pakiet | Kalkulator wewn. | Strona | Kalkulator publ. | Dokument | Baza |
|--------|------------------|--------|------------------|----------|------|
| FREE | 5 CV / 0 zł | 5 CV / 0 zł | 5 CV / 0 zł | 5 CV / 0 zł | 5 CV (polityka) |
| PRESELEKCJA | 60 CV / 300 zł | 60 CV / 300 zł | 60 CV / 300 zł (netto 243,90) | 60 CV / 300 zł | 60 CV / 300 zł (oferta) |
| WERYFIKACJA | 60 CV / 615 zł | 60 CV / 615 zł | 60 CV / 615 zł (jako etap) | 60 CV / 615 zł | **brak** |
| ASSESSMENT CENTER | 50 CV / 1 499 zł | 50 CV / 1 499 zł | 50 CV / 1 499 zł (jako etap) | 50 CV / 1 499 zł | **brak** |

Problem nie polega więc na tym, że coś się już rozjechało, tylko że **nic nie powstrzyma rozjazdu
przy następnej zmianie ceny**: trzeba ją dziś wprowadzić ręcznie w czterech miejscach, a piąte
(baza) zmienia się osobną ścieżką operatorską.

## 3. Rozbieżności i luki

**R1. Pięć kopii tych samych liczb, bez wspólnego źródła.** Zmiana ceny wymaga ręcznej edycji
w czterech plikach plus działania operatora w bazie. To jest główny powód tego zadania.

**R2. Kalkulator wewnętrzny nie zapisuje się nigdzie poza przeglądarką.** `internal-calculator.tsx`
czyta i zapisuje `localStorage` pod kluczem `skillcheck.internal-pricing.v1`. Wyczyszczenie danych
przeglądarki kasuje całą konfigurację; druga osoba ani drugie urządzenie jej nie widzi; nic z niej
nie może być źródłem dla strony, dopóki mieszka tylko w przeglądarce.

**R3. Tylko PRESELEKCJA istnieje w bazie.** Ograniczenia bazy dopuszczają dziś wyłącznie plany
`FREE` i `PRESELEKCJA` (`sc19_package_policy.plan`) oraz oferty z planem `PRESELEKCJA`.
WERYFIKACJA i ASSESSMENT CENTER żyją wyłącznie w kodzie i dokumencie jako „kolejne etapy".
Katalog z W2 musi umieć wyrazić wszystkie cztery, zanim strona zacznie z niego czytać.

**R4. Test spójności pokrywa cztery źródła z pięciu; niepilnowana zostaje baza.**
`tests/marketing-http.test.mjs` przypina liczby z kalkulatora publicznego (3) do
`lib/preselekcja-offer.ts` (2), a `tests/pricing-cv-pool.test.mjs` pilnuje dodatkowo dokumentu
cennika (4) i kalkulatora wewnętrznego (1) — sprawdzone zmianą ceny WERYFIKACJI w `defaultConfig()`,
która ten test wywraca. **Niepilnowana zostaje baza (5)**: polityka pakietów i oferta zakupu mogą
rozjechać się z pozostałymi czterema źródłami i żaden test tego nie wyłapie. To jest realna luka,
którą ma domknąć katalog z W2.

**R5. Dodatki istnieją tylko w kalkulatorze wewnętrznym i mają zerowe stawki.** 20 pozycji
(test kompetencji, zadanie/case study, konsultacja ekspercka, konto użytkownika, raport, stanowisko,
e-mail, SMS, strona OCR, zadanie generowane przez AI, manualny review CV, priorytetowe SLA, godziny
wsparcia, integracja ATS/API/SSO, branding, lokalizacja, umowa indywidualna, talent pool, quality of
hire, rozmowa AI). Wszystkie mają `unitGrossMinor = 0` i `unitCostMinor = 0`. Rozmowa AI jest
osobnym przypadkiem: `disabledEverywhere(...)` wyłącza ją we wszystkich pakietach, bo voicebot nie
działa (decyzja właściciela 2026-11-02). Do katalogu wchodzi więc 19 pozycji, bez rozmowy AI, i nie
należy jej tam dodawać, dopóki voicebot nie zacznie działać. Żadne inne miejsce
w systemie o nich nie wie. To są właśnie „elementy do wyceny", o których mówił właściciel —
po akceptacji mają trafiać na stronę jako wybór klienta (SC-PRICING-W3/W4).

**R6. Pola kosztowe zostają puste — decyzja właściciela 2026-11-03.** `cvCostMinor`,
`paymentFeeBasisPoints`, `fixedCostPerOrderMinor` oraz `unitCostMinor` każdego dodatku stoją na
zerach i tak zostają („jak będą potrzebne, kiedyś to doprogramujemy"). Skutek: wyliczana marża
jest dziś równa cenie i nie należy jej czytać jako marży. Nie jest to błąd do naprawienia w W2.

**R7. Różne modele sprzedaży puli CV.** Kalkulator wewnętrzny zna dopłatę za CV ponad pulę
(20 gr brutto za CV dla WERYFIKACJI i ASSESSMENT CENTER), a dla PRESELEKCJI celowo jej nie ma —
PRESELEKCJA sprzedaje się w całych pakietach po 60 CV. Kalkulator publiczny liczy właśnie całymi
pakietami (`prePackages`), a strona nie wyraża dopłaty w ogóle. Katalog musi umieć oba modele,
inaczej przy przepinaniu strony na katalog jedna z tych ścieżek policzy inną kwotę.

**R8. Kalkulator wewnętrzny sam mówi, że niczego nie zmienia.** Nagłówek strony operatora:
„Zmiany tutaj **nie zmieniają** cen na stronie dla klientów, w kalkulatorze publicznym ani przy
zakupie". Po W2–W4 ten komunikat przestanie być prawdziwy i musi zostać zmieniony razem z nimi —
inaczej panel będzie kłamał właścicielowi o skutkach jego własnych edycji.

## 4. Co z tego wynika dla kolejnych zadań

- **W2 (katalog jako jedno źródło)** musi: unieść cztery pakiety, oba modele puli CV (R7),
  mieć zapis po stronie serwera zamiast przeglądarki (R2) i objąć testem wszystkie pięć miejsc (R4).
- **W3 (opcje płatne)** dotyczy dodatków z R5; tylko pozycja oznaczona przez właściciela jako
  gotowa do realizacji i wyceniona powyżej zera może pojawić się klientowi.
- **W4 (spięcie strony z katalogiem)** kończy się decyzją właściciela o włączeniu flagi, nie
  scaleniem — od tej chwili zmiana w katalogu zmienia ceny widoczne dla klienta.
- Prototyp katalogu `db/isolated/sc-pricing-catalog.sql` ma już wersjonowanie i stan
  DRAFT → PUBLISHED z wymaganą akceptacją. To jest dokładnie model, którego właściciel oczekuje:
  element zaakceptowany staje się widoczny, niezaakceptowany nie.

## 5. Zasady, które nie podlegają zmianie w tych zadaniach

1. Koszty i marże nigdy nie opuszczają panelu operatora — ani na stronę, ani do oferty, ani do bazy
   czytanej przez role publiczne.
2. Klient widzi tylko to, co właściciel oznaczył jako gotowe do realizacji.
3. Zmiana ceny widocznej dla klienta jest decyzją właściciela, nie skutkiem scalenia kodu.
