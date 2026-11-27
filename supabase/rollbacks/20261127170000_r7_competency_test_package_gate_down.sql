-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R7 SC-019b competency test package gate
-- (20261127170000_r7_competency_test_package_gate.sql).
-- Restores the SC-019 catalog-orders body of sc19_commerce.consume_skill_test (no
-- package check; metering only). No data is touched: the migration stored nothing;
-- grants issued meanwhile stay as they are. `create or replace` keeps the existing
-- (owner-only) EXECUTE grants. Idempotent. Run with `psql -v ON_ERROR_STOP=1`.
begin;

create or replace function sc19_commerce.consume_skill_test(cid uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 -- Existing deployments keep their behavior until explicit runtime activation.
 if not (select skill_test_metering from sc19_commerce.settings where singleton) then return;end if;
 update sc19_commerce.entitlements set available=available-1,used=used+1
 where company_id=cid and code='skill_test' and available>0;
 if not found then raise exception 'commerce_skill_test_exhausted' using errcode='PT422';end if;
end;$$;
revoke all on function sc19_commerce.consume_skill_test(uuid) from public,anon,authenticated;

-- The restored body must be exactly the reviewed SC-019 one.
do $verify$
begin
 if encode(sha256(convert_to((select prosrc from pg_proc where oid='sc19_commerce.consume_skill_test(uuid)'::regprocedure),'UTF8')),'hex')
   is distinct from '27a344e726dae207e9cb770c498c92dfd0f962cbd65daaef7b0c793cb33960b7' then
  raise exception 'r7_competency_package_gate_rollback_body_mismatch' using errcode='55000';end if;
end $verify$;

commit;
