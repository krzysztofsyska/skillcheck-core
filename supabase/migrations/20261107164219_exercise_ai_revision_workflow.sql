-- Generated from pinned reviewed functions by scripts/sc-c6-revision-compose.mjs.
-- Function-only change: no new storage, erasure inventory or runtime activation.
begin;
do $preflight$ begin
 if private.erasure_schema_signature() is distinct from '75eca00dc4b8bbf7959e18a144beda51a70b0377ab4cc306e59b2cef56402688' then raise exception 'c6_revision_requires_r14' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='public.save_exercise_definition(uuid,uuid,jsonb,integer,uuid,timestamptz)'::regprocedure and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='19706ae9d2f27d48c4261ccef8c7a3deaab4b3660487e2d4283b9eea8581a384' and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""'] and proacl::text='{postgres=X/postgres,authenticated=X/postgres}') then raise exception 'c6_revision_dependency_unreviewed:public.save_exercise_definition(uuid,uuid,jsonb,integer,uuid,timestamptz)' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='exercise_ai.approve_proposal(uuid)'::regprocedure and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='0ff36b910150b80c6911c3accc617e28070da4b7405d0e0147eb77e2cc7f8e58' and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""'] and proacl::text='{postgres=X/postgres,authenticated=X/postgres}') then raise exception 'c6_revision_dependency_unreviewed:exercise_ai.approve_proposal(uuid)' using errcode='55000';end if;
 if not exists(select 1 from pg_proc where oid='exercise_ai.record_proposal(uuid,uuid,jsonb,integer)'::regprocedure and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='e9a20dad044a8414a76f0b5faa89b4fbc4965a92f390b815fe15215a66d4703d' and pg_get_userbyid(proowner)='postgres' and prosecdef and proconfig=array['search_path=""'] and proacl::text='{postgres=X/postgres,authenticated=X/postgres}') then raise exception 'c6_revision_dependency_unreviewed:exercise_ai.record_proposal(uuid,uuid,jsonb,integer)' using errcode='55000';end if;
end $preflight$;
create or replace function public.save_exercise_definition(target_recruitment uuid, target_exercise uuid, new_definition jsonb,
  expected_version integer, expected_position_id uuid, expected_position_updated_at timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid()); recruitment public.recruitments%rowtype; position public.positions%rowtype;
  previous public.exercise_definition_entries%rowtype; source_proposal exercise_ai.proposals%rowtype; canonical jsonb; entry_id uuid;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Read committed transaction required' using errcode='PT409';end if;
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
  -- Use the same lock order as approval/rejection: parent, exercise, proposal.
  select * into source_proposal from exercise_ai.proposals where definition_entry_id=previous.id for update;
  insert into public.exercise_definition_entries(exercise_id, company_id, recruitment_id,version,definition,
    position_id,position_updated_at,position_snapshot,author_id)
    values(target_exercise,recruitment.company_id,recruitment.id,expected_version+1,canonical,
      position.id,position.updated_at,jsonb_build_object('title',position.title,'description',position.description,
        'tasks',position.tasks,'kpis',position.kpis,'autonomy_level',position.autonomy_level,
        'required_competencies',position.required_competencies,'required_behaviors',position.required_behaviors),actor)
    returning id into entry_id;
  if source_proposal.id is not null then
    -- Editing cannot strip AI provenance or inherit an approval. This also
    -- covers the existing manual-save RPC, not just the new UI endpoint.
    insert into exercise_ai.proposals(company_id,recruitment_id,definition_entry_id,provenance,created_by)
      values(recruitment.company_id,recruitment.id,entry_id,
        (source_proposal.provenance - 'workflow' - 'human_edit') || jsonb_build_object('human_edit',jsonb_build_object(
          'source_definition_id',previous.id,'root_definition_id',coalesce(source_proposal.provenance->'human_edit'->>'root_definition_id',previous.id::text),
          'actor',actor,'at',clock_timestamp())),actor);
    if source_proposal.approved_at is null and coalesce(source_proposal.provenance->'workflow'->>'state','pending')='pending' then
      update exercise_ai.proposals set provenance=jsonb_set(provenance,'{workflow}',jsonb_build_object(
        'state','superseded','actor',actor,'at',clock_timestamp(),'next_definition_id',entry_id)) where id=source_proposal.id;
    end if;
  end if;
  return entry_id;
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
  -- Serialize classification with revision creation, including manual saves.
  perform pg_advisory_xact_lock(hashtextextended('exercise:' || entry.exercise_id::text,0));
  if exists(select 1 from public.exercise_definition_entries e where e.exercise_id=entry.exercise_id and e.version>entry.version) then
    raise exception 'Exercise changed' using errcode='PT409';end if;
  perform pg_advisory_xact_lock(hashtextextended('exercise_ai:' || recruitment.id::text, 0));
  -- Usunięcie rekrutacji usuwa propozycje przez definicję (FK CASCADE).
  select count(*) into used from exercise_ai.proposals p
    where p.company_id = recruitment.company_id and p.recruitment_id = recruitment.id and not (p.provenance ? 'human_edit');
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
  perform pg_advisory_xact_lock(hashtextextended('exercise:' || (select e.exercise_id::text from public.exercise_definition_entries e where e.id=target_definition_entry),0));
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
  if coalesce(proposal.provenance->'workflow'->>'state','pending') <> 'pending' then
    raise exception 'Proposal is no longer pending' using errcode='55000';
  end if;
  update exercise_ai.proposals set approved_by = actor, approved_at = now(), approval_mode = 'manual'
    where id = proposal.id;
  return proposal.id;
end;
$$;
-- Server-owned lifecycle metadata is added beside the original provider trace.
-- The provider fields are never rewritten and callers cannot write this JSON.
create function public.reject_exercise_ai_proposal(target_company uuid,target_recruitment uuid,target_definition uuid,
 expected_position_updated_at timestamptz,rejection_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare review jsonb; entry public.exercise_definition_entries%rowtype; proposal exercise_ai.proposals%rowtype;
begin
 review:=public.read_exercise_ai_proposal(target_company,target_recruitment,target_definition);
 if expected_position_updated_at is null or expected_position_updated_at is distinct from
  (review->'definitionEntry'->>'position_updated_at')::timestamptz then
  raise exception 'Proposal context changed' using errcode='PT409';end if;
 if rejection_reason is null or length(btrim(rejection_reason)) not between 1 and 1000 then
  raise exception 'Invalid rejection reason' using errcode='22023';end if;
 perform 1 from public.recruitments r join public.positions p on p.company_id=r.company_id and p.id=r.position_id
  where r.company_id=target_company and r.id=target_recruitment and r.status in ('draft','open') and p.status<>'archived' for share of r,p;
 if not found then raise exception 'Editing closed' using errcode='55000';end if;
 select * into entry from public.exercise_definition_entries where id=target_definition for share;
 perform pg_advisory_xact_lock(hashtextextended('exercise:'||entry.exercise_id::text,0));
 select * into proposal from exercise_ai.proposals where definition_entry_id=target_definition for update;
 if not found then raise exception 'Resource unavailable' using errcode='PT404';end if;
 if proposal.approved_at is not null then raise exception 'Approved revision is immutable' using errcode='55000';end if;
 if proposal.provenance->'workflow'->>'state'='rejected' then return proposal.id;end if;
 if proposal.provenance->'workflow'->>'state'='superseded' or exists(
  select 1 from public.exercise_definition_entries e where e.exercise_id=entry.exercise_id and e.version>entry.version) then
  raise exception 'Proposal context changed' using errcode='PT409';end if;
 update exercise_ai.proposals set provenance=jsonb_set(provenance,'{workflow}',jsonb_build_object(
  'state','rejected','actor',auth.uid(),'at',clock_timestamp(),'reason',btrim(rejection_reason))) where id=proposal.id;
 return proposal.id;
end;$$;

create function public.edit_exercise_ai_proposal(target_company uuid,target_recruitment uuid,target_definition uuid,
 expected_position_updated_at timestamptz,new_definition jsonb,expected_current_position_updated_at timestamptz)
returns uuid language plpgsql security definer set search_path='' as $$
declare review jsonb; entry public.exercise_definition_entries%rowtype;
begin
 review:=public.read_exercise_ai_proposal(target_company,target_recruitment,target_definition);
 if expected_position_updated_at is null or expected_position_updated_at is distinct from
  (review->'definitionEntry'->>'position_updated_at')::timestamptz then
  raise exception 'Proposal context changed' using errcode='PT409';end if;
 select * into entry from public.exercise_definition_entries where id=target_definition;
 -- save_exercise_definition takes the parent locks and exercise advisory lock,
 -- checks the latest version, and copies provenance atomically with the insert.
 -- Every new human revision is pending, even if auto_release is enabled.
 return public.save_exercise_definition(target_recruitment,entry.exercise_id,new_definition,
  entry.version,entry.position_id,expected_current_position_updated_at);
end;$$;

do $acl$ declare o record;g record;begin
 for o in select oid,proowner from pg_proc where oid=any(array['public.edit_exercise_ai_proposal(uuid,uuid,uuid,timestamptz,jsonb,timestamptz)'::regprocedure,'public.reject_exercise_ai_proposal(uuid,uuid,uuid,timestamptz,text)'::regprocedure]) loop
 execute format('revoke all on function %s from public',o.oid::regprocedure);
 for g in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid=a.grantee where p.oid=o.oid and a.grantee<>o.proowner loop
 execute format('revoke all on function %s from %I',o.oid::regprocedure,g.rolname);end loop;end loop;end $acl$;
alter function public.edit_exercise_ai_proposal(uuid,uuid,uuid,timestamptz,jsonb,timestamptz) owner to postgres;
grant execute on function public.edit_exercise_ai_proposal(uuid,uuid,uuid,timestamptz,jsonb,timestamptz) to authenticated;
alter function public.reject_exercise_ai_proposal(uuid,uuid,uuid,timestamptz,text) owner to postgres;
grant execute on function public.reject_exercise_ai_proposal(uuid,uuid,uuid,timestamptz,text) to authenticated;
do $postflight$ begin if private.erasure_schema_signature() is distinct from '75eca00dc4b8bbf7959e18a144beda51a70b0377ab4cc306e59b2cef56402688' then raise exception 'c6_revision_inventory_changed' using errcode='55000';end if;end $postflight$;
commit;
