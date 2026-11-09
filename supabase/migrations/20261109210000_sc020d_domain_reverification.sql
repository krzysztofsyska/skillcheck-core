-- SC-020-D — cykliczna ponowna weryfikacja DNS własnych domen firm (issue #21).
--
-- Dotąd właściciel firmy musiał co najmniej raz na `reverify_days` kliknąć
-- „Sprawdź”; inaczej domena przestawała wskazywać firmę. Ta migracja dodaje
-- osobną rolę `tenant_domain_reverifier` (NOLOGIN) i dwie funkcje wyłącznie
-- dla niej, z których korzysta zadanie cykliczne w lib/tenant-domain-reverify.ts.
-- Osobna rola, a nie `tenant_domain_verifier`: tamtą rolą posługuje się serwer
-- aplikacji po kliknięciu właściciela (record_dns_check wymaga identyfikatora
-- właściciela). Gdyby te same dane logowania mogły też wypisać domeny wszystkich
-- firm i odnowić je bez właściciela, wyciek poświadczenia aplikacji pozwalałby
-- utrzymywać porzuconą domenę przy życiu. Zadanie cykliczne dostaje więc własną
-- rolę i własny adres połączenia (TENANT_DOMAIN_REVERIFY_DATABASE_URL):
--   * tenant_domains.reverify_due(max_rows) — lista własnych domen, którym
--     zbliża się termin ponownej weryfikacji (host, token; nic więcej),
--   * tenant_domains.record_scheduled_dns_check(...) — zapis wyniku. Może
--     wyłącznie ODNOWIĆ weryfikację domeny zweryfikowanej/aktywnej, która
--     jeszcze nie wygasła, albo zapisać niepowodzenie. Domenę już wygasłą cofa
--     do `pending` (także gdy rekord jest), więc nigdy nie przywraca jej sama.
--     Nigdy nie weryfikuje domeny `pending`, nie włącza domeny, nie zmienia TLS
--     i nie dotyka domen innych firm. Zdarzenia mają actor = NULL
--     („automatycznie” w historii właściciela).
--
-- Kolejne niepowodzenia w oknie przed terminem nie zaśmiecają historii: wpis
-- 'verification_failed' (automatyczny) zapisujemy, tylko gdy ostatni wpis tej
-- domeny nie jest już takim samym wpisem.
--
-- Bez loginu dla roli, bez sekretu i bez harmonogramu: uruchomienie zadania
-- (login roli, sekret, cron) to osobna decyzja operatora/właściciela. Bez tego
-- funkcje istnieją, ale nikt ich nie woła (fail closed).
--
-- Schemat `tenant_domains` leży poza inwentarzem SC-010: migracja nie tworzy
-- ani nie zmienia relacji w 'public'/'private'. Sygnatura sprawdzana w
-- preflight i postflight.

begin;

do $preflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc020d_source_schema_unreviewed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if to_regnamespace('tenant_domains') is null then
    raise exception 'sc020d_requires_sc020b' using errcode = '55000';
  end if;
  if to_regprocedure('tenant_domains.reverify_due(integer)') is not null then
    raise exception 'sc020d_already_installed' using errcode = '55000';
  end if;
end
$preflight$;

do $role$
begin
  if not exists (select 1 from pg_roles where rolname = 'tenant_domain_reverifier') then
    create role tenant_domain_reverifier nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
  end if;
  -- Rola istniejąca wcześniej w klastrze: tylko z tymi samymi atrybutami i bez członków; inaczej odmowa
  -- (bez ALTER ROLE — na Supabase migracje nie działają jako superuser).
  if exists (select 1 from pg_roles r where r.rolname = 'tenant_domain_reverifier'
             and (r.rolcanlogin or r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolinherit or r.rolreplication or r.rolbypassrls)) then
    raise exception 'sc020d_reverifier_unexpected_attributes' using errcode = '55000';
  end if;
  -- PostgreSQL 16+: twórca bez superusera (Supabase `postgres`) dostaje automatycznie członkostwo
  -- ADMIN bez INHERIT i bez SET — to nie daje uprawnień roli. Odmawiamy przy każdym innym.
  if exists (select 1 from pg_auth_members m where m.roleid = 'tenant_domain_reverifier'::regrole
             and (m.inherit_option or m.set_option)) then
    raise exception 'sc020d_reverifier_has_members' using errcode = '55000';
  end if;
end
$role$;

-- Domeny do ponownego sprawdzenia: własne, zweryfikowane lub aktywne, których
-- ostatnia udana weryfikacja jest starsza niż max(reverify_days - 7,
-- połowa reverify_days) dni — czyli zanim wygasną. Także już wygasłe (te zadanie
-- tylko cofa do `pending`). Najstarsze najpierw.
create function tenant_domains.reverify_due(max_rows integer)
returns table (company_id uuid, domain_id uuid, hostname text, verification_token text)
language sql stable security definer set search_path = '' as $$
  select d.company_id, d.id, d.hostname, d.verification_token
    from tenant_domains.domains d, tenant_domains.settings s
   where s.singleton and d.kind = 'custom' and d.status in ('verified', 'active')
     and d.last_verified_at <= clock_timestamp() - make_interval(days => greatest(s.reverify_days - 7, ceil(s.reverify_days / 2.0)::integer))
   order by d.last_verified_at, d.id
   limit least(greatest(coalesce(max_rows, 0), 0), 500)
$$;

-- Wynik zaplanowanego sprawdzenia DNS. Token musi się zgadzać (wiersz nie
-- zmienił się od odczytu listy). Zwraca status domeny po zapisie albo
-- 'skipped', gdy domena nie kwalifikuje się już do odnowienia.
create function tenant_domains.record_scheduled_dns_check(target_company uuid, target_domain uuid, expected_token text, dns_ok boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare d tenant_domains.domains; cfg tenant_domains.settings;
begin
  if dns_ok is null or expected_token is null then raise exception 'tenant_domain_bad_check' using errcode = '22023'; end if;
  -- Ta sama kolejność blokad co record_dns_check: host (doradcza), potem wiersz.
  perform pg_advisory_xact_lock(hashtextextended('tenant_domains:' || d2.hostname, 0))
    from tenant_domains.domains d2 where d2.company_id = target_company and d2.id = target_domain;
  d := tenant_domains.lock_domain(target_company, target_domain);
  if d.verification_token is distinct from expected_token then
    raise exception 'tenant_domain_stale_check' using errcode = 'PT409';
  end if;
  if d.kind <> 'custom' or d.status not in ('verified', 'active') then
    return 'skipped';
  end if;
  select * into cfg from tenant_domains.settings s where s.singleton;
  -- Kolejne niepowodzenia w oknie przed terminem: jeden wpis, nie po jednym na przebieg.
  if not dns_ok and not exists (select 1 from (select e.action, e.actor from tenant_domains.events e
                                 where e.company_id = target_company and e.domain_id = d.id order by e.id desc limit 1) last
                  where last.action = 'verification_failed' and last.actor is null) then
    perform tenant_domains.log(target_company, d.id, 'verification_failed', null);
  end if;
  if not tenant_domains.fresh(d) then
    -- Już wygasła: zadanie NIE odnawia jej nawet przy obecnym rekordzie. Domena
    -- wraca do `pending` i wymaga sprawdzenia przez właściciela.
    update tenant_domains.domains set status = 'pending', activated_at = null, tls_ready_at = null,
      pending_expires_at = clock_timestamp() + make_interval(days => cfg.pending_days) where id = d.id;
    perform tenant_domains.log(target_company, d.id, 'verification_lapsed', null);
    return 'pending';
  end if;
  if dns_ok then
    update tenant_domains.domains set last_verified_at = clock_timestamp() where id = d.id;
    perform tenant_domains.log(target_company, d.id, 'reverified', null);
  end if;
  return d.status;
end;
$$;

do $grants$
declare fn regprocedure;
begin
  foreach fn in array array['tenant_domains.reverify_due(integer)',
                            'tenant_domains.record_scheduled_dns_check(uuid,uuid,text,boolean)']::regprocedure[] loop
    execute format('revoke all on function %s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('revoke all on function %s from service_role', fn); end if;
    execute format('revoke all on function %s from tenant_domain_verifier', fn);
    execute format('grant execute on function %s to tenant_domain_reverifier', fn);
  end loop;
end
$grants$;
grant usage on schema tenant_domains to tenant_domain_reverifier;

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc020d_final_schema_mismatch:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
end
$postflight$;

commit;
