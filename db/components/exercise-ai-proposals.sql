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

