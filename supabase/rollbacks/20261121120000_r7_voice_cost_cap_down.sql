-- Manual rollback ONLY; never placed in supabase/migrations/ (would run forwards).
-- Rollback R7: miesięczny limit kosztu rozmów głosowych (20261121120000_r7_voice_cost_cap.sql).
--
-- 1. Przywraca strażnika zleceń rozmów private.sc011b_dispatch_guard() bajt w bajt do
--    treści z R20 (bez sprawdzania limitu) — od tej chwili limit przestaje działać.
-- 2. Usuwa funkcje schematu voice_budget.
-- 3. Tabele voice_budget (koszty rozmów i alerty dla właściciela) usuwa WYŁĄCZNIE,
--    gdy są puste. Jeśli są w nich wpisy, zostają nietknięte (usunięcie zapisanych
--    kosztów to decyzja właściciela, nie rollback); wtedy ponowne uruchomienie migracji
--    w przód zatrzyma się na 'voice_cost_cap_already_installed'.
-- Migracja nie zmieniała relacji w 'public'/'private', więc sygnatura inwentarza SC-010
-- ma pozostać ta sama — sprawdzane na końcu.
-- Idempotentny: ponowne uruchomienie po udanym rollbacku nic nie zmienia.
-- Uruchamiaj przez `psql -v ON_ERROR_STOP=1` przy wstrzymanym ruchu aplikacji.
begin;
set local lock_timeout = '500ms';

do $preflight$
begin
 perform set_config('r7_voice_cost_cap.signature_before',private.erasure_schema_signature(),true);
 if not exists(select 1 from pg_catalog.pg_proc where oid='private.sc011b_dispatch_guard()'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex') in
   ('2850610e17132511139b5fefbba79710fe5e0cbc46e8af11627b30698d5d5be5','e5404e835bbead0b47dbc9a686d8d8f6302e9f3ddc3498f4e6b7d57009b62a7f')) then
  raise exception 'r7_voice_cost_cap_rollback_guard_unreviewed' using errcode='55000';end if;
end $preflight$;

-- Strażnik najpierw: po tym żadne nowe zlecenie nie woła funkcji usuwanych niżej.
create or replace function private.sc011b_dispatch_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
declare prep private.sc010c_voice_preparations;
begin
 if tg_op='DELETE' and current_user='erasure_purge_owner' and
  private.erasure_purge_allowed(tg_table_schema||'.'||tg_table_name,to_jsonb(old)) then return old;end if;
 if tg_op in ('DELETE','TRUNCATE') then
  raise exception using errcode='42501',message='VOICE_DISPATCH_IMMUTABLE';
 end if;
 if tg_op='INSERT' then
  -- BEFORE INSERT runs ahead of ON CONFLICT: an existing claim is left as is.
  if exists(select 1 from private.sc011b_voice_dispatches
    where company_id=new.company_id and preparation_id=new.preparation_id) then
   return null;
  end if;
  select * into prep from private.sc010c_voice_preparations
   where company_id=new.company_id and id=new.preparation_id for share;
  if not found or prep.state<>'prepared_offline' then
   raise exception using errcode='PT409',message='VOICE_DISPATCH_UNAVAILABLE';
  end if;
  perform private.erasure_lock_candidate(prep.candidate_id);
  if new.provider_key_digest<>prep.provider_key_digest then
   raise exception using errcode='42501',message='VOICE_DISPATCH_DRAFT_MISMATCH';
  end if;
  -- Queue the SC-010-C deferred currentness check (contact, permission,
  -- release, entitlement) for this transaction's COMMIT: no claim without it.
  update private.sc010c_voice_preparations set state=state
   where company_id=new.company_id and id=new.preparation_id;
  if new.state<>'sending' or new.attempts<>1 or new.rejection is not null then
   raise exception using errcode='42501',message='VOICE_DISPATCH_INVALID_STATE';
  end if;
  new.started_at:=clock_timestamp(); new.last_attempt_at:=new.started_at;
  new.lease_until:=new.started_at+interval '15 seconds';
  return new;
 end if;
 -- A sending claim moves by one resend, a lease release, or one terminal
 -- outcome. An unknown claim may still learn that its call was accepted.
 if new.company_id<>old.company_id or new.preparation_id<>old.preparation_id
  or new.started_at<>old.started_at or new.provider_key_digest<>old.provider_key_digest
  or new.payload_sha256<>old.payload_sha256 or new.attempts<old.attempts
  or not ((old.state='sending' and new.state='sending' and new.attempts=old.attempts+1)
       or (old.state='sending' and new.state='sending' and new.attempts=old.attempts
           and new.lease_until is null)
       or (old.state='sending' and new.state in ('accepted','rejected','unknown') and new.attempts=old.attempts)
       or (old.state='unknown' and new.state='accepted' and new.attempts=old.attempts)
       -- Only the SC-011-B6 operator resolution may abandon an unknown claim.
       or (old.state='unknown' and new.state='abandoned' and new.attempts=old.attempts
           -- An unset setting is NULL: coalesce so absence is a refusal, never unknown.
           and coalesce(pg_catalog.current_setting('skillcheck.sc011b_resolution',true),'')='on')) then
  raise exception using errcode='42501',message='VOICE_DISPATCH_IMMUTABLE';
 end if;
 if new.state='sending' and new.attempts=old.attempts+1 then
  if old.lease_until>clock_timestamp() then
   raise exception using errcode='PT409',message='VOICE_DISPATCH_IN_FLIGHT';
  end if;
  -- Every resend re-proves current contact authority at COMMIT as well.
  update private.sc010c_voice_preparations set state=state
   where company_id=new.company_id and id=new.preparation_id;
  new.last_attempt_at:=clock_timestamp();
  new.lease_until:=new.last_attempt_at+interval '15 seconds';
 else
  new.last_attempt_at:=old.last_attempt_at;
  if new.state<>'sending' then new.lease_until:=null; end if;
 end if;
 return new;
end;$$;
do $acl$
declare g record;
begin
 revoke all on function private.sc011b_dispatch_guard() from public cascade;
 for g in select distinct a.grantee from pg_catalog.pg_proc p cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
  where p.oid='private.sc011b_dispatch_guard()'::regprocedure and a.grantee<>0 and a.grantee<>p.proowner loop
  execute pg_catalog.format('revoke all on function private.sc011b_dispatch_guard() from %I cascade',pg_catalog.pg_get_userbyid(g.grantee));
 end loop;
end $acl$;

drop function if exists voice_budget.list_owner_alerts(integer);
drop function if exists voice_budget.month_status(timestamptz);
drop function if exists voice_budget.record_call_cost(uuid,uuid,integer);
drop function if exists voice_budget.reserve_dispatch(uuid,uuid);
drop function if exists voice_budget.reserve_at(uuid,uuid,timestamptz);
drop function if exists voice_budget.note_cap(date,text);
drop function if exists voice_budget.month_to_date(date);
drop function if exists voice_budget.month_of(timestamptz);

do $tables$
begin
 if to_regnamespace('voice_budget') is null then return;end if;
 if to_regclass('voice_budget.charges') is not null then
  lock table voice_budget.charges, voice_budget.owner_alerts in access exclusive mode nowait;
  if exists(select 1 from voice_budget.charges) or exists(select 1 from voice_budget.owner_alerts) then
   raise notice 'r7_voice_cost_cap_rollback_kept_records: voice_budget tables keep their rows; the cap is off';
   return;
  end if;
 end if;
 drop table if exists voice_budget.owner_alerts, voice_budget.charges, voice_budget.settings;
 drop function if exists voice_budget.alert_guard();
 drop function if exists voice_budget.charge_guard();
 drop function if exists voice_budget.settings_guard();
 drop schema voice_budget;
end $tables$;

do $postflight$
begin
 if private.erasure_schema_signature() is distinct from current_setting('r7_voice_cost_cap.signature_before',true) then
  raise exception 'r7_voice_cost_cap_rollback_signature_changed' using errcode='55000';end if;
 if not exists(select 1 from pg_catalog.pg_proc where oid='private.sc011b_dispatch_guard()'::regprocedure
  and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='e5404e835bbead0b47dbc9a686d8d8f6302e9f3ddc3498f4e6b7d57009b62a7f'
  and pg_get_userbyid(proowner)='postgres' and not prosecdef and proconfig=array['search_path=""']) then
  raise exception 'r7_voice_cost_cap_rollback_guard_mismatch' using errcode='55000';end if;
end $postflight$;
commit;
