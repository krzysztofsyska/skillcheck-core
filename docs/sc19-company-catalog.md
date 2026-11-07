# SC-019 — firmowy podgląd katalogu (#283/#284)

Ekran `/dashboard/[companyId]/billing` może pokazać podstawowe ceny i pule CV
z istniejących RPC `pricing_published_packages` i `pricing_published_addons`.
Odczyt używa klienta uwierzytelnionego przez `companyAccess`, bez dostępu uprzywilejowanego.
Nie zmienia salda, pakietu, uprawnień ani warunków zamówienia.

## Aktywacja i granice

- `SC19_CATALOG_ENABLED` to nowa flaga serwerowa, domyślnie OFF. Sekcja wymaga
  też `SC19_PACKAGES_ENABLED=true`. Ten PR nie włącza żadnej flagi.
- Włączenie prezentacji katalogu pozostaje osobnym krokiem wydania zgodnie z W4.
- Podgląd nie jest wyceną zamówienia. Obecna kasa weryfikuje własną zatwierdzoną
  ofertę, uprawnienia firmy, cenę i warunki przed zakupem.
- `sellable` z katalogu nie dowodzi gotowości realizacji. WERYFIKACJA i AC
  nadal są niedostępne do zakupu; istniejące FREE/PRESELEKCJA zachowują własne bramki.
- Nie ma aktywnego kontraktu zakupu i realizacji dodatków. Dlatego każdy pokazany
  dodatek jest niedostępny do zakupu. Tylko znane istniejące funkcje `report`
  i `ocr_page` mają dopuszczone etykiety; pozostałe wpisy są pomijane, w tym voicebot.
- Brak opublikowanego katalogu, niepełne/niepoprawne dane i błędy odczytu dają
  neutralny komunikat. Nie ma zastępczych cen wpisanych w kodzie.
- Ta część nie realizuje upgrade, dodatkowych uprawnień, zgodności dodatków ani
  atomowego połączenia wyceny z zamówieniem. #283 i #284 pozostają otwarte.

## Sprawdzenie

`tests/sc-019-billing-ui.test.mjs` renderuje rzeczywistą stronę dla obu ról,
obu flag, różnych cen, błędów/duplikatów danych i dodatków spoza zakresu.
`tests/pricing-catalog.test.mjs` wykonuje istniejące RPC na izolowanej bazie
(opublikowana wersja, brak szkiców, zatwierdzone kwoty, dostępność dodatków).
`tests/database-types.contract.ts` sprawdza kształt odpowiedzi RPC.
Wymagane: testy billingu/zakupu/katalogu, typecheck, build, pełne CI i niezależny review.
