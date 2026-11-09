-- SC-020-A — wersjonowana konfiguracja marki firmy (white-label, etap A).
--
-- Decyzja właściciela 2026-11-09 (issue #21): w interfejsach objętych
-- white-label wyłącznie własna marka klienta, bez przełącznika na SkillCheck.
-- Informacje wymagane prawem (administrator danych, operator platformy) nie są
-- częścią tej konfiguracji i klient nie może ich zmienić.
--
-- Dlaczego osobny schemat `branding`, a nie `public`/`private` (wzorzec z
-- 20261104080000_pricing_catalog.sql): private.erasure_schema_signature()
-- obejmuje relacje w 'public' i 'private' (oraz więzy, które się do nich
-- odwołują) i jest przypięta do baseline'u inwentarza usuwania danych
-- kandydatów (SC-010, R15). Konfiguracja marki to dane firmy, nie kandydata,
-- więc nie należy do tego inwentarza. Dlatego tabele `branding.*` NIE mają
-- kluczy obcych do public.companies (taki więz zmieniłby sygnaturę); firmę
-- i uprawnienia sprawdzają wyłącznie funkcje poniżej. Ta migracja nie tworzy,
-- nie zmienia ani nie usuwa żadnej relacji, kolumny, więzu ani wyzwalacza w
-- 'public' lub 'private'; dodaje jedynie funkcje. Sygnatura SC-010 pozostaje
-- niezmieniona (sprawdzane w preflight i postflight).
--
-- Dostęp: schemat `branding` nie jest widoczny dla anon/authenticated. Jedyna
-- droga z przeglądarki/serwera to funkcje public.brand_* (security definer):
--   * edycja szkicu, publikacja, przywrócenie wersji, rejestracja pliku —
--     wyłącznie właściciel firmy (private.is_company_owner);
--   * odczyt opublikowanej wersji — każdy członek firmy (has_company_access);
--   * historia i szkic — wyłącznie właściciel firmy.
-- Pliki (logo, favicon) leżą w Supabase Storage, w prywatnym koszyku
-- `brand-assets`, pod ścieżką `<company_id>/<logo|favicon>/<uuid>.<ext>`.
-- Polityki RLS na storage.objects: zapis tylko właściciel firmy do folderu
-- swojej firmy, odczyt tylko członkowie tej firmy, brak nadpisywania i usuwania.
-- Zawartość pliku jest walidowana na serwerze przed zapisem i ponownie przy
-- każdym serwowaniu (lib/brand-config.ts), więc ominięcie walidacji przez
-- bezpośredni zapis do Storage nie prowadzi do wyświetlenia pliku.
-- Koszyk przyjmuje WYŁĄCZNIE typ application/octet-stream: Storage nigdy nie
-- serwuje stąd obrazu ani SVG jako treści wykonywalnej, nawet przez podpisany
-- lub uwierzytelniony adres. Prawdziwy typ ustala trasa aplikacji po walidacji.
-- Zasada: aplikacja nie wydaje przeglądarkom surowych adresów Storage tego
-- koszyka (żadnych signed URL); pliki idą tylko przez trasę
-- /dashboard/<firma>/marka/zasob/<plik>.
-- Limity: 50 zarejestrowanych plików na firmę (brand_register_asset) i 60
-- obiektów na firmę w koszyku (polityka zapisu), 512 KB na obiekt.
-- Usuwanie: historia jest niezmienna dla wszystkich ról. Jedyny wyjątek to
-- przyszła, uprzywilejowana procedura usuwania firmy, która w tej samej
-- transakcji ustawi set_config('branding.purge_company', '<uuid firmy>', true);
-- wtedy wyzwalacze pozwalają usunąć wiersze tylko tej firmy. Nic w tej
-- migracji tego nie robi.
begin;

do $preflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc020_source_schema_unreviewed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
  if to_regnamespace('branding') is not null then
    raise exception 'sc020_already_installed' using errcode = '55000';
  end if;
end
$preflight$;

create schema branding;
revoke all on schema branding from public;

-- Zarejestrowane pliki marki. Niezmienne po zapisie.
create table branding.assets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  kind text not null check (kind in ('logo', 'favicon')),
  object_path text not null unique check (length(object_path) <= 200),
  mime text not null check (mime in ('image/png', 'image/svg+xml', 'image/x-icon', 'image/webp')),
  byte_size integer not null check (byte_size between 1 and 524288),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (company_id, id),
  check (kind <> 'favicon' or byte_size <= 131072),
  check (kind <> 'logo' or mime <> 'image/x-icon')
);

-- Wersje konfiguracji. Jeden szkic na firmę (edytowalny), co najwyżej jedna
-- wersja opublikowana; wersje opublikowane są niezmienne (poza przejściem
-- published -> superseded). Przywrócenie tworzy NOWĄ wersję opublikowaną z
-- treścią wskazanej wersji, więc historia jest tylko dopisywana.
create table branding.versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  status text not null check (status in ('draft', 'published', 'superseded')),
  version_no integer check (version_no between 1 and 1000000),
  config jsonb not null check (pg_column_size(config) <= 8192),
  logo_asset_id uuid,
  favicon_asset_id uuid,
  rolled_back_from uuid,
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_by uuid not null,
  updated_at timestamptz not null default clock_timestamp(),
  published_by uuid,
  published_at timestamptz,
  unique (company_id, id),
  unique (company_id, version_no),
  check ((status = 'draft') = (version_no is null)),
  check ((status = 'draft') = (published_at is null)),
  check ((published_at is null) = (published_by is null)),
  check (rolled_back_from is null or status <> 'draft'),
  foreign key (company_id, logo_asset_id) references branding.assets (company_id, id),
  foreign key (company_id, favicon_asset_id) references branding.assets (company_id, id),
  foreign key (company_id, rolled_back_from) references branding.versions (company_id, id)
);
create unique index versions_one_draft on branding.versions (company_id) where status = 'draft';
create unique index versions_one_published on branding.versions (company_id) where status = 'published';

-- Dziennik zmian: kto i kiedy. Tylko dopisywanie.
create table branding.events (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  version_id uuid,
  asset_id uuid,
  action text not null check (action in ('asset_registered', 'draft_saved', 'published', 'rolled_back')),
  actor uuid not null,
  at timestamptz not null default clock_timestamp(),
  foreign key (company_id, version_id) references branding.versions (company_id, id),
  foreign key (company_id, asset_id) references branding.assets (company_id, id),
  check ((action = 'asset_registered') = (asset_id is not null)),
  check ((action = 'asset_registered') = (version_id is null))
);
create index events_company_idx on branding.events (company_id, id desc);

alter table branding.assets enable row level security;
alter table branding.versions enable row level security;
alter table branding.events enable row level security;
revoke all on branding.assets, branding.versions, branding.events from public;
do $revoke$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on branding.assets, branding.versions, branding.events from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on branding.assets, branding.versions, branding.events from authenticated;
  end if;
end
$revoke$;

create function branding.purge_allowed(target_company uuid) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('branding.purge_company', true), '') = target_company::text
$$;
revoke all on function branding.purge_allowed(uuid) from public;

create function branding.guard_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and branding.purge_allowed(old.company_id) then
    return old;
  end if;
  raise exception 'brand_history_immutable' using errcode = '42501';
end;
$$;
create trigger immutable_assets before update or delete on branding.assets
  for each row execute function branding.guard_immutable();
create trigger immutable_events before update or delete on branding.events
  for each row execute function branding.guard_immutable();

create function branding.guard_version() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if branding.purge_allowed(old.company_id) then
      return old;
    end if;
    raise exception 'brand_history_immutable' using errcode = '42501';
  end if;
  if new.id <> old.id or new.company_id <> old.company_id or new.created_by <> old.created_by
     or new.created_at <> old.created_at then
    raise exception 'brand_history_immutable' using errcode = '42501';
  end if;
  if old.status = 'draft' then
    return new;
  end if;
  if old.status = 'published' and new.status = 'superseded'
     and row(new.version_no, new.config, new.logo_asset_id, new.favicon_asset_id, new.rolled_back_from,
             new.updated_by, new.updated_at, new.published_by, new.published_at)
       is not distinct from
         row(old.version_no, old.config, old.logo_asset_id, old.favicon_asset_id, old.rolled_back_from,
             old.updated_by, old.updated_at, old.published_by, old.published_at) then
    return new;
  end if;
  raise exception 'brand_history_immutable' using errcode = '42501';
end;
$$;
create trigger guard_versions before update or delete on branding.versions
  for each row execute function branding.guard_version();
revoke all on function branding.guard_immutable(), branding.guard_version() from public;

-- Ścieżka obiektu w Storage -> firma. Null dla każdej innej postaci, więc
-- polityki nie rzucają błędem rzutowania na obcych ścieżkach.
create function private.brand_object_company(object_name text) returns uuid
language sql immutable set search_path = '' as $$
  select case when object_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(logo|favicon)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|svg|ico|webp)$'
    then substr(object_name, 1, 36)::uuid end
$$;
revoke all on function private.brand_object_company(text) from public;

-- Limit obiektów firmy w koszyku dla polityki zapisu (polityka sama nie może
-- policzyć wierszy tej samej tabeli bez RLS). Bez Storage: false. Tylko dla
-- właściciela tej firmy (nie ujawnia stanu cudzych firm) i pod tą samą blokadą
-- doradczą co rejestracja, więc równoległe zapisy nie przekroczą limitu.
create function private.brand_storage_quota_ok(object_name text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare company uuid := private.brand_object_company(object_name); total bigint;
begin
  if company is null or to_regclass('storage.objects') is null or not private.is_company_owner(company) then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sc020:' || company::text, 0));
  execute 'select count(*) from storage.objects where bucket_id = $1 and name like $2'
    into total using 'brand-assets', company::text || '/%';
  return total < 60;
end;
$$;
revoke all on function private.brand_storage_quota_ok(text) from public;

-- Kontrast WCAG 2.x dla dwóch kolorów #rrggbb.
create function private.brand_luminance(hex text) returns double precision
language plpgsql immutable set search_path = '' as $$
declare
  channel double precision;
  total double precision := 0;
  weights double precision[] := array[0.2126, 0.7152, 0.0722];
  i integer;
begin
  for i in 0..2 loop
    channel := ('x' || substr(hex, 2 + i * 2, 2))::bit(8)::integer / 255.0;
    channel := case when channel <= 0.04045 then channel / 12.92 else power((channel + 0.055) / 1.055, 2.4) end;
    total := total + weights[i + 1] * channel;
  end loop;
  return total;
end;
$$;
create function private.brand_contrast(a text, b text) returns double precision
language sql immutable set search_path = '' as $$
  select (greatest(private.brand_luminance(a), private.brand_luminance(b)) + 0.05)
       / (least(private.brand_luminance(a), private.brand_luminance(b)) + 0.05)
$$;
revoke all on function private.brand_luminance(text), private.brand_contrast(text, text) from public;

-- Walidacja konfiguracji. Te same reguły co parseBrandConfig() w
-- lib/brand-config.ts; baza jest ostateczną granicą.
create function private.brand_valid_text(value jsonb, min_len integer, max_len integer) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(value) = 'string'
    and length(btrim(value #>> '{}')) between min_len and max_len
    and (value #>> '{}') = btrim(value #>> '{}')
    and (value #>> '{}') !~ '[\x01-\x1f\x7f-\x9f<>]'
$$;
create function private.brand_validate_config(config jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  colors jsonb := config -> 'colors';
  recruiter jsonb := config -> 'recruiterPanel';
  candidate jsonb := config -> 'candidatePanel';
  key text;
begin
  if jsonb_typeof(config) is distinct from 'object'
     or (select array_agg(k order by k) from jsonb_object_keys(config) k) is distinct from array['brandName', 'candidatePanel', 'colors', 'recruiterPanel']
     or not private.brand_valid_text(config -> 'brandName', 1, 80)
     or jsonb_typeof(colors) is distinct from 'object'
     or (select array_agg(k order by k) from jsonb_object_keys(colors) k) is distinct from array['accent', 'background', 'onPrimary', 'primary', 'text']
     or jsonb_typeof(recruiter) is distinct from 'object'
     or (select array_agg(k order by k) from jsonb_object_keys(recruiter) k) is distinct from array['headerStyle']
     or coalesce(recruiter ->> 'headerStyle', '') not in ('primary', 'light')
     or jsonb_typeof(recruiter -> 'headerStyle') is distinct from 'string'
     or jsonb_typeof(candidate) is distinct from 'object'
     or (select array_agg(k order by k) from jsonb_object_keys(candidate) k) is distinct from array['headline', 'intro']
     or not private.brand_valid_text(candidate -> 'headline', 1, 120)
     or not (candidate -> 'intro' = '""'::jsonb or private.brand_valid_text(candidate -> 'intro', 1, 600)) then
    raise exception 'brand_config_invalid' using errcode = '22023';
  end if;
  foreach key in array array['accent', 'background', 'onPrimary', 'primary', 'text'] loop
    if jsonb_typeof(colors -> key) is distinct from 'string' or (colors ->> key) !~ '^#[0-9a-f]{6}$' then
      raise exception 'brand_color_invalid' using errcode = '22023';
    end if;
  end loop;
  if private.brand_contrast(colors ->> 'text', colors ->> 'background') < 4.5
     or private.brand_contrast(colors ->> 'onPrimary', colors ->> 'primary') < 4.5
     or private.brand_contrast(colors ->> 'primary', colors ->> 'background') < 4.5
     or private.brand_contrast(colors ->> 'accent', colors ->> 'background') < 3 then
    raise exception 'brand_contrast_insufficient' using errcode = '22023';
  end if;
  return config;
end;
$$;
revoke all on function private.brand_valid_text(jsonb, integer, integer), private.brand_validate_config(jsonb) from public;

create function private.brand_require_owner(target_company uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or target_company is null or not private.is_company_owner(target_company) then
    raise exception 'brand_forbidden' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.brand_require_owner(uuid) from public;

create function private.brand_check_asset(target_company uuid, asset uuid, expected_kind text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if asset is not null and not exists (
    select 1 from branding.assets a where a.id = asset and a.company_id = target_company and a.kind = expected_kind) then
    raise exception 'brand_asset_invalid' using errcode = '22023';
  end if;
end;
$$;
revoke all on function private.brand_check_asset(uuid, uuid, text) from public;

-- Rejestracja pliku już zapisanego w Storage przez właściciela (serwer
-- najpierw waliduje zawartość, potem zapisuje, potem rejestruje).
create function public.brand_register_asset(target_company uuid, asset_kind text, object_path text,
  asset_mime text, asset_size integer, asset_sha256 text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  saved uuid;
  ext text := substring(object_path from '\.([a-z]+)$');
  stored_size bigint;
  stored_owner text;
  stored_mime text;
  expected_mime text;
  size_limit integer;
begin
  perform private.brand_require_owner(target_company);
  expected_mime := case ext when 'png' then 'image/png' when 'svg' then 'image/svg+xml'
                            when 'ico' then 'image/x-icon' when 'webp' then 'image/webp' end;
  size_limit := case asset_kind when 'logo' then 524288 else 131072 end;
  if private.brand_object_company(object_path) is distinct from target_company
     or asset_kind not in ('logo', 'favicon')
     or split_part(object_path, '/', 2) is distinct from asset_kind
     or expected_mime is null or asset_mime is distinct from expected_mime
     or (asset_kind = 'logo' and asset_mime = 'image/x-icon')
     or asset_size is null or asset_size < 1 or asset_size > size_limit
     or asset_sha256 is null or asset_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'brand_asset_invalid' using errcode = '22023';
  end if;
  -- Obiekt musi istnieć w prywatnym koszyku, mieć zadeklarowany rozmiar i
  -- należeć do wywołującego. Bez Storage (np. goły PostgreSQL) — odmowa.
  if to_regclass('storage.objects') is null then
    raise exception 'brand_storage_unavailable' using errcode = '55000';
  end if;
  execute 'select (metadata ->> ''size'')::bigint, owner_id, metadata ->> ''mimetype'' from storage.objects where bucket_id = $1 and name = $2'
    into stored_size, stored_owner, stored_mime using 'brand-assets', object_path;
  if stored_size is distinct from asset_size or stored_owner is distinct from auth.uid()::text
     or stored_mime is distinct from 'application/octet-stream' then
    raise exception 'brand_asset_invalid' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sc020:' || target_company::text, 0));
  if (select count(*) from branding.assets where company_id = target_company) >= 50 then
    raise exception 'brand_asset_limit' using errcode = '54000';
  end if;
  insert into branding.assets (company_id, kind, object_path, mime, byte_size, sha256, created_by)
    values (target_company, asset_kind, object_path, asset_mime, asset_size, asset_sha256, auth.uid())
    returning id into saved;
  insert into branding.events (company_id, asset_id, action, actor) values (target_company, saved, 'asset_registered', auth.uid());
  return saved;
exception when unique_violation then
  raise exception 'brand_asset_invalid' using errcode = '22023';
end;
$$;

create function public.brand_save_draft(target_company uuid, draft_config jsonb, logo uuid, favicon uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare saved uuid;
begin
  perform private.brand_require_owner(target_company);
  perform private.brand_validate_config(draft_config);
  perform private.brand_check_asset(target_company, logo, 'logo');
  perform private.brand_check_asset(target_company, favicon, 'favicon');
  perform pg_advisory_xact_lock(hashtextextended('sc020:' || target_company::text, 0));
  update branding.versions
     set config = draft_config, logo_asset_id = logo, favicon_asset_id = favicon,
         updated_by = auth.uid(), updated_at = clock_timestamp()
   where company_id = target_company and status = 'draft'
   returning id into saved;
  if saved is null then
    insert into branding.versions (company_id, status, config, logo_asset_id, favicon_asset_id, created_by, updated_by)
      values (target_company, 'draft', draft_config, logo, favicon, auth.uid(), auth.uid())
      returning id into saved;
  end if;
  insert into branding.events (company_id, version_id, action, actor) values (target_company, saved, 'draft_saved', auth.uid());
  return saved;
end;
$$;

-- Publikuje bieżący szkic. expected_draft chroni przed publikacją szkicu
-- zmienionego w innej karcie po wyświetleniu podglądu.
create function public.brand_publish_draft(target_company uuid, expected_draft uuid, expected_updated_at timestamptz)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare d branding.versions; next_no integer;
begin
  perform private.brand_require_owner(target_company);
  perform pg_advisory_xact_lock(hashtextextended('sc020:' || target_company::text, 0));
  select * into d from branding.versions where company_id = target_company and status = 'draft' for update;
  if d.id is null or d.id is distinct from expected_draft or d.updated_at is distinct from expected_updated_at then
    raise exception 'brand_draft_changed' using errcode = 'PT409';
  end if;
  perform private.brand_validate_config(d.config);
  perform private.brand_check_asset(target_company, d.logo_asset_id, 'logo');
  perform private.brand_check_asset(target_company, d.favicon_asset_id, 'favicon');
  select coalesce(max(version_no), 0) + 1 into next_no from branding.versions where company_id = target_company;
  update branding.versions set status = 'superseded' where company_id = target_company and status = 'published';
  update branding.versions
     set status = 'published', version_no = next_no, published_by = auth.uid(), published_at = clock_timestamp()
   where id = d.id;
  insert into branding.events (company_id, version_id, action, actor) values (target_company, d.id, 'published', auth.uid());
  return d.id;
end;
$$;

-- Przywraca dowolną wcześniej opublikowaną wersję jako nową wersję opublikowaną.
create function public.brand_rollback(target_company uuid, target_version uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare v branding.versions; next_no integer; saved uuid;
begin
  perform private.brand_require_owner(target_company);
  perform pg_advisory_xact_lock(hashtextextended('sc020:' || target_company::text, 0));
  select * into v from branding.versions where id = target_version and company_id = target_company and status = 'superseded';
  if v.id is null then
    raise exception 'brand_version_unavailable' using errcode = '22023';
  end if;
  select coalesce(max(version_no), 0) + 1 into next_no from branding.versions where company_id = target_company;
  update branding.versions set status = 'superseded' where company_id = target_company and status = 'published';
  insert into branding.versions (company_id, status, version_no, config, logo_asset_id, favicon_asset_id, rolled_back_from,
                                 created_by, updated_by, published_by, published_at)
    values (target_company, 'published', next_no, v.config, v.logo_asset_id, v.favicon_asset_id, v.id,
            auth.uid(), auth.uid(), auth.uid(), clock_timestamp())
    returning id into saved;
  insert into branding.events (company_id, version_id, action, actor) values (target_company, saved, 'rolled_back', auth.uid());
  return saved;
end;
$$;

-- Opublikowana wersja: dla każdego członka firmy. Pusto = brak marki.
create function public.brand_published(target_company uuid)
returns table (version_id uuid, version_no integer, config jsonb, logo_asset_id uuid, favicon_asset_id uuid, published_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or target_company is null or not private.has_company_access(target_company) then
    raise exception 'brand_forbidden' using errcode = '42501';
  end if;
  return query
    select v.id, v.version_no, v.config, v.logo_asset_id, v.favicon_asset_id, v.published_at
      from branding.versions v where v.company_id = target_company and v.status = 'published';
end;
$$;

-- Metadane pliku do serwowania: dla członka firmy, tylko pliki tej firmy.
create function public.brand_asset(target_company uuid, target_asset uuid)
returns table (object_path text, mime text, kind text, byte_size integer, sha256 text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or target_company is null or not private.has_company_access(target_company) then
    raise exception 'brand_forbidden' using errcode = '42501';
  end if;
  return query
    select a.object_path, a.mime, a.kind, a.byte_size, a.sha256
      from branding.assets a where a.company_id = target_company and a.id = target_asset;
end;
$$;

-- Stan edytora: szkic, wszystkie wersje opublikowane, pliki i dziennik. Tylko właściciel.
create function public.brand_editor_state(target_company uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.brand_require_owner(target_company);
  return jsonb_build_object(
    'draft', (select to_jsonb(d) - 'company_id' from branding.versions d where d.company_id = target_company and d.status = 'draft'),
    'versions', coalesce((select jsonb_agg(to_jsonb(v) - 'company_id' order by v.version_no desc)
                            from branding.versions v where v.company_id = target_company and v.status <> 'draft'), '[]'::jsonb),
    'assets', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'mime', a.mime, 'byte_size', a.byte_size,
                                                            'created_at', a.created_at) order by a.created_at desc)
                          from branding.assets a where a.company_id = target_company), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('action', e.action, 'actor', e.actor, 'at', e.at,
                                                            'version_id', e.version_id, 'asset_id', e.asset_id) order by e.id desc)
                          from (select * from branding.events where company_id = target_company order by id desc limit 100) e), '[]'::jsonb)
  );
end;
$$;

do $grants$
declare fn text;
begin
  foreach fn in array array[
    'public.brand_register_asset(uuid,text,text,text,integer,text)',
    'public.brand_save_draft(uuid,jsonb,uuid,uuid)',
    'public.brand_publish_draft(uuid,uuid,timestamptz)',
    'public.brand_rollback(uuid,uuid)',
    'public.brand_published(uuid)',
    'public.brand_asset(uuid,uuid)',
    'public.brand_editor_state(uuid)'] loop
    execute format('revoke all on function %s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', fn);
    end if;
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
  -- Funkcje pomocnicze potrzebne politykom Storage (wywoływane jako użytkownik).
  grant execute on function private.brand_object_company(text), private.brand_storage_quota_ok(text) to authenticated;
end
$grants$;

-- Supabase Storage: prywatny koszyk z limitem rozmiaru i typów oraz polityki
-- na storage.objects. Pomijane tylko tam, gdzie Storage nie istnieje (goły
-- PostgreSQL w CI); w Supabase schemat storage istnieje zawsze.
do $storage$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'sc020: storage schema absent, bucket and policies not installed';
    return;
  end if;
  execute $sql$insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('brand-assets', 'brand-assets', false, 524288, array['application/octet-stream'])
    on conflict (id) do update set public = false, file_size_limit = 524288,
            allowed_mime_types = array['application/octet-stream']$sql$;
  execute $sql$create policy sc020_brand_assets_read on storage.objects for select to authenticated
    using (bucket_id = 'brand-assets' and private.has_company_access(private.brand_object_company(name)))$sql$;
  execute $sql$create policy sc020_brand_assets_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'brand-assets' and private.is_company_owner(private.brand_object_company(name))
                and private.brand_storage_quota_ok(name))$sql$;
end
$storage$;

do $postflight$
begin
  if private.erasure_schema_signature() is distinct from '1093b01d527503638d0204fc4d0df7382c8a3ed2dece1ac21cc644ac2285be44' then
    raise exception 'sc020_inventory_changed:%', private.erasure_schema_signature() using errcode = '55000';
  end if;
end
$postflight$;

commit;
