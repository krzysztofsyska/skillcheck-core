-- SC-014-C6: proposal lifecycle foreign keys + erasure inventory R14.
-- Generated offline by scripts/sc-c6-compose.mjs, pinned to reviewed R13/AC.
-- No candidate-linked tables. No service, preview flag or production activation.
begin;
do $preflight$
declare known text[];actual text[];
begin
 if to_regclass('private.erasure_inventory_baseline_r13') is null then raise exception 'c6_requires_r13' using errcode='55000';end if;
 if to_regclass('private.erasure_inventory_baseline_r14') is not null or to_regnamespace('exercise_ai') is not null then
  raise exception 'c6_already_installed' using errcode='55000';end if;
 if not exists(select 1 from private.erasure_inventory_baseline_r13 where singleton and schema_signature='de6b8172a272c6933ea39da4374a1206cb857ecabae218714c1d90d50d7d2889')
  or private.erasure_schema_signature() is distinct from 'de6b8172a272c6933ea39da4374a1206cb857ecabae218714c1d90d50d7d2889' then
  raise exception 'c6_source_schema_unreviewed:%',private.erasure_schema_signature() using errcode='55000';end if;
 select known_tables into known from private.erasure_inventory_baseline_r13 where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception 'c6_source_inventory_gap' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_inventory_rows(uuid,uuid[])'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='9f7edcf5d0b3fefca54e032992f7d1b778d22b855e193daf759ea51a68850d2f'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'c6_source_function_unreviewed:private.erasure_inventory_rows' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_row_candidates(text,jsonb)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='654764eaa73493ea5091238a1c582d358bb2e30c3872aa9bdf1a03e26adf8fe9'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'c6_source_function_unreviewed:private.erasure_row_candidates' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.erasure_purge_engine(uuid,bigint,boolean)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='13a9fb369b2ffa93895f33abd6f5f97adb0fac56d0d6954900e0d999b20db3bd'
  and pg_get_userbyid(proowner)='erasure_purge_owner' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{erasure_purge_owner=X/erasure_purge_owner}') then
  raise exception 'c6_source_function_unreviewed:private.erasure_purge_engine' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='public.preview_candidate_erasure(uuid,text,uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='f7f6eb80a6154b3f21eecf0581f65d44579280060ed54ad36765c32680888bdf'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{postgres=X/postgres,authenticated=X/postgres}') then
  raise exception 'c6_source_function_unreviewed:public.preview_candidate_erasure' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.prepare_erasure_purge_manifest(uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='0d6d3cc833e0e9c27a893a0a51383194f0629b9cfe44bbaf0230f8d9911b13ee'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'c6_source_function_unreviewed:private.prepare_erasure_purge_manifest' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='private.authorize_retention_suggestion(uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='b85b16492b9c9839edf41be5a7352a3cd9e0b8aa710f8e805cf8a58b2010f523'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""','TimeZone=UTC','DateStyle=ISO, YMD'] and proacl::text='{postgres=X/postgres}') then
  raise exception 'c6_source_function_unreviewed:private.authorize_retention_suggestion' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='public.get_retention_schedule(uuid)'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='57da0cde3d38a4e627782d2a7cd62689103f30cc0126ff574ecdb5433806025e'
  and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""'] and proacl::text='{postgres=X/postgres,authenticated=X/postgres}') then
  raise exception 'c6_source_function_unreviewed:public.get_retention_schedule' using errcode='55000';end if;
end $preflight$;

-- SC-014-C6: dane wspólnego zadania stanowiska, bez danych kandydatów.
-- FK CASCADE wiążą cykl życia z rekrutacją/definicją. Ponowne użycie id lub
-- created_at nigdy nie odtwarza zgody ani limitu usuniętej rekrutacji.
-- Przychodzące FK są uwzględnione w przypiętym inwentarzu R14.
-- AC3 (grant kandydata) i aktywacja AI pozostają osobnym krokiem.
create schema if not exists exercise_ai;
revoke all on schema exercise_ai from public;
grant usage on schema exercise_ai to authenticated;

-- Jeden wiersz na propozycję wygenerowaną przez model. Wiersz istnieje WYŁĄCZNIE
-- dla propozycji AI; zadania napisane ręcznie przez rekrutera nie mają tu nic i
-- działają dokładnie jak dotąd.
create table exercise_ai.proposals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  recruitment_id uuid not null,
  -- Wpis definicji, który powstał z tej propozycji. Niezmienny, jak cała historia
  -- public.exercise_definition_entries.
  definition_entry_id uuid not null unique,
  -- Ślad pochodzenia: z czego powstała propozycja. Walidowany niżej, żeby nie dało
  -- się zapisać wpisu bez możliwości odtworzenia, na jakich danych powstał.
  provenance jsonb not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  -- Zwolnienie propozycji do użycia. Dopóki jest puste, propozycja nie jest zadaniem.
  approved_by uuid references auth.users(id) on delete restrict,
  approved_at timestamptz,
  -- Czy zwolnił ją człowiek, który ją przeczytał, czy automat, bo rekruter tak
  -- ustawił rekrutację. To nie jest szczegół: przy 'auto' nikt nie widział treści,
  -- która poszła do kandydata, i raport ma to pokazywać wprost.
  approval_mode text check (approval_mode in ('manual','auto')),
  check ((approved_by is null) = (approved_at is null)),
  check ((approved_at is null) = (approval_mode is null)),
  foreign key (company_id, recruitment_id, definition_entry_id)
    references public.exercise_definition_entries(company_id, recruitment_id, id) on delete cascade
);
create index exercise_ai_proposals_recruitment_idx on exercise_ai.proposals(company_id, recruitment_id, created_at desc);

alter table exercise_ai.proposals enable row level security;
revoke all on exercise_ai.proposals from public, anon, authenticated;
grant select on exercise_ai.proposals to authenticated;
create policy exercise_ai_proposals_read on exercise_ai.proposals for select to authenticated
  using (private.has_company_access(company_id));

-- Wybór rekrutera dla całej rekrutacji: czy czyta i zwalnia zadania sam, czy mają
-- wychodzić automatycznie (decyzja właściciela 2026-11-06). Brak wiersza znaczy
-- zatwierdzanie ręczne — bezpieczniejszy stan jest stanem domyślnym, a włączenie
-- automatu jest świadomym, zapisanym imiennie działaniem.
create table exercise_ai.recruitment_settings (
  company_id uuid not null,
  recruitment_id uuid not null,
  auto_release boolean not null default false,
  -- Pułap liczby propozycji dla tej rekrutacji. Trzymany w bazie, bo limit podany
  -- w wywołaniu wybiera klient, a rachunek u dostawcy przychodzi i tak.
  draft_ceiling integer not null default 20 check (draft_ceiling between 1 and 1000),
  set_by uuid not null references auth.users(id) on delete restrict,
  set_at timestamptz not null default now(),
  primary key (company_id, recruitment_id),
  foreign key (company_id, recruitment_id)
    references public.recruitments(company_id, id) on delete cascade
);
alter table exercise_ai.recruitment_settings enable row level security;
revoke all on exercise_ai.recruitment_settings from public, anon, authenticated;
grant select on exercise_ai.recruitment_settings to authenticated;
create policy exercise_ai_settings_read on exercise_ai.recruitment_settings for select to authenticated
  using (private.has_company_access(company_id));

create function exercise_ai.set_auto_release(target_recruitment uuid, enabled boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare actor uuid := (select auth.uid()); recruitment public.recruitments%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if enabled is null then raise exception 'Invalid setting' using errcode = '22023'; end if;
  select * into recruitment from public.recruitments r
    where r.id = target_recruitment and private.has_company_access(r.company_id, true) for share;
  if not found then raise exception 'No write access' using errcode = '42501'; end if;
  -- Przełączenie automatu zachowuje pułap operatora; DELETE rekrutacji usuwa ustawienie.
  insert into exercise_ai.recruitment_settings(company_id, recruitment_id, auto_release, set_by)
    values(recruitment.company_id, recruitment.id, enabled, actor)
    on conflict (company_id, recruitment_id)
    do update set auto_release = excluded.auto_release, set_by = excluded.set_by, set_at = now();
  return enabled;
end;
$$;
revoke all on function exercise_ai.set_auto_release(uuid,boolean) from public, anon, authenticated;
grant execute on function exercise_ai.set_auto_release(uuid,boolean) to authenticated;

-- Ślad pochodzenia musi wystarczyć człowiekowi do odtworzenia, skąd wzięła się
-- propozycja: który dostawca i model, która wersja zapytania, jaki odcisk wejścia
-- i która wersja profilu stanowiska. Bez tego wpis byłby tylko tekstem bez źródła.
create function exercise_ai.validate_provenance(value jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare field text; maximum integer; known text[] := array['provider','model','model_revision',
  'prompt_version','payload_schema_version','result_schema_version','input_fingerprint',
  'position_id','position_updated_at'];
begin
  if value is null or jsonb_typeof(value) <> 'object' then
    raise exception 'Invalid provenance' using errcode = '22023';
  end if;
  -- Ślad ma być śladem, nie workiem na dowolną treść: ograniczony rozmiar i
  -- wyłącznie znane pola. Inaczej dałoby się tu przemycić cokolwiek.
  if pg_catalog.pg_column_size(value) > 4000 then
    raise exception 'Provenance too large' using errcode = '22023';
  end if;
  if exists (select 1 from pg_catalog.jsonb_object_keys(value) k where k <> all(known)) then
    raise exception 'Unknown provenance field' using errcode = '22023';
  end if;
  if value ? 'model_revision' and jsonb_typeof(value->'model_revision') = 'string'
    and length(value->>'model_revision') > 200 then
    raise exception 'Invalid provenance revision' using errcode = '22023';
  end if;
  foreach field in array array['provider','model','prompt_version','input_fingerprint','position_id'] loop
    maximum := case field when 'input_fingerprint' then 64 else 200 end;
    if jsonb_typeof(value->field) is distinct from 'string'
      or length(value->>field) = 0 or length(value->>field) > maximum then
      raise exception 'Invalid provenance field' using errcode = '22023';
    end if;
  end loop;
  if value->>'input_fingerprint' !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid provenance fingerprint' using errcode = '22023';
  end if;
  foreach field in array array['payload_schema_version','result_schema_version'] loop
    if jsonb_typeof(value->field) is distinct from 'number'
      or (value->>field)::numeric < 1
      or trunc((value->>field)::numeric) <> (value->>field)::numeric then
      raise exception 'Invalid provenance version' using errcode = '22023';
    end if;
  end loop;
  if jsonb_typeof(value->'position_updated_at') is distinct from 'string' then
    raise exception 'Invalid provenance position revision' using errcode = '22023';
  end if;
  begin
    perform (value->>'position_id')::uuid;
  exception when invalid_text_representation then
    raise exception 'Invalid provenance position id' using errcode = '22023';
  end;
  begin
    perform (value->>'position_updated_at')::timestamptz;
  exception when others then raise exception 'Invalid provenance position revision' using errcode = '22023';
  end;
  -- model_revision bywa pusty u dostawcy; dopuszczamy null, ale nie inny typ.
  if value ? 'model_revision' and jsonb_typeof(value->'model_revision') not in ('string','null') then
    raise exception 'Invalid provenance revision' using errcode = '22023';
  end if;
  return value;
end;
$$;
revoke all on function exercise_ai.validate_provenance(jsonb) from public, anon, authenticated;

-- Twardy limit liczby propozycji na rekrutację. Pomyłka albo zapętlony klik nie
-- mogą nabić rachunku u dostawcy modelu. Limit liczy się po stronie bazy, bo
-- interfejs da się ominąć, a rachunek i tak przyjdzie.
create function exercise_ai.record_proposal(target_recruitment uuid, target_definition_entry uuid,
  new_provenance jsonb, draft_limit integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid()); recruitment public.recruitments%rowtype;
  entry public.exercise_definition_entries%rowtype; used integer; proposal_id uuid;
  auto_release boolean; ceiling integer; position public.positions%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if draft_limit is null or draft_limit < 1 or draft_limit > 1000 then
    raise exception 'Invalid draft limit' using errcode = '22023';
  end if;
  -- `draft_limit` wybiera klient, więc sam w sobie niczego nie chroni. Wiążący
  -- jest pułap z bazy; argument może go wyłącznie obniżyć.
  select * into recruitment from public.recruitments r
    where r.id = target_recruitment and private.has_company_access(r.company_id, true) for share;
  if not found then raise exception 'No write access' using errcode = '42501'; end if;
  select * into entry from public.exercise_definition_entries e
    where e.id = target_definition_entry and e.company_id = recruitment.company_id
      and e.recruitment_id = recruitment.id for share;
  if not found then raise exception 'No definition' using errcode = '42501'; end if;
  new_provenance := exercise_ai.validate_provenance(new_provenance);
  -- Ślad pochodzenia musi opisywać TEN wpis definicji, nie dowolny. Dobrze
  -- zbudowany, ale nieprawdziwy ślad jest gorszy od braku śladu: wygląda na
  -- źródło, a prowadzi donikąd. Wersję profilu bierzemy z wpisu, który już mamy.
  if (new_provenance->>'position_id')::uuid is distinct from entry.position_id
    or (new_provenance->>'position_updated_at')::timestamptz is distinct from entry.position_updated_at then
    raise exception 'Provenance does not match the definition' using errcode = '22023';
  end if;
  -- Serializuje równoległe żądania tej samej rekrutacji, żeby limit nie dał się
  -- obejść dwoma kliknięciami naraz.
  perform pg_advisory_xact_lock(hashtextextended('exercise_ai:' || recruitment.id::text, 0));
  -- Usunięcie rekrutacji usuwa propozycje przez definicję (FK CASCADE).
  select count(*) into used from exercise_ai.proposals p
    where p.company_id = recruitment.company_id and p.recruitment_id = recruitment.id;
  -- Ustawienie czyta się TU, w tej samej transakcji co zapis, a nie przyjmuje
  -- z wywołania: inaczej klient mógłby zażądać automatu dla rekrutacji, w której
  -- rekruter go nie włączył. Brak wiersza = zatwierdzanie ręczne.
  select coalesce(s.auto_release, false), coalesce(s.draft_ceiling, 20)
    into auto_release, ceiling
    from (select 1) one
    left join exercise_ai.recruitment_settings s
      on s.company_id = recruitment.company_id and s.recruitment_id = recruitment.id;
  if used >= least(draft_limit, ceiling) then raise exception 'Draft limit reached' using errcode = 'PT429'; end if;
  -- Automat zwalnia zadanie bez niczyjej lektury, więc musi sprawdzać to samo, co
  -- sprawdza człowiek w approve_proposal. Wpis definicji powstał, gdy rekrutacja
  -- była otwarta, ale status mógł się zmienić PÓŹNIEJ i nic go tu nie czytało.
  -- Propozycja wtedy powstaje, ale niezwolniona: ślad zostaje, zadanie nie wychodzi.
  if auto_release then
    select * into position from public.positions p
      where p.company_id = recruitment.company_id and p.id = recruitment.position_id for share;
    if recruitment.status not in ('draft','open') or not found or position.status = 'archived' then
      auto_release := false;
    end if;
  end if;
  insert into exercise_ai.proposals(company_id, recruitment_id, definition_entry_id, provenance, created_by,
      approved_by, approved_at, approval_mode)
    values(recruitment.company_id, recruitment.id, entry.id,
      new_provenance, actor,
      case when auto_release then actor end,
      case when auto_release then now() end,
      case when auto_release then 'auto' end)
    returning id into proposal_id;
  return proposal_id;
end;
$$;
revoke all on function exercise_ai.record_proposal(uuid,uuid,jsonb,integer) from public, anon, authenticated;
grant execute on function exercise_ai.record_proposal(uuid,uuid,jsonb,integer) to authenticated;

-- Zatwierdzenie jest jednokierunkowe i imienne. Nie ma cofania: propozycja raz
-- zatwierdzona zostaje w historii, a zmiana zadania to nowa wersja definicji,
-- tak samo jak przy zadaniu pisanym ręcznie.
create function exercise_ai.approve_proposal(target_definition_entry uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid()); proposal exercise_ai.proposals%rowtype;
  recruitment public.recruitments%rowtype; position public.positions%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select * into proposal from exercise_ai.proposals p
    where p.definition_entry_id = target_definition_entry;
  if not found then raise exception 'No proposal' using errcode = '42501'; end if;
  if not private.has_company_access(proposal.company_id, true) then
    raise exception 'No write access' using errcode = '42501';
  end if;
  select * into recruitment from public.recruitments r
    where r.company_id = proposal.company_id and r.id = proposal.recruitment_id for share;
  if not found or recruitment.status not in ('draft','open') then
    raise exception 'Approval closed' using errcode = '55000';
  end if;
  select * into position from public.positions p
    where p.company_id = recruitment.company_id and p.id = recruitment.position_id for share;
  if not found or position.status = 'archived' then
    raise exception 'Approval closed' using errcode = '55000';
  end if;
  -- Kolejność blokad odpowiada DELETE rodzica z CASCADE: rekrutacja,
  -- stanowisko/definicja, na końcu propozycja. Pierwszy odczyt był tylko wskazówką.
  -- Sprawdzenie żywej definicji poprzedza również idempotentny return.
  perform 1 from public.exercise_definition_entries e
    where e.id = proposal.definition_entry_id and e.company_id = proposal.company_id
      and e.recruitment_id = recruitment.id for share;
  if not found then raise exception 'No definition' using errcode = '42501'; end if;
  select * into proposal from exercise_ai.proposals p
    where p.definition_entry_id = target_definition_entry and p.company_id = recruitment.company_id
      and p.recruitment_id = recruitment.id for update;
  if not found then raise exception 'No proposal' using errcode = '42501'; end if;
  if not private.has_company_access(proposal.company_id, true) then
    raise exception 'No write access' using errcode = '42501';
  end if;
  -- Powtórne zatwierdzenie tej samej propozycji przez tę samą osobę jest
  -- bezskuteczne, a nie błędem: podwójne kliknięcie nie ma nic psuć.
  if proposal.approved_at is not null then return proposal.id; end if;
  update exercise_ai.proposals set approved_by = actor, approved_at = now(), approval_mode = 'manual'
    where id = proposal.id;
  return proposal.id;
end;
$$;
revoke all on function exercise_ai.approve_proposal(uuid) from public, anon, authenticated;
grant execute on function exercise_ai.approve_proposal(uuid) to authenticated;




create table private.erasure_inventory_baseline_r14 (
 singleton boolean primary key default true check(singleton),schema_signature text not null,known_tables text[] not null
);
alter table private.erasure_inventory_baseline_r14 enable row level security;
create trigger immutable_history before update or delete on private.erasure_inventory_baseline_r14
 for each row execute function private.contact_immutable();
insert into private.erasure_inventory_baseline_r14 select true,'75eca00dc4b8bbf7959e18a144beda51a70b0377ab4cc306e59b2cef56402688',
 known_tables||array['private.erasure_inventory_baseline_r14'] from private.erasure_inventory_baseline_r13 where singleton;


create or replace function public.preview_candidate_erasure(target_candidate uuid,scope_kind text default 'candidate_record',resolution_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare tenant uuid;subjects uuid[];p private.candidate_retention_policies;r private.erasure_subject_resolutions;
 baseline private.erasure_inventory_baseline_r14;signature text;counts jsonb:='{}';manifest text;row_digest jsonb:='[]';
 blockers text[]:=array['execution_not_provisioned','external_inventory_unverified','backup_policy_unverified','administrative_inventory_pending_execution'];generated timestamptz:=statement_timestamp();
begin
 select company_id into tenant from public.candidates where id=target_candidate;perform private.erasure_owner(tenant);
 if scope_kind is null or scope_kind not in ('candidate_record','confirmed_subject')
 or (scope_kind='candidate_record' and resolution_id is not null) or (scope_kind='confirmed_subject' and resolution_id is null)
 then raise exception using errcode='PT422',message='Invalid preview scope';end if;
 subjects:=array[target_candidate];
 if scope_kind='confirmed_subject' then
  select * into r from private.erasure_subject_resolutions where id=resolution_id and company_id=tenant and anchor_candidate_id=target_candidate;
  if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
  subjects:=r.candidate_ids;
  if r.revision<>(select max(revision) from private.erasure_subject_resolutions where company_id=tenant and anchor_candidate_id=target_candidate)
   or r.confirmed_by<>auth.uid() then blockers:=array_append(blockers,'subject_resolution_changed');end if;
  if cardinality(subjects)<>(select count(*) from public.candidates where company_id=tenant and id=any(subjects)) then
   blockers:=array_append(blockers,'subject_resolution_changed');end if;
 else blockers:=array_append(blockers,'subject_resolution_required');end if;
 select * into p from private.candidate_retention_policies where company_id=tenant order by revision desc limit 1;
 if p.id is null then blockers:=array_append(blockers,'retention_policy_required');
 elsif jsonb_array_length(p.rules)<8 then blockers:=array_append(blockers,'retention_policy_incomplete');end if;
 if p.id is not null and p.approved_by<>auth.uid() then blockers:=array_append(blockers,'policy_owner_changed');end if;
 select * into baseline from private.erasure_inventory_baseline_r14 where singleton;
 signature:=private.erasure_schema_signature();
 if baseline.singleton is null or baseline.known_tables is null or signature is distinct from baseline.schema_signature or exists(
  select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f')
  and not (n.nspname||'.'||c.relname)=any(baseline.known_tables)) then
  blockers:=array_append(blockers,'schema_dependency_unknown');
 else
  -- Preserve the R4-VOICE preview denial as well as its purge/restore adapters.
  -- The legacy R4 fixture has no voice module; SQL in this branch is planned
  -- only when the reviewed voice helper exists.
  if to_regprocedure('private.erasure_voice_request_candidate(uuid,text,uuid)') is not null then
    if exists(select 1 from private.voice_plan_request_keys t where t.company_id=tenant
      and private.erasure_voice_request_candidate(t.company_id,t.operation,t.result_id) is null)
    then blockers:=array_append(blockers,'voice_request_adapter_unknown');end if;
  end if;
  if exists(select 1 from private.contact_requests t where t.company_id=tenant
   and private.erasure_contact_request_candidate(t.company_id,t.operation,t.payload,t.result_id) is null) then blockers:=array_append(blockers,'contact_request_adapter_unknown');end if;
  if exists(select 1 from public.screening_analysis_versions a join public.applications ap on ap.company_id=a.company_id and ap.id=a.application_id
   where ap.company_id=tenant and ap.candidate_id=any(subjects) and a.execution_status in ('pending','processing')) then blockers:=array_append(blockers,'active_screening');end if;
  if exists(select 1 from private.erasure_subject_resolutions sr where sr.company_id=tenant and sr.candidate_ids && subjects and not sr.candidate_ids <@ subjects)
   then blockers:=array_append(blockers,'shared_resolution_requires_adapter');end if;
  if exists(select 1 from private.competency_test_cancellations c where c.company_id=tenant
   and private.erasure_row_candidates('private.competency_test_cancellations',to_jsonb(c)) && subjects
   and not private.erasure_row_candidates('private.competency_test_cancellations',to_jsonb(c)) <@ subjects)
   then blockers:=array_append(blockers,'shared_competency_cancellation_requires_adapter');end if;
  with rows as materialized(select * from private.erasure_inventory_rows(tenant,subjects)),
  grouped as(select adapter,count(*) n from rows group by adapter)
  select coalesce((select jsonb_object_agg(adapter,n) from grouped),'{}'::jsonb),
   coalesce((select jsonb_agg(jsonb_build_array(adapter,row_key,private.erasure_hash(row_data)) order by adapter,row_key) from rows),'[]'::jsonb)
  into counts,row_digest;
 end if;
 manifest:=private.erasure_hash(jsonb_build_object('contract','sc010-r1-v1','tenant',tenant,'owner',auth.uid(),'scope',scope_kind,'subjects',subjects,
 'resolution',to_jsonb(r),'current_resolution_revision',(select coalesce(max(revision),0) from private.erasure_subject_resolutions where company_id=tenant and anchor_candidate_id=target_candidate),
 'policy',to_jsonb(p),'schema',signature,'rows',row_digest,'blockers',blockers));
 return jsonb_build_object('scope_kind',scope_kind,'candidate_count',cardinality(subjects),'counts',counts,'blockers',to_jsonb(blockers),
 'policy_revision',coalesce(p.revision,0),'resolution_revision',coalesce(r.revision,0),'manifest_hash',manifest,'schema_signature',signature,
 'generated_at',generated,'expires_at',generated+interval '5 minutes','execution_enabled',false);
end;$$;

create or replace function private.prepare_erasure_purge_manifest(target_request uuid) returns jsonb
language plpgsql volatile security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare e private.erasure_executions;digest text;signature text;counts jsonb;baseline text;
begin
 perform private.erasure_check_purge_scope(target_request);
 select * into e from private.erasure_executions where request_id=target_request;
 signature:=private.erasure_schema_signature();
 -- R4 final reviewed baseline is installed by the final migration, never learned at runtime.
 select schema_signature into baseline from private.erasure_inventory_baseline_r14 where singleton;
 if signature is distinct from baseline then raise exception using errcode='PT409',message='Unknown schema dependency';end if;
 select private.erasure_hash(coalesce(jsonb_agg(jsonb_build_array(adapter,row_key,private.erasure_hash(row_data)) order by adapter,row_key),'[]'::jsonb)) into digest from private.erasure_purge_rows(e.company_id,e.candidate_ids);
 insert into private.erasure_purge_manifest
 select target_request,digest,adapter,row_key,private.erasure_hash(row_data) from private.erasure_purge_rows(e.company_id,e.candidate_ids) on conflict do nothing;
 select coalesce(jsonb_object_agg(adapter,n),'{}'::jsonb) into counts from(select adapter,count(*) n from private.erasure_purge_rows(e.company_id,e.candidate_ids) group by adapter)c;
 return jsonb_build_object('manifest_hash',digest,'schema_signature',signature,'counts',counts);
end;$$;

create or replace function private.authorize_retention_suggestion(target_suggestion uuid) returns uuid
language plpgsql volatile security definer set search_path='' set timezone='UTC' set datestyle='ISO, YMD' as $$
declare s private.retention_suggestions;d private.retention_delegations;r private.erasure_subject_resolutions;p jsonb;ticket uuid;result uuid;issued timestamptz;authz jsonb;
begin
 select * into s from private.retention_suggestions where id=target_suggestion for update nowait;
 select * into d from private.retention_delegations where id=s.delegation_id;
 if d.execution_mode<>'automatic' then raise exception using errcode='PT409',message='Automatic delegation required';end if;
 perform private.erasure_execution_gate(false);
 if private.erasure_schema_signature() is distinct from (select schema_signature from private.erasure_inventory_baseline_r14 where singleton) then raise exception using errcode='PT409',message='Unknown schema dependency';end if;
 p:=private.evaluate_retention_subject(s.resolution_id,d.id);
 if p->'blockers'<>'[]'::jsonb or p->>'evidence_hash'<>s.evidence_hash then raise exception using errcode='PT409',message='Retention eligibility changed';end if;
 if exists(select 1 from unnest(s.candidate_ids) x(id) where private.erasure_candidate_frozen(x.id)) then raise exception using errcode='PT409',message='Candidate workflow frozen';end if;
 select * into r from private.erasure_subject_resolutions where id=s.resolution_id;
 -- Fixed graph checks, with unknown schema/JSON/dependencies rejected by the R3 adapter before commit.
 if exists(select 1 from private.contact_requests c where c.company_id=s.company_id and private.erasure_contact_request_candidate(c.company_id,c.operation,c.payload,c.result_id) is null) then raise exception using errcode='PT409',message='Unknown candidate dependency';end if;
 issued:=clock_timestamp();
 insert into private.erasure_preview_tickets(company_id,actor_id,anchor_candidate_id,scope_kind,resolution_id,candidate_ids,manifest_hash,generations,created_at,expires_at)
 values(s.company_id,d.owner_id,r.anchor_candidate_id,'confirmed_subject',r.id,s.candidate_ids,s.evidence_hash,private.erasure_generation_snapshot(s.candidate_ids),issued,issued+interval '5 minutes') returning id into ticket;
 insert into private.erasure_requests(company_id,actor_id,anchor_candidate_id,candidate_ids,scope_kind,preview_ticket_id,manifest_hash,policy_revision,resolution_revision,status,generation)
 values(s.company_id,d.owner_id,r.anchor_candidate_id,s.candidate_ids,'confirmed_subject',ticket,s.evidence_hash,d.policy_revision,r.revision,'authorized',1) returning id into result;
 insert into private.erasure_candidate_lifecycle(candidate_id,company_id,generation,status,request_id)
 select id,s.company_id,1,'frozen',result from unnest(s.candidate_ids) x(id)
 on conflict(candidate_id) do update set generation=erasure_candidate_lifecycle.generation+1,status='frozen',request_id=excluded.request_id;
 authz:=jsonb_build_object('kind','retention_policy','actor_id',d.owner_id,'delegation_id',d.id,'activation_revision',d.revision,'policy_revision',d.policy_revision,'due_generation',s.due_generation,'due_at',s.due_at,'evidence_hash',s.evidence_hash);
 insert into private.retention_authorizations(request_id,authorization_json) values(result,authz);
 update private.retention_suggestions set status='authorized',request_id=result,blockers='[]'::jsonb where id=s.id;
 insert into private.erasure_lifecycle_events(company_id,request_id,actor_id,event,generation) values(s.company_id,result,d.owner_id,'authorized',1);
 -- Reuse the complete reviewed R3 scope validator inside this transaction. This
 -- temporary non-exportable execution never receives a reservation or ledger ACK.
 insert into private.erasure_executions(request_id,company_id,candidate_ids,scope_kind,owner_id,policy_copy,resolution_revision,generation,phase,recovery_retain_until)
 select result,s.company_id,s.candidate_ids,'confirmed_subject',d.owner_id,jsonb_build_object('revision',p2.revision,'rules',p2.rules),r.revision,1,'authorized',clock_timestamp()+interval '1 second'
 from private.candidate_retention_policies p2 where p2.id=d.policy_id;
 perform private.erasure_check_purge_scope(result);
 delete from private.erasure_executions where request_id=result;
 return result;
end;$$;

create or replace function public.get_retention_schedule(target_company uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare d private.retention_delegations;t private.retention_ticks;c private.erasure_execution_config;p private.candidate_retention_policies;schema_ok boolean;begin
 perform private.erasure_owner(target_company);
 select * into d from private.retention_delegations where company_id=target_company order by revision desc limit 1;
 select * into t from private.retention_ticks where company_id=target_company order by created_at desc,id desc limit 1;
 select * into c from private.erasure_execution_config where singleton;
 select * into p from private.candidate_retention_policies where company_id=target_company order by revision desc limit 1;
 schema_ok:=private.erasure_schema_signature() is not distinct from (select schema_signature from private.erasure_inventory_baseline_r14 where singleton);
 return jsonb_build_object('revision',coalesce(d.revision,0),'delegation_id',d.id,'policy_revision',d.policy_revision,'execution_mode',coalesce(d.execution_mode,'suggest_only'),
 'max_batch',coalesce(d.max_batch,25),'revoked',coalesce(d.revoked,true),'owner_current',d.owner_id is not distinct from auth.uid(),
 'authorization_enabled',coalesce(schema_ok and not d.revoked and d.execution_mode='automatic' and d.owner_id=auth.uid() and d.policy_id=p.id and d.policy_revision=p.revision and p.approved_by=auth.uid()
  and c.enabled and c.external_inventory_verified and c.backup_horizon_days is not null and c.artifact_horizon_days is not null and c.retention_margin_days is not null and not c.restore_isolated,false),
 'production_ready',false,
 'blockers',case when c.enabled and c.external_inventory_verified and c.backup_horizon_days is not null and c.artifact_horizon_days is not null and c.retention_margin_days is not null and not c.restore_isolated then '[]'::jsonb else jsonb_build_array('execution_not_provisioned') end || case when schema_ok then '[]'::jsonb else jsonb_build_array('schema_dependency_unknown') end,
 'oldest_pending_at',(select min(created_at) from (select created_at from private.erasure_executions where company_id=target_company and phase in ('authorized','erasing') union all select r.created_at from private.erasure_requests r where r.company_id=target_company and r.status='authorized' and not exists(select 1 from private.erasure_executions e where e.request_id=r.id)) pending),
 'expired_leases',(select count(*) from private.erasure_executions where company_id=target_company and (pending_phase is not null or (phase='erasing' and not local_purged)) and lease_until<clock_timestamp()),
 'last_tick_at',t.created_at,'lag_seconds',case when t.id is null then null else greatest(0,floor(extract(epoch from statement_timestamp()-t.created_at))) end,
 'suggestions',(select count(*) from private.retention_suggestions where company_id=target_company and status='suggested'),
 'authorized',(select count(*) from private.retention_suggestions where company_id=target_company and status='authorized'),
 'blocked',(select count(*) from private.retention_suggestions where company_id=target_company and status='blocked'),
 'holds',(select count(*) from private.erasure_holds where company_id=target_company and released_at is null));
end;$$;


-- The baseline is internal even when the migration creator has hostile defaults.
do $acl$
declare g record;o record;
begin
 for o in select c.oid,c.relowner from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='exercise_ai' and c.relkind='r' loop
  execute format('revoke all on table %s from public',o.oid::regclass);
  for g in select distinct r.rolname from pg_class c cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid=a.grantee
   where c.oid=o.oid and a.grantee<>o.relowner loop execute format('revoke all on table %s from %I',o.oid::regclass,g.rolname);end loop;
 end loop;
 for o in select p.oid,p.proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exercise_ai' loop
  execute format('revoke all on function %s from public',o.oid::regprocedure);
  for g in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee
   where p.oid=o.oid and a.grantee<>o.proowner loop execute format('revoke all on function %s from %I',o.oid::regprocedure,g.rolname);end loop;
 end loop;
 revoke all on private.erasure_inventory_baseline_r14 from public;
 for g in select distinct r.rolname from pg_class c cross join lateral aclexplode(c.relacl) a
 join pg_roles r on r.oid=a.grantee where c.oid='private.erasure_inventory_baseline_r14'::regclass
 and a.grantee<>c.relowner loop
 execute format('revoke all on private.erasure_inventory_baseline_r14 from %I',g.rolname);
 end loop;
end $acl$;
grant select on exercise_ai.proposals,exercise_ai.recruitment_settings to authenticated;
grant execute on function exercise_ai.approve_proposal(uuid),exercise_ai.record_proposal(uuid,uuid,jsonb,integer),
 exercise_ai.set_auto_release(uuid,boolean) to authenticated;
do $postflight$
declare known text[];actual text[];
begin
 if private.erasure_schema_signature() is distinct from '75eca00dc4b8bbf7959e18a144beda51a70b0377ab4cc306e59b2cef56402688' then
  raise exception 'c6_final_schema_mismatch:%',private.erasure_schema_signature() using errcode='55000';end if;
 select known_tables into known from private.erasure_inventory_baseline_r14 where singleton;
 select array_agg(n.nspname||'.'||c.relname order by (n.nspname||'.'||c.relname) collate "C") into actual
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p','f');
 if actual is distinct from (select array_agg(x order by x collate "C") from unnest(known) x) then
  raise exception 'c6_final_inventory_gap' using errcode='55000';end if;
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','private') and p.prosrc ~ 'erasure_inventory_baseline_r([4-9]|1[0123])([^0-9]|$)') then
  raise exception 'c6_stale_inventory_reference' using errcode='55000';end if;
 if (select count(*) from pg_proc p where p.prosrc like '%erasure_inventory_baseline_r14%'
  and p.proname in ('preview_candidate_erasure','prepare_erasure_purge_manifest','authorize_retention_suggestion','get_retention_schedule'))<>4 then
  raise exception 'c6_inventory_reference_missing' using errcode='55000';end if;
end $postflight$;
commit;
