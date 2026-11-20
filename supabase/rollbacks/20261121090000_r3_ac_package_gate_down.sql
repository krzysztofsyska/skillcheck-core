-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R3 Assessment Center package gate (20261121090000_r3_ac_package_gate.sql).
-- Restores the R16 bodies of public.ac_session_create and public.ac_session_set_status
-- (no package check) and drops the owner-only helper. No data is touched: the
-- migration stored nothing. `create or replace` keeps the existing EXECUTE grants.
-- Idempotent. Run with `psql -v ON_ERROR_STOP=1`.
begin;

create or replace function public.ac_session_create(recruitment uuid,session_title text,competencies text[]) returns uuid
language plpgsql security definer set search_path='' as $$
declare r public.recruitments;p public.positions;keys text[]:='{}';item text;saved uuid;
begin
 select * into r from public.recruitments where id=recruitment;
 if r.id is null or not private.has_company_access(r.company_id,true) then
  raise exception using errcode='42501',message='Session unavailable';end if;
 perform private.competency_authority(r.company_id,true);
 select * into r from public.recruitments where id=recruitment for share nowait;
 select * into p from public.positions where company_id=r.company_id and id=r.position_id for share nowait;
 if r.id is null or r.status not in ('draft','open') or p.id is null or p.status='archived' then
  raise exception using errcode='42501',message='Session unavailable';end if;
 if session_title is null or private.behavior_trim(session_title)='' or length(session_title)>200
  or competencies is null or cardinality(competencies) not between 1 and 24 or array_ndims(competencies)<>1 then
  raise exception using errcode='22023',message='Invalid session plan';end if;
 foreach item in array competencies loop
  if item is null or length(item)>200 or private.ac_competency_key(item)='' or private.ac_competency_key(item)=any(keys) then
   raise exception using errcode='22023',message='Invalid session plan';end if;
  keys:=keys||private.ac_competency_key(item);
 end loop;
 insert into private.ac_sessions(company_id,recruitment_id,title,planned_competencies,created_by)
 values(r.company_id,r.id,private.behavior_trim(session_title),keys,auth.uid()) returning id into saved;
 return saved;
exception when unique_violation then raise exception using errcode='PT409',message='Session already exists';
 when lock_not_available then raise exception using errcode='PT409',message='Session busy';end;$$;

create or replace function public.ac_session_set_status(session uuid,next_status text) returns void
language plpgsql security definer set search_path='' as $$
declare s private.ac_sessions;
begin
 s:=private.ac_session_lock(session,true);
 if next_status='open' and s.status='draft' then
  -- Stage rows are locked so the plan checked by the table guard is the plan committed.
  perform 1 from private.ac_session_stages where session_id=s.id order by id for share nowait;
  update private.ac_sessions set status='open',opened_by=auth.uid(),opened_at=clock_timestamp() where id=s.id;
 elsif next_status='closed' and s.status='open' then
  update private.ac_sessions set status='closed',closed_by=auth.uid(),closed_at=clock_timestamp() where id=s.id;
 else raise exception using errcode='PT409',message='Session state changed';end if;
exception when lock_not_available then raise exception using errcode='PT409',message='Session busy';end;$$;

drop function if exists private.ac_package_required(uuid);
commit;
