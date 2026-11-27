# SC-019a — test końcowy sklepu w core (tryb testowy Stripe), 27.11.2026

Krok R7 (`docs/ROADMAP.md`), issue #634. Dane wyłącznie fikcyjne, bez sieci, bez prawdziwych
kluczy, bez trybu live, bez zmian w kodzie aplikacji i bez migracji.

## Co sprawdza test

Plik: `tests/sc019a-shop-e2e-database.test.mjs`, w grupie `npm run test:ac-session-db`
(CI: `.github/workflows/checks.yml`, PostgreSQL 16).

Cztery fikcyjne firmy z potwierdzonym NIP-em: P kupuje PRESELEKCJĘ, W kupuje WERYFIKACJĘ,
A kupuje ASSESSMENT CENTER, N nie kupuje niczego.

1. Bez zakupu: żadna firma nie ma puli CV ani pakietu; analiza CV jest odrzucana
   (`sc19_quota_exhausted`), sesja AC jest odrzucana („Assessment Center package required”).
2. Sklep pokazuje dokładnie trzy pakiety w cenach z `docs/cennik-2026-11-02.md`:
   PRESELEKCJA 300 zł / 60 CV, WERYFIKACJA 615 zł / 60 CV, ASSESSMENT CENTER 1 499 zł / 50 CV.
3. Dla każdego pakietu, przez warstwę HTTP płatności:
   - zakup tworzy płatność Stripe w trybie testowym (`cs_test_…`) na kwotę z cennika;
   - przed zapłatą dostępu nadal nie ma (analiza CV i sesja AC odrzucone);
   - zdarzenie `checkout.session.completed` dla sesji jeszcze nieopłaconej niczego nie daje;
   - zdarzenie z fałszywym podpisem (inny sekret) jest odrzucane (400) i niczego nie daje;
   - podpisane zdarzenie po zapłacie otwiera właściwy pakiet i limit: PRESELEKCJA 60 CV,
     WERYFIKACJA 60 CV + pakiet `WERYFIKACJA`, ASSESSMENT CENTER 50 CV + pakiet
     `ASSESSMENT_CENTER`; powtórka zdarzenia = `already_applied`, nic nie dochodzi drugi raz;
   - wykorzystanie: jedna analiza CV zużywa jedno CV z kupionej puli; tylko ASSESSMENT CENTER
     pozwala utworzyć sesję AC (pakiet nie jest przez nią zużywany).
4. Zakup jednej firmy nie otwiera niczego innej; firma N nadal nie ma dostępu; jeden wpis
   przyznania na opłacone zamówienie; żadnego zamówienia poza trybem testowym.

Prawdziwe w teście: pełny łańcuch migracji, oferta PRESELEKCJI z seeda Preview, rola adaptera
`sc19_p24_checkout` z jej uprawnieniami, `lib/sc19-payment-http.ts`, `lib/sc19-payments.ts`,
magazyn Postgres z rozszerzeniem pakietów Stripe, adapter `lib/sc19-stripe-provider.ts`
(z weryfikacją `Stripe-Signature`), bramka sesji AC (R3), zużycie analizy CV.
Atrapy: API Stripe (wstrzyknięty `fetch`), logowanie (stały użytkownik), klucze testowe
losowane w trakcie testu.

## Wyniki (27.11.2026, lokalnie)

- Nowy test na PostgreSQL 16.15: 6 z 6 sprawdzeń zielonych, 1 oznaczone jako `todo` (luka niżej).
- Cała grupa `npm run test:ac-session-db`: 58 zielonych, 0 błędów, 1 `todo`.
- Dowód negatywny: po ręcznym dopisaniu pakietu AC firmie N (bez zakupu) test zgłasza błąd
  w 2 sprawdzeniach dostępu — kontrola wykrywa dostęp bez zakupu.
- `npm run typecheck`: zielony.
- Przejście na Preview z prawdziwym kontem testowym Stripe: NOT RUN (wymaga kluczy testowych
  Stripe w Preview; poza zakresem tego kroku).

## Luki

1. **Test kompetencji (warstwa WERYFIKACJI) nie zależy od zakupu WERYFIKACJI** (issue #634,
   w teście jako `todo`). Zakup WERYFIKACJI daje pulę 60 CV i pakiet `WERYFIKACJA`, ale żadna
   funkcja w bazie nie sprawdza tego pakietu. Liczenie testów
   (`sc19_commerce.settings.skill_test_metering`) jest wyłączone, a migracja
   `20261121150000_r7_stripe_packages.sql` celowo nie przyznaje jednostek testu („liczby testów
   w WERYFIKACJI nie ma w cenniku”). Skutek: firma z samą PRESELEKCJĄ albo FREE może wysłać
   test kompetencji. To decyzja produktowa (ile testów w WERYFIKACJI i czy je blokować), więc
   osobny krok; tu nic nie jest poprawiane.
2. Faktury Fakturowni nie są częścią tego testu (tryb testowy ich nie wystawia; prawdziwe
   płatności i faktury mają osobne testy w `tests/sc19-stripe-live.test.mjs` i
   `tests/sc19-stripe-database.test.mjs`).
3. Rozmowy głosowe z pakietu (10 na pakiet) celowo pominięte — voicebot nie jest pokazywany
   klientom, dopóki nie działa.
