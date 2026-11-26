# R1 — włączenie testu kompetencji na Preview (przygotowanie, 18.11.2026)

Decyzja właściciela: `docs/DECYZJE.md`, 18.11.2026 („TAK na 1 i 2”). Dotyczy wyłącznie Preview
gałęzi `integration` i bazy testowej `skillcheck-preview` (`orbyscrupgnupifzlqxp`). Produkcja bez zmian.

## Zrobione przez agenta (baza Preview)

- Login pośrednika `competency_gateway_preview` utworzony **bez możliwości logowania i bez hasła**:
  `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`, jedyne członkostwo
  `competency_test_gateway` (`INHERIT FALSE, SET TRUE`), ustawienia roli wyłączające zapis parametrów
  w logach: `log_statement=none`, `log_parameter_max_length=0`, `log_parameter_max_length_on_error=0`,
  `auto_explain.log_min_duration=-1` (wymaga tego audyt w `lib/competency-broker-role.ts`).
- Ogranicznik prób: `postgres` (funkcja `private.consume_competency_rate_limit` jest w bazie Preview) —
  bez dodatkowej usługi i bez kosztu.

## Do zrobienia przez właściciela (jedyne sekrety)

Hasło loginu i dwa klucze generuje baza, a wartości widzi tylko właściciel. Agent ich nie czyta.

1. Supabase, projekt **skillcheck-preview**, SQL Editor:
   https://supabase.com/dashboard/project/orbyscrupgnupifzlqxp/sql/new — wkleić i uruchomić (Run):

   ```sql
   select set_config('sc.pw', encode(extensions.gen_random_bytes(24), 'hex'), false);
   do $$ begin
     execute format('alter role competency_gateway_preview login password %L', current_setting('sc.pw'));
   end $$;
   select
     'postgresql://competency_gateway_preview:' || current_setting('sc.pw')
       || '@db.orbyscrupgnupifzlqxp.supabase.co:5432/postgres' as "1_COMPETENCY_BROKER_GATEWAY_DATABASE_URL",
     encode(extensions.gen_random_bytes(32), 'hex') as "2_COMPETENCY_BROKER_CSRF_KEY",
     encode(extensions.gen_random_bytes(32), 'hex') as "3_COMPETENCY_BROKER_SOURCE_HMAC_KEY";
   ```

   Wynik to jeden wiersz z trzema wartościami. Hasło nie trafia do historii zapytań (jest tworzone w bazie).
2. Vercel: https://vercel.com/krzysztofs-projects-b7ce87b5/skillcheck-core/settings/environment-variables —
   dla każdej z trzech wartości „Add New”: nazwa jak w nagłówku kolumny (bez `1_`, `2_`, `3_`),
   wartość z wyniku, środowisko **tylko Preview**, gałąź `integration`, zaznaczone **Sensitive**, Save.
3. Napisać agentowi „klucze wpisane”.

## Potem agent (bez właściciela)

- Ustawia jawne (niesekretne) zmienne tylko dla Preview `integration`: `COMPETENCY_BROKER_LIMITER=postgres`,
  `COMPETENCY_BROKER_ORIGIN` (dokładny adres HTTPS aliasu Preview `integration`), `EXERCISE_AI_ENABLED=true`,
  a po sprawdzeniu połączenia `COMPETENCY_BROKER_ENABLED=true` i `COMPETENCY_CANDIDATE_PREVIEW=true`.
- Uruchamia ponowne wdrożenie Preview `integration` i przechodzi ścieżkę R1/R2 w przeglądarce
  (`docs/checks/r1-preview-walk-2026-11-18.md`, kroki 1, 3a, 8b).

Ryzyko do sprawdzenia przy pierwszym uruchomieniu: połączenie Vercel → bezpośredni host bazy
(`db.…supabase.co:5432`). Gdy nie zadziała (odpowiedź 503), agent opisze to jako blokadę z propozycją —
bez płatnych dodatków bez zgody właściciela.

## Wykonanie (25.11.2026)

- Właściciel wpisał trzy klucze (Preview, gałąź `integration`, Sensitive) — potwierdzone w Vercel
  tylko po metadanych, bez odczytu wartości.
- Baza Preview: login `competency_gateway_preview` ma `LOGIN`, bez `SUPERUSER` i `BYPASSRLS`;
  funkcja ogranicznika `consume_competency_rate_limit` jest w bazie.
- Agent ustawił jawne zmienne tylko dla Preview `integration`: `COMPETENCY_BROKER_LIMITER=postgres`,
  `COMPETENCY_BROKER_ORIGIN=https://skillcheck-core-git-integration-krzysztofs-projects-b7ce87b5.vercel.app`,
  `EXERCISE_AI_ENABLED=true`, `COMPETENCY_BROKER_ENABLED=true`, `COMPETENCY_CANDIDATE_PREVIEW=true`.
  Produkcja bez zmian.
- Zmienne zaczynają działać od następnego wdrożenia Preview `integration` (po scaleniu PR z tą notatką).
- Połączenie Vercel → `db.orbyscrupgnupifzlqxp.supabase.co:5432` i przejście ścieżki na stronie: NOT RUN
  (wymaga nowego wdrożenia). Odpowiedź 503 z `/zadanie-kompetencyjne` = blokada sieciowa, do opisania
  z propozycją bez płatnych dodatków.

## Połączenie przez pooler sesyjny (26.11.2026)

- Przyczyna 503 (`limiter_unavailable`, `connect`): host `db.orbyscrupgnupifzlqxp.supabase.co` ma tylko adres
  IPv6, a funkcje Vercel łączą się tylko po IPv4.
- Rozwiązanie bez nowego sekretu i bez kosztów: jawna (niesekretna) zmienna
  `COMPETENCY_BROKER_GATEWAY_POOLER_HOST` = host darmowego poolera sesyjnego Supabase
  (`aws-<n>-<region>.pooler.supabase.com`). Gdy jest ustawiona, aplikacja sama zamienia w adresie z sekretu:
  host na pooler, port na 5432 (tryb sesyjny; port 6543, tryb transakcyjny, jest niedozwolony),
  użytkownika na `<rola>.<ref projektu>`. Hasło, rola i baza pochodzą nadal tylko z sekretu właściciela.
- Bezpieczeństwo: host poolera musi pasować do `^aws-[0-9]+-[a-z]{2}-[a-z]+-[0-9]+\.pooler\.supabase\.com$`,
  a host w sekrecie do `^db\.[a-z0-9]{20}\.supabase\.co$` (z niego bierzemy ref); inaczej `config_dsn` i 503.
  Kontrola roli (`session_user`) dalej oczekuje gołej nazwy roli. TLS: pełna weryfikacja certyfikatu
  i nazwy hosta, przypięty ten sam główny certyfikat Supabase co dla hosta bezpośredniego (Supabase
  dokumentuje `sslmode=verify-full` z tym certyfikatem dla hostów poolera).
- Pusta lub brak zmiennej = zachowanie jak dotąd.
- Po scaleniu (osobny przebieg agenta): ustawić zmienną tylko dla Preview `integration` (najpierw
  `aws-0-eu-west-1.pooler.supabase.com`; jeśli w logu pojawi się `connect` lub `verify_*`, spróbować
  `aws-1-eu-west-1.pooler.supabase.com`), wdrożyć ponownie i przejść ścieżkę. Produkcja bez zmian.
