-- Restore the two finalizers; keep existing provisional groups/history.
begin;
do $rollback$
declare definition text; fragment text;
begin
  definition:=pg_get_functiondef('public.complete_screening_analysis(uuid,text,text,text,jsonb,text,text,integer,integer,integer,numeric,text)'::regprocedure);
  fragment:=E'  if analysis.result_schema_version = 1 then\n    perform private.screening_apply_single_group(analysis.application_id,analysis.id);\n  end if;\n';
  if position(fragment in definition)=0 then raise exception 'single_group_not_installed' using errcode='55000'; end if;
  execute replace(definition,fragment,'');
  definition:=pg_get_functiondef('public.complete_screening_evidence(uuid,text,text,text,jsonb,text,text,integer,integer,integer,numeric,text)'::regprocedure);
  fragment:=E'  perform private.screening_apply_single_group(a.application_id,finished_id);\n';
  if position(fragment in definition)=0 then raise exception 'single_group_not_installed' using errcode='55000'; end if;
  execute replace(definition,fragment,'');
end $rollback$;
drop function private.screening_apply_single_group(uuid,uuid);
commit;
