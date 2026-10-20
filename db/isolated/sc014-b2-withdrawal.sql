-- SC-014-B2: isolated withdrawal protocol. Loaded after sc014-b2-attempts.sql.
-- No production migration, link/import endpoint, or restoration of consent.
begin;

-- The exception is an ungrantable NOLOGIN capability, not a spoofable GUC.
-- The trigger is intentionally SECURITY INVOKER: current_user is the caller
-- executing the UPDATE, not the installer who owns this trigger function.
create function private.competency_marker_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='INSERT' then
  if new.competency_access_cancelled_at is not null or new.competency_access_cancel_reason is not null
   or (tg_table_name='applications' and to_jsonb(new)->>'status'='withdrawn') then
   raise exception using errcode='42501',message='Controlled competency withdrawal required';end if;
 else
  if row(new.competency_access_cancelled_at,new.competency_access_cancel_reason) is distinct from
   row(old.competency_access_cancelled_at,old.competency_access_cancel_reason)
   and (current_user<>'competency_test_marker_writer' or old.competency_access_cancelled_at is not null
    or new.competency_access_cancelled_at is null or new.competency_access_cancel_reason is null) then
   raise exception using errcode='42501',message='Competency withdrawal marker is immutable';end if;
  if tg_table_name='applications' and to_jsonb(new)->>'status'='withdrawn'
   and to_jsonb(old)->>'status' is distinct from 'withdrawn'
   and current_user<>'competency_test_marker_writer' then
   raise exception using errcode='42501',message='Controlled competency withdrawal required';end if;
 end if;
 return new;
end;$$;
revoke all on function private.competency_marker_guard() from public,anon,authenticated;
create trigger competency_candidate_marker_guard before insert or update on public.candidates
 for each row execute function private.competency_marker_guard();
create trigger competency_application_marker_guard before insert or update on public.applications
 for each row execute function private.competency_marker_guard();

grant usage on schema public,private to competency_test_marker_writer;
grant select on public.candidates,public.applications to competency_test_marker_writer;
grant update(competency_access_cancelled_at,competency_access_cancel_reason) on public.candidates to competency_test_marker_writer;
grant update(status,competency_access_cancelled_at,competency_access_cancel_reason) on public.applications to competency_test_marker_writer;
grant execute on function private.erasure_normal_row_guard(text,text,text,jsonb,jsonb) to competency_test_marker_writer;
create policy competency_marker_read on public.candidates for select to competency_test_marker_writer using(true);
create policy competency_marker_write on public.candidates for update to competency_test_marker_writer using(true) with check(true);
create policy competency_marker_read on public.applications for select to competency_test_marker_writer using(true);
create policy competency_marker_write on public.applications for update to competency_test_marker_writer using(true) with check(true);

create function private.competency_write_markers(tenant uuid,subjects uuid[],application_ids uuid[],reason text,
 mark_candidates boolean,withdraw_application boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
 if reason is null or reason not in ('consent_withdrawn','candidate_withdrawn') then
  raise exception using errcode='PT422',message='Invalid withdrawal reason';end if;
 if mark_candidates then
  update public.candidates set competency_access_cancelled_at=coalesce(competency_access_cancelled_at,clock_timestamp()),
   competency_access_cancel_reason=coalesce(competency_access_cancel_reason,reason)
   where company_id=tenant and id=any(subjects);
 end if;
 update public.applications set competency_access_cancelled_at=coalesce(competency_access_cancelled_at,clock_timestamp()),
  competency_access_cancel_reason=coalesce(competency_access_cancel_reason,reason),
  status=case when withdraw_application then 'withdrawn' else status end
  where company_id=tenant and candidate_id=any(subjects) and id=any(application_ids);
end;$$;
alter function private.competency_write_markers(uuid,uuid[],uuid[],text,boolean,boolean) owner to competency_test_marker_writer;
revoke all on function private.competency_write_markers(uuid,uuid[],uuid[],text,boolean,boolean) from public,anon,authenticated;

-- Include historical ranges as well as the latest revision. Shrinking a range
-- or switching its anchor cannot detach an already persisted withdrawal.
create function private.competency_resolution_closure(tenant uuid,subjects uuid[]) returns uuid[]
language sql volatile security definer set search_path='' as $$
 with recursive linked(id) as (
  select unnest(subjects)
  union
  select member.id from linked l join private.erasure_subject_resolutions r
   on r.company_id=tenant and l.id=any(array_append(r.candidate_ids,r.anchor_candidate_id))
   cross join lateral unnest(array_append(r.candidate_ids,r.anchor_candidate_id)) member(id)
 ) select array_agg(id order by id) from linked
$$;
revoke all on function private.competency_resolution_closure(uuid,uuid[]) from public,anon,authenticated;

-- For every publisher of a resolution, old and new ranges share candidate
-- locks. Applications precede the company authority lock, avoiding the former
-- company -> candidate inversion in confirm_erasure_subject.
create function private.competency_lock_resolution(tenant uuid,subjects uuid[]) returns uuid[]
language plpgsql volatile security definer set search_path='' as $$
declare locked_ids uuid[];subject uuid;application_id uuid;
begin
 if auth.uid() is null or not exists(select 1 from public.companies where id=tenant and owner_id=auth.uid()) then
  raise exception using errcode='PT404',message='Resource unavailable';end if;
 locked_ids:=private.competency_resolution_closure(tenant,subjects);
 if cardinality(locked_ids)>100 then raise exception using errcode='PT409',message='Subject resolution required';end if;
 foreach subject in array locked_ids loop
  perform private.erasure_lock_candidate(subject);
  if not exists(select 1 from public.candidates where id=subject and company_id=tenant) then
   raise exception using errcode='PT404',message='Resource unavailable';end if;
 end loop;
 perform 1 from private.erasure_execution_config where singleton for share nowait;
 if exists(select 1 from private.erasure_execution_config where singleton and restore_isolated) then
  raise exception using errcode='PT409',message='Restore isolation required';end if;
 if locked_ids is distinct from private.competency_resolution_closure(tenant,subjects) then
  raise exception using errcode='PT409',message='Subject resolution changed';end if;
 for application_id in select a.id from public.applications a where a.company_id=tenant and a.candidate_id=any(locked_ids) order by a.id loop
  perform 1 from public.applications where id=application_id for update nowait;
 end loop;
 perform private.competency_authority(tenant,true);
 return locked_ids;
exception when lock_not_available then raise exception using errcode='PT409',message='Subject resolution busy';end;$$;
revoke all on function private.competency_lock_resolution(uuid,uuid[]) from public,anon,authenticated;

-- Called only after all candidate/application/authority locks have been taken.
-- Every revoke gets its own event key; the cancellation row ties the complete
-- affected set to the caller's idempotency key in this same transaction.
create function private.competency_revoke_applications(tenant uuid,application_ids uuid[]) returns void
language plpgsql security definer set search_path='' as $$
declare grant_id uuid;
begin
 for grant_id in select g.id from private.competency_test_grants g
  where g.company_id=tenant and g.application_id=any(application_ids) order by g.id loop
  perform public.revoke_competency_test_grant(grant_id,gen_random_uuid());
 end loop;
end;$$;
revoke all on function private.competency_revoke_applications(uuid,uuid[]) from public,anon,authenticated;

-- This trigger also protects an INSERT made by a future trusted importer or
-- helper. There is no executable public bypass around resolution propagation.
create function private.competency_resolution_insert_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare ids uuid[];locked_ids uuid[];application_ids uuid[];latest bigint;reason text;
begin
 if new.candidate_ids is null or cardinality(new.candidate_ids) not between 1 and 100
  or array_ndims(new.candidate_ids)<>1 or array_position(new.candidate_ids,null) is not null
  or not new.anchor_candidate_id=any(new.candidate_ids) then
  raise exception using errcode='PT422',message='Invalid subject resolution';end if;
 select array_agg(distinct id order by id) into ids from unnest(new.candidate_ids) x(id);
 if cardinality(ids)<>cardinality(new.candidate_ids) then raise exception using errcode='PT422',message='Duplicate candidate IDs';end if;
 locked_ids:=private.competency_lock_resolution(new.company_id,ids);
 if new.confirmed_by is distinct from auth.uid() then raise exception using errcode='PT404',message='Resource unavailable';end if;
 select coalesce(max(r.revision),0) into latest from private.erasure_subject_resolutions r
  where r.company_id=new.company_id and r.anchor_candidate_id=new.anchor_candidate_id;
 if new.revision<>latest+1 then raise exception using errcode='PT409',message='Subject resolution changed';end if;
 select c.competency_access_cancel_reason into reason from public.candidates c
  where c.company_id=new.company_id and c.id=any(locked_ids) and c.competency_access_cancelled_at is not null order by c.id limit 1;
 if found then
  -- A new A/C link can join existing A/B and C/D resolutions. All confirmed
  -- members of the already locked transitive closure inherit the denial,
  -- including D which is absent from this INSERT's candidate_ids payload.
  select coalesce(array_agg(a.id order by a.id),'{}'::uuid[]) into application_ids from public.applications a
   where a.company_id=new.company_id and a.candidate_id=any(locked_ids);
  perform private.competency_revoke_applications(new.company_id,application_ids);
  perform private.competency_write_markers(new.company_id,locked_ids,application_ids,reason,true,false);
  insert into private.competency_test_cancellations(company_id,candidate_ids,scope_kind,resolution_id,resolution_revision,reason,actor_id,request_key)
   values(new.company_id,locked_ids,'resolution_link',new.id,new.revision,reason,auth.uid(),gen_random_uuid());
 end if;
 new.candidate_ids:=ids;
 return new;
exception when lock_not_available then raise exception using errcode='PT409',message='Subject resolution busy';end;$$;
revoke all on function private.competency_resolution_insert_guard() from public,anon,authenticated;
create trigger competency_resolution_insert_guard before insert on private.erasure_subject_resolutions
 for each row execute function private.competency_resolution_insert_guard();

create or replace function public.confirm_erasure_subject(target_candidate uuid,candidate_ids uuid[],expected_revision bigint,request_key uuid)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare tenant uuid;ids uuid[];latest bigint;payload text;old private.erasure_configuration_requests;result uuid;
begin
 if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then
  raise exception using errcode='PT409',message='Fresh transaction required';end if;
 if expected_revision is null or expected_revision<0 or request_key is null or candidate_ids is null
  or cardinality(candidate_ids) not between 1 and 100 or array_ndims(candidate_ids)<>1 or array_position(candidate_ids,null) is not null
  or target_candidate is null or not target_candidate=any(candidate_ids) then
  raise exception using errcode='PT422',message='Invalid subject resolution';end if;
 select array_agg(distinct x order by x) into ids from unnest(candidate_ids) x;
 if cardinality(ids)<>cardinality(candidate_ids) then raise exception using errcode='PT422',message='Duplicate candidate IDs';end if;
 select company_id into tenant from public.candidates where id=target_candidate;
 perform private.competency_lock_resolution(tenant,ids);
 payload:=private.erasure_hash(jsonb_build_array(target_candidate,ids,expected_revision));
 select * into old from private.erasure_configuration_requests where company_id=tenant and actor_id=auth.uid()
  and operation='resolution' and erasure_configuration_requests.request_key=confirm_erasure_subject.request_key;
 if found then
  if old.payload_hash<>payload then raise exception using errcode='PT409',message='Request key reused';end if;
  return old.result_id;
 end if;
 select coalesce(max(revision),0) into latest from private.erasure_subject_resolutions where company_id=tenant and anchor_candidate_id=target_candidate;
 if latest<>expected_revision then raise exception using errcode='PT409',message='Subject revision changed';end if;
 insert into private.erasure_subject_resolutions(company_id,anchor_candidate_id,candidate_ids,revision,confirmed_by)
  values(tenant,target_candidate,ids,latest+1,auth.uid()) returning id into result;
 insert into private.erasure_configuration_requests values(tenant,auth.uid(),'resolution',request_key,payload,result,now());
 return result;
exception when lock_not_available or unique_violation then raise exception using errcode='PT409',message='Subject changed';end;$$;
revoke all on function public.confirm_erasure_subject(uuid,uuid[],bigint,uuid) from public,anon,authenticated;
grant execute on function public.confirm_erasure_subject(uuid,uuid[],bigint,uuid) to authenticated;

-- Scope is explicit and closed: {kind:'application',application_id,reason} or
-- {kind:'confirmed_subject',resolution_id,resolution_revision,reason}. IDs in
-- a confirmed subject always come from the immutable server resolution.
create function public.withdraw_competency_test_access(scope jsonb,request_key uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare kind text;reason text;app public.applications;r private.erasure_subject_resolutions;expected_revision bigint;
 tenant uuid;ids uuid[];subject uuid;application_ids uuid[];application_id uuid;old private.competency_test_cancellations;
 result uuid;resolution_id uuid;
begin
 if request_key is null or jsonb_typeof(scope) is distinct from 'object' then
  raise exception using errcode='PT422',message='Invalid withdrawal scope';end if;
 kind:=scope->>'kind';reason:=scope->>'reason';
 if reason is null or reason not in ('candidate_withdrawn','consent_withdrawn') then
  raise exception using errcode='PT422',message='Invalid withdrawal reason';end if;
 if kind='application' then
  if (scope-array['kind','application_id','reason'])<>'{}'::jsonb or scope->>'application_id' is null
   or reason<>'candidate_withdrawn' then raise exception using errcode='PT422',message='Invalid application withdrawal';end if;
  app:=private.competency_lock_application((scope->>'application_id')::uuid,true,true);
  tenant:=app.company_id;ids:=array[app.candidate_id];application_ids:=array[app.id];
 elsif kind='confirmed_subject' then
  if (scope-array['kind','resolution_id','resolution_revision','reason'])<>'{}'::jsonb or scope->>'resolution_id' is null
   or jsonb_typeof(scope->'resolution_revision') is distinct from 'number' or scope->>'resolution_revision' !~ '^[1-9][0-9]*$' then
   raise exception using errcode='PT422',message='Invalid subject withdrawal';end if;
  resolution_id:=(scope->>'resolution_id')::uuid;expected_revision:=(scope->>'resolution_revision')::bigint;
  select * into r from private.erasure_subject_resolutions where id=resolution_id;
  if not found then raise exception using errcode='PT409',message='Subject resolution required';end if;
  tenant:=r.company_id;ids:=r.candidate_ids;
  if auth.uid() is null or not exists(select 1 from public.companies where id=tenant and owner_id=auth.uid()) then
   raise exception using errcode='PT404',message='Resource unavailable';end if;
  foreach subject in array ids loop
   perform private.erasure_lock_candidate(subject);
   if not exists(select 1 from public.candidates where id=subject and company_id=tenant) then
    raise exception using errcode='PT409',message='Subject resolution changed';end if;
  end loop;
  perform 1 from private.erasure_execution_config where singleton for share nowait;
  if exists(select 1 from private.erasure_execution_config where singleton and restore_isolated) then
   raise exception using errcode='PT409',message='Restore isolation required';end if;
  select * into r from private.erasure_subject_resolutions where id=resolution_id for share nowait;
  if r.id is null or r.company_id<>tenant or r.candidate_ids is distinct from ids or r.revision<>expected_revision
   or r.revision<>(select max(revision) from private.erasure_subject_resolutions where company_id=tenant and anchor_candidate_id=r.anchor_candidate_id)
   or ids is distinct from private.competency_resolution_closure(tenant,ids) then
   raise exception using errcode='PT409',message='Subject resolution changed';end if;
  select coalesce(array_agg(a.id order by a.id),'{}'::uuid[]) into application_ids from public.applications a
   where a.company_id=tenant and a.candidate_id=any(ids);
  foreach application_id in array application_ids loop
   perform 1 from public.applications where id=application_id for update nowait;
  end loop;
  perform private.competency_authority(tenant,true);
  if r.confirmed_by is distinct from auth.uid() then raise exception using errcode='PT409',message='Subject resolution required';end if;
 else raise exception using errcode='PT422',message='Invalid withdrawal scope';
 end if;
 select * into old from private.competency_test_cancellations c where c.company_id=tenant and c.actor_id=auth.uid()
  and c.request_key=withdraw_competency_test_access.request_key;
 if found then
  if old.scope_kind<>kind or old.reason<>reason or old.candidate_ids is distinct from ids
   or old.application_id is distinct from app.id or old.resolution_id is distinct from resolution_id
   or old.resolution_revision is distinct from expected_revision then raise exception using errcode='PT409',message='Request key reused';end if;
  return jsonb_build_object('withdrawn',true,'cancellationId',old.id,'scope',kind);
 end if;
 perform private.competency_revoke_applications(tenant,application_ids);
 perform private.competency_write_markers(tenant,ids,application_ids,reason,kind='confirmed_subject',kind='application');
 insert into private.competency_test_cancellations(company_id,candidate_ids,application_id,scope_kind,resolution_id,resolution_revision,reason,actor_id,request_key)
  values(tenant,ids,app.id,kind,resolution_id,expected_revision,reason,auth.uid(),request_key) returning id into result;
 return jsonb_build_object('withdrawn',true,'cancellationId',result,'scope',kind);
exception when invalid_text_representation or numeric_value_out_of_range then raise exception using errcode='PT422',message='Invalid withdrawal scope';
 when lock_not_available or unique_violation then raise exception using errcode='PT409',message='Withdrawal busy';end;$$;
revoke all on function public.withdraw_competency_test_access(jsonb,uuid) from public,anon,authenticated;
grant execute on function public.withdraw_competency_test_access(jsonb,uuid) to authenticated;

-- Existing withdrawn rows must be safe before this composition can activate.
-- The fresh isolated B2 tables cannot contain prior grants. Fail closed if the
-- caller tries to apply this installation step to a partially active schema.
-- This is an explicit installation backfill audit attributed to the tenant's
-- existing owner; it neither sets an auth claim nor impersonates that owner.
do $$declare app public.applications;actor uuid;subject uuid;application_id uuid;begin
 for subject in select distinct candidate_id from public.applications
  where status='withdrawn' and competency_access_cancelled_at is null order by candidate_id loop
  perform private.erasure_lock_candidate(subject);
 end loop;
 for application_id in select id from public.applications
  where status='withdrawn' and competency_access_cancelled_at is null order by id loop
  perform 1 from public.applications where id=application_id for update nowait;
 end loop;
 for app in select a.* from public.applications a where a.status='withdrawn' and a.competency_access_cancelled_at is null order by a.candidate_id,a.id loop
  if exists(select 1 from private.competency_test_grants g where g.application_id=app.id) then
   raise exception 'Historical withdrawn grant requires controlled reconciliation before installation';end if;
  select owner_id into actor from public.companies where id=app.company_id for share nowait;
  if actor is null then raise exception 'Historical withdrawal requires an auditable owner';end if;
  perform private.competency_write_markers(app.company_id,array[app.candidate_id],array[app.id],'candidate_withdrawn',false,true);
  insert into private.competency_test_cancellations(company_id,candidate_ids,application_id,scope_kind,reason,actor_id,request_key)
   values(app.company_id,array[app.candidate_id],app.id,'historical_withdrawn','candidate_withdrawn',actor,gen_random_uuid());
 end loop;
end;$$;

-- Do not inherit an installation's over-broad default function grants. The
-- marker writer cannot be assumed by an API role and its writer has no public
-- EXECUTE path. ACL cleanup is transactional with publication of these RPCs.
do $$declare f record;g record;begin
 for f in select p.oid,p.proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='private' and p.proname in ('competency_marker_guard','competency_write_markers',
   'competency_resolution_closure','competency_lock_resolution','competency_revoke_applications','competency_resolution_insert_guard'))
   or (n.nspname='public' and p.proname in ('confirm_erasure_subject','withdraw_competency_test_access')) loop
  for g in select distinct x.grantee,r.rolname from pg_proc p
   cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
   left join pg_roles r on r.oid=x.grantee where p.oid=f.oid and x.grantee<>f.proowner loop
   if g.grantee=0 then execute format('revoke all on function %s from public',f.oid::regprocedure);
   else execute format('revoke all on function %s from %I',f.oid::regprocedure,g.rolname);end if;
  end loop;
 end loop;
end;$$;
grant execute on function public.confirm_erasure_subject(uuid,uuid[],bigint,uuid),
 public.withdraw_competency_test_access(jsonb,uuid) to authenticated;
commit;
