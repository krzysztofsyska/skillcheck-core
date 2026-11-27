-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R3 SC-016b pair package gate (20261127160000_r3_ac_pair_package_gate.sql).
-- Restores the R13 body of public.ac_assign_pair (no package check). No data is
-- touched: the migration stored nothing; pairs created meanwhile stay as they are.
-- `create or replace` keeps the existing EXECUTE grants. The R3 session gate
-- (private.ac_package_required) is left in place. Idempotent. Run with
-- `psql -v ON_ERROR_STOP=1`.
begin;

create or replace function public.ac_assign_pair(application uuid,revision uuid,first_id uuid,second_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare a public.applications;owner_id uuid;participant uuid;saved uuid;
begin
 a:=private.ac_lock_application(application);
 perform private.competency_authority(a.company_id,true);
 if first_id is null or second_id is null or first_id=second_id or not exists(
  select 1 from public.exercise_definition_entries d where d.id=revision and d.company_id=a.company_id
  and d.recruitment_id=a.recruitment_id and d.definition->>'kind'='assessment_center') then
  raise exception using errcode='42501',message='Assessment unavailable';end if;
 select c.owner_id into owner_id from public.companies c where c.id=a.company_id;
 foreach participant in array array[first_id,second_id] loop
  if participant<>owner_id then
   perform 1 from public.company_members m where m.company_id=a.company_id and m.user_id=participant and m.role='recruiter' for share nowait;
   if not found then raise exception using errcode='42501',message='Assessor unavailable';end if;
  end if;
 end loop;
 insert into private.ac_paired_sheets(company_id,recruitment_id,application_id,definition_id,first_assessor,second_assessor)
 values(a.company_id,a.recruitment_id,a.id,revision,first_id,second_id) returning id into saved;
 return saved;
exception when unique_violation or lock_not_available then raise exception using errcode='PT409',message='Assessment assignment changed';end;$$;

-- The restored body must be exactly the reviewed R13 one.
do $verify$
begin
 if encode(sha256(convert_to((select prosrc from pg_proc where oid='public.ac_assign_pair(uuid,uuid,uuid,uuid)'::regprocedure),'UTF8')),'hex')
   is distinct from '27dc900372491f08f71f5c50bfc4fe62403b3265ea20b7dcfffbbd05e4f7f418' then
  raise exception 'r3_ac_pair_package_gate_rollback_body_mismatch' using errcode='55000';end if;
end $verify$;

commit;
