begin;
do $$ begin if exists(select 1 from exercise_ai.proposals where provenance ? 'workflow' or provenance ? 'human_edit') then raise exception 'c6_revision_rollback_requires_forward_fix' using errcode='55000';end if;end $$;
drop function public.edit_exercise_ai_proposal(uuid,uuid,uuid,timestamptz,jsonb,timestamptz);
drop function public.reject_exercise_ai_proposal(uuid,uuid,uuid,timestamptz,text);
create or replace function public.save_exercise_definition(target_recruitment uuid, target_exercise uuid, new_definition jsonb,
  expected_version integer, expected_position_id uuid, expected_position_updated_at timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid()); recruitment public.recruitments%rowtype; position public.positions%rowtype;
  previous public.exercise_definition_entries%rowtype; canonical jsonb; entry_id uuid;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if target_exercise is null or expected_version is null or expected_version < 0
    or expected_position_id is null or expected_position_updated_at is null then
    raise exception 'Invalid revision context' using errcode = '22023';
  end if;
  select * into recruitment from public.recruitments r where r.id = target_recruitment
    and private.has_company_access(r.company_id, true) for share;
  if not found then raise exception 'No write access' using errcode = '42501'; end if;
  select * into position from public.positions p where p.id = recruitment.position_id and p.company_id = recruitment.company_id for share;
  if not found then raise exception 'No position' using errcode = '42501'; end if;
  if recruitment.status not in ('draft','open') or position.status = 'archived' then
    raise exception 'Exercise editing closed' using errcode = '55000';
  end if;
  if position.id is distinct from expected_position_id or position.updated_at is distinct from expected_position_updated_at then
    raise exception 'Position changed' using errcode = 'PT409';
  end if;
  canonical := private.validate_exercise_definition(new_definition);
  perform pg_advisory_xact_lock(hashtextextended('exercise:' || target_exercise::text,0));
  select * into previous from public.exercise_definition_entries where exercise_id = target_exercise order by version desc limit 1;
  if found and (previous.company_id <> recruitment.company_id or previous.recruitment_id <> recruitment.id) then
    raise exception 'No write access' using errcode = '42501';
  end if;
  if coalesce(previous.version,0) <> expected_version then raise exception 'Exercise changed' using errcode = 'PT409'; end if;
  insert into public.exercise_definition_entries(exercise_id, company_id, recruitment_id,version,definition,
    position_id,position_updated_at,position_snapshot,author_id)
    values(target_exercise,recruitment.company_id,recruitment.id,expected_version+1,canonical,
      position.id,position.updated_at,jsonb_build_object('title',position.title,'description',position.description,
        'tasks',position.tasks,'kpis',position.kpis,'autonomy_level',position.autonomy_level,
        'required_competencies',position.required_competencies,'required_behaviors',position.required_behaviors),actor)
    returning id into entry_id;
  return entry_id;
end;
$$;
create or replace function exercise_ai.approve_proposal(target_definition_entry uuid)
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
create or replace function exercise_ai.record_proposal(target_recruitment uuid, target_definition_entry uuid,
  new_provenance jsonb, draft_limit integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid()); recruitment public.recruitments%rowtype;
  entry public.exercise_definition_entries%rowtype; used integer; proposal_id uuid;
  auto_release boolean; ceiling integer; position public.positions%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
 -- Absence checks must see the latest committed classification, not an old snapshot.
 if current_setting('transaction_isolation') <> 'read committed' then
  raise exception using errcode='PT409',message='Read committed transaction required';end if;
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
      and e.recruitment_id = recruitment.id for update nowait;
  if not found then raise exception 'No definition' using errcode = '42501'; end if;
  -- Classification is fixed once any grant exists, including revoked grants.
  -- This preserves historical answers and prevents retroactive AI retagging.
  if exists(select 1 from private.competency_test_grants g
    where g.company_id=entry.company_id and g.recruitment_id=entry.recruitment_id
      and g.definition_entry_id=entry.id) then
    raise exception 'Definition already granted' using errcode='PT409';
  end if;
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
exception when lock_not_available then
  raise exception 'Definition busy' using errcode='PT409';
end;
$$;
commit;
