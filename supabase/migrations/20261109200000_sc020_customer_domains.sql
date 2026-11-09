-- SC-020-B — domeny klienta (white-label, etap B): subdomeny i własne domeny
-- firm, weryfikacja własności przez rekord DNS TXT, gotowość TLS, cykl życia
-- pending -> verified -> active -> revoked i rozpoznawanie firmy po hoście.
--
-- Decyzja właściciela 2026-11-09 (issue #21). Bez realnych zmian DNS, zakupów
-- domen i wywołań API Vercel dodających domeny — to bramka właściciela. Ta
-- migracja tylko przechowuje roszczenia do domen i wyniki sprawdzeń.
--
-- Dlaczego osobny schemat `tenant_domains` (wzorzec 20261104080000_pricing_catalog
-- i SC-020-A `branding`): private.erasure_schema_signature() obejmuje relacje
-- w 'public' i 'private' i jest przypięta do baseline'u inwentarza usuwania
-- danych kandydatów (SC-010, R15). Domeny to dane firmy, nie kandydata. Tabele
-- nie mają kluczy obcych do public.companies (taki więz zmieniłby sygnaturę);
-- istnienie firmy i uprawnienia sprawdzają funkcje poniżej. Migracja nie
-- tworzy, nie zmienia ani nie usuwa relacji, kolumn, więzów ani wyzwalaczy w
-- 'public' lub 'private'. Sygnatura sprawdzana w preflight i postflight.
-- Migracja nie zależy od SC-020-A (działa przed i po niej).
--
-- Zasady bezpieczeństwa:
--   * Zarządzanie domenami (zgłoszenie, aktywacja, wyłączenie, odwołanie,
--     odczyt stanu i dziennika) — wyłącznie właściciel firmy
--     (private.is_company_owner; w repozytorium nie ma roli „admin”).
--   * Właściciel NIE może sam oznaczyć domeny jako zweryfikowanej ani gotowej
--     TLS. Wyniki sprawdzeń DNS/TLS zapisuje tylko rola `tenant_domain_verifier`
--     (NOLOGIN, bez dostępu do danych), używana wyłącznie przez serwer aplikacji
--     po sprawdzeniu uprawnień właściciela. Brak loginu dla tej roli = brak
--     weryfikacji (fail closed). Utworzenie loginu to decyzja operatora.
--   * Jeden host nigdy nie wskazuje dwóch firm: unikalny indeks na hoście dla
--     statusów verified/active.
--   * Każde nowe zgłoszenie (także po odwołaniu) ma nowy losowy token i musi
--     przejść weryfikację od nowa. Własna domena działa tylko, gdy ostatnia
--     udana weryfikacja DNS jest świeższa niż `reverify_days`; nieudana
--     ponowna weryfikacja po tym terminie cofa domenę do `pending`. To chroni
--     przed przejęciem „wiszącej” domeny, którą klient porzucił.
--   * Odwołana subdomena platformy jest w kwarantannie dla innych firm.
--   * Rozpoznanie hosta (anon/authenticated) zwraca wyłącznie identyfikator
--     firmy dla aktywnego, świeżo zweryfikowanego hosta; nic więcej.
--   * Dziennik zdarzeń tylko dopisywany; historia domen niezmienna poza
--     dozwolonymi przejściami statusu.
begin;

do $preflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc020b_source_schema_unreviewed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if to_regnamespace('tenant_domains') is not null then
    raise exception 'sc020b_already_installed' using errcode = '55000';
  end if;
end
$preflight$;

do $role$
begin
  if not exists (select 1 from pg_roles where rolname = 'tenant_domain_verifier') then
    create role tenant_domain_verifier nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
  end if;
end
$role$;

create schema tenant_domains;
revoke all on schema tenant_domains from public;

-- Nazwa hosta w postaci kanonicznej: małe litery ASCII (IDN jako punycode
-- xn--), etykiety 1–63 znaki bez myślnika na brzegach, co najmniej dwie
-- etykiety, TLD zaczyna się literą (wyklucza adresy IP), bez kropki na końcu,
-- bez portu. Te same reguły co lib/tenant-domains.ts.
create function tenant_domains.valid_hostname(value text) returns boolean
language sql immutable set search_path = '' as $$
  select value is not null
    and length(value) between 4 and 253
    and value ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
$$;

-- Hosty platformy i nazwy techniczne: nigdy jako własna domena klienta.
create function tenant_domains.reserved_hostname(value text) returns boolean
language sql immutable set search_path = '' as $$
  select exists (
    select 1 from unnest(array[
      'skillcheck.pl', 'skillcheck.invalid', 'vercel.app', 'vercel.com', 'vercel.dev', 'now.sh',
      'supabase.co', 'supabase.com', 'supabase.in', 'supabase.net',
      'localhost', 'local', 'internal', 'localdomain', 'home.arpa', 'arpa', 'test', 'invalid', 'example',
      'example.com', 'example.net', 'example.org', 'onion'
    ]) as suffix
    where value = suffix or right(value, length(suffix) + 1) = '.' || suffix
  )
$$;

-- Etykiety subdomen platformy zarezerwowane dla usług.
create function tenant_domains.reserved_label(value text) returns boolean
language sql immutable set search_path = '' as $$
  select value = any (array[
    'www', 'app', 'api', 'admin', 'auth', 'login', 'operator', 'dashboard', 'panel', 'mail', 'smtp',
    'imap', 'pop', 'ftp', 'ns', 'ns1', 'ns2', 'dns', 'status', 'static', 'cdn', 'assets', 'media',
    'preview', 'staging', 'dev', 'test', 'support', 'help', 'docs', 'blog', 'billing', 'pay',
    'skillcheck', 'security', 'abuse', 'postmaster', 'webmaster', 'root', 'autodiscover', 'autoconfig'
  ]) or value like 'xn--%' or value like '%--%'
$$;

-- Ustawienia (jeden wiersz). subdomain_base = NULL: subdomeny platformy
-- wyłączone (domyślnie). Ustawia je operator osobną decyzją.
create table tenant_domains.settings (
  singleton boolean primary key default true check (singleton),
  subdomain_base text check (subdomain_base is null or (tenant_domains.valid_hostname(subdomain_base))),
  reverify_days integer not null default 30 check (reverify_days between 1 and 90),
  pending_days integer not null default 7 check (pending_days between 1 and 30),
  quarantine_days integer not null default 30 check (quarantine_days between 0 and 365),
  max_domains_per_company integer not null default 5 check (max_domains_per_company between 1 and 20)
);
insert into tenant_domains.settings default values;

create table tenant_domains.domains (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  hostname text not null check (tenant_domains.valid_hostname(hostname)),
  kind text not null check (kind in ('subdomain', 'custom')),
  status text not null check (status in ('pending', 'verified', 'active', 'revoked')),
  verification_token text not null check (verification_token ~ '^[0-9a-f]{64}$'),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  pending_expires_at timestamptz,
  verified_at timestamptz,
  last_verified_at timestamptz,
  tls_ready_at timestamptz,
  activated_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text check (revoke_reason in ('owner', 'expired')),
  unique (company_id, id),
  unique (verification_token),
  check (kind <> 'custom' or not tenant_domains.reserved_hostname(hostname)),
  check ((status = 'pending') = (pending_expires_at is not null)),
  check (status not in ('verified', 'active') or (verified_at is not null and last_verified_at is not null)),
  check (status <> 'active' or (activated_at is not null and tls_ready_at is not null)),
  check ((status = 'revoked') = (revoked_at is not null and revoke_reason is not null)),
  check (revoked_by is null or status = 'revoked')
);
-- Jeden host — najwyżej jedna firma, która go zweryfikowała lub używa.
create unique index domains_one_company_per_live_host on tenant_domains.domains (hostname)
  where status in ('verified', 'active');
-- Jedna firma — najwyżej jedno otwarte zgłoszenie danego hosta.
create unique index domains_one_open_claim on tenant_domains.domains (company_id, hostname)
  where status <> 'revoked';
create index domains_company_idx on tenant_domains.domains (company_id, created_at desc);
create index domains_host_idx on tenant_domains.domains (hostname, revoked_at desc);

create table tenant_domains.events (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  domain_id uuid not null,
  action text not null check (action in (
    'claimed', 'verified', 'verification_failed', 'reverified', 'verification_lapsed', 'verification_conflict',
    'tls_ready', 'tls_failed', 'activated', 'deactivated', 'revoked', 'expired')),
  actor uuid,
  at timestamptz not null default clock_timestamp(),
  foreign key (company_id, domain_id) references tenant_domains.domains (company_id, id)
);
create index events_company_idx on tenant_domains.events (company_id, id desc);

alter table tenant_domains.settings enable row level security;
alter table tenant_domains.domains enable row level security;
alter table tenant_domains.events enable row level security;
revoke all on tenant_domains.settings, tenant_domains.domains, tenant_domains.events from public;
do $revoke$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on tenant_domains.settings, tenant_domains.domains, tenant_domains.events from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on tenant_domains.settings, tenant_domains.domains, tenant_domains.events from authenticated;
  end if;
end
$revoke$;

-- Niezmienność: dziennik tylko dopisywany; w domenach zmieniają się wyłącznie
-- pola cyklu życia i tylko dozwolonymi przejściami. Usuwanie: tylko przyszła
-- uprzywilejowana procedura usuwania firmy z set_config('tenant_domains.purge_company', '<uuid>', true).
create function tenant_domains.purge_allowed(target_company uuid) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('tenant_domains.purge_company', true), '') = target_company::text
$$;

create function tenant_domains.guard_events() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and tenant_domains.purge_allowed(old.company_id) then return old; end if;
  raise exception 'tenant_domain_history_immutable' using errcode = '42501';
end;
$$;
create trigger events_immutable before update or delete on tenant_domains.events
  for each row execute function tenant_domains.guard_events();
create trigger events_no_truncate before truncate on tenant_domains.events
  for each statement execute function tenant_domains.guard_events();

create function tenant_domains.guard_domains() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if tenant_domains.purge_allowed(old.company_id) then return old; end if;
    raise exception 'tenant_domain_history_immutable' using errcode = '42501';
  end if;
  if new.id <> old.id or new.company_id <> old.company_id or new.hostname <> old.hostname or new.kind <> old.kind
     or new.verification_token <> old.verification_token or new.created_by <> old.created_by
     or new.created_at <> old.created_at then
    raise exception 'tenant_domain_identity_immutable' using errcode = '42501';
  end if;
  if old.status = 'revoked' then
    raise exception 'tenant_domain_revoked_final' using errcode = '42501';
  end if;
  if new.status <> old.status and not (
       (old.status = 'pending' and new.status in ('verified', 'revoked'))
    or (old.status = 'verified' and new.status in ('active', 'pending', 'revoked'))
    or (old.status = 'active' and new.status in ('verified', 'pending', 'revoked'))) then
    raise exception 'tenant_domain_bad_transition' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger domains_guard before update or delete on tenant_domains.domains
  for each row execute function tenant_domains.guard_domains();
create trigger domains_no_truncate before truncate on tenant_domains.domains
  for each statement execute function tenant_domains.guard_events();

create function tenant_domains.log(target_company uuid, target_domain uuid, target_action text, target_actor uuid)
returns void language sql set search_path = '' as $$
  insert into tenant_domains.events (company_id, domain_id, action, actor)
  values (target_company, target_domain, target_action, target_actor)
$$;

-- Token weryfikacyjny: 64 znaki hex z dwóch UUID v4 (rdzeń PostgreSQL, ~244 bity losowości).
create function tenant_domains.new_token() returns text
language sql volatile set search_path = '' as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
$$;

-- Wspólne sprawdzenie: zalogowany właściciel istniejącej firmy.
create function tenant_domains.require_owner(target_company uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := auth.uid();
begin
  if caller is null or target_company is null or not private.is_company_owner(target_company) then
    raise exception 'tenant_domain_forbidden' using errcode = '42501';
  end if;
  return caller;
end;
$$;

-- Czy domena jest „świeża”: subdomena platformy zawsze, własna domena —
-- ostatnia udana weryfikacja DNS w terminie reverify_days.
create function tenant_domains.fresh(d tenant_domains.domains) returns boolean
language sql stable set search_path = '' as $$
  select d.kind = 'subdomain' or d.last_verified_at > clock_timestamp()
    - make_interval(days => (select s.reverify_days from tenant_domains.settings s where s.singleton))
$$;

-- Wygaszenie przeterminowanych zgłoszeń danej firmy (wywoływane leniwie).
create function tenant_domains.expire_pending(target_company uuid) returns void
language plpgsql set search_path = '' as $$
declare r record;
begin
  for r in update tenant_domains.domains set status = 'revoked', revoked_at = clock_timestamp(),
             revoke_reason = 'expired', pending_expires_at = null
           where company_id = target_company and status = 'pending' and pending_expires_at <= clock_timestamp()
           returning company_id, id loop
    perform tenant_domains.log(r.company_id, r.id, 'expired', null);
  end loop;
end;
$$;

-- ZGŁOSZENIE: właściciel firmy. Własna domena -> pending z nowym tokenem.
-- Subdomena platformy (gdy subdomain_base ustawione) -> verified od razu
-- (strefę DNS kontroluje platforma), ale aktywacja nadal wymaga TLS.
create function public.tenant_domain_claim(target_company uuid, target_hostname text, target_kind text)
returns table (domain_id uuid, status text, verification_token text)
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := tenant_domains.require_owner(target_company);
  cfg tenant_domains.settings;
  label text;
  open_count integer;
  claimed tenant_domains.domains;
begin
  if target_kind is null or target_kind not in ('subdomain', 'custom') then
    raise exception 'tenant_domain_invalid_kind' using errcode = '22023';
  end if;
  if not tenant_domains.valid_hostname(target_hostname) then
    raise exception 'tenant_domain_invalid_hostname' using errcode = '22023';
  end if;
  select * into cfg from tenant_domains.settings s where s.singleton;
  perform pg_advisory_xact_lock(hashtextextended('tenant_domains:' || target_hostname, 0));
  perform pg_advisory_xact_lock(hashtextextended('tenant_domains:company:' || target_company::text, 0));
  perform tenant_domains.expire_pending(target_company);
  if target_kind = 'custom' then
    if tenant_domains.reserved_hostname(target_hostname)
       or (cfg.subdomain_base is not null and (target_hostname = cfg.subdomain_base
           or right(target_hostname, length(cfg.subdomain_base) + 1) = '.' || cfg.subdomain_base)) then
      raise exception 'tenant_domain_reserved' using errcode = '22023';
    end if;
  else
    if cfg.subdomain_base is null then
      raise exception 'tenant_domain_subdomains_disabled' using errcode = '55000';
    end if;
    if right(target_hostname, length(cfg.subdomain_base) + 1) <> '.' || cfg.subdomain_base then
      raise exception 'tenant_domain_invalid_hostname' using errcode = '22023';
    end if;
    label := left(target_hostname, length(target_hostname) - length(cfg.subdomain_base) - 1);
    if position('.' in label) > 0 or length(label) < 3 or tenant_domains.reserved_label(label) then
      raise exception 'tenant_domain_reserved' using errcode = '22023';
    end if;
    if exists (select 1 from tenant_domains.domains d where d.hostname = target_hostname and d.company_id <> target_company
               and (d.status <> 'revoked'
                    or d.revoked_at > clock_timestamp() - make_interval(days => cfg.quarantine_days))) then
      raise exception 'tenant_domain_taken' using errcode = '23505';
    end if;
  end if;
  if exists (select 1 from tenant_domains.domains d where d.company_id = target_company
             and d.hostname = target_hostname and d.status <> 'revoked') then
    raise exception 'tenant_domain_already_claimed' using errcode = '23505';
  end if;
  select count(*) into open_count from tenant_domains.domains d
    where d.company_id = target_company and d.status <> 'revoked';
  if open_count >= cfg.max_domains_per_company then
    raise exception 'tenant_domain_limit' using errcode = '54000';
  end if;
  insert into tenant_domains.domains (company_id, hostname, kind, status, verification_token, created_by,
                                      pending_expires_at, verified_at, last_verified_at)
  values (target_company, target_hostname, target_kind,
          case when target_kind = 'subdomain' then 'verified' else 'pending' end,
          tenant_domains.new_token(), caller,
          case when target_kind = 'custom' then clock_timestamp() + make_interval(days => cfg.pending_days) end,
          case when target_kind = 'subdomain' then clock_timestamp() end,
          case when target_kind = 'subdomain' then clock_timestamp() end)
  returning * into claimed;
  perform tenant_domains.log(target_company, claimed.id, 'claimed', caller);
  if claimed.status = 'verified' then perform tenant_domains.log(target_company, claimed.id, 'verified', caller); end if;
  return query select claimed.id, claimed.status, claimed.verification_token;
end;
$$;

-- Wczytanie domeny firmy pod blokadą wiersza (do zmian statusu).
create function tenant_domains.lock_domain(target_company uuid, target_domain uuid) returns tenant_domains.domains
language plpgsql set search_path = '' as $$
declare hit tenant_domains.domains;
begin
  select * into hit from tenant_domains.domains d
    where d.company_id = target_company and d.id = target_domain for update;
  if hit.id is null then
    raise exception 'tenant_domain_not_found' using errcode = 'P0002';
  end if;
  return hit;
end;
$$;

-- AKTYWACJA: właściciel. Tylko zweryfikowana, świeża domena z gotowym TLS.
create function public.tenant_domain_activate(target_company uuid, target_domain uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare caller uuid := tenant_domains.require_owner(target_company); d tenant_domains.domains;
begin
  d := tenant_domains.lock_domain(target_company, target_domain);
  if d.status = 'active' then return 'active'; end if;
  if d.status <> 'verified' or d.tls_ready_at is null or not tenant_domains.fresh(d) then
    raise exception 'tenant_domain_not_ready' using errcode = '55000';
  end if;
  update tenant_domains.domains set status = 'active', activated_at = clock_timestamp() where id = d.id;
  perform tenant_domains.log(target_company, d.id, 'activated', caller);
  return 'active';
end;
$$;

-- WYŁĄCZENIE: właściciel. active -> verified (host przestaje wskazywać firmę).
create function public.tenant_domain_deactivate(target_company uuid, target_domain uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare caller uuid := tenant_domains.require_owner(target_company); d tenant_domains.domains;
begin
  d := tenant_domains.lock_domain(target_company, target_domain);
  if d.status <> 'active' then raise exception 'tenant_domain_not_active' using errcode = '55000'; end if;
  update tenant_domains.domains set status = 'verified', activated_at = null where id = d.id;
  perform tenant_domains.log(target_company, d.id, 'deactivated', caller);
  return 'verified';
end;
$$;

-- ODWOŁANIE: właściciel. Ostateczne; ponowne użycie hosta = nowe zgłoszenie
-- z nowym tokenem i pełną weryfikacją.
create function public.tenant_domain_revoke(target_company uuid, target_domain uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare caller uuid := tenant_domains.require_owner(target_company); d tenant_domains.domains;
begin
  d := tenant_domains.lock_domain(target_company, target_domain);
  if d.status = 'revoked' then return 'revoked'; end if;
  update tenant_domains.domains set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = caller,
    revoke_reason = 'owner', pending_expires_at = null, activated_at = null where id = d.id;
  perform tenant_domains.log(target_company, d.id, 'revoked', caller);
  return 'revoked';
end;
$$;

-- STAN dla panelu: domeny, ustawienia potrzebne do instrukcji i dziennik. Tylko właściciel.
create function public.tenant_domain_state(target_company uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare caller uuid := tenant_domains.require_owner(target_company); cfg tenant_domains.settings;
begin
  perform tenant_domains.expire_pending(target_company);
  select * into cfg from tenant_domains.settings s where s.singleton;
  return jsonb_build_object(
    'subdomain_base', cfg.subdomain_base,
    'reverify_days', cfg.reverify_days,
    'domains', coalesce((select jsonb_agg(jsonb_build_object(
        'id', d.id, 'hostname', d.hostname, 'kind', d.kind, 'status', d.status,
        'verification_token', case when d.status <> 'revoked' then d.verification_token end,
        'created_at', d.created_at, 'pending_expires_at', d.pending_expires_at,
        'verified_at', d.verified_at, 'last_verified_at', d.last_verified_at, 'fresh', tenant_domains.fresh(d),
        'tls_ready_at', d.tls_ready_at, 'activated_at', d.activated_at,
        'revoked_at', d.revoked_at, 'revoke_reason', d.revoke_reason) order by d.created_at desc)
      from tenant_domains.domains d where d.company_id = target_company), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('domain_id', e.domain_id, 'action', e.action,
        'by_owner', e.actor is not null, 'at', e.at) order by e.id desc)
      from (select * from tenant_domains.events e where e.company_id = target_company order by e.id desc limit 50) e), '[]'::jsonb));
end;
$$;

-- ROZPOZNANIE HOSTA (proxy): anon/authenticated. Tylko identyfikator firmy
-- dla aktywnego, świeżego hosta; inaczej NULL. Wejście musi być kanoniczne.
create function public.tenant_domain_resolve(target_host text)
returns uuid language sql stable security definer set search_path = '' as $$
  select d.company_id from tenant_domains.domains d
   where tenant_domains.valid_hostname(target_host) and d.hostname = target_host
     and d.status = 'active' and tenant_domains.fresh(d)
   limit 1
$$;

-- WERYFIKATOR (tylko rola tenant_domain_verifier, serwer aplikacji po
-- sprawdzeniu właściciela). Cel sprawdzenia: host, token i status.
create function tenant_domains.verifier_target(target_company uuid, target_domain uuid)
returns table (hostname text, kind text, status text, verification_token text)
language plpgsql security definer set search_path = '' as $$
begin
  perform tenant_domains.expire_pending(target_company);
  return query select d.hostname, d.kind, d.status, d.verification_token from tenant_domains.domains d
    where d.company_id = target_company and d.id = target_domain and d.status <> 'revoked';
end;
$$;

-- Sprawdzenie zleca właściciel firmy (serwer potwierdził to klientem RLS);
-- weryfikator przekazuje jego identyfikator do dziennika. Inny identyfikator = odmowa.
create function tenant_domains.require_acting_owner(target_company uuid, acting_owner uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if acting_owner is null or not exists (select 1 from public.companies c where c.id = target_company and c.owner_id = acting_owner) then
    raise exception 'tenant_domain_forbidden' using errcode = '42501';
  end if;
end;
$$;

-- Wynik sprawdzenia DNS TXT. Token musi się zgadzać (wiersz nie zmienił się
-- od odczytu celu). Zwraca nowy status albo 'conflict', gdy host ma już
-- inna firma (nic nie zmienia).
create function tenant_domains.record_dns_check(target_company uuid, target_domain uuid, expected_token text, dns_ok boolean, acting_owner uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare d tenant_domains.domains; cfg tenant_domains.settings; stale record;
begin
  if dns_ok is null then raise exception 'tenant_domain_bad_check' using errcode = '22023'; end if;
  perform tenant_domains.require_acting_owner(target_company, acting_owner);
  -- Kolejność blokad: najpierw host (blokada doradcza), potem wiersz — tak samo
  -- dla każdej firmy, więc równoległe sprawdzenia tego hosta się nie zakleszczą.
  perform pg_advisory_xact_lock(hashtextextended('tenant_domains:' || d2.hostname, 0))
    from tenant_domains.domains d2 where d2.company_id = target_company and d2.id = target_domain;
  perform tenant_domains.expire_pending(target_company);
  d := tenant_domains.lock_domain(target_company, target_domain);
  if expected_token is null or d.verification_token is distinct from expected_token or d.status = 'revoked' then
    raise exception 'tenant_domain_stale_check' using errcode = 'PT409';
  end if;
  select * into cfg from tenant_domains.settings s where s.singleton;
  if d.kind = 'subdomain' then return d.status; end if;
  if dns_ok then
    if d.status = 'pending' then
      -- Inna firma trzymająca host z NIEświeżą weryfikacją (porzucona domena)
      -- nie blokuje bieżącego właściciela DNS: jej wpis wraca do pending.
      for stale in update tenant_domains.domains o set status = 'pending', activated_at = null, tls_ready_at = null,
                     pending_expires_at = clock_timestamp() + make_interval(days => cfg.pending_days)
                   where o.hostname = d.hostname and o.id <> d.id and o.kind = 'custom'
                     and o.status in ('verified', 'active') and not tenant_domains.fresh(o)
                   returning o.company_id, o.id loop
        perform tenant_domains.log(stale.company_id, stale.id, 'verification_lapsed', null);
      end loop;
      if exists (select 1 from tenant_domains.domains o where o.hostname = d.hostname and o.id <> d.id
                 and o.status in ('verified', 'active')) then
        perform tenant_domains.log(target_company, d.id, 'verification_conflict', acting_owner);
        return 'conflict';
      end if;
      update tenant_domains.domains set status = 'verified', pending_expires_at = null,
        verified_at = clock_timestamp(), last_verified_at = clock_timestamp() where id = d.id;
      perform tenant_domains.log(target_company, d.id, 'verified', acting_owner);
      return 'verified';
    end if;
    update tenant_domains.domains set last_verified_at = clock_timestamp() where id = d.id;
    perform tenant_domains.log(target_company, d.id, 'reverified', acting_owner);
    return d.status;
  end if;
  perform tenant_domains.log(target_company, d.id, 'verification_failed', acting_owner);
  if d.status in ('verified', 'active') and not tenant_domains.fresh(d) then
    -- Weryfikacja wygasła i nie da się jej odnowić: host przestaje wskazywać
    -- firmę i wymaga ponownej weryfikacji (ochrona przed wiszącą domeną).
    update tenant_domains.domains set status = 'pending', activated_at = null, tls_ready_at = null,
      pending_expires_at = clock_timestamp() + make_interval(days => cfg.pending_days) where id = d.id;
    perform tenant_domains.log(target_company, d.id, 'verification_lapsed', acting_owner);
    return 'pending';
  end if;
  return d.status;
end;
$$;

-- Wynik sprawdzenia TLS. Gotowość zapisywana tylko dla domeny zweryfikowanej
-- lub aktywnej; niepowodzenie zdejmuje gotowość tylko z nieaktywnej domeny
-- (aktywnej nie wyłącza pojedynczy błąd sieci — tylko dziennik).
create function tenant_domains.record_tls_check(target_company uuid, target_domain uuid, expected_token text, tls_ok boolean, acting_owner uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare d tenant_domains.domains;
begin
  if tls_ok is null then raise exception 'tenant_domain_bad_check' using errcode = '22023'; end if;
  perform tenant_domains.require_acting_owner(target_company, acting_owner);
  d := tenant_domains.lock_domain(target_company, target_domain);
  if expected_token is null or d.verification_token is distinct from expected_token or d.status = 'revoked' then
    raise exception 'tenant_domain_stale_check' using errcode = 'PT409';
  end if;
  if d.status not in ('verified', 'active') then
    raise exception 'tenant_domain_not_verified' using errcode = '55000';
  end if;
  if tls_ok then
    update tenant_domains.domains set tls_ready_at = clock_timestamp() where id = d.id;
    perform tenant_domains.log(target_company, d.id, 'tls_ready', acting_owner);
  else
    if d.status = 'verified' then update tenant_domains.domains set tls_ready_at = null where id = d.id; end if;
    perform tenant_domains.log(target_company, d.id, 'tls_failed', acting_owner);
  end if;
  return d.status;
end;
$$;

-- Uprawnienia. Domyślnie PUBLIC ma EXECUTE na nowych funkcjach — odbieramy
-- wszystko i nadajemy wyłącznie to, co potrzebne.
do $grants$
declare fn regprocedure;
begin
  for fn in select p.oid::regprocedure from pg_proc p where p.pronamespace = 'tenant_domains'::regnamespace loop
    execute format('revoke all on function %s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('revoke all on function %s from service_role', fn); end if;
  end loop;
  for fn in select unnest(array[
      'public.tenant_domain_claim(uuid,text,text)', 'public.tenant_domain_activate(uuid,uuid)',
      'public.tenant_domain_deactivate(uuid,uuid)', 'public.tenant_domain_revoke(uuid,uuid)',
      'public.tenant_domain_state(uuid)', 'public.tenant_domain_resolve(text)']::regprocedure[]) loop
    execute format('revoke all on function %s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('revoke all on function %s from service_role', fn); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', fn); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function public.tenant_domain_resolve(text) to anon;
  end if;
end
$grants$;
grant usage on schema tenant_domains to tenant_domain_verifier;
grant execute on function tenant_domains.verifier_target(uuid, uuid) to tenant_domain_verifier;
grant execute on function tenant_domains.record_dns_check(uuid, uuid, text, boolean, uuid) to tenant_domain_verifier;
grant execute on function tenant_domains.record_tls_check(uuid, uuid, text, boolean, uuid) to tenant_domain_verifier;

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc020b_final_schema_mismatch:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
end
$postflight$;

commit;
