-- R3 (issue #338, #274, #283): an Assessment Center finalist session is tied to the
-- company's paid ASSESSMENT CENTER package.
--
-- Reuses the existing entitlement data, nothing new is stored: a paid catalog order
-- for the package (public.sc19_settle_catalog_order, operator-confirmed payment)
-- adds the row sc19_commerce.entitlements(company_id, 'package:ASSESSMENT_CENTER')
-- with available > 0. That row is the "active package". Nothing here creates an
-- order, grants a package, consumes a unit, changes a price or the catalog, or
-- talks to a payment provider.
--
-- Enforced in the database:
--  * public.ac_session_create — refused without the package (PT402,
--    'Assessment Center package required'); checked after the existing company
--    authorization, so a user outside the company still gets the same 42501 and
--    learns nothing about another company's package;
--  * public.ac_session_set_status draft -> open — refused without the package
--    (also covers a draft created before this migration). Closing an open session
--    and every other action on an existing session stay as they are, so work
--    already started is never cut off half-way.
-- One package does not limit the number of sessions and is not consumed here:
-- how many sessions one package covers is a package decision of the owner.
--
-- Functions only: no table, column, constraint, trigger or grant changes, so the
-- SC-010 erasure schema signature and inventory stay exactly as they are.
-- `create or replace` keeps the existing EXECUTE grants of both public functions.
-- The new helper is owner-only (nothing granted to API roles).
--
-- Code compatibility: the application code shipped with this change works on the
-- pre-migration schema (it only reads the existing public.sc19_catalog_entitlements
-- and maps one more error message).
-- Rollback: supabase/rollbacks/20261121090000_r3_ac_package_gate_down.sql.
begin;

do $preflight$
begin
 if to_regclass('sc19_commerce.entitlements') is null
  or to_regprocedure('public.ac_session_create(uuid,text,text[])') is null
  or to_regprocedure('public.ac_session_set_status(uuid,text)') is null then
  raise exception 'r3_ac_package_gate_requires_r16_and_catalog_orders' using errcode='55000';end if;
 if to_regprocedure('private.ac_package_required(uuid)') is not null then
  raise exception 'r3_ac_package_gate_already_installed' using errcode='55000';end if;
 -- Replace only the reviewed R16 bodies, never a later change made elsewhere.
 if encode(sha256(convert_to((select prosrc from pg_proc where oid='public.ac_session_create(uuid,text,text[])'::regprocedure),'UTF8')),'hex')
   is distinct from '6a58bd0859c17e2bacd8da5e551b5f402a2199388df6d0c892546aedcfc34416'
  or encode(sha256(convert_to((select prosrc from pg_proc where oid='public.ac_session_set_status(uuid,text)'::regprocedure),'UTF8')),'hex')
   is distinct from 'd365a42931e7b2cce5f1c4cacb6da543f279d3cf63c41e92ecd8d315d1267237' then
  raise exception 'r3_ac_package_gate_source_unreviewed' using errcode='55000';end if;
 perform set_config('r3_ac_package_gate.signature_before', private.erasure_schema_signature(), true);
end $preflight$;

-- Raises PT402 unless the company holds a paid ASSESSMENT CENTER package. The row
-- is read FOR SHARE so the check holds until the calling transaction commits.
create function private.ac_package_required(target_company uuid) returns void
language plpgsql volatile security definer set search_path='' as $$
begin
 perform 1 from sc19_commerce.entitlements
  where company_id=target_company and code='package:ASSESSMENT_CENTER' and available>0 for share;
 if not found then
  raise exception using errcode='PT402',message='Assessment Center package required';end if;
end;$$;
revoke all on function private.ac_package_required(uuid) from public,anon,authenticated;

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
 -- R3: only a company with a paid ASSESSMENT CENTER package creates a session.
 -- Checked after the company authorization above, so an outsider learns nothing.
 perform private.ac_package_required(r.company_id);
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
  -- R3: running a session needs the package too (covers drafts created before this gate).
  perform private.ac_package_required(s.company_id);
  -- Stage rows are locked so the plan checked by the table guard is the plan committed.
  perform 1 from private.ac_session_stages where session_id=s.id order by id for share nowait;
  update private.ac_sessions set status='open',opened_by=auth.uid(),opened_at=clock_timestamp() where id=s.id;
 elsif next_status='closed' and s.status='open' then
  update private.ac_sessions set status='closed',closed_by=auth.uid(),closed_at=clock_timestamp() where id=s.id;
 else raise exception using errcode='PT409',message='Session state changed';end if;
exception when lock_not_available then raise exception using errcode='PT409',message='Session busy';end;$$;

do $postflight$
begin
 if private.erasure_schema_signature() is distinct from current_setting('r3_ac_package_gate.signature_before') then
  raise exception 'r3_ac_package_gate_changed_erasure_signature' using errcode='55000';end if;
end $postflight$;
commit;
