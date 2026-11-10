# SC-021-C — budżety kosztów AI (80% ostrzeżenie, 100% blokada)

TASK: SC-021-C · Issue #81 · LEVEL: L3 · SCOPE: FULLSTACK · OWNER: Claude (builder) ·
REVIEWER: niezależna sesja · DEPENDS ON: SC-021-A, A2, B ·
PRODUCTION_APPROVAL: NO (działa tylko przy `AI_GATEWAY_ENABLED=true`, które nigdzie nie jest włączone).

## Co dostarcza

| element | rola |
|---|---|
| `supabase/migrations/20261109230000_sc021_ai_budgets.sql` | budżety, rezerwacje, zdarzenia 80%/100%, overridy, audyt, zamknięcie stawki |
| `lib/ai-gateway/budget.ts` | hook `beforeOperation` (`createBudgetGuard`), odczyt decyzji bazy (fail closed) |
| `lib/ai-gateway/gateway.ts` | hook budżetu po autoryzacji i kontroli danych, przed pierwszą próbą |
| `lib/screening-gateway.ts`, worker Edge | rezerwacja `public.reserve_screening_ai_budget` jako `screening_worker` |
| `lib/ai-ledger-writer.ts`, `lib/exercise-ai-budget.ts`, akcja generowania | rezerwacja i zwolnienie przez serwerowe połączenie `ai_ledger_writer`, **przed** zajęciem miejsca na propozycję |

## Model budżetu

- **Okres**: miesiąc kalendarzowy (strefa Europe/Warsaw).
- **Limit** (mikro-jednostki waluty, `bigint`):
  1. ostatnia wersja limitu firmy (`ai_ledger.company_budgets`), jeśli ma kwotę;
  2. w przeciwnym razie ostatnia wersja limitu pakietu (`ai_ledger.plan_budgets`) dla bieżącego
     pakietu firmy (`private.sc19_balances.plan`, dziś FREE / PRESELEKCJA);
  3. brak obu → `budget_unconfigured`.

  Dlaczego firma + pakiet, a nie „budżet na każdy zakup”: salda SC-19 nie mają dziś osobnych
  partii zakupów, a koszt AI rośnie z liczbą analiz w czasie. Limit pakietu daje rozsądną wartość
  domyślną dla wszystkich firm na danym pakiecie, limit firmy — wyjątek dla konkretnego klienta.
  Każda zmiana to nowa wersja (stare zostają), wpisywana tylko funkcją operatora.
- **Zaangażowany koszt** = rozliczony (`settled` z ceną w walucie budżetu) + niepewny (`unknown`,
  bez wyceny albo w innej walucie — liczony najgorszym szacunkiem jednej próby) + część aktywnych
  rezerwacji, której ich próby jeszcze nie zużyły (bez podwójnego liczenia). Próby liczą się w
  miesiącu swojego zapisu; pozostałość każdej wciąż żywej rezerwacji obciąża bieżący miesiąc, także
  gdy rezerwację utworzono w poprzednim (operacja rozpoczęta tuż przed północą ostatniego dnia).
- **Stan**: `ok`, `warning` (≥ 80%), `exceeded` (≥ 100%), `unconfigured`.

## Reguły

- **Rezerwacja przed pierwszą próbą**, jedna na operację, idempotentna:
  screening — `operation_id` (id próby analizy); generowanie zadań — (firma, rekrutacja, klucz),
  jak tożsamość operacji w SC-021-B.
- **Kwota rezerwacji** = najgorszy koszt próby × liczba prób operacji. Najgorszy koszt próby =
  maks. tokeny wejścia (bez rabatu za cache) × stawka wejścia + maks. tokeny wyjścia × stawka
  wyjścia, ze stawki zatwierdzonej albo testowej (`ai_ledger.price_for`). Szacunki
  (`ai_ledger.budget_estimates`, przypięte testem do kodu):
  - screening: 120 000 tokenów wejścia (CV ≤ 100 000 znaków + kryteria + instrukcje), 4 000
    wyjścia, 3 próby (1 + 2 ponowienia workera) → na stawkach testowych 384 000 µUSD.
    **To przybliżenie, nie twardy limit**: ścieżka screeningu nie ogranicza żądania do 120 000
    tokenów (limit bajtów tej wielkości odrzucałby polskie CV do 100 000 znaków, które dziś
    przechodzą). Rozliczona próba ma zawsze dokładny koszt; szacunek dotyczy tylko prób „unknown”
    i kwoty rezerwacji;
  - generowanie zadań: 48 000 wejścia (limit bajtów żądania), 4 000 wyjścia, 1 próba → 56 000 µUSD.
- **100%**: nowa operacja jest odrzucana **przed wywołaniem dostawcy**, gdy zaangażowany koszt +
  jej rezerwacja > limit (`budget_exceeded`, nienaliczone). Raz na okres zapisuje się zdarzenie
  `blocked_100`.
- **80%**: gdy po rezerwacji zaangażowany koszt ≥ 80% limitu, raz na okres zapisuje się zdarzenie
  `warning_80` (także gdy jedna operacja przeskakuje od razu ponad 100% i zostaje odrzucona). Bez maili
  i innych wysyłek — tylko trwały wpis i stan.
- **Operacje w toku nie są odcinane**: operacja przechodzi bez nowego sprawdzenia, gdy ma żywą
  rezerwację (niezwolnioną i niewygasłą) albo ma już próby w rejestrze — także po przekroczeniu limitu
  (np. po obniżeniu limitu przez operatora). Blokowane są tylko nowe operacje.
- **Ponowne użycie klucza**: rezerwacja zwolniona lub wygasła, bez prób w rejestrze (np. klucz
  żądania użyty jeszcze raz), nie daje wolnej drogi — przechodzi pełne sprawdzenie i, jeśli mieści
  się w limicie, dostaje nową wersję (`arm`). Nad 100% jest odrzucana.
- **Zwolnienie**: rezerwacja przestaje trzymać kwotę, gdy (a) zostanie zwolniona (generowanie zadań
  po zakończeniu; zwolnienie jest odmawiane, dopóki generacja tego klucza jest `reserved`, więc
  równoległe wywołanie z tym samym kluczem nie zwolni cudzej rezerwacji), (b) operacja się skończy (próba analizy nie jest już `pending`/`processing`,
  generacja nie jest już `reserved`), albo (c) wygaśnie (screening 15 min, generowanie 5 min) — po
  awarii nic nie blokuje na zawsze. Faktyczny koszt prób zostaje w rejestrze.
- **Współbieżność**: blokada doradcza na firmę przed sumowaniem, tryb `read committed` wymagany
  (inny poziom izolacji → odmowa). Test na dwóch połączeniach.
- **Brak budżetu → odmowa** (`budget_unconfigured`). Uzasadnienie: flaga gatewaya jest dziś
  wszędzie wyłączona, więc nic się nie zmienia, a przed jej włączeniem budżety muszą istnieć —
  bez tego płatne wywołania nie miałyby żadnego limitu. To samo, gdy dla waluty budżetu nie ma
  stawki.

## Komunikaty

- Screening: analiza kończy się statusem `failed` z kodem `ai_budget_exceeded` albo
  `ai_budget_unavailable` (bez ponowień, jak inne odmowy przed dostawcą); komunikat po polsku
  „Miesięczny limit kosztów AI firmy został wyczerpany…”.
- Generowanie zadań: odmowa **przed** zajęciem miejsca na propozycję; rekruter widzi
  „Miesięczny limit kosztów AI Twojej firmy został wyczerpany. Napisz zadanie ręcznie albo
  skontaktuj się z obsługą SkillCheck. Nie zużyto próby AI.”

## Override i audyt

Wyłącznie operator platformy (`private.is_platform_operator`), nigdy członek firmy:

- `raise` — podniesienie limitu o kwotę, z powodem i datą wygaśnięcia (≤ 31 dni); waluta musi być
  walutą obowiązującego budżetu firmy (inaczej odmowa `22023`, bez budżetu też);
- `bypass` — zdjęcie blokady 100% (ostrzeżenie zostaje), z powodem i wygaśnięciem; rezerwacja,
  którą przepuścił, wskazuje ten override;
- odwołanie overridu — jednorazowe, z powodem.

Każda zmiana limitu, override, odwołanie i zamknięcie stawki zapisuje wiersz
`ai_ledger.budget_audit` (autor, akcja, firma, szczegóły, powód). Konfiguracja, zdarzenia i audyt są
tylko dopisywane; overridy i rezerwacje dopuszczają tylko jednorazowe ustawienie pola
odwołania / zwolnienia.

**Zamknięcie stawki** (z review B): `ai_ledger.operator_close_price` ustawia `valid_to` jeden raz,
z pustego na datę nie wcześniejszą niż teraz; stawek nie da się zmienić (wyzwalacz).

## Kroki operatora (przed włączeniem `AI_GATEWAY_ENABLED`)

To decyzja właściciela/operatora, nie ta zmiana. Funkcje operatora leżą w schemacie `ai_ledger`,
którego API Supabase (PostgREST) nie udostępnia, i wymagają `auth.uid()` operatora platformy — nie da
się ich więc wywołać ani z przeglądarki, ani wprost z edytora SQL (tam `auth.uid()` jest puste →
`ai_budget_operator_forbidden`). Docelowo ustawia się je w panelu operatora z SC-021-D (akcja
serwerowa w imieniu zalogowanego operatora). Do tego czasu — tylko na bazie, na której właściciel
na to pozwolił — w edytorze SQL, w jednej transakcji, w imieniu konta operatora:

```sql
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '<user_id operatora platformy>', true);
select ai_ledger.operator_set_plan_budget('FREE', <limit_µ>, 'USD', 'Limit kosztów AI pakietu FREE');
select ai_ledger.operator_set_plan_budget('PRESELEKCJA', <limit_µ>, 'USD', 'Limit kosztów AI pakietu PRESELEKCJA');
-- wyjątek dla firmy (NULL, NULL = wróć do limitu pakietu):
select ai_ledger.operator_set_company_budget('<company_id>', <limit_µ>, 'USD', '<powód>');
commit;
```

Audyt zapisze wtedy tego operatora jako autora.

Waluta budżetu musi mieć stawkę w `ai_ledger.prices` (dziś tylko testowa w USD). Kwoty limitów to
decyzja właściciela (koszty). Na produkcji nic nie jest ustawione.

## Bezpieczeństwo i SC-010

- Nowe tabele w schemacie `ai_ledger` (poza `public`/`private`), bez kluczy obcych do nich i bez
  danych kandydata: `operation_id` screeningu to pseudonim, jak w B. Sygnatura SC-010 (R15) bez zmian
  (preflight i postflight).
- RLS na wszystkich tabelach; brak bezpośredniego zapisu dla ról API. Członek firmy czyta stan
  (`ai_ledger.company_budget_status`) i zdarzenia swojej firmy (RLS); inna firma — odmowa.
- Funkcje `security definer` z `search_path = ''`; PUBLIC odebrane; uprawnienia: worker — tylko
  `reserve_screening_ai_budget`; `ai_ledger_writer` — tylko rezerwacja/zwolnienie generowania;
  `authenticated` — odczyt stanu i funkcje operatora (sprawdzają operatora).

## Co zostaje na D

- Panel kosztów i budżetów (operator: ustawianie limitów i overridów, przegląd audytu; firma:
  widok stanu i ostrzeżenia), odczyt przez `company_budget_status` / `operator_budget_audit`.
- Grupowanie kosztów po operacji (reguła tożsamości z B).
- Zatwierdzone stawki dostawcy i kwoty limitów — decyzja właściciela.
- Status `reserved` w `ai_ledger.attempts` pozostaje nieużywany: rezerwacje mają własną tabelę
  (próby pozostają tylko dopisywane).

## Testy

- `npm run test:ai-gateway` — hook budżetu w gatewayu, screening i generowanie zadań (bez sieci).
- `npm run test:ai-budget-db` — PostgreSQL (CI: PG16): dwie firmy, brak budżetu, limit pakietu i
  firmy, 80%, 100%, rezerwacja/rozliczenie/zwolnienie, wygaśnięcie, operacje w toku, overridy i
  audyt, izolacja, wyścig na dwóch połączeniach, zamknięcie stawki, rollback, ponowne użycie klucza
  (pełne sprawdzenie), zwolnienie przy równoległym duplikacie, okresy Europe/Warsaw (zmiana czasu).
