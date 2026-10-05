# SC-SALES-006A — projekt formularza kontaktowego i bezpiecznej obsługi zgłoszeń

- TASK: SC-SALES-006A
- STATUS: REVIEW
- LEVEL: L3
- OWNER: Codex
- REVIEWER: Codex
- BASE: `dbef6a8462f2e46587d061c321586136e0e68fbe` (`origin/main` w momencie projektu)
- DB / MIGRATIONS: brak zmian wykonanych w tym zadaniu

To nie jest backendowe SC-006. SC-006 w `docs/BACKLOG.md` nadal oznacza UI uruchomienia analizy AI i pozostaje BACKLOG. To zadanie nie zmienia jego zakresu.

## 1. Cel

Firma odwiedzająca publiczną stronę może zostawić kontakt w sprawie rozmowy o rekrutacji, bez zakładania konta. Właściciel SkillCheck odczytuje zgłoszenie tylko jako uprawniony operator platformy. Wysłanie formularza nie rezerwuje terminu i nie obiecuje czasu odpowiedzi.

## 2. Co już jest i co wolno użyć ponownie

Sprawdzone w kodzie na bazie `dbef6a8`:

- Role firmy to wyłącznie `companies.owner_id` oraz `company_members.role` o wartościach `recruiter` albo `viewer`. Nie ma roli operatora platformy, kolumny administratora ani tabeli uprawnień globalnych.
- Każda tabela operacyjna ma `company_id`. RLS i `private.has_company_access` izolują tenantów. Anonim nie ma do nich dostępu.
- Zapis krytyczny idzie przez funkcje `SECURITY DEFINER` z `search_path = ''`, a nie przez otwarty `INSERT`. Wzorzec jest w `public.create_company` i RPC preselekcji. Po utworzeniu funkcji projekt robi `revoke all` i nadaje `execute` tylko wybranym rolom.
- Aplikacja używa `lib/supabase/server.ts` i klucza publicznego. `service_role` jest zakazany w runtime. Tego zakazu nie luzujemy.
- Walidacja e-maila logowania jest w `lib/auth-validation.ts`: trim, długość do 254, jeden prosty wzorzec bez MX.
- Formularze auth są server actions w `app/auth/actions.ts`. Błąd nie pokazuje surowego komunikatu dostawcy.
- `proxy.ts` odświeża sesję tylko dla `/login`, `/register`, `/forgot-password`, `/reset-password`, `/onboarding` i `/dashboard/:path*`. Strony `/` i `/demo` są statyczne i celowo nie wołają Supabase przy wejściu.
- Publiczna oferta jest w `app/components/marketing/`. Przyciski „Zobacz przykład” i „Utwórz konto” są w sekcji otwierającej i na końcu `/` oraz `/demo`. Stopka bierze linki z `app/components/marketing/links.ts`.
- Testy bazy odtwarzają role `anon` i `authenticated` oraz `auth.uid()` w PGlite. Kontrakt tabel i RPC jest zamrożony w `tests/database-types.test.mjs` i `tests/database-types.contract.ts`.
- Ostatnia wykonana migracja to `20261005000100_screening_worker_claim_payload.sql`. Starszych plików nie wolno uruchamiać ponownie ani edytować.

Nie używać tabel `candidates`, `companies` ani `company_members` jako miejsca na zgłoszenie. Nie wywoływać `create_company` ani `ensure_initial_company` z formularza publicznego.

## 3. Podział implementacji

Jeden krok nie obejmuje jednocześnie migracji, publicznej strony i panelu.

| Etap | Zakres | Zależność |
|---|---|---|
| SC-SALES-006B | Nowa migracja, RLS, RPC, typy, testy PGlite | ten dokument na `main` |
| SC-SALES-006C | Strona `/rozmowa`, przyciski, server action, test HTTP | 006B DONE |
| SC-SALES-006D | Widok `/operator/leads` | 006C DONE |
| SC-SALES-013 | Etapy, notatki, przypomnienia, ręczne powiązanie z firmą | 006D DONE |

006D jest po 006C, bo oba etapy dopisują skrypt testowy do `package.json` i CI. Publiczne włączenie wymaga obu.

Pierwszy prompt wykonawczy jest w `docs/sc-sales-006b-cursor-prompt.md`.

## 4. Ścieżka odwiedzającego

1. Na stronie widzi odnośnik „Porozmawiajmy o Twojej rekrutacji”.
2. Otwiera `/rozmowa` bez konta.
3. Podaje imię, nazwę firmy, e-mail i krótki opis potrzeb. Telefon może zostać pusty.
4. Wysyła formularz.
5. Napis „Zgłoszenie zostało zapisane. To nie jest rezerwacja terminu rozmowy.” pojawia się tylko wtedy, gdy funkcja bazy zwróci identyfikator istniejącego albo nowo zapisanego wiersza.

Nie dodawać kalendarza, uploadu CV, załączników, płatności ani wysyłki wiadomości.

### Gdzie dodać odnośnik w 006C

- Sekcja otwierająca i sekcja zamykająca `app/components/marketing/home-page.tsx`.
- Sekcja zamykająca `app/components/marketing/demo-page.tsx`.
- Stopka przez `footerLinks` w `app/components/marketing/links.ts`.
- Nawigacja desktop i menu telefonu w `site-header.tsx` oraz `mobile-nav.tsx`, jako odnośnik tekstowy za „Zaloguj się”. Przycisk „Zobacz przykład” zostaje przyciskiem głównym.

Adres strony formularza: `/rozmowa`. Nie używać `/kontakt` ani adresu sugerującego umówione spotkanie.

## 5. A. Formularz i walidacja

### Pola

| Pole | Wymagane | Po normalizacji | Zasada |
|---|---|---|---|
| `first_name` | tak | 1–80 znaków | trim, wielokrotne białe znaki do jednej spacji |
| `company_name` | tak | 1–160 znaków | tak samo |
| `email` | tak | 3–254 znaków | trim, małe litery, wzorzec `^[^\s@]+@[^\s@]+\.[^\s@]+$` |
| `phone` | nie | `null` albo 5–32 znaki | pusty tekst staje się `null`; wzorzec `^[0-9+().\-\s]{5,32}$` |
| `needs` | tak | 10–1000 znaków | trim, końce linii do `\n` |
| `idempotency_key` | tak | UUID | generuje przeglądarka, nie użytkownik |

Odrzucić znaki sterujące. W `needs` wolno zostawić tabulator i znak nowej linii. Nie sprawdzać MX. Nie poprawiać telefonu do formatu międzynarodowego.

Normalizacja jest powtarzana w server action i jeszcze raz wewnątrz `submit_sales_lead`. Baza jest źródłem prawdy. Action nie przepuszcza danych, które już lokalnie łamią limity, ale bezpośrednie RPC też nie może ich zapisać.

### Stany interfejsu

- gotowy — pola edytowalne, przycisk „Wyślij zgłoszenie”;
- wysyłanie — `aria-busy`, wartości zostają, drugi klik nie tworzy nowego klucza;
- sukces — formularz znika, zostaje tylko potwierdzenie z cytowanym wyżej zdaniem;
- błąd — wartości zostają, komunikat w `role="alert"`, fokus na pierwszym błędzie pola albo na podsumowaniu;
- ponowienie — ten sam klucz, dopóki treść po normalizacji jest taka sama.

Wyłączony przycisk jest tylko stanem interfejsu. Nie jest zabezpieczeniem.

### Klawiatura i telefon

Etykiety powiązane z polami, bez zastępowania ich placeholderem. `autoComplete`: `given-name`, `organization`, `email`, `tel`. `inputMode` dla e-maila i telefonu. Przycisk ma co najmniej 44 px wysokości. Cały formularz działa tabulatorem i Enterem. Błędy nie opierają się wyłącznie na walidacji przeglądarki.

### Komunikaty

- błąd pola: krótko o tym polu, bez treści innego zgłoszenia;
- błąd zapisu: „Nie udało się zapisać zgłoszenia. Dane zostały w formularzu. Możesz spróbować ponownie.”;
- limit: „Nie udało się teraz przyjąć zgłoszenia. Spróbuj później.”;
- formularz wyłączony: „Formularz nie przyjmuje teraz zgłoszeń.”;
- konflikt klucza: „To zgłoszenie różni się od poprzedniej próby. Wyślij je ponownie.” Po tym błędzie przeglądarka tworzy nowy klucz.

Nie pokazywać kodu SQL, nazwy constraintu ani identyfikatora cudzego wiersza.

### Informacja o danych

Nie ma zatwierdzonej treści o przetwarzaniu danych. 006C nie wymyśla regulaminu, okresu retencji ani podstawy prawnej. Jeśli zmienna `SALES_LEAD_NOTICE` jest pusta, strona nie podaje własnej klauzuli. Publiczne włączenie i tak jest zablokowane do czasu decyzji właściciela opisanej w sekcji 10.

## 6. B. Model danych

Nowa migracja, jedyna do utworzenia w 006B: `supabase/migrations/20261006000100_sales_leads.sql`. Jeśli ten numer będzie już zajęty, zatrzymać się. Nie edytować migracji o niższych numerach.

### `public.sales_leads`

| Kolumna | Typ | Znaczenie |
|---|---|---|
| `id` | `uuid` PK, `gen_random_uuid()` | nadawany w bazie |
| `idempotency_key` | `uuid not null unique` | klucz ponowienia |
| `first_name` | `text not null` | imię po normalizacji |
| `company_name` | `text not null` | nazwa firmy wpisana przez osobę |
| `email` | `text not null` | e-mail po normalizacji |
| `phone` | `text null` | telefon albo brak |
| `needs` | `text not null` | opis potrzeb |
| `status` | `text not null default 'received'` | jedyna dozwolona wartość: `received` |
| `submitted_by` | `uuid null` → `auth.users(id) on delete set null` | `auth.uid()` w chwili zapisu, nigdy argument klienta |
| `fingerprint_hash` | `text not null` | 64 znaki hex, bez adresu IP |
| `created_at` | `timestamptz not null default now()` | czas zapisu |

Brak `company_id`, `updated_at` i kolumny edytowalnej przez zgłaszającego. `status` ma check równy dokładnie `received`. Rozszerzenie statusów należy do SC-SALES-013 i wymaga nowej migracji.

Długości z sekcji 5 są też checkami tabeli. Check nie zastępuje walidacji formatu e-maila i telefonu w funkcji.

Trigger `BEFORE UPDATE OR DELETE` woła `private.sales_leads_immutable()` i przerywa operację kodem `sales_lead_immutable`. Wiersz jest dopisywany, nie poprawiany i nie usuwany przez API.

### `public.platform_operators`

| Kolumna | Typ | Znaczenie |
|---|---|---|
| `user_id` | `uuid` PK → `auth.users(id) on delete cascade` | konto operatora |
| `granted_at` | `timestamptz not null default now()` | nadanie |
| `granted_by` | `uuid null` → `auth.users(id) on delete set null` | kto nadał; `null` dla pierwszego wpisu SQL |
| `revoked_at` | `timestamptz null` | `null` oznacza uprawnienie aktywne |

Check: `revoked_at` jest puste albo nie wcześniejsze niż `granted_at`. Migracja nie wstawia żadnego `user_id`.

Aktywny operator to wiersz z `revoked_at is null`. Właściciel firmy-klienta nie staje się operatorem przez `companies.owner_id`.

### `private.sales_lead_settings`

Jednowierszowa tabela. Kolumna `leads_enabled boolean not null default false`. Migracja wstawia `false`. Brak grantów dla `anon` i `authenticated`. Przełącznik publiczny jest opisany w sekcji 10.

### `private.sales_lead_attempts`

| Kolumna | Typ |
|---|---|
| `id` | `bigint identity` PK |
| `fingerprint_hash` | `text not null` |
| `attempted_at` | `timestamptz not null default now()` |
| `result` | `text not null`: `accepted`, `rejected`, `rate_limited`, `unavailable`, `replay` |

Tabela nie zawiera imienia, telefonu, e-maila, nazwy firmy ani treści potrzeb. Służy do limitu prób. Schemat `private` nie jest wystawiony w API.

### Powtórzone wysłanie

Funkcja normalizuje argumenty i szuka `idempotency_key`.

- Brak wiersza i flaga włączona: po limitach robi `INSERT` i zwraca nowe `id`.
- Brak wiersza i flaga wyłączona: `sales_lead_unavailable`, bez nowego zgłoszenia i bez wiersza w `sales_lead_attempts`. Limit prób nie maleje.
- Jest wiersz i wszystkie znormalizowane pola są równe: zwraca istniejące `id` także przy wyłączonej fladze, dopisuje attempt `replay`, nie tworzy drugiego zgłoszenia i nie zwiększa liczników z sekcji 9. Dzięki temu ponowienie po utracie odpowiedzi nie kończy się fałszywym błędem.
- Jest wiersz i którekolwiek pole się różni: przerywa kodem `sales_lead_idempotency_conflict`, nie zmienia wiersza.

Ten sam klucz z inną wielkością liter e-maila albo ze spacjami na brzegach jest powtórzeniem, nie konfliktem. Inny opis potrzeb jest konfliktem.

Nowy klucz przy tym samym e-mailu może utworzyć kolejne zgłoszenie, aż do limitu z sekcji 9. Domeny e-maila nie wolno porównywać z firmami ani członkostwami.

`submitted_by` ustawia wyłącznie funkcja z `(select auth.uid())`. Dla anonima zostaje `null`. Zalogowanie nie tworzy firmy i nie wiąże zgłoszenia z tenantem.

## 7. C. Granica zaufania

```text
przeglądarka
  → server action Next.js (klient z kluczem publicznym i ciasteczkiem sesji)
    → public.submit_sales_lead(...) jako rola anon albo authenticated
      → INSERT wykonany wewnątrz SECURITY DEFINER
```

Przeglądarka nie dostaje połączenia do Postgresa inaczej niż przez opublikowane API Supabase. To API używa ról `anon` i `authenticated`.

### Dlaczego bezpośrednie API nie omija walidacji

1. `revoke all` na `public.sales_leads`, `public.platform_operators` i tabelach `private` odbiera `anon` oraz `authenticated` prawa `select`, `insert`, `update` i `delete`. PostgREST odrzuca operację na tabeli brakiem uprawnienia, zanim zastosuje RLS.
2. RLS i tak jest włączone. Nie ma polityki `INSERT`. Nawet późniejsze przypadkowe `GRANT INSERT` bez polityki nie wstawi wiersza roli niebędącej właścicielem.
3. Jedyny zapis zgłoszenia to `public.submit_sales_lead`. Funkcja jest `SECURITY DEFINER`, ma `search_path = ''` i sama normalizuje, sprawdza format, limity, flagę i klucz. Argumenty nie obejmują `id`, `status`, `created_at`, `submitted_by` ani `company_id`.
4. `execute` na tej funkcji mają `anon` i `authenticated`. Nie mają go na funkcjach prywatnych.
5. Odczyt listy ma tylko `public.list_sales_leads`, i tylko dla aktywnego operatora. Brak `GRANT SELECT` na tabeli oznacza, że firma-klient nie odczyta zgłoszeń zapytaniem `.from('sales_leads')`.
6. Trigger koryguje próbę `UPDATE` i `DELETE` na `sales_leads`, także gdy wywoła ją funkcja.
7. Runtime aplikacji nie używa `service_role`. Istniejące polityki tenantów nie dostają nowej roli ani wyjątku.

`private.is_platform_operator(uuid)` jest `SECURITY DEFINER` z pustym `search_path`. Zwraca prawdę tylko dla aktywnego wiersza. `execute` ma wyłącznie `authenticated`. Funkcja nie jest wystawiona jako publiczne RPC.

## 8. D. Operator platformy

### Nadanie i odebranie

Pierwszego operatora nie tworzy aplikacja i nie tworzy migracja. Właściciel projektu, po zalogowaniu się zwykłym kontem, kopiuje własny UUID z panelu Auth i uruchamia w SQL Editorze jako postgres:

```sql
insert into public.platform_operators (user_id)
values ('UUID-Z-PANELU-AUTH');
```

Projekt nie podaje tego UUID.

Kolejnego operatora nadaje już aktywny operator przez `public.grant_platform_operator(target_user uuid)`. Cel musi istnieć w `auth.users`. Ponowne nadanie czyści `revoked_at`. W 006B nie ma do tego ekranu. RPC ma być pokryte testem, a ekran nadawania zostaje poza 006C i 006D.

`public.revoke_platform_operator(target_user uuid)` ustawia `revoked_at`. Aktywny operator nie może odebrać uprawnienia samemu sobie, jeśli jest ostatnim aktywnym operatorem. Wtedy funkcja zwraca `sales_lead_last_operator` i nic nie zmienia.

Oba RPC sprawdzają operatora po `auth.uid()`. Nie przyjmują identyfikatora wywołującego. Właściciel firmy, rekruter i viewer dostają odmowę.

### Sprawdzenie

- W bazie: `private.is_platform_operator((select auth.uid()))`.
- W aplikacji, od 006D: `public.platform_operator_status()` zwraca boolean i nie ujawnia innych operatorów. Rola `anon` nie ma `execute`, więc brak sesji obsługuje przekierowanie do `/login` zanim padnie wywołanie. Zalogowany bez aktywnego wiersza dostaje `false`. `auth.uid()` równe `null` wewnątrz funkcji też zwraca `false`.

### Widok

Adres: `/operator/leads`. Nie leży pod `/dashboard/[companyId]`, bo nie jest zasobem tenanta.

006D:

- brak sesji przekierowuje do `/login`, tak jak reszta chronionych stron;
- sesja bez operatora kończy się `notFound()`, bez informacji, że adres istnieje;
- operator widzi do 50 najnowszych zgłoszeń: czas, imię, nazwę firmy, e-mail, telefon, opis, status i UUID `submitted_by`, jeśli jest;
- brak edycji, notatek, filtrów CRM, eksportu i wysyłki;
- `list_sales_leads` przycina limit do zakresu 1–100 niezależnie od argumentu. Domyślnie 50. Sortowanie: `created_at desc`, `id desc`.

`proxy.ts` w 006D dopisuje wyłącznie matcher `/operator/:path*`, żeby sesja i `Cache-Control: private, no-store` działały jak na `/dashboard`.

## 9. E. Ochrona publicznego formularza

Limity egzekwuje `submit_sales_lead`, nie przycisk:

- flaga `private.sales_lead_settings.leads_enabled` musi być `true` dla nowego klucza, inaczej `sales_lead_unavailable` i brak zapisu; wyjątek ponowienia jest w sekcji 6;
- 8 prób na `fingerprint_hash` w 10 minut, licząc attempty inne niż `replay`; po przekroczeniu `sales_lead_rate_limited`;
- 5 przyjętych zgłoszeń na ten sam odcisk w 60 minut;
- 3 przyjęte zgłoszenia na ten sam znormalizowany e-mail w 24 godziny;
- 30 przyjętych zgłoszeń łącznie w 60 minut.

Replay tego samego klucza i tej samej treści nie zwiększa liczników i nie tworzy wiersza.

Odcisk liczy server action: HMAC-SHA256 z sekretem `SALES_LEAD_FINGERPRINT_SECRET` i treścią `ip + '|' + userAgent`. Do funkcji trafia sam hex. Adres IP bierze się z `x-real-ip`, a gdy go nie ma, z `127.0.0.1`. Nie używać lewej strony `x-forwarded-for` podanej przez klienta. Sekret krótszy niż 32 znaki albo pusty oznacza odmowę przed RPC.

Rozmiar: action odrzuca pole, zanim je zapisze, gdy surowy tekst przekracza limit kolumny. Nie obniżać globalnego `serverActions.bodySizeLimit` w `next.config.mjs`, bo ten sam proces przyjmuje pliki CV.

Niedostępna baza, wyłączona flaga albo brak sekretu dają komunikat odmowy i nie pokazują sukcesu. Wyjątek Postgresa jest mapowany na stały kod. Log serwera zawiera tylko nazwę zdarzenia: `sales_lead_accepted`, `sales_lead_rejected`, `sales_lead_rate_limited`, `sales_lead_unavailable`, `sales_lead_replay`. Bez imienia, e-maila, telefonu, firmy, treści i adresu IP.

Ryzyko resztkowe: ktoś wołający RPC bezpośrednio może zmieniać odcisk. Nadal wiążą go limit e-maila i limit globalny. Captcha i nowa zależność nie wchodzą do tych etapów.

## 10. F. Konfiguracja i uruchomienie

### Zmienne

| Nazwa | Gdzie | Uwagi |
|---|---|---|
| `SALES_LEADS_ENABLED` | serwer Vercel, nie `NEXT_PUBLIC` | `true` albo `false`; brak traktować jak `false` |
| `SALES_LEAD_FINGERPRINT_SECRET` | serwer Vercel | co najmniej 32 znaki; nie wkładać wartości do repozytorium |
| `SALES_LEAD_NOTICE` | serwer Vercel | zatwierdzona treść od właściciela; pusta do czasu decyzji |

Istniejące `NEXT_PUBLIC_SUPABASE_URL` i `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` wystarczą do wywołania RPC. Nie dodawać klucza `service_role`.

### Kolejność

1. Zmergować 006B. Uruchomić tylko `20261006000100_sales_leads.sql` raz, na docelowym Supabase, metodą już używaną dla nowych migracji. Nie uruchamiać starszych plików.
2. Zmergować 006C i 006D przy `leads_enabled = false` i `SALES_LEADS_ENABLED` nieustawionym. Formularz odpowiada odmową.
3. Właściciel podaje UUID swojego konta Auth i wykonuje SQL z sekcji 8.
4. Właściciel zatwierdza tekst `SALES_LEAD_NOTICE` albo świadomie odkłada publikację.
5. Ustawić sekret odcisku.
6. Ustawić `SALES_LEADS_ENABLED=true` oraz `update private.sales_lead_settings set leads_enabled = true`.
7. Sprawdzić jedno zgłoszenie testowe i odczyt operatorem. Potem usunięcie testu, jeśli będzie potrzebne, wymaga ręcznego wyłączenia triggera przez postgresa. API tego nie zrobi.

Wyłączenie bez utraty danych: `SALES_LEADS_ENABLED=false` i `leads_enabled = false`. Wiersze zostają. Samo ukrycie przycisku nie wystarcza, bo RPC też sprawdza flagę w bazie.

Aplikacja i baza muszą być zgodne. Sama zmienna środowiska nie otwiera zapisu, jeśli flaga w bazie jest fałszywa. Sama flaga w bazie nie otwiera formularza w interfejsie, jeśli zmienna środowiska nie jest `true`. Oba warunki są potrzebne. Bez sekretu odcisku action też odmawia.

## 11. RPC, które 006B ma utworzyć

Wszystkie publiczne funkcje: `language plpgsql`, `security definer`, `set search_path = ''`. Po definicji `revoke all ... from public` i grant tylko jak niżej.

### `public.submit_sales_lead(idempotency_key uuid, first_name text, company_name text, email text, phone text, needs text, fingerprint_hash text) returns uuid`

Grant: `anon`, `authenticated`.

Zwraca `id`. Komunikaty wyjątków są stałymi tokenami: `sales_lead_invalid`, `sales_lead_rate_limited`, `sales_lead_unavailable`, `sales_lead_idempotency_conflict`. Nie zawierają treści zgłoszenia.

### `public.list_sales_leads(result_limit integer) returns setof public.sales_leads`

Grant: `authenticated`. Brak operatora: `sales_lead_forbidden`.

### `public.platform_operator_status() returns boolean`

Grant: `authenticated`. Brak aktywnego uprawnienia albo puste `auth.uid()` zwraca `false`. Rola `anon` nie dostaje `execute`.

### `public.grant_platform_operator(target_user uuid) returns void`

### `public.revoke_platform_operator(target_user uuid) returns void`

Grant obu: `authenticated`. Wywołujący musi być aktywnym operatorem. Grant nie przyjmuje identyfikatora wywołującego.

## 12. Testy przyszłej implementacji

### Lokalnie, PGlite, bez sieci — 006B

- migracja przechodzi na istniejącym łańcuchu i jest dopisana do listy w `tests/database-types.test.mjs`;
- `anon` i `authenticated` nie mają `select/insert/update/delete` na obu nowych tabelach publicznych;
- bezpośredni `insert` i `select` na `sales_leads` kończą się odmową dla anonima, właściciela firmy, rekrutera i viewera;
- przy `leads_enabled = true` poprawne wywołanie funkcji wstawia jeden wiersz i zwraca jego `id`;
- pusty telefon staje się `null`, zły e-mail, za długi opis i puste imię nie tworzą wiersza;
- ten sam klucz i ta sama treść zwracają to samo `id` i zostawiają jeden wiersz;
- ten sam klucz i inny opis przerywają się, a pierwotny wiersz zostaje;
- wywołanie nie tworzy `companies` ani `company_members` i nie ustawia `company_id`, bo takiej kolumny nie ma;
- anonim ma `submitted_by null`; zalogowany użytkownik ma tam własne `auth.uid()` i nadal nie ma członkostwa z tego tytułu;
- anonim nie może wywołać `list_sales_leads`;
- właściciel firmy, rekruter i viewer dostają `sales_lead_forbidden`;
- operator widzi zgłoszenie, a po `revoked_at` już nie;
- operator nie odebrałby uprawnienia ostatniemu aktywnemu samemu sobie;
- `grant_platform_operator` odrzuca UUID spoza `auth.users`;
- limity e-maila, odcisku i progu globalnego działają wewnątrz funkcji;
- `leads_enabled = false` odrzuca nowy klucz, nie tworzy zgłoszenia, nie dopisuje próby i nie kasuje starych wierszy;
- przy wyłączonej fladze ten sam klucz i ta sama znormalizowana treść nadal zwracają istniejące `id` i dopisują attempt `replay`;
- `update` i `delete` zgłoszenia są przerwane triggerem;
- komunikat wyjątku nie zawiera treści `needs`.

`npm run test:db` musi dalej przechodzić, bo zamrożony kontrakt tabel i sygnatur trzeba świadomie rozszerzyć. Nowy plik testu ma własny skrypt, dopisany do CI.

### Lokalnie, HTTP, bez prawdziwej wysyłki — 006C i 006D

- `GET /rozmowa` zwraca 200 i nie twierdzi, że termin jest zarezerwowany;
- niepoprawny POST nie zawiera potwierdzenia zapisu;
- gdy stub RPC zwróci błąd, odpowiedź nie zawiera „Zgłoszenie zostało zapisane”;
- gdy stub zapisze i zwróci id, potwierdzenie jest;
- ponowienie tego samego klucza i tej samej treści nie tworzy drugiego żądania insertu w stubie albo stub widzi ten sam klucz;
- anonimowe `GET /operator/leads` przekierowuje do `/login`;
- zalogowany nie-operator dostaje 404;
- `/`, `/demo`, `/login`, `/register`, `/forgot-password` zostają sprawne;
- anonimowe `/dashboard` i `/onboarding` nadal prowadzą do `/login`.

Wzorzec stubu: `tests/auth-mail-http.test.mjs`. Nie wysyłać wiadomości i nie używać `test:live`.

### Środowisko testowe właściciela, poza CI

Dopiero po migracji na projekcie testowym, nie produkcyjnym: dwa prawdziwe konta, właściciel firmy nie widzi `/operator/leads`, wskazany operator widzi własne zgłoszenie testowe. Ten projekt nie planuje takiego sprawdzenia jako warunku 006B.

## 13. Pliki zarezerwowane

006B, i tylko 006B, ma ruszyć pliki wypisane w prompcie Cursora.

006C, później:

- `app/rozmowa/page.tsx`
- `app/rozmowa/actions.ts`
- `app/rozmowa/lead-form.tsx`
- `app/rozmowa/rozmowa.module.css`
- `lib/sales-lead.ts`
- `app/components/marketing/home-page.tsx`
- `app/components/marketing/demo-page.tsx`
- `app/components/marketing/links.ts`
- `app/components/marketing/site-header.tsx`
- `app/components/marketing/mobile-nav.tsx`
- `app/marketing.module.css` tylko jeśli odnośnik nie mieści się w istniejących klasach
- `tests/sales-leads-http.test.mjs`
- `package.json` i `.github/workflows/checks.yml` wyłącznie o nowy skrypt
- `.env.example` wyłącznie o nazwy zmiennych, bez wartości sekretu
- `docs/sc-sales-006c-handoff.md`

006D, później:

- `app/operator/leads/page.tsx`
- `app/operator/leads/leads.module.css`
- `proxy.ts` wyłącznie dopisanie matchera `/operator/:path*`
- `tests/sales-leads-operator-http.test.mjs`
- `docs/sc-sales-006d-handoff.md`

Żaden etap nie zmienia `app/globals.css`, `app/layout.tsx`, auth, onboardingu, analizy AI ani istniejących migracji.

## 14. Otwarte kwestie

| Kwestia | Skutek |
|---|---|
| Brak UUID pierwszego operatora | Nie blokuje 006B, 006C ani 006D. Blokuje publiczne włączenie. Nie wolno go zgadywać. |
| Brak zatwierdzonej informacji o przetwarzaniu danych | Nie blokuje kodu. Blokuje ustawienie `leads_enabled = true`. |
| Brak sekretu odcisku | Nie blokuje kodu. Blokuje przyjęcie zgłoszenia, bo action ma wtedy odmówić. |
| Brak powiadomienia e-mail o nowym zgłoszeniu | Świadomy brak. Właściciel czyta `/operator/leads`. Osobne zadanie, jeśli będzie potrzebne. Nie obiecywać czasu odpowiedzi. |
| Captcha | Poza zakresem. Zostają limity z sekcji 9. |
| Etapy sprzedaży i powiązanie z firmą | SC-SALES-013. Nie dodawać kolumny `company_id` teraz. |

## 15. Decyzje podjęte w tym projekcie

- Zgłoszenie jest osobnym bytem, bez tenanta i bez fikcyjnej firmy.
- Zapis i limity są w funkcji bazy, a tabele nie mają grantów CRUD dla `anon` i `authenticated`.
- Operator jest wierszem `platform_operators`, nadawanym poza profilem firmy.
- Pierwszy operator powstaje ręcznym SQL, nie seedem migracji.
- Publiczny formularz ma adres `/rozmowa` i znany tekst przycisku.
- Potwierdzenie oznacza tylko zapis. Nie oznacza terminu.
- Wyłączenie jest flagą w bazie i zmienną środowiska, bez usuwania wierszy.
- Implementacja zaczyna się od 006B.
