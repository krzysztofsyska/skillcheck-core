-- Operational rollback removes application access to these two RPCs only.
-- Retain review history, internal approval and the candidate approval boundary.
begin;
do $acl$ declare o record;g record;begin
 for o in select oid,proowner from pg_proc where oid=any(array[
  'public.read_exercise_ai_proposal(uuid,uuid,uuid)'::regprocedure,
  'public.approve_exercise_ai_proposal(uuid,uuid,uuid,timestamptz)'::regprocedure]) loop
  execute format('revoke all on function %s from public',o.oid::regprocedure);
  for g in select distinct r.rolname from pg_proc p cross join lateral aclexplode(p.proacl) a
   join pg_roles r on r.oid=a.grantee where p.oid=o.oid and a.grantee<>o.proowner loop
   execute format('revoke all on function %s from %I',o.oid::regprocedure,g.rolname);
  end loop;
 end loop;
end $acl$;
commit;
