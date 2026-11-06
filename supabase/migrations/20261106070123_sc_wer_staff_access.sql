-- SC-WER C3: authenticated staff status index. No capability is returned.
begin;
create function public.list_competency_test_access(target uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare app public.applications;cancelled boolean;shortlisted boolean;
begin
 app:=private.competency_lock_application(target,true,true);
 select app.status='withdrawn' or app.competency_access_cancelled_at is not null
  or c.competency_access_cancelled_at is not null into cancelled from public.candidates c
  where c.id=app.candidate_id and c.company_id=app.company_id;
 shortlisted:=exists(select 1 from public.recruitment_shortlist_entries e where e.company_id=app.company_id
  and e.recruitment_id=app.recruitment_id and e.application_id=app.id and e.removed_at is null);
 return jsonb_build_object('cancelled',cancelled,'shortlisted',shortlisted,'access',
  (select coalesce(jsonb_agg(jsonb_build_object(
   'grantId',g.id,'definitionId',g.definition_entry_id,'revision',g.revision,'startBy',g.start_by_at,
   'state',case when cancelled then 'withdrawn' when g.revoked_at is not null then 'revoked'
    when not shortlisted then 'unavailable' when a.state='submitted' then 'submitted'
    when coalesce(a.deadline_at,g.start_by_at)<=clock_timestamp() then 'expired'
    when a.id is null then 'not_started' else 'in_progress' end,
   'attemptId',case when cancelled then null else a.id end,'deadlineAt',case when cancelled then null else a.deadline_at end)
   order by g.created_at desc,g.id),'[]'::jsonb)
   from private.competency_test_grants g left join public.competency_test_attempts a on a.grant_id=g.id
   and a.company_id=g.company_id and a.application_id=g.application_id
   where g.company_id=app.company_id and g.recruitment_id=app.recruitment_id and g.application_id=app.id));
end;$$;
do $$declare g record;begin
 for g in select distinct a.grantee,r.rolname from pg_proc p
 cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 left join pg_roles r on r.oid=a.grantee where p.oid='public.list_competency_test_access(uuid)'::regprocedure and a.grantee<>p.proowner loop
 if g.grantee=0 then revoke all on function public.list_competency_test_access(uuid) from public;
 else execute format('revoke all on function public.list_competency_test_access(uuid) from %I',g.rolname);end if;
 end loop;
end;$$;
grant execute on function public.list_competency_test_access(uuid) to authenticated;
commit;
